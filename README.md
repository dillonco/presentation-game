# The Presentation Game

**A live party game for groups.** Put it on the TV, and everyone scans a QR code and plays on their phone. Use it to present something, such as a trip, a hobby or a year in review, or just have fun with your own ideas. You build the night in a deck: your words, your photos, your questions. Nobody needs an account or an app, and it runs on one small server.

## The games

- **Define it.** A real word goes up. Everyone writes a fake meaning, then votes for the one they think is real. You score for finding it, and for every friend your fake fooled. Words can come with a clip of someone saying them.
- **Where was this?** A photo goes up and everyone drops a pin on a street map of the country. The closer you are, the more you score.
- **Caption this.** Everyone captions the same photo, then votes for the best one that isn't theirs.
- **Pick one.** A photo, a question and four answers. The TV shows how everyone split, then circles the right one.

Each photo can bring up to 5 more from the same moment, pinned up on the TV after its round. The night ends on a podium that lands one place at a time, then an optional page of tips on the TV and every phone, with each place a tap away in Maps. [`docs/decks.md`](docs/decks.md) covers every game and setting.

## Run it yourself in two minutes

You need [Node.js 22](https://nodejs.org) or newer.

```bash
git clone https://github.com/dillonco/presentation-game.git
cd presentation-game
npm install
npm run setup
npm run dev
```

`npm run setup` makes a `.env` file with a presenter password and prints the password. Open http://localhost:5173/admin, sign in with it, and press **Add the sample deck**. It has all four games, with free-to-use photos from Japan. Press **Start game**, then open the join link in another window, or a few, to play along.

Or let sample players fill the room. Leave the lobby on the TV page, and in another terminal run this with the link from that page's address bar:

```bash
npm run players -- http://localhost:5173/host/<room> --count 4
```

They write, vote, drop pins and pick answers like guests' phones would, while you press `Space` on the TV.

The sample deck and sample players are for trying the game while you develop. A server running with `NODE_ENV=production`, as the Docker image does, has no sample deck: every deck on it is one somebody made.

## Play it on the night

Phones join by scanning the QR code on the TV, so they need to reach the server at the address the TV shows.

**On your Wi-Fi.** Build it and run it on a laptop plugged into the TV:

```bash
npm run build
npm start
```

Open `http://<your laptop's network address>:3000/admin` on the laptop, not `localhost`, so the QR code points somewhere phones can reach. Everyone needs to be on the same Wi-Fi.

**With Docker.** [`compose.yaml`](compose.yaml) runs the app with its decks and photos in a volume:

```bash
npm run setup
docker compose up -d
```

**On a host.** Guests on mobile data need a public HTTPS address. The [`Dockerfile`](Dockerfile) runs anywhere that runs containers, and `/healthz` answers `{"ok":true}` for health checks. Set the environment below. If the host wipes the disk on each deploy, use S3 storage so decks and photos survive.

| Variable | |
| --- | --- |
| `ADMIN_PASSWORD` | The presenter password for `/admin`. Required to build decks. |
| `SESSION_SECRET` | 16 characters or more, for signing presenter sessions. Required. |
| `PORT` | Defaults to `3000`. |
| `DATA_DIR` | Where decks, photos and saved games live without S3. Defaults to `.data`. |
| `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Store everything in S3 instead of on disk. |
| `S3_REGION` | Defaults to `us-east-1`. |
| `S3_ENDPOINT_URL` | For MinIO, Cloudflare R2 and other S3-compatible stores. Leave it out for Amazon S3. |
| `MEDIA_CACHE_MB` | How much local disk the copy of photos and videos may use. Defaults to `2048`. |
| `TRUST_PROXY` | How many proxies are in front of the server, usually `1` on a host. Then each visitor gets their own limit on connections. Leave it out when nothing is in front, or anyone could claim any address. Only set it if the proxy passes on real visitor addresses: signed in, `/api/admin/stats` shows `yourAddress`, which should be your own. |
| `FORCE_HTTPS` | `true` to send every visitor to HTTPS and refuse sign-in over plain HTTP. Set it on a public server unless the host already redirects. |

[`.env.example`](.env.example) lists them all. On a public server, use a strong `ADMIN_PASSWORD` and serve it over HTTPS: sign-in cookies are only marked Secure when the request arrived over HTTPS (`X-Forwarded-Proto: https` behind a proxy). A game in progress is saved as it goes, so a restart or redeploy only pauses it: the TV and phones reconnect by themselves, on the same screen, with their answers and scores. Still, don't deploy during the party.

A game holds up to 50 guests. Before a big night, [`docs/rehearsal.md`](docs/rehearsal.md) is a checklist for trying it on the real TV and phones, including a load test.

## Build your deck

Open `/admin` and press **New deck**. Pick the country for the map, add games in any order, and fill them with your words and photos. Changes save as you type, and the builder lists anything that still needs fixing. Keep it off the TV, since it shows the real answers.

Photos are resized in the browser and stripped of their location and camera data before upload, and a photo's GPS location fills in its spot on the map. iPhone HEIC photos and MP4 or MOV videos work too.

[`docs/decks.md`](docs/decks.md) covers every game and setting.

## Running the show

The TV is the remote. Press a key once when the TV page opens, since browsers only allow sound after that.

| Key | |
| --- | --- |
| `Space` | Next. During a reveal or the podium, show everything at once. |
| `S` | Skip the timer, or skip to the vote while answers are shown one at a time |
| `+` | Add 15 seconds |
| `P` | Pause, or hold on the current answer |
| `M` | Mute. Remembered on that computer. |
| `L` | Lock or open joining |
| `R` | Show the players |
| `Y` / `N` | Let a guest back in on a new phone, or not |
| `H` | Hear a Define it clip again |
| `F` | Full screen. `F` or `Esc` leaves it. |
| `J` | Put the join QR code back up mid-game, for a guest who closed the page. `J` or `Esc` puts it away. |

Click an answer on the TV to hide it. Only the TV makes sound.

Guests can lock their phones, lose signal or refresh, and they come straight back to where they were. After the first visit, the app opens even on very weak signal and reconnects when it can.

## The look

The TV has no background pictures. Behind everything is a sky drawn from colours, in [`client/src/host/Scene.tsx`](client/src/host/Scene.tsx) and [`client/src/theme/scene.css`](client/src/theme/scene.css), with a different time of day for each part of the night: dusk in the lobby, daytime on each game's title card, night during rounds, sunset for the standings and a lantern-lit night for the podium. Clouds part between games. Anyone set to reduce motion gets a still version. A deck's accent colour tints the rest.

There is no background music: the TV makes its own beeps and chimes, and plays a word's clip when it has one. Each title card and standings screen pins up a GIF from Giphy, set in [`client/src/theme/gifs.ts`](client/src/theme/gifs.ts). The TV needs internet for the GIFs and word clips. Anything that can't load is left out.

## Development

```bash
npm run typecheck
npm test                  # unit tests
npm run test:integration  # a real server, with simulated TVs and phones
npm run test:e2e          # a TV and phones in real browsers
```

The browser tests need `npx playwright install chromium` once. They're slow and timing-sensitive, so CI runs everything except them: run them locally for anything that changes what's on screen. `/styleguide` shows the phone components at real sizes.

One server holds every game in memory and talks to the TV and phones over Socket.IO. The server decides everything, including timers, scores and what each screen shows, so a phone can't see an answer before the reveal or vote for its own. The server is [Fastify](https://fastify.dev), and the client is React, built with Vite.

| Folder | |
| --- | --- |
| `shared/` | Code both sides use: the deck format and its checks (`deck.ts`), the messages (`messages.ts`, `protocol.ts`), map maths and country outlines. |
| `server/session/` | `room.ts` is one game's state machine: lobby, rounds, reveals, standings and the podium. `manager.ts` keeps rooms and saves them, so a restart picks up where it left off. `sockets.ts` connects TVs and phones to their room. |
| `server/games/` | Scoring and checks for each game type. |
| `server/storage/` | Disk or S3 storage for decks, photos and saved games. |
| `client/src/` | `host/` is the TV, `guest/` the phones, `admin/` the deck builder, `map/` the MapLibre maps. |

Each screen's contents come from the server as a `HostScreen` or `GuestScreen` (see `shared/protocol.ts`). A new screen or game usually means a new kind there, the state that produces it in `room.ts`, and a view for the TV and for phones.

## Credits

- Maps: [OpenFreeMap](https://openfreemap.org), with data from [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, drawn with [MapLibre](https://maplibre.org). Country outlines from [Natural Earth](https://www.naturalearthdata.com).
- Sample photos: Wikimedia Commons, all CC0. See [`server/sample-photos/CREDITS.md`](server/sample-photos/CREDITS.md).
- Fonts: Zen Kaku Gothic New, Zen Old Mincho, DotGothic16 and DSEG7, all under the SIL Open Font License. See [`client/src/theme/fonts/LICENSES.md`](client/src/theme/fonts/LICENSES.md).
- Word clips play from YouTube, and GIFs from Giphy; neither is included in this repository.

## License

[MIT](LICENSE). The license covers this repository's code. The sample photos and fonts keep their own terms.
