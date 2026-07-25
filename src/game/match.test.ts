import { describe, expect, it } from 'vitest'
import {
  isMatchFormat,
  matchScores,
  matchTarget,
  newMatch,
  recordHand,
  type MatchFormat,
  type MatchState,
} from './match'
import { tableFor } from './table'
import { TOTAL_POINTS } from './rules'

const two = tableFor(2)
const three = tableFor(3)

/** Feeds a sequence of hand results in, as [teamA, teamB] card points. */
function playHands(format: MatchFormat, hands: number[][], config = two): MatchState {
  let m = newMatch(format, config.teams.length)
  for (const points of hands) {
    if (m.decided) break
    m = recordHand(m, config, points)
  }
  return m
}

describe('single hand', () => {
  it('is decided by the one hand played', () => {
    const m = playHands({ kind: 'single' }, [[70, 50]])
    expect(m.decided).toBe(true)
    expect(m.winners).toEqual([0])
  })
})

describe('best of N', () => {
  const bestOf3: MatchFormat = { kind: 'bestOf', target: 2 }

  it('needs two hands to take a best of three', () => {
    const after1 = playHands(bestOf3, [[70, 50]])
    expect(after1.decided).toBe(false)
    expect(after1.handsWon).toEqual([1, 0])

    const after2 = playHands(bestOf3, [[70, 50], [80, 40]])
    expect(after2.decided).toBe(true)
    expect(after2.winners).toEqual([0])
  })

  it('goes to a decider when the hands are split', () => {
    const m = playHands(bestOf3, [[70, 50], [40, 80], [65, 55]])
    expect(m.decided).toBe(true)
    expect(m.winners).toEqual([0])
    expect(m.handsWon).toEqual([2, 1])
  })

  it('counts a 60-60 hand for nobody', () => {
    const m = playHands(bestOf3, [[60, 60], [60, 60]])
    expect(m.handsWon).toEqual([0, 0])
    expect(m.decided).toBe(false)
    // A drawn hand still moves the match on, so it cannot loop forever.
    expect(m.handNumber).toBe(3)
  })

  it('always terminates', () => {
    // Whoever wins, five hands is the most a best-of-three can need.
    for (const seed of [0, 1, 2, 3]) {
      const hands = Array.from({ length: 10 }, (_, i) =>
        (i + seed) % 2 === 0 ? [70, 50] : [50, 70],
      )
      const m = playHands({ kind: 'bestOf', target: 2 }, hands)
      expect(m.decided).toBe(true)
      expect(m.handNumber).toBeLessThanOrEqual(6)
    }
  })
})

describe('points target', () => {
  const to301: MatchFormat = { kind: 'points', target: 301 }

  it('accumulates card points across hands', () => {
    const m = playHands(to301, [[70, 50], [80, 40]])
    expect(m.points).toEqual([150, 90])
    expect(m.decided).toBe(false)
  })

  it('ends once someone crosses the target', () => {
    const m = playHands(to301, [[100, 20], [100, 20], [100, 20], [100, 20]])
    expect(m.decided).toBe(true)
    expect(m.winners).toEqual([0])
    expect(m.points[0]).toBeGreaterThanOrEqual(301)
  })

  it('calls it a draw when two sides cross together on level points', () => {
    // Both reach exactly 300 then split the next hand evenly.
    const m = playHands(to301, [
      [60, 60], [60, 60], [60, 60], [60, 60], [60, 60], [60, 60],
    ])
    expect(m.points).toEqual([360, 360])
    expect(m.decided).toBe(true)
    expect(m.winners).toEqual([0, 1])
  })

  it('conserves 120 points per hand', () => {
    const m = playHands(to301, [[70, 50], [80, 40], [60, 60]])
    expect(m.points.reduce((a, b) => a + b, 0)).toBe(3 * TOTAL_POINTS)
  })
})

describe('three-handed matches', () => {
  it('gives the hand to the highest scorer, with no majority needed', () => {
    const m = playHands({ kind: 'bestOf', target: 2 }, [[50, 40, 30]], three)
    expect(m.handsWon).toEqual([1, 0, 0])
  })

  it('gives a tied hand to nobody', () => {
    const m = playHands({ kind: 'bestOf', target: 2 }, [[50, 50, 20]], three)
    expect(m.handsWon).toEqual([0, 0, 0])
  })
})

describe('reporting', () => {
  it('shows hands won for a bestOf and points for a points race', () => {
    const bo = playHands({ kind: 'bestOf', target: 3 }, [[70, 50]])
    expect(matchScores(bo)).toEqual([1, 0])

    const pts = playHands({ kind: 'points', target: 301 }, [[70, 50]])
    expect(matchScores(pts)).toEqual([70, 50])
  })

  it('reports the target being raced towards', () => {
    expect(matchTarget({ kind: 'single' })).toBeNull()
    expect(matchTarget({ kind: 'bestOf', target: 2 })).toBe(2)
    expect(matchTarget({ kind: 'points', target: 301 })).toBe(301)
  })
})

describe('validation', () => {
  it('accepts the offered formats', () => {
    expect(isMatchFormat({ kind: 'single' })).toBe(true)
    expect(isMatchFormat({ kind: 'bestOf', target: 2 })).toBe(true)
    expect(isMatchFormat({ kind: 'points', target: 1001 })).toBe(true)
  })

  it('rejects anything else a peer might send', () => {
    // A hostile peer could otherwise ask for a match that never ends.
    expect(isMatchFormat({ kind: 'points', target: 10_000_000 })).toBe(false)
    expect(isMatchFormat({ kind: 'bestOf', target: 999 })).toBe(false)
    expect(isMatchFormat({ kind: 'nonsense' })).toBe(false)
    expect(isMatchFormat(null)).toBe(false)
    expect(isMatchFormat('single')).toBe(false)
  })
})
