import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Telegraf } from 'telegraf';

import { config } from './config.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Commits the user explicitly skipped — never re-notify for these
const _skipped = new Set<string>();
// Hash of the commit we already sent a notification for (avoid spam)
let _notifiedCommit: string | null = null;

function gitExec(cmd: string): string {
  return execSync(cmd, { cwd: PROJECT_ROOT, stdio: 'pipe' }).toString().trim();
}

/** Returns the short hash of origin/main if it's ahead of HEAD, else null. */
function getNewCommit(): string | null {
  try {
    gitExec('git fetch origin main --quiet');
    const behind = gitExec('git log HEAD..origin/main --oneline');
    if (!behind) return null;
    return gitExec('git rev-parse --short origin/main');
  } catch {
    return null;
  }
}

/** Human-readable list of new commits (max 10 lines). */
function getChangelog(): string {
  try {
    return gitExec('git log HEAD..origin/main --oneline --no-merges');
  } catch {
    return '';
  }
}

/** Manually trigger an update check. Returns the notification message sent, or null if up to date. */
export async function checkForUpdates(telegram: Telegraf['telegram'], groupId: number, threadId?: number): Promise<void> {
  const commit = getNewCommit();
  const replyOpts = threadId ? { message_thread_id: threadId } : {};

  if (!commit) {
    await telegram.sendMessage(
      groupId,
      '✅ <b>Bot đang ở phiên bản mới nhất!</b>',
      { ...replyOpts, parse_mode: 'HTML' },
    );
    return;
  }

  const changelog = getChangelog();
  await telegram.sendMessage(
    groupId,
    `🔔 <b>Có bản cập nhật mới!</b>\n\n${
      changelog
        ? changelog.split('\n').slice(0, 10).map(l => `• ${l}`).join('\n') + '\n\n'
        : ''
    }Bạn có muốn cập nhật bot không?`,
    {
      ...replyOpts,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Cập nhật ngay', callback_data: `ua:yes:${commit}` },
          { text: '❌ Bỏ qua',         callback_data: `ua:no:${commit}`  },
        ]],
      },
    },
  );
}

export function startUpdateChecker(bot: Telegraf): void {

  // ── Callback: ua:yes:<hash> / ua:no:<hash> ─────────────────────────────────
  bot.action(/^ua:(yes|no):(.+)$/, async (ctx) => {
    const action = ctx.match[1] as 'yes' | 'no';
    const commit = ctx.match[2];

    if (action === 'no') {
      _skipped.add(commit);
      _notifiedCommit = null;
      await ctx.answerCbQuery('🔕 Đã bỏ qua, sẽ không nhắc lại phiên bản này');
      await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
      return;
    }

    // action === 'yes'
    await ctx.answerCbQuery('⏳ Đang cập nhật...');
    await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);

    try {
      await bot.telegram.sendMessage(
        config.telegram.groupId,
        '⏳ Đang kéo code mới, cài dependencies và build...',
      );

      gitExec('git pull --rebase');
      execSync('npm ci --prefer-offline', { cwd: PROJECT_ROOT, stdio: 'pipe' });
      execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'pipe' });

      const newHash = gitExec('git rev-parse --short HEAD');
      await bot.telegram.sendMessage(
        config.telegram.groupId,
        `✅ Cập nhật lên <code>${newHash}</code> thành công!\nBot đang khởi động lại...`,
        { parse_mode: 'HTML' },
      );

      // Thoát → launchd/systemd tự restart với code mới
      setTimeout(() => process.exit(0), 1500);
    } catch (err) {
      console.error('[Updater] Update failed:', err);
      _notifiedCommit = null; // cho phép thử lại lần sau
      await bot.telegram.sendMessage(
        config.telegram.groupId,
        `❌ Cập nhật thất bại!\n<code>${err instanceof Error ? err.message : String(err)}</code>`,
        { parse_mode: 'HTML' },
      );
    }
  });

  // ── Periodic check mỗi 10 phút ───────────────────────────────────────────
  const check = async () => {
    const commit = getNewCommit();
    if (!commit) return;                     // không có gì mới
    if (_skipped.has(commit)) return;        // user đã skip commit này
    if (_notifiedCommit === commit) return;  // đã nhắn rồi, chờ user trả lời

    _notifiedCommit = commit;
    const changelog = getChangelog();

    try {
      await bot.telegram.sendMessage(
        config.telegram.groupId,
        `🔔 <b>Có bản cập nhật mới!</b>\n\n${
          changelog
            ? changelog.split('\n').slice(0, 10).map(l => `• ${l}`).join('\n') + '\n\n'
            : ''
        }Bạn có muốn cập nhật bot không?`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Cập nhật ngay', callback_data: `ua:yes:${commit}` },
              { text: '❌ Bỏ qua',         callback_data: `ua:no:${commit}`  },
            ]],
          },
        },
      );
    } catch (err) {
      console.error('[Updater] Failed to send notification:', err);
      _notifiedCommit = null;
    }
  };

  // Kiểm tra 1 phút sau khi khởi động, sau đó mỗi 10 phút
  setTimeout(check, 60_000);
  setInterval(check, 10 * 60_000);
}
