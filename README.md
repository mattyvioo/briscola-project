# Briscola

The Italian card game, in the browser. One-on-one online with **no backend** —
the two browsers talk directly over WebRTC — plus a practice opponent and a
pass-the-device mode.

```bash
npm install
npm run dev
```

## Playing

| Mode | How it works |
|---|---|
| **Gioca online** | Creates a room and shows a 6-character code. Send the code (or the `#CODE` link) to your opponent. |
| **Contro il computer** | Solo, against a heuristic AI. |
| **Due giocatori** | Both players on one device, with a handoff screen between turns. |

Tap or click a card to play it. On desktop, `1` / `2` / `3` play the cards in hand.

### Settings

Available from the main menu and from the lobby while you wait for an opponent.

- **Ritmo di gioco** — how long a finished trick stays face-up before it is
  swept away (0.8s / 1.4s / 2.5s / 4s), so you get time to see what the other
  player put down. In an online game the **host's** choice governs: the host
  owns the state and runs that timer, so a guest setting would only
  desynchronise the two boards.
- **Mazzo di carte** — Neapolitan or French artwork. **Shared**: either player
  can change it (the guest asks, the host applies and rebroadcasts) and both
  boards switch together, so you are always looking at the same cards. Also
  switchable mid-game from the 🂠 button in the HUD.

Both persist to `localStorage`.

### On the table

- Cards of the trump suit carry a **pip badge** in the corner. Briscola gives no
  visual cue for this normally — you are expected to remember the suit — and at
  60px on a phone that is a hard read.
- The **briscola sits beside the deck**, fully visible, rather than tucked
  underneath it.
- The counter next to the deck shows **tricks remaining**, not cards remaining.
- The **previous trick** stays on screen (your card vs theirs, and who took it).
  Only the most recent one.
- **Emoji reactions** (online only): tap to float one across both screens.
  Spam away — the gate is 80ms, only there to stop a held button saturating the
  data channel, and at most 14 are on screen at once so it stays readable.
- **Soundboard** (🔊 in the reaction bar): plays on *both* devices. Every sound
  is synthesised with the Web Audio API rather than shipped as a file — the
  recognisable meme clips are all somebody's copyright, and this repo is
  public. See [`src/ui/sounds.ts`](src/ui/sounds.ts) for the recipes and for
  how to swap in real recordings if you have the rights to some.

Both the emoji set and the sound ids are fixed lists, validated on receipt —
a modified peer cannot get an arbitrary string rendered or played.

### After a game

The result screen offers **Rivincita** and **Esci**.

- **Rivincita** deals a new hand in the same room, with the deal alternating.
  Either player can press it — the guest's click is relayed to the host, which
  owns the state — and both boards reset together. Nothing needs re-sharing.
- **Esci** returns to the main menu and drops the connection. From there
  *Gioca online* opens a fresh lobby with a **new** code, so the opponent has
  to be given the new link (or type the code into *Entra con codice*).

So: same opponent, more games → *Rivincita*. New opponent or a new room →
*Esci*.

### Room links

```
…/#ABC234        join a room   (send this to your opponent)
…/#host=ABC234   open it as host (keep this one)
```

Both are handled on `hashchange`, not just at load, so opening a room link
while the app is already on screen works — a fragment-only navigation does not
reload the page.

## The rules it implements

40-card Italian deck — **denari, coppe, spade, bastoni**, ranks 1–10 where
8/9/10 are the Fante, Cavallo and Re.

- **Trick order** (high → low): `1, 3, 10, 9, 8, 7, 6, 5, 4, 2`
- **Points:** Asso 11, Tre 10, Re 4, Cavallo 3, Fante 2, everything else 0 — **120 in the deck**
- 3 cards each, the 7th turned face up as the **briscola** (trump), 33 in the stock
- The **non-dealer leads**, and there is **no obligation to follow suit**
- A trick goes to the higher card of the led suit, or to a trump; otherwise **the led card wins**
- The winner draws first. On trick 17 the winner takes the last stock card and
  the **loser takes the face-up briscola**; tricks 18–20 are played from hand
- **61 points wins.** 60–60 is a *pareggio*

Rules cross-checked against [pagat.com](https://www.pagat.com/aceten/briscola.html).

## How the networking works

Peer discovery runs through [Trystero](https://github.com/dmotz/trystero) over
public MQTT relays. Nothing of ours is deployed: the relay only carries the
WebRTC handshake, and the room code is passed as Trystero's `password`, so the
session descriptions are encrypted and the code doubles as a shared secret.
After the handshake the game data goes browser-to-browser.

The room creator is the **host**: it holds the authoritative `GameState` and
sends each player only a redacted `PublicView` — your own hand, the opponent's
card *count*, the trump, the stock size, the table and the scores. The guest
sends intents (`play this card`) and the host validates them.

> ### Trust caveat
>
> The host's browser necessarily knows the whole deck, including the guest's
> hand. A modified client could therefore cheat. This is the accepted cost of
> having no server, and it is fine for a game between friends. Cryptographic
> dealing (commit-reveal / mental poker) is deliberately out of scope.

Public relays are best-effort. If a room won't connect, try again — or switch
the strategy import in [`src/net/trystero.ts`](src/net/trystero.ts) from
`@trystero-p2p/mqtt` to `@trystero-p2p/nostr` or `/torrent`.

## Layout

Everything is sized from one CSS custom property, `--card-w`, via `clamp()`.
There is a single width breakpoint (720px, which also requires height, so a
phone in landscape doesn't get desktop-sized cards) plus a short-viewport rule
for phone landscape — the genuinely tight case. The table is `100dvh` with
`overflow: hidden` and honours `env(safe-area-inset-*)`, so it never scrolls
and nothing hides under a notch.

## Layout of the code

```
src/
  game/     pure rules engine — no DOM, no network
    deck.ts     suits, ranks, points, strength
    rules.ts    trickWinner — the three-case heart of the game
    engine.ts   GameState + the play() reducer, draw order, stock exhaustion
    rng.ts      seeded shuffle, so any game replays from its seed
    ai.ts       heuristic opponent
  net/
    protocol.ts  PublicView + the message union, room codes
    transport.ts one interface, so the game never imports Trystero
    trystero.ts  the WebRTC implementation
    session.ts   host / guest / AI / hotseat, behind one Session interface
  ui/        imperative views — table, menu, card rendering, strings
scripts/
  fetch-cards.mjs  one-shot asset download (npm run assets)
```

Interface language is Italian; `src/ui/strings.ts` carries an English map
alongside, and switching is a one-line change to `LANG`.

## Tests

```bash
npm test
```

Covers the trick-resolution truth table, the 120-point invariant, the draw
order across the stock exhaustion boundary, and a **1000-game AI self-play
fuzz** asserting every game terminates in exactly 20 tricks with all 120 points
accounted for.

## Card artwork

Two packs ship, both free:

| Pack | Source | Licence |
|---|---|---|
| `napoletane` | Commons [Naples deck](https://commons.wikimedia.org/wiki/Category:Naples_deck) | **Public domain** |
| `francesi` | Commons [English pattern deck.svg](https://commons.wikimedia.org/wiki/File:English_pattern_playing_cards_deck.svg) | **CC0** |

The French pack is one CC0 sheet holding a 13x4 grid; `scripts/fetch-cards.mjs`
slices the 40 cards Briscola needs out of it and masks the rounded corners.

A third pack, `bergamasche` (Commons [Bergamo deck](https://commons.wikimedia.org/wiki/Category:Bergamo_deck),
CC BY-SA 3.0 by *Poulpy*), is implemented in the fetch script but **not
shipped**: it is 40 separate downloads and reliably trips Commons' rate
limiter. Run `npm run assets` until `public/cards/bergamasche` holds all 40,
then add `'bergamasche'` back to `DECK_IDS` in
[`src/game/decks.ts`](src/game/decks.ts).

See [`public/cards/CREDITS.md`](public/cards/CREDITS.md). Images are committed,
so a build never hits the network.

## Deploying

`npm run build` emits a static `dist/`. `base` is `'./'`, so it works from any
subpath — GitHub Pages, Netlify, Cloudflare Pages.

### HTTPS is required

Trystero derives its room topic with `crypto.subtle`, which browsers only
expose in a **secure context**. So online play works on `https://…` and on
`http://localhost`, but **not** on a plain LAN address like
`http://192.168.1.5:5173` — `crypto.subtle` is `undefined` there and the room
never forms. Single-player and hotseat are unaffected.

### Testing with someone on another machine

Quickest, no deploy — put the dev server behind an HTTPS tunnel:

```bash
brew install cloudflared
```

```bash
cloudflared tunnel --url http://localhost:5173
```

That prints a `https://….trycloudflare.com` URL; both players open it, one
picks *Gioca online* and shares the 6-character code (or the whole `#CODE`
link). `vite.config.ts` already allowlists the tunnel hostnames.

Note that only the *page load* goes through the tunnel — once the two browsers
have found each other, game traffic is direct peer-to-peer.

For anything longer-lived, build and put `dist/` on a static host instead; then
neither machine needs to be running anything.

### If two peers can't connect

Trystero ships STUN servers but no TURN, so a symmetric NAT or a locked-down
corporate network can stop the handshake. Add a TURN server via `turnConfig` in
[`src/net/trystero.ts`](src/net/trystero.ts) if that happens.
