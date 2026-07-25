import { describe, expect, it } from 'vitest'
import { freshDeck, makeCard, totalPoints, type Card } from './deck'
import { cardsLeftToDraw, newGame, play, score, type GameState } from './engine'
import { chooseCard } from './ai'
import { other, outcomeFor, trickWinner, TOTAL_POINTS, type Seat } from './rules'

const c = makeCard

describe('deck', () => {
  it('has 40 distinct cards', () => {
    const deck = freshDeck()
    expect(deck).toHaveLength(40)
    expect(new Set(deck.map(x => x.id)).size).toBe(40)
  })

  it('is worth exactly 120 points', () => {
    expect(totalPoints(freshDeck())).toBe(TOTAL_POINTS)
  })

  it('gives 30 points per suit (11+10+4+3+2)', () => {
    for (const suit of ['denari', 'coppe', 'spade', 'bastoni'] as const) {
      expect(totalPoints(freshDeck().filter(x => x.suit === suit))).toBe(30)
    }
  })
})

describe('trickWinner', () => {
  const trump = 'coppe'

  it('same suit: higher strength wins', () => {
    // The 3 beats the Re, which beats the 7 — strength order, not point order.
    expect(trickWinner(c('spade', 10), c('spade', 3), trump)).toBe('follow')
    expect(trickWinner(c('spade', 3), c('spade', 10), trump)).toBe('lead')
    expect(trickWinner(c('spade', 3), c('spade', 1), trump)).toBe('follow')
    expect(trickWinner(c('spade', 7), c('spade', 2), trump)).toBe('lead')
  })

  it('follower trumps an off-suit lead', () => {
    expect(trickWinner(c('spade', 1), c('coppe', 2), trump)).toBe('follow')
  })

  it('off-suit non-trump loses to any lead', () => {
    // The lead wins even when it is the weakest card in the deck.
    expect(trickWinner(c('spade', 2), c('bastoni', 1), trump)).toBe('lead')
  })

  it('trump vs trump falls back to strength', () => {
    expect(trickWinner(c('coppe', 10), c('coppe', 3), trump)).toBe('follow')
    expect(trickWinner(c('coppe', 3), c('coppe', 10), trump)).toBe('lead')
  })

  it('a trump lead is not beaten by an off-suit card', () => {
    expect(trickWinner(c('coppe', 2), c('spade', 1), trump)).toBe('lead')
  })
})

describe('newGame', () => {
  it('deals 3 each, turns a trump, and leaves 33 in the stock', () => {
    const s = newGame(42)
    expect(s.hands[0]).toHaveLength(3)
    expect(s.hands[1]).toHaveLength(3)
    expect(s.stock).toHaveLength(33)
    expect(s.trumpSuit).toBe(s.trumpCard.suit)
    expect(s.trumpTaken).toBe(false)
  })

  it('uses all 40 cards exactly once', () => {
    const s = newGame(7)
    const all = [...s.hands[0]!, ...s.hands[1]!, ...s.stock, s.trumpCard]
    expect(all).toHaveLength(40)
    expect(new Set(all.map(x => x.id)).size).toBe(40)
  })

  it('lets the non-dealer lead', () => {
    expect(newGame(1, 0).turn).toBe(1)
    expect(newGame(1, 1).turn).toBe(0)
  })

  it('is deterministic for a given seed', () => {
    expect(newGame(99).hands[0]!.map(x => x.id)).toEqual(newGame(99).hands[0]!.map(x => x.id))
    expect(newGame(99).hands[0]!.map(x => x.id)).not.toEqual(newGame(100).hands[0]!.map(x => x.id))
  })
})

describe('play', () => {
  it('rejects a card the player does not hold', () => {
    const s = newGame(5)
    const notInHand = freshDeck().find(x => !s.hands[s.turn]!.some(h => h.id === x.id))!
    expect(() => play(s, s.turn, notInHand.id)).toThrow(/does not hold/)
  })

  it('rejects a move out of turn', () => {
    const s = newGame(5)
    const wrong = other(s.turn)
    expect(() => play(s, wrong, s.hands[wrong]![0]!.id)).toThrow(/turn/)
  })

  it('parks the led card and passes the turn', () => {
    const s = newGame(5)
    const leader = s.turn
    const { state, trick } = play(s, leader, s.hands[leader]![0]!.id)
    expect(trick).toBeNull()
    expect(state.table).toHaveLength(1)
    expect(state.table[0]!.seat).toBe(leader)
    expect(state.turn).toBe(other(leader))
    expect(state.hands[leader]).toHaveLength(2)
  })

  it('awards the trick and refills both hands to 3', () => {
    let s = newGame(5)
    const leader = s.turn
    s = play(s, leader, s.hands[leader]![0]!.id).state
    const follower = s.turn
    const res = play(s, follower, s.hands[follower]![0]!.id)

    expect(res.trick).not.toBeNull()
    expect(res.state.table).toHaveLength(0)
    expect(res.state.turn).toBe(res.trick!.winner)
    expect(res.state.piles[res.trick!.winner]).toHaveLength(2) // 2p: team index == seat
    expect(res.state.hands[0]).toHaveLength(3)
    expect(res.state.hands[1]).toHaveLength(3)
    expect(res.state.stock).toHaveLength(31)
  })

  it('draws winner-first', () => {
    let s = newGame(11)
    const leader = s.turn
    s = play(s, leader, s.hands[leader]![0]!.id).state
    const res = play(s, s.turn, s.hands[s.turn]![0]!.id)
    expect(res.trick!.drawn[0]!.seat).toBe(res.trick!.winner)
    expect(res.trick!.drawn[1]!.seat).toBe(other(res.trick!.winner))
  })
})

/** Plays a game to completion with the AI on both seats. */
function playOut(seed: number, dealer: Seat = 0) {
  let s = newGame(seed, dealer)
  const tricks: { winner: Seat; states: GameState }[] = []
  let guard = 0

  while (s.phase === 'playing') {
    if (guard++ > 100) throw new Error('game did not terminate')
    const seat = s.turn
    const card = chooseCard(s, seat)
    // The AI must only ever pick from its own hand.
    expect(s.hands[seat]!.some(x => x.id === card.id)).toBe(true)
    const res = play(s, seat, card.id)
    s = res.state
    if (res.trick) tricks.push({ winner: res.trick.winner, states: s })
  }
  return { state: s, tricks }
}

describe('a full game', () => {
  it('runs exactly 20 tricks', () => {
    const { tricks } = playOut(2024)
    expect(tricks).toHaveLength(20)
  })

  it('conserves all 120 points', () => {
    const { state } = playOut(2024)
    expect(score(state, 0) + score(state, 1)).toBe(TOTAL_POINTS)
    expect(state.piles[0]!.length + state.piles[1]!.length).toBe(40)
  })

  it('empties the stock and hands out the trump card by the end', () => {
    const { state } = playOut(2024)
    expect(state.stock).toHaveLength(0)
    expect(state.trumpTaken).toBe(true)
    expect(cardsLeftToDraw(state)).toBe(0)
    expect(state.hands[0]).toHaveLength(0)
    expect(state.hands[1]).toHaveLength(0)
  })

  it('gives the trump card to the loser of trick 17', () => {
    let s = newGame(2024)
    let trickNo = 0
    let trumpTakenBy: Seat | null = null
    let trick17Loser: Seat | null = null

    while (s.phase === 'playing') {
      const res = play(s, s.turn, chooseCard(s, s.turn).id)
      if (res.trick) {
        trickNo++
        const gotTrump = res.trick.drawn.find(d => d.card.id === s.trumpCard.id)
        if (gotTrump) {
          trumpTakenBy = gotTrump.seat
          expect(trickNo).toBe(17)
          trick17Loser = other(res.trick.winner)
        }
      }
      s = res.state
    }

    expect(trumpTakenBy).not.toBeNull()
    expect(trumpTakenBy).toBe(trick17Loser)
  })

  it('leaves 3 cards each after the stock runs out', () => {
    let s = newGame(777)
    let trickNo = 0
    while (s.phase === 'playing') {
      const res = play(s, s.turn, chooseCard(s, s.turn).id)
      if (res.trick) {
        trickNo++
        if (trickNo === 17) {
          expect(res.state.stock).toHaveLength(0)
          expect(res.state.trumpTaken).toBe(true)
          expect(res.state.hands[0]).toHaveLength(3)
          expect(res.state.hands[1]).toHaveLength(3)
        }
      }
      s = res.state
    }
    expect(trickNo).toBe(20)
  })
})

describe('scoring', () => {
  it('needs 61 to win and calls 60-60 a draw', () => {
    expect(outcomeFor(61)).toBe('win')
    expect(outcomeFor(120)).toBe('win')
    expect(outcomeFor(60)).toBe('draw')
    expect(outcomeFor(59)).toBe('loss')
    expect(outcomeFor(0)).toBe('loss')
  })
})

describe('fuzz: 1000 AI self-play games', () => {
  it('always terminates in 20 tricks conserving 120 points', () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const dealer: Seat = (seed % 2) as Seat
      const { state, tricks } = playOut(seed, dealer)

      expect(tricks, `seed ${seed}`).toHaveLength(20)
      expect(score(state, 0) + score(state, 1), `seed ${seed}`).toBe(TOTAL_POINTS)

      // Every card accounted for, none duplicated.
      const played: Card[] = [...state.piles[0]!, ...state.piles[1]!]
      expect(new Set(played.map(x => x.id)).size, `seed ${seed}`).toBe(40)
    }
  })
})
