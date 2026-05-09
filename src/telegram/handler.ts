import { ThreadType } from 'zca-js';
import path from 'path';
import { createReadStream } from 'fs';

import type { ZaloAPI } from '../zalo/types.js';
import { store, msgStore, userCache, friendsCache, sentMsgStore, pollStore } from '../store.js';
import { tgBot } from './bot.js';
import { config } from '../config.js';
import { downloadToTemp, cleanTemp, convertToM4a } from '../utils/media.js';
import { triggerQRLogin } from '../zalo/client.js';

// ── Mention resolution helper ──────────────────────────────────────────────

type TgEntity = { type: string; offset: number; length: number; user?: { first_name: string; last_name?: string } };

/**
 * Resolve TG mention entities (or plain-text @Name patterns) in a string
 * to Zalo mention objects. Works for both msg.text+entities and
 * msg.caption+caption_entities.
 */
function resolveTgMentions(
  text: string,
  entities: ReadonlyArray<TgEntity> | undefined,
  forZaloGroup: boolean,
): Array<{ pos: number; uid: string; len: number }> {
  const result: Array<{ pos: number; uid: string; len: number }> = [];
  if (!forZaloGroup) return result;

  // 1. Named TG entities (@username or text_mention with user object)
  if (entities) {
    for (const e of entities) {
      if (e.type === 'mention') {
        const rawName = text.slice(e.offset + 1, e.offset + e.length); // strip leading @
        const uid = userCache.resolveByName(rawName);
        if (uid) result.push({ pos: e.offset, uid, len: e.length });
      } else if (e.type === 'text_mention' && e.user) {
        const rawName = e.user.first_name + (e.user.last_name ? ` ${e.user.last_name}` : '');
        const uid = userCache.resolveByName(rawName);
        if (uid) result.push({ pos: e.offset, uid, len: e.length });
      }
    }
  }

  // 2. Plain-text @Name patterns (only if no entity matched above)
  if (result.length === 0) {
    const atPattern = /@([\p{L}\p{N}_]+(?:\s[\p{L}\p{N}_]+){0,3})/gu;
    let m: RegExpExecArray | null;
    while ((m = atPattern.exec(text)) !== null) {
      const captured = m[1];
      if (/^(all|everyone|tất\s*cả)$/i.test(captured)) {
        result.push({ pos: m.index, uid: '-1', len: m[0].length });
        continue;
      }
      const words = captured.split(' ');
      for (let end = words.length; end >= 1; end--) {
        const candidate = words.slice(0, end).join(' ');
        const uid = userCache.resolveByName(candidate);
        if (uid) {
          result.push({ pos: m.index, uid, len: ('@' + candidate).length });
          break;
        }
      }
    }
  }

  return result;
}

/** Track in-progress QR login so we don't stack multiple flows. */
let qrLoginInProgress = false;

/**
 * Start a Zalo QR login flow and forward the QR image + status messages
 * back to the Telegram chat/topic where /login was sent.
 */
async function handleLoginCommand(
  chatId: number,
  threadId: number | undefined,
  onNewApi: (api: ZaloAPI) => void,
): Promise<void> {
  if (qrLoginInProgress) {
    await tgBot.telegram.sendMessage(
      chatId,
      '⏳ Đang có phiên đăng nhập khác đang chạy. Vui lòng chờ...',
      threadId ? { message_thread_id: threadId } : {},
    );
    return;
  }

  qrLoginInProgress = true;
  const msgOpts = threadId ? { message_thread_id: threadId } : {};

  try {
    await tgBot.telegram.sendMessage(chatId, '🔄 Đang tạo mã QR Zalo...', msgOpts);

    const newApi = await triggerQRLogin({
      onQRReady: async (imagePath) => {
        await tgBot.telegram.sendPhoto(
          chatId,
          { source: createReadStream(imagePath) },
          {
            ...msgOpts,
            caption: '📱 Mở ứng dụng <b>Zalo</b> → Cài đặt → Quét mã QR để đăng nhập.',
            parse_mode: 'HTML',
          },
        );
      },
      onExpired: async () => {
        await tgBot.telegram.sendMessage(chatId, '⏰ QR hết hạn, đang tạo mã mới...', msgOpts);
      },
      onScanned: async (displayName) => {
        await tgBot.telegram.sendMessage(
          chatId,
          `✅ Đã quét! Chờ xác nhận từ <b>${displayName}</b>...`,
          { ...msgOpts, parse_mode: 'HTML' },
        );
      },
      onDeclined: async () => {
        await tgBot.telegram.sendMessage(chatId, '❌ Đăng nhập bị từ chối trên điện thoại.', msgOpts);
      },
      onSuccess: async () => {
        await tgBot.telegram.sendMessage(
          chatId,
          '🎉 Đăng nhập Zalo thành công! Bridge đang hoạt động.',
          msgOpts,
        );
      },
    });

    onNewApi(newApi);
  } catch (err) {
    await tgBot.telegram.sendMessage(
      chatId,
      `❌ Đăng nhập thất bại: ${String(err)}`,
      msgOpts,
    ).catch(() => undefined);
  } finally {
    qrLoginInProgress = false;
  }
}

/**
 * Wire up Telegram → Zalo forwarding.
 *
 * @param initialApi  Starting Zalo API (null if not yet logged in).
 * @param onZaloLogin Called with the new API after a successful /login so the
 *                    caller can re-attach the Zalo listener on the fresh API.
 */
export function setupTelegramHandler(
  initialApi: ZaloAPI | null,
  onZaloLogin: (api: ZaloAPI) => Promise<void>,
): (api: ZaloAPI) => void {
  /** Mutable reference so /login can swap in a new API instance. */
  let currentApi: ZaloAPI | null = initialApi;

  /** Exposed setter so index.ts can inject the auto-logged-in API. */
  const setCurrentApi = (api: ZaloAPI) => { currentApi = api; };

  tgBot.command('login', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const threadId = ctx.message.message_thread_id;
    await handleLoginCommand(ctx.chat.id, threadId, (newApi) => {
      currentApi = newApi;
      void onZaloLogin(newApi).catch((e: unknown) => console.error('[/login] onZaloLogin error:', e));
    });
  });

  // /topic – manage bridge topic mappings
  // Usage inside a topic:  /topic info | /topic delete
  // Usage from General:    /topic list
  tgBot.command('topic', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const topicId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const arg = (ctx.message.text ?? '').split(/\s+/)[1]?.toLowerCase() ?? '';
    const replyOpts = topicId ? { message_thread_id: topicId } : {};

    if (arg === 'list' || !arg) {
      const all = store.all();
      if (all.length === 0) {
        await ctx.telegram.sendMessage(config.telegram.groupId, '📭 Chưa có topic nào.', replyOpts);
        return;
      }
      const lines = all.map(e =>
        `• <b>${e.name}</b> — topicId=${e.topicId}, zaloId=${e.zaloId}, type=${e.type === 1 ? 'group' : 'dm'}`,
      );
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `📋 <b>Bridge topics</b> (${all.length}):\n${lines.join('\n')}`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    if (!topicId) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        '⚠️ Lệnh này phải được gửi trong một topic cụ thể.',
        replyOpts,
      );
      return;
    }

    if (arg === 'info') {
      const entry = store.getEntryByTopic(topicId);
      if (!entry) {
        await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Topic này chưa được map.', replyOpts);
        return;
      }
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `ℹ️ <b>${entry.name}</b>\nzaloId: <code>${entry.zaloId}</code>\ntype: ${entry.type === 1 ? 'group' : 'dm'}`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    if (arg === 'delete') {
      const removed = store.remove(topicId);
      if (!removed) {
        await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Topic này chưa được map.', replyOpts);
        return;
      }
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `🗑️ Đã xoá mapping: <b>${removed.name}</b> (zaloId=${removed.zaloId})`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    await ctx.telegram.sendMessage(
      config.telegram.groupId,
      '❓ Dùng: <code>/topic list</code> | <code>/topic info</code> | <code>/topic delete</code>',
      { ...replyOpts, parse_mode: 'HTML' },
    );
  });

  tgBot.command('recall', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    if (!currentApi) { await ctx.reply('❌ Zalo chưa kết nối'); return; }

    const replyTo = 'reply_to_message' in ctx.message
      ? (ctx.message as { reply_to_message?: { message_id: number } }).reply_to_message
      : undefined;

    if (!replyTo) {
      await ctx.reply('ℹ️ Reply vào tin nhắn mình đã gửi rồi gõ /recall');
      return;
    }

    // Look up from sentMsgStore (TG→Zalo messages we sent)
    const sent = sentMsgStore.get(replyTo.message_id);
    if (!sent) {
      await ctx.reply('❌ Không tìm thấy tin nhắn đã gửi (chỉ thu hồi được tin mình gửi từ Telegram, và chỉ trong 300 tin gần nhất)');
      return;
    }

    const { ThreadType } = await import('zca-js');
    const zaloThreadType = sent.threadType === 1 ? ThreadType.Group : ThreadType.User;

    try {
      await currentApi.undo(
        { msgId: sent.msgId, cliMsgId: 0 },
        sent.zaloId,
        zaloThreadType,
      );
      console.log(`[TG→Zalo] Recall msgId=${sent.msgId} zaloId=${sent.zaloId}`);
      await ctx.reply('✅ Đã thu hồi tin nhắn trên Zalo');
    } catch (err) {
      console.error('[TG→Zalo] Recall error:', err);
      await ctx.reply(`❌ Thu hồi thất bại: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  tgBot.command('search', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    // /search must be in General (no topicId) or any topic — reply to same thread
    const threadId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const replyOpts = threadId ? { message_thread_id: threadId } : {};

    const query = (ctx.message.text ?? '').replace(/^\/search\s*/i, '').trim();
    if (!query) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        '🔍 Cú pháp: <code>/search Tên</code>',
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    // Refresh friends cache if stale
    if (!friendsCache.isFresh()) {
      try {
        const raw = await currentApi?.getAllFriends() as Array<{ userId: string; displayName: string }> | undefined;
        if (raw) friendsCache.set(raw.map(f => ({ userId: f.userId, displayName: f.displayName })));
      } catch (err) {
        console.error('[/search] getAllFriends failed:', err);
      }
    }

    const results = friendsCache.search(query, 10);
    if (results.length === 0) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `🔍 Không tìm thấy ai có tên chứa "<b>${query}</b>".`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    // Build inline keyboard — each button opens/creates a DM topic
    const buttons = results.map(f => [{
      text: f.displayName,
      callback_data: `sc:${f.userId}`,
    }]);

    await ctx.telegram.sendMessage(
      config.telegram.groupId,
      `🔍 Kết quả "<b>${query}</b>" (${results.length} người):`,
      {
        ...replyOpts,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons },
      },
    );
  });

  tgBot.on('callback_query', async (ctx) => {
    const data = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;

    if (data?.startsWith('lock_poll:')) {
      const pollId = Number(data.slice('lock_poll:'.length));
      const entry = pollStore.getByPollId(pollId);
      if (!entry || !currentApi) {
        await ctx.answerCbQuery('❌ Không tìm thấy bình chọn.');
        return;
      }
      try {
        await doLockPoll(entry, currentApi);
        await ctx.answerCbQuery('✅ Đã khoá bình chọn');
      } catch (err) {
        console.error('[TG→Zalo] lock_poll callback error:', err);
        try { await ctx.answerCbQuery('❌ Lỗi khoá bình chọn'); } catch { /* ignore */ }
      }
      return;
    }

    if (!data?.startsWith('sc:')) return;

    const userId = data.slice(3);
    if (!userId) { await ctx.answerCbQuery('❌ Dữ liệu không hợp lệ'); return; }

    // Check if topic already exists
    const existing = store.getTopicByZalo(userId, 0 /* DM */);
    if (existing !== undefined) {
      await ctx.answerCbQuery('ℹ️ Topic đã tồn tại');
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `💬 Topic cho người này đã có sẵn (topicId=${existing}).`,
        { message_thread_id: existing },
      );
      return;
    }

    // Resolve display name (from friends cache or getUserInfo)
    let displayName = friendsCache.search('', 0).find(f => f.userId === userId)?.displayName;
    if (!displayName) {
      try {
        const resp = await currentApi?.getUserInfo(userId) as {
          changed_profiles?: Record<string, { displayName?: string }>;
        } | undefined;
        displayName = resp?.changed_profiles?.[userId]?.displayName;
      } catch { /* ignore */ }
    }
    if (!displayName) displayName = `Zalo ${userId}`;

    // Create TG forum topic
    try {
      const topic = await ctx.telegram.createForumTopic(
        config.telegram.groupId,
        `👤 ${displayName}`.slice(0, 128),
        { icon_color: 0x6FB9F0 },
      );
      const topicId = topic.message_thread_id;
      store.set({ topicId, zaloId: userId, type: 0, name: displayName });
      console.log(`[/search] Created DM topic "${displayName}" (topicId=${topicId})`);

      await ctx.answerCbQuery('✅ Đã tạo topic!');
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `✅ Đã tạo topic cho <b>${displayName}</b>.\nNhắn tin tại đây để chat với họ qua Zalo.`,
        { message_thread_id: topicId, parse_mode: 'HTML' },
      );
    } catch (err) {
      console.error('[/search] createForumTopic failed:', err);
      await ctx.answerCbQuery('❌ Tạo topic thất bại');
    }
  });

  // Bot phải là admin và allowed_updates phải có "message_reaction"
  tgBot.on('message_reaction', async (ctx) => {
    try {
      if (!currentApi) return;
      const update = ctx.messageReaction;
      if (!update) return;

      // Determine which reaction was added (new_reaction - old_reaction)
      type EmojiReaction = { type: 'emoji'; emoji: string };
      const isEmoji = (r: { type: string }): r is EmojiReaction => r.type === 'emoji';
      const oldEmojis = new Set(
        update.old_reaction
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter(r => isEmoji(r as any))
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map(r => (r as any).emoji as string),
      );
      const added = update.new_reaction
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter(r => isEmoji(r as any) && !oldEmojis.has((r as any).emoji as string));

      // If nothing was added (only removed), skip
      if (added.length === 0) return;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tgEmoji = (added[0] as any).emoji as string;

      // Map TG emoji → Zalo Reactions icon
      // Zalo Reactions enum values are the icon strings used in addReaction
      const TG_TO_ZALO: Record<string, string> = {
        '❤':  '/-heart',
        '❤️': '/-heart',
        '👍':  '/-strong',
        '👎':  '/-weak',
        '😄':  ':>',
        '😁':  ':>',
        '😢':  ':-((',
        '😭':  ':((',
        '😮':  ':o',
        '😱':  ':o',
        '😡':  ':-h',
        '🤬':  ':-h',
        '😘':  ':-*',
        '🥰':  ';xx',
        '😍':  ';xx',
        '🤣':  ":'>",
        '😂':  ":'>",
        '💩':  '/-shit',
        '🌹':  '/-rose',
        '💔':  '/-break',
        '😕':  ';-/',
        '🤔':  ';-/',
        '😉':  ';-)',
        '👌':  '/-ok',
        '✌️':  '/-v',
        '✌':  '/-v',
        '🙏':  '_()_',
        '👊':  '/-punch',
        '🤯':  ':o',
        '🎉':  '/-bd',
        '🏆':  '/-ok',
        '💯':  '/-ok',
        '😎':  'x-)',
        '🤩':  'x-)',
        '🔥':  '/-heart',
      };

      const zaloIcon = TG_TO_ZALO[tgEmoji];
      if (!zaloIcon) {
        console.log(`[TG→Zalo] Reaction: no Zalo map for TG emoji "${tgEmoji}"`);
        return;
      }

      // Look up Zalo quote data for this TG message
      const tgMsgId = update.message_id;
      const quote   = msgStore.getQuote(tgMsgId);
      if (!quote) {
        console.log(`[TG→Zalo] Reaction: no Zalo quote for TG msg ${tgMsgId}`);
        return;
      }

      const { ThreadType } = await import('zca-js');
      const zaloThreadType = quote.threadType === 1 ? ThreadType.Group : ThreadType.User;

      await currentApi.addReaction(
        { rType: 0, source: 0, icon: zaloIcon },
        {
          data: { msgId: quote.msgId, cliMsgId: quote.cliMsgId },
          threadId: quote.zaloId,
          type: zaloThreadType,
        },
      );
      console.log(`[TG→Zalo] Reaction "${tgEmoji}" → Zalo "${zaloIcon}" on msg ${quote.msgId}`);
    } catch (err) {
      console.error('[TG→Zalo] Reaction error:', err);
    }
  });

  tgBot.on('message', async (ctx) => {
    try {
      const msg = ctx.message;
      // Only handle messages from our bridge group
      if (ctx.chat.id !== config.telegram.groupId) return;

      // Must originate from a topic (all bridged conversations live in topics)
      const topicId =
        'message_thread_id' in msg ? (msg.message_thread_id as number | undefined) : undefined;
      if (!topicId) return;

      // Zalo not connected yet
      if (!currentApi) {
        console.warn('[TG→Zalo] currentApi is null – Zalo not connected. Ignoring message.');
        return;
      }

      // Capture api reference so closures below always use the same instance
      const api = currentApi;

      // Look up the corresponding Zalo conversation
      const entry = store.getEntryByTopic(topicId);
      if (!entry) {
        console.warn(`[TG→Zalo] No Zalo mapping for topicId=${topicId}`);
        return;
      }

      const { zaloId } = entry;
      // Ensure numeric value is correctly mapped to ThreadType enum at runtime
      const threadType: ThreadType = entry.type === 1 ? ThreadType.Group : ThreadType.User;

      // Helper: send TG error notification back to the same topic
      const notifyError = async (action: string, err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: number }).code;
        console.error(`[TG→Zalo] ${action} failed (zaloId=${zaloId}, type=${threadType}):`, err);

        // Provide a friendlier explanation for common Zalo error codes
        let hint = '';
        if (code === 114) {
          hint = threadType === ThreadType.User
            ? '\n💡 <i>Zalo từ chối: chưa kết bạn hoặc người dùng đã bật giới hạn tin nhắn từ người lạ.</i>'
            : '\n💡 <i>Zalo từ chối tham số (code 114).</i>';
        } else if (code === -216) {
          hint = '\n💡 <i>Phiên đăng nhập Zalo hết hạn. Dùng /login để đăng nhập lại.</i>';
        }

        await tgBot.telegram
          .sendMessage(
            config.telegram.groupId,
            `⚠️ Gửi thất bại: <b>${action}</b>\n<code>${errMsg}${code != null ? ` (code ${code})` : ''}</code>${hint}`,
            { message_thread_id: topicId, parse_mode: 'HTML' },
          )
          .catch(() => undefined);
      };

      if ('text' in msg && msg.text) {
        // Skip bot commands that were already handled above
        if (msg.text.startsWith('/')) return;
        console.log(`[TG→Zalo] sendMessage → zaloId=${zaloId} type=${threadType} text="${msg.text.slice(0, 80)}"`);
        // Look up Zalo quote data if this TG message is a reply
        const replyToMsgId = msg.reply_to_message?.message_id;
        const zaloQuote = replyToMsgId !== undefined ? msgStore.getQuote(replyToMsgId) : undefined;

        const zaloMentions = resolveTgMentions(
          msg.text,
          ('entities' in msg ? msg.entities : undefined) as ReadonlyArray<TgEntity> | undefined,
          threadType === ThreadType.Group,
        );

        try {
          const sendResult = await api.sendMessage(
            {
              msg: msg.text,
              ...(zaloQuote ? { quote: zaloQuote } : {}),
              ...(zaloMentions.length ? { mentions: zaloMentions } : {}),
            },
            zaloId,
            threadType,
          );
          const zaloMsgId = sendResult?.message?.msgId;
          if (zaloMsgId !== undefined) {
            sentMsgStore.save(msg.message_id, { msgId: zaloMsgId, zaloId, threadType });
          }
        } catch (err) {
          await notifyError('sendMessage', err);
        }
        return;
      }

      // helper: download TG file → send via uploadAttachment → cleanup
      const TG_FILE_LIMIT = 20 * 1024 * 1024; // 20 MB — Telegram Bot API hard limit
      const notifyTooBig = async (filename: string, sizeBytes?: number) => {
        const sizeMb = sizeBytes ? ` (${(sizeBytes / 1024 / 1024).toFixed(1)} MB)` : '';
        await notifyError(
          `sendAttachment(${filename})`,
          new Error(`File${sizeMb} vượt giới hạn 20 MB của Telegram Bot API — không thể tải xuống`),
        );
      };

      const sendAttachment = async (
        fileId: string,
        filename: string,
        fileSize?: number,
        caption?: string,
        captionMentions?: Array<{ pos: number; uid: string; len: number }>,
      ) => {
        // Telegram Bot API cannot download files > 20 MB
        if (fileSize !== undefined && fileSize > TG_FILE_LIMIT) {
          await notifyTooBig(filename, fileSize);
          return;
        }
        // Pass Zalo quote if the TG message is a reply to a forwarded Zalo message
        const replyToMsgId = 'reply_to_message' in msg
          ? (msg as { reply_to_message?: { message_id: number } }).reply_to_message?.message_id
          : undefined;
        const zaloQuote = replyToMsgId !== undefined ? msgStore.getQuote(replyToMsgId) : undefined;
        let fileLink: URL;
        try {
          fileLink = await ctx.telegram.getFileLink(fileId);
        } catch (err: unknown) {
          const isTooBig = err instanceof Error && err.message.includes('file is too big');
          if (isTooBig) { await notifyTooBig(filename, fileSize); return; }
          throw err;
        }
        const localPath = await downloadToTemp(fileLink.toString(), filename);
        try {
          console.log(`[TG→Zalo] Sending ${filename} → zaloId=${zaloId} type=${threadType}`);
          const sendPromise = api.sendMessage(
            {
              msg: caption ?? '',
              attachments: [localPath],
              ...(zaloQuote ? { quote: zaloQuote } : {}),
              ...(captionMentions?.length ? { mentions: captionMentions } : {}),
            },
            zaloId,
            threadType,
          );
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Send timeout (30s)')), 30_000),
          );
          const sendResult = await Promise.race([sendPromise, timeoutPromise]) as {
            message?: { msgId?: number } | null;
            attachment?: Array<{ msgId?: number }>;
          };
          const zaloMsgId = sendResult?.message?.msgId ?? sendResult?.attachment?.[0]?.msgId;
          if (zaloMsgId !== undefined) {
            sentMsgStore.save(msg.message_id, { msgId: zaloMsgId, zaloId, threadType });
          }
          console.log(`[TG→Zalo] Send OK: ${filename}`);
        } catch (err) {
          await notifyError(`sendAttachment(${filename})`, err);
        } finally {
          await cleanTemp(localPath);
        }
      };

      // Helper: extract caption + resolved mentions from any media message
      const getCaptionMentions = () => {
        const cap = ('caption' in msg ? (msg as { caption?: string }).caption : undefined);
        const capEntities = ('caption_entities' in msg
          ? (msg as { caption_entities?: ReadonlyArray<TgEntity> }).caption_entities
          : undefined);
        const capMentions = cap
          ? resolveTgMentions(cap, capEntities, threadType === ThreadType.Group)
          : undefined;
        return { cap, capMentions };
      };

      if ('photo' in msg && msg.photo && msg.photo.length > 0) {
        const photo = msg.photo[msg.photo.length - 1]!;
        const { cap, capMentions } = getCaptionMentions();
        await sendAttachment(photo.file_id, 'photo.jpg', photo.file_size, cap, capMentions);
        return;
      }

      if ('animation' in msg && msg.animation) {
        const fname = msg.animation.file_name ?? 'animation.gif';
        const { cap, capMentions } = getCaptionMentions();
        await sendAttachment(msg.animation.file_id, fname, msg.animation.file_size, cap, capMentions);
        return;
      }

      if ('document' in msg && msg.document) {
        const doc   = msg.document;
        const fname = doc.file_name ?? `file_${Date.now()}.bin`;
        const { cap, capMentions } = getCaptionMentions();
        await sendAttachment(doc.file_id, fname, doc.file_size, cap, capMentions);
        return;
      }

      if ('video' in msg && msg.video) {
        const vid   = msg.video;
        const fname = vid.file_name ?? `video_${Date.now()}.mp4`;
        const { cap, capMentions } = getCaptionMentions();
        await sendAttachment(vid.file_id, fname, vid.file_size, cap, capMentions);
        return;
      }

      if ('voice' in msg && msg.voice) {
        // Telegram voice notes are always small (<1 min OGG Opus), well under 20 MB
        if ((msg.voice.file_size ?? 0) > TG_FILE_LIMIT) {
          await notifyTooBig(`voice_${Date.now()}.ogg`, msg.voice.file_size);
          return;
        }
        // Download OGG from TG, convert to M4A, upload to Zalo, send as voice bubble
        let fileLink: URL;
        try { fileLink = await ctx.telegram.getFileLink(msg.voice.file_id); }
        catch (err: unknown) {
          const isTooBig = err instanceof Error && err.message.includes('file is too big');
          if (isTooBig) { await notifyTooBig(`voice_${Date.now()}.ogg`, msg.voice.file_size); return; }
          throw err;
        }
        const oggPath  = await downloadToTemp(fileLink.toString(), `voice_${Date.now()}.ogg`);
        let m4aPath: string | undefined;
        try {
          m4aPath = await convertToM4a(oggPath);
          // Upload to Zalo CDN to get a voiceUrl
          const uploaded = await api.uploadAttachment(m4aPath, zaloId, threadType) as Array<{ fileUrl?: string }>;
          const voiceUrl = uploaded[0]?.fileUrl;
          if (!voiceUrl) throw new Error('No fileUrl from uploadAttachment');
          console.log(`[TG→Zalo] Sending voice → ${voiceUrl}`);
          await api.sendVoice({ voiceUrl }, zaloId, threadType);
          console.log(`[TG→Zalo] Voice sent OK`);
        } catch (err) {
          console.error('[TG→Zalo] Voice convert/send failed, falling back to file:', err);
          await sendAttachment(msg.voice.file_id, `voice_${Date.now()}.ogg`);
        } finally {
          await cleanTemp(oggPath);
          if (m4aPath) await cleanTemp(m4aPath);
        }
        return;
      }

      if ('sticker' in msg && msg.sticker) {
        const sticker = msg.sticker;
        // For animated (tgs) or video (webm) stickers, use the jpg thumbnail
        // so Zalo receives a viewable image instead of a binary animation blob.
        const useThumb = (sticker.is_animated || sticker.is_video) && sticker.thumbnail;
        const fileId   = useThumb ? sticker.thumbnail!.file_id : sticker.file_id;
        const ext      = useThumb ? '.jpg' : '.webp';
        await sendAttachment(fileId, `sticker_${Date.now()}${ext}`);
        return;
      }

      if ('poll' in msg && msg.poll) {
        const tgPoll = msg.poll;
        console.log(`[TG→Zalo] Received TG poll: id=${tgPoll.id} question="${tgPoll.question}" is_anonymous=${tgPoll.is_anonymous}`);

        if (threadType !== 1) {
          await ctx.reply('❌ Chỉ tạo bình chọn được trong nhóm Zalo.', { message_thread_id: topicId });
          return;
        }

        try {
          // 1. Create poll on Zalo
          const created = await api.createPoll(
            {
              question:         tgPoll.question,
              options:          tgPoll.options.map((o: { text: string }) => o.text),
              isAnonymous:      false,   // force non-anonymous so poll_answer fires
              allowMultiChoices: tgPoll.allows_multiple_answers ?? false,
            },
            zaloId,
          );
          console.log(`[TG→Zalo] Zalo poll created: pollId=${created?.poll_id}`);

          // 2. Bot re-creates the same poll on TG (non-anonymous so bot gets poll_answer)
          const botPollMsg = await tgBot.telegram.sendPoll(
            config.telegram.groupId,
            tgPoll.question,
            tgPoll.options.map((o: { text: string }) => o.text),
            {
              message_thread_id:       topicId,
              is_anonymous:            false,
              allows_multiple_answers: tgPoll.allows_multiple_answers ?? false,
            } as Parameters<typeof tgBot.telegram.sendPoll>[3],
          );
          const tgPollUUID = (botPollMsg as { poll?: { id?: string } }).poll?.id ?? '';
          console.log(`[TG→Zalo] Bot TG poll sent: msgId=${botPollMsg.message_id} uuid=${tgPollUUID}`);

          // 3. Build option list from Zalo response
          const zaloPollOptions = created?.options ?? tgPoll.options.map((o: { text: string }, i: number) => ({
            option_id: i, content: o.text, votes: 0,
          }));

          // 4. Send score message below bot's poll
          const scoreLines = zaloPollOptions.map((o: { content: string }) =>
            `${o.content}\n  ${'░'.repeat(10)} 0 phiếu (0%)`,
          );
          const scoreText = `📊 <b>Kết quả bình chọn</b>\n<i>(tạo từ Telegram)</i>\n\nTổng: 0 phiếu\n\n${scoreLines.join('\n\n')}`;
          const lockPollId = created?.poll_id ?? 0;
          const tgScoreMsg = await tgBot.telegram.sendMessage(
            config.telegram.groupId,
            scoreText,
            {
              message_thread_id: topicId,
              parse_mode: 'HTML',
              reply_parameters: { message_id: botPollMsg.message_id, allow_sending_without_reply: true },
              reply_markup: {
                inline_keyboard: [[
                  { text: '🔒 Khoá bình chọn', callback_data: `lock_poll:${lockPollId}` },
                ]],
              },
            },
          );

          // 5. Save to pollStore — keyed by both pollId and tgPollUUID
          if (created?.poll_id) {
            pollStore.save({
              pollId:           created.poll_id,
              zaloGroupId:      zaloId,
              tgPollMsgId:      botPollMsg.message_id,
              tgOrigPollMsgId:  msg.message_id,   // user's original poll
              tgPollUUID:       tgPollUUID,
              tgScoreMsgId:     tgScoreMsg.message_id,
              tgThreadId:       topicId,
              options: zaloPollOptions.map((o: { option_id?: number; content: string }, i: number) => ({
                option_id: o.option_id ?? i,
                content:   o.content,
              })),
            });
          }
        } catch (err) {
          console.error('[TG→Zalo] createPoll failed:', err);
          await tgBot.telegram.sendMessage(
            config.telegram.groupId,
            '❌ Không thể tạo bình chọn trên Zalo.',
            { message_thread_id: topicId },
          );
        }
        return;
      }

      if ('location' in msg && msg.location) {
        const { latitude, longitude } = msg.location;
        const mapsUrl = `https://www.google.com/maps?q=${latitude},${longitude}`;
        try {
          // zca-js has no sendLocation — use sendLink for a map preview bubble in Zalo
          await api.sendLink(
            { msg: '', link: mapsUrl },
            zaloId,
            threadType,
          );
          console.log(`[TG→Zalo] Location sent: ${latitude},${longitude}`);
        } catch (err) {
          // Fallback: send as plain text link
          await api.sendMessage({ msg: `📍 ${mapsUrl}` }, zaloId, threadType);
        }
        return;
      }
    } catch (err) {
      console.error('[TG→Zalo] Error:', err);
    }
  });

  async function doLockPoll(entry: import('../store.js').PollEntry, api: ZaloAPI): Promise<void> {
    await api.lockPoll(entry.pollId);
    console.log(`[TG→Zalo] Locked Zalo poll ${entry.pollId}`);
    // Stop bot's clone TG poll
    try {
      await tgBot.telegram.stopPoll(config.telegram.groupId, entry.tgPollMsgId);
    } catch { /* already stopped or no permission */ }
    // Stop original user poll too (if we have its message_id)
    if (entry.tgOrigPollMsgId) {
      try {
        await tgBot.telegram.stopPoll(config.telegram.groupId, entry.tgOrigPollMsgId);
      } catch { /* no admin rights or already stopped */ }
    }
    // Update score message: show [Đã đóng], remove lock button
    try {
      const detail = await api.getPollDetail(entry.pollId);
      if (detail?.options) {
        const total = detail.options.reduce((s: number, o: { votes: number }) => s + (o.votes ?? 0), 0);
        const lines = (detail.options as Array<{ content: string; votes: number }>).map(o => {
          const pct = total > 0 ? Math.round((o.votes / total) * 100) : 0;
          const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
          return `${o.content}\n  ${bar} ${o.votes} phiếu (${pct}%)`;
        });
        const scoreText = `📊 <b>Kết quả bình chọn <i>[Đã đóng]</i></b>\n\nTổng: ${total} phiếu\n\n${lines.join('\n\n')}`;
        try {
          await tgBot.telegram.editMessageText(
            config.telegram.groupId,
            entry.tgScoreMsgId,
            undefined,
            scoreText,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } },
          );
        } catch { /* too old to edit */ }
      }
    } catch { /* non-fatal */ }
  }

  tgBot.on('poll', async (ctx) => {
    try {
      const poll = ctx.poll;
      if (!poll.is_closed) return;
      const entry = pollStore.getByTgPollUUID(poll.id);
      if (!entry || !currentApi) return;
      await doLockPoll(entry, currentApi);
    } catch (err) {
      console.error('[TG→Zalo] lockPoll error:', err);
    }
  });

  tgBot.on('poll_answer', async (ctx) => {
    try {
      const answer = ctx.pollAnswer;
      // answer.option_ids: array of 0-based indices chosen in TG poll
      // answer.poll_id: TG internal poll ID (NOT the Zalo pollId)
      // We track by message_id via pollStore, but Telegraf poll_answer only has poll_id.
      // pollStore also indexes by tgPollMsgId. TG doesn't give us the message_id in poll_answer,
      // so we keep a secondary index by TG poll UUID in our store via a separate lookup.
      // Telegraf ctx.pollAnswer.poll_id is the TG poll identifier — we stored tgPollMsgId.
      // Workaround: iterate pollStore (small set) by checking tgPollUUID stored during creation.

      // Since we can only look up by tgPollMsgId but TG gives us poll_id (a string UUID),
      // we store the mapping tgPollUUID → pollId when the poll is sent.
      const tgPollUUID = answer.poll_id;
      console.log(`[TG→Zalo] poll_answer: poll_id=${tgPollUUID} option_ids=[${answer.option_ids}]`);
      const entry = pollStore.getByTgPollUUID(tgPollUUID);
      if (!entry) {
        console.log('[TG→Zalo] poll_answer: unknown poll UUID', tgPollUUID);
        return;
      }

      if (!currentApi) return;
      const api = currentApi;

      // Map TG 0-based option indices → Zalo option_ids
      const optionIds = answer.option_ids
        .map(idx => entry.options[idx]?.option_id)
        .filter((id): id is number => id !== undefined);

      // empty option_ids = user retracted vote — refresh score only, no Zalo call
      const refreshScore = async () => {
        try {
          const detail = await api.getPollDetail(entry.pollId);
          if (!detail?.options) return;
          const total = detail.options.reduce((s: number, o: { votes: number }) => s + (o.votes ?? 0), 0);
          const lines = (detail.options as Array<{ content: string; votes: number }>).map(o => {
            const pct = total > 0 ? Math.round((o.votes / total) * 100) : 0;
            const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
            return `${o.content}\n  ${bar} ${o.votes} phiếu (${pct}%)`;
          });
          const status = detail.closed ? ' <i>[Đã đóng]</i>' : '';
          const scoreText = `📊 <b>Kết quả bình chọn${status}</b>\n\nTổng: ${total} phiếu\n\n${lines.join('\n\n')}`;
          const replyMarkup = detail.closed
            ? { inline_keyboard: [] as { text: string; callback_data: string }[][] }
            : { inline_keyboard: [[{ text: '🔒 Khoá bình chọn', callback_data: `lock_poll:${entry.pollId}` }]] };
          try {
            await tgBot.telegram.editMessageText(
              config.telegram.groupId,
              entry.tgScoreMsgId,
              undefined,
              scoreText,
              { parse_mode: 'HTML', reply_markup: replyMarkup },
            );
          } catch {
            const newMsg = await tgBot.telegram.sendMessage(
              config.telegram.groupId,
              scoreText,
              { message_thread_id: entry.tgThreadId, parse_mode: 'HTML',
                reply_parameters: { message_id: entry.tgPollMsgId, allow_sending_without_reply: true },
                reply_markup: replyMarkup },
            );
            pollStore.updateScoreMsg(entry.pollId, newMsg.message_id);
          }
        } catch (e) {
          console.warn('[TG→Zalo] poll score refresh failed:', e);
        }
      };

      if (optionIds.length === 0) {
        // Vote retracted — unvote on Zalo then refresh score
        try {
          await api.votePoll(entry.pollId, []);
          console.log(`[TG→Zalo] Unvoted poll ${entry.pollId}`);
        } catch (e) {
          console.warn('[TG→Zalo] unvote failed:', e);
        }
        await refreshScore();
        return;
      }

      // votePoll accepts single id or array
      await api.votePoll(entry.pollId, optionIds.length === 1 ? optionIds[0] : optionIds);
      console.log(`[TG→Zalo] Voted poll ${entry.pollId} options [${optionIds}]`);

      // Immediately refresh score message
      await refreshScore();
    } catch (err) {
      console.error('[TG→Zalo] poll_answer error:', err);
    }
  });

  return setCurrentApi;
}

// Called by setupTelegramHandler, but defined after so we can reference tgBot directly.

