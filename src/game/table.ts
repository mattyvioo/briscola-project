import { freshDeck, type Card, type Rank, type Suit } from './deck'

/**
 * Everything that varies with the number of players.
 *
 * The deal is always the same shape — 3 cards each, the next card face up as
 * the briscola, the rest as stock — and it happens to work out that for 2, 3
 * and 4 players the draws divide evenly *and* the last three tricks are played
 * from an empty stock. That invariant is what keeps one engine able to run all
 * three.
 *
 *   players  deck  dealt  stock  draw rounds  tricks
 *      2      40     6     33        17         20
 *      3      39     9     29        10         13
 *      4      40    12     27         7         10
 */

export type PlayerCount = 2 | 3 | 4

export const PLAYER_COUNTS: readonly PlayerCount[] = [2, 3, 4]

export const HAND_SIZE = 3

/** Seats belonging to one side. Teams are indexed by their position here. */
export type Team = readonly number[]

export interface TableConfig {
  readonly players: PlayerCount
  /** 40, or 39 for three players — see `buildDeck`. */
  readonly deckSize: number
  readonly tricks: number
  /** Partition of the seats. Solo play gives every seat its own team. */
  readonly teams: readonly Team[]
  /**
   * Whether taking more than half the points wins outright.
   *
   * With two sides that is the familiar "61 wins, 60-60 is a pareggio". With
   * three players there is no majority to reach, so the most points simply
   * wins and ties are possible.
   */
  readonly hasMajorityThreshold: boolean
}

export const TABLES: Readonly<Record<PlayerCount, TableConfig>> = {
  2: {
    players: 2,
    deckSize: 40,
    tricks: 20,
    teams: [[0], [1]],
    hasMajorityThreshold: true,
  },
  3: {
    players: 3,
    deckSize: 39,
    tricks: 13,
    teams: [[0], [1], [2]],
    hasMajorityThreshold: false,
  },
  4: {
    players: 4,
    deckSize: 40,
    tricks: 10,
    // Partners sit opposite each other, as at a real table.
    teams: [[0, 2], [1, 3]],
    hasMajorityThreshold: true,
  },
}

export function tableFor(players: PlayerCount): TableConfig {
  return TABLES[players]
}

export function isPlayerCount(value: unknown): value is PlayerCount {
  return value === 2 || value === 3 || value === 4
}

/**
 * The deck for a given table.
 *
 * Three-handed Briscola drops one card so 39 divides by three. It is always a
 * **2** — worth nothing — so the deck is still worth 120 points and every
 * scoring rule carries over untouched.
 */
export const THREE_PLAYER_REMOVED: { suit: Suit; rank: Rank } = {
  suit: 'denari',
  rank: 2,
}

export function buildDeck(config: TableConfig): Card[] {
  const deck = freshDeck()
  if (config.deckSize === deck.length) return deck
  return deck.filter(
    c => !(c.suit === THREE_PLAYER_REMOVED.suit && c.rank === THREE_PLAYER_REMOVED.rank),
  )
}

/** Which team a seat plays for. */
export function teamOf(config: TableConfig, seat: number): number {
  const index = config.teams.findIndex(t => t.includes(seat))
  if (index === -1) throw new Error(`Seat ${seat} is not at a ${config.players}-player table`)
  return index
}

/** The seat's partner, or null when they play alone. */
export function partnerOf(config: TableConfig, seat: number): number | null {
  const team = config.teams[teamOf(config, seat)]!
  return team.find(s => s !== seat) ?? null
}

export function areAllies(config: TableConfig, a: number, b: number): boolean {
  return teamOf(config, a) === teamOf(config, b)
}

/** Sanity net for the table definitions above; exercised by the tests. */
export function describeTable(config: TableConfig): string {
  const dealt = config.players * HAND_SIZE
  const stock = config.deckSize - dealt - 1
  const drawRounds = (stock + 1) / config.players
  return `${config.players}p: ${config.deckSize} cards, ${dealt} dealt, ${stock} stock, ${drawRounds} draw rounds, ${config.tricks} tricks`
}
