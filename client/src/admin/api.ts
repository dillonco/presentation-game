import type { DeckContent, DeckSummary, StoredDeck, TipPlace } from '../../../shared/deck.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: { error?: string; problems?: string[] },
  ) {
    super(body.error ?? `Request failed with ${status}`);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new ApiError(response.status, body);
  return body;
}

function json(method: string, value: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) };
}

export interface RoomSummary {
  id: string;
  title: string;
  playerCount: number;
  finished: boolean;
}

export const api = {
  decks: () => call<{ decks: DeckSummary[] }>('/api/admin/decks').then((result) => result.decks),
  deck: (id: string) => call<{ deck: StoredDeck }>(`/api/admin/decks/${id}`).then((result) => result.deck),
  createDeck: (content: DeckContent) =>
    call<{ deck: StoredDeck }>('/api/admin/decks', json('POST', content)).then((result) => result.deck),
  saveDeck: (id: string, revision: number, content: DeckContent) =>
    call<{ revision: number }>(`/api/admin/decks/${id}`, json('PUT', { revision, content })).then(
      (result) => result.revision,
    ),
  addSampleDeck: () =>
    call<{ deck: StoredDeck }>('/api/admin/decks/sample', { method: 'POST' }).then((result) => result.deck),
  duplicateDeck: (id: string) =>
    call<{ deck: StoredDeck }>(`/api/admin/decks/${id}/duplicate`, { method: 'POST' }).then((result) => result.deck),
  deleteDeck: (id: string) => call(`/api/admin/decks/${id}`, { method: 'DELETE' }),
  rooms: () => call<{ rooms: RoomSummary[] }>('/api/admin/rooms').then((result) => result.rooms),
  deleteRoom: (id: string) => call(`/api/admin/rooms/${id}`, { method: 'DELETE' }),
  startGame: (deckId: string) =>
    call<{ id: string }>('/api/admin/rooms', json('POST', { deckId })).then((result) => result.id),
  uploadPhoto: (photo: Blob) =>
    call<{ id: string }>('/api/admin/images', {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg' },
      body: photo,
    }).then((result) => result.id),
  uploadVideo: (video: Blob) =>
    call<{ id: string }>('/api/admin/videos', {
      method: 'POST',
      headers: { 'content-type': 'video/mp4' },
      body: video,
    }).then((result) => result.id),
  uploadPoster: (id: string, poster: Blob) =>
    call(`/api/admin/images/${id}/full`, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      body: poster,
    }),
  uploadSmallPhoto: (id: string, photo: Blob) =>
    call(`/api/admin/images/${id}/small`, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      body: photo,
    }),
  lookUpPlace: (url: string) =>
    call<{ place: TipPlace }>('/api/admin/places', json('POST', { url })).then((result) => result.place),
  signOut: () => call('/api/admin/logout', { method: 'POST' }),
  space: () =>
    call<{ space: { code: string; presenterKey: string } | null }>('/api/admin/space').then((result) => result.space),
};

/** What to say when a hosted space has reached one of its limits, or null for any other error. */
export function spaceFullMessage(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.body.error === 'too_many_photos') {
    return 'this space holds as many photos and videos as it can. Delete a deck you no longer need to make room.';
  }
  if (error.body.error === 'too_many_videos') {
    return 'this space holds as many videos as it can. Use a photo, or delete a deck with videos you no longer need.';
  }
  if (error.body.error === 'too_many_decks') return 'This space holds as many decks as it can. Delete one to make room.';
  return null;
}

/** Sends a browser to the host page, or says what's still missing. */
export function startProblems(error: unknown): string[] {
  if (error instanceof ApiError && error.body.problems) return error.body.problems;
  return ["Couldn't start the game. Check the connection and try again."];
}
