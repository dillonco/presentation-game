import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { closeEverything, failOnPageErrors, joinAs, newContext, openPhone } from './helpers.js';

test.afterEach(closeEverything);

const RIGHT = 'Fushimi Inari';
const OPTIONS = [RIGHT, 'Kiyomizu-dera', 'Kinkaku-ji', 'Nara Park'];

async function startPickGame(browser: Browser): Promise<{ tv: Page; room: string }> {
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
      title: 'Which shrine',
      theme: { accent: null },
      region: { country: 'Japan' },
      moderation: { blocklist: [], similarity: 'normal', showLeftPage: true },
      games: [{ type: 'choice', settings: {}, items: [{ image, question: 'Where is this?', options: OPTIONS, answer: 0 }] }],
    },
  });
  const { deck } = (await created.json()) as { deck: { id: string } };
  const started = await context.request.post('/api/admin/rooms', { data: { deckId: deck.id } });
  const { id } = (await started.json()) as { id: string };
  await tv.goto(`/host/${id}`);
  await tv.getByText('Scan to join').waitFor();
  return { tv, room: id };
}

async function press(tv: Page, key: string): Promise<void> {
  await tv.waitForTimeout(550);
  await tv.keyboard.press(key);
}

test('a tap on an answer sends it, and another tap changes it, with no button to press', async ({ browser }) => {
  test.setTimeout(60_000);
  const { tv, room } = await startPickGame(browser);
  const phone = await openPhone(browser, room);
  await joinAs(phone, 'Aiko');
  await press(tv, 'Space');
  await tv.getByRole('heading', { name: 'Pick one' }).waitFor();
  await press(tv, 'Space');
  await phone.getByRole('radio', { name: 'Nara Park' }).waitFor();

  await expect(phone.getByText('Tap one. You can change it until time runs out.')).toBeVisible();
  await expect(phone.locator('.act')).toHaveCount(0);

  await phone.getByRole('radio', { name: 'Nara Park' }).click();
  await expect(phone.getByText('Locked in')).toBeVisible();

  // Still counts after a refresh, and a different tap replaces it.
  await phone.reload();
  await expect(phone.getByRole('radio', { name: 'Nara Park' })).toBeChecked();
  await expect(phone.getByText('Locked in')).toBeVisible();
  await phone.getByRole('radio', { name: RIGHT }).click();
  await expect(phone.getByRole('radio', { name: RIGHT })).toBeChecked();
  await expect(phone.getByRole('radio', { name: 'Nara Park' })).not.toBeChecked();
  await expect(phone.getByText('Locked in')).toBeVisible();

  await press(tv, 's');
  await expect(phone.getByText('You got it')).toBeVisible({ timeout: 20_000 });
});
