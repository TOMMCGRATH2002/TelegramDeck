/**
 * TelegramDeck — Authentication Script
 * Run once: npm run auth
 * This generates a session string you paste into .env
 */

require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');

const API_ID = parseInt(process.env.TELEGRAM_API_ID);
const API_HASH = process.env.TELEGRAM_API_HASH;

if (!API_ID || !API_HASH || API_HASH === 'your_api_hash_here') {
  console.error('\n❌  Please set TELEGRAM_API_ID and TELEGRAM_API_HASH in your .env file first.');
  console.error('    Get them from: https://my.telegram.org/apps\n');
  process.exit(1);
}

(async () => {
  console.log('\n🔐  TelegramDeck — First-time Authentication\n');
  console.log('   This will log in to your Telegram account and generate');
  console.log('   a session string. You only need to do this once.\n');

  const session = new StringSession('');
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 3,
  });

  await client.start({
    phoneNumber: async () => await input.text('📱  Your phone number (with country code, e.g. +353...): '),
    password: async () => await input.text('🔑  2FA password (leave blank if none): '),
    phoneCode: async () => await input.text('📨  Code from Telegram: '),
    onError: (err) => {
      console.error('\n❌  Auth error:', err.message);
      process.exit(1);
    },
  });

  const sessionString = client.session.save();

  console.log('\n✅  Authentication successful!\n');
  console.log('   Copy the line below into your .env file:\n');
  console.log(`TELEGRAM_SESSION=${sessionString}`);
  console.log('\n   Then run: npm start\n');

  await client.disconnect();
  process.exit(0);
})();
