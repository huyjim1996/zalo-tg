/** Truncate a string to `max` characters, appending ellipsis if cut. */
export function truncate(text: string, max = 4096): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Escape characters special to Telegram HTML parse mode. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Apply Zalo mention metadata to a plain-text message body, returning an
 * HTML-escaped string with each mention span wrapped in `<b>` tags.
 *
 * @param text     Raw (unescaped) message content.
 * @param mentions Array of {pos, len, type} from TGroupMessage.mentions.
 */
export function applyMentionsHtml(
  text: string,
  mentions: ReadonlyArray<{ pos: number; len: number; type: number }>,
): string {
  if (!mentions.length) return escapeHtml(text);

  const sorted = [...mentions].sort((a, b) => a.pos - b.pos);
  let result = '';
  let cursor = 0;

  for (const m of sorted) {
    // Guard against out-of-range or overlapping mentions
    if (m.pos < cursor || m.pos >= text.length) continue;
    if (m.pos > cursor) result += escapeHtml(text.slice(cursor, m.pos));
    const span = text.slice(m.pos, m.pos + m.len);
    result += `<b>${escapeHtml(span)}</b>`;
    cursor = m.pos + m.len;
  }

  if (cursor < text.length) result += escapeHtml(text.slice(cursor));
  return result;
}

/**
 * Format a group message as:
 *   <b>SenderName:</b>
 *   content…
 */
export function formatGroupMsg(senderName: string, content: string): string {
  return `<b>${escapeHtml(truncate(senderName, 64))}:</b>\n${escapeHtml(truncate(content))}`;
}

/**
 * Format a group message with pre-escaped HTML body (e.g. when mention spans
 * have already been wrapped in <b> tags).
 */
export function formatGroupMsgHtml(senderName: string, bodyHtml: string): string {
  return `<b>${escapeHtml(truncate(senderName, 64))}:</b>\n${bodyHtml}`;
}

/** Caption for group media (just bold sender name). */
export function groupCaption(senderName: string): string {
  return `<b>${escapeHtml(truncate(senderName, 64))}</b>`;
}

/**
 * Format a Telegram Topic name:
 *   👤 Name  (DM)
 *   👥 Name  (Group)
 * Telegram's max topic name length is 128 chars.
 */
export function topicName(name: string, type: 0 | 1): string {
  return `${type === 1 ? '👥' : '👤'} ${name}`.slice(0, 128);
}
