/**
 * Writes a .env with a presenter password and a session secret, so `npm run dev` and
 * `npm start` can sign you in. Leaves an existing .env alone.
 *
 *   npm run setup
 */
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

if (existsSync('.env')) {
  console.log('.env already exists, so nothing changed. Your presenter password is ADMIN_PASSWORD in it.');
  process.exit(0);
}

// Easy to read out and type on a TV keyboard: four groups of letters and digits.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const password = Array.from({ length: 4 }, () =>
  Array.from(randomBytes(4), (byte) => ALPHABET[byte % ALPHABET.length]).join(''),
).join('-');

writeFileSync(
  '.env',
  `# Made by npm run setup. Keep this file out of git.
ADMIN_PASSWORD=${password}
SESSION_SECRET=${randomBytes(32).toString('base64url')}
`,
);

console.log(`Wrote .env.

  Presenter password: ${password}

Run npm run dev, open http://localhost:5173/admin and sign in with it.`);
