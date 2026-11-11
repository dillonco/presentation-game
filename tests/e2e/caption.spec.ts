import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { closeEverything, failOnPageErrors, joinAs, newContext, openPhone, PHONE } from './helpers.js';

test.afterEach(closeEverything);

const SIZES = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
];

const LONG_CAPTIONS = [
  "When your grandmother insists there's still room in the suitcase for one more enormous jar of pickled plums from the market",
  'Local tourist discovers that the vending machine outside the temple sells hot soup, and quietly reconsiders every life decision so far',
  'The moment everybody on the platform realised the express train does not, in fact, stop here, and neither did their luggage trolley',
  'A pigeon stares down an entire school trip, wins easily, then helps itself to the last of the rice crackers while nobody dares to move',
  '三時間も山道を登ったあとで、地図が逆さまだったと友達がようやく白状した。神社は今朝からずっと私たちの後ろにあったらしい。誰も怒らなかったけれど、帰りの道では誰も話さなかった。夕日だけがきれいで、猿が一匹、こちらを見て笑っていた。',
  'Nobody warned me the hot spring would be this hot, or that the monkeys would be judging my technique quite so openly from the rocks',
  'Our guide said this bridge has stood for four hundred years, then looked at my backpack, then looked at the bridge, then sighed deeply',
  '新宿駅で迷子になって二十分も歩き続けた結果、最初の改札口に戻ってきてしまった私たちを、駅員さんが優しい目で見守っていた。お土産の袋はもう破れそうで、誰も地図を読めないまま、ただ静かに自動販売機の前で温かいお茶を買って飲んでいた午後のこと。',
];

async function startCaptionGame(
  browser: Browser,
  settings: Record<string, number> = {},
): Promise<{ tv: Page; room: string; image: string }> {
  // The shared helper also keeps the TV's GIFs and word clips off the internet.
  const context = await newContext(browser, { viewport: { width: 1920, height: 1080 } });
  const tv = await context.newPage();
  failOnPageErrors(tv);
  await tv.goto('/admin');
  await tv.getByLabel('Password').fill('e2e-test-password');
  await tv.getByRole('button', { name: 'Sign in' }).click();
  await tv.getByRole('heading', { name: 'Your decks' }).waitFor();

  const upload = await context.request.post('/api/admin/images', {
    headers: { 'content-type': 'image/jpeg' },
    data: readFileSync('tests/fixtures/plain.jpg'),
  });
  const { id: image } = (await upload.json()) as { id: string };
  const created = await context.request.post('/api/admin/decks', {
    data: {
      title: 'Captions',
      theme: { accent: null },
      region: { country: 'Japan' },
      moderation: { blocklist: [], similarity: 'normal', showLeftPage: true },
      games: [{ type: 'caption', settings, items: [{ image }] }],
    },
  });
  const { deck } = (await created.json()) as { deck: { id: string } };
  const started = await context.request.post('/api/admin/rooms', { data: { deckId: deck.id } });
  const { id } = (await started.json()) as { id: string };
  await tv.goto(`/host/${id}`);
  await tv.getByText('Scan to join').waitFor();
  return { tv, room: id, image };
}

async function press(tv: Page, key: string): Promise<void> {
  await tv.waitForTimeout(550);
  await tv.keyboard.press(key);
}

async function toWriting(tv: Page): Promise<void> {
  await press(tv, 'Space');
  await tv.getByRole('heading', { name: 'Caption this' }).waitFor();
  await press(tv, 'Space');
  await tv.getByRole('heading', { name: 'Write your best caption' }).waitFor();
}

async function write(phone: Page, text: string): Promise<void> {
  await phone.getByLabel('Your caption').fill(text);
  await phone.getByRole('button', { name: 'Send' }).click();
  await phone.getByText('Locked in').waitFor();
}

/** A tap is the vote: it sends straight away. */
async function chooseAndLock(phone: Page, text: string): Promise<void> {
  await phone.getByRole('radio', { name: text }).click();
  await phone.getByText('Locked in').waitFor();
}

async function photoIsShowing(photo: Locator): Promise<void> {
  await expect
    .poll(() => photo.evaluate((image: HTMLImageElement) => (image.complete ? image.naturalWidth : 0)))
    .toBeGreaterThan(0);
  await expect(photo).toHaveCSS('opacity', '1');
}

/** From writing, past the captions being shown, to the vote. */
async function skipToVoting(tv: Page): Promise<void> {
  const voting = tv.getByRole('heading', { name: 'Vote for the best' });
  for (let press = 0; press < 3 && !(await voting.isVisible()); press += 1) {
    await skipOnce(tv);
  }
  await voting.waitFor();
}

async function skipOnce(tv: Page): Promise<void> {
  await press(tv, 's');
  await tv.waitForTimeout(300);
}

async function noAccessibilityProblems(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.html}`)).toEqual([]);
}

test('a TV and three phones caption a photo through to the standings', async ({ browser }) => {
  test.setTimeout(90_000);
  // A long time on each caption, so this test sets the pace however slow the machine is.
  const { tv, room } = await startCaptionGame(browser, { showSeconds: 30 });
  const alex = await openPhone(browser, room);
  await joinAs(alex, 'Alex');
  const sam = await openPhone(browser, room);
  await joinAs(sam, 'Sam');
  const priya = await openPhone(browser, room);
  await joinAs(priya, 'Priya');

  await toWriting(tv);
  await photoIsShowing(tv.locator('.tv-photo img'));
  await photoIsShowing(alex.locator('.photo-thumb img'));
  await expect(alex.getByText('Caption this · Photo 1 of 1')).toBeVisible();
  await noAccessibilityProblems(tv);
  await noAccessibilityProblems(alex);

  // Tapping opens it larger with the timer still in sight, and the typed text survives.
  await alex.getByLabel('Your caption').fill('A cat judging the platform');
  await alex.getByRole('button', { name: /^Enlarge/ }).click();
  const large = alex.getByRole('button', { name: /^Tap to close/ });
  await expect(large).toBeFocused();
  const [thumbBox, largeBox] = [await alex.locator('.photo-thumb').boundingBox(), await large.boundingBox()];
  expect(largeBox!.height).toBeGreaterThan(thumbBox!.height * 2);
  await expect(alex.locator('.strip')).toBeInViewport();
  await noAccessibilityProblems(alex);
  await alex.keyboard.press('Escape');
  await expect(large).toBeHidden();
  await expect(alex.getByLabel('Your caption')).toHaveValue('A cat judging the platform');

  await alex.getByRole('button', { name: 'Send' }).click();
  await alex.getByText('Locked in').waitFor();
  await expect(tv.getByText('1 of 3 in')).toBeVisible();

  // A copy gets a caption-worded message, and the text stays to edit.
  await sam.getByLabel('Your caption').fill('a cat judging the platform!');
  await sam.getByRole('button', { name: 'Send' }).click();
  await expect(sam.getByText('Too close to another caption. Try something different.')).toBeVisible();
  await expect(sam.getByLabel('Your caption')).toHaveValue('a cat judging the platform!');
  await sam.waitForTimeout(2100);
  await write(sam, 'Rush hour, as seen by the pigeons');

  await press(tv, 's');
  await press(tv, 's');
  // One at a time first, with phones pointing everyone at the TV.
  await tv.getByRole('heading', { name: 'Caption 1 of 2' }).waitFor();
  await expect(alex.getByRole('heading', { name: 'Look up at the TV' })).toBeVisible();
  await expect(tv.locator('.entry-text')).toHaveCount(1);
  const firstShown = await tv.locator('.entry-text').textContent();
  await tv.waitForTimeout(400);
  await noAccessibilityProblems(tv);
  await noAccessibilityProblems(alex);

  await press(tv, 'p');
  await expect(tv.getByText('Paused')).toBeVisible();
  await press(tv, 'p');
  await press(tv, 'Space');
  await tv.getByRole('heading', { name: 'Caption 2 of 2' }).waitFor();
  await expect(tv.locator('.entry-text')).toHaveCount(1);
  expect(await tv.locator('.entry-text').textContent()).not.toBe(firstShown);
  await press(tv, 'Space');

  // Then all of them together for the vote.
  await tv.getByRole('heading', { name: 'Vote for the best' }).waitFor();
  await expect(tv.locator('.entry-text')).toHaveCount(2);
  await photoIsShowing(tv.locator('.tv-photo img'));
  await expect(alex.getByRole('radio')).toHaveCount(1);
  await expect(priya.getByRole('radio')).toHaveCount(2);
  await noAccessibilityProblems(tv);
  await noAccessibilityProblems(priya);

  await chooseAndLock(alex, 'Rush hour, as seen by the pigeons');
  await chooseAndLock(sam, 'A cat judging the platform');
  await chooseAndLock(priya, 'Rush hour, as seen by the pigeons');
  await press(tv, 's');
  await press(tv, 's');

  await tv.getByRole('heading', { name: 'The results' }).waitFor();
  await expect(tv.getByText('Top caption ·')).toBeVisible({ timeout: 10_000 });
  await expect(tv.locator('.entry.real')).toContainText('Rush hour, as seen by the pigeons');
  await expect(tv.locator('.entry.real')).toContainText('Sam · 2 votes');
  await expect(tv.locator('.pencil-ring')).toBeVisible();
  // Once the row has finished turning to paper, since colours are only final then.
  await tv.waitForTimeout(700);
  await noAccessibilityProblems(tv);

  await expect(sam.getByRole('heading', { name: 'Top caption, with 2 votes' })).toBeVisible({ timeout: 10_000 });
  await expect(sam.getByText('+900')).toBeVisible();
  await expect(alex.getByRole('heading', { name: 'Your caption got 1 vote' })).toBeVisible();
  await expect(priya.getByRole('heading', { name: 'No caption this time' })).toBeVisible();
  await noAccessibilityProblems(sam);

  // A rude winner can still be hidden from the TV. The points stand, as they do for any reveal.
  await tv.locator('.entry.real').click();
  await expect(tv.getByText('Rush hour, as seen by the pigeons')).toBeHidden();
  await expect(tv.getByRole('button', { name: /Hidden/ })).toBeDisabled();
  await expect(tv.locator('.entry.real')).toHaveCount(0);

  await press(tv, 'Space');
  await tv.getByText('After Caption this').waitFor();
  const first = tv.locator('.board-row').first();
  await expect(first).toContainText('Sam');
  await expect(first).toContainText('900');
});

test('the game carries on when a phone can\'t load the photo, then it appears', async ({ browser }) => {
  const { tv, room, image } = await startCaptionGame(browser);
  const context = await browser.newContext(PHONE);
  const phone = await context.newPage();
  failOnPageErrors(phone, { allowFailedRequests: true });
  let blocked = true;
  await phone.route(`**/media/${image}/**`, (route) => (blocked ? route.abort() : route.continue()));
  await phone.goto(`/j/${room}`);
  await joinAs(phone, 'Alex');
  await toWriting(tv);

  await expect(phone.getByText("Photo's on the TV")).toBeVisible();
  await write(phone, 'Still playing without the photo');

  blocked = false;
  await photoIsShowing(phone.locator('.photo-thumb img'));
  await expect(phone.getByText("Photo's on the TV")).toBeHidden();
  await context.close();
});

test('Send stays in one spot through every state, and the keyboard never hides it', async ({ browser }) => {
  const { tv, room } = await startCaptionGame(browser);
  const phones: Page[] = [];
  for (const [index, viewport] of SIZES.entries()) {
    const phone = await openPhone(browser, room, { ...PHONE, viewport });
    await joinAs(phone, `Guest ${index}`);
    phones.push(phone);
  }
  await toWriting(tv);

  for (const [index, phone] of phones.entries()) {
    const { width, height } = SIZES[index]!;
    const send = phone.getByRole('button', { name: 'Send' });
    await send.waitFor();
    const resting = await send.boundingBox();

    // An error message mustn't push the button anywhere.
    await send.click();
    await expect(phone.getByText('Write something first.')).toBeVisible();
    expect(await send.boundingBox()).toEqual(resting);

    // Imitates the keyboard taking up the bottom of the screen.
    for (const visible of [Math.round(height * 0.62), Math.round(height * 0.5), 300]) {
      await phone.setViewportSize({ width, height: visible });
      await expect(send).toBeInViewport({ ratio: 1 });
      await expect(phone.getByLabel('Your caption')).toBeInViewport({ ratio: 1 });
      const overflow = await phone.evaluate(() => {
        const root = document.documentElement;
        return root.scrollHeight - root.clientHeight;
      });
      expect(overflow).toBeLessThanOrEqual(0);
    }
    await phone.setViewportSize({ width, height });
    await expect(phone.locator('.photo-thumb')).toBeVisible();
    await expect(send).toBeInViewport({ ratio: 1 });
  }
});

test('long captions never get cut off on the TV, and every one gets its turn', async ({ browser }) => {
  test.setTimeout(90_000);
  const { tv, room } = await startCaptionGame(browser, { showSeconds: 30 });
  const phones: Page[] = [];
  for (const index of LONG_CAPTIONS.keys()) {
    const phone = await openPhone(browser, room);
    await joinAs(phone, `Guest ${index}`);
    phones.push(phone);
  }
  await toWriting(tv);
  await tv.locator('.names').waitFor();
  for (const [index, phone] of phones.entries()) await write(phone, LONG_CAPTIONS[index]!);
  // The longest caption, in Japanese, must fit on its own too.
  await skipThroughCaptions(tv);
  await tv.getByRole('heading', { name: 'Vote for the best' }).waitFor();
  await expect(tv.getByText(/Page 1 of [2-9]/)).toBeVisible();

  const insideList = () =>
    tv.evaluate(() => {
      const list = document.querySelector('.entries')!;
      return list.scrollHeight <= list.clientHeight + 1;
    });
  expect(await insideList()).toBe(true);

  const seen = new Set<string>();
  await expect
    .poll(
      async () => {
        for (const text of await tv.locator('.entry-text').allTextContents()) seen.add(text);
        expect(await insideList()).toBe(true);
        return seen.size;
      },
      { timeout: 30_000, intervals: [1000] },
    )
    .toBe(LONG_CAPTIONS.length);
});

/** Moves on with Space, checking that each caption fits on the screen by itself. */
async function skipThroughCaptions(tv: Page): Promise<void> {
  // Everyone has written, so this comes up by itself. S here would skip all of them.
  const count = tv.locator('.tv-show-count');
  await count.waitFor({ timeout: 15_000 });
  for (let shown = 1; shown <= LONG_CAPTIONS.length; shown += 1) {
    // Measures only once this caption is up, not the last one on its way out.
    await expect(count).toHaveText(`Caption ${shown} of ${LONG_CAPTIONS.length}`);
    const box = await tv.locator('.tv-show-text').boundingBox();
    expect(box!.y).toBeGreaterThan(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(1080);
    expect(box!.x + box!.width).toBeLessThanOrEqual(1920);
    await press(tv, 'Space');
  }
}

test('each caption stays up by itself, then moves on without the presenter', async ({ browser }) => {
  const { tv, room } = await startCaptionGame(browser, { showSeconds: 3 });
  const alex = await openPhone(browser, room);
  await joinAs(alex, 'Alex');
  const sam = await openPhone(browser, room);
  await joinAs(sam, 'Sam');
  await toWriting(tv);
  await write(alex, 'A cat judging the platform');
  await write(sam, 'Rush hour, as seen by the pigeons');
  // Everyone has written, so nobody needs to press anything from here on.
  await tv.getByRole('heading', { name: 'Caption 1 of 2' }).waitFor({ timeout: 15_000 });
  await tv.getByRole('heading', { name: 'Caption 2 of 2' }).waitFor({ timeout: 8000 });
  await tv.getByRole('heading', { name: 'Vote for the best' }).waitFor({ timeout: 8000 });
  await expect(alex.getByRole('radio')).toHaveCount(1);
});
