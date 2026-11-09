import { expect, test, type Page } from '@playwright/test';
import { closeEverything, joinAs, newContext, openPhone, PHONE, startGame } from './helpers.js';

test.afterEach(closeEverything);

/** The paths the service worker has kept, once it's in charge of the page. */
async function keptPaths(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    if (!navigator.serviceWorker.controller) return [];
    const names = (await caches.keys()).filter((name) => name.startsWith('trip-party-'));
    const paths: string[] = [];
    for (const name of names) {
      for (const request of await (await caches.open(name)).keys()) paths.push(new URL(request.url).pathname);
    }
    return paths;
  });
}

/** The app's own files this page has loaded that the worker hasn't kept yet. */
async function unkeptAssets(page: Page): Promise<string[]> {
  const kept = new Set(await keptPaths(page));
  const loaded = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((entry) => new URL(entry.name))
      .filter((url) => url.origin === window.location.origin && url.pathname.startsWith('/assets/'))
      .map((url) => url.pathname),
  );
  return [...new Set(loaded)].filter((path) => !kept.has(path));
}

test('a phone that refreshes with no signal still opens the game, then reconnects', async ({ browser }) => {
  const { room } = await startGame(browser);
  const phone = await openPhone(browser, room);
  await joinAs(phone, 'Aiko');

  // The page shell, and the guest screens loaded before the worker took over.
  await expect
    .poll(async () => {
      const paths = await keptPaths(phone);
      return paths.includes('/__shell') && paths.some((path) => /\/assets\/GuestApp-.+\.js$/.test(path));
    }, { timeout: 15_000 })
    .toBe(true);
  // Everything else the page loaded before then, fonts included, is told to the worker a
  // second time after 10 seconds. The tests turn the browser's own cache off (routing does),
  // so going offline before that would leave the fonts with nowhere to come from.
  await expect.poll(() => unkeptAssets(phone), { timeout: 15_000 }).toEqual([]);

  await phone.context().setOffline(true);
  await phone.reload();
  // The app itself opens from the kept copy, and waits for signal.
  await expect(phone.getByRole('heading', { name: 'Connecting…' })).toBeVisible({ timeout: 15_000 });

  await phone.context().setOffline(false);
  await expect(phone.getByText("You're in")).toBeVisible({ timeout: 25_000 });
});

test('a page from before a release reloads once when a screen it needs is gone', async ({ browser }) => {
  const { room } = await startGame(browser);
  const context = await newContext(browser, PHONE);
  const phone = await context.newPage();
  // Until the page loads again, the guest screens 404, as a file from the last release does
  // after a deploy.
  let pageLoads = 0;
  phone.on('request', (request) => {
    if (request.isNavigationRequest()) pageLoads++;
  });
  let refused = 0;
  await context.route(/\/assets\/GuestApp-[^/]+\.js$/, (route) => {
    if (pageLoads >= 2) return route.continue();
    refused++;
    return route.fulfill({ status: 404, body: '' });
  });
  await phone.goto(`/j/${room}`);
  await joinAs(phone, 'Aiko');
  expect(refused).toBeGreaterThan(0);
  expect(pageLoads).toBe(2);
});

test('game data, sockets and the deck builder are never kept', async ({ browser }) => {
  const { room } = await startGame(browser);
  const phone = await openPhone(browser, room);
  await joinAs(phone, 'Kenji');
  await expect.poll(() => keptPaths(phone), { timeout: 15_000 }).toContain('/__shell');
  const paths = await keptPaths(phone);
  expect(paths.filter((path) => path !== '/__shell' && !path.startsWith('/assets/'))).toEqual([]);

  // The deck builder never loads from the kept copy, even on a device that has one.
  await phone.context().setOffline(true);
  const failed = await phone.goto('/admin').then(
    () => false,
    () => true,
  );
  expect(failed).toBe(true);
  await phone.context().setOffline(false);
});
