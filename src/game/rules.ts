import { STRENGTH, type Card, type Suit } from './deck'
import type { TableConfig } from './table'

/** A seat at the table: 0 .. players-1, in play order. */
export type Seat = number

/** The seat to the left — play always moves in one direction. */
export function nextSeat(seat: Seat, players: number): Seat {
  return (seat + 1) % players
}

/** The other seat. Only meaningful at a two-player table. */
export function other(seat: Seat): Seat {
  return seat === 0 ? 1 : 0
}

export interface Play {
  readonly seat: Seat
  readonly card: Card
}

/**
 * Who wins a trick of any size.
 *
 * Briscola has no obligation to follow suit, so anyone may throw off. Walking
 * the plays in order and keeping the best gives the three familiar cases
 * without special-casing them:
 *
 *   1. Same suit as the current best  → higher STRENGTH takes it. This also
 *      settles trump-against-trump, since both are the same suit.
 *   2. A trump against a non-trump    → the trump takes it.
 *   3. Anything else                  → the current best holds, however weak.
 *
 * Case 3 is why a led 2 can beat an Ace of another suit.
 */
export function trickWinnerOf(plays: readonly Play[], trump: Suit): Seat {
  if (plays.length === 0) throw new Error('An empty trick has no winner')

  let best = plays[0]!
  for (const play of plays.slice(1)) {
    if (play.card.suit === best.card.suit) {
      if (STRENGTH[play.card.rank] > STRENGTH[best.card.rank]) best = play
    } else if (play.card.suit === trump) {
      best = play
    }
  }
  return best.seat
}

/**
 * Two-card form, kept because it reads better at a 1v1 table and is what the
 * existing tests are written against.
 */
export function trickWinner(lead: Card, follow: Card, trump: Suit): 'lead' | 'follow' {
  const winner = trickWinnerOf(
    [
      { seat: 0, card: lead },
      { seat: 1, card: follow },
    ],
    trump,
  )
  return winner === 0 ? 'lead' : 'follow'
}

/** True if `follow` would take the trick from `lead`. */
export function beats(follow: Card, lead: Card, trump: Suit): boolean {
  return trickWinner(lead, follow, trump) === 'follow'
}

/**
 * True if `card` would take a trick currently led/held as `plays`.
 * The N-seat form of `beats`, used by the AI when it is not second to play.
 */
export function wouldTake(card: Card, plays: readonly Play[], trump: Suit): boolean {
  if (plays.length === 0) return true
  // A seat number nobody at the table uses, so the answer is unambiguous.
  const probe = Math.max(...plays.map(p => p.seat)) + 1
  return trickWinnerOf([...plays, { seat: probe, card }], trump) === probe
}

export const TOTAL_POINTS = 120

/** With two sides, more than half the deck settles it. */
export const POINTS_TO_WIN = 61

export type Outcome = 'win' | 'loss' | 'draw'

/**
 * How a team finished.
 *
 * With two sides this is the familiar 61-to-win with 60-60 a pareggio. With
 * three players nobody needs a majority — the most points wins, and two or
 * three players can genuinely tie.
 */
export function outcomeForTeam(
  config: TableConfig,
  teamPoints: readonly number[],
  team: number,
): Outcome {
  const mine = teamPoints[team] ?? 0
  const best = Math.max(...teamPoints)

  if (config.hasMajorityThreshold) {
    if (mine >= POINTS_TO_WIN) return 'win'
    if (mine * 2 === TOTAL_POINTS) return 'draw'
    return 'loss'
  }

  if (mine < best) return 'loss'
  return teamPoints.filter(p => p === best).length > 1 ? 'draw' : 'win'
}

/** Two-player convenience, preserved for the existing tests. */
export function outcomeFor(myPoints: number): Outcome {
  if (myPoints >= POINTS_TO_WIN) return 'win'
  if (myPoints === TOTAL_POINTS - myPoints) return 'draw'
  return 'loss'
}
