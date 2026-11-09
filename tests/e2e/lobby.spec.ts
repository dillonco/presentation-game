import { expect, test } from '@playwright/test';
import { closeEverything, joinAs, openPhone, startGame } from './helpers.js';

test.afterEach(closeEverything);

test('guests scan in and the lobby fills up live', async ({ browser }) => {
  const { tv, room } = await startGame(browser);
  await expect(tv.getByText('Names appear here')).toBeVisible();

  const alex = await openPhone(browser, room);
  await joinAs(alex, 'Alex');
  await expect(tv.getByRole('listitem').filter({ hasText: 'Alex' })).toBeVisible();
  await expect(tv.getByText('1 of 50 joined')).toBeAttached();

  const sam = await openPhone(browser, room);
  await joinAs(sam, 'Sam');
  const priya = await openPhone(browser, room);
  await joinAs(priya, 'Priya');
  await expect(tv.getByText('3 of 50 joined')).toBeAttached();
  await expect(alex.getByText('3 of 50 here')).toBeVisible();
});

test('the QR code holds the room link', async ({ browser }) => {
  const { tv, room } = await startGame(browser);
  const qr = tv.getByRole('img', { name: 'QR code to join the game' });
  await expect(qr).toBeVisible();
  // Reads the code's own path, since headless browsers have no camera to scan it.
  expect(await qr.locator('path').getAttribute('d')).toMatch(/^M\d+ \d+h1v1h-1z/);
  expect(room).toMatch(/^[A-Za-z0-9_-]{22}$/);
});

test('refreshing a phone returns to the game without asking for a name', async ({ browser }) => {
  const { room } = await startGame(browser);
  const phone = await openPhone(browser, room);
  await joinAs(phone, 'Alex');
  await phone.reload();
  await expect(phone.getByText("You're in")).toBeVisible();
  await expect(phone.getByRole('heading', { name: 'Alex' })).toBeVisible();
  await expect(phone.getByLabel('Your name')).toHaveCount(0);
});

test('rescanning the QR code in a new tab is the same player', async ({ browser }) => {
  const { tv, room } = await startGame(browser);
  const phone = await openPhone(browser, room);
  await joinAs(phone, 'Alex');
  const again = await phone.context().newPage();
  await again.goto(`/j/${room}`);
  await expect(again.getByRole('heading', { name: 'Alex' })).toBeVisible();
  await expect(tv.getByText('1 of 50 joined')).toBeAttached();
});

test('the TV view resumes after a refresh', async ({ browser }) => {
  const { tv, room } = await startGame(browser);
  const phone = await openPhone(browser, room);
  await joinAs(phone, 'Alex');
  await tv.reload();
  await expect(tv.getByRole('listitem').filter({ hasText: 'Alex' })).toBeVisible();
});

test('a double tap on Join makes one player', async ({ browser }) => {
  const { tv, room } = await startGame(browser);
  const phone = await openPhone(browser, room);
  await phone.getByLabel('Your name').fill('Alex');
  await phone.getByRole('button', { name: 'Join game' }).dblclick();
  await phone.getByText("You're in").waitFor();
  await expect(tv.getByText('1 of 50 joined')).toBeAttached();
});

test('holding Return sends once', async ({ browser }) => {
  const { tv, room } = await startGame(browser);
  const phone = await openPhone(browser, room);
  const field = phone.getByLabel('Your name');
  await field.fill('Alex');
  await field.press('Enter');
  await phone.getByText("You're in").waitFor();
  await expect(tv.getByText('1 of 50 joined')).toBeAttached();
});

test('a double press of Space on the TV moves one screen, at any speed', async ({ browser }) => {
  const { tv, room } = await startGame(browser);
  await joinAs(await openPhone(browser, room), 'Alex');
  await tv.keyboard.press('Space');
  await tv.waitForTimeout(150);
  await tv.keyboard.press('Space');
  await expect(tv.getByRole('heading', { name: 'Define it' })).toBeVisible();
  await tv.waitForTimeout(300);
  await expect(tv.getByRole('heading', { name: 'Define it' })).toBeVisible();

  await tv.waitForTimeout(300);
  await tv.keyboard.press('Space');
  await expect(tv.getByRole('heading', { name: 'komorebi' })).toBeVisible();
});

test('Space does nothing on an empty lobby, and Next says so by being off', async ({ browser }) => {
  const { tv, room } = await startGame(browser);
  await tv.keyboard.press('Space');
  await tv.waitForTimeout(300);
  await expect(tv.getByText('Scan to join')).toBeVisible();
  await tv.mouse.move(200, 200);
  await expect(tv.getByRole('button', { name: /^Next/ })).toBeDisabled();

  await joinAs(await openPhone(browser, room), 'Alex');
  await expect(tv.getByRole('button', { name: /^Next/ })).toBeEnabled();
  await tv.waitForTimeout(600);
  await tv.keyboard.press('Space');
  await expect(tv.getByRole('heading', { name: 'Define it' })).toBeVisible();
});

test('the first game locks joining, and L reopens it', async ({ browser }) => {
  const { tv, room } = await startGame(browser);
  await joinAs(await openPhone(browser, room), 'Alex');
  await tv.keyboard.press('Space');
  await expect(tv.getByRole('heading', { name: 'Define it' })).toBeVisible();

  const late = await openPhone(browser, room);
  await expect(late.getByText('Joining is closed. Already playing? Enter the same name.')).toBeVisible();
  await late.getByLabel('Your name').fill('Late');
  await late.getByRole('button', { name: 'Join game' }).click();
  await expect(late.getByRole('alert')).toHaveText('Joining is closed. Ask the presenter to open it.');

  await tv.keyboard.press('l');
  await tv.waitForTimeout(100);
  await late.getByRole('button', { name: 'Join game' }).click();
  await expect(late.getByRole('heading', { name: 'Define it' })).toBeVisible();
});

test('F fills the screen with the TV, and F again leaves it', async ({ browser }) => {
  const { tv } = await startGame(browser);
  const fullScreen = () => tv.evaluate(() => document.fullscreenElement === document.documentElement);

  await tv.keyboard.press('f');
  await expect.poll(fullScreen).toBe(true);
  await expect(tv.getByRole('button', { name: /^Exit full screen/ })).toHaveAttribute('aria-pressed', 'true');

  await tv.keyboard.press('f');
  await expect.poll(fullScreen).toBe(false);
  await expect(tv.getByRole('button', { name: /^Full screen/ })).toHaveAttribute('aria-pressed', 'false');
});

test('J brings the join code back after the lobby, and J or Esc puts it away', async ({ browser }) => {
  const { tv, room } = await startGame(browser);
  await joinAs(await openPhone(browser, room), 'Alex');
  const card = tv.getByRole('complementary', { name: 'Rejoin link' });

  // The lobby already shows the code.
  await tv.keyboard.press('j');
  await expect(card).toHaveCount(0);

  await tv.keyboard.press('Space');
  await expect(tv.getByRole('heading', { name: 'Define it' })).toBeVisible();
  await tv.keyboard.press('j');
  await expect(card).toBeVisible();
  await expect(card.getByRole('img', { name: 'QR code to get back into the game' })).toBeVisible();
  await expect(card.getByRole('heading', { name: 'Scan to get back in' })).toBeVisible();
  await tv.keyboard.press('j');
  await expect(card).toHaveCount(0);

  await tv.mouse.move(200, 200);
  await tv.getByRole('button', { name: /^Rejoin link/ }).click();
  await expect(card).toBeVisible();
  await tv.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
});

test('the presenter removes a guest, and that phone stays out', async ({ browser }) => {
  const { tv, room } = await startGame(browser);
  const phone = await openPhone(browser, room);
  await joinAs(phone, 'Mallory');

  await tv.keyboard.press('r');
  await tv.getByRole('button', { name: 'Remove Mallory' }).click();
  // Two steps: a single click only arms it.
  await expect(phone.getByText("You're in")).toBeVisible();
  await tv.getByRole('button', { name: 'Confirm removal' }).click();

  await expect(phone.getByRole('heading', { name: 'You were removed from this game' })).toBeVisible();
  await expect(tv.getByText('0 of 50 joined')).toBeAttached();
  await phone.reload();
  await expect(phone.getByRole('heading', { name: 'You were removed from this game' })).toBeVisible();
});

test('a new phone gets back in after the presenter approves', async ({ browser }) => {
  const { tv, room } = await startGame(browser);
  const old = await openPhone(browser, room);
  await joinAs(old, 'Alex');
  await old.context().close();
  await expect(tv.getByRole('listitem').filter({ hasText: 'Alex' })).toHaveClass(/offline/);

  const fresh = await openPhone(browser, room);
  await fresh.getByLabel('Your name').fill('alex');
  await fresh.getByRole('button', { name: 'Join game' }).click();
  await expect(fresh.getByRole('heading', { name: 'Asking the presenter' })).toBeVisible();
  await expect(tv.getByText('Alex wants back in')).toBeVisible();

  await tv.keyboard.press('y');
  await expect(fresh.getByText("You're in")).toBeVisible();
  await expect(tv.getByText('Alex wants back in')).toHaveCount(0);
  await expect(tv.getByText('1 of 50 joined')).toBeAttached();
});

test('a declined phone is told and can pick another name', async ({ browser }) => {
  const { tv, room } = await startGame(browser);
  const old = await openPhone(browser, room);
  await joinAs(old, 'Alex');
  await old.context().close();
  await expect(tv.getByRole('listitem').filter({ hasText: 'Alex' })).toHaveClass(/offline/);

  const fresh = await openPhone(browser, room);
  await fresh.getByLabel('Your name').fill('Alex');
  await fresh.getByRole('button', { name: 'Join game' }).click();
  await expect(tv.getByText('Alex wants back in')).toBeVisible();
  await tv.keyboard.press('n');
  await expect(fresh.getByRole('alert')).toHaveText('The presenter said no. Try a different name.');
  await joinAs(fresh, 'Alexa');
});

test('a phone rides out a dropout and lands back on the current screen', async ({ browser }) => {
  const { tv, room } = await startGame(browser);
  const phone = await openPhone(browser, room);
  await joinAs(phone, 'Alex');
  await phone.context().setOffline(true);
  await expect(phone.getByText('Reconnecting…')).toBeVisible({ timeout: 25_000 });
  await tv.keyboard.press('Space');
  await expect(tv.getByRole('heading', { name: 'Define it' })).toBeVisible();
  await phone.context().setOffline(false);
  await expect(phone.getByText('Reconnecting…')).toHaveCount(0, { timeout: 25_000 });
  await expect(phone.getByRole('heading', { name: 'Define it' })).toBeVisible();
});

test('a name sent during a dropout arrives, and the button says what it is doing', async ({ browser }) => {
  const { tv, room } = await startGame(browser);
  const phone = await openPhone(browser, room);
  await phone.getByLabel('Your name').waitFor();
  await phone.context().setOffline(true);
  await phone.getByLabel('Your name').fill('Alex');
  await phone.getByRole('button', { name: 'Join game' }).click();
  await expect(phone.getByRole('button', { name: 'Joining…' })).toBeVisible();
  await expect(phone.getByRole('button', { name: 'Still sending…' })).toBeVisible({ timeout: 5000 });
  await expect(phone.getByText('Weak connection')).toBeVisible();
  await phone.context().setOffline(false);
  await expect(phone.getByText("You're in")).toBeVisible({ timeout: 25_000 });
  await expect(tv.getByText('1 of 50 joined')).toBeAttached();
});

test('a link to a game that does not exist says so', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/j/${'A'.repeat(22)}`);
  await expect(page.getByRole('heading', { name: "This game isn't running" })).toBeVisible();
});

test('the TV sends you to sign in without a session', async ({ browser }) => {
  const { room } = await startGame(browser);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/host/${room}`);
  await page.waitForURL(/\/admin\?next=/);
  await page.getByLabel('Password').fill('e2e-test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(new RegExp(`/host/${room}`));
  await expect(page.getByText('Scan to join')).toBeVisible();
});

test('a wrong password gets a clear message and no session', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/admin');
  await page.getByLabel('Password').fill('wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText("That password isn't right. Try again.");
  expect(await context.cookies()).toEqual([]);
});
