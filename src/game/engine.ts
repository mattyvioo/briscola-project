import { freshDeck, totalPoints, type Card, type CardId, type Suit } from './deck'
import { mulberry32, shuffle } from './rng'
import { other, outcomeFor, trickWinner, type Outcome, type Seat } from './rules'

export interface TableCard {
  readonly seat: Seat
  readonly card: Card
}

export interface GameState {
  readonly seed: number
  /** Cards in hand, per seat. */
  readonly hands: readonly [readonly Card[], readonly Card[]]
  /** Face-down stock. Cards are drawn from the end. */
  readonly stock: readonly Card[]
  /** The face-up briscola, sitting half-under the stock. */
  readonly trumpCard: Card
  readonly trumpSuit: Suit
  /** Set once the trump card has been drawn (by the loser of trick 17). */
  readonly trumpTaken: boolean
  /** The led card, waiting for a response. Null between tricks. */
  readonly table: TableCard | null
  readonly turn: Seat
  /** Captured cards, per seat. */
  readonly piles: readonly [readonly Card[], readonly Card[]]
  readonly trickNumber: number
  readonly phase: 'playing' | 'over'
  /** The trick just completed, kept so players can review what was played. */
  readonly lastTrick: CompletedTrick | null
}

export interface CompletedTrick {
  readonly leader: Seat
  readonly leadCard: Card
  readonly followCard: Card
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
 * 3 cards each, the 7th turned face up as the briscola, 33 left in the stock.
 * The non-dealer leads.
 */
export function newGame(seed: number, dealer: Seat = 0): GameState {
  const deck = shuffle(freshDeck(), mulberry32(seed))

  const handA = deck.slice(0, 3)
  const handB = deck.slice(3, 6)
  const trumpCard = deck[6]!
  // Stock is drawn from the end, so reverse: deck[7] should come off first.
  const stock = deck.slice(7).reverse()

  const leader = other(dealer)
  const hands: [Card[], Card[]] = dealer === 0 ? [handA, handB] : [handB, handA]

  return {
    seed,
    hands,
    stock,
    trumpCard,
    trumpSuit: trumpCard.suit,
    trumpTaken: false,
    table: null,
    turn: leader,
    piles: [[], []],
    trickNumber: 1,
    phase: 'playing',
    lastTrick: null,
  }
}

/** Tricks still to be played, counting the one in progress. A game has 20. */
export const TRICKS_PER_GAME = 20

export function tricksLeft(state: GameState): number {
  if (state.phase === 'over') return 0
  return TRICKS_PER_GAME - state.trickNumber + 1
}

export function legalMoves(state: GameState, seat: Seat): readonly Card[] {
  // Briscola imposes no follow-suit obligation: every card in hand is legal.
  if (state.phase === 'over' || state.turn !== seat) return []
  return state.hands[seat]
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

  const hand = state.hands[seat]
  const idx = hand.findIndex(c => c.id === id)
  if (idx === -1) throw new Error(`Seat ${seat} does not hold ${id}`)
  const card = hand[idx]!

  const hands: [Card[], Card[]] = [state.hands[0].slice(), state.hands[1].slice()]
  hands[seat].splice(idx, 1)

  // Leading: park the card on the table and pass the turn.
  if (state.table === null) {
    return {
      state: { ...state, hands, table: { seat, card }, turn: other(seat) },
      trick: null,
    }
  }

  // Following: resolve the trick.
  const leader = state.table.seat
  const leadCard = state.table.card
  const winner = trickWinner(leadCard, card, state.trumpSuit) === 'lead' ? leader : seat

  const piles: [Card[], Card[]] = [state.piles[0].slice(), state.piles[1].slice()]
  piles[winner].push(leadCard, card)

  // Winner draws first, then the loser. The loser of the trick that empties
  // the stock is the one who picks up the face-up briscola.
  const stock = state.stock.slice()
  let trumpTaken = state.trumpTaken
  const drawn: { seat: Seat; card: Card }[] = []

  for (const s of [winner, other(winner)] as const) {
    if (stock.length > 0) {
      const drawnCard = stock.pop()!
      hands[s].push(drawnCard)
      drawn.push({ seat: s, card: drawnCard })
    } else if (!trumpTaken) {
      trumpTaken = true
      hands[s].push(state.trumpCard)
      drawn.push({ seat: s, card: state.trumpCard })
    }
  }

  const over = hands[0].length === 0 && hands[1].length === 0

  const completed: CompletedTrick = {
    leader,
    leadCard,
    followCard: card,
    winner,
    points: totalPoints([leadCard, card]),
  }

  return {
    state: {
      ...state,
      hands,
      stock,
      trumpTaken,
      piles,
      table: null,
      turn: winner,
      trickNumber: state.trickNumber + 1,
      phase: over ? 'over' : 'playing',
      lastTrick: completed,
    },
    trick: { ...completed, drawn },
  }
}

export function score(state: GameState, seat: Seat): number {
  return totalPoints(state.piles[seat])
}

export function outcome(state: GameState, seat: Seat): Outcome {
  return outcomeFor(score(state, seat))
}

/** Cards left to draw, counting the face-up briscola. */
export function cardsLeftToDraw(state: GameState): number {
  return state.stock.length + (state.trumpTaken ? 0 : 1)
}
