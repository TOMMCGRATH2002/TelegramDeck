/**
 * GramJS keeps a background ping loop (node_modules/telegram/client/updates.js).
 * Its default 10s ping deadline often trips on slow or busy networks, causing
 * Error: TIMEOUT and reconnect churn. Relax timeouts after every npm install.
 *
 * Safe to run multiple times (no-op if already patched or if gram-js changes).
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'node_modules', 'telegram', 'client', 'updates.js');

if (!fs.existsSync(file)) {
  console.warn('[relax-gramjs-ping] skipping — telegram not installed yet');
  process.exit(0);
}

let s = fs.readFileSync(file, 'utf8');
if (s.includes('PING_TIMEOUT = 45000')) {
  process.exit(0);
}

const before = s;

s = s.replace(
  /const PING_TIMEOUT = 10000; \/\/ 10 sec\r?\nconst PING_FAIL_ATTEMPTS = 3;/,
  'const PING_TIMEOUT = 45000; // 45 sec (TelegramDeck: relaxed vs upstream 10s)\r\nconst PING_FAIL_ATTEMPTS = 5;'
);

s = s.replace(
  /const PING_WAKE_UP_TIMEOUT = 3000; \/\/ 3 sec/,
  'const PING_WAKE_UP_TIMEOUT = 15000; // 15 sec (TelegramDeck: relaxed vs upstream 3s)'
);

if (s !== before) {
  fs.writeFileSync(file, s);
  console.log('[relax-gramjs-ping] updated', path.relative(process.cwd(), file));
} else {
  console.warn(
    '[relax-gramjs-ping] no changes — check telegram/client/updates.js for new gram-js version'
  );
}
