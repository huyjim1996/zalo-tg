*Vietnamese version: [README.vi.md](README.vi.md)*


# zalo-tg

## Setup Video

<video src="REC-20260510162634.mp4" controls width="100%"></video>

A bidirectional message bridge between **Zalo** and **Telegram**, implemented in TypeScript on Node.js. Each Zalo conversation (direct message or group) is mapped to a dedicated Forum Topic inside a Telegram supergroup, providing full message synchronisation across both platforms.

---

## Table of Contents

- [Architecture](#architecture)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running](#running)
- [Bot Commands](#bot-commands)
- [Project Structure](#project-structure)
- [Security Considerations](#security-considerations)
- [License](#license)

---

## Architecture

The bridge operates as a single long-running Node.js process that simultaneously maintains:

1. **A Telegram bot** (via [Telegraf](https://github.com/telegraf/telegraf)) connected to the Bot API using long polling.
2. **A Zalo client** (via [zca-js](https://github.com/VolunteerSVD/zca-js)) connected to Zalo's internal WebSocket API.

Both sides communicate through a set of in-memory and on-disk stores that maintain bidirectional mappings between Telegram message IDs and Zalo message IDs. This enables features such as reply chaining, message recall, and reaction forwarding.

```
 Zalo WebSocket API
        |
   zalo/client.ts         (authentication, session management)
        |
   zalo/handler.ts        (decode incoming Zalo events → Telegram)
        |
   store.ts               (msgStore, sentMsgStore, pollStore,
        |                  mediaGroupStore, zaloAlbumStore,
        |                  userCache, friendsCache, topicStore)
        |
   telegram/handler.ts    (decode incoming Telegram updates → Zalo)
        |
   Telegram Bot API (long polling)
```

**Topic mapping** (`data/topics.json`) is persisted to disk. All message-ID mappings are kept in memory with LRU-style eviction and are lost on process restart (graceful degradation: reply chains to old messages simply omit the `reply_parameters` field).

---

## Features

### Message Types — Zalo to Telegram

| Zalo type (`msgType`) | Telegram output |
|---|---|
| `webchat` (plain text) | `sendMessage` with HTML parse mode; mentions wrapped in `<b>` |
| `chat.photo` | `sendPhoto` (single) or `sendMediaGroup` (album, buffered 600 ms) |
| `chat.video.msg` | `sendVideo` |
| `chat.gif` | `sendAnimation` |
| `share.file` | `sendDocument` with original filename |
| `chat.voice` | `sendVoice` |
| `chat.sticker` | `sendSticker` (WebP); falls back to `sendPhoto` if oversized |
| `chat.doodle` | `sendPhoto` |
| `chat.recommended` (link) | `sendMessage` with inline link preview |
| `chat.location.new` | `sendLocation` (native map widget) |
| `chat.webcontent` — bank card | `sendPhoto` with VietQR image + account details |
| `chat.webcontent` — generic | `sendMessage` with icon and label |
| contact card (contactUid) | `sendPhoto` with QR code + name/ID, or `sendMessage` fallback |
| `group.poll` — create | `sendPoll` + editable score message with lock button |
| `group.poll` — vote update | Edit score message with updated vote counts and bar chart |

### Message Types — Telegram to Zalo

| Telegram content | Zalo API call |
|---|---|
| Text | `sendMessage` |
| Photo (single) | `sendMessage` with attachment |
| Photo album (media group) | `sendMessage` with multiple attachments (buffered 500 ms) |
| Video (single) | `sendMessage` with attachment |
| Video album (media group) | `sendMessage` with multiple attachments (buffered 500 ms) |
| Animation / GIF | `sendMessage` with attachment |
| Document | `sendMessage` with attachment |
| Voice note (OGG Opus) | Convert to M4A via ffmpeg → `uploadAttachment` → `sendVoice` |
| Sticker (static WebP) | `sendMessage` with attachment |
| Sticker (animated / video) | Downloads JPEG thumbnail → `sendMessage` with attachment |
| Location | `sendLink` with Google Maps URL; fallback to `sendMessage` |
| Contact | `sendMessage` with name and phone number |
| Poll | `createPoll` on Zalo + bot-owned non-anonymous clone poll on Telegram |

### Interaction Sync

**Reply chain** — When a Telegram message has `reply_to_message`, the bridge resolves the target to a Zalo `quote` object and passes it to `sendMessage`. Replies to messages originally sent from Telegram to Zalo are resolved via a reverse index in `sentMsgStore`.

**Reactions** — Telegram `message_reaction` updates are mapped through a static emoji table and forwarded via `addReaction`. Zalo reactions are forwarded as a short text reply on Telegram.

**Message recall (undo)** — Zalo `undo` events trigger `deleteMessage` on the mirrored Telegram message. The `/recall` command triggers `api.undo` for messages the bot itself sent.

**Mentions** — Zalo `@mention` spans are wrapped in `<b>` tags on Telegram. Telegram `@username` entities and plain-text `@Name` patterns are resolved to Zalo UIDs via `userCache` and forwarded as `mentions` in `sendMessage`. Captions on photos, videos, and documents are also mention-resolved.

### Poll Synchronisation

- Zalo poll creation → Telegram native poll + editable score message with inline lock button.
- Telegram poll creation → Zalo `createPoll` + bot-owned non-anonymous clone poll (required for `poll_answer` updates) + editable score message.
- `poll_answer` events (Telegram side) → `votePoll` on Zalo + immediate score refresh via `getPollDetail`.
- Zalo votes trigger `group_event` with `boardType=3` → `getPollDetail` → score message edit.
- Lock button / `stopPoll` → `lockPoll` on Zalo, `stopPoll` on both TG polls, score message updated to show closed state.

### Group Management

- New Zalo group conversation → Forum Topic created automatically on first message received, with the group avatar fetched and pinned as the first message.
- Group events (join, leave, remove, block) forwarded as italic system messages inside the topic.

---

## Requirements

| Dependency | Version | Notes |
|---|---|---|
| Node.js | >= 18 | ESM support required |
| npm | >= 9 | |
| ffmpeg | any | Must be in `PATH`; used for OGG→M4A voice conversion |
| Telegram Bot | — | Created via [@BotFather](https://t.me/BotFather) |
| Telegram Supergroup | — | Forum (Topics) mode enabled; bot must be admin |
| Zalo account | — | Active account; session stored in `credentials.json` |

**Required bot admin permissions in the Telegram supergroup:**
- Manage topics (create, edit)
- Delete messages
- Pin messages
- Manage the group (for reactions via `message_reaction` updates)

---

## Installation

```bash
git clone https://github.com/williamcachamwri/zalo-tg
cd zalo-tg
npm install
cp .env.example .env
```

---

## Configuration

Edit `.env`:

```env
# Telegram Bot token from @BotFather
TG_TOKEN=123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Telegram supergroup ID (negative integer, e.g. -1001234567890)
TG_GROUP_ID=-1001234567890

# Directory for persistent data (topics.json, credentials.json)
# Defaults to ./data if omitted
DATA_DIR=./data

# Skip forwarding messages from muted Zalo groups
# Defaults to false; set to true/1/yes/on to enable
ZALO_SKIP_MUTED_GROUPS=false
```

---

## Running

```bash
# Development — hot reload via tsx watch
npm run dev

# Production
npm run build
npm start
```

On first run with no existing `credentials.json`, send `/login` inside any topic (or the General topic) of the bridged Telegram group. The bot will send a Zalo QR code image; scan it with the Zalo mobile app under **Settings → QR Code Login**.

---

## Bot Commands

| Command | Description |
|---|---|
| `/login` | Initiate Zalo QR code authentication |
| `/search <query>` | Search Zalo friends list; select a result to create a DM topic |
| `/recall` | Retract a message sent from Telegram to Zalo (reply to the target message) |
| `/topic list` | List all active topic–conversation mappings |
| `/topic info` | Show the Zalo conversation details for the current topic |
| `/topic delete` | Remove the mapping for the current topic |

---

## Project Structure

```
src/
├── index.ts                  Entry point. Initialises Telegraf, Zalo client,
│                             attaches both handlers, starts polling.
├── config.ts                 Reads and validates environment variables.
├── store.ts                  All in-memory and on-disk state:
│                               - topicStore      (persisted, topics.json)
│                               - msgStore        (Zalo msgId ↔ TG message_id)
│                               - sentMsgStore    (TG→Zalo msgId reverse index)
│                               - pollStore       (poll ↔ TG poll message mapping)
│                               - mediaGroupStore (TG media group buffer)
│                               - zaloAlbumStore  (Zalo album buffer)
│                               - userCache       (uid ↔ displayName)
│                               - friendsCache    (friends list, 5-min TTL)
├── telegram/
│   ├── bot.ts                Telegraf instance; sets allowedUpdates.
│   └── handler.ts            Processes all Telegram updates and forwards to Zalo.
│                             Handles: text, media, voice, sticker, poll, location,
│                             contact, reaction, callback_query, poll_answer.
├── zalo/
│   ├── client.ts             Zalo API initialisation and QR login flow.
│   ├── types.ts              TypeScript interfaces and ZALO_MSG_TYPES constant.
│   └── handler.ts            Processes all Zalo listener events and forwards to TG.
│                             Handles: message (all msgTypes), undo, reaction,
│                             group_event (join/leave/poll/update_board).
└── utils/
    ├── format.ts             HTML escaping, mention application, caption helpers.
    └── media.ts              Temporary file download, cleanup, OGG→M4A conversion.
```

---

## Security Considerations

- `.env` and `credentials.json` are listed in `.gitignore` and must never be committed to version control.
- `credentials.json` contains a Zalo session token equivalent to the account password. Treat it with the same level of protection.
- The bridge runs as a single-user system: the Telegram group should be private and restricted to trusted members only, as any member can send messages through the bridge.
- All outbound HTTP requests to Telegram and Zalo use TLS. No credentials are logged.
- The `/recall` command is unrestricted within the group — any group member can retract messages the bot sent. Restrict bot admin rights or group membership if this is a concern.

---

## License

MIT

---
