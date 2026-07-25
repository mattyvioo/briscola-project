import { STRENGTH, type Card, type Suit } from './deck'

export type Seat = 0 | 1

export function other(seat: Seat): Seat {
  return seat === 0 ? 1 : 0
}

/**
 * Who wins a two-card trick.
 *
 * Briscola has no obligation to follow suit, so the follower is free to throw
 * off. The three cases:
 *
 *   1. Same suit          → higher STRENGTH wins (covers trump vs trump).
 *   2. Follower trumps    → follower wins.
 *   3. Anything else      → the led card wins, however weak it is.
 */
export function trickWinner(lead: Card, follow: Card, trump: Suit): 'lead' | 'follow' {
  if (follow.suit === lead.suit) {
    return STRENGTH[follow.rank] > STRENGTH[lead.rank] ? 'follow' : 'lead'
  }
  if (follow.suit === trump) return 'follow'
  return 'lead'
}

/** True if `follow` would take the trick from `lead`. */
export function beats(follow: Card, lead: Card, trump: Suit): boolean {
  return trickWinner(lead, follow, trump) === 'follow'
}

/**
 * Winning threshold. 61 of the 120 points takes the game; a 60-60 split is a
 * draw ("pareggio").
 */
export const POINTS_TO_WIN = 61
export const TOTAL_POINTS = 120

export type Outcome = 'win' | 'loss' | 'draw'

export function outcomeFor(myPoints: number): Outcome {
  if (myPoints >= POINTS_TO_WIN) return 'win'
  if (myPoints === TOTAL_POINTS - myPoints) return 'draw'
  return 'loss'
}
