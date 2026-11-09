# Building a deck

Everything about one night lives in a deck: its title, the country for the map, the games and their content. Another trip needs a new deck, not new code.

Sign in at `/admin`, press **New deck** (or **Add the sample deck** to try one first), and fill it in. Changes save as you type. When it's ready, press **Start game**: the page turns into the TV screen, with a QR code for guests to join. Make it full screen on the TV.

> The builder shows the real answers, so keep it off the TV.

## The deck

- **Title** is shown in the lobby and on the podium.
- **Country for the map** is where Where was this? guests drop their pins, and frames the trip tips map. Any country works.
- **Colour and moderation** sets the accent colour, words guests can't use in answers, and how close two answers can be before the second is refused.
- A deck is an ordered list of up to 12 games. Each can be moved, repeated or removed.
- **Export** saves a deck as a JSON file. The file names its photos but doesn't contain them, so an imported deck only finds its photos on the same server.

## The games

### Define it

Each round is a word and its real meaning. Guests write fake meanings, then everyone votes for the one they think is real. You score for finding the real one and for each person your fake fooled.

Each word can have a **pronunciation clip**: part of a YouTube video of someone saying it. Paste the link and set when it starts and ends, up to 20 seconds. A link copied with a start time (`?t=73`) fills in the start, and **Play** previews it. On the TV the clip plays 1.5 seconds after the word goes up, then twice more with 5 seconds between. Only the sound comes through, because a video's title or picture could give the meaning away. Press `H` to hear it again. Clips use YouTube's privacy-enhanced player and need internet on the TV. If YouTube can't be reached, the round goes on without one.

### Where was this?

One round per photo. Guests drop a pin on a street map of the deck's country, and points fall away with distance, on a scale of a tenth of the country's size. Pins must land within 20 km of the country's outline, which the server checks. If the street map can't load, the outline that ships with the app still takes a pin.

A photo's GPS location fills in its spot when you upload it, and you can move it on the map.

### Caption this

One round per photo. Guests write a caption, then vote for the best one that isn't theirs. The similarity check is one step looser than the deck's setting, since jokes often share an opening and only copies need stopping.

### Pick one

One round per photo, with an optional question and four answers, one marked right. The answers are shuffled when a game starts, so it doesn't matter where you put the right one. Everyone picks on their phone and can change their mind until time runs out (30 seconds unless the deck says otherwise). The right answer scores 1000 points, or what the deck sets. The TV then shows how many chose each answer, circles the right one and names everyone who got it.

## Answers on the TV

In Define it and Caption this, the TV shows each answer on its own once writing ends, so the room can laugh, then all of them together for the vote. Each stays up according to its length, or for a fixed time set in the deck. Click an answer on the TV to hide it.

## More photos from the same moment

Each photo in Caption this, Where was this? and Pick one can have up to 5 more photos. Once that photo's result is shown, the TV pins them up as a collage, so you can tell the story behind it, and phones say to look up. Click a photo to fill the screen, use the arrow keys to step through, and press Escape to go back. `Space` moves on as usual.

## The podium and trip tips

The night ends on a podium. Places below it fade in, then 3rd, 2nd and 1st land in turn. Ties share a place, and each phone shows its guest's place only once it's on the TV.

**Trip tips** are an optional last page: a heading and a line for each tip, such as "Best bite", with an optional photo and up to 3 places. Paste a Google Maps link to add a place. The server follows short links only to Google Maps and reads the place's name and spot from the address. The TV shows the tips beside a map with numbered pins. Each phone gets the same page, where each place opens in Maps and **Copy all** copies everything as plain text. On the podium, `Space` moves on to the tips.

## Photos

Photos are resized in the browser and lose their metadata before upload. The server rebuilds each one again to be sure, and rejects anything that isn't a complete JPEG. iPhone HEIC files are converted first. Any photo can be a video instead, as an MP4 or MOV of up to 100 MB.

The sample deck's photos are free to use (see [`server/sample-photos/CREDITS.md`](../server/sample-photos/CREDITS.md)), and each copy of the sample gets its own.
