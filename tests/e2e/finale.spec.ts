import { randomBytes } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { io, type Socket } from 'socket.io-client';
import {
  closeEverything,
  expectNoAccessibilityProblems,
  KYOTO,
  mapPhone,
  press,
  startMapGame,
  tapJapan,
  toGuessing,
} from './helpers.js';

test.afterEach(closeEverything);

const TOKYO = { lat: 35.6812, lng: 139.7671 };

/**
 * One map round is the quickest way to give everyone a different score. Each test can hear what
 * the TV played, without speakers.
 */
function startFinaleGame(browser: Browser) {
  return startMapGame(browser, {}, async (context) => {
    await context.addInitScript(() => {
      const heard: string[] = [];
      (window as unknown as { heard: string[] }).heard = heard;
      window.addEventListener('tp:sound', (event) => heard.push((event as CustomEvent<string>).detail));
    });
  });
}

interface Bot {
  socket: Socket;
  /** Pins part of the way from Kyoto to Tokyo, so further along scores less and the same distance ties. */
  pin: (along: number) => Promise<void>;
}

const sockets: Socket[] = [];
test.afterEach(() => sockets.splice(0).forEach((socket) => socket.close()));

async function bot(baseURL: string, room: string, name: string): Promise<Bot> {
  const socket = io(baseURL, { auth: { room, role: 'guest' }, transports: ['websocket'], forceNew: true });
  sockets.push(socket);
  let view: { screenId: number; screen: { kind: string } } | null = null;
  socket.on('view', (next) => (view = next));
  const reply = await socket.timeout(10_000).emitWithAck('guest:join', { token: randomBytes(32).toString('base64url'), name });
  if (!reply.ok) throw new Error(`${name} could not join: ${reply.code}`);
  view = reply.view;
  let seq = 0;
  return {
    socket,
    pin: async (along) => {
      await expect.poll(() => view?.screen.kind).toBe('guess');
      seq += 1;
      const result = await socket.timeout(5000).emitWithAck('guest:pin', {
        screenId: view!.screenId,
        seq,
        lat: KYOTO.lat + (TOKYO.lat - KYOTO.lat) * along,
        lng: KYOTO.lng + (TOKYO.lng - KYOTO.lng) * along,
      });
      if (!result.ok) throw new Error(`${name}'s pin was refused: ${result.code}`);
    },
  };
}

/** Ends the guess, passes the map reveal and the standings, and stops on the first moment of the podium. */
async function toPodium(tv: Page): Promise<void> {
  await press(tv, 's');
  await press(tv, 's');
  await tv.locator('.tv-map').waitFor();
  // The first press shows the whole reveal, the second moves on.
  await press(tv, 'Space');
  await press(tv, 'Space');
  await tv.getByRole('heading', { name: 'Standings' }).waitFor();
  await press(tv, 'Space');
  await tv.getByRole('heading', { name: 'Final standings' }).waitFor();
}

/** Records, in the TV's own clock, when each podium place lands. */
async function watchLandings(tv: Page): Promise<void> {
  await tv.evaluate(() => {
    const landed: Record<string, number> = {};
    (window as unknown as { landed: Record<string, number> }).landed = landed;
    const check = () => {
      for (const slot of document.querySelectorAll('.podium-slot')) {
        const place = [...slot.classList].find((name) => name.startsWith('place-'))!;
        if (!slot.classList.contains('waiting') && !(place in landed)) landed[place] = Date.now();
      }
      const list = document.querySelector('.final-list .board-row:not(.waiting)');
      if (list && !('list' in landed)) landed.list = Date.now();
    };
    check();
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, attributes: true });
  });
}

/** The TV never scrolls, and everything matching sits fully on screen, at 1080p and 720p. */
async function expectFitsAtBothSizes(tv: Page, selector: string): Promise<void> {
  for (const size of [
    { width: 1280, height: 720 },
    { width: 1920, height: 1080 },
  ]) {
    await tv.setViewportSize(size);
    await tv.waitForTimeout(200);
    const layout = await tv.evaluate((matching) => {
      const elements = [...document.querySelectorAll(matching)];
      return {
        found: elements.length > 0,
        scrolls: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth,
        outside: elements
          .filter((element) => {
            const box = element.getBoundingClientRect();
            return box.left < 0 || box.right > innerWidth + 0.5 || box.top < 0 || box.bottom > innerHeight + 0.5;
          })
          .map((element) => element.textContent),
      };
    }, selector);
    expect(layout, `${selector} at ${size.width}×${size.height}`).toEqual({ found: true, scrolls: false, outside: [] });
  }
}

const landed = (tv: Page) => tv.evaluate(() => (window as unknown as { landed: Record<string, number> }).landed);

test.describe('the final podium', () => {
  test('lands 3rd, 2nd, then 1st, and each phone waits for its own place', async ({ browser, baseURL }) => {
    test.setTimeout(60_000);
    const { tv, room } = await startFinaleGame(browser);
    const alex = await mapPhone(browser, room, 'Alex');
    const bots = await Promise.all(['Bea', 'Cy', 'Di', 'Ed', 'Flo'].map((name) => bot(baseURL!, room, name)));
    await toGuessing(tv);
    // Bea is spot on, Alex is somewhere in Japan, and nobody else pins, so they tie for 3rd.
    await bots[0]!.pin(0);
    await tapJapan(alex);
    await alex.getByRole('button', { name: 'Lock in pin' }).click();
    await alex.getByText('Locked in').waitFor();
    await toPodium(tv);
    await watchLandings(tv);

    // Nothing has landed yet: empty plinths, and the phone holds back.
    await expect(tv.locator('.podium-slot.waiting')).toHaveCount(3);
    await expect(tv.getByText('Bea')).toHaveCount(0);
    await expect(alex.getByText('Your place appears here once it')).toBeVisible();

    // 3rd is up on the TV, and Alex's phone still holds back their 2nd place.
    await expect(tv.locator('.place-3')).not.toHaveClass(/waiting/, { timeout: 15_000 });
    await expect(tv.locator('.place-2')).toHaveClass(/waiting/);
    await expect(alex.locator('.medal-2')).toHaveCount(0);
    await expect(alex.getByText('Your place appears here once it')).toBeVisible();

    // The medal, rather than the heading, since the standings before also said "2nd place".
    await expect(alex.locator('.medal-2')).toBeVisible({ timeout: 15_000 });
    await expect(alex.getByRole('heading', { name: '2nd place' })).toBeVisible();
    await expect(tv.locator('.place-2')).not.toHaveClass(/waiting/);
    await expect(tv.locator('.place-1.waiting')).toHaveCount(1);

    await expect(tv.getByText('Winner')).toBeVisible({ timeout: 15_000 });
    await expect(tv.locator('.place-1 .podium-score')).toHaveText(/1000/);
    // One burst of confetti over 1st, then it's gone.
    await expect(tv.locator('canvas.confetti')).toBeAttached();
    await expect(tv.locator('canvas.confetti')).toHaveCount(0, { timeout: 6000 });

    const times = await landed(tv);
    expect(times['place-3']).toBeLessThan(times['place-2']!);
    expect(times['place-2']).toBeLessThan(times['place-1']!);
    // A longer wait before 1st. Generous, since a busy test machine can draw late.
    expect(times['place-1']! - times['place-2']!).toBeGreaterThan(2000);

    // Four people tied for 3rd share one card, so the TV stays tidy. They joined at once, so in any order.
    const tied = await tv.locator('.place-3 .podium-names li:not(.podium-more)').allTextContents();
    expect(tied).toHaveLength(3);
    for (const name of tied) expect(['Cy', 'Di', 'Ed', 'Flo']).toContain(name);
    await expect(tv.locator('.place-3')).toContainText('and 1 more');

    await expectNoAccessibilityProblems(tv);
    await expectNoAccessibilityProblems(alex);
  });

  test('Space shows the whole podium at once, and a refreshed TV shows it settled', async ({ browser, baseURL }) => {
    const { tv, room } = await startFinaleGame(browser);
    const bots = await Promise.all(['Bea', 'Cy', 'Di', 'Ed', 'Flo'].map((name) => bot(baseURL!, room, name)));
    await toGuessing(tv);
    await Promise.all(bots.map((each, index) => each.pin(index * 0.1)));
    await toPodium(tv);
    await tv.mouse.move(400, 400);
    await expect(tv.getByRole('button', { name: /Show everyone/ })).toBeVisible();
    await press(tv, 'Space');
    await expect(tv.locator('.podium-slot.waiting')).toHaveCount(0, { timeout: 2000 });
    await expect(tv.locator('.final-list .board-row.waiting')).toHaveCount(0);
    await expect(tv.getByRole('button', { name: /Show everyone/ })).toHaveCount(0);
    // A skip doesn't slam every card at once.
    await expect(tv.locator('.podium-slot.landing')).toHaveCount(0);

    await tv.reload();
    await tv.getByRole('heading', { name: 'Final standings' }).waitFor();
    await expect(tv.locator('.podium-slot.settled')).toHaveCount(3);
    await expect(tv.locator('canvas.confetti')).toHaveCount(0);
    await expect(tv.locator('.final-list .board-row')).toHaveCount(2);
  });

  test('a full room with ties and the longest names fits at 1080p and 720p', async ({ browser, baseURL }) => {
    test.setTimeout(90_000);
    const { tv, room } = await startFinaleGame(browser);
    const plans: [string, number | null][] = [
      ['Wwwwwwwwwwwwwwww', 0],
      ['Mmmmmmmmmmmmmmmm', 0],
      ['WWWWWWWWWWWWWWW1', 0.12],
      ['WWWWWWWWWWWWWWW2', 0.12],
      ['WWWWWWWWWWWWWWW3', 0.12],
      ['WWWWWWWWWWWWWWW4', 0.12],
      ...Array.from({ length: 44 }, (_, index): [string, number | null] => [
        `Wwwwwwwwwwwwww${String(index).padStart(2, '0')}`,
        index % 6 === 0 ? null : 0.2 + index * 0.015,
      ]),
    ];
    const bots = await Promise.all(plans.map(([name]) => bot(baseURL!, room, name)));
    await expect(tv.getByText('50 of 50 joined')).toBeAttached();
    await toGuessing(tv);
    await Promise.all(bots.map((each, index) => (plans[index]![1] === null ? undefined : each.pin(plans[index]![1]!))));
    // Everyone's names beside the photo while they pin.
    await expectFitsAtBothSizes(tv, '.tv-progress li');

    await press(tv, 's');
    await press(tv, 's');
    await tv.locator('.tv-map').waitFor();
    await press(tv, 'Space');
    await press(tv, 'Space');
    await tv.getByRole('heading', { name: 'Standings' }).waitFor();
    await expectFitsAtBothSizes(tv, '.board-row, .board-more');
    await press(tv, 'Space');
    await tv.getByRole('heading', { name: 'Final standings' }).waitFor();
    await press(tv, 'Space');
    await expect(tv.locator('.podium-slot.waiting')).toHaveCount(0);
    await expect(tv.locator('.place-1 .podium-names li')).toHaveCount(2);
    await expect(tv.locator('.place-3')).toContainText('and 1 more');
    await expect(tv.locator('.place-2')).toHaveCount(0);

    for (const size of [
      { width: 1920, height: 1080 },
      { width: 1280, height: 720 },
    ]) {
      await tv.setViewportSize(size);
      await tv.waitForTimeout(200);
      const layout = await tv.evaluate(() => {
        const inside = (element: Element) => {
          const box = element.getBoundingClientRect();
          return box.left >= 0 && box.right <= innerWidth + 0.5 && box.top >= 0 && box.bottom <= innerHeight + 0.5;
        };
        return {
          scrolls: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth,
          cardsInside: [...document.querySelectorAll('.podium-card')].every(inside),
          // Nothing in a card is cut off.
          cardsFit: [...document.querySelectorAll('.podium-card')].every((card) => card.scrollHeight <= card.clientHeight + 1),
          rowsInside: [...document.querySelectorAll('.final-list .board-row, .board-more')].every(inside),
          rows: document.querySelectorAll('.final-list .board-row').length,
        };
      });
      expect(layout).toEqual({ scrolls: false, cardsInside: true, cardsFit: true, rowsInside: true, rows: 7 });
    }
  });
});

test.describe('sound on the TV', () => {
  test('chimes for each game, hits the podium once after a skip, and M mutes until unmuted', async ({ browser, baseURL }) => {
    const { tv, room } = await startFinaleGame(browser);
    const bots = await Promise.all(['Bea', 'Cy', 'Di'].map((name) => bot(baseURL!, room, name)));
    const heard = () => tv.evaluate(() => [...(window as unknown as { heard: string[] }).heard]);

    await press(tv, 'Space');
    await tv.getByRole('heading', { name: 'Where was this?' }).waitFor();
    // Test browsers allow sound before any key press, so the lobby may also have blipped as guests joined.
    await expect.poll(async () => (await heard()).filter((cue) => cue !== 'join')).toEqual(['chime']);

    // Muted, and still muted after a refresh.
    await press(tv, 'm');
    await tv.reload();
    await tv.getByRole('heading', { name: 'Where was this?' }).waitFor();
    await expect(tv.getByRole('button', { name: /Unmute/ })).toHaveAttribute('aria-pressed', 'true');
    await press(tv, 'Space');
    await tv.getByText('Drop a pin on your phone.').waitFor();
    await Promise.all(bots.map((each, index) => each.pin(index * 0.1)));
    await press(tv, 's');
    await press(tv, 's');
    await tv.locator('.tv-map').waitFor();
    await press(tv, 'Space');
    await tv.waitForTimeout(300);
    expect(await heard()).toEqual([]);

    await press(tv, 'm');
    await expect(tv.getByRole('button', { name: /^Mute/ })).toHaveAttribute('aria-pressed', 'false');
    await press(tv, 'Space');
    await tv.getByRole('heading', { name: 'Standings' }).waitFor();
    await press(tv, 'Space');
    await tv.getByRole('heading', { name: 'Final standings' }).waitFor();
    await press(tv, 'Space');
    await expect(tv.locator('.podium-slot.waiting')).toHaveCount(0);
    // Everything still to come landed at once, so only 1st's fanfare plays, and only once.
    await expect.poll(heard).toContain('place1');
    await tv.waitForTimeout(4000);
    const after = await heard();
    expect(after.filter((cue) => cue === 'place1')).toHaveLength(1);
    expect(after).not.toContain('place2');
  });
});
