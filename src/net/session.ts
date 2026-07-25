import { chooseCard } from '../game/ai'
import type { CardId } from '../game/deck'
import { cardsLeftToDraw, newGame, play, score, tricksLeft, type GameState } from '../game/engine'
import { other, type Seat } from '../game/rules'
import { randomSeed } from '../game/rng'
import { DEFAULT_SETTINGS, type MatchSettings } from '../game/settings'
import { isReaction, type ClientMsg, type HostMsg, type NetMsg, type PublicView, type Reaction, type TrickSummary } from './protocol'
import { isSoundId, type SoundId } from '../ui/sounds'
import { isDeckId, type DeckId } from '../game/decks'
import type { Transport } from './transport'

/** A beat before the AI answers, so it doesn't feel instantaneous. */
export const AI_THINK_MS = 650

export type SessionStatus =
  | { kind: 'waiting' }
  | { kind: 'playing' }
  /** Hotseat only: hide the board and wait for the next player to take over. */
  | { kind: 'handoff'; seat: Seat }
  | { kind: 'disconnected' }

export interface Session {
  readonly mode: 'online' | 'ai' | 'hotseat'
  onView(handler: (view: PublicView) => void): void
  onStatus(handler: (status: SessionStatus) => void): void
  /** Fires when the *opponent* sends a reaction. Online only. */
  onReaction(handler: (emoji: Reaction) => void): void
  /** Fires when the *opponent* triggers a soundboard sound. Online only. */
  onSound(handler: (sound: SoundId) => void): void
  play(card: CardId): void
  rematch(): void
  /** Send a reaction to the opponent. No-op offline. */
  react(emoji: Reaction): void
  /** Play a soundboard sound on the opponent's device too. No-op offline. */
  sound(sound: SoundId): void
  /** Change the shared deck style. Online, the host applies and rebroadcasts. */
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
  opts: { table?: PublicView['table']; resolving?: boolean; lastWinner?: Seat | null } = {},
): PublicView {
  return {
    hand: state.hands[seat],
    opponentCards: state.hands[other(seat)].length,
    trumpCard: state.trumpCard,
    trumpSuit: state.trumpSuit,
    trumpTaken: state.trumpTaken,
    stockLeft: cardsLeftToDraw(state),
    table: opts.table ?? (state.table ? [state.table] : []),
    turn: state.turn,
    mySeat: seat,
    myPoints: score(state, seat),
    opponentPoints: score(state, other(seat)),
    trickNumber: state.trickNumber,
    deck,
    tricksLeft: tricksLeft(state),
    lastTrick: lastTrickFor(state, seat),
    phase: state.phase,
    resolving: opts.resolving ?? false,
    lastWinner: opts.lastWinner ?? null,
  }
}

/** Re-frames the last trick from one seat's point of view. */
function lastTrickFor(state: GameState, seat: Seat): PublicView['lastTrick'] {
  const t = state.lastTrick
  if (!t) return null
  const mineIsLead = t.leader === seat
  return {
    mine: mineIsLead ? t.leadCard : t.followCard,
    theirs: mineIsLead ? t.followCard : t.leadCard,
    iWon: t.winner === seat,
    points: t.points,
  }
}

/** Shared plumbing for handler registration. */
abstract class BaseSession implements Session {
  abstract readonly mode: 'online' | 'ai' | 'hotseat'

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

  abstract setDeck(deck: DeckId): void

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
 * Owns the authoritative GameState. Everything that actually advances a game
 * lives here; the online host, the AI game and the hotseat game all differ
 * only in who is allowed to move and who gets told about it.
 */
abstract class AuthoritativeSession extends BaseSession {
  protected state: GameState
  private dealer: Seat
  protected settings: MatchSettings

  constructor(seed: number, dealer: Seat = 0, settings: MatchSettings = DEFAULT_SETTINGS) {
    super()
    this.dealer = dealer
    this.settings = settings
    this.state = newGame(seed, dealer)
  }

  /**
   * Change the pace mid-lobby. Only the authoritative side has any say: it
   * runs the timer that holds a finished trick on the table.
   */
  applySettings(next: MatchSettings) {
    this.settings = next
    this.broadcast()
  }

  /** Deck is shared match state, so changing it re-renders both boards. */
  setDeck(deck: DeckId) {
    this.settings = { ...this.settings, deck }
    this.broadcast()
  }

  /** Push the current state out to whoever needs to see it. */
  protected abstract broadcast(opts?: Parameters<typeof viewFor>[3]): void

  /** Called after a trick has been swept and it is someone's turn again. */
  protected abstract afterTrick(): void

  protected applyMove(seat: Seat, card: CardId): boolean {
    if (this.state.phase === 'over') return false
    if (this.state.turn !== seat) return false
    if (!this.state.hands[seat].some(c => c.id === card)) return false

    const before = this.state
    const { state, trick } = play(before, seat, card)
    this.state = state

    if (!trick) {
      this.broadcast()
      this.onMoved()
      return true
    }

    // Hold both cards face-up for a beat so the loser can see what happened.
    const shown: PublicView['table'] = [
      { seat: trick.leader, card: trick.leadCard },
      { seat: other(trick.leader), card: trick.followCard },
    ]
    this.broadcast({ table: shown, resolving: true, lastWinner: trick.winner })
    this.onTrickResolved({
      leadCard: trick.leadCard.id,
      followCard: trick.followCard.id,
      winner: trick.winner,
      points: trick.points,
    })

    this.later(() => {
      this.broadcast()
      if (this.state.phase === 'playing') this.afterTrick()
    }, this.settings.trickDelayMs)

    return true
  }

  /** Hook: a card was played but the trick is still open. */
  protected onMoved() {}
  /** Hook: a trick just resolved. */
  protected onTrickResolved(_trick: TrickSummary) {}

  rematch() {
    // Alternate the deal, as you would across the table.
    this.dealer = other(this.dealer)
    this.state = newGame(randomSeed(), this.dealer)
    this.broadcast()
    this.afterTrick()
  }
}

/** Solo play against the heuristic AI. The human is always seat 0. */
export class AiSession extends AuthoritativeSession {
  readonly mode = 'ai' as const
  private static readonly HUMAN: Seat = 0
  private static readonly BOT: Seat = 1

  start() {
    this.broadcast()
    this.status({ kind: 'playing' })
    this.maybeMoveBot()
  }

  protected broadcast(opts?: Parameters<typeof viewFor>[3]) {
    this.emit(viewFor(this.state, AiSession.HUMAN, this.settings.deck, opts))
  }

  play(card: CardId) {
    if (this.applyMove(AiSession.HUMAN, card)) this.maybeMoveBot()
  }

  protected override onMoved() {
    this.maybeMoveBot()
  }

  protected afterTrick() {
    this.maybeMoveBot()
  }

  private maybeMoveBot() {
    if (this.state.phase !== 'playing' || this.state.turn !== AiSession.BOT) return
    this.later(() => {
      if (this.state.phase !== 'playing' || this.state.turn !== AiSession.BOT) return
      this.applyMove(AiSession.BOT, chooseCard(this.state, AiSession.BOT).id)
    }, AI_THINK_MS)
  }

  override rematch() {
    super.rematch()
    this.status({ kind: 'playing' })
  }
}

/** Two players sharing one device, with a handoff screen between turns. */
export class HotseatSession extends AuthoritativeSession {
  readonly mode = 'hotseat' as const
  /** Whose eyes the board is currently rendered for. */
  private viewer: Seat = 0
  private awaitingHandoff = false

  start() {
    this.viewer = this.state.turn
    this.broadcast()
    this.status({ kind: 'playing' })
  }

  protected broadcast(opts?: Parameters<typeof viewFor>[3]) {
    this.emit(viewFor(this.state, this.viewer, this.settings.deck, opts))
  }

  play(card: CardId) {
    if (this.awaitingHandoff) return
    this.applyMove(this.viewer, card)
  }

  protected override onMoved() {
    this.requestHandoff()
  }

  protected afterTrick() {
    this.requestHandoff()
  }

  private requestHandoff() {
    if (this.state.phase !== 'playing') return
    if (this.state.turn === this.viewer) return
    this.awaitingHandoff = true
    this.status({ kind: 'handoff', seat: this.state.turn })
  }

  override confirmHandoff() {
    if (!this.awaitingHandoff) return
    this.awaitingHandoff = false
    this.viewer = this.state.turn
    this.broadcast()
    this.status({ kind: 'playing' })
  }

  override rematch() {
    this.awaitingHandoff = false
    super.rematch()
    this.viewer = this.state.turn
    this.broadcast()
    this.status({ kind: 'playing' })
  }
}

/**
 * Online host. Seat 0, holds the real state, and feeds the guest a redacted
 * view of it.
 *
 * The host's browser necessarily knows the whole deck, so a modified client
 * could cheat. That is an accepted trade for having no server; see the README.
 */
export class HostSession extends AuthoritativeSession {
  readonly mode = 'online' as const
  private static readonly HOST: Seat = 0
  private static readonly GUEST: Seat = 1

  constructor(private transport: Transport, seed: number, settings?: MatchSettings) {
    super(seed, 0, settings)

    transport.onMessage(msg => this.receive(msg))
    transport.onPeerJoin(() => {
      this.status({ kind: 'playing' })
      this.broadcast()
    })
    transport.onPeerLeave(() => {
      if (!transport.isConnected()) this.status({ kind: 'disconnected' })
    })
  }

  start() {
    this.broadcast()
    this.status(this.transport.isConnected() ? { kind: 'playing' } : { kind: 'waiting' })
  }

  protected broadcast(opts?: Parameters<typeof viewFor>[3]) {
    this.emit(viewFor(this.state, HostSession.HOST, this.settings.deck, opts))
    this.send({ t: 'view', view: viewFor(this.state, HostSession.GUEST, this.settings.deck, opts) })
  }

  protected override onTrickResolved(trick: TrickSummary) {
    this.send({ t: 'trick', trick })
  }

  protected afterTrick() {}

  play(card: CardId) {
    this.applyMove(HostSession.HOST, card)
  }

  private receive(msg: NetMsg) {
    const m = msg as ClientMsg
    switch (m.t) {
      case 'hello':
        // The guest is ready to render; re-send state. Also covers a reconnect.
        this.broadcast()
        break
      case 'play':
        if (!this.applyMove(HostSession.GUEST, m.card)) {
          this.send({ t: 'error', message: 'Mossa non valida' })
          this.broadcast()
        }
        break
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
