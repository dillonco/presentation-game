import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { closeEverything, failOnPageErrors, joinAs, openPhone } from './helpers.js';

test.afterEach(closeEverything);

const FIXTURES = 'tests/fixtures';
let counter = 0;

function uniqueTitle(): string {
  counter += 1;
  return `Deck ${process.pid} ${Date.now()} ${counter}`;
}

async function signIn(browser: Browser, viewport = { width: 1280, height: 900 }): Promise<Page> {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await context.newPage();
  failOnPageErrors(page, { allowFailedRequests: true });
  await page.goto('/admin');
  await page.getByLabel('Password').fill('e2e-test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Your decks' }).waitFor();
  return page;
}

/** Makes a deck through the app's own API, ready to open. */
async function makeDeck(page: Page, content: Record<string, unknown>): Promise<string> {
  return page.evaluate(async (fields) => {
    const response = await fetch('/api/admin/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Deck',
        theme: { accent: null },
        region: { country: 'Japan' },
        moderation: { blocklist: [], similarity: 'normal', showLeftPage: true },
        games: [],
        ...fields,
      }),
    });
    return ((await response.json()) as { deck: { id: string } }).deck.id;
  }, content);
}

async function openEditor(page: Page, games: unknown[], title = uniqueTitle()): Promise<string> {
  const id = await makeDeck(page, { title, games });
  await page.goto(`/admin/decks/${id}`);
  await page.getByText('Saved', { exact: true }).waitFor();
  return id;
}

const GEO = { type: 'geo', settings: {}, items: [] };
const CAPTION = { type: 'caption', settings: {}, items: [] };
const DEFINE = { type: 'define', settings: {}, items: [] };

function region(page: Page, name: RegExp) {
  return page.getByRole('region', { name });
}

async function savedDeck(page: Page, id: string) {
  return page.evaluate(async (deckId) => {
    const response = await fetch(`/api/admin/decks/${deckId}`);
    return ((await response.json()) as { deck: { content: any } }).deck.content;
  }, id);
}

test('a presenter writes a deck, starts it, and guests play its words', async ({ browser }) => {
  const page = await signIn(browser);
  const title = uniqueTitle();
  await page.getByRole('button', { name: 'New deck' }).click();
  await page.waitForURL(/\/admin\/decks\//);

  await page.getByLabel('Title').fill(title);
  const define = region(page, /Define it/);
  await define.getByRole('button', { name: 'Add a word' }).click();
  await define.getByLabel('Word 1', { exact: true }).fill('irasshaimase');
  await define.getByLabel('Real definition of word 1').fill('The greeting you hear on entering a shop');
  await expect(page.getByText('Ready to play.')).toBeVisible();

  await page.getByRole('button', { name: 'Start game' }).click();
  await page.waitForURL(/\/host\//);
  await expect(page.getByText(title)).toBeVisible();
  await expect(page.getByText('Scan to join')).toBeVisible();

  const room = page.url().split('/host/')[1]!;
  const phone = await openPhone(browser, room);
  await joinAs(phone, 'Alex');
  await page.keyboard.press('Space');
  await page.getByRole('heading', { name: 'Define it' }).waitFor();
  await page.waitForTimeout(550); // The TV ignores Space for a moment after a change, so a held key can't skip.
  await page.keyboard.press('Space');
  await expect(page.getByText('irasshaimase')).toBeVisible();
  await expect(phone.getByText('irasshaimase')).toBeVisible();
  // The real answer must stay on the builder.
  await expect(page.getByText('The greeting you hear')).toHaveCount(0);
  await expect(phone.getByText('The greeting you hear')).toHaveCount(0);
});

test('changes save by themselves and are there after a reload', async ({ browser }) => {
  const page = await signIn(browser);
  const id = await openEditor(page, [DEFINE]);
  const define = region(page, /Define it/);
  await define.getByRole('button', { name: 'Add a word' }).click();
  await define.getByLabel('Word 1', { exact: true }).fill('komorebi');
  await define.getByLabel('Real definition of word 1').fill('Sunlight through leaves');
  await page.getByText('Saved', { exact: true }).waitFor();
  await expect.poll(async () => (await savedDeck(page, id)).games[0].items[0]?.definition).toBe('Sunlight through leaves');

  await page.reload();
  await expect(region(page, /Define it/).getByLabel('Word 1', { exact: true })).toHaveValue('komorebi');
  await expect(region(page, /Define it/).getByLabel('Real definition of word 1')).toHaveValue('Sunlight through leaves');
});

test('Start explains what is missing and stays on the page', async ({ browser }) => {
  const page = await signIn(browser);
  await openEditor(page, [{ ...DEFINE, items: [{ word: 'komorebi', definition: '' }] }]);
  const url = page.url();
  await page.getByRole('button', { name: 'Start game' }).click();
  await expect(page.getByText('Define it, word 1: add the real definition.')).toBeVisible();
  expect(page.url()).toBe(url);
});

test('a dropped connection keeps retrying until the save lands', async ({ browser }) => {
  const page = await signIn(browser);
  const id = await openEditor(page, [DEFINE]);
  await page.context().route(/\/api\/admin\/decks\/[^/]+$/, (route) =>
    route.request().method() === 'PUT' ? route.abort() : route.continue(),
  );
  await page.getByLabel('Title').fill('Saved after the dropout');
  await expect(page.getByText('Not saved yet. Trying again…')).toBeVisible();
  await page.context().unrouteAll();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10_000 });
  expect((await savedDeck(page, id)).title).toBe('Saved after the dropout');
});

test('a second tab cannot silently overwrite the first', async ({ browser }) => {
  const first = await signIn(browser);
  const id = await openEditor(first, [DEFINE]);
  const second = await first.context().newPage();
  await second.goto(`/admin/decks/${id}`);
  await second.getByText('Saved', { exact: true }).waitFor();

  await first.getByLabel('Title').fill('From the first tab');
  await first.getByText('Saved', { exact: true }).waitFor();
  await expect.poll(async () => (await savedDeck(first, id)).title).toBe('From the first tab');

  await second.getByLabel('Title').fill('From the second tab');
  await expect(second.getByText(/changed in another tab/)).toBeVisible();
  expect((await savedDeck(first, id)).title).toBe('From the first tab');
});

test.describe('photos', () => {
  test('a photo is resized, loses its metadata, and fills in its location', async ({ browser }) => {
    const page = await signIn(browser);
    const id = await openEditor(page, [GEO]);
    const geo = region(page, /Where was this/);
    await geo.locator('input[type=file]').setInputFiles(`${FIXTURES}/gps.jpg`);
    await expect(geo.getByText("34.9671, 135.7727. From the photo's GPS, so check it's right.")).toBeVisible({ timeout: 15_000 });

    const image = (await savedPhoto(page, id)).image;
    const thumb = geo.getByAltText('Photo 1');
    await expect.poll(() => thumb.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(960);

    const sizes = await page.evaluate(async (name) => {
      const read = async (variant: string) => {
        const response = await fetch(`/media/${name}/${variant}.jpg`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
        return { width: bitmap.width, size: bytes.length, text: String.fromCharCode(...bytes.slice(0, 4000)) };
      };
      return { full: await read('full'), small: await read('small') };
    }, image);
    expect(sizes.full.width).toBe(1920);
    expect(sizes.small.width).toBe(960);
    expect(sizes.small.size).toBeLessThanOrEqual(170 * 1024);
    for (const version of [sizes.full, sizes.small]) {
      expect(version.text).not.toContain('Exif');
      expect(version.text).not.toContain('SecretCameraMake');
    }
  });

  test('a photo taken sideways ends up the right way round', async ({ browser }) => {
    const page = await signIn(browser);
    await openEditor(page, [CAPTION]);
    const caption = region(page, /Caption this/);
    await caption.locator('input[type=file]').setInputFiles(`${FIXTURES}/sideways.jpg`);
    const thumb = caption.getByAltText('Photo 1');
    await thumb.waitFor({ timeout: 15_000 });
    await expect.poll(() => thumb.evaluate((node: HTMLImageElement) => node.naturalHeight)).toBeGreaterThan(0);
    const { width, height } = await thumb.evaluate((node: HTMLImageElement) => ({
      width: node.naturalWidth,
      height: node.naturalHeight,
    }));
    expect(height).toBeGreaterThan(width);
  });

  test('an iPhone photo converts, with its location', async ({ browser }) => {
    test.setTimeout(60_000);
    const page = await signIn(browser);
    await openEditor(page, [GEO]);
    const geo = region(page, /Where was this/);
    await geo.locator('input[type=file]').setInputFiles(`${FIXTURES}/iphone.heic`);
    await expect(geo.getByText(/^35\.6586, 139\.7454/)).toBeVisible({ timeout: 45_000 });
    const thumb = geo.getByAltText('Photo 1');
    await expect.poll(() => thumb.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(640);
  });

  test('a photo with no location asks for one', async ({ browser }) => {
    const page = await signIn(browser);
    await openEditor(page, [GEO]);
    const geo = region(page, /Where was this/);
    await geo.locator('input[type=file]').setInputFiles(`${FIXTURES}/plain.jpg`);
    await expect(geo.getByText('No location yet.')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Where was this?, photo 1: set the location.')).toBeVisible();
  });

  test('a file that is not a photo gets a clear message', async ({ browser }) => {
    const page = await signIn(browser);
    await openEditor(page, [CAPTION]);
    await region(page, /Caption this/)
      .locator('input[type=file]')
      .setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a photo') });
    await expect(page.getByText("notes.txt: couldn't read or upload this photo. Try again.")).toBeVisible();
  });

  test('photos can be dragged in', async ({ browser }) => {
    const page = await signIn(browser);
    await openEditor(page, [CAPTION]);
    const bytes = readFileSync(`${FIXTURES}/plain.jpg`).toString('base64');
    const transfer = await page.evaluateHandle((data) => {
      const list = new DataTransfer();
      const binary = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
      list.items.add(new File([binary], 'dropped.jpg', { type: 'image/jpeg' }));
      return list;
    }, bytes);
    await region(page, /Caption this/).locator('.dropzone').dispatchEvent('drop', { dataTransfer: transfer });
    await expect(region(page, /Caption this/).getByAltText('Photo 1')).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('setting a location', () => {
  async function withPhoto(page: Page) {
    await openEditor(page, [GEO]);
    const geo = region(page, /Where was this/);
    await geo.locator('input[type=file]').setInputFiles(`${FIXTURES}/plain.jpg`);
    await geo.getByText('No location yet.').waitFor({ timeout: 15_000 });
    return geo;
  }

  test('pasted coordinates set it, and a spot abroad is flagged', async ({ browser }) => {
    const page = await signIn(browser);
    const geo = await withPhoto(page);
    await geo.getByRole('button', { name: /Set location/ }).click();
    const coordinates = geo.getByLabel('Coordinates');

    await coordinates.fill('not a place');
    await coordinates.press('Enter');
    await expect(geo.getByText('Use the form 35.0116, 135.7681.')).toBeVisible();

    await coordinates.fill('41.9028, 12.4964');
    await coordinates.press('Enter');
    await expect(geo.getByText('41.9028, 12.4964 is outside Japan.')).toBeVisible();
    await expect(page.getByText(/photo 1: the location is outside Japan/)).toBeVisible();

    await coordinates.fill('35.0116, 135.7681');
    await coordinates.press('Enter');
    await expect(geo.getByText('35.0116, 135.7681', { exact: true })).toBeVisible();
  });

  test('coordinates being typed survive the deck saving', async ({ browser }) => {
    const page = await signIn(browser);
    const geo = await withPhoto(page);
    await geo.getByRole('button', { name: /Set location/ }).click();
    const coordinates = geo.getByLabel('Coordinates');
    await coordinates.fill('41.9028, 12.4964');
    await coordinates.press('Enter');
    // Typed while that change is still saving, and not applied yet.
    await coordinates.fill('35.0116, 135.7681');
    await page.getByText('Saved', { exact: true }).waitFor();
    await expect(coordinates).toHaveValue('35.0116, 135.7681');
    await coordinates.press('Enter');
    await expect(geo.getByText('35.0116, 135.7681', { exact: true })).toBeVisible();
  });

  test('clicking the map places the pin', async ({ browser }) => {
    const page = await signIn(browser);
    // A blank style, so this doesn't depend on the map service being up.
    await page.context().route('https://tiles.openfreemap.org/**', (route) =>
      route.fulfill({ json: { version: 8, sources: {}, layers: [] } }),
    );
    const geo = await withPhoto(page);
    await geo.getByRole('button', { name: /Set location/ }).click();
    const canvas = geo.locator('.maplibregl-canvas');
    await canvas.waitFor({ timeout: 15_000 });
    await canvas.click();
    await expect(geo.locator('.pin-mark')).toBeVisible();
    // The middle of the opening view is somewhere in Japan.
    await expect(geo.getByLabel('Coordinates')).toHaveValue(/^3\d\.\d+, 13\d\.\d+$/);
    await expect(geo.getByText(/is outside/)).toHaveCount(0);
  });
});

test.describe('managing decks', () => {
  test('games and words can be reordered, added and removed', async ({ browser }) => {
    const page = await signIn(browser);
    const id = await openEditor(page, [
      { ...DEFINE, items: [{ word: 'first', definition: 'a' }, { word: 'second', definition: 'b' }] },
      GEO,
    ]);
    await page.getByRole('button', { name: 'Move word 1 down' }).click();
    await expect(page.getByLabel('Word 1', { exact: true })).toHaveValue('second');

    await page.getByRole('button', { name: 'Move Where was this? earlier' }).click();
    await expect(page.getByRole('heading', { level: 2 }).first()).toHaveText('1 Where was this?');

    await page.getByRole('button', { name: 'Add: Caption this' }).click();
    await page.getByRole('button', { name: 'Caption this: Remove' }).click();
    await page.getByText('Saved', { exact: true }).waitFor();
    await expect
      .poll(async () => (await savedDeck(page, id)).games.map((game: { type: string }) => game.type))
      .toEqual(['geo', 'define']);
  });

  test('a deck can be duplicated and deleted, with a second press to confirm', async ({ browser }) => {
    const page = await signIn(browser);
    const title = uniqueTitle();
    await makeDeck(page, { title });
    await page.reload();

    await page.getByRole('button', { name: `${title}: Duplicate` }).click();
    await expect(page.getByRole('link', { name: `${title} copy` })).toBeVisible();

    const remove = page.getByRole('button', { name: `${title} copy: Delete` });
    await remove.click();
    await expect(page.getByRole('link', { name: `${title} copy` })).toBeVisible();
    await page.getByRole('button', { name: `${title} copy: Really delete?` }).click();
    await expect(page.getByRole('link', { name: `${title} copy` })).toHaveCount(0);
    await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible();
  });

  test('a deck can be exported and imported, and a bad file is refused', async ({ browser }) => {
    const page = await signIn(browser);
    const title = uniqueTitle();
    await makeDeck(page, { title, games: [{ ...DEFINE, items: [{ word: 'komorebi', definition: 'Sunlight' }] }] });
    await page.reload();

    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: `${title}: Export` }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/\.presentation-game\.json$/);
    const file = await download.path();
    const exported = JSON.parse(readFileSync(file, 'utf8'));
    expect(exported.games[0].items).toEqual([{ word: 'komorebi', definition: 'Sunlight' }]);
    expect(exported.id).toBeUndefined();

    await page.getByLabel('Deck file to import').setInputFiles({
      name: 'nonsense.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"title": 7}'),
    });
    await expect(page.getByText("nonsense.json isn't a deck this app can read.")).toBeVisible();

    await page.getByLabel('Deck file to import').setInputFiles(file);
    await page.waitForURL(/\/admin\/decks\//);
    await expect(page.getByLabel('Word 1', { exact: true })).toHaveValue('komorebi');
  });

  test('the sample deck is one press away, with all four games', async ({ browser }) => {
    const page = await signIn(browser);
    await page.context().route('**/api/admin/decks', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { decks: [] } });
      return route.continue();
    }, { times: 1 });
    await page.reload();
    await expect(page.getByText('add the sample deck to try all four games')).toBeVisible();
    await page.getByRole('button', { name: 'Add the sample deck' }).click();
    const row = page.locator('.deck-row', { has: page.getByRole('link', { name: 'Sample deck' }) }).first();
    await expect(row.getByText('Define it: 3 words · Where was this?: 3 photos · Caption this: 2 photos')).toBeVisible();
  });

  test('a double click on Start only starts one game', async ({ browser }) => {
    const page = await signIn(browser);
    const title = uniqueTitle();
    await makeDeck(page, { title, games: [{ ...DEFINE, items: [{ word: 'komorebi', definition: 'Sunlight' }] }] });
    await page.reload();
    await page.getByRole('button', { name: `${title}: Start game` }).dblclick();
    await page.waitForURL(/\/host\//);
    const rooms = await page.evaluate(async () => {
      const response = await fetch('/api/admin/rooms');
      return ((await response.json()) as { rooms: { title: string }[] }).rooms;
    });
    expect(rooms.filter((room) => room.title === title)).toHaveLength(1);
  });

  test("an unfinished deck on the list says what's missing", async ({ browser }) => {
    const page = await signIn(browser);
    const title = uniqueTitle();
    await makeDeck(page, { title });
    await page.reload();
    await page.getByRole('button', { name: `${title}: Start game` }).click();
    await expect(page.getByText('Add at least one word or photo.')).toBeVisible();
  });

  test("a deck's accent colour reaches the TV and the phones", async ({ browser }) => {
    const page = await signIn(browser);
    const id = await makeDeck(page, {
      title: uniqueTitle(),
      theme: { accent: '#225577' },
      games: [{ ...DEFINE, items: [{ word: 'komorebi', definition: 'Sunlight' }] }],
    });
    const room = await page.evaluate(async (deckId) => {
      const response = await fetch('/api/admin/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deckId }),
      });
      return ((await response.json()) as { id: string }).id;
    }, id);
    await page.goto(`/host/${room}`);
    await page.getByText('Scan to join').waitFor();
    const accent = (target: Page) =>
      target.evaluate(() => document.documentElement.style.getPropertyValue('--accent'));
    await expect.poll(() => accent(page)).toBe('#225577');

    const phone = await openPhone(browser, room);
    await joinAs(phone, 'Alex');
    await expect.poll(() => accent(phone)).toBe('#225577');
  });

  test('a long title keeps the player count on the TV', async ({ browser }) => {
    const page = await signIn(browser);
    const id = await makeDeck(page, {
      title: 'A really very long deck title that goes all the way to sixty',
      games: [{ ...DEFINE, items: [{ word: 'komorebi', definition: 'Sunlight' }] }],
    });
    const room = await page.evaluate(async (deckId) => {
      const response = await fetch('/api/admin/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deckId }),
      });
      return ((await response.json()) as { id: string }).id;
    }, id);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`/host/${room}`);
    await page.getByText('Scan to join').waitFor();
    await expect(page.locator('.tv-count-now')).toBeInViewport({ ratio: 1 });
    await expect(page.locator('.tv-title')).toBeInViewport({ ratio: 1 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('signing out ends the session', async ({ browser }) => {
    const page = await signIn(browser);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByLabel('Password')).toBeVisible();
    const status = await page.evaluate(async () => (await fetch('/api/admin/decks')).status);
    expect(status).toBe(401);
  });
});

test.describe('layout and accessibility', () => {
  async function fullEditor(page: Page) {
    await openEditor(page, [
      { ...DEFINE, items: [{ word: 'komorebi', definition: 'Sunlight through the leaves' }] },
      GEO,
      CAPTION,
    ]);
    await region(page, /Where was this/).locator('input[type=file]').setInputFiles(`${FIXTURES}/gps.jpg`);
    await region(page, /Where was this/).getByAltText('Photo 1').waitFor({ timeout: 15_000 });
    await region(page, /Caption this/).locator('input[type=file]').setInputFiles(`${FIXTURES}/plain.jpg`);
    await region(page, /Caption this/).getByAltText('Photo 1').waitFor({ timeout: 15_000 });
    await page.getByText('Saved', { exact: true }).waitFor();
  }

  async function expectNoProblems(page: Page) {
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(', ')}`)).toEqual([]);
  }

  async function expectNoSideScroll(page: Page) {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  }

  test('the deck list and builder have no accessibility problems', async ({ browser }) => {
    const page = await signIn(browser);
    await makeDeck(page, { title: uniqueTitle() });
    await page.reload();
    await page.getByRole('list').first().waitFor();
    await expectNoProblems(page);

    await fullEditor(page);
    await expectNoProblems(page);
    for (const opener of await page.locator('details summary').all()) await opener.click();
    await expectNoProblems(page);
  });

  for (const width of [390, 768, 1280]) {
    test(`the builder fits a ${width}px screen with no sideways scrolling`, async ({ browser }) => {
      const page = await signIn(browser, { width, height: 800 });
      await expectNoSideScroll(page);
      await fullEditor(page);
      await expectNoSideScroll(page);
    });
  }

  test('the page scrolls to reach everything, and the Start button stays in reach', async ({ browser }) => {
    const page = await signIn(browser, { width: 1280, height: 500 });
    await fullEditor(page);
    await page.getByRole('button', { name: 'Add: Define it' }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: 'Add: Define it' })).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Start game' })).toBeInViewport();
  });

  test('nothing sits over the page while no photos are uploading', async ({ browser }) => {
    const page = await signIn(browser, { width: 1280, height: 500 });
    await fullEditor(page);
    await expect(page.locator('.upload-lines')).toBeEmpty();
    const size = await page.locator('.upload-lines').boundingBox();
    expect(size?.height ?? 0).toBe(0);
    // Whatever is at the very bottom of the window is the page's own content, showing through.
    const covering = await page.evaluate(() => {
      const element = document.elementFromPoint(640, window.innerHeight - 4);
      return element?.closest('.upload-lines, .editor-bar') ? element.className : null;
    });
    expect(covering).toBeNull();
  });

  test('the top bar runs the full width of the window', async ({ browser }) => {
    const page = await signIn(browser, { width: 1280, height: 800 });
    await openEditor(page, [DEFINE]);
    const bar = await page.locator('.editor-bar').boundingBox();
    expect(bar).toMatchObject({ x: 0, width: 1280 });
    const colour = await page.getByRole('link', { name: 'Your decks' }).evaluate((node) => getComputedStyle(node).color);
    expect(colour).toBe('rgb(42, 41, 38)');
  });

  test('phones still download none of the builder', async ({ browser }) => {
    const page = await signIn(browser);
    const id = await makeDeck(page, {
      title: uniqueTitle(),
      games: [{ ...DEFINE, items: [{ word: 'komorebi', definition: 'Sunlight' }] }],
    });
    const room = await page.evaluate(async (deckId) => {
      const response = await fetch('/api/admin/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deckId }),
      });
      return ((await response.json()) as { id: string }).id;
    }, id);
    const context = await browser.newContext();
    const phone = await context.newPage();
    const scripts: string[] = [];
    phone.on('response', (response) => {
      if (response.url().endsWith('.js')) scripts.push(response.url());
    });
    const answer = await phone.goto(`/j/${room}`);
    await phone.getByLabel('Your name').waitFor();
    expect(scripts.some((url) => /heic|maplibre|exifr|DeckEditor|AdminApp/i.test(url))).toBe(false);
    // Only the builder may run the photo converter's code.
    expect(answer!.headers()['content-security-policy']).not.toContain('wasm-unsafe-eval');
    await context.close();
  });
});

async function savedPhoto(page: Page, id: string): Promise<{ image: string }> {
  await expect.poll(async () => (await savedDeck(page, id)).games[0].items.length).toBe(1);
  return (await savedDeck(page, id)).games[0].items[0];
}
