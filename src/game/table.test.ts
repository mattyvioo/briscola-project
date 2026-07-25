import { describe, expect, it } from 'vitest'
import { makeCard, totalPoints, type Card } from './deck'
import { chooseCard } from './ai'
import { cardsLeftToDraw, newGame, play, allTeamScores, type GameState } from './engine'
import { outcomeForTeam, trickWinnerOf, TOTAL_POINTS, type Play } from './rules'
import {
  buildDeck,
  HAND_SIZE,
  PLAYER_COUNTS,
  partnerOf,
  tableFor,
  teamOf,
  type PlayerCount,
} from './table'

const c = makeCard

describe('table configuration', () => {
  it.each(PLAYER_COUNTS)('deals evenly at %i players', players => {
    const config = tableFor(players)
    const dealt = config.players * HAND_SIZE
    const stock = config.deckSize - dealt - 1

    // Every card is either dealt, the face-up briscola, or drawn later.
    expect(dealt + 1 + stock).toBe(config.deckSize)
    // The draws must divide evenly, or somebody would be short a card.
    expect((stock + 1) % config.players).toBe(0)
    // Everyone plays every card they are dealt or draw.
    expect(config.tricks * config.players).toBe(config.deckSize)
  })

  it.each(PLAYER_COUNTS)('leaves the last 3 tricks played from hand at %i players', players => {
    const config = tableFor(players)
    const drawRounds = (config.deckSize - config.players * HAND_SIZE - 1 + 1) / config.players
    expect(config.tricks - drawRounds).toBe(HAND_SIZE)
  })

  it.each(PLAYER_COUNTS)('builds a deck worth 120 points at %i players', players => {
    const deck = buildDeck(tableFor(players))
    expect(deck).toHaveLength(tableFor(players).deckSize)
    // Three-player drops a 2, which is worth nothing, so the total is intact.
    expect(totalPoints(deck)).toBe(TOTAL_POINTS)
    expect(new Set(deck.map(x => x.id)).size).toBe(deck.length)
  })

  it('seats partners opposite each other at four players', () => {
    const four = tableFor(4)
    expect(teamOf(four, 0)).toBe(teamOf(four, 2))
    expect(teamOf(four, 1)).toBe(teamOf(four, 3))
    expect(teamOf(four, 0)).not.toBe(teamOf(four, 1))
    expect(partnerOf(four, 0)).toBe(2)
    expect(partnerOf(four, 3)).toBe(1)
  })

  it('gives every seat its own team when playing alone', () => {
    for (const players of [2, 3] as const) {
      const config = tableFor(players)
      expect(config.teams).toHaveLength(players)
      expect(partnerOf(config, 0)).toBeNull()
    }
  })
})

describe('trickWinnerOf', () => {
  const trump = 'coppe'
  const p = (seat: number, card: Card): Play => ({ seat, card })

  it('gives it to the highest card of the led suit', () => {
    expect(trickWinnerOf([p(0, c('spade', 7)), p(1, c('spade', 3)), p(2, c('spade', 2))], trump)).toBe(1)
  })

  it('lets a late trump take a trick nobody else could', () => {
    expect(trickWinnerOf([p(0, c('spade', 1)), p(1, c('spade', 3)), p(2, c('coppe', 2))], trump)).toBe(2)
  })

  it('settles two trumps in one trick by strength', () => {
    const plays = [p(0, c('spade', 1)), p(1, c('coppe', 4)), p(2, c('coppe', 10)), p(3, c('spade', 3))]
    expect(trickWinnerOf(plays, trump)).toBe(2)
  })

  it('keeps the led card when everyone throws off', () => {
    // A led 2 beats three aces of other suits — the case that surprises people.
    const plays = [
      p(0, c('spade', 2)),
      p(1, c('denari', 1)),
      p(2, c('bastoni', 1)),
      p(3, c('denari', 3)),
    ]
    expect(trickWinnerOf(plays, trump)).toBe(0)
  })

  it('is unaffected by a trump played first then out-trumped', () => {
    const plays = [p(0, c('coppe', 8)), p(1, c('coppe', 1)), p(2, c('spade', 1))]
    expect(trickWinnerOf(plays, trump)).toBe(1)
  })
})

describe('scoring', () => {
  it('needs a majority with two sides', () => {
    const two = tableFor(2)
    expect(outcomeForTeam(two, [61, 59], 0)).toBe('win')
    expect(outcomeForTeam(two, [59, 61], 0)).toBe('loss')
    expect(outcomeForTeam(two, [60, 60], 0)).toBe('draw')
  })

  it('awards three-handed play to the highest score, with ties possible', () => {
    const three = tableFor(3)
    // No majority to reach: 50 wins if it is the best.
    expect(outcomeForTeam(three, [50, 40, 30], 0)).toBe('win')
    expect(outcomeForTeam(three, [50, 40, 30], 1)).toBe('loss')
    expect(outcomeForTeam(three, [50, 50, 20], 0)).toBe('draw')
    expect(outcomeForTeam(three, [50, 50, 20], 2)).toBe('loss')
  })
})

/** Plays a whole game with the AI in every seat. */
function playOut(seed: number, players: PlayerCount, dealer = 0) {
  let s: GameState = newGame(seed, dealer, players)
  let tricks = 0
  let guard = 0
  const handSizesWhenStockEmpty: number[] = []

  while (s.phase === 'playing') {
    if (guard++ > 500) throw new Error('game did not terminate')
    const seat = s.turn
    const card = chooseCard(s, seat)
    expect(s.hands[seat]!.some(x => x.id === card.id)).toBe(true)
    const res = play(s, seat, card.id)
    s = res.state
    if (res.trick) {
      tricks++
      if (cardsLeftToDraw(s) === 0 && handSizesWhenStockEmpty.length === 0) {
        handSizesWhenStockEmpty.push(...s.hands.map(h => h.length))
      }
    }
  }
  return { state: s, tricks, handSizesWhenStockEmpty }
}

describe.each(PLAYER_COUNTS)('a full %i-player game', players => {
  const config = tableFor(players)

  it(`runs exactly ${config.tricks} tricks`, () => {
    expect(playOut(2024, players).tricks).toBe(config.tricks)
  })

  it('conserves all 120 points across the teams', () => {
    const { state } = playOut(2024, players)
    const scores = allTeamScores(state)
    expect(scores.reduce((a, b) => a + b, 0)).toBe(TOTAL_POINTS)
    expect(state.piles.reduce((n, p) => n + p.length, 0)).toBe(config.deckSize)
  })

  it('empties the stock and hands out the briscola', () => {
    const { state } = playOut(2024, players)
    expect(state.stock).toHaveLength(0)
    expect(state.trumpTaken).toBe(true)
    expect(state.hands.every(h => h.length === 0)).toBe(true)
  })

  it('leaves everyone holding 3 cards when the stock runs out', () => {
    const { handSizesWhenStockEmpty } = playOut(777, players)
    expect(handSizesWhenStockEmpty).toEqual(Array(players).fill(HAND_SIZE))
  })

  it('deals every card exactly once', () => {
    const s = newGame(11, 0, players)
    const all = [...s.hands.flatMap(h => [...h]), ...s.stock, s.trumpCard]
    expect(all).toHaveLength(config.deckSize)
    expect(new Set(all.map(x => x.id)).size).toBe(config.deckSize)
  })

  it('starts with the player to the dealer’s left', () => {
    for (let dealer = 0; dealer < players; dealer++) {
      expect(newGame(1, dealer, players).turn).toBe((dealer + 1) % players)
    }
  })
})

describe('fuzz: AI self-play at every table size', () => {
  it.each(PLAYER_COUNTS)('%i players — 300 seeds all terminate cleanly', players => {
    const config = tableFor(players)
    for (let seed = 1; seed <= 300; seed++) {
      const { state, tricks } = playOut(seed, players, seed % players)
      expect(tricks, `seed ${seed}`).toBe(config.tricks)
      const scores = allTeamScores(state)
      expect(scores.reduce((a, b) => a + b, 0), `seed ${seed}`).toBe(TOTAL_POINTS)
      const played = state.piles.flatMap(p => [...p])
      expect(new Set(played.map(x => x.id)).size, `seed ${seed}`).toBe(config.deckSize)
    }
  })
})
