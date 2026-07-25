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

Public domain, from the Wikimedia Commons
[Naples deck](https://commons.wikimedia.org/wiki/Category:Naples_deck) category.
See [`public/cards/CREDITS.md`](public/cards/CREDITS.md). The images are
committed, so a build never hits the network; `npm run assets` regenerates them.

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
