import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { closeEverything, joinAs, openPhone, PHONE, startGame } from './helpers.js';

const REAL = 'Sunlight filtering through the leaves of trees';

/** Long, and different enough from each other to pass the similarity check. */
const LONG_ANSWERS = [
  'The apple orchard behind your grandmother\'s house, remembered fondly during a long winter when nothing grows outside and everyone stays in',
  'A wooden bridge crossing shallow rivers, usually painted bright vermilion, which villagers repaint together every spring after heavy rainfall',
  'Lighting candles beside mountain shrines at midnight, hoping passing spirits notice before morning arrives and travellers wander home again',
  'Dragons guarding ancient harbours, according to fishermen telling stories over warm sake whenever storms keep their little boats tied ashore',
  'Railway engines whistling through tunnels near Nagano, startling sleepy monkeys soaking in volcanic hot springs throughout snowy afternoons',
  'Forest bathing without phones, breathing cedar-scented air slowly until office worries fade, then buying expensive souvenirs at gift shops',
  'Tiny raked gardens tended by retired monks, who sweep gravel into perfect circles only to watch curious cats ruin everything by lunchtime',
  'Harbour markets selling frozen tuna before dawn, where auctioneers shout incomprehensible prices at sleepy tourists clutching vending coffee',
];

test.afterEach(closeEverything);

async function toWriting(tv: Page): Promise<void> {
  await tv.keyboard.press('Space');
  await tv.getByRole('heading', { name: 'Define it' }).waitFor();
  await tv.waitForTimeout(550);
  await tv.keyboard.press('Space');
  await tv.getByRole('heading', { name: 'komorebi' }).waitFor();
  await tv.waitForTimeout(550);
}

async function write(phone: Page, text: string): Promise<void> {
  await phone.getByLabel('Your fake definition').fill(text);
  await phone.getByRole('button', { name: 'Send' }).click();
  await phone.getByText('Locked in').waitFor();
}

/** A tap is the vote: it sends straight away. */
async function chooseAndLock(phone: Page, text: string): Promise<void> {
  await phone.getByRole('radio', { name: text }).click();
  await phone.getByText('Locked in').waitFor();
}

async function skipTimer(tv: Page): Promise<void> {
  await tv.keyboard.press('s');
  await tv.waitForTimeout(100);
}

/** Goes past the answers being shown one at a time, if they get that far, to the vote. */
async function reachVoting(tv: Page): Promise<void> {
  const voting = tv.getByText('Which one is real?');
  const showing = tv.locator('.tv-show-text');
  await voting.or(showing).first().waitFor({ timeout: 12_000 });
  if (await showing.isVisible()) {
    // The TV ignores S just after the answers come up, so a double press can't skip them.
    await tv.waitForTimeout(550);
    await tv.keyboard.press('s');
  }
  await voting.waitFor();
}

async function expectNoAccessibilityProblems(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.html}`)).toEqual([]);
}

test('a TV and three phones play a whole game to the correct standings', async ({ browser }) => {
  test.setTimeout(120_000);
  const { tv, room } = await startGame(browser);
  const alex = await openPhone(browser, room);
  await joinAs(alex, 'Alex');
  const sam = await openPhone(browser, room);
  await joinAs(sam, 'Sam');
  const priya = await openPhone(browser, room);
  await joinAs(priya, 'Priya');

  await toWriting(tv);
  await expect(alex.getByRole('heading', { name: 'komorebi' })).toBeVisible();

  await write(alex, 'A quiet walk at dawn');
  await expect(tv.getByText('1 of 3 in')).toBeVisible();

  // The real answer and a copy both get the same message, and the text stays to edit.
  await sam.getByLabel('Your fake definition').fill('sunlight filtering through leaves');
  await sam.getByRole('button', { name: 'Send' }).click();
  await expect(sam.getByText('Too close to another answer. Try something different.')).toBeVisible();
  await expect(sam.getByLabel('Your fake definition')).toHaveValue('sunlight filtering through leaves');
  await expect(sam.getByLabel('Your fake definition')).toBeFocused();
  await sam.waitForTimeout(2100);
  await write(sam, 'The sound of rain on paper');

  await write(priya, 'A bowl of cold noodles');

  // Everyone's done, so the timer drops to its final seconds, then moves on by itself.
  await reachVoting(tv);
  await expect(tv.getByRole('button', { name: new RegExp(REAL) })).toBeVisible();

  // Nobody's own entry is on their ballot.
  await expect(alex.getByRole('radio', { name: 'A quiet walk at dawn' })).toHaveCount(0);
  await expect(alex.getByRole('radio')).toHaveCount(3);

  await chooseAndLock(alex, REAL);
  await chooseAndLock(sam, 'A quiet walk at dawn');
  await chooseAndLock(priya, 'A quiet walk at dawn');

  await expect(tv.getByRole('heading', { name: 'komorebi' })).toBeVisible();
  await expect(tv.getByText(/Real answer/)).toBeVisible({ timeout: 15_000 });
  await expect(alex.getByText('You found it and fooled 2 people')).toBeVisible({ timeout: 15_000 });
  await expect(alex.getByText('+2000')).toBeVisible();
  await expect(sam.getByText('Not this time')).toBeVisible();

  // Space moves on to the next word. Nobody writes, so both remaining words finish cleanly.
  await tv.keyboard.press('Space');
  await tv.getByRole('heading', { name: 'tsundoku' }).waitFor();
  await expect(alex.getByRole('heading', { name: 'tsundoku' })).toBeVisible();
  await tv.waitForTimeout(550);
  await skipTimer(tv);
  await expect(tv.getByText(/Real answer/)).toBeVisible();
  await tv.keyboard.press('Space');
  await tv.getByRole('heading', { name: 'kuidaore' }).waitFor();
  await tv.waitForTimeout(550);
  await skipTimer(tv);
  await expect(tv.getByText(/Real answer/)).toBeVisible();
  await tv.keyboard.press('Space');

  await tv.getByRole('heading', { name: 'Standings' }).waitFor();
  const rows = tv.locator('.board-row');
  await expect(rows.first()).toContainText('Alex');
  await expect(rows.first().locator('.board-score')).toHaveText('2000');
  await expect(alex.getByRole('heading', { name: '1st place' })).toBeVisible();
  await expect(sam.getByRole('heading', { name: '2nd place' })).toBeVisible();

  await tv.waitForTimeout(550);
  await tv.keyboard.press('Space');
  await tv.getByRole('heading', { name: 'Where was this?' }).waitFor();
  await tv.waitForTimeout(550);
  await tv.keyboard.press('Space');
  await tv.getByRole('heading', { name: 'Caption this' }).waitFor();
  await tv.waitForTimeout(550);
  await tv.keyboard.press('Space');
  await tv.getByRole('heading', { name: 'Final standings' }).waitFor();
  await expect(priya.getByRole('heading', { name: '2nd place' })).toBeVisible();
  // The night ends somewhere: back to the decks, with nothing left to advance.
  await expect(tv.getByRole('link', { name: 'Your decks' })).toHaveAttribute('href', '/admin');
  await expect(tv.getByRole('button', { name: /^Next/ })).toHaveCount(0);
});

test.describe('when time runs out', () => {
  async function twoPhonesWriting(browser: Parameters<typeof startGame>[0]) {
    const { tv, room } = await startGame(browser);
    const alex = await openPhone(browser, room);
    await joinAs(alex, 'Alex');
    const sam = await openPhone(browser, room);
    await joinAs(sam, 'Sam');
    await toWriting(tv);
    return { tv, alex, sam };
  }

  test('an answer typed but never sent still counts', async ({ browser }) => {
    const { tv, alex, sam } = await twoPhonesWriting(browser);
    await alex.getByLabel('Your fake definition').fill('Typed but never sent');
    await write(sam, 'The sound of rain on paper');
    await skipTimer(tv);
    await reachVoting(tv);
    await expect(tv.getByRole('button', { name: /Typed but never sent/ })).toBeVisible();
    // It's Alex's own, so it isn't on Alex's ballot.
    await expect(alex.getByRole('radio', { name: 'Typed but never sent' })).toHaveCount(0);
    await expect(sam.getByRole('radio', { name: 'Typed but never sent' })).toHaveCount(1);
  });

  test('an edit still being typed leaves the sent answer in place', async ({ browser }) => {
    const { tv, alex, sam } = await twoPhonesWriting(browser);
    await write(alex, 'The answer I meant to send');
    await alex.getByRole('button', { name: 'Edit answer' }).click();
    await alex.getByLabel('Your fake definition').fill('The answer I meant to s');
    await write(sam, 'The sound of rain on paper');
    await skipTimer(tv);
    await reachVoting(tv);
    await expect(tv.getByRole('button', { name: /The answer I meant to send/ })).toBeVisible();
  });

  test('an answer the check would refuse is not counted, and nothing breaks', async ({ browser }) => {
    const { tv, alex, sam } = await twoPhonesWriting(browser);
    await write(sam, 'The sound of rain on paper');
    await alex.getByLabel('Your fake definition').fill('the sound of rain on paper');
    await skipTimer(tv);
    await reachVoting(tv);
    await expect(alex.getByRole('radio')).toHaveCount(2);
  });

  test('a tapped answer counts as a vote, even without pressing Lock in', async ({ browser }) => {
    const { tv, alex, sam } = await twoPhonesWriting(browser);
    await write(alex, 'A quiet walk at dawn');
    await write(sam, 'The sound of rain on paper');
    await reachVoting(tv);
    await alex.getByRole('radio', { name: REAL }).click();
    await chooseAndLock(sam, 'A quiet walk at dawn');
    await skipTimer(tv);
    await expect(alex.getByText('You found it and fooled 1 person')).toBeVisible({ timeout: 20_000 });
    await expect(alex.getByText('+1500')).toBeVisible();
  });

  test('tapping another answer changes the vote, and the last tap counts', async ({ browser }) => {
    const { tv, alex, sam } = await twoPhonesWriting(browser);
    await write(alex, 'A quiet walk at dawn');
    await write(sam, 'The sound of rain on paper');
    await reachVoting(tv);
    await chooseAndLock(alex, 'The sound of rain on paper');
    await chooseAndLock(alex, REAL);
    await expect(alex.getByRole('radio', { name: REAL })).toBeChecked();
    await expect(alex.getByRole('radio', { name: 'The sound of rain on paper' })).not.toBeChecked();
    await skipTimer(tv);
    await expect(alex.getByText('You found the real one')).toBeVisible({ timeout: 20_000 });
  });
});

test.describe('long and awkward answers on a small phone', () => {
  const SMALL = { ...PHONE, viewport: { width: 320, height: 568 } };

  test('every option shows all of its text, and the list scrolls instead of squashing', async ({ browser }) => {
    test.setTimeout(60_000);
    const { tv, room } = await startGame(browser);
    const phones = [];
    for (const [index, text] of LONG_ANSWERS.entries()) {
      const phone = await openPhone(browser, room, SMALL);
      await joinAs(phone, `Guest ${index}`);
      phones.push({ phone, text });
    }
    await toWriting(tv);
    for (const { phone, text } of phones) await write(phone, text);
    await reachVoting(tv);

    const { phone } = phones[0]!;
    await phone.getByRole('radio').first().waitFor();
    const clipped = await phone.locator('.opt').evaluateAll((boxes) =>
      boxes
        .map((box) => {
          const text = box.querySelector('.opt-text')!.getBoundingClientRect();
          const outer = box.getBoundingClientRect();
          return text.top < outer.top || text.bottom > outer.bottom || text.right > outer.right;
        })
        .filter(Boolean).length,
    );
    expect(clipped).toBe(0);
    // The list itself scrolls, with the status line under it still on screen.
    const list = await phone.locator('.vote-list').evaluate((node) => node.scrollHeight > node.clientHeight);
    expect(list).toBe(true);
    await expect(phone.locator('.round-pad > .status')).toBeInViewport();
  });

  test('text with no spaces wraps instead of running off the box', async ({ browser }) => {
    const { tv, room } = await startGame(browser);
    const alex = await openPhone(browser, room, SMALL);
    await joinAs(alex, 'Alex');
    const sam = await openPhone(browser, room, SMALL);
    await joinAs(sam, 'Sam');
    await toWriting(tv);
    await write(alex, 'W'.repeat(140));
    await write(sam, 'fine');
    await reachVoting(tv);
    const box = await sam.getByRole('radio', { name: /WWWW/ }).boundingBox();
    const text = await sam.locator('.opt-text', { hasText: 'WWWW' }).boundingBox();
    expect(text!.x + text!.width).toBeLessThanOrEqual(box!.x + box!.width);
    const overflow = await sam.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('lines from a pasted answer stay separate words', async ({ browser }) => {
    const { tv, room } = await startGame(browser);
    const alex = await openPhone(browser, room);
    await joinAs(alex, 'Alex');
    await toWriting(tv);
    await write(alex, 'Pasted\nacross\nlines');
    await reachVoting(tv);
    await expect(tv.getByRole('button', { name: /Pasted across lines/ })).toBeVisible();
  });
});

test('a reveal with many answers gets to the real one quickly', async ({ browser }) => {
  test.setTimeout(60_000);
  const { tv, room } = await startGame(browser);
  const phones = [];
  for (const [index, text] of LONG_ANSWERS.entries()) {
    const phone = await openPhone(browser, room);
    await joinAs(phone, `Guest ${index}`);
    phones.push({ phone, text });
  }
  await toWriting(tv);
  for (const { phone, text } of phones) await write(phone, text);
  await reachVoting(tv);
  await tv.waitForTimeout(600);
  await skipTimer(tv);
  await tv.waitForTimeout(100);
  await skipTimer(tv);
  await tv.locator('.entry-row').first().waitFor();
  const started = Date.now();
  // Eight answers nobody voted for, and the real one.
  await tv.getByText(/Real answer/).waitFor({ timeout: 15_000 });
  expect(Date.now() - started).toBeLessThan(9000);
});

test('refreshing a phone mid-vote returns to the same ballot and vote', async ({ browser }) => {
  test.setTimeout(60_000);
  const { tv, room } = await startGame(browser);
  const alex = await openPhone(browser, room);
  await joinAs(alex, 'Alex');
  const sam = await openPhone(browser, room);
  await joinAs(sam, 'Sam');
  await toWriting(tv);
  await write(alex, 'A quiet walk at dawn');
  await skipTimer(tv);
  await reachVoting(tv);
  await sam.getByRole('radio').first().waitFor();
  const order = await sam.getByRole('radio').allTextContents();
  await chooseAndLock(sam, REAL);

  await sam.reload();
  await expect(sam.getByText('Locked in')).toBeVisible();
  expect(await sam.getByRole('radio').allTextContents()).toEqual(order);
  await expect(sam.getByRole('radio', { name: REAL })).toBeChecked();
});

test('typed text survives a refresh, and an answer can be edited until time runs out', async ({ browser }) => {
  const { tv, room } = await startGame(browser);
  const alex = await openPhone(browser, room);
  await joinAs(alex, 'Alex');
  await toWriting(tv);

  await alex.getByLabel('Your fake definition').fill('Half a thought');
  await alex.reload();
  await expect(alex.getByLabel('Your fake definition')).toHaveValue('Half a thought');

  await write(alex, 'A quiet walk at dawn');
  await tv.keyboard.press('+');
  await alex.getByRole('button', { name: 'Edit answer' }).click();
  await expect(alex.getByLabel('Your fake definition')).toBeFocused();
  await expect(alex.getByText('Locked in')).toHaveCount(0);
  await write(alex, 'A quiet walk at dusk');
  await expect(alex.getByLabel('Your fake definition')).toHaveValue('A quiet walk at dusk');
});

test('the keyboard Return key sends, and holding it sends once', async ({ browser }) => {
  const { tv, room } = await startGame(browser);
  const alex = await openPhone(browser, room);
  await joinAs(alex, 'Alex');
  await toWriting(tv);
  await alex.getByLabel('Your fake definition').fill('A quiet walk at dawn');
  await alex.getByLabel('Your fake definition').press('Enter');
  await expect(alex.getByText('Locked in')).toBeVisible();
  await expect(tv.getByText('1 of 1 in')).toBeVisible();
});

test('a double tap on Send and on an answer each count once', async ({ browser }) => {
  test.setTimeout(60_000);
  const { tv, room } = await startGame(browser);
  const alex = await openPhone(browser, room);
  await joinAs(alex, 'Alex');
  const sam = await openPhone(browser, room);
  await joinAs(sam, 'Sam');
  await toWriting(tv);

  await alex.getByLabel('Your fake definition').fill('A quiet walk at dawn');
  await alex.getByRole('button', { name: 'Send' }).dblclick();
  await expect(alex.getByText('Locked in')).toBeVisible();
  // A second tap landing on Edit answer is the worst it can do, and the answer is safe either way.
  await tv.waitForTimeout(200);
  await expect(tv.getByText('1 of 2 in')).toBeVisible();

  await skipTimer(tv);
  await reachVoting(tv);
  await sam.getByRole('radio', { name: REAL }).dblclick();
  await expect(sam.getByText('Locked in')).toBeVisible();
  await expect(tv.getByText(/1 of 2 voted/)).toBeVisible();
});

test('buttons stay put through every state of a screen', async ({ browser }) => {
  test.setTimeout(60_000);
  const { tv, room } = await startGame(browser);
  const alex = await openPhone(browser, room);
  await joinAs(alex, 'Alex');
  const sam = await openPhone(browser, room);
  await joinAs(sam, 'Sam');
  await toWriting(tv);

  const button = alex.locator('.act');
  const start = await button.boundingBox();
  const expectUnmoved = async () => expect(await button.boundingBox()).toEqual(start);

  await alex.getByLabel('Your fake definition').fill(REAL);
  await expectUnmoved();
  await alex.getByRole('button', { name: 'Send' }).click();
  await alex.getByText('Too close to another answer').waitFor();
  await expectUnmoved();
  await alex.waitForTimeout(2100);
  await alex.getByLabel('Your fake definition').fill('x'.repeat(130));
  await expect(alex.getByText('130/140')).toBeVisible();
  await expectUnmoved();
  await alex.getByLabel('Your fake definition').fill('A quiet walk at dawn');
  await alex.getByRole('button', { name: 'Send' }).click();
  await alex.getByText('Locked in').waitFor();
  await expectUnmoved();
  await alex.getByRole('button', { name: 'Edit answer' }).click();
  await expectUnmoved();

  await skipTimer(tv);
  await reachVoting(tv);
  await sam.getByRole('radio').first().waitFor();
  // Voting has no button: the answers and the line under them stay put as a tap sends.
  const voteStatus = sam.locator('.round-pad > .status');
  const voteStart = await voteStatus.boundingBox();
  const firstAnswer = await sam.getByRole('radio').first().boundingBox();
  await chooseAndLock(sam, REAL);
  expect(await voteStatus.boundingBox()).toEqual(voteStart);
  expect(await sam.getByRole('radio').first().boundingBox()).toEqual(firstAnswer);
});

for (const size of [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
]) {
  test(`writing fits at ${size.width}×${size.height}, with and without the keyboard`, async ({ browser }) => {
    const { tv, room } = await startGame(browser);
    const phone = await openPhone(browser, room, { ...PHONE, viewport: size });
    await joinAs(phone, 'Alex');
    await toWriting(tv);
    await phone.getByLabel('Your fake definition').waitFor();

    const inView = async (visibleHeight: number) => {
      for (const locator of [
        phone.locator('.strip-digits'),
        phone.getByRole('heading', { name: 'komorebi' }),
        phone.getByLabel('Your fake definition'),
        phone.getByRole('button', { name: 'Send' }),
      ]) {
        const box = await locator.boundingBox();
        expect(box, 'should be on screen').not.toBeNull();
        expect(box!.y).toBeGreaterThanOrEqual(0);
        expect(box!.y + box!.height).toBeLessThanOrEqual(visibleHeight);
        expect(box!.x + box!.width).toBeLessThanOrEqual(size.width);
      }
    };
    await inView(size.height);

    const before = await phone.getByRole('button', { name: 'Send' }).boundingBox();
    const keyboardHeight = size.height < 700 ? 260 : 340;
    await phone.setViewportSize({ width: size.width, height: size.height - keyboardHeight });
    // The page resizes from a resize event, which can land late when the machine is busy.
    await expect(() => inView(size.height - keyboardHeight)).toPass({ timeout: 5_000 });
    if (size.height >= 800) {
      // On normal phones the keyboard opens below everything, so Send doesn't move at all.
      expect(await phone.getByRole('button', { name: 'Send' }).boundingBox()).toEqual(before);
    }
  });
}

test('a long ballot scrolls by itself, with the button pinned below it', async ({ browser }) => {
  test.setTimeout(60_000);
  const { tv, room } = await startGame(browser);
  const phones: Page[] = [];
  const words = ['apple', 'bridge', 'candle', 'dragon', 'engine', 'forest'];
  for (const word of words) {
    const phone = await openPhone(browser, room, { ...PHONE, viewport: { width: 320, height: 568 } });
    await joinAs(phone, word);
    phones.push(phone);
  }
  await toWriting(tv);
  for (const [index, phone] of phones.entries()) await write(phone, LONG_ANSWERS[index]!);
  await tv.waitForTimeout(100);
  await skipTimer(tv);
  await reachVoting(tv);
  const phone = phones[0]!;
  await phone.getByRole('radio').first().waitFor();
  const status = await phone.locator('.round-pad > .status').boundingBox();
  expect(status!.y + status!.height).toBeLessThanOrEqual(568);
  const canScroll = await phone
    .locator('.vote-list')
    .evaluate((element) => element.scrollHeight > element.clientHeight);
  expect(canScroll).toBe(true);
  expect(await phone.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(568);
});

test('TV and a phone with a wrong clock count down together', async ({ browser }) => {
  const { tv, room } = await startGame(browser);
  const context = await browser.newContext(PHONE);
  // This phone's clock is an hour fast.
  await context.addInitScript(() => {
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + 60 * 60 * 1000;
  });
  const phone = await context.newPage();
  await phone.goto(`/j/${room}`);
  await joinAs(phone, 'Alex');
  await toWriting(tv);
  await phone.waitForTimeout(800);

  const seconds = (text: string | null) => {
    const [minutes, rest] = (text ?? '').split(':');
    return Number(minutes) * 60 + Number(rest);
  };
  const onPhone = seconds(await phone.locator('.strip-digits').textContent());
  const onTv = seconds(await tv.locator('.tv-clock').textContent());
  expect(onPhone).toBeGreaterThan(40);
  expect(Math.abs(onPhone - onTv)).toBeLessThanOrEqual(1);
  await context.close();
});

test('P pauses on the TV and phones, and + adds time', async ({ browser }) => {
  const { tv, room } = await startGame(browser);
  const phone = await openPhone(browser, room);
  await joinAs(phone, 'Alex');
  await toWriting(tv);

  await tv.keyboard.press('p');
  await expect(phone.getByText('Paused')).toBeVisible();
  await expect(tv.getByText(/· Paused/)).toBeVisible();
  const held = await tv.locator('.tv-clock').textContent();
  await tv.waitForTimeout(1500);
  expect(await tv.locator('.tv-clock').textContent()).toBe(held);

  await tv.keyboard.press('+');
  await tv.waitForTimeout(150);
  const seconds = (text: string | null) => {
    const [minutes, rest] = (text ?? '').split(':');
    return Number(minutes) * 60 + Number(rest);
  };
  expect(seconds(await tv.locator('.tv-clock').textContent())).toBe(seconds(held) + 15);

  await tv.keyboard.press('p');
  await expect(phone.getByText('Paused')).toHaveCount(0);
});

test('a dropout mid-send retries and arrives, with no second tap', async ({ browser }) => {
  test.setTimeout(60_000);
  const { tv, room } = await startGame(browser);
  const phone = await openPhone(browser, room);
  await joinAs(phone, 'Alex');
  await toWriting(tv);
  await phone.getByLabel('Your fake definition').fill('A quiet walk at dawn');
  await phone.context().setOffline(true);
  await expect(phone.getByText('Reconnecting…')).toBeVisible({ timeout: 25_000 });
  await phone.getByRole('button', { name: 'Send' }).click();
  await expect(phone.getByRole('button', { name: /Sending/ })).toBeVisible();
  await expect(tv.getByText('0 of 1 in')).toBeVisible();
  await phone.context().setOffline(false);
  await expect(phone.getByText('Locked in')).toBeVisible({ timeout: 25_000 });
  await expect(tv.getByText('1 of 1 in')).toBeVisible();
});

test('clicking an answer on the TV hides it, and voters get to choose again', async ({ browser }) => {
  test.setTimeout(60_000);
  const { tv, room } = await startGame(browser);
  const alex = await openPhone(browser, room);
  await joinAs(alex, 'Alex');
  const sam = await openPhone(browser, room);
  await joinAs(sam, 'Sam');
  await toWriting(tv);
  await write(alex, 'Something rude');
  await skipTimer(tv);
  await reachVoting(tv);
  await chooseAndLock(sam, 'Something rude');

  await tv.getByRole('button', { name: /Something rude/ }).click();
  await expect(tv.getByText('Something rude')).toHaveCount(0);
  await expect(sam.getByText('That answer was removed. Pick another.')).toBeVisible();
  await expect(sam.getByRole('radio', { checked: true })).toHaveCount(0);
  await expect(sam.getByRole('radio', { name: 'Something rude' })).toHaveCount(0);
});

test('a hidden real answer is refused, so it stays on the ballot', async ({ browser }) => {
  test.setTimeout(60_000);
  const { tv, room } = await startGame(browser);
  const alex = await openPhone(browser, room);
  await joinAs(alex, 'Alex');
  await toWriting(tv);
  await write(alex, 'A quiet walk at dawn');
  await skipTimer(tv);
  await reachVoting(tv);
  await tv.getByRole('button', { name: new RegExp(REAL) }).click();
  await tv.waitForTimeout(150);
  await expect(tv.getByRole('button', { name: new RegExp(REAL) })).toBeVisible();
});

test('long answers fit on the TV at 1080p and 720p', async ({ browser }) => {
  test.setTimeout(90_000);
  const { tv, room } = await startGame(browser);
  const words = ['apple', 'bridge', 'candle', 'dragon', 'engine', 'forest', 'garden', 'harbor'];
  const phones: Page[] = [];
  for (const word of words) {
    const phone = await openPhone(browser, room);
    await joinAs(phone, word);
    phones.push(phone);
  }
  await toWriting(tv);
  for (const [index, phone] of phones.entries()) await write(phone, LONG_ANSWERS[index]!);
  await skipTimer(tv);
  await reachVoting(tv);

  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1280, height: 720 },
  ]) {
    await tv.setViewportSize(viewport);
    await tv.waitForTimeout(100);
    const overflow = await tv.evaluate(() => {
      const list = document.querySelector('.entries')!;
      return { scroll: list.scrollHeight, client: list.clientHeight, entries: list.children.length };
    });
    expect(overflow.entries).toBe(8);
    expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
  }
});

test.describe('accessibility', () => {
  test('every round screen, on the TV and a phone', async ({ browser }) => {
    test.setTimeout(90_000);
    const { tv, room } = await startGame(browser);
    const alex = await openPhone(browser, room);
    await joinAs(alex, 'Alex');
    const sam = await openPhone(browser, room);
    await joinAs(sam, 'Sam');
    await toWriting(tv);
    await tv.waitForTimeout(350);
    await expectNoAccessibilityProblems(tv);
    await expectNoAccessibilityProblems(alex);

    await write(alex, 'A quiet walk at dawn');
    await expectNoAccessibilityProblems(alex);

    await sam.getByLabel('Your fake definition').fill(REAL);
    await sam.getByRole('button', { name: 'Send' }).click();
    await sam.getByText('Too close').waitFor();
    await expectNoAccessibilityProblems(sam);

    await skipTimer(tv);
    await reachVoting(tv);
    await tv.waitForTimeout(350);
    await expectNoAccessibilityProblems(tv);
    await sam.getByRole('radio').first().waitFor();
    await expectNoAccessibilityProblems(sam);
    await chooseAndLock(sam, 'A quiet walk at dawn');
    await expectNoAccessibilityProblems(sam);

    await skipTimer(tv);
    await tv.getByText(/Real answer/).waitFor({ timeout: 15_000 });
    await tv.waitForTimeout(1000);
    await expectNoAccessibilityProblems(tv);
    await expect(alex.getByText('You fooled 1 person')).toBeVisible({ timeout: 15_000 });
    await expectNoAccessibilityProblems(alex);

    await tv.keyboard.press('Space');
    await tv.getByRole('heading', { name: 'tsundoku' }).waitFor();
    await tv.waitForTimeout(550);
    await skipTimer(tv);
    await expect(tv.getByText(/Real answer/)).toBeVisible();
    await tv.keyboard.press('Space');
    await tv.getByRole('heading', { name: 'kuidaore' }).waitFor();
    await tv.waitForTimeout(550);
    await skipTimer(tv);
    await expect(tv.getByText(/Real answer/)).toBeVisible();
    await tv.keyboard.press('Space');
    await tv.getByRole('heading', { name: 'Standings' }).waitFor();
    await tv.waitForTimeout(1500);
    await expectNoAccessibilityProblems(tv);
    await alex.getByRole('heading', { name: '1st place' }).waitFor();
    await expectNoAccessibilityProblems(alex);
  });
});

test('the sun bar runs across the top of the TV and moves', async ({ browser }) => {
  const { tv, room } = await startGame(browser);
  const phone = await openPhone(browser, room);
  await joinAs(phone, 'Alex');
  await toWriting(tv);

  const bar = await tv.locator('.tv-sunbar').boundingBox();
  expect(bar).toMatchObject({ x: 0, y: 0, width: 1920, height: 12 });
  const sun = await tv.locator('.tv-sunbar .sunbar-sun').boundingBox();
  expect(sun!.width).toBeCloseTo(18, 1);

  const coverLeft = () => tv.locator('.tv-sunbar .sunbar-cover').evaluate((node) => node.getBoundingClientRect().left);
  const before = await coverLeft();
  await tv.waitForTimeout(1200);
  expect(await coverLeft()).toBeGreaterThan(before);
  const painted = await tv
    .locator('.tv-sunbar')
    .evaluate((node) => getComputedStyle(node).backgroundImage);
  expect(painted).toContain('linear-gradient');
});

test('the TV shows each definition by itself, real one included, then all of them', async ({ browser }) => {
  // A long time on each, so this test sets the pace however slow the machine is.
  const { tv, room } = await startGame(browser, [
    { type: 'define', settings: { showSeconds: 30 }, items: [{ word: 'komorebi', definition: REAL }] },
  ]);
  const alex = await openPhone(browser, room);
  await joinAs(alex, 'Alex');
  const sam = await openPhone(browser, room);
  await joinAs(sam, 'Sam');
  await toWriting(tv);
  await write(alex, 'A quiet walk at dawn');
  await write(sam, 'The sound of rain on paper');

  // Everyone's done, so the first S moves on at once. A doubled one must not skip the answers.
  await tv.keyboard.press('s');
  await tv.keyboard.press('s');
  await expect(tv.getByText('Definition 1 of 3')).toBeVisible({ timeout: 8000 });
  await tv.waitForTimeout(300);
  await expect(tv.getByText('Definition 1 of 3')).toBeVisible();
  await expect(tv.getByRole('heading', { name: 'komorebi' })).toBeVisible();
  await expect(alex.getByRole('heading', { name: 'Look up at the TV' })).toBeVisible();
  await expect(alex.getByText('Definition 1 of 3.')).toBeVisible();
  await expect(alex.getByRole('radio')).toHaveCount(0);
  await tv.waitForTimeout(350);
  await expectNoAccessibilityProblems(tv);
  await expectNoAccessibilityProblems(alex);

  const seen: string[] = [];
  for (const position of [1, 2, 3]) {
    await expect(tv.getByText(`Definition ${position} of 3`)).toBeVisible();
    await expect(tv.locator('.entry-text')).toHaveCount(1);
    seen.push((await tv.locator('.entry-text').textContent())!);
    await tv.waitForTimeout(550);
    await tv.keyboard.press('Space');
  }
  expect(seen.sort()).toEqual(['A quiet walk at dawn', REAL, 'The sound of rain on paper'].sort());

  await tv.getByText('Which one is real?').waitFor();
  await expect(tv.locator('.entry-text')).toHaveCount(3);
  await expect(alex.getByRole('radio')).toHaveCount(2);
});
