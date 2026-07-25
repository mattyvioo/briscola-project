import { POINTS, STRENGTH, totalPoints, type Card, type Suit } from './deck'
import { cardsLeftToDraw, type GameState, type TableCard } from './engine'
import { wouldTake, type Seat } from './rules'

/**
 * A heuristic Briscola opponent. No search — just the handful of principles a
 * decent casual player follows:
 *
 *   - Don't waste trumps on tricks that aren't worth anything.
 *   - When you do take a trick, take it with the cheapest card that wins.
 *   - Lead with rubbish; hold the Asso and Tre for when they can capture.
 *
 * It plays a reasonable game without being unbeatable, which is what you want
 * from a practice opponent. Card counting, an exact endgame and partner play
 * are separate concerns layered on top.
 */

/** Value of a card as a thing to *keep*: its points, plus a bonus for trumps. */
function keepValue(card: Card, trump: Suit): number {
  const base = POINTS[card.rank] + STRENGTH[card.rank] * 0.1
  return card.suit === trump ? base + 12 : base
}

function cheapest(cards: readonly Card[], trump: Suit): Card {
  return cards.reduce((best, c) => (keepValue(c, trump) < keepValue(best, trump) ? c : best))
}

function isTrump(card: Card, trump: Suit): boolean {
  return card.suit === trump
}

export function chooseCard(state: GameState, seat: Seat): Card {
  const hand = state.hands[seat] ?? []
  if (hand.length === 0) throw new Error('AI has no cards')
  if (hand.length === 1) return hand[0]!

  const trump = state.trumpSuit
  const endgame = cardsLeftToDraw(state) === 0

  return state.table.length === 0
    ? chooseLead(hand, trump, endgame)
    : chooseFollow(hand, state.table, trump, endgame, state.config.players)
}

function chooseLead(hand: readonly Card[], trump: Suit, endgame: boolean): Card {
  const junk = hand.filter(c => POINTS[c.rank] === 0 && !isTrump(c, trump))
  if (junk.length > 0) {
    // Lead the weakest worthless card — cheap probe, keeps the good cards back.
    return junk.reduce((best, c) => (STRENGTH[c.rank] < STRENGTH[best.rank] ? c : best))
  }

  const nonTrump = hand.filter(c => !isTrump(c, trump))
  if (nonTrump.length > 0) {
    // Only point cards left off-suit: lead the cheapest of them.
    return cheapest(nonTrump, trump)
  }

  // All trumps. In the endgame the high trumps are guaranteed winners, so lead
  // them; earlier, keep them back and lead the weakest.
  return endgame
    ? hand.reduce((best, c) => (STRENGTH[c.rank] > STRENGTH[best.rank] ? c : best))
    : hand.reduce((best, c) => (STRENGTH[c.rank] < STRENGTH[best.rank] ? c : best))
}

function chooseFollow(
  hand: readonly Card[],
  plays: readonly TableCard[],
  trump: Suit,
  endgame: boolean,
  players: number,
): Card {
  // What is already on the table is what we stand to win — or hand over.
  const pot = totalPoints(plays.map(p => p.card))
  const winners = hand.filter(c => wouldTake(c, plays, trump))
  // Taking is safer when nobody plays after us; otherwise a later seat may
  // still take the trick and everything we add to it.
  const lastToPlay = plays.length === players - 1

  if (winners.length > 0) {
    // Cheapest card that wins, preferring to win in the led suit over burning
    // a trump.
    const ledSuit = plays[0]!.card.suit
    const sameSuit = winners.filter(c => c.suit === ledSuit)
    const pool = sameSuit.length > 0 ? sameSuit : winners
    const takeIt = pool.reduce((best, c) => (keepValue(c, trump) < keepValue(best, trump) ? c : best))

    // Worth taking? Always in the endgame (every trick is points in the bank),
    // otherwise only if the pot justifies what we spend on it.
    const cost = POINTS[takeIt.rank]
    const worthIt = endgame || pot >= 10 || (pot > 0 && cost <= pot) || !isTrump(takeIt, trump)
    if (worthIt && (lastToPlay || !isTrump(takeIt, trump) || pot >= 10)) {
      return takeIt
    }
  }

  // Can't win it, or not worth winning: throw away the least useful card.
  // Never discard a trump if there is any alternative.
  const nonTrump = hand.filter(c => !isTrump(c, trump))
  return cheapest(nonTrump.length > 0 ? nonTrump : hand, trump)
}
