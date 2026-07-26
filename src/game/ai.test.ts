import { describe, expect, it } from 'vitest'
import { chooseCard, unseenFrom, DIFFICULTIES, isDifficulty, type Difficulty } from './ai'
import { makeCard, POINTS, type Card } from './deck'
import { newGame, play, allTeamScores, type GameState } from './engine'
import { areAllies, PLAYER_COUNTS, tableFor, teamOf, type PlayerCount } from './table'
import { TOTAL_POINTS, trickWinnerOf } from './rules'

const c = makeCard

/**
 * Builds a state with chosen hands and a chosen trick in progress, so the AI's
 * decision can be examined in isolation.
 */
function rig(opts: {
  players: PlayerCount
  trump: Card
  hands: Card[][]
  table?: { seat: number; card: Card }[]
  turn: number
}): GameState {
  const base = newGame(1, 0, opts.players)
  return {
    ...base,
    hands: opts.hands,
    table: opts.table ?? [],
    turn: opts.turn,
    leader: opts.table?.[0]?.seat ?? opts.turn,
    trumpCard: opts.trump,
    trumpSuit: opts.trump.suit,
    // Empty the stock so these are endgame-free decisions unless stated.
    stock: base.stock,
  }
}

describe('partner play at four', () => {
  const four = tableFor(4)

  it('seats 0 and 2 are partners, 1 and 3 are not', () => {
    expect(areAllies(four, 0, 2)).toBe(true)
    expect(areAllies(four, 0, 1)).toBe(false)
  })

  it('never trumps a trick the partner is already winning', () => {
    // Seat 2 (our partner) leads the Asso di spade and is winning. We are seat
    // 0, last to play, holding a trump that would take it off them.
    const state = rig({
      players: 4,
      trump: c('coppe', 5),
      turn: 0,
      hands: [
        [c('coppe', 1), c('denari', 4), c('bastoni', 6)],
        [],
        [],
        [],
      ],
      table: [
        { seat: 1, card: c('spade', 4) },
        { seat: 2, card: c('spade', 1) },
        { seat: 3, card: c('spade', 2) },
      ],
    })

    // Seat 2 is indeed taking it before we play.
    expect(trickWinnerOf(state.table, state.trumpSuit)).toBe(2)

    const chosen = chooseCard(state, 0, 'normal')
    expect(chosen.suit, 'took the trick off its own partner').not.toBe('coppe')
  })

  it('throws points onto a partner’s safe trick', () => {
    // Partner (seat 2) is winning and we play last, so nobody can steal it.
    const state = rig({
      players: 4,
      trump: c('coppe', 5),
      turn: 0,
      hands: [
        [c('denari', 1), c('denari', 4), c('bastoni', 6)],
        [],
        [],
        [],
      ],
      table: [
        { seat: 1, card: c('spade', 4) },
        { seat: 2, card: c('spade', 1) },
        { seat: 3, card: c('spade', 2) },
      ],
    })

    const chosen = chooseCard(state, 0, 'normal')
    // The Asso di denari is worth 11 and is safe to give away to our own side.
    expect(POINTS[chosen.rank]).toBeGreaterThan(0)
    expect(chosen.id).toBe('denari-1')
  })

  it('still fights for a trick an opponent is winning', () => {
    // Seat 1 (an opponent) is winning with a loaded trick; we should take it.
    const state = rig({
      players: 4,
      trump: c('coppe', 5),
      turn: 0,
      hands: [
        [c('coppe', 4), c('denari', 4), c('bastoni', 6)],
        [],
        [],
        [],
      ],
      table: [
        { seat: 1, card: c('spade', 1) },
        { seat: 2, card: c('spade', 4) },
        { seat: 3, card: c('spade', 3) },
      ],
    })

    expect(trickWinnerOf(state.table, state.trumpSuit)).toBe(1)
    const chosen = chooseCard(state, 0, 'normal')
    expect(chosen.suit, 'let 21 points go without trumping').toBe('coppe')
  })
})

describe('card counting', () => {
  it('counts only what this seat cannot see', () => {
    const state = newGame(5, 0, 2)
    const unseen = unseenFrom(state, 0)
    const mine = new Set((state.hands[0] ?? []).map(x => x.id))

    // Never our own cards, never the face-up briscola.
    for (const card of unseen) {
      expect(mine.has(card.id)).toBe(false)
      expect(card.id).not.toBe(state.trumpCard.id)
    }
    // 40 cards, minus our 3 and the face-up trump.
    expect(unseen).toHaveLength(36)
  })

  it('shrinks as cards are played', () => {
    let state = newGame(5, 0, 2)
    const before = unseenFrom(state, 0).length
    const leader = state.turn
    state = play(state, leader, state.hands[leader]![0]!.id).state
    const follower = state.turn
    state = play(state, follower, state.hands[follower]![0]!.id).state
    // Both played cards are now visible to seat 0 (one was already its own).
    expect(unseenFrom(state, 0).length).toBeLessThan(before)
  })

  it('uses the 39-card deck when three are playing', () => {
    const state = newGame(5, 0, 3)
    // 39 total, minus our 3 and the face-up trump.
    expect(unseenFrom(state, 0)).toHaveLength(35)
    expect(unseenFrom(state, 0).some(x => x.id === 'denari-2')).toBe(false)
  })
})

describe('difficulty', () => {
  it('validates the offered levels', () => {
    for (const d of DIFFICULTIES) expect(isDifficulty(d)).toBe(true)
    expect(isDifficulty('impossible')).toBe(false)
    expect(isDifficulty(null)).toBe(false)
  })

  it('easy still refuses to throw away a point card for nothing', () => {
    const state = rig({
      players: 2,
      trump: c('coppe', 5),
      turn: 0,
      hands: [[c('denari', 1), c('bastoni', 4), c('spade', 6)], []],
    })
    // Over many deals it must never lead the Asso when junk is available.
    for (let i = 0; i < 60; i++) {
      expect(POINTS[chooseCard(state, 0, 'easy').rank]).toBe(0)
    }
  })
})

/** Plays a whole game with a chosen difficulty in every seat. */
function playOut(seed: number, players: PlayerCount, difficulty: Difficulty) {
  let s = newGame(seed, 0, players)
  let guard = 0
  while (s.phase === 'playing') {
    if (guard++ > 500) throw new Error('game did not terminate')
    const seat = s.turn
    const card = chooseCard(s, seat, difficulty)
    expect(s.hands[seat]!.some(x => x.id === card.id)).toBe(true)
    s = play(s, seat, card.id).state
  }
  return s
}

describe('fuzz across difficulties and table sizes', () => {
  const cases = PLAYER_COUNTS.flatMap(p => DIFFICULTIES.map(d => [p, d] as const))

  it.each(cases)('%i players on %s terminates with 120 points', (players, difficulty) => {
    for (let seed = 1; seed <= 60; seed++) {
      const state = playOut(seed, players, difficulty)
      const scores = allTeamScores(state)
      expect(scores.reduce((a, b) => a + b, 0), `seed ${seed}`).toBe(TOTAL_POINTS)
      expect(state.hands.every(h => h.length === 0)).toBe(true)
    }
  })
})

describe('hard beats easy over a series', () => {
  it('wins the majority of 2-player games', () => {
    let hardWins = 0
    let easyWins = 0

    for (let seed = 1; seed <= 80; seed++) {
      let s = newGame(seed, seed % 2, 2)
      let guard = 0
      while (s.phase === 'playing') {
        if (guard++ > 200) throw new Error('stalled')
        const seat = s.turn
        // Seat 0 is hard, seat 1 is easy.
        const card = chooseCard(s, seat, seat === 0 ? 'hard' : 'easy')
        s = play(s, seat, card.id).state
      }
      const [a = 0, b = 0] = allTeamScores(s)
      if (a > b) hardWins++
      else if (b > a) easyWins++
    }

    // Not a strict guarantee of every game, but the stronger player must come
    // out clearly ahead or the difficulty setting is meaningless.
    expect(hardWins, `hard ${hardWins} vs easy ${easyWins}`).toBeGreaterThan(easyWins)
  })
})

describe('teams', () => {
  it('scores four-handed play by team, not by seat', () => {
    const state = playOut(2024, 4, 'normal')
    const scores = allTeamScores(state)
    expect(scores).toHaveLength(2)
    expect(scores.reduce((a, b) => a + b, 0)).toBe(TOTAL_POINTS)
    expect(teamOf(state.config, 0)).toBe(teamOf(state.config, 2))
  })
})
