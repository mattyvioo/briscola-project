import { POINTS, STRENGTH, totalPoints, type Card, type Suit } from './deck'
import { cardsLeftToDraw, type GameState, type TableCard } from './engine'
import { trickWinnerOf, wouldTake, type Seat } from './rules'
import { areAllies, buildDeck } from './table'

/**
 * The computer opponent.
 *
 * Three layers, each of which can be turned off by difficulty:
 *
 *   - the heuristics a decent casual player follows (don't waste trumps, take
 *     with the cheapest card that wins, lead rubbish);
 *   - card counting, so it knows which point cards are still out;
 *   - partner play, without which four-handed Briscola is nonsense — trumping
 *     your own partner's winning trick looks broken to anyone watching.
 */

export type Difficulty = 'easy' | 'normal' | 'hard'
export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard']

export function isDifficulty(value: unknown): value is Difficulty {
  return value === 'easy' || value === 'normal' || value === 'hard'
}

/** Value of a card as a thing to *keep*: its points, plus a bonus for trumps. */
function keepValue(card: Card, trump: Suit): number {
  const base = POINTS[card.rank] + STRENGTH[card.rank] * 0.1
  return card.suit === trump ? base + 12 : base
}

function cheapest(cards: readonly Card[], trump: Suit): Card {
  return cards.reduce((best, c) => (keepValue(c, trump) < keepValue(best, trump) ? c : best))
}

function dearest(cards: readonly Card[], trump: Suit): Card {
  return cards.reduce((best, c) => (keepValue(c, trump) > keepValue(best, trump) ? c : best))
}

function isTrump(card: Card, trump: Suit): boolean {
  return card.suit === trump
}

/**
 * Cards this seat has not seen: still in the stock, or in someone else's hand.
 *
 * Everything captured, everything on the table and everything in our own hand
 * is accounted for; whatever is left is what can still beat us. The face-up
 * briscola counts as seen while it sits there.
 */
export function unseenFrom(state: GameState, seat: Seat): Card[] {
  const seen = new Set<string>()
  for (const pile of state.piles) for (const c of pile) seen.add(c.id)
  for (const p of state.table) seen.add(p.card.id)
  for (const c of state.hands[seat] ?? []) seen.add(c.id)
  if (!state.trumpTaken) seen.add(state.trumpCard.id)

  return buildDeck(state.config).filter(c => !seen.has(c.id))
}

/** Whether a card that beats the current trick can still appear after us. */
function anyoneLeftCanBeat(
  state: GameState,
  seat: Seat,
  plays: readonly TableCard[],
  candidate: Card,
): boolean {
  const yetToPlay = state.config.players - plays.length - 1
  if (yetToPlay <= 0) return false

  const provisional = [...plays, { seat, card: candidate }]
  return unseenFrom(state, seat).some(c => wouldTake(c, provisional, state.trumpSuit))
}

export function chooseCard(
  state: GameState,
  seat: Seat,
  difficulty: Difficulty = 'normal',
): Card {
  const hand = state.hands[seat] ?? []
  if (hand.length === 0) throw new Error('AI has no cards')
  if (hand.length === 1) return hand[0]!

  const trump = state.trumpSuit

  // Easy plays almost at random, but still never throws away a good card for
  // nothing — a bot that discards its Asso feels broken rather than weak.
  if (difficulty === 'easy') {
    const junk = hand.filter(c => POINTS[c.rank] === 0)
    const pool = junk.length > 0 ? junk : hand
    return pool[Math.floor(Math.random() * pool.length)]!
  }

  const endgame = cardsLeftToDraw(state) === 0

  return state.table.length === 0
    ? chooseLead(state, seat, hand, trump, endgame, difficulty)
    : chooseFollow(state, seat, hand, state.table, trump, endgame, difficulty)
}

function chooseLead(
  state: GameState,
  seat: Seat,
  hand: readonly Card[],
  trump: Suit,
  endgame: boolean,
  difficulty: Difficulty,
): Card {
  // Late on, a trump nobody can beat is a free trick — cash it.
  if (difficulty === 'hard' && endgame) {
    const unbeatable = hand.filter(c => !anyoneLeftCanBeat(state, seat, [], c))
    if (unbeatable.length > 0) return dearest(unbeatable, trump)
  }

  const junk = hand.filter(c => POINTS[c.rank] === 0 && !isTrump(c, trump))
  if (junk.length > 0) {
    // Lead the weakest worthless card — cheap probe, keeps the good cards back.
    return junk.reduce((best, c) => (STRENGTH[c.rank] < STRENGTH[best.rank] ? c : best))
  }

  const nonTrump = hand.filter(c => !isTrump(c, trump))
  if (nonTrump.length > 0) return cheapest(nonTrump, trump)

  return endgame
    ? hand.reduce((best, c) => (STRENGTH[c.rank] > STRENGTH[best.rank] ? c : best))
    : hand.reduce((best, c) => (STRENGTH[c.rank] < STRENGTH[best.rank] ? c : best))
}

function chooseFollow(
  state: GameState,
  seat: Seat,
  hand: readonly Card[],
  plays: readonly TableCard[],
  trump: Suit,
  endgame: boolean,
  difficulty: Difficulty,
): Card {
  const pot = totalPoints(plays.map(p => p.card))
  const winners = hand.filter(c => wouldTake(c, plays, trump))
  const lastToPlay = plays.length === state.config.players - 1

  // Who is taking it as things stand, and are they on our side?
  const leader = trickWinnerOf(plays, trump)
  const partnerWinning = areAllies(state.config, seat, leader) && leader !== seat

  if (partnerWinning) {
    // Never take a trick off your own partner. If their win is safe, throw the
    // points onto it ("carico"); if someone after us might still steal it,
    // don't hand them a present.
    const theirWinIsSafe =
      lastToPlay || difficulty !== 'hard' || !anyoneLeftCanBeat(state, seat, plays, cheapestJunk(hand, trump))

    if (theirWinIsSafe) {
      const nonTrump = hand.filter(c => !isTrump(c, trump))
      const pool = nonTrump.length > 0 ? nonTrump : hand
      const loaded = pool.filter(c => POINTS[c.rank] > 0)
      if (loaded.length > 0) return dearest(loaded, trump)
      return cheapest(pool, trump)
    }
    return cheapestJunk(hand, trump)
  }

  if (winners.length > 0) {
    // Cheapest card that wins, preferring to win in the led suit over burning
    // a trump.
    const ledSuit = plays[0]!.card.suit
    const sameSuit = winners.filter(c => c.suit === ledSuit)
    const pool = sameSuit.length > 0 ? sameSuit : winners
    const takeIt = pool.reduce((best, c) => (keepValue(c, trump) < keepValue(best, trump) ? c : best))

    // Winning into a seat that can still overtake us just donates the card.
    const wouldStick =
      lastToPlay || difficulty !== 'hard' || !anyoneLeftCanBeat(state, seat, plays, takeIt)

    const cost = POINTS[takeIt.rank]
    const worthIt = endgame || pot >= 10 || (pot > 0 && cost <= pot) || !isTrump(takeIt, trump)

    if (worthIt && wouldStick && (lastToPlay || !isTrump(takeIt, trump) || pot >= 10)) {
      return takeIt
    }
  }

  return cheapestJunk(hand, trump)
}

/** The least useful card to let go of: never a trump if there is a choice. */
function cheapestJunk(hand: readonly Card[], trump: Suit): Card {
  const nonTrump = hand.filter(c => !isTrump(c, trump))
  return cheapest(nonTrump.length > 0 ? nonTrump : hand, trump)
}
