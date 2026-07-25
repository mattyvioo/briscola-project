import { chooseCard } from '../game/ai'
import type { CardId } from '../game/deck'
import { isDeckId, type DeckId } from '../game/decks'
import {
  allTeamScores,
  cardsLeftToDraw,
  newGame,
  play,
  score,
  tricksLeft,
  type GameState,
} from '../game/engine'
import { matchScores, newMatch, recordHand, type MatchState } from '../game/match'
import { teamOf } from '../game/table'
import { nextSeat, other, type Seat } from '../game/rules'
import { randomSeed } from '../game/rng'
import { DEFAULT_SETTINGS, type MatchSettings } from '../game/settings'
import type { PlayerCount } from '../game/table'
import { isSoundId, type SoundId } from '../ui/sounds'
import {
  isReaction,
  type ClientMsg,
  type HostMsg,
  type NetMsg,
  type PublicView,
  type Reaction,
  type TrickSummary,
} from './protocol'
import type { Transport } from './transport'

/** A beat before an AI seat answers, so it doesn't feel instantaneous. */
export const AI_THINK_MS = 650

/**
 * How a seat is driven.
 *
 * This one field replaces what used to be three near-identical session
 * classes. Solo play is `['local', 'ai']`, hotseat is `['local', 'local']`,
 * an online 1v1 is `['local', 'remote']`, and a four-handed game with two
 * bots is `['local', 'ai', 'remote', 'ai']`. It is also what later lets a
 * dropped player's seat be handed to an AI without touching the game loop.
 */
export type SeatControl = 'local' | 'ai' | 'remote'

export interface SeatConfig {
  control: SeatControl
  name?: string
  /** Survives a reload, unlike the transport's per-session peer id. */
  clientId?: string
  peerId?: string
}

export type SessionMode = 'online' | 'ai' | 'hotseat'

export type SessionStatus =
  | { kind: 'waiting' }
  | { kind: 'playing' }
  /** Hotseat only: hide the board until the next player picks the device up. */
  | { kind: 'handoff'; seat: Seat }
  | { kind: 'disconnected' }

export interface Session {
  readonly mode: SessionMode
  onView(handler: (view: PublicView) => void): void
  onStatus(handler: (status: SessionStatus) => void): void
  /** Fires when *someone else* sends a reaction. Online only. */
  onReaction(handler: (emoji: Reaction) => void): void
  /** Fires when *someone else* triggers a soundboard sound. Online only. */
  onSound(handler: (sound: SoundId) => void): void
  play(card: CardId): void
  rematch(): void
  react(emoji: Reaction): void
  sound(sound: SoundId): void
  setDeck(deck: DeckId): void
  /** Hotseat only: the next player has picked up the device. */
  confirmHandoff(): void
  leave(): void
}

/** Derives the seat-specific, redacted view of a game. */
function viewFor(
  state: GameState,
  seat: Seat,
  deck: DeckId,
  match: MatchState,
  opts: { table?: PublicView['table']; resolving?: boolean; lastWinner?: Seat | null } = {},
): PublicView {
  const players = state.config.players
  return {
    hand: state.hands[seat] ?? [],
    // At more than two seats this is the next player round, which is what the
    // 1v1 layout already shows. Phase 6 generalises the board itself.
    opponentCards: state.hands[nextSeat(seat, players)]?.length ?? 0,
    trumpCard: state.trumpCard,
    trumpSuit: state.trumpSuit,
    trumpTaken: state.trumpTaken,
    stockLeft: cardsLeftToDraw(state),
    table: opts.table ?? state.table,
    turn: state.turn,
    mySeat: seat,
    myPoints: score(state, seat),
    opponentPoints: score(state, nextSeat(seat, players)),
    trickNumber: state.trickNumber,
    deck,
    tricksLeft: tricksLeft(state),
    lastTrick: lastTrickFor(state, seat),
    phase: state.phase,
    resolving: opts.resolving ?? false,
    lastWinner: opts.lastWinner ?? null,
    match: {
      format: match.format,
      handNumber: match.handNumber,
      decided: match.decided,
      myScore: matchScores(match)[teamOf(state.config, seat)] ?? 0,
      scores: matchScores(match),
      myTeam: teamOf(state.config, seat),
      winners: match.winners,
    },
  }
}

/** Re-frames the last trick from one seat's point of view. */
function lastTrickFor(state: GameState, seat: Seat): PublicView['lastTrick'] {
  const t = state.lastTrick
  if (!t) return null
  return { plays: t.plays, winner: t.winner, iWon: t.winner === seat, points: t.points }
}

type ViewOpts = Parameters<typeof viewFor>[4]

/** Shared plumbing for handler registration. */
abstract class BaseSession implements Session {
  abstract readonly mode: SessionMode

  protected viewHandlers: ((view: PublicView) => void)[] = []
  protected statusHandlers: ((status: SessionStatus) => void)[] = []
  protected reactionHandlers: ((emoji: Reaction) => void)[] = []
  protected soundHandlers: ((sound: SoundId) => void)[] = []
  protected timers = new Set<ReturnType<typeof setTimeout>>()

  onView(handler: (view: PublicView) => void) {
    this.viewHandlers.push(handler)
  }
  onStatus(handler: (status: SessionStatus) => void) {
    this.statusHandlers.push(handler)
  }
  onReaction(handler: (emoji: Reaction) => void) {
    this.reactionHandlers.push(handler)
  }
  onSound(handler: (sound: SoundId) => void) {
    this.soundHandlers.push(handler)
  }

  protected emit(view: PublicView) {
    for (const h of this.viewHandlers) h(view)
  }
  protected status(status: SessionStatus) {
    for (const h of this.statusHandlers) h(status)
  }
  protected emitReaction(emoji: Reaction) {
    for (const h of this.reactionHandlers) h(emoji)
  }
  protected emitSound(sound: SoundId) {
    for (const h of this.soundHandlers) h(sound)
  }

  react(_emoji: Reaction) {
    // Only meaningful when there is another browser to send to.
  }
  sound(_sound: SoundId) {
    // Ditto — offline modes just play it locally.
  }

  /** setTimeout that gets cleaned up on leave(), so a torn-down session goes quiet. */
  protected later(fn: () => void, ms: number) {
    const id = setTimeout(() => {
      this.timers.delete(id)
      fn()
    }, ms)
    this.timers.add(id)
  }

  abstract play(card: CardId): void
  abstract rematch(): void
  abstract setDeck(deck: DeckId): void

  confirmHandoff() {
    /* only meaningful in hotseat */
  }

  leave() {
    for (const id of this.timers) clearTimeout(id)
    this.timers.clear()
    this.viewHandlers = []
    this.statusHandlers = []
    this.reactionHandlers = []
    this.soundHandlers = []
  }
}

/**
 * Owns the authoritative GameState and drives every seat that isn't a remote
 * human: AI seats move on a timer, local seats wait for the UI.
 *
 * One class covers solo, hotseat and any mix of the two; the online host
 * extends it with a transport.
 */
export class GameSession extends BaseSession {
  readonly mode: SessionMode
  protected state: GameState
  protected seats: SeatConfig[]
  protected settings: MatchSettings
  private dealer: Seat
  private players: PlayerCount
  protected match: MatchState
  /** Which local seat the board is currently drawn for. */
  protected viewer: Seat
  private awaitingHandoff = false

  constructor(
    seats: SeatConfig[],
    seed: number = randomSeed(),
    settings: MatchSettings = DEFAULT_SETTINGS,
    dealer: Seat = 0,
  ) {
    super()
    this.seats = seats
    this.players = seats.length as PlayerCount
    this.settings = settings
    this.dealer = dealer
    this.state = newGame(seed, dealer, this.players)
    this.match = newMatch(settings.format, this.state.config.teams.length)
    this.viewer = this.firstLocalSeat()
    this.mode = seats.some(s => s.control === 'remote')
      ? 'online'
      : seats.filter(s => s.control === 'local').length > 1
        ? 'hotseat'
        : 'ai'
  }

  private firstLocalSeat(): Seat {
    const i = this.seats.findIndex(s => s.control === 'local')
    return i === -1 ? 0 : i
  }

  private localSeats(): Seat[] {
    return this.seats.flatMap((s, i) => (s.control === 'local' ? [i] : []))
  }

  start() {
    // Start on whoever leads if they are local, so the first turn is theirs.
    if (this.seats[this.state.turn]?.control === 'local') this.viewer = this.state.turn
    this.broadcast()
    this.status({ kind: 'playing' })
    this.advance()
  }

  protected broadcast(opts?: ViewOpts) {
    this.emit(viewFor(this.state, this.viewer, this.settings.deck, this.match, opts))
  }

  applySettings(next: MatchSettings) {
    this.settings = next
    this.broadcast()
  }

  /** Deck is shared match state, so changing it re-renders every board. */
  setDeck(deck: DeckId) {
    this.settings = { ...this.settings, deck }
    this.broadcast()
  }

  play(card: CardId) {
    if (this.awaitingHandoff) return
    const seat = this.state.turn
    if (this.seats[seat]?.control !== 'local') return
    // In hotseat the viewer is whoever's turn it is, so this is the same seat.
    this.applyMove(seat, card)
  }

  protected applyMove(seat: Seat, card: CardId): boolean {
    if (this.state.phase === 'over') return false
    if (this.state.turn !== seat) return false
    if (!this.state.hands[seat]?.some(c => c.id === card)) return false

    const { state, trick } = play(this.state, seat, card)
    this.state = state

    if (!trick) {
      this.broadcast()
      this.advance()
      return true
    }

    // Hold the trick face-up for a beat so the losers can see what happened.
    this.broadcast({ table: trick.plays, resolving: true, lastWinner: trick.winner })
    this.onTrickResolved({
      plays: trick.plays.map(p => p.card.id),
      winner: trick.winner,
      points: trick.points,
    })

    this.later(() => {
      // A finished hand only counts once the trick that ended it is swept.
      if (this.state.phase === 'over') {
        this.match = recordHand(this.match, this.state.config, allTeamScores(this.state))
      }
      this.broadcast()
      if (this.state.phase === 'playing') this.advance()
    }, this.settings.trickDelayMs)

    return true
  }

  /**
   * Hands the turn to whoever owns it: schedule an AI move, ask for the device
   * to be passed, or simply wait for a local or remote human.
   */
  protected advance() {
    if (this.state.phase !== 'playing') return
    const seat = this.state.turn
    const control = this.seats[seat]?.control

    if (control === 'ai') {
      this.later(() => {
        if (this.state.phase !== 'playing') return
        if (this.seats[this.state.turn]?.control !== 'ai') return
        const s = this.state.turn
        this.applyMove(s, chooseCard(this.state, s).id)
      }, AI_THINK_MS)
      return
    }

    if (control === 'local' && seat !== this.viewer && this.localSeats().length > 1) {
      // More than one person on this device: hide the board until they swap.
      this.awaitingHandoff = true
      this.status({ kind: 'handoff', seat })
      return
    }

    if (control === 'local' && seat !== this.viewer) {
      // Single local player whose seat changed (shouldn't normally happen).
      this.viewer = seat
      this.broadcast()
    }
  }

  override confirmHandoff() {
    if (!this.awaitingHandoff) return
    this.awaitingHandoff = false
    this.viewer = this.state.turn
    this.broadcast()
    this.status({ kind: 'playing' })
  }

  /** Hook: a trick just resolved. The host relays it. */
  protected onTrickResolved(_trick: TrickSummary) {}

  rematch() {
    // Move the deal round the table, as you would in person.
    this.awaitingHandoff = false
    this.dealer = nextSeat(this.dealer, this.players)
    // A decided partita starts over; an undecided one just deals the next hand.
    if (this.match.decided) {
      this.match = newMatch(this.settings.format, this.state.config.teams.length)
    }
    this.state = newGame(randomSeed(), this.dealer, this.players)
    if (this.seats[this.state.turn]?.control === 'local') this.viewer = this.state.turn
    this.broadcast()
    this.status({ kind: 'playing' })
    this.advance()
  }
}

/**
 * Online host. Holds the real state and feeds each remote seat a redacted
 * view of it.
 *
 * The host's browser necessarily knows the whole deck, so a modified client
 * could cheat. That is an accepted trade for having no server; see the README.
 */
export class HostSession extends GameSession {
  constructor(
    private transport: Transport,
    seed: number = randomSeed(),
    settings: MatchSettings = DEFAULT_SETTINGS,
    seats: SeatConfig[] = [{ control: 'local' }, { control: 'remote' }],
  ) {
    super(seats, seed, settings, 0)

    transport.onMessage(msg => this.receive(msg))
    transport.onPeerJoin(() => {
      this.status({ kind: 'playing' })
      this.broadcast()
    })
    transport.onPeerLeave(() => {
      if (!transport.isConnected()) this.status({ kind: 'disconnected' })
    })
  }

  override start() {
    this.broadcast()
    this.status(this.transport.isConnected() ? { kind: 'playing' } : { kind: 'waiting' })
    this.advance()
  }

  protected override broadcast(opts?: ViewOpts) {
    this.emit(viewFor(this.state, this.viewer, this.settings.deck, this.match, opts))
    // Every remote seat gets its own view. Phase 4 targets these per peer;
    // with a single remote seat a broadcast reaches exactly the right browser.
    this.seats.forEach((seat, i) => {
      if (seat.control !== 'remote') return
      this.send({ t: 'view', view: viewFor(this.state, i, this.settings.deck, this.match, opts) })
    })
  }

  protected override onTrickResolved(trick: TrickSummary) {
    this.send({ t: 'trick', trick })
  }

  private receive(msg: NetMsg) {
    const m = msg as ClientMsg
    switch (m.t) {
      case 'hello':
        // The guest is ready to render; re-send state. Also covers a reconnect.
        this.broadcast()
        break
      case 'play': {
        const seat = this.remoteSeatToMove()
        if (seat === null || !this.applyMove(seat, m.card)) {
          this.send({ t: 'error', message: 'Mossa non valida' })
          this.broadcast()
        }
        break
      }
      case 'rematch':
        this.rematch()
        break
      case 'react':
        // Validate rather than trusting the peer — this string ends up in the
        // UI, and the allowed set is small and fixed.
        if (isReaction(m.emoji)) this.emitReaction(m.emoji)
        break
      case 'sound':
        if (isSoundId(m.sound)) this.emitSound(m.sound)
        break
      case 'settings':
        // The guest may ask; the host still owns the state and rebroadcasts,
        // so both boards end up agreeing.
        if (isDeckId(m.deck)) this.setDeck(m.deck)
        break
    }
  }

  /**
   * Which seat a `play` from the wire belongs to.
   *
   * With one remote seat this is unambiguous: it can only be a move for the
   * seat whose turn it is, and only if that seat is remote. Phase 4 replaces
   * this with a peer-id lookup once several remotes can be connected at once.
   */
  private remoteSeatToMove(): Seat | null {
    const seat = this.state.turn
    return this.seats[seat]?.control === 'remote' ? seat : null
  }

  override react(emoji: Reaction) {
    this.send({ t: 'react', emoji })
  }

  override sound(sound: SoundId) {
    this.send({ t: 'sound', sound })
  }

  private send(msg: HostMsg) {
    this.transport.send(msg)
  }

  override leave() {
    super.leave()
    this.transport.leave()
  }
}

/**
 * Online guest. Holds no game state at all — it renders whatever view the host
 * sends and forwards the player's intent.
 */
export class GuestSession extends BaseSession {
  readonly mode = 'online' as const

  constructor(private transport: Transport) {
    super()

    transport.onMessage(msg => {
      const m = msg as HostMsg
      if (m.t === 'view') {
        this.status({ kind: 'playing' })
        this.emit(m.view)
      } else if (m.t === 'react' && isReaction(m.emoji)) {
        this.emitReaction(m.emoji)
      } else if (m.t === 'sound' && isSoundId(m.sound)) {
        this.emitSound(m.sound)
      }
    })

    transport.onPeerJoin(() => {
      this.transport.send({ t: 'hello' } satisfies ClientMsg)
    })

    transport.onPeerLeave(() => {
      if (!transport.isConnected()) this.status({ kind: 'disconnected' })
    })
  }

  start() {
    this.status({ kind: 'waiting' })
    if (this.transport.isConnected()) this.transport.send({ t: 'hello' } satisfies ClientMsg)
  }

  play(card: CardId) {
    this.transport.send({ t: 'play', card } satisfies ClientMsg)
  }

  rematch() {
    this.transport.send({ t: 'rematch' } satisfies ClientMsg)
  }

  override react(emoji: Reaction) {
    this.transport.send({ t: 'react', emoji } satisfies ClientMsg)
  }

  override sound(sound: SoundId) {
    this.transport.send({ t: 'sound', sound } satisfies ClientMsg)
  }

  /** The guest has no state of its own: ask the host and wait for the view. */
  setDeck(deck: DeckId) {
    this.transport.send({ t: 'settings', deck } satisfies ClientMsg)
  }

  override leave() {
    super.leave()
    this.transport.leave()
  }
}

// --- convenience constructors ------------------------------------------------

/** Solo play: seat 0 is you, every other seat is a bot. */
export function aiSession(settings: MatchSettings, players: PlayerCount = 2): GameSession {
  const seats: SeatConfig[] = [{ control: 'local' }]
  for (let i = 1; i < players; i++) seats.push({ control: 'ai' })
  return new GameSession(seats, randomSeed(), settings)
}

/** Everyone on one device, passing it round. */
export function hotseatSession(settings: MatchSettings, players: PlayerCount = 2): GameSession {
  return new GameSession(
    Array.from({ length: players }, () => ({ control: 'local' as const })),
    randomSeed(),
    settings,
  )
}

export { other }
