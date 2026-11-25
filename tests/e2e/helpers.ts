import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { sampleDeck } from '../../shared/deck.js';
import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

export const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };

const opened: BrowserContext[] = [];

const BLANK_GIF = Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64');

/** Each test gets its own TV and phones, so close them or they pile up and slow later tests. */
export async function closeEverything(): Promise<void> {
  await Promise.all(opened.splice(0).map((context) => context.close().catch(() => undefined)));
}

export async function newContext(browser: Browser, options: Parameters<Browser['newContext']>[0]): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  opened.push(context);
  // The TV's GIFs come from Giphy. A blank stand-in keeps tests off the internet.
  await context.route(/^https:\/\/([a-z0-9-]+\.)?giphy\.com\//, (route) =>
    route.fulfill({ contentType: 'image/gif', body: BLANK_GIF }),
  );
  // YouTube's player stays empty, so a word clip never reaches the internet.
  await context.route(/^https:\/\/www\.youtube(-nocookie)?\.com\/(iframe_api|embed\/)/, (route) =>
    route.fulfill({ contentType: route.request().url().includes('iframe_api') ? 'text/javascript' : 'text/html', body: '' }),
  );
  return context;
}

export const FIXTURES = 'tests/fixtures';
export const TV = { width: 1920, height: 1080 };

/** Signs in on a page of its own, TV-sized unless given another size. */
export async function signIn(
  browser: Browser,
  { viewport = TV, allowFailedRequests = false }: { viewport?: { width: number; height: number }; allowFailedRequests?: boolean } = {},
  prepare?: (context: BrowserContext) => Promise<void>,
): Promise<{ page: Page; context: BrowserContext }> {
  const context = await newContext(browser, { viewport, acceptDownloads: true });
  await prepare?.(context);
  const page = await context.newPage();
  failOnPageErrors(page, { allowFailedRequests });
  await page.goto('/admin');
  await page.getByLabel('Password').fill('e2e-test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Your decks' }).waitFor();
  return { page, context };
}

/** Uploads one of the test photos, as the deck builder would. */
export async function upload(context: BrowserContext, file = 'plain.jpg'): Promise<string> {
  const response = await context.request.post('/api/admin/images', {
    headers: { 'content-type': 'image/jpeg' },
    data: readFileSync(`${FIXTURES}/${file}`),
  });
  return ((await response.json()) as { id: string }).id;
}

/** Makes a deck through the app's own API. */
export async function makeDeck(context: BrowserContext, content: Record<string, unknown>): Promise<string> {
  const response = await context.request.post('/api/admin/decks', {
    data: {
      title: 'Test deck',
      theme: { accent: null },
      region: { country: 'Japan' },
      moderation: { blocklist: [], similarity: 'normal', showLeftPage: true },
      games: [],
      ...content,
    },
  });
  return ((await response.json()) as { deck: { id: string } }).deck.id;
}

/**
 * Signs in on a TV-sized page and starts a game, from a deck of these games, or of the sample
 * deck's three words if none are given. Given a
 * function, it gets a freshly uploaded photo for the games to use, and the signed-in browser to
 * upload more. `prepare` sets up the TV's browser before anything loads.
 */
export async function startGame(
  browser: Browser,
  games?: unknown[] | ((image: string, context: BrowserContext) => unknown[] | Promise<unknown[]>),
  prepare?: (context: BrowserContext) => Promise<void>,
): Promise<{ tv: Page; room: string; context: BrowserContext; image: string }> {
  const { page: tv, context } = await signIn(browser, {}, prepare);
  const image = typeof games === 'function' ? await upload(context) : '';
  const deckGames = typeof games === 'function' ? await games(image, context) : (games ?? sampleDeck().games);
  const deckId = await makeDeck(context, { games: deckGames });
  const started = await context.request.post('/api/admin/rooms', { data: { deckId } });
  const { id: room } = (await started.json()) as { id: string };
  await tv.goto(`/host/${room}`);
  await tv.getByText('Scan to join').waitFor();
  return { tv, room, context, image };
}

/** A pause first, since the TV ignores a second press that comes too soon after the last. */
export async function press(tv: Page, key: string): Promise<void> {
  await tv.waitForTimeout(550);
  await tv.keyboard.press(key);
}

/** Past a game's title card to its first round. */
export async function toRound(tv: Page, title: string, heading: string): Promise<void> {
  await press(tv, 'Space');
  await tv.getByRole('heading', { name: title }).waitFor();
  await press(tv, 'Space');
  await tv.getByRole('heading', { name: heading }).waitFor();
}

/** Writes an answer or caption and waits until it's in. */
export async function write(phone: Page, text: string): Promise<void> {
  await phone.locator('.round-field').fill(text);
  await phone.getByRole('button', { name: 'Send' }).click();
  await phone.getByText('Locked in').waitFor();
}

/** A tap is the vote: it sends straight away. */
export async function chooseAndLock(phone: Page, text: string): Promise<void> {
  await phone.getByRole('radio', { name: text }).click();
  await phone.getByText('Locked in').waitFor();
}

export async function expectNoAccessibilityProblems(page: Page, exclude?: string): Promise<void> {
  const builder = new AxeBuilder({ page });
  if (exclude) builder.exclude(exclude);
  const results = await builder.analyze();
  expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.html}`)).toEqual([]);
}

/** A blank street style, so map tests don't depend on the map service being up. */
export async function blankStreets(context: BrowserContext): Promise<void> {
  await context.route('https://tiles.openfreemap.org/**', (route) =>
    route.fulfill({ json: { version: 8, sources: {}, layers: [] } }),
  );
}

export const KYOTO = { lat: 34.9671, lng: 135.7727 };

/** One photo to place on the map of Japan. */
export async function startMapGame(
  browser: Browser,
  settings: Record<string, number> = {},
  prepare?: (context: BrowserContext) => Promise<void>,
): Promise<{ tv: Page; room: string; context: BrowserContext }> {
  return startGame(
    browser,
    (image) => [{ type: 'geo', settings, items: [{ image, label: 'Fushimi Inari', ...KYOTO }] }],
    async (context) => {
      await blankStreets(context);
      await prepare?.(context);
    },
  );
}

/** A phone that has joined a map game, with the blank street style. */
export async function mapPhone(browser: Browser, room: string, name: string, size = PHONE.viewport): Promise<Page> {
  const context = await newContext(browser, { ...PHONE, viewport: size });
  await blankStreets(context);
  const page = await context.newPage();
  failOnPageErrors(page);
  await page.goto(`/j/${room}`);
  await joinAs(page, name);
  return page;
}

export async function toGuessing(tv: Page): Promise<void> {
  await press(tv, 'Space');
  await tv.getByRole('heading', { name: 'Where was this?' }).waitFor();
  await press(tv, 'Space');
  await tv.getByText('Drop a pin on your phone.').waitFor();
}

/** The map is ready to take a tap once it has drawn. */
export async function mapReady(page: Page): Promise<Locator> {
  const canvas = page.locator('.map-stage .maplibregl-canvas');
  await canvas.waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => (document.querySelector<HTMLCanvasElement>('.maplibregl-canvas')?.width ?? 0) > 0);
  // Lets the opening view settle, so a tap lands where the test means it to.
  await page.waitForTimeout(300);
  return canvas;
}

/** Roughly mainland Japan, on the opening view of every phone size here. */
export async function tapJapan(page: Page): Promise<void> {
  const canvas = await mapReady(page);
  const box = (await canvas.boundingBox())!;
  const foot = (await page.locator('.map-foot').boundingBox())!;
  await canvas.tap({ position: { x: box.width * 0.56, y: (foot.y - box.y) * 0.52 } });
  await expect(page.locator('.pin-mark')).toBeVisible();
}

export async function openPhone(browser: Browser, room: string, size = PHONE): Promise<Page> {
  const context = await newContext(browser, size);
  const page = await context.newPage();
  failOnPageErrors(page);
  await page.goto(`/j/${room}`);
  return page;
}

export async function joinAs(page: Page, name: string): Promise<void> {
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Join game' }).click();
  await page.getByText("You're in").waitFor();
}

/** Any script error or content security violation fails the test that caused it. */
export function failOnPageErrors(page: Page, options: { allowFailedRequests?: boolean } = {}): void {
  page.on('pageerror', (error) => {
    throw new Error(`Page error: ${error.message}`);
  });
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      // The browser logs every refused request, even ones a test sets out to cause.
      !(options.allowFailedRequests && /^Failed to load resource/.test(message.text())) &&
      !/WebSocket|ERR_INTERNET_DISCONNECTED|polling|socket\.io/i.test(message.text() + message.location().url)
    ) {
      throw new Error(`Console error: ${message.text()}`);
    }
  });
}
