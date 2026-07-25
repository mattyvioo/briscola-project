/**
 * The 40-card Italian deck used by Briscola.
 *
 * Ranks run 1..10, where 8/9/10 are the court cards:
 *   8 = Fante (jack), 9 = Cavallo (knight), 10 = Re (king).
 */

export const SUITS = ['denari', 'coppe', 'spade', 'bastoni'] as const
export type Suit = (typeof SUITS)[number]

export const RANKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const
export type Rank = (typeof RANKS)[number]

export type CardId = `${Suit}-${Rank}`

export interface Card {
  readonly suit: Suit
  readonly rank: Rank
  readonly id: CardId
}

/**
 * Card point values. The Asso and the Tre carry most of the deck; everything
 * from 2 to 7 is worthless ("scartine"). The whole deck sums to 120.
 */
export const POINTS: Readonly<Record<Rank, number>> = {
  1: 11, // Asso
  3: 10, // Tre
  10: 4, // Re
  9: 3, // Cavallo
  8: 2, // Fante
  2: 0,
  4: 0,
  5: 0,
  6: 0,
  7: 0,
}

/**
 * Trick-taking order, high to low: 1, 3, 10, 9, 8, 7, 6, 5, 4, 2.
 * Note this is *not* the same order as the point values — the 3 beats the Re
 * but the 7 beats nothing that matters.
 */
export const STRENGTH: Readonly<Record<Rank, number>> = {
  1: 10,
  3: 9,
  10: 8,
  9: 7,
  8: 6,
  7: 5,
  6: 4,
  5: 3,
  4: 2,
  2: 1,
}

export function cardId(suit: Suit, rank: Rank): CardId {
  return `${suit}-${rank}`
}

export function makeCard(suit: Suit, rank: Rank): Card {
  return { suit, rank, id: cardId(suit, rank) }
}

/** Parses a CardId back into a Card. Throws on malformed input. */
export function parseCard(id: CardId): Card {
  const dash = id.lastIndexOf('-')
  const suit = id.slice(0, dash) as Suit
  const rank = Number(id.slice(dash + 1)) as Rank
  if (!SUITS.includes(suit) || !RANKS.includes(rank)) {
    throw new Error(`Not a valid card id: "${id}"`)
  }
  return { suit, rank, id }
}

/** A fresh, ordered 40-card deck. */
export function freshDeck(): Card[] {
  return SUITS.flatMap(suit => RANKS.map(rank => makeCard(suit, rank)))
}

export function points(card: Card): number {
  return POINTS[card.rank]
}

export function totalPoints(cards: readonly Card[]): number {
  return cards.reduce((sum, c) => sum + POINTS[c.rank], 0)
}

// Display concerns — card names, artwork paths, suit pips — depend on the
// chosen deck style and live in ./decks.ts. This module stays purely about the
// rules.
