import { expect, test, type Page } from '@playwright/test';
import {
  closeEverything,
  expectNoAccessibilityProblems,
  FIXTURES,
  joinAs,
  makeDeck,
  openPhone,
  press,
  signIn,
  startGame,
  toRound,
  upload,
} from './helpers.js';

test.afterEach(closeEverything);

async function savedExtras(page: Page, deckId: string): Promise<string[] | undefined> {
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/admin/decks/${id}`);
    const { deck } = (await response.json()) as { deck: { content: { games: { items: { extras?: string[] }[] }[] } } };
    return deck.content.games[0]!.items[0]!.extras;
  }, deckId);
}

test('the deck builder adds and removes more photos for after a reveal', async ({ browser }) => {
  const { page, context } = await signIn(browser);
  const image = await upload(context);
  const deckId = await makeDeck(context, { games: [{ type: 'caption', settings: {}, items: [{ image }] }] });
  await page.goto(`/admin/decks/${deckId}`);
  await page.getByText('Saved', { exact: true }).waitFor();

  const extras = page.getByRole('group', { name: 'More photos after photo 1' });
  await expect(extras.getByText('0 of 5')).toBeVisible();
  await extras.locator('input[type=file]').setInputFiles(`${FIXTURES}/sideways.jpg`);
  await expect(extras.getByAltText('More after photo 1, photo 1')).toBeVisible({ timeout: 15_000 });
  await expect(extras.getByText('1 of 5')).toBeVisible();
  await expect.poll(() => savedExtras(page, deckId)).toHaveLength(1);

  await extras.getByRole('button', { name: 'More after photo 1, photo 1: Remove' }).click();
  await expect(extras.getByText('0 of 5')).toBeVisible();
  await expect.poll(() => savedExtras(page, deckId)).toEqual([]);
});

test('after the winning caption, the TV shows the extra photos and phones point to it', async ({ browser }, testInfo) => {
  const { tv, room } = await startGame(browser, async (image, context) => {
    const extras = await Promise.all([upload(context, 'sideways.jpg'), upload(context, 'gps.jpg')]);
    return [{ type: 'caption', settings: {}, items: [{ image, extras }] }];
  });

  const phone = await openPhone(browser, room);
  await joinAs(phone, 'Aiko');

  await toRound(tv, 'Caption this', 'Write your best caption');
  // Nobody writes, so time's up goes straight to the result.
  await press(tv, 's');
  await press(tv, 's');
  await expect(tv.locator('main.tv')).toHaveAttribute('data-screen', 'reveal');
  await press(tv, 'Space');

  await expect(tv.getByRole('heading', { name: 'More from this one' })).toBeVisible();
  const photos = tv.getByRole('region', { name: 'More photos' }).getByRole('img');
  await expect(photos).toHaveCount(2);
  await expect.poll(() => photos.evaluateAll((nodes) => nodes.every((node) => (node as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await expect(phone.getByText('2 more photos from this one, on the TV.')).toBeVisible();
  await tv.waitForTimeout(1000);
  await tv.screenshot({ path: testInfo.outputPath('gallery.png') });
  await expectNoAccessibilityProblems(tv);

  // A click fills the screen with one, the arrows step through, and Escape goes back.
  await photos.first().click();
  await expect(tv.getByText('1 / 2')).toBeVisible();
  await tv.keyboard.press('ArrowRight');
  await expect(tv.getByText('2 / 2')).toBeVisible();
  const big = tv.locator('.gallery-lightbox img');
  await expect.poll(() => big.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
  await tv.waitForTimeout(600);
  await tv.screenshot({ path: testInfo.outputPath('gallery-open.png') });
  await tv.keyboard.press('Escape');
  await expect(tv.getByText('2 / 2')).toBeHidden();

  await press(tv, 'Space');
  await tv.getByRole('heading', { name: 'Standings' }).waitFor();
});
