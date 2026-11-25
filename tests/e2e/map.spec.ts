import { expect, test, type Page } from '@playwright/test';
import {
  closeEverything,
  expectNoAccessibilityProblems,
  failOnPageErrors,
  joinAs,
  mapPhone,
  mapReady,
  newContext,
  PHONE,
  press,
  startMapGame,
  tapJapan,
  toGuessing,
} from './helpers.js';

test.afterEach(closeEverything);

const SIZES = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
];

/** Inland, up and to the right of the pin from tapJapan, and clear of the pin itself. */
async function tapBesidePin(page: Page): Promise<void> {
  const pin = (await page.locator('.pin-mark').boundingBox())!;
  await page.touchscreen.tap(pin.x + pin.width / 2 + 30, pin.y + pin.height / 2 - 45);
}

test.describe('the map on a phone', () => {
  test('fills the screen right to the bottom edge, at every size', async ({ browser }) => {
    const { tv, room } = await startMapGame(browser);
    const phones = await Promise.all(SIZES.map((size, index) => mapPhone(browser, room, `P${index}`, size)));
    await toGuessing(tv);
    for (const [index, page] of phones.entries()) {
      const canvas = await mapReady(page);
      const box = (await canvas.boundingBox())!;
      const size = SIZES[index]!;
      expect(Math.round(box.width)).toBe(size.width);
      expect(Math.round(box.y + box.height)).toBe(size.height);
      await expect(page.getByRole('button', { name: 'Lock in pin' })).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole('button', { name: 'Zoom in' })).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  });

  test('stays matched to its box when the screen changes size', async ({ browser }) => {
    const { tv, room } = await startMapGame(browser);
    const page = await mapPhone(browser, room, 'Alex');
    await toGuessing(tv);
    const canvas = await mapReady(page);
    for (const size of [{ width: 390, height: 600 }, { width: 700, height: 340 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      await expect.poll(async () => {
        const box = (await canvas.boundingBox())!;
        return [Math.round(box.width), Math.round(box.y + box.height)];
      }).toEqual([size.width, size.height]);
    }
  });

  test('a tap drops the pin, another moves it, and Lock in sends it', async ({ browser }) => {
    const { tv, room } = await startMapGame(browser);
    const page = await mapPhone(browser, room, 'Alex');
    await toGuessing(tv);
    await expect(page.getByText('Tap to drop your pin.')).toBeVisible();
    await tapJapan(page);
    await expect(page.getByText('Tap again to move it, then lock it in.')).toBeVisible();
    const first = (await page.locator('.pin-mark').boundingBox())!;

    await tapBesidePin(page);
    await expect.poll(async () => (await page.locator('.pin-mark').boundingBox())!.x).not.toBe(first.x);

    await page.getByRole('button', { name: 'Lock in pin' }).tap();
    await expect(page.getByRole('button', { name: 'Move pin' })).toBeVisible();
    await expect(page.getByText('Locked in')).toBeVisible();
    await expect(tv.getByText('1 of 1 in')).toBeVisible();
  });

  test('the pin can be dragged, but only inside the country', async ({ browser }) => {
    const { tv, room } = await startMapGame(browser);
    const page = await mapPhone(browser, room, 'Alex');
    await toGuessing(tv);
    await tapJapan(page);
    const pin = page.locator('.pin-mark');
    const start = (await pin.boundingBox())!;
    const centre = { x: start.x + start.width / 2, y: start.y + start.height / 2 };
    const drag = async (dx: number, dy: number) => {
      const from = (await pin.boundingBox())!;
      const fromX = from.x + from.width / 2;
      const fromY = from.y + from.height / 2;
      await page.mouse.move(fromX, fromY);
      await page.mouse.down();
      await page.mouse.move(fromX + dx, fromY + dy, { steps: 8 });
      await page.mouse.up();
    };

    // Up Honshu, and it stays where it's dropped.
    await drag(30, -45);
    await expect
      .poll(async () => {
        const moved = (await pin.boundingBox())!;
        return Math.round(Math.hypot(moved.x + moved.width / 2 - centre.x - 30, moved.y + moved.height / 2 - centre.y + 45));
      })
      .toBeLessThan(4);
    const dropped = (await pin.boundingBox())!;

    // Far out to sea is refused, and the pin goes back.
    await drag(120, 100);
    await expect(page.getByText("That's outside Japan. Drop your pin in Japan.")).toBeVisible();
    await expect
      .poll(async () => {
        const back = (await pin.boundingBox())!;
        return Math.round(Math.abs(back.x - dropped.x) + Math.abs(back.y - dropped.y));
      })
      .toBeLessThan(2);

    // Once locked in, it stays put until Move pin.
    await page.getByRole('button', { name: 'Lock in pin' }).tap();
    await expect(page.getByRole('button', { name: 'Move pin' })).toBeVisible();
    // That drag only pans the map, so back on the opening view the pin is where it was.
    await drag(10, 10);
    await page.getByRole('button', { name: 'Show all of Japan' }).tap();
    await expect
      .poll(async () => {
        const after = (await pin.boundingBox())!;
        return Math.round(Math.abs(after.x - dropped.x) + Math.abs(after.y - dropped.y));
      })
      .toBeLessThan(2);
  });

  test('panning or double-tapping never places a pin', async ({ browser }) => {
    const { tv, room } = await startMapGame(browser);
    const page = await mapPhone(browser, room, 'Alex');
    await toGuessing(tv);
    const canvas = await mapReady(page);
    const box = (await canvas.boundingBox())!;
    const centre = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.4 };
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await page.mouse.move(centre.x + 80, centre.y + 40, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    await expect(page.locator('.pin-mark')).toHaveCount(0);

    await page.mouse.dblclick(centre.x, centre.y);
    await page.waitForTimeout(600);
    await expect(page.locator('.pin-mark')).toHaveCount(0);
  });

  test('zoom keys work, and Show all of Japan comes back to the start', async ({ browser }) => {
    const { tv, room } = await startMapGame(browser);
    const page = await mapPhone(browser, room, 'Alex');
    await toGuessing(tv);
    await tapJapan(page);
    const pin = page.locator('.pin-mark');
    const start = (await pin.boundingBox())!;
    await page.getByRole('button', { name: 'Zoom in' }).tap();
    await page.getByRole('button', { name: 'Zoom in' }).tap();
    await expect.poll(async () => (await pin.boundingBox())!.y).not.toBe(start.y);
    await page.getByRole('button', { name: 'Show all of Japan' }).tap();
    await expect
      .poll(async () => {
        const now = (await pin.boundingBox())!;
        return Math.abs(now.x - start.x) + Math.abs(now.y - start.y);
      })
      .toBeLessThan(2);
    // None of those presses moved the pin itself.
    await expect(page.getByText('Tap again to move it, then lock it in.')).toBeVisible();
  });

  test('a tap off the country is refused, with a message, and keeps the pin', async ({ browser }) => {
    const { tv, room } = await startMapGame(browser);
    const page = await mapPhone(browser, room, 'Alex');
    await toGuessing(tv);
    const canvas = await mapReady(page);
    const box = (await canvas.boundingBox())!;
    // The far corner of the map is open sea.
    await canvas.tap({ position: { x: box.width - 12, y: 150 } });
    await expect(page.getByText("That's outside Japan. Drop your pin in Japan.")).toBeVisible();
    await expect(page.locator('.pin-mark')).toHaveCount(0);
    await tapJapan(page);
    await expect(page.getByText("That's outside Japan.")).toHaveCount(0);
  });

  test('Lock in pin with no pin says what to do, and no button moves', async ({ browser }) => {
    const { tv, room } = await startMapGame(browser);
    const page = await mapPhone(browser, room, 'Alex');
    await toGuessing(tv);
    await mapReady(page);
    const lock = page.getByRole('button', { name: /pin/ }).last();
    const before = await lock.boundingBox();
    await page.getByRole('button', { name: 'Lock in pin' }).tap();
    await expect(page.getByText('Tap the map to drop your pin first.')).toBeVisible();
    expect(await lock.boundingBox()).toEqual(before);
    await tapJapan(page);
    expect(await lock.boundingBox()).toEqual(before);
    await page.getByRole('button', { name: 'Lock in pin' }).tap();
    await expect(page.getByRole('button', { name: 'Move pin' })).toBeVisible();
    expect(await page.getByRole('button', { name: 'Move pin' }).boundingBox()).toEqual(before);
  });

  test('once locked, tapping the map does nothing until Move pin', async ({ browser }) => {
    const { tv, room } = await startMapGame(browser);
    const page = await mapPhone(browser, room, 'Alex');
    await toGuessing(tv);
    await tapJapan(page);
    await page.getByRole('button', { name: 'Lock in pin' }).tap();
    await expect(page.getByRole('button', { name: 'Move pin' })).toBeVisible();
    const locked = (await page.locator('.pin-mark').boundingBox())!;
    await tapBesidePin(page);
    await page.waitForTimeout(500);
    expect((await page.locator('.pin-mark').boundingBox())!.x).toBe(locked.x);

    await page.getByRole('button', { name: 'Move pin' }).tap();
    await tapBesidePin(page);
    await expect.poll(async () => (await page.locator('.pin-mark').boundingBox())!.x).not.toBe(locked.x);
    await expect(page.getByRole('button', { name: 'Lock in pin' })).toBeVisible();
  });

  test('rapid taps on Lock in count once', async ({ browser }) => {
    const { tv, room } = await startMapGame(browser);
    const page = await mapPhone(browser, room, 'Alex');
    await toGuessing(tv);
    await tapJapan(page);
    const lock = page.getByRole('button', { name: 'Lock in pin' });
    await lock.dblclick();
    await expect(page.getByRole('button', { name: 'Move pin' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Lock in pin' })).toHaveCount(0);
  });

  test('a refresh keeps an unsent pin, and a locked one', async ({ browser }) => {
    const { tv, room } = await startMapGame(browser);
    const page = await mapPhone(browser, room, 'Alex');
    await toGuessing(tv);
    await tapJapan(page);
    await page.reload();
    await mapReady(page);
    await expect(page.locator('.pin-mark')).toBeVisible();
    await expect(page.getByText('Tap again to move it, then lock it in.')).toBeVisible();
    await page.getByRole('button', { name: 'Lock in pin' }).tap();
    await expect(page.getByRole('button', { name: 'Move pin' })).toBeVisible();
    await page.reload();
    await mapReady(page);
    await expect(page.locator('.pin-mark')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Move pin' })).toBeVisible();
  });

  test('a pin never locked in still counts when time runs out', async ({ browser }) => {
    const { tv, room } = await startMapGame(browser, { guessSeconds: 10 });
    const page = await mapPhone(browser, room, 'Alex');
    await toGuessing(tv);
    await tapJapan(page);
    await expect(tv.getByRole('heading', { name: 'Fushimi Inari' })).toBeVisible({ timeout: 25_000 });
    await expect(tv.getByText(/\+\d+/).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/ away$|Right on the spot/)).toBeVisible({ timeout: 15_000 });
  });

  test('the photo opens larger and closes again', async ({ browser }) => {
    const { tv, room } = await startMapGame(browser);
    const page = await mapPhone(browser, room, 'Alex');
    await toGuessing(tv);
    await mapReady(page);
    await page.getByRole('button', { name: 'Enlarge Photo 1 of 1' }).tap();
    await page.getByRole('button', { name: 'Tap to close Photo 1 of 1' }).tap();
    await expect(page.getByRole('button', { name: 'Enlarge Photo 1 of 1' })).toBeVisible();
    await expect(page.locator('.pin-mark')).toHaveCount(0);
  });

  test('passes the accessibility checks', async ({ browser }) => {
    const { tv, room } = await startMapGame(browser);
    const page = await mapPhone(browser, room, 'Alex');
    await toGuessing(tv);
    await tapJapan(page);
    await expectNoAccessibilityProblems(page);
  });
});

test.describe('without a working map', () => {
  test('the outline still draws and takes a pin when street data is down', async ({ browser }) => {
    const { tv, room } = await startMapGame(browser);
    const context = await newContext(browser, PHONE);
    await context.route('https://tiles.openfreemap.org/**', (route) => route.abort());
    const page = await context.newPage();
    failOnPageErrors(page, { allowFailedRequests: true });
    await page.goto(`/j/${room}`);
    await joinAs(page, 'Alex');
    await toGuessing(tv);
    await tapJapan(page);
    await page.getByRole('button', { name: 'Lock in pin' }).tap();
    await expect(page.getByRole('button', { name: 'Move pin' })).toBeVisible();
  });

  test('a phone with no graphics support gets the tappable outline', async ({ browser }) => {
    const { tv, room } = await startMapGame(browser);
    const context = await newContext(browser, PHONE);
    await context.addInitScript(() => {
      const real = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        return /webgl/.test(type) ? null : (real as (...args: unknown[]) => unknown).call(this, type, ...rest);
      } as typeof real;
    });
    const page = await context.newPage();
    await page.goto(`/j/${room}`);
    await joinAs(page, 'Alex');
    await toGuessing(tv);
    const outline = page.getByRole('img', { name: 'Map of Japan' });
    await outline.waitFor({ timeout: 20_000 });
    await expect(page.locator('.outline-land')).toBeAttached({ timeout: 20_000 });
    await expect(page.locator('.maplibregl-canvas')).toHaveCount(0);

    // Tokyo, on a drawing 1000 units wide across Japan's map box.
    await page.locator('.outline-map').evaluate((svg: SVGSVGElement) => {
      const [west, east, north] = [123.18, 146.33, 46.01];
      const mercator = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
      const scale = 1000 / ((east - west) * (Math.PI / 180));
      const x = ((139.7 - west) / (east - west)) * 1000;
      const y = (mercator(north) - mercator(35.7)) * scale;
      const point = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM()!);
      svg.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: point.x, clientY: point.y }));
    });
    await expect(page.locator('.outline-target')).toBeAttached();
    await page.getByRole('button', { name: 'Lock in pin' }).tap();
    await expect(page.getByRole('button', { name: 'Move pin' })).toBeVisible();
    await expect(tv.getByText('1 of 1 in')).toBeVisible();
  });
});

test.describe('the reveal on the TV', () => {
  test('flies to the real spot, then names the closest', async ({ browser }) => {
    const { tv, room } = await startMapGame(browser);
    const alex = await mapPhone(browser, room, 'Alex');
    const sam = await mapPhone(browser, room, 'Sam');
    await toGuessing(tv);
    await tapJapan(alex);
    await alex.getByRole('button', { name: 'Lock in pin' }).tap();
    await tapJapan(sam);
    await sam.getByRole('button', { name: 'Lock in pin' }).tap();
    await expect(tv.getByText('2 of 2 in')).toBeVisible();
    await press(tv, 's');

    // The place isn't named until the map starts to move, and phones wait for the TV.
    await expect(tv.locator('.tv-map .maplibregl-canvas')).toBeVisible({ timeout: 20_000 });
    await expect(alex.getByRole('heading', { name: 'Look up at the TV' })).toBeVisible();
    await expect(tv.getByRole('heading', { name: 'Fushimi Inari' })).toBeVisible({ timeout: 10_000 });
    await expect(tv.locator('.pin-mark.target')).toBeVisible();
    await expect(tv.locator('.pin-row.in')).toHaveCount(2, { timeout: 15_000 });
    await expect(tv.locator('.map-name')).toHaveCount(2);

    await expect(alex.getByText(/ away$|Right on the spot/)).toBeVisible({ timeout: 15_000 });
    await expect(alex.getByText('Fushimi Inari')).toBeVisible();
    await expectNoAccessibilityProblems(tv, '.maplibregl-canvas');
  });

  test('Space skips to the end, then moves on', async ({ browser }) => {
    const { tv, room } = await startMapGame(browser);
    const alex = await mapPhone(browser, room, 'Alex');
    await toGuessing(tv);
    await tapJapan(alex);
    await alex.getByRole('button', { name: 'Lock in pin' }).tap();
    await expect(tv.getByText('1 of 1 in')).toBeVisible();
    await press(tv, 's');
    await tv.locator('.tv-map').waitFor();
    await press(tv, 'Space');
    await expect(tv.locator('.pin-row.in')).toHaveCount(1);
    await expect(tv.getByRole('heading', { name: 'Fushimi Inari' })).toBeVisible();
    await expect(alex.getByText(/ away$|Right on the spot/)).toBeVisible();
    await press(tv, 'Space');
    await expect(tv.getByRole('heading', { name: 'Standings' })).toBeVisible();
  });

  test('copes with nobody placing a pin', async ({ browser }) => {
    const { tv, room } = await startMapGame(browser);
    const alex = await mapPhone(browser, room, 'Alex');
    await toGuessing(tv);
    await press(tv, 's');
    await expect(tv.getByText('No pins this time.')).toBeVisible({ timeout: 10_000 });
    await expect(alex.getByText('No pin this time')).toBeVisible({ timeout: 15_000 });
  });

  test('a refreshed TV lands straight on the finished reveal', async ({ browser }) => {
    const { tv, room } = await startMapGame(browser);
    const alex = await mapPhone(browser, room, 'Alex');
    await toGuessing(tv);
    await tapJapan(alex);
    await alex.getByRole('button', { name: 'Lock in pin' }).tap();
    await expect(tv.getByText('1 of 1 in')).toBeVisible();
    await press(tv, 's');
    await tv.locator('.tv-map').waitFor();
    await press(tv, 'Space');
    await tv.reload();
    await expect(tv.locator('.pin-mark.target')).toBeVisible({ timeout: 20_000 });
    await expect(tv.locator('.map-name')).toHaveCount(1);
    await expect(tv.locator('.pin-row.in')).toHaveCount(1);
  });
});

test('the phone downloads no map code before it joins a game', async ({ browser }) => {
  const { room } = await startMapGame(browser);
  const context = await newContext(browser, PHONE);
  const page = await context.newPage();
  const scripts: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'script') scripts.push(request.url());
  });
  await page.goto(`/j/${room}`);
  await page.getByLabel('Your name').waitFor();
  expect(scripts.some((url) => /maplibre|gameMap|PinMap/i.test(url))).toBe(false);
});
