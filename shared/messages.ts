import { z } from 'zod';
import { ROOM_ID_PATTERN, TOKEN_PATTERN } from './constants.js';

/** Every message from a client is checked against one of these. Unknown fields are refused. */

// Generous enough for a cleaned 16-character name, small enough to refuse junk early.
const rawName = z.string().max(200);
// Generous for the same reason: the 140-character limit applies after cleaning.
const rawAnswer = z.string().max(1000);
const shortId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const screenId = z.number().int().min(0).max(10_000);
/** Numbers each guest's actions, so a delayed retry can't overwrite a newer edit. */
const seq = z.number().int().min(1).max(2 ** 31);

export const handshakeSchema = z.strictObject({
  room: z.string().regex(ROOM_ID_PATTERN),
  role: z.enum(['guest', 'host']),
});

export const emptySchema = z.strictObject({});

export const guestHelloSchema = z.strictObject({
  token: z.string().regex(TOKEN_PATTERN),
});

export const guestJoinSchema = z.strictObject({
  token: z.string().regex(TOKEN_PATTERN),
  name: rawName,
});

export const guestAnswerSchema = z.strictObject({ screenId, seq, text: rawAnswer });

export const guestVoteSchema = z.strictObject({ screenId, seq, entryId: shortId });

export const guestPinSchema = z.strictObject({
  screenId,
  seq,
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

/** The position of the chosen answer, as the guest saw them. */
export const guestPickSchema = z.strictObject({ screenId, seq, option: z.number().int().min(0).max(3) });

export const hostCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('next'), screenId }),
  z.strictObject({ type: z.literal('skipTimer'), screenId }),
  z.strictObject({ type: z.literal('addTime'), screenId }),
  z.strictObject({ type: z.literal('setPaused'), paused: z.boolean() }),
  z.strictObject({ type: z.literal('setJoinLocked'), locked: z.boolean() }),
  z.strictObject({ type: z.literal('remove'), playerId: shortId }),
  z.strictObject({ type: z.literal('hideEntry'), entryId: shortId }),
  z.strictObject({ type: z.literal('answerRejoin'), requestId: shortId, approve: z.boolean() }),
]);

export const loginSchema = z.strictObject({
  password: z.string().min(1).max(200),
});
