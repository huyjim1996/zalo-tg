# Zalo ↔ Telegram Bridge

Cầu nối hai chiều giữa **Zalo** và **Telegram** sử dụng Forum Topics. Mỗi cuộc trò chuyện Zalo (cá nhân hoặc nhóm) tương ứng với một topic riêng trong group Telegram.

## Tính năng

- 💬 **Nhắn tin 2 chiều** — văn bản, hình ảnh, video, file, GIF, sticker
- 🎤 **Ghi âm** — voice note TG → Zalo (auto-convert OGG→M4A)
- 📎 **File lớn** — cảnh báo khi vượt giới hạn 20MB của Telegram Bot API
- 👥 **Nhắn nhóm Zalo** — forward vào topic tương ứng, hiển thị tên người gửi
- 🏷️ **Mention** — `@Tên` trên TG tự động chuyển thành mention Zalo và ngược lại
- 😄 **React** — thả react emoji trên TG → react tương ứng trên Zalo
- 🗑️ **Thu hồi tin nhắn** — Zalo thu hồi → xoá trên TG; `/recall` để thu hồi từ TG
- 🏦 **Thẻ ngân hàng** — hiển thị QR + thông tin tài khoản ngân hàng
- 🔍 **Tìm bạn bè** — `/search Tên` → chọn → tự tạo topic DM
- 📢 **Thông báo nhóm** — vào/rời nhóm, bị xoá, bị chặn

## Yêu cầu

- Node.js ≥ 18
- ffmpeg (để convert voice note)
- Tài khoản Zalo đang hoạt động
- Telegram Bot Token ([@BotFather](https://t.me/BotFather))
- Telegram Group với **Topics** được bật, bot là **admin**

## Cài đặt

```bash
git clone https://github.com/<you>/zalo-tg
cd zalo-tg
npm install
cp .env.example .env
```

Chỉnh sửa `.env`:

```env
TG_TOKEN=<token từ BotFather>
TG_GROUP_ID=<ID group Telegram, số âm>
```

## Chạy

```bash
npm run dev        # dev mode (hot-reload)
npm run build && npm start   # production
```

Lần đầu chưa có credentials Zalo → gõ `/login` trong Telegram để đăng nhập.

## Lệnh Telegram

| Lệnh | Mô tả |
|------|-------|
| `/login` | Đăng nhập tài khoản Zalo |
| `/search Tên` | Tìm bạn bè Zalo, tạo topic DM |
| `/recall` | Thu hồi tin nhắn vừa gửi (reply vào tin cần thu hồi) |
| `/topic list` | Xem danh sách topic đang active |
| `/topic info` | Xem thông tin topic hiện tại |
| `/topic delete` | Xoá liên kết topic ↔ Zalo |

## Cấu trúc

```
src/
├── index.ts          # Entry point
├── config.ts         # Đọc env
├── store.ts          # Lưu trữ mapping topic ↔ Zalo
├── telegram/
│   ├── bot.ts        # Khởi tạo Telegraf
│   └── handler.ts    # Xử lý tin nhắn TG → Zalo
├── zalo/
│   ├── types.ts      # TypeScript types
│   └── handler.ts    # Xử lý tin nhắn Zalo → TG
└── utils/
    ├── format.ts     # Format HTML, mention, escape
    └── media.ts      # Download/upload file tạm
```

## Lưu ý bảo mật

- **Không commit** file `.env` và `credentials.json` — đã được ignore
- Bot Telegram cần quyền **admin** trong group để tạo/xoá topic và nhận reaction
- Zalo session lưu trong `credentials.json` — bảo mật như password

## License

MIT
