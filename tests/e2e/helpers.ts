import type { Browser, BrowserContext, Page } from '@playwright/test';

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

/** Signs in on a TV-sized page and starts a game, from a deck of these games if given. */
export async function startGame(
  browser: Browser,
  games?: unknown[],
): Promise<{ tv: Page; room: string; context: BrowserContext }> {
  const context = await newContext(browser, { viewport: { width: 1920, height: 1080 } });
  const tv = await context.newPage();
  failOnPageErrors(tv);
  await tv.goto('/admin');
  await tv.getByLabel('Password').fill('e2e-test-password');
  await tv.getByRole('button', { name: 'Sign in' }).click();
  await tv.getByRole('heading', { name: 'Your decks' }).waitFor();
  const id = await tv.evaluate(async (deckGames) => {
    const post = (path: string, body?: unknown) =>
      fetch(path, {
        method: 'POST',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }).then((response) => response.json() as Promise<any>);
    if (deckGames === undefined) return (await post('/api/admin/rooms')).id as string;
    const { deck } = await post('/api/admin/decks', {
      title: 'Test deck',
      theme: { accent: null },
      region: { country: 'Japan' },
      moderation: { blocklist: [], similarity: 'normal', showLeftPage: true },
      games: deckGames,
    });
    return (await post('/api/admin/rooms', { deckId: deck.id })).id as string;
  }, games);
  await tv.goto(`/host/${id}`);
  await tv.getByText('Scan to join').waitFor();
  return { tv, room: tv.url().split('/host/')[1]!, context };
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
