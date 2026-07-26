import { chooseCard } from '../game/ai'
import type { CardId } from '../game/deck'
import { isDeckId, type DeckId } from '../game/decks'
import {
  allTeamScores,
  teamScore,
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
import { cleanName, DEFAULT_SETTINGS, type MatchSettings } from '../game/settings'
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
import { clientId, isClientId } from './identity'
import type { PeerId, Transport } from './transport'

/** A beat before an AI seat answers, so it doesn't feel instantaneous. */
export const AI_THINK_MS = 650

/**
 * How long a seat is held for a player who vanished.
 *
 * Long enough to survive a reload, a tunnel, or a phone call — mobile
 * browsers discard backgrounded tabs routinely — but not so long that the
 * others are stuck staring at a paused board. After it expires the seat is
 * handed to an AI so the hand can finish; the player can still take it back.
 */
export const RECONNECT_GRACE_MS = 90_000

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
  /**
   * Set when the peer went away and we are holding their seat. The seat stays
   * 'remote' so it can be reclaimed; if the grace period lapses it becomes
   * 'ai' and this clears.
   */
  awaitingSince?: number
}

export type SessionMode = 'online' | 'ai' | 'hotseat'

export type SessionStatus =
  | { kind: 'waiting' }
  | { kind: 'playing' }
  /** Hotseat only: hide the board until the next player picks the device up. */
  | { kind: 'handoff'; seat: Seat }
  | { kind: 'disconnected' }
  /** The room already has all its players. */
  | { kind: 'full' }
  /** Somebody dropped; their seat is being held open. */
  | { kind: 'awaiting'; seat: Seat; name?: string }
  /** The table is short of players and cannot start yet. */
  | { kind: 'seating'; waitingFor: number; players: number }

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
  seats: readonly SeatConfig[],
  opts: { table?: PublicView['table']; resolving?: boolean; lastWinner?: Seat | null } = {},
): PublicView {
  const players = state.config.players
  return {
    hand: state.hands[seat] ?? [],
    opponentCards: state.hands[nextSeat(seat, players)]?.length ?? 0,
    seats: seatViews(state, seat, seats),
    players,
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

/**
 * Everyone at the table as this seat sees them — counts, never cards.
 *
 * `offset` is the distance round the table from the viewer, so the board can
 * lay seats out relative to whoever is looking without knowing the seat
 * numbers: 0 is you, 1 the player to your left, and so on.
 */
function seatViews(
  state: GameState,
  viewer: Seat,
  seats: readonly SeatConfig[],
): PublicView['seats'] {
  const players = state.config.players
  const myTeam = teamOf(state.config, viewer)

  return state.hands.map((hand, i) => {
    const team = teamOf(state.config, i)
    const config = seats[i]
    return {
      seat: i,
      name: config?.name ?? '',
      cards: hand.length,
      team,
      offset: (i - viewer + players) % players,
      isMe: i === viewer,
      isPartner: i !== viewer && team === myTeam,
      points: teamScore(state, team),
      control: config?.control === 'ai' ? ('ai' as const) : ('human' as const),
      awaiting: config?.awaitingSince !== undefined,
    }
  })
}

/** Re-frames the last trick from one seat's point of view. */
function lastTrickFor(state: GameState, seat: Seat): PublicView['lastTrick'] {
  const t = state.lastTrick
  if (!t) return null
  return { plays: t.plays, winner: t.winner, iWon: t.winner === seat, points: t.points }
}

type ViewOpts = Parameters<typeof viewFor>[5]

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
    // Local seats are this player; label them so the others' boards agree.
    for (const seat of this.seats) {
      if (seat.control === 'local' && settings.name) seat.name = settings.name
    }
    this.viewer = this.firstLocalSeat()
    this.mode = seats.some(s => s.control === 'remote')
      ? 'online'
      : seats.filter(s => s.control === 'local').length > 1
        ? 'hotseat'
        : 'ai'
  }

  /**
   * True while the game must not move on. Overridden by the host, which pauses
   * when the player whose turn it is has dropped.
   */
  protected isPaused(): boolean {
    return false
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
    this.emit(viewFor(this.state, this.viewer, this.settings.deck, this.match, this.seats, opts))
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
    if (this.isPaused()) return
    const seat = this.state.turn
    const control = this.seats[seat]?.control

    if (control === 'ai') {
      this.later(() => {
        if (this.state.phase !== 'playing') return
        if (this.seats[this.state.turn]?.control !== 'ai') return
        const s = this.state.turn
        this.applyMove(s, chooseCard(this.state, s, this.settings.difficulty).id)
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
    seats?: SeatConfig[],
  ) {
    super(seats ?? defaultOnlineSeats(settings), seed, settings, 0)

    transport.onMessage((msg, from) => this.receive(msg, from))
    transport.onPeerJoin(() => {
      // Nothing is sent until the peer says hello: only then is it known
      // which seat — and therefore which hand — belongs to them.
      this.status({ kind: 'playing' })
    })
    transport.onPeerLeave(peer => this.onPeerLeave(peer))
  }

  /** Seats a joining browser, restoring its old seat if it has one. */
  private seatFor(client: string, peer: PeerId): Seat | null {
    const known = this.seats.findIndex(s => s.clientId === client)
    if (known !== -1) {
      const config = this.seats[known]!
      config.peerId = peer
      // Takes the seat back even if a bot had been standing in for them.
      config.control = 'remote'
      delete config.awaitingSince
      this.status({ kind: 'playing' })
      return known
    }

    const free = this.seats.findIndex(s => s.control === 'remote' && !s.clientId)
    if (free === -1) return null
    this.seats[free] = { control: 'remote', clientId: client, peerId: peer }
    return free
  }

  private onPeerLeave(peer: PeerId) {
    const seat = this.seats.findIndex(s => s.peerId === peer)
    if (seat === -1) {
      if (!this.transport.isConnected()) this.status({ kind: 'disconnected' })
      return
    }

    const config = this.seats[seat]!
    delete config.peerId
    // Keep the game and the seat: the usual reason a peer vanishes is that a
    // phone put the tab to sleep, and they are seconds from coming back.
    config.awaitingSince = Date.now()

    this.status({ kind: 'awaiting', seat, ...(config.name ? { name: config.name } : {}) })
    this.broadcast()

    this.later(() => this.giveSeatToAi(seat), RECONNECT_GRACE_MS)
  }

  /** The grace period lapsed: let a bot finish the hand for them. */
  private giveSeatToAi(seat: Seat) {
    const config = this.seats[seat]
    if (!config || config.peerId || config.awaitingSince === undefined) return

    config.control = 'ai'
    delete config.awaitingSince
    this.status(this.transport.isConnected() ? { kind: 'playing' } : { kind: 'disconnected' })
    this.broadcast()
    this.advance()
  }

  /** Seats still expecting a human who has never arrived. */
  private emptySeats(): Seat[] {
    return this.seats.flatMap((s, i) =>
      s.control === 'remote' && !s.peerId && s.awaitingSince === undefined ? [i] : [],
    )
  }

  /** Everyone who is going to play is here. */
  private tableIsFull(): boolean {
    return this.emptySeats().length === 0
  }

  /**
   * The clock stops while the table is short a player, or while a seat is
   * being held for someone who dropped.
   *
   * The first of those is why a three-handed game used to deal the moment one
   * opponent connected: nothing checked that the *third* seat had anybody in
   * it, so two players started a game the third could never join.
   */
  protected override isPaused(): boolean {
    if (!this.tableIsFull()) return true
    const seat = this.seats[this.state.turn]
    return seat?.control === 'remote' && seat.awaitingSince !== undefined
  }

  /** Fills the seats nobody has taken with bots and gets under way. */
  fillWithBots() {
    for (const seat of this.emptySeats()) this.seats[seat]!.control = 'ai'
    this.announce()
  }

  /** Re-evaluates whether the game can run, and tells the UI either way. */
  private announce() {
    if (this.tableIsFull()) {
      this.status({ kind: 'playing' })
      this.broadcast()
      this.advance()
    } else {
      this.status({ kind: 'seating', waitingFor: this.emptySeats().length, players: this.seats.length })
      this.broadcast()
    }
  }

  override start() {
    this.broadcast()
    this.announce()
  }

  protected override broadcast(opts?: ViewOpts) {
    this.emit(viewFor(this.state, this.viewer, this.settings.deck, this.match, this.seats, opts))
    // Each remote seat gets its own view, addressed to its own peer. These
    // carry that seat's hand, so a broadcast would deal everyone's cards face
    // up at a three or four player table.
    this.seats.forEach((seat, i) => {
      if (seat.control !== 'remote' || !seat.peerId) return
      this.send(
        { t: 'view', view: viewFor(this.state, i, this.settings.deck, this.match, this.seats, opts) },
        seat.peerId,
      )
    })
  }

  protected override onTrickResolved(trick: TrickSummary) {
    this.send({ t: 'trick', trick })
  }

  private receive(msg: NetMsg, from: PeerId) {
    const m = msg as ClientMsg
    switch (m.t) {
      case 'hello': {
        if (!isClientId(m.clientId)) return
        const seat = this.seatFor(m.clientId, from)
        if (seat === null) {
          this.send({ t: 'full' }, from)
          return
        }
        // Names arrive from a peer and land in everyone else's UI, so they go
        // through the same cleaning as anything else off the wire.
        const name = cleanName(m.name)
        if (name) this.seats[seat]!.name = name
        this.send({ t: 'seated', seat, players: this.seats.length }, from)
        this.announce()
        break
      }
      case 'play': {
        const seat = this.seatOf(from)
        if (seat === null || !this.applyMove(seat, m.card)) {
          this.send({ t: 'error', message: 'Mossa non valida' }, from)
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
   * Which seat a message came from.
   *
   * Looked up by peer rather than inferred from whose turn it is: with more
   * than one remote player, "it is somebody's turn" says nothing about who
   * actually sent the packet.
   */
  private seatOf(peer: PeerId): Seat | null {
    const seat = this.seats.findIndex(s => s.peerId === peer)
    return seat === -1 ? null : seat
  }

  override react(emoji: Reaction) {
    this.send({ t: 'react', emoji })
  }

  override sound(sound: SoundId) {
    this.send({ t: 'sound', sound })
  }

  private send(msg: HostMsg, target?: PeerId) {
    this.transport.send(msg, target)
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

  constructor(
    private transport: Transport,
    private name = '',
  ) {
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
      } else if (m.t === 'full') {
        // Better to say so than to sit on a lobby screen that never fills.
        this.status({ kind: 'full' })
      }
    })

    transport.onPeerJoin(() => {
      this.transport.send({
        t: 'hello',
        clientId: clientId(),
        ...(this.name ? { name: this.name } : {}),
      } satisfies ClientMsg)
    })

    transport.onPeerLeave(() => {
      if (!transport.isConnected()) this.status({ kind: 'disconnected' })
    })
  }

  start() {
    this.status({ kind: 'waiting' })
    if (this.transport.isConnected()) {
      this.transport.send({
        t: 'hello',
        clientId: clientId(),
        ...(this.name ? { name: this.name } : {}),
      } satisfies ClientMsg)
    }
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

/**
 * Seats for a room the host just opened: the host takes seat 0 and the rest
 * are held open for whoever joins.
 */
function defaultOnlineSeats(settings: MatchSettings): SeatConfig[] {
  const seats: SeatConfig[] = [{ control: 'local' }]
  for (let i = 1; i < settings.players; i++) seats.push({ control: 'remote' })
  return seats
}

/** Solo play: seat 0 is you, every other seat is a bot. */
export function aiSession(
  settings: MatchSettings,
  players: PlayerCount = 2,
  seed: number = randomSeed(),
): GameSession {
  const seats: SeatConfig[] = [{ control: 'local' }]
  for (let i = 1; i < players; i++) seats.push({ control: 'ai' })
  return new GameSession(seats, seed, settings)
}

/** Everyone on one device, passing it round. */
export function hotseatSession(
  settings: MatchSettings,
  players: PlayerCount = 2,
  seed: number = randomSeed(),
): GameSession {
  return new GameSession(
    Array.from({ length: players }, () => ({ control: 'local' as const })),
    seed,
    settings,
  )
}

export { other }
