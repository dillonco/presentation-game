import { expect, test, type Browser } from '@playwright/test';
import { closeEverything, joinAs, openPhone, press, startGame } from './helpers.js';

test.afterEach(closeEverything);

const RIGHT = 'Fushimi Inari';
const OPTIONS = [RIGHT, 'Kiyomizu-dera', 'Kinkaku-ji', 'Nara Park'];

function startPickGame(browser: Browser) {
  return startGame(browser, (image) => [
    { type: 'choice', settings: {}, items: [{ image, question: 'Where is this?', options: OPTIONS, answer: 0 }] },
  ]);
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
