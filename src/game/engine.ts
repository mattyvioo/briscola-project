import { totalPoints, type Card, type CardId, type Suit } from './deck'
import { mulberry32, shuffle } from './rng'
import {
  nextSeat,
  outcomeForTeam,
  trickWinnerOf,
  type Outcome,
  type Play,
  type Seat,
} from './rules'
import { buildDeck, HAND_SIZE, tableFor, teamOf, type PlayerCount, type TableConfig } from './table'

export type TableCard = Play

export interface GameState {
  readonly seed: number
  readonly config: TableConfig
  /** Cards in hand, indexed by seat. */
  readonly hands: readonly (readonly Card[])[]
  /** Face-down stock. Cards are drawn from the end. */
  readonly stock: readonly Card[]
  /** The face-up briscola, sitting beside the stock. */
  readonly trumpCard: Card
  readonly trumpSuit: Suit
  /** Set once the briscola itself has been drawn. */
  readonly trumpTaken: boolean
  /** Cards played into the current trick, in play order. Empty between tricks. */
  readonly table: readonly TableCard[]
  readonly turn: Seat
  /** Who led the current trick. */
  readonly leader: Seat
  /** Captured cards, indexed by **team** rather than seat. */
  readonly piles: readonly (readonly Card[])[]
  readonly trickNumber: number
  readonly phase: 'playing' | 'over'
  /** The trick just completed, kept so players can review what was played. */
  readonly lastTrick: CompletedTrick | null
}

export interface CompletedTrick {
  readonly leader: Seat
  readonly plays: readonly TableCard[]
  readonly winner: Seat
  readonly points: number
}

export interface TrickResult extends CompletedTrick {
  /** What each seat drew afterwards, in draw order (winner first). */
  readonly drawn: readonly { seat: Seat; card: Card }[]
}

export interface PlayResult {
  readonly state: GameState
  /** Present only when the played card completed a trick. */
  readonly trick: TrickResult | null
}

/**
 * Deals a new game.
 *
 * 3 cards to each seat, the next card turned face up as the briscola, the rest
 * face down as stock. The player to the dealer's left leads.
 */
export function newGame(seed: number, dealer: Seat = 0, players: PlayerCount = 2): GameState {
  const config = tableFor(players)
  const deck = shuffle(buildDeck(config), mulberry32(seed))

  const hands: Card[][] = []
  for (let i = 0; i < config.players; i++) {
    hands.push(deck.slice(i * HAND_SIZE, (i + 1) * HAND_SIZE))
  }

  const dealt = config.players * HAND_SIZE
  const trumpCard = deck[dealt]!
  // Stock is drawn from the end, so reverse: deck[dealt + 1] comes off first.
  const stock = deck.slice(dealt + 1).reverse()

  // Deal so that the seat holding the first packet is the one who leads.
  const leader = nextSeat(dealer, config.players)
  const rotated: Card[][] = []
  for (let i = 0; i < config.players; i++) {
    rotated[(leader + i) % config.players] = hands[i]!
  }

  return {
    seed,
    config,
    hands: rotated,
    stock,
    trumpCard,
    trumpSuit: trumpCard.suit,
    trumpTaken: false,
    table: [],
    turn: leader,
    leader,
    piles: config.teams.map(() => []),
    trickNumber: 1,
    phase: 'playing',
    lastTrick: null,
  }
}

export function tricksLeft(state: GameState): number {
  if (state.phase === 'over') return 0
  return state.config.tricks - state.trickNumber + 1
}

export function legalMoves(state: GameState, seat: Seat): readonly Card[] {
  // Briscola imposes no follow-suit obligation: every card in hand is legal.
  if (state.phase === 'over' || state.turn !== seat) return []
  return state.hands[seat] ?? []
}

/**
 * Plays a card. Returns the next state, and the trick result when the card
 * completed a trick.
 *
 * Throws on an illegal move rather than silently correcting it — a bad move
 * means a bug or a malicious peer, and both deserve to be loud.
 */
export function play(state: GameState, seat: Seat, id: CardId): PlayResult {
  if (state.phase === 'over') throw new Error('Game is over')
  if (state.turn !== seat) throw new Error(`Not seat ${seat}'s turn`)

  const hand = state.hands[seat] ?? []
  const idx = hand.findIndex(c => c.id === id)
  if (idx === -1) throw new Error(`Seat ${seat} does not hold ${id}`)
  const card = hand[idx]!

  const hands = state.hands.map(h => h.slice())
  hands[seat]!.splice(idx, 1)

  const table = [...state.table, { seat, card }]
  const players = state.config.players

  // Trick still open: pass the turn round the table.
  if (table.length < players) {
    return {
      state: { ...state, hands, table, turn: nextSeat(seat, players) },
      trick: null,
    }
  }

  // Everyone has played — resolve.
  const winner = trickWinnerOf(table, state.trumpSuit)
  const winningTeam = teamOf(state.config, winner)

  const piles = state.piles.map(p => p.slice())
  piles[winningTeam]!.push(...table.map(t => t.card))

  // The winner draws first, then round the table in play order. The last card
  // to go is the face-up briscola, so whoever draws last in the final round
  // picks it up.
  const stock = state.stock.slice()
  let trumpTaken = state.trumpTaken
  const drawn: { seat: Seat; card: Card }[] = []

  for (let i = 0; i < players; i++) {
    const s = (winner + i) % players
    if (stock.length > 0) {
      const drawnCard = stock.pop()!
      hands[s]!.push(drawnCard)
      drawn.push({ seat: s, card: drawnCard })
    } else if (!trumpTaken) {
      trumpTaken = true
      hands[s]!.push(state.trumpCard)
      drawn.push({ seat: s, card: state.trumpCard })
    }
  }

  const over = hands.every(h => h.length === 0)

  const completed: CompletedTrick = {
    leader: state.leader,
    plays: table,
    winner,
    points: totalPoints(table.map(t => t.card)),
  }

  return {
    state: {
      ...state,
      hands,
      stock,
      trumpTaken,
      piles,
      table: [],
      turn: winner,
      leader: winner,
      trickNumber: state.trickNumber + 1,
      phase: over ? 'over' : 'playing',
      lastTrick: completed,
    },
    trick: { ...completed, drawn },
  }
}

/** Points captured by a team. */
export function teamScore(state: GameState, team: number): number {
  return totalPoints(state.piles[team] ?? [])
}

/** Points captured by the team a seat plays for. */
export function score(state: GameState, seat: Seat): number {
  return teamScore(state, teamOf(state.config, seat))
}

export function allTeamScores(state: GameState): number[] {
  return state.piles.map(p => totalPoints(p))
}

export function outcome(state: GameState, seat: Seat): Outcome {
  return outcomeForTeam(state.config, allTeamScores(state), teamOf(state.config, seat))
}

/** Cards left to draw, counting the face-up briscola. */
export function cardsLeftToDraw(state: GameState): number {
  return state.stock.length + (state.trumpTaken ? 0 : 1)
}
