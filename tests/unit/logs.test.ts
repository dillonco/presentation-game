import { describe, expect, it } from 'vitest';
import { redactUrl } from '../../server/app.js';

describe('what goes into the logs', () => {
  it.each([
    ['/j/abcdefghijklmnopqrstuv', '/j/…'],
    ['/host/abcdefghijklmnopqrstuv', '/host/…'],
    ['/api/join/ABCDEF', '/api/join/…'],
    ['/api/admin/rooms/abcdefghijklmnopqrstuv', '/api/admin/rooms/…'],
    ['/admin?next=/host/abcdefghijklmnopqrstuv', '/admin'],
  ])('leaves no room id or join code in %s', (url, logged) => {
    expect(redactUrl(url)).toBe(logged);
  });

  it('keeps everything else as it is', () => {
    expect(redactUrl('/api/admin/decks')).toBe('/api/admin/decks');
    expect(redactUrl('/api/admin/rooms')).toBe('/api/admin/rooms');
    expect(redactUrl('/media/abcdefghijklmnopqrstuv/full.jpg')).toBe('/media/abcdefghijklmnopqrstuv/full.jpg');
  });
});
