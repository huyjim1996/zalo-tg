import type { ThreadType } from 'zca-js';

// ── Incoming Zalo message ─────────────────────────────────────────────────────

/**
 * Parsed content object for media messages.
 * Zalo sends all media types as TAttachmentContent:
 *   href  = main URL (image / file / video / voice / gif)
 *   thumb = thumbnail URL
 *   title = display name (filename for files, link title for links)
 *   params = JSON string with extra metadata (hd, fileSize, fileExt, duration …)
 */
export interface ZaloMediaContent {
  // common TAttachmentContent fields (used by ALL media types)
  href?:        string;
  thumb?:       string;
  title?:       string;
  description?: string;
  params?:      string;   // JSON string
  action?:      string;
  childnumber?: number;
  type?:        string | number;
  // sticker has a different shape
  id?:          number;
  catId?:       number;
  cateId?:      number;
}

/** Zalo message types (value of data.msgType). */
export const ZALO_MSG_TYPES = {
  TEXT:       'webchat',
  PHOTO:      'chat.photo',
  VOICE:      'chat.voice',
  STICKER:    'chat.sticker',
  DOODLE:     'chat.doodle',
  LINK:       'chat.recommended',
  VIDEO:      'chat.video.msg',
  FILE:       'share.file',
  GIF:        'chat.gif',
  LOCATION:   'chat.location.new',
  WEBCONTENT: 'chat.webcontent',
} as const;

/** A single @mention inside a Zalo group message. */
export interface ZaloTMention {
  uid:  string;  // Zalo UID of the mentioned user
  pos:  number;  // character offset in the message string
  len:  number;  // character length of the @Name span
  type: 0 | 1;  // 0 = individual, 1 = mention-all
}

/** Quote (reply-to) metadata carried on an incoming Zalo message. */
export interface ZaloTQuote {
  ownerId:     string;
  cliMsgId:    number;
  globalMsgId: number;  // server-assigned ID of the quoted message
  cliMsgType:  number;
  ts:          number;
  msg:         string;
  attach:      string;
  fromD:       string;
  ttl:         number;
}

export interface ZaloMessageData {
  content:    string | ZaloMediaContent | Record<string, unknown>;
  msgId:      string;
  cliMsgId?:  string;
  realMsgId?: string;   // server-side canonical ID (matches globalMsgId in TQuote)
  uidFrom:    string;
  dName?:     string;
  idTo:       string;
  ts:         string;
  msgType?:   string;
  ttl?:       number;
  quote?:     ZaloTQuote;
  mentions?:  ZaloTMention[];  // group messages only
}

export interface ZaloMessage {
  type:     ThreadType;
  data:     ZaloMessageData;
  isSelf:   boolean;
  threadId: string;
}

// ── Group info ────────────────────────────────────────────────────────────────

export interface ZaloGridInfo {
  name:         string;
  avt?:         string;
  totalMember?: number;
}

export interface ZaloGroupInfoResponse {
  gridInfoMap: Record<string, ZaloGridInfo>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ZaloAPI = any;
