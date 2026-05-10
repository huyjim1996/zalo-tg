/**
 * Rate-limit-aware queue for Telegram API calls.
 * When Telegram returns 429 Too Many Requests, the call is re-queued
 * after the specified retry_after delay instead of crashing.
 */

interface QueueItem {
  fn: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject:  (e: unknown) => void;
  retries: number;
}

const MAX_RETRIES = 5;
const _queue: QueueItem[] = [];
let _running = false;
let _pauseUntil = 0; // epoch ms

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

async function drain(): Promise<void> {
  if (_running) return;
  _running = true;

  while (_queue.length > 0) {
    const now = Date.now();
    if (_pauseUntil > now) {
      await new Promise(r => setTimeout(r, _pauseUntil - now));
    }

    const item = _queue.shift()!;
    try {
      const result = await item.fn();
      item.resolve(result);
    } catch (err) {
      const retryAfter = is429(err);
      if (retryAfter !== null && item.retries < MAX_RETRIES) {
        const delay = (retryAfter + 1) * 1000;
        console.warn(`[TGQueue] 429 — retry #${item.retries + 1} after ${retryAfter}s`);
        _pauseUntil = Date.now() + delay;
        _queue.unshift({ ...item, retries: item.retries + 1 });
      } else {
        item.reject(err);
      }
    }
  }

  _running = false;
}

/** Enqueue a Telegram API call. Returns a promise that resolves/rejects when done. */
export function tgQueue<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    _queue.push({ fn: fn as () => Promise<unknown>, resolve: resolve as (v: unknown) => void, reject, retries: 0 });
    void drain();
  });
}
