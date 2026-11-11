/**
 * Plays a whole game of the sample deck with a TV and four phones in headless Chromium, and saves
 * the screenshots and screen recordings used in the README.
 *
 *   npm run build && npm run capture
 *
 * Screenshots land in docs/media. Recordings land in docs/media/raw as .webm, and
 * scripts/capture/gifs.sh turns them into GIFs with ffmpeg. Nothing here is needed to run the app.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';

const PORT = 3200 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = randomBytes(12).toString('hex');
const OUT = 'docs/media';
const RAW = join(OUT, 'raw');

/** The screenshots the README shows. */
const IN_README = new Set([
  'builder',
  'tv-define-reveal',
  'phone-define-write',
  'phone-geo-pin',
  'tv-caption-vote',
  'phone-caption-write',
  'tv-choice-reveal',
  'phone-choice',
]);

const TV_SIZE = { width: 1920, height: 1080 };
const PHONE_SIZE = { width: 390, height: 844 };
const PHONE = { viewport: PHONE_SIZE, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };

/** Guests, and what each of them writes and picks, so the reveals are worth looking at. */
const GUESTS = ['Mika', 'Jordan', 'Sam', 'Priya'] as const;
const FAKE_DEFINITIONS = [
  'The feeling of finding a forgotten snack in your coat pocket',
  'A cat that refuses to leave a sunny windowsill',
  'Napping on a train and waking at exactly your stop',
  'The polite bow you give a vending machine',
];
const CAPTIONS = [
  ['Waiting for my cracker like', 'Deer: 1, tourists: 0', 'He knows what he did', 'Bow first, then we talk'],
  ['Choosing dinner, round 4', 'The 2 a.m. dilemma', 'Hot or cold? Yes', 'My entire food budget'],
];

const recordings: { context: BrowserContext; name: string }[] = [];

/**
 * When each recording started and when things happened, in milliseconds, so gifs.sh can cut
 * the right moments out of the recordings.
 */
const marks: Record<string, number> = {};
function mark(name: string): void {
  marks[name] = Date.now();
}

function startServer(): ChildProcess {
  const server = spawn('node', ['dist/server/index.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: mkdtempSync(join(tmpdir(), 'trip-party-capture-')),
      ADMIN_PASSWORD: PASSWORD,
      SESSION_SECRET: randomBytes(24).toString('hex'),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return server;
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('The server never came up. Run npm run build first.');
}

async function context(browser: Browser, options: Parameters<Browser['newContext']>[0], record?: string) {
  const created = await browser.newContext({
    ...options,
    baseURL: BASE,
    ...(record ? { recordVideo: { dir: RAW, size: options?.viewport ?? undefined } } : {}),
  });
  if (record) recordings.push({ context: created, name: record });
  return created;
}

async function shot(page: Page, name: string): Promise<void> {
  // Lets animations land before the picture.
  await page.waitForTimeout(900);
  // Phones stay sharp as PNGs. The TV's painted scenery is far smaller as a JPEG.
  const file = (page.viewportSize()?.width ?? 0) > 1000 ? `${name}.jpg` : `${name}.png`;
  // Only the README's pictures go in docs/media. The rest are kept beside the recordings.
  const folder = IN_README.has(name) ? OUT : RAW;
  await page.screenshot({ path: join(folder, file), ...(file.endsWith('.jpg') ? { quality: 82 } : {}) });
  console.log(`  ${file}`);
}

async function pause(page: Page, ms: number): Promise<void> {
  await page.waitForTimeout(ms);
}

/** The TV ignores a key pressed straight after the screen changes, so a double press can't skip. */
async function key(tv: Page, which: string): Promise<void> {
  await tv.waitForTimeout(650);
  await tv.keyboard.press(which);
}

/** Presses Space until a screen with this heading is up, past any reveal still finishing. */
async function advanceTo(tv: Page, heading: string): Promise<void> {
  const target = tv.getByRole('heading', { name: heading });
  for (let tries = 0; tries < 12; tries++) {
    await key(tv, 'Space');
    if (await target.waitFor({ timeout: 2500 }).then(() => true, () => false)) return;
  }
  throw new Error(`Never reached ${heading}`);
}

async function mapReady(page: Page) {
  const canvas = page.locator('.map-stage .maplibregl-canvas');
  await canvas.waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => {
    const map = document.querySelector<HTMLCanvasElement>('.maplibregl-canvas');
    return !!map && map.width > 0;
  });
  await page.waitForTimeout(1500);
  return canvas;
}

/** Taps somewhere on the opening view of the map, a different spot for each guest. */
async function dropPin(page: Page, at: { x: number; y: number }): Promise<void> {
  const canvas = await mapReady(page);
  const box = (await canvas.boundingBox())!;
  const foot = (await page.locator('.map-foot').boundingBox())!;
  await canvas.tap({ position: { x: box.width * at.x, y: (foot.y - box.y) * at.y } });
  await page.locator('.pin-mark').waitFor();
}

async function main(): Promise<void> {
  mkdirSync(RAW, { recursive: true });
  for (const file of readdirSync(RAW)) rmSync(join(RAW, file));
  const server = startServer();
  const browser = await chromium.launch();
  try {
    await waitForServer();

    // The presenter signs in, adds the sample deck, and gives it tips.
    const admin = await context(browser, { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const builder = await admin.newPage();
    await builder.goto('/admin');
    await builder.getByLabel('Password').fill(PASSWORD);
    await builder.getByRole('button', { name: 'Sign in' }).click();
    await builder.getByRole('heading', { name: 'Your decks' }).waitFor();
    const { deck } = (await (await admin.request.post('/api/admin/decks/sample')).json()) as {
      deck: { id: string; revision: number; content: any };
    };
    const photo = (game: number, index: number): string => deck.content.games[game].items[index].image;
    const content = {
      ...deck.content,
      title: 'Japan, spring trip',
      tips: [
        {
          heading: 'Best bite',
          text: 'Okonomiyaki cooked at the counter. Order one more than you think.',
          places: [{ name: 'Dōtonbori, Osaka', url: 'https://maps.google.com/?q=34.6687,135.5013', lat: 34.6687, lng: 135.5013 }],
          image: null,
        },
        {
          heading: 'Best view',
          text: 'Get to the torii at high tide, then stay for sunset.',
          places: [{ name: 'Itsukushima Shrine', url: 'https://maps.google.com/?q=34.296,132.3197', lat: 34.296, lng: 132.3197 }],
          image: photo(1, 1),
        },
        {
          heading: 'Would skip',
          text: 'The crossing is better from a café window than from the middle of it.',
          places: [{ name: 'Shibuya Crossing', url: 'https://maps.google.com/?q=35.6595,139.7005', lat: 35.6595, lng: 139.7005 }],
          image: null,
        },
        {
          heading: 'Bring',
          text: 'A pocket of coins for vending machines and a bag for crackers.',
          places: [{ name: 'Nara Park', url: 'https://maps.google.com/?q=34.685,135.843', lat: 34.685, lng: 135.843 }],
          image: null,
        },
      ],
    };
    const saved = await admin.request.put(`/api/admin/decks/${deck.id}`, { data: { revision: deck.revision, content } });
    if (!saved.ok()) throw new Error(`Saving the deck failed: ${saved.status()} ${await saved.text()}`);

    await builder.goto(`/admin/decks/${deck.id}`);
    await builder.getByText('komorebi').first().waitFor().catch(() => undefined);
    await shot(builder, 'builder');

    const started = await admin.request.post('/api/admin/rooms', { data: { deckId: deck.id } });
    const { id: room } = (await started.json()) as { id: string };

    // The TV, signed in with the same cookie, recording the whole night.
    const tvContext = await context(browser, { viewport: TV_SIZE, storageState: await admin.storageState() }, 'tv');
    const tv = await tvContext.newPage();
    mark('tv');
    await tv.goto(`/host/${room}`);
    await tv.getByText('Scan to join').waitFor();
    await pause(tv, 2500);

    const phones: Page[] = [];
    for (const [index, name] of GUESTS.entries()) {
      const phoneContext = await context(browser, PHONE, index === 0 ? 'phone' : undefined);
      const phone = await phoneContext.newPage();
      if (index === 0) mark('phone');
      await phone.goto(`/j/${room}`);
      if (index === 0) await shot(phone, 'phone-join');
      await phone.getByLabel('Your name').pressSequentially(name, { delay: index === 0 ? 90 : 0 });
      await phone.getByRole('button', { name: 'Join game' }).click();
      await phone.getByText("You're in").waitFor();
      phones.push(phone);
      await pause(tv, 700);
    }
    await shot(tv, 'tv-lobby');
    await shot(phones[0]!, 'phone-lobby');

    // Define it: everyone writes a fake meaning for a real word, then votes for the real one.
    await key(tv, 'Space');
    await tv.getByRole('heading', { name: 'Define it' }).waitFor();
    await shot(tv, 'tv-title-define');
    await key(tv, 'Space');
    await tv.getByRole('heading', { name: 'komorebi' }).waitFor();
    mark('define');
    await pause(tv, 1500);
    for (const [index, phone] of phones.entries()) {
      const box = phone.getByLabel('Your fake definition');
      if (index === 0) {
        await box.pressSequentially(FAKE_DEFINITIONS[index]!, { delay: 45 });
        await shot(phone, 'phone-define-write');
      } else {
        await box.fill(FAKE_DEFINITIONS[index]!);
      }
      await phone.getByRole('button', { name: 'Send' }).click();
      await phone.getByText('Locked in').waitFor();
      if (index === 1) await shot(tv, 'tv-define-write');
    }
    // Answers show one at a time, then the vote.
    await tv.locator('.tv-show-text').first().waitFor({ timeout: 20_000 }).catch(() => undefined);
    await pause(tv, 1200);
    await shot(tv, 'tv-define-show');
    await tv.getByText('Which one is real?').waitFor({ timeout: 60_000 });
    await shot(tv, 'tv-define-vote');
    await shot(phones[0]!, 'phone-define-vote');
    const votes = ['Sunlight filtering through the leaves of trees', FAKE_DEFINITIONS[0]!, FAKE_DEFINITIONS[0]!, 'Sunlight filtering through the leaves of trees'];
    for (const [index, phone] of phones.entries()) {
      const pick = votes[index] === FAKE_DEFINITIONS[index] ? FAKE_DEFINITIONS[(index + 1) % 4]! : votes[index]!;
      await phone.getByRole('radio', { name: pick }).click();
      await pause(phone, 400);
    }
    await tv.getByText(/Real answer/).waitFor({ timeout: 30_000 });
    await pause(tv, 2500);
    await shot(tv, 'tv-define-reveal');
    await shot(phones[0]!, 'phone-define-result');
    mark('define-end');

    // The other two words go by quickly.
    for (const word of ['tsundoku', 'kuidaore']) {
      await key(tv, 'Space');
      await tv.getByRole('heading', { name: word }).waitFor();
      await key(tv, 's');
      await tv.getByText(/Real answer/).waitFor({ timeout: 30_000 });
    }
    await advanceTo(tv, 'Standings');
    await pause(tv, 2500);
    await shot(tv, 'tv-standings');
    await shot(phones[0]!, 'phone-standings');

    // Where was this?: pins on a map, scored by distance.
    await key(tv, 'Space');
    await tv.getByRole('heading', { name: 'Where was this?' }).waitFor();
    await shot(tv, 'tv-title-geo');
    // Near Tokyo, Osaka, Hiroshima and Sapporo on the opening view of Japan.
    const spots = [
      { x: 0.665, y: 0.505 },
      { x: 0.53, y: 0.515 },
      { x: 0.41, y: 0.53 },
      { x: 0.75, y: 0.28 },
    ];
    for (let round = 0; round < 3; round++) {
      await key(tv, 'Space');
      await tv.getByText('Drop a pin on your phone.').waitFor();
      if (round === 0) {
        await pause(tv, 1500);
        await shot(tv, 'tv-geo-guess');
      }
      for (const [index, phone] of phones.entries()) {
        await dropPin(phone, spots[(index + round) % 4]!);
        if (round === 0 && index === 0) await shot(phone, 'phone-geo-pin');
        await phone.getByRole('button', { name: 'Lock in pin' }).click();
      }
      if (round === 0) mark('geo-reveal');
      await tv.locator('.maplibregl-canvas').first().waitFor({ timeout: 30_000 });
      await pause(tv, 6000);
      if (round === 0) await shot(tv, 'tv-geo-reveal');
      // Skip past any gallery of extra photos too.
      await pause(tv, 500);
    }
    await advanceTo(tv, 'Standings');

    // Caption this.
    await key(tv, 'Space');
    await tv.getByRole('heading', { name: 'Caption this' }).waitFor();
    for (let round = 0; round < 2; round++) {
      await key(tv, 'Space');
      await phones[0]!.getByLabel('Your caption').waitFor();
      for (const [index, phone] of phones.entries()) {
        await phone.getByLabel('Your caption').fill(CAPTIONS[round]![index]!);
        if (round === 0 && index === 0) await shot(phone, 'phone-caption-write');
        await phone.getByRole('button', { name: 'Send' }).click();
      }
      await tv.locator('.tv-show-text').first().waitFor({ timeout: 20_000 }).catch(() => undefined);
      if (round === 0) await shot(tv, 'tv-caption-show');
      await key(tv, 's');
      await phones[0]!.getByRole('radio').first().waitFor({ timeout: 30_000 });
      if (round === 0) await shot(tv, 'tv-caption-vote');
      for (const [index, phone] of phones.entries()) {
        await phone.getByRole('radio', { name: CAPTIONS[round]![(index + 1) % 4]! }).click();
        }
      await key(tv, 's');
      await tv.getByText(/ · \d+ votes?$/).first().waitFor({ timeout: 30_000 });
      await pause(tv, 3000);
      if (round === 0) await shot(tv, 'tv-caption-reveal');
    }
    await advanceTo(tv, 'Standings');

    // Pick one.
    await key(tv, 'Space');
    await tv.getByRole('heading', { name: 'Pick one' }).waitFor();
    for (let round = 0; round < 2; round++) {
      await key(tv, 'Space');
      await phones[0]!.getByRole('radio').first().waitFor({ timeout: 20_000 });
      if (round === 0) {
        await pause(tv, 1200);
        await shot(tv, 'tv-choice-question');
      }
      for (const [index, phone] of phones.entries()) {
        await phone.getByRole('radio').nth(index % 3).click();
        if (round === 0 && index === 0) await shot(phone, 'phone-choice');
      }
      await key(tv, 's');
      await pause(tv, 6000);
      if (round === 0) await shot(tv, 'tv-choice-reveal');
    }
    await advanceTo(tv, 'Standings');

    // The podium, then the tips.
    await advanceTo(tv, 'Final standings');
    mark('podium');
    await pause(tv, 9000);
    await shot(tv, 'tv-podium');
    await shot(phones[0]!, 'phone-podium');
    await key(tv, 'Space');
    await tv.getByText('Best bite').waitFor();
    mark('tips');
    await pause(tv, 4000);
    await shot(tv, 'tv-tips');
    await shot(phones[0]!, 'phone-tips');
    await pause(tv, 1500);
    mark('end');
  } catch (error) {
    for (const [index, page] of browser.contexts().flatMap((each) => each.pages()).entries()) {
      await page.screenshot({ path: join(RAW, `failed-${index}.png`) }).catch(() => undefined);
    }
    throw error;
  } finally {
    // A recording is only written out once its context closes.
    const videos = recordings.map(({ context: recorded, name }) => ({ name, video: recorded.pages()[0]?.video() }));
    for (const { context: recorded } of recordings) await recorded.close();
    for (const { name, video } of videos) {
      if (video) renameSync(await video.path(), join(RAW, `${name}.webm`));
    }
    await browser.close();
    server.kill();
    writeFileSync(join(RAW, 'marks.json'), `${JSON.stringify(marks, null, 2)}\n`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
