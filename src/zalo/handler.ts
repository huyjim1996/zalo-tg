import { ThreadType } from 'zca-js';
import { createReadStream } from 'fs';
import path from 'path';
import QRCode from 'qrcode';

import type { ZaloAPI, ZaloMessage, ZaloMediaContent, ZaloGroupInfoResponse } from './types.js';
import { ZALO_MSG_TYPES } from './types.js';
import { store } from '../store.js';
import { tgBot } from '../telegram/bot.js';
import { config } from '../config.js';
import { downloadToTemp, cleanTemp } from '../utils/media.js';
import { applyMentionsHtml, formatGroupMsgHtml, formatGroupMsg, groupCaption, topicName, truncate, escapeHtml } from '../utils/format.js';
import { msgStore, userCache, type ZaloQuoteData } from '../store.js';

// ── Bank card HTML parser ────────────────────────────────────────────────────
interface BankCardInfo {
  bankName: string;
  accountNumber: string;
  holderName?: string;
  vietqr: string;
}

function parseBankCardHtml(html: string): BankCardInfo | null {
  const ptags = [...html.matchAll(/<p[^>]*>([^<]+)<\/p>/g)]
    .map(m => m[1].trim()).filter(t => t.length > 0);

  const normalised = html.replace(/&amp;/g, '&');
  const contentMatch = normalised.match(/content=([^&"< ]+)/);
  if (!contentMatch) return null;
  const vietqr = decodeURIComponent(contentMatch[1]);

  // p-tag order from Zalo HTML: [BIN, BankName, AccountNumber, HolderName?, ...]
  const numericTags = ptags.filter(t => /^\d+$/.test(t));
  const textTags    = ptags.filter(t => !/^\d+$/.test(t));

  const accountNumber = numericTags.find(t => t.length !== 6) ?? numericTags[1] ?? numericTags[0] ?? '';
  const bankName      = textTags[0] ?? '';
  const holderName    = textTags[1]?.trim() || undefined;

  if (!vietqr) return null;
  return { bankName, accountNumber, holderName, vietqr };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Fetch group member list and populate `userCache` so mention resolution works
 * immediately even before any group message is received.
 */
async function populateGroupMemberCache(api: ZaloAPI, groupId: string): Promise<void> {
  try {
    const info = await api.getGroupInfo(groupId) as {
      gridInfoMap?: Record<string, {
        memVerList?: string[];
        totalMember?: number;
      }>;
    };
    const groupData = info?.gridInfoMap?.[groupId];
    if (!groupData) {
      console.warn(`[Zalo] getGroupInfo: no data for group ${groupId}`);
      return;
    }

    // memVerList entries are "uid_version" — extract UIDs
    const uids = (groupData.memVerList ?? [])
      .map(s => s.split('_')[0])
      .filter(Boolean);
    if (uids.length === 0) {
      console.warn(`[Zalo] group ${groupId}: empty memVerList (totalMember=${groupData.totalMember})`);
      return;
    }

    // Batch-fetch display names (getUserInfo accepts up to ~50 per call)
    const BATCH = 50;
    let saved = 0;
    for (let i = 0; i < uids.length; i += BATCH) {
      const batch = uids.slice(i, i + BATCH);
      const resp = await api.getUserInfo(batch) as {
        changed_profiles?: Record<string, { displayName?: string; zaloName?: string }>;
        unchanged_profiles?: Record<string, unknown>;
      };
      const profiles = resp?.changed_profiles ?? {};
      // unchanged_profiles also has profile data
      const unchanged = resp?.unchanged_profiles ?? {};
      for (const uid of batch) {
        const p = (profiles[uid] ?? unchanged[uid]) as { displayName?: string; zaloName?: string } | undefined;
        const name = p?.displayName?.trim() || p?.zaloName?.trim();
        if (uid && name) { userCache.save(uid, name); saved++; }
      }
    }
    console.log(`[Zalo] Cached ${saved}/${uids.length} members for group ${groupId}`);
  } catch (err) {
    console.warn(`[Zalo] populateGroupMemberCache failed for ${groupId}:`, err);
  }
}

async function getOrCreateTopic(
  zaloId: string,
  type: 0 | 1,
  displayName: string,
): Promise<number> {
  const existing = store.getTopicByZalo(zaloId, type);
  if (existing !== undefined) return existing;

  const name  = topicName(displayName, type);
  const color = type === ThreadType.Group ? 0xFF93B2 : 0x6FB9F0;

  const topic = await tgBot.telegram.createForumTopic(
    config.telegram.groupId,
    name,
    { icon_color: color },
  );

  const topicId = topic.message_thread_id;
  store.set({ topicId, zaloId, type, name: displayName });
  console.log(`[Zalo→TG] New topic: "${name}" (topicId=${topicId})`);
  return topicId;
}

/**
 * Parse `content` field which is either a JSON string, a plain string, or
 * already an object. Returns a normalised `ZaloMediaContent` object.
 */
function parseContent(raw: string | ZaloMediaContent | Record<string, unknown>): {
  text: string | null;
  media: ZaloMediaContent;
} {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as ZaloMediaContent;
      return { text: null, media: parsed };
    } catch {
      // plain text string
      return { text: raw, media: {} };
    }
  }
  return { text: null, media: raw as ZaloMediaContent };
}

// ── Main handler ─────────────────────────────────────────────────────────────

/** Track which groups already had their member cache populated this session. */
const _memberCacheLoaded = new Set<string>();

export function setupZaloHandler(api: ZaloAPI): void {
  // Pre-populate userCache for all existing group topics on startup
  for (const entry of store.all()) {
    if (entry.type === 1 /* Group */) {
      void populateGroupMemberCache(api, entry.zaloId);
      _memberCacheLoaded.add(entry.zaloId);
    }
  }

  api.listener.on('message', async (msg: ZaloMessage) => {
    try {
      if (msg.isSelf) return;

      const zaloId     = msg.threadId;
      const type       = msg.type as 0 | 1;
      const senderName = msg.data.dName ?? msg.data.uidFrom;
      const msgType    = msg.data.msgType ?? ZALO_MSG_TYPES.TEXT;

      // Pre-populate member cache the first time we see a new group
      if (type === 1 && !_memberCacheLoaded.has(zaloId)) {
        _memberCacheLoaded.add(zaloId);
        void populateGroupMemberCache(api, zaloId);
      }

      // Keep userCache up-to-date so TG→Zalo mention resolution works
      userCache.save(msg.data.uidFrom, senderName);

      // Resolve group name
      let displayName = senderName;
      if (type === ThreadType.Group) {
        try {
          const info = await api.getGroupInfo(zaloId) as ZaloGroupInfoResponse;
          displayName = info?.gridInfoMap?.[zaloId]?.name ?? senderName;
        } catch { /* non-fatal */ }
      }

      const topicId = await getOrCreateTopic(zaloId, type, displayName);

      // Resolve Telegram reply target from incoming Zalo quote (if any)
      let tgReplyMsgId: number | undefined;
      if (msg.data.quote) {
        tgReplyMsgId = msgStore.getTgMsgId(String(msg.data.quote.globalMsgId));
      }

      // Base TG send options (with optional reply_parameters)
      const tgBase: {
        message_thread_id: number;
        reply_parameters?: { message_id: number; allow_sending_without_reply: boolean };
      } = { message_thread_id: topicId };
      if (tgReplyMsgId !== undefined) {
        tgBase.reply_parameters = { message_id: tgReplyMsgId, allow_sending_without_reply: true };
      }

      const caption = type === ThreadType.Group ? groupCaption(senderName) : undefined;
      const tgOpts  = { ...tgBase, parse_mode: 'HTML' as const, caption };

      // Build quote data + mapping helper — saved after every successful TG send
      const zaloMsgIds = msg.data.realMsgId && msg.data.realMsgId !== msg.data.msgId
        ? [msg.data.msgId, msg.data.realMsgId]
        : [msg.data.msgId];
      const zaloQuoteData: ZaloQuoteData = {
        msgId:    msg.data.msgId,
        cliMsgId: msg.data.cliMsgId ?? '',
        uidFrom:  msg.data.uidFrom,
        ts:       msg.data.ts,
        msgType:  msgType,
        content:  msg.data.content as string | Record<string, unknown>,
        ttl:      msg.data.ttl ?? 0,
        zaloId,
        threadType: type,
      };
      const saveTgMapping = (sent: { message_id: number }) => {
        msgStore.save(sent.message_id, zaloMsgIds, zaloQuoteData);
      };

      const { text, media } = parseContent(msg.data.content);

      // ── 1. Plain text ──────────────────────────────────────────────────────
      if (msgType === ZALO_MSG_TYPES.TEXT || (text !== null)) {
        const body = text ?? (typeof msg.data.content === 'string' ? msg.data.content : '');
        if (!body.trim()) return;
        const mentions = msg.data.mentions;
        const bodyHtml = mentions?.length
          ? applyMentionsHtml(truncate(body), mentions)
          : escapeHtml(truncate(body));
        const tgText = type === ThreadType.Group
          ? formatGroupMsgHtml(senderName, bodyHtml)
          : bodyHtml;
        const sent = await tgBot.telegram.sendMessage(
          config.telegram.groupId,
          tgText,
          { ...tgBase, parse_mode: 'HTML' },
        );
        saveTgMapping(sent);
        return;
      }

      // ── 2. Photo / Image ───────────────────────────────────────────────────
      if (msgType === ZALO_MSG_TYPES.PHOTO) {
        // prefer HD from params, fall back to href
        let url = media.href;
        if (media.params) {
          try {
            const p = JSON.parse(media.params) as { hd?: string };
            if (p.hd) url = p.hd;
          } catch { /* ignore */ }
        }
        if (!url) { console.warn('[ZaloHandler] Photo: no URL found in content:', media); return; }
        const localPath = await downloadToTemp(url, `photo_${Date.now()}.jpg`);
        const stream = createReadStream(localPath);
        try {
          const sent = await tgBot.telegram.sendPhoto(config.telegram.groupId, { source: stream }, tgOpts);
          saveTgMapping(sent);
        } finally { await cleanTemp(localPath); }
        return;
      }

      // ── 3. GIF ─────────────────────────────────────────────────────────────
      if (msgType === ZALO_MSG_TYPES.GIF) {
        const url = media.href;
        if (!url) {
          console.warn('[ZaloHandler] GIF: no URL found in content:', media);
          return;
        }
        const ext = path.extname(url.split('?')[0] ?? '').toLowerCase() || '.mp4';
        const localPath = await downloadToTemp(url, `gif_${Date.now()}${ext}`);
        const stream = createReadStream(localPath);
        try {
          const sent = await tgBot.telegram.sendAnimation(
            config.telegram.groupId,
            { source: stream },
            tgOpts,
          );
          saveTgMapping(sent);
        } finally { await cleanTemp(localPath); }
        return;
      }

      // ── 4. File ────────────────────────────────────────────────────────────
      if (msgType === ZALO_MSG_TYPES.FILE) {
        const url = media.href;
        // title holds the original filename (e.g. "report.pdf")
        const fileName = media.title ?? `file_${Date.now()}`;
        if (!url) {
          console.warn('[ZaloHandler] File: no URL found in content:', media);
          return;
        }
        const localPath = await downloadToTemp(url, fileName);
        const stream = createReadStream(localPath);
        try {
          const sent = await tgBot.telegram.sendDocument(
            config.telegram.groupId,
            { source: stream, filename: fileName },
            tgOpts,
          );
          saveTgMapping(sent);
        } finally { await cleanTemp(localPath); }
        return;
      }

      // ── 5. Video ───────────────────────────────────────────────────────────
      if (msgType === ZALO_MSG_TYPES.VIDEO) {
        const url = media.href;
        if (!url) { console.warn('[ZaloHandler] Video: no URL found in content:', media); return; }
        const localPath = await downloadToTemp(url, `video_${Date.now()}.mp4`);
        const stream = createReadStream(localPath);
        try {
          const sent = await tgBot.telegram.sendVideo(config.telegram.groupId, { source: stream }, tgOpts);
          saveTgMapping(sent);
        } finally { await cleanTemp(localPath); }
        return;
      }

      // ── 6. Voice ───────────────────────────────────────────────────────────
      if (msgType === ZALO_MSG_TYPES.VOICE) {
        const url = media.href;
        if (!url) { console.warn('[ZaloHandler] Voice: no URL found in content:', media); return; }
        const ext = path.extname(url.split('?')[0] ?? '').toLowerCase() || '.m4a';
        const localPath = await downloadToTemp(url, `voice_${Date.now()}${ext}`);
        const stream = createReadStream(localPath);
        try {
          const sent = await tgBot.telegram.sendVoice(config.telegram.groupId, { source: stream }, tgOpts);
          saveTgMapping(sent);
        } finally { await cleanTemp(localPath); }
        return;
      }

      // ── 7. Sticker – fetch real URL via getStickersDetail ──────────────────
      if (msgType === ZALO_MSG_TYPES.STICKER) {
        const stickerId = media.id;
        if (!stickerId) {
          console.warn('[ZaloHandler] Sticker: no id in content:', media);
          return;
        }
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const details: any[] = await api.getStickersDetail([stickerId]);
          const detail = details?.[0];
          const url: string | undefined =
            detail?.stickerWebpUrl ?? detail?.stickerUrl ?? detail?.stickerSpriteUrl;
          if (!url) {
            console.warn('[ZaloHandler] Sticker: no URL in detail:', detail);
            return;
          }
          const ext = path.extname(url.split('?')[0] ?? '').toLowerCase() || '.webp';
          const localPath = await downloadToTemp(url, `sticker_${Date.now()}${ext}`);
          const stream = createReadStream(localPath);
          try {
            const sent = await tgBot.telegram.sendPhoto(config.telegram.groupId, { source: stream }, tgOpts);
            saveTgMapping(sent);
          } finally { await cleanTemp(localPath); }
        } catch (stickerErr) {
          console.error('[ZaloHandler] Sticker fetch error:', stickerErr);
        }
        return;
      }

      // ── 8. Link ────────────────────────────────────────────────────────────
      if (msgType === ZALO_MSG_TYPES.LINK) {
        const href  = media.href;
        const title = media.title ?? href;
        if (!href) return;
        const linkText = type === ThreadType.Group
          ? `${groupCaption(senderName)}\n<a href="${href}">${title}</a>`
          : `<a href="${href}">${title}</a>`;
        const sent = await tgBot.telegram.sendMessage(config.telegram.groupId, linkText, {
          ...tgBase,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: false },
        });
        saveTgMapping(sent);
        return;
      }

      // ── 9. Web content (Zalo instant: bank card, mini app, etc.) ──────────
      if (msgType === ZALO_MSG_TYPES.WEBCONTENT) {
        // For bank cards: fetch HTML, parse data, send QR image + caption
        if (media.action === 'zinstant.bankcard' && media.params) {
          try {
            const parsedParams = JSON.parse(media.params) as {
              pcItem?: { data_url?: string };
              item?:   { data_url?: string };
            };
            const dataUrl = parsedParams.pcItem?.data_url ?? parsedParams.item?.data_url;
            if (dataUrl) {
              const htmlResp = await fetch(`${dataUrl}?data=html`);
              const html = await htmlResp.text();
              const info = parseBankCardHtml(html);
              if (info) {
                const qrBuf = await QRCode.toBuffer(info.vietqr, {
                  width: 300, margin: 2,
                  color: { dark: '#000000ff', light: '#ffffffff' },
                });
                let caption = `🏦 <b>Tài khoản ngân hàng</b>`;
                if (info.bankName)      caption += `\nNgân hàng: <b>${info.bankName}</b>`;
                if (info.accountNumber) caption += `\nSTK: <code>${info.accountNumber}</code>`;
                if (info.holderName)    caption += `\nChủ TK: <b>${info.holderName}</b>`;
                const fullCaption = type === ThreadType.Group
                  ? `${groupCaption(senderName)}\n${caption}`
                  : caption;
                const sent = await tgBot.telegram.sendPhoto(
                  config.telegram.groupId,
                  { source: qrBuf },
                  { ...tgBase, caption: fullCaption, parse_mode: 'HTML' },
                );
                saveTgMapping(sent);
                return;
              }
            }
          } catch (err) {
            console.error('[ZaloHandler] bankcard parse error:', err);
          }
        }

        // Generic webcontent fallback
        let label = media.title || '';
        try {
          if (media.params) {
            const p = JSON.parse(media.params) as {
              customMsg?: { msg?: { vi?: string; en?: string } };
            };
            const vi = p.customMsg?.msg?.vi;
            const en = p.customMsg?.msg?.en;
            if (vi && vi.trim()) label = vi.trim();
            else if (en && en.trim()) label = en.trim();
          }
        } catch { /* use fallback */ }
        if (!label) label = '[Nội dung web]';

        const ACTION_ICONS: Record<string, string> = {
          'zinstant.bankcard': '🏦',
          'zinstant.transfer': '💸',
          'zinstant.invoice':  '🧾',
          'zinstant.qr':       '📷',
        };
        const icon = ACTION_ICONS[media.action ?? ''] ?? '📋';
        const body = `${icon} ${label}`;
        const text = type === ThreadType.Group ? `${groupCaption(senderName)}\n${body}` : body;
        const sent = await tgBot.telegram.sendMessage(config.telegram.groupId, text, {
          ...tgBase,
          parse_mode: 'HTML',
        });
        saveTgMapping(sent);
        return;
      }

      // ── Fallback ───────────────────────────────────────────────────────────
      console.log(`[ZaloHandler] Unhandled msgType="${msgType}" content:`, JSON.stringify(msg.data.content));
      const fallback = type === ThreadType.Group
        ? `${groupCaption(senderName)}\n<i>[${msgType}]</i>`
        : `<i>[${msgType}]</i>`;
      const sentFallback = await tgBot.telegram.sendMessage(config.telegram.groupId, fallback, {
        ...tgBase,
        parse_mode: 'HTML',
      });
      saveTgMapping(sentFallback);
    } catch (err) {
      console.error('[ZaloHandler] Error:', err);
    }
  });

  // ── Undo (thu hồi tin nhắn) ────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.listener.on('undo', async (undo: any) => {
    try {
      const data = undo?.data;
      // The recalled Zalo message ID
      const zaloMsgId = String(data?.content?.globalMsgId ?? data?.msgId ?? '');
      if (!zaloMsgId) return;

      const tgMsgId = msgStore.getTgMsgId(zaloMsgId);
      if (tgMsgId === undefined) {
        console.log(`[ZaloHandler] Undo: no TG mapping for zaloMsgId=${zaloMsgId}`);
        return;
      }

      // Find which topic this message belongs to
      const zaloId = undo?.threadId ?? data?.idTo;
      const type   = (undo?.isGroup ? 1 : 0) as 0 | 1;
      const topicId = store.getTopicByZalo(String(zaloId), type);
      if (topicId === undefined) return;

      // Delete the forwarded TG message
      await tgBot.telegram.deleteMessage(config.telegram.groupId, tgMsgId);
      console.log(`[ZaloHandler] Undo: deleted TG msg ${tgMsgId} (zaloMsgId=${zaloMsgId})`);

      // Notify in topic
      await tgBot.telegram.sendMessage(
        config.telegram.groupId,
        `<i>🗑 Tin nhắn đã được thu hồi</i>`,
        { message_thread_id: topicId, parse_mode: 'HTML' },
      );
    } catch (err) {
      console.error('[ZaloHandler] Undo error:', err);
    }
  });

  // ── Reaction (cảm xúc) ─────────────────────────────────────────────────────
  const REACTION_EMOJI: Record<string, string> = {
    '/-heart':   '❤️',
    '/-strong':  '👍',
    ':>':        '😄',
    ':o':        '😮',
    ':-((':      '😢',
    ':-h':       '😡',
    ':-*':       '😘',
    ":')":       '😂',
    '/-shit':    '💩',
    '/-rose':    '🌹',
    '/-break':   '💔',
    '/-weak':    '👎',
    ';xx':       '🥰',
    ';-/':       '😕',
    ';-)':       '😉',
    '/-fade':    '✨',
    '/-ok':      '👌',
    '/-v':       '✌️',
    '/-thanks':  '🙏',
    '/-punch':   '👊',
    '/-no':      '🙅',
    '/-loveu':   '🤟',
    '--b':       '😞',
    ':((': '😭',
    'x-)':       '😎',
    '_()_':      '🙏',
    '/-bd':      '🎂',
    '/-bome':    '💣',
    '/-beer':    '🍺',
    '/-li':      '☀️',
    '/-share':   '🔁',
    '/-bad':     '😤',
    '':          '❌',  // remove reaction
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.listener.on('reaction', async (reaction: any) => {
    try {
      const data = reaction?.data;
      const rIcon: string = data?.content?.rIcon ?? '';
      const emoji = REACTION_EMOJI[rIcon] ?? rIcon;

      // If empty reaction icon → user removed reaction; skip notification
      if (!rIcon) return;

      const gMsgIds: Array<{ gMsgID?: string | number }> = data?.content?.rMsg ?? [];
      const zaloMsgId = String(gMsgIds[0]?.gMsgID ?? '');
      if (!zaloMsgId) return;

      const tgMsgId = msgStore.getTgMsgId(zaloMsgId);
      if (tgMsgId === undefined) return;

      const zaloId = reaction?.threadId ?? data?.idTo;
      const type   = (reaction?.isGroup ? 1 : 0) as 0 | 1;
      const topicId = store.getTopicByZalo(String(zaloId), type);
      if (topicId === undefined) return;

      const dName = data?.dName ?? data?.uidFrom ?? 'ai đó';

      // Send reaction emoji as a reply to the forwarded TG message
      await tgBot.telegram.sendMessage(
        config.telegram.groupId,
        `${emoji} <b>${escapeHtml(dName)}</b>`,
        {
          message_thread_id: topicId,
          parse_mode: 'HTML',
          reply_parameters: { message_id: tgMsgId, allow_sending_without_reply: true },
        },
      );
    } catch (err) {
      console.error('[ZaloHandler] Reaction error:', err);
    }
  });

  // ── Group events (vào/rời nhóm) ────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.listener.on('group_event', async (event: any) => {
    try {
      const type  = event?.type as string | undefined;
      const data  = event?.data;
      const groupId = String(event?.threadId ?? data?.groupId ?? '');
      if (!groupId) return;

      // Only notify for join/leave/remove — skip setting changes, pins, etc.
      const NOTIFY_TYPES = new Set(['join', 'leave', 'remove_member', 'block_member']);
      if (!type || !NOTIFY_TYPES.has(type)) return;

      const topicId = store.getTopicByZalo(groupId, 1 /* Group */);
      if (topicId === undefined) return;

      const members: Array<{ dName?: string }> = data?.updateMembers ?? [];
      const names = members.map(m => m.dName ?? '?').join(', ');
      const actor  = data?.creatorId === data?.sourceId ? '' : '';  // unused for now
      void actor;

      let notifText = '';
      if (type === 'join') {
        notifText = `➕ <b>${escapeHtml(names)}</b> đã tham gia nhóm`;
      } else if (type === 'leave') {
        notifText = `➖ <b>${escapeHtml(names)}</b> đã rời nhóm`;
      } else if (type === 'remove_member') {
        notifText = `🚫 <b>${escapeHtml(names)}</b> đã bị xóa khỏi nhóm`;
      } else if (type === 'block_member') {
        notifText = `🔒 <b>${escapeHtml(names)}</b> đã bị chặn khỏi nhóm`;
      }

      if (!notifText) return;

      await tgBot.telegram.sendMessage(
        config.telegram.groupId,
        `<i>${notifText}</i>`,
        { message_thread_id: topicId, parse_mode: 'HTML' },
      );
      console.log(`[ZaloHandler] GroupEvent type=${type} group=${groupId}`);
    } catch (err) {
      console.error('[ZaloHandler] GroupEvent error:', err);
    }
  });
}
