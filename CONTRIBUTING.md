# Contributing

Thanks for helping. Bug reports, fixes, new games and translations of the look to other places are all welcome.

## Getting set up

```bash
npm install
npm run setup   # makes .env with a presenter password
npm run dev     # the server on :3000 and the client on :5173
```

Before opening a pull request, run:

```bash
npm run typecheck
npm test
npm run test:integration
npm run test:e2e   # needs `npx playwright install chromium` once
```

CI runs all of these except the browser tests, so please run those locally for anything that changes what's on screen.

## How it fits together

One server holds every game in memory and talks to the TV and phones over Socket.IO. The server decides everything, including timers, scores and what each screen shows, so a phone can't see an answer before the reveal or vote for its own.

| Folder | |
| --- | --- |
| `shared/` | Code both sides use: the deck format and its checks (`deck.ts`), the messages (`messages.ts`, `protocol.ts`), map maths and country outlines. |
| `server/session/` | `room.ts` is one game's state machine: lobby, rounds, reveals, standings and the podium. `manager.ts` keeps rooms and saves them, so a restart picks up where it left off. `sockets.ts` connects TVs and phones to their room. |
| `server/games/` | Scoring and checks for each game type, such as the similarity check between answers. |
| `server/storage/` | Disk or S3 storage for decks, photos and saved games. |
| `client/src/host/` | The TV. |
| `client/src/guest/` | The phones. |
| `client/src/admin/` | The deck builder. |
| `client/src/map/` | The MapLibre maps for pins, reveals and tips. |
| `client/src/theme/` | Styles, fonts and GIFs. |

Each screen's contents come from the server as a `HostScreen` or `GuestScreen` (see `shared/protocol.ts`). A new screen or game usually means a new kind there, the state that produces it in `room.ts`, and a view for the TV and for phones.

## Tests

- `tests/unit` covers rooms, scoring and deck checks without a network.
- `tests/integration` starts a real server and drives it with socket clients.
- `tests/e2e` runs a TV and phones in Chromium with Playwright.
- `tests/load` holds checks to run against a real server before a big night. See [docs/rehearsal.md](docs/rehearsal.md).

## Screenshots

If you change how something looks, `npm run build && npm run capture` remakes the screenshots and GIFs in `docs/media`. It needs ffmpeg. Commit them only when the README's pictures should change.

## Style

The code is TypeScript with strict settings. Comments say why, not what. Text people read in the app is short, plain and friendly.
