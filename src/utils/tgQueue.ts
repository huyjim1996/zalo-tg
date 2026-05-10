/**
 * Rate-limit-aware concurrent queue for Telegram API calls.
 *
 * Allows up to CONCURRENCY calls in-flight simultaneously for low latency.
 * On 429 Too Many Requests: the failing call is re-queued after retry_after,
 * and all subsequent calls wait out the same pause window.
 */

interface QueueItem {
  fn: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject:  (e: unknown) => void;
  retries: number;
}

const MAX_RETRIES  = 5;
const CONCURRENCY  = 5;   // max simultaneous in-flight TG calls
const _queue: QueueItem[] = [];
let   _active    = 0;
let   _pauseUntil = 0; // epoch ms — global back-off on 429

function is429(err: unknown): number | null {
  if (
    err != null &&
    typeof err === 'object' &&
    'response' in err &&
    (err as { response: { error_code?: number; parameters?: { retry_after?: number } } })
      .response?.error_code === 429
  ) {
    return (
      (err as { response: { parameters?: { retry_after?: number } } })
        .response?.parameters?.retry_after ?? 30
    );
  }
  return null;
}

function scheduleNext(): void {
  while (_active < CONCURRENCY && _queue.length > 0) {
    const item = _queue.shift()!;
    _active++;
    void runOne(item);
  }
}

async function runOne(item: QueueItem): Promise<void> {
  try {
    // Honour the global pause window before firing
    const wait = _pauseUntil - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));

    const result = await item.fn();
    item.resolve(result);
  } catch (err) {
    const retryAfter = is429(err);
    if (retryAfter !== null && item.retries < MAX_RETRIES) {
      const delay = (retryAfter + 1) * 1000;
      console.warn(`[TGQueue] 429 — retry #${item.retries + 1} after ${retryAfter}s`);
      _pauseUntil = Math.max(_pauseUntil, Date.now() + delay);
      // Re-queue at the front so it goes next once the pause expires
      _queue.unshift({ ...item, retries: item.retries + 1 });
    } else {
      item.reject(err);
    }
  } finally {
    _active--;
    scheduleNext();
  }
}

/** Enqueue a Telegram API call. Returns a promise that resolves/rejects when done. */
export function tgQueue<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    _queue.push({ fn: fn as () => Promise<unknown>, resolve: resolve as (v: unknown) => void, reject, retries: 0 });
    scheduleNext();
  });
}
