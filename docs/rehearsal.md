# Rehearsal checklist

Run through this on the server you'll use on the night, with the real TV and phones, a few days before the party. Tick each line, and note anything that looked wrong.

## Before the rehearsal

- [ ] The server runs the version you'll play, CI passed on it, and `npm run test:e2e` passed locally.
- [ ] `ADMIN_PASSWORD` and `SESSION_SECRET` are set on the server, and so is S3 if its disk doesn't last between deploys.
- [ ] `https://<host>/healthz` answers `{"ok":true}`.
- [ ] The real deck is built: words with real definitions, map photos with checked locations, caption photos. The builder shows no problems.

## Load, from a laptop

- [ ] `LOAD_ADMIN_PASSWORD=<your password> npm run test:load -- --url https://<host>` passes with 50 guests. It takes about 6 minutes, or about 9 with `--real-pace`, and makes and then deletes a "Load test" deck.
- [ ] Note the CPU and memory peaks it prints. If CPU stays above about 70%, or a reply took over a second, give the server more CPU.
- [ ] Sign in and open `https://<host>/api/admin/stats` afterwards. Connections should be back near zero.

## Failure tests

- [ ] **Restart mid-round:** start a round with two phones, then restart the server. Within about 30 seconds the TV and phones reconnect by themselves, on the same screen, with answers and scores intact. A running timer starts again.
- [ ] **Locked phone:** lock a phone mid-vote for a minute, unlock it, and it lands on the current screen with its vote kept.
- [ ] **Refresh:** refresh a phone mid-vote. It skips the name screen and keeps its vote.
- [ ] **Airplane mode:** turn it on while pressing Send, wait, turn it off. The answer goes through once, without a second tap.
- [ ] **No signal refresh:** after the phone has loaded the game once, turn on airplane mode and refresh. The app still opens and says it's connecting, then gets back in when signal returns.
- [ ] **New phone:** join on a second phone with a name that's already playing, while the first is offline. "<Name> wants back in" appears on the TV, and `Y` moves the player over.
- [ ] **Full and locked:** a 51st guest is told the game is full, and a guest arriving after the first game starts is told joining is closed. `L` opens it again.

## Cheating pass, on a real phone

- [ ] With the browser's developer tools on a phone or laptop joined as a guest, watch the socket messages during writing and voting. No real answer, real location or author appears before the reveal.
- [ ] Try to vote for your own answer from the developer tools console. It's refused.
- [ ] Download a served photo (`/media/<id>/full.jpg`) and check it has no GPS or camera data, for example with `exiftool`.

## Real devices

At least one iPhone and one Android, on cellular, plus the smallest phone available.

- [ ] Each phone scans the QR code on the TV and joins.
- [ ] **Keyboards:** on every writing screen, open and close the keyboard. The timer, prompt, answer box and Send stay visible and nothing jumps. Send a flagged answer, edit it, send again. Rotate the phone.
- [ ] **Map:** the map reaches the bottom edge. Pinch from the whole country down to streets, check labels are readable in a few cities and rural areas, and drop and move a pin one-handed.
- [ ] **Weak signal:** play a full round with the phone throttled or at the edge of signal. Note how long the first load takes.
- [ ] **Idle lobby:** leave phones in the lobby for 5 minutes. None drop out.
- [ ] **Medals:** the top three phones show their medal only once that place lands on the TV.

## The TV

- [ ] Plug in the laptop, open `/host/<room>` full screen, and press a key once so sound can play.
- [ ] From across the room: the QR code scans, the timer and answers read clearly, and the podium looks right, including a tie for a medal place and a game with fewer than 3 players.
- [ ] Sound plays from the TV's speakers at a sensible volume, and `M` mutes it.
- [ ] Words and names in other scripts render in the right fonts.

## On the night

- [ ] **Don't deploy on game night**, because a restart pauses the game while everyone reconnects.
- [ ] Open the deck, press **Start game**, and put `/host/<room>` on the TV before guests arrive.
- [ ] Keep the deck builder off the TV, since it shows real answers.
