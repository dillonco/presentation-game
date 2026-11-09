/** Values both the server and the phones need. Holds no dependencies, so it stays small. */

export const MAX_PLAYERS = 50;
export const MAX_NAME_LENGTH = 16;

/** A rejoin token is 32 random bytes in base64url. The phone creates it and the server keeps only a hash. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** How long a "wants back in" prompt stays on the TV. */
export const REJOIN_REQUEST_TTL_MS = 2 * 60 * 1000;
export const MAX_PENDING_REJOINS = 5;

export const MAX_ANSWER_LENGTH = 140;
/** Flagged tries per round, which slows down anyone fishing for the real answer. */
export const MAX_FLAGGED_TRIES = 5;
/** Answers arriving this soon after the deadline still count, to be fair to slow connections. */
export const DEADLINE_GRACE_MS = 1500;
/** How long a guest must be away from the page before the TV shows it. */
export const LEFT_PAGE_AFTER_MS = 5000;
