import 'dotenv/config';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

export const config = {
  telegram: {
    token:   requireEnv('TG_TOKEN'),
    groupId: Number(requireEnv('TG_GROUP_ID')),
  },
  zalo: {
    credentialsPath: process.env.ZALO_CREDENTIALS_PATH ?? './credentials.json',
  },
  dataDir: process.env.DATA_DIR ?? './data',
} as const;
