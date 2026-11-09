import { randomBytes } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { io } from 'socket.io-client';
import { closeEverything, joinAs, openPhone, PHONE, startGame } from './helpers.js';

test.afterEach(closeEverything);

const SIZES = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
];

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error('element has no box');
  return found;
}

async function expectInsideScreen(page: Page, locator: Locator): Promise<void> {
  const { y, height, x, width } = await box(locator);
  const size = page.viewportSize()!;
  expect(y).toBeGreaterThanOrEqual(0);
  expect(y + height).toBeLessThanOrEqual(size.height);
  expect(x).toBeGreaterThanOrEqual(0);
  expect(x + width).toBeLessThanOrEqual(size.width);
}

async function expectNoScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return { x: root.scrollWidth - root.clientWidth, y: root.scrollHeight - root.clientHeight };
  });
  expect(overflow.x).toBeLessThanOrEqual(0);
  expect(overflow.y).toBeLessThanOrEqual(0);
}

async function expectNoAccessibilityProblems(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(', ')}`)).toEqual([]);
}

for (const size of SIZES) {
  test(`join screen fits and holds still at ${size.width}×${size.height}`, async ({ browser }) => {
    const { room } = await startGame(browser);
    const phone = await openPhone(browser, room, { ...PHONE, viewport: size });
    const field = phone.getByLabel('Your name');
    const button = phone.getByRole('button', { name: 'Join game' });
    await button.waitFor();
    await expectNoScroll(phone);
    await expectInsideScreen(phone, button);
    const resting = await box(button);

    // Error state: the message must not push the button anywhere.
    await button.click();
    await expect(phone.getByRole('alert')).toBeVisible();
    expect(await box(button)).toEqual(resting);

    // Keyboard open, roughly half the screen.
    await phone.setViewportSize({ width: size.width, height: Math.max(260, Math.round(size.height * 0.5)) });
    await phone.waitForTimeout(100);
    await expectNoScroll(phone);
    await expectInsideScreen(phone, field);
    await expectInsideScreen(phone, button);
    expect((await box(button)).x).toBe(resting.x);
    expect((await box(button)).width).toBe(resting.width);
  });
}

test('the shell follows the visible screen when the keyboard opens', async ({ browser }) => {
  const { room } = await startGame(browser);
  const phone = await openPhone(browser, room);
  await phone.getByLabel('Your name').waitFor();
  await phone.setViewportSize({ width: 390, height: 400 });
  // Wait for the resize to reach the page rather than a fixed pause, which a busy machine outruns.
  await expect.poll(async () => (await box(phone.locator('.shell'))).height).toBe(400);
  expect((await box(phone.locator('.shell'))).y).toBe(0);
});

test('tapping Send keeps focus in the text box, so the keyboard stays open', async ({ browser }) => {
  const { room } = await startGame(browser);
  const phone = await openPhone(browser, room);
  const field = phone.getByLabel('Your name');
  await field.focus();
  const { x, y, width, height } = await box(phone.getByRole('button', { name: 'Join game' }));
  await phone.mouse.move(x + width / 2, y + height / 2);
  await phone.mouse.down();
  await expect(field).toBeFocused();
  await phone.mouse.up();
  await expect(phone.getByRole('alert')).toBeVisible();
  await expect(field).toBeFocused();
});

test('pressing a button never moves or resizes it', async ({ browser }) => {
  const { room } = await startGame(browser);
  const phone = await openPhone(browser, room);
  const button = phone.getByRole('button', { name: 'Join game' });
  const before = await box(button);
  await phone.mouse.move(before.x + 20, before.y + 10);
  await phone.mouse.down();
  await expect(button).toHaveClass(/down/);
  await expect(button.locator('.wash')).toBeAttached();
  expect(await box(button)).toEqual(before);
  await phone.mouse.up();
  expect(await box(button)).toEqual(before);
});

test('the wash starts from the point of contact', async ({ browser }) => {
  const { room } = await startGame(browser);
  const phone = await openPhone(browser, room);
  const button = phone.getByRole('button', { name: 'Join game' });
  const { x, y, height } = await box(button);
  await phone.mouse.move(x + 30, y + height / 2);
  await phone.mouse.down();
  await phone.waitForTimeout(400);
  const wash = await box(button.locator('.wash'));
  expect(Math.abs(wash.x + wash.width / 2 - (x + 30))).toBeLessThan(2);
  await phone.mouse.up();
});

test.describe('style guide', () => {
  // Tall enough to hold both phones, so nothing scrolls while positions are compared.
  const size = { width: 390, height: 1800 };

  test('Send, its states and Edit answer stay in one spot', async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/styleguide');
    const send = page.getByRole('button', { name: 'Send' });
    const resting = await box(send);

    await page.getByLabel('Your fake definition').fill('sunlight');
    await send.click();
    await expect(page.getByRole('button', { name: 'Sending…' })).toBeVisible();
    expect(await box(page.getByRole('button', { name: 'Sending…' }))).toEqual(resting);
    await expect(page.getByRole('alert')).toHaveText('Too close to another answer. Try something different.');
    expect(await box(send)).toEqual(resting);

    await page.getByLabel('Your fake definition').fill('A shared silence');
    await send.click();
    const edit = page.getByRole('button', { name: 'Edit answer' });
    await edit.waitFor();
    expect(await box(edit)).toEqual(resting);
    await expect(page.getByText('Locked in')).toBeVisible();
  });

  test('a tap on an answer sends it, and another tap changes it', async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/styleguide');
    const options = page.getByRole('radio');
    await expect(page.getByText('Tap one. You can change it until time runs out.')).toBeVisible();

    const optionBox = await box(options.nth(1));
    await options.nth(1).click();
    await expect(options.nth(1)).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('Sending…')).toBeVisible();
    await expect(page.getByText('Locked in')).toBeVisible();
    expect(await box(options.nth(1))).toEqual(optionBox);

    await options.nth(0).click();
    await expect(options.nth(0)).toHaveAttribute('aria-checked', 'true');
    await expect(options.nth(1)).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByText('Locked in')).toBeVisible();
  });

  test('the sun bar runs left to right without restarting', async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/styleguide');
    const sun = page.locator('.sunbar-sun').first();
    const first = (await box(sun)).x;
    await page.waitForTimeout(1500);
    const second = (await box(sun)).x;
    expect(second).toBeGreaterThan(first);
    await page.waitForTimeout(500);
    expect((await box(sun)).x).toBeGreaterThan(second);
  });

  test('the last 10 seconds change the digits', async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/styleguide');
    await expect(page.locator('.strip-digits').nth(1)).toHaveClass(/last/);
    await expect(page.locator('.strip-digits').nth(0)).not.toHaveClass(/last/);
  });

  test('reduced motion turns off the sweep and keeps the fill', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce', viewport: size });
    const page = await context.newPage();
    await page.goto('/styleguide');
    await expect(page.locator('.sunbar-sweep').first()).toBeHidden();
    await expect(page.locator('.sunbar-sun').first()).toBeVisible();
  });
});

test('the TV never scrolls with 50 names, at 1080p and 720p', async ({ browser, baseURL }) => {
  const { tv, room } = await startGame(browser);
  const sockets = await Promise.all(
    Array.from({ length: 50 }, async (_, i) => {
      const socket = io(baseURL!, { auth: { room, role: 'guest' }, transports: ['websocket'] });
      // The longest names allowed are the worst case for the grid.
      const name = `Wwwwwwwwwwwwww${String(i).padStart(2, '0')}`;
      await socket.emitWithAck('guest:join', { token: randomBytes(32).toString('base64url'), name });
      return socket;
    }),
  );
  await expect(tv.getByText('50 of 50 joined')).toBeAttached();
  await expect(tv.getByText('The game is full')).toBeVisible();

  for (const size of [
    { width: 1920, height: 1080 },
    { width: 1280, height: 720 },
  ]) {
    await tv.setViewportSize(size);
    await tv.waitForTimeout(100);
    await expectNoScroll(tv);
    await expectInsideScreen(tv, tv.getByRole('listitem').last());
    // Long names are clipped to their column, never spilling into the next.
    const first = await box(tv.getByRole('listitem').nth(0));
    const second = await box(tv.getByRole('listitem').nth(1));
    expect(first.x + first.width).toBeLessThanOrEqual(second.x);
  }
  sockets.forEach((socket) => socket.close());
});

test.describe('accessibility', () => {
  test('phone screens', async ({ browser }) => {
    const { room } = await startGame(browser);
    const phone = await openPhone(browser, room);
    await phone.getByLabel('Your name').waitFor();
    await expectNoAccessibilityProblems(phone);

    await phone.getByRole('button', { name: 'Join game' }).click();
    await expect(phone.getByRole('alert')).toBeVisible();
    await expectNoAccessibilityProblems(phone);

    await joinAs(phone, 'Alex');
    await expectNoAccessibilityProblems(phone);
  });

  test('TV screens', async ({ browser }) => {
    const { tv, room } = await startGame(browser);
    await expectNoAccessibilityProblems(tv);

    const phone = await openPhone(browser, room);
    await joinAs(phone, 'Alex');
    await expect(tv.getByRole('listitem').filter({ hasText: 'Alex' })).toBeVisible();
    await tv.waitForTimeout(350);
    await expectNoAccessibilityProblems(tv);

    await tv.keyboard.press('r');
    await tv.getByRole('button', { name: 'Remove Alex' }).waitFor();
    await expectNoAccessibilityProblems(tv);
    await tv.keyboard.press('r');

    await tv.keyboard.press('Space');
    await tv.getByRole('heading', { name: 'Define it' }).waitFor();
    await expectNoAccessibilityProblems(tv);
  });

  test('sign-in and the style guide', async ({ page }) => {
    await page.goto('/admin');
    await page.getByLabel('Password').waitFor();
    await expectNoAccessibilityProblems(page);

    await page.setViewportSize({ width: 390, height: 1800 });
    await page.goto('/styleguide');
    await page.getByRole('radio').first().waitFor();
    await expectNoAccessibilityProblems(page);
  });
});

test('phones load within the first-load budget, compressed', async ({ browser }) => {
  const { room } = await startGame(browser);
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  await client.send('Network.enable');
  let bytes = 0;
  client.on('Network.loadingFinished', (event) => {
    bytes += event.encodedDataLength;
  });
  await page.goto(`/j/${room}`);
  await page.getByLabel('Your name').waitFor();
  await page.waitForTimeout(500);
  expect(bytes).toBeLessThan(200 * 1024);
});
