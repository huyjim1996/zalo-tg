import { Telegraf } from 'telegraf';
import https from 'https';
import { config } from '../config.js';

// Force IPv4 to avoid ETIMEDOUT on systems where IPv6 is blocked/unreachable
const agent = new https.Agent({ family: 4 });

/** Singleton Telegraf bot instance shared across the app. */
export const tgBot = new Telegraf(config.telegram.token, {
  telegram: { agent },
});
