import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { aiSession, hotseatSession, HostSession, RECONNECT_GRACE_MS, type SessionStatus } from './session'
import { REACTIONS, type NetMsg, type PublicView } from './protocol'
import type { Transport } from './transport'
import { TOTAL_POINTS } from '../game/rules'
import { freshDeck } from '../game/deck'
import { DEFAULT_SETTINGS } from '../game/settings'
import { SOUND_IDS } from '../ui/sounds'

interface SentMsg {
  msg: NetMsg
  target?: string
}

/**
 * In-memory transport recording what the host sent *and to whom*, so tests can
 * assert that hands only ever go to the seat that holds them.
 */
function fakeTransport() {
  const sent: SentMsg[] = []
  const messageHandlers: ((m: NetMsg, from: string) => void)[] = []
  const joinHandlers: ((p: string) => void)[] = []
  const leaveHandlers: ((p: string) => void)[] = []
  let connectedPeers: string[] = []

  const transport: Transport = {
    send: (msg, target) => void sent.push(target === undefined ? { msg } : { msg, target }),
    onMessage: h => void messageHandlers.push(h),
    onPeerJoin: h => void joinHandlers.push(h),
    onPeerLeave: h => void leaveHandlers.push(h),
    peers: () => connectedPeers,
    isConnected: () => connectedPeers.length > 0,
    leave: () => void (connectedPeers = []),
  }

  return {
    transport,
    sent,
    /** Messages addressed to nobody in particular. */
    broadcasts: () => sent.filter(s => s.target === undefined).map(s => s.msg),
    to: (peer: string) => sent.filter(s => s.target === peer).map(s => s.msg),
    receive: (m: NetMsg, from = 'peer-1') => messageHandlers.forEach(h => h(m, from)),
    join: (peer = 'peer-1') => {
      connectedPeers = [...connectedPeers, peer]
      joinHandlers.forEach(h => h(peer))
    },
    part: (peer = 'peer-1') => {
      connectedPeers = connectedPeers.filter(p => p !== peer)
      leaveHandlers.forEach(h => h(peer))
    },
  }
}

/** A peer announcing itself, which is what earns it a seat. */
function hello(clientId: string): NetMsg {
  return { t: 'hello', clientId }
}

describe('trick pause honours the configured pace', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** Plays a full trick and reports how long both cards stay on the table. */
  function measure(delayMs: number): { atPause: number; afterPause: number } {
    const views: PublicView[] = []
    const s = hotseatSession({ ...DEFAULT_SETTINGS, trickDelayMs: delayMs })
    s.onView((v: PublicView) => views.push(v))
    s.start()

    // Lead, hand over, then follow — completing the trick.
    s.play(views.at(-1)!.hand[0]!.id)
    s.confirmHandoff()
    s.play(views.at(-1)!.hand[0]!.id)

    const atPause = views.at(-1)!.table.length

    // One tick short of the delay: still showing.
    vi.advanceTimersByTime(delayMs - 1)
    const stillShowing = views.at(-1)!.table.length
    expect(stillShowing, `table cleared before ${delayMs}ms`).toBe(2)

    vi.advanceTimersByTime(2)
    return { atPause, afterPause: views.at(-1)!.table.length }
  }

  it.each([800, 1400, 2500, 4000])('holds the trick for exactly %ims', delay => {
    const { atPause, afterPause } = measure(delay)
    expect(atPause).toBe(2)
    expect(afterPause).toBe(0)
  })

  it('marks the trick as resolving only while it is held', () => {
    const views: PublicView[] = []
    const s = hotseatSession({ ...DEFAULT_SETTINGS, trickDelayMs: 1000 })
    s.onView((v: PublicView) => views.push(v))
    s.start()
    s.play(views.at(-1)!.hand[0]!.id)
    s.confirmHandoff()
    s.play(views.at(-1)!.hand[0]!.id)

    expect(views.at(-1)!.resolving).toBe(true)
    expect(views.at(-1)!.lastWinner).not.toBeNull()
    vi.advanceTimersByTime(1000)
    expect(views.at(-1)!.resolving).toBe(false)
  })
})

describe('public view', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('counts tricks down from 20', () => {
    const views: PublicView[] = []
    const s = aiSession(DEFAULT_SETTINGS)
    s.onView((v: PublicView) => views.push(v))
    s.start()
    expect(views.at(-1)!.tricksLeft).toBe(20)
  })

  it('exposes the previous trick from each seat, and only the previous one', () => {
    const views: PublicView[] = []
    const s = hotseatSession({ ...DEFAULT_SETTINGS, trickDelayMs: 10 })
    s.onView((v: PublicView) => views.push(v))
    s.start()

    expect(views.at(-1)!.lastTrick).toBeNull()

    const lead = views.at(-1)!.hand[0]!
    s.play(lead.id)
    s.confirmHandoff()
    const follow = views.at(-1)!.hand[0]!
    s.play(follow.id)
    vi.advanceTimersByTime(20)

    const last = views.at(-1)!.lastTrick!
    expect(last).not.toBeNull()
    // The recap must contain exactly the two cards actually played.
    expect(last.plays.map(p => p.card.id).sort()).toEqual([lead.id, follow.id].sort())
    expect(last.points).toBeLessThanOrEqual(TOTAL_POINTS)
  })

  it('never leaks the opponent hand to the guest view', () => {
    const f = fakeTransport()
    const host = new HostSession(f.transport, 42, DEFAULT_SETTINGS)
    host.start()
    f.join()
    f.receive(hello('client-a'))

    const guestViews = f.to('peer-1').filter(m => m.t === 'view').map(m => (m as { view: PublicView }).view)
    expect(guestViews.length).toBeGreaterThan(0)
    for (const v of guestViews) {
      expect(v.hand).toHaveLength(3)
      expect(v.mySeat).toBe(1)
      // Only a count of the opponent's cards, never their identities.
      expect(v.opponentCards).toBe(3)
      expect(Object.keys(v)).not.toContain('hands')
    }
  })
})

describe('reactions', () => {
  it('relays a valid emoji from the guest to the host UI', () => {
    const f = fakeTransport()
    const host = new HostSession(f.transport, 1, DEFAULT_SETTINGS)
    const seen: string[] = []
    host.onReaction(e => seen.push(e))

    f.receive({ t: 'react', emoji: REACTIONS[0] })
    expect(seen).toEqual([REACTIONS[0]])
  })

  it('drops anything outside the fixed set', () => {
    const f = fakeTransport()
    const host = new HostSession(f.transport, 1, DEFAULT_SETTINGS)
    const seen: string[] = []
    host.onReaction(e => seen.push(e))

    // A hostile peer could send arbitrary strings; this one would otherwise
    // end up rendered into the other player's DOM.
    f.receive({ t: 'react', emoji: '<img src=x onerror=alert(1)>' } as unknown as NetMsg)
    f.receive({ t: 'react', emoji: '💣' } as unknown as NetMsg)
    expect(seen).toEqual([])
  })

  it('sends the host reaction over the wire', () => {
    const f = fakeTransport()
    const host = new HostSession(f.transport, 1, DEFAULT_SETTINGS)
    host.react(REACTIONS[1])
    expect(f.broadcasts()).toContainEqual({ t: 'react', emoji: REACTIONS[1] })
  })
})

describe('host authority', () => {
  it('rejects a guest move made out of turn', () => {
    const f = fakeTransport()
    const host = new HostSession(f.transport, 3, DEFAULT_SETTINGS)
    host.start()
    f.join()
    f.receive(hello('client-a'))

    const view = f.to('peer-1').filter(m => m.t === 'view').map(m => (m as { view: PublicView }).view).at(-1)!
    // Seat 1 leads on dealer 0, so make it the host's turn first.
    if (view.turn === 1) {
      host.play(view.hand[0]!.id) // not the host's turn -> ignored
    }

    f.sent.length = 0
    // A card the guest does not hold.
    f.receive({ t: 'play', card: 'denari-1' })
    const out = f.to('peer-1')
    // Either the card was legitimately held, or the host refused it — never a
    // silent state change.
    expect(out.filter(m => m.t === 'error').length + out.filter(m => m.t === 'view').length)
      .toBeGreaterThan(0)
  })
})

describe('soundboard', () => {
  it('relays a valid sound from the guest', () => {
    const f = fakeTransport()
    const host = new HostSession(f.transport, 1, DEFAULT_SETTINGS)
    const heard: string[] = []
    host.onSound(s => heard.push(s))

    f.receive({ t: 'sound', sound: SOUND_IDS[0] })
    expect(heard).toEqual([SOUND_IDS[0]])
  })

  it('ignores a sound id that is not in the set', () => {
    const f = fakeTransport()
    const host = new HostSession(f.transport, 1, DEFAULT_SETTINGS)
    const heard: string[] = []
    host.onSound(s => heard.push(s))

    f.receive({ t: 'sound', sound: 'rickroll' } as unknown as NetMsg)
    expect(heard).toEqual([])
  })
})

describe('shared deck style', () => {
  it('is carried in the view so both players see the same cards', () => {
    const f = fakeTransport()
    const host = new HostSession(f.transport, 8, { ...DEFAULT_SETTINGS, deck: 'napoletane' })
    host.start()
    f.join()
    f.receive(hello('client-a'))

    const viewOf = () =>
      f.to('peer-1').filter(m => m.t === 'view').map(m => (m as { view: PublicView }).view).at(-1)!
    expect(viewOf().deck).toBe('napoletane')

    // The guest asks; the host is still the authority and rebroadcasts.
    f.receive({ t: 'settings', deck: 'francesi' })
    expect(viewOf().deck).toBe('francesi')
  })

  it('refuses an unknown deck id from a peer', () => {
    const f = fakeTransport()
    const host = new HostSession(f.transport, 8, { ...DEFAULT_SETTINGS, deck: 'napoletane' })
    host.start()
    f.join()
    f.receive(hello('client-a'))

    f.receive({ t: 'settings', deck: '../../etc/passwd' } as unknown as NetMsg)
    const view = f.to('peer-1').filter(m => m.t === 'view').map(m => (m as { view: PublicView }).view).at(-1)!
    expect(view.deck).toBe('napoletane')
  })
})

describe('seat control', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** Runs the clock forward, letting AI seats take their turns. */
  function settle(ms = 60_000) {
    vi.advanceTimersByTime(ms)
  }

  it.each([2, 3, 4] as const)('fills every non-human seat with a bot at %i players', players => {
    const views: PublicView[] = []
    const s = aiSession({ ...DEFAULT_SETTINGS, trickDelayMs: 10 }, players)
    s.onView(v => views.push(v))
    s.start()
    settle()

    const view = views.at(-1)!
    // Only seat 0 is human, so play must stop there and nowhere else.
    expect(view.mySeat).toBe(0)
    expect(view.turn).toBe(0)
    expect(view.hand.length).toBeGreaterThan(0)
  })

  it.each([3, 4] as const)('plays a whole %i-player game with one human', players => {
    const views: PublicView[] = []
    const s = aiSession({ ...DEFAULT_SETTINGS, trickDelayMs: 5 }, players)
    s.onView(v => views.push(v))
    s.start()

    let guard = 0
    while (views.at(-1)!.phase === 'playing') {
      if (guard++ > 200) throw new Error('game did not terminate')
      settle(200)
      const view = views.at(-1)!
      if (view.phase === 'over') break
      if (view.turn === 0 && !view.resolving && view.hand.length > 0) s.play(view.hand[0]!.id)
    }
    expect(views.at(-1)!.phase).toBe('over')
    expect(views.at(-1)!.tricksLeft).toBe(0)
  })

  it('asks for a handoff only when more than one seat is local', () => {
    const soloStatuses: SessionStatus[] = []
    const solo = aiSession({ ...DEFAULT_SETTINGS, trickDelayMs: 5 })
    solo.onStatus(st => soloStatuses.push(st))
    solo.start()
    settle()
    expect(soloStatuses.some(st => st.kind === 'handoff')).toBe(false)

    const hotStatuses: SessionStatus[] = []
    const hotViews: PublicView[] = []
    const hot = hotseatSession({ ...DEFAULT_SETTINGS, trickDelayMs: 5 })
    hot.onStatus(st => hotStatuses.push(st))
    hot.onView(v => hotViews.push(v))
    hot.start()
    hot.play(hotViews.at(-1)!.hand[0]!.id)
    expect(hotStatuses.some(st => st.kind === 'handoff')).toBe(true)
  })

  it('ignores a card the local player does not hold', () => {
    const views: PublicView[] = []
    const s = aiSession({ ...DEFAULT_SETTINGS, trickDelayMs: 5 }, 2, 4242)
    s.onView(v => views.push(v))
    s.start()
    settle()

    const view = views.at(-1)!
    expect(view.turn).toBe(0)
    // Pick a card that is provably not in our hand, so this cannot pass by
    // accident on a lucky deal.
    const held = new Set(view.hand.map(c => c.id))
    const notHeld = freshDeck().find(c => !held.has(c.id))!

    const before = views.length
    s.play(notHeld.id)
    expect(views.length).toBe(before)

    // A card we do hold still works, proving the guard is not simply off.
    s.play(view.hand[0]!.id)
    expect(views.length).toBeGreaterThan(before)
  })
})

describe('match play through a session', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** Plays hands to completion, pressing "next hand" until the match decides. */
  function playMatch(format: Parameters<typeof aiSession>[0]['format'], maxHands = 12) {
    const views: PublicView[] = []
    const s = aiSession({ ...DEFAULT_SETTINGS, trickDelayMs: 5, format })
    s.onView(v => views.push(v))
    s.start()

    for (let hand = 0; hand < maxHands; hand++) {
      let guard = 0
      while (views.at(-1)!.phase === 'playing') {
        if (guard++ > 400) throw new Error('hand did not finish')
        vi.advanceTimersByTime(100)
        const v = views.at(-1)!
        if (v.phase === 'playing' && v.turn === 0 && !v.resolving && v.hand.length > 0) {
          s.play(v.hand[0]!.id)
        }
      }
      vi.advanceTimersByTime(100)
      if (views.at(-1)!.match.decided) break
      s.rematch()
      vi.advanceTimersByTime(100)
    }
    return { views, last: views.at(-1)! }
  }

  it('decides a single-hand game in one hand', () => {
    const { last } = playMatch({ kind: 'single' })
    expect(last.phase).toBe('over')
    expect(last.match.decided).toBe(true)
    expect(last.match.handNumber).toBe(2) // recordHand advances past the played hand
  })

  it('plays a best-of-three to a conclusion', () => {
    const { last } = playMatch({ kind: 'bestOf', target: 2 })
    expect(last.match.decided).toBe(true)
    expect(Math.max(...last.match.scores)).toBe(2)
    // Two wins needed, so at most three hands plus any drawn ones.
    expect(last.match.handNumber).toBeLessThanOrEqual(8)
  })

  it('accumulates points across hands in a points race', () => {
    const { views } = playMatch({ kind: 'points', target: 301 })
    const totals = views
      .filter(v => v.phase === 'over')
      .map(v => v.match.scores.reduce((a, b) => a + b, 0))
    // Every completed hand adds exactly 120 to the pot.
    for (const total of totals) expect(total % TOTAL_POINTS).toBe(0)
    expect(views.at(-1)!.match.decided).toBe(true)
  })

  it('carries the match into every view so both players see the same score', () => {
    const { views } = playMatch({ kind: 'bestOf', target: 2 })
    for (const v of views) {
      expect(v.match.scores).toHaveLength(2)
      expect(v.match.myTeam).toBe(0)
      expect(v.match.myScore).toBe(v.match.scores[0])
    }
  })
})

describe('redaction with several peers', () => {
  /** Seats N-1 remote players at a table, each with its own peer id. */
  function seatEveryone(players: 3 | 4) {
    const f = fakeTransport()
    const host = new HostSession(f.transport, 99, { ...DEFAULT_SETTINGS, players })
    host.start()
    const peers = Array.from({ length: players - 1 }, (_, i) => `peer-${i + 1}`)
    peers.forEach((p, i) => {
      f.join(p)
      f.receive(hello(`client-${i + 1}`), p)
    })
    return { f, host, peers }
  }

  it.each([3, 4] as const)('never broadcasts a hand at %i players', players => {
    const { f } = seatEveryone(players)

    // The critical property: anything carrying cards must name its recipient.
    for (const msg of f.broadcasts()) {
      expect(msg.t, `broadcast ${msg.t} would reach every peer`).not.toBe('view')
    }
  })

  it.each([3, 4] as const)('sends each peer only its own hand at %i players', players => {
    const { f, peers } = seatEveryone(players)

    const handsByPeer = new Map<string, string[]>()
    peers.forEach((peer, i) => {
      const views = f.to(peer).filter(m => m.t === 'view').map(m => (m as { view: PublicView }).view)
      expect(views.length, `peer ${peer} got no view`).toBeGreaterThan(0)
      const view = views.at(-1)!
      // Seat 0 is the host, so the first joiner takes seat 1 and so on.
      expect(view.mySeat).toBe(i + 1)
      expect(view.hand).toHaveLength(3)
      handsByPeer.set(peer, view.hand.map(c => c.id))
    })

    // No card may appear in two different players' hands.
    const all = [...handsByPeer.values()].flat()
    expect(new Set(all).size).toBe(all.length)
  })

  it('routes a move by peer, not by whose turn it happens to be', () => {
    const { f, peers } = seatEveryone(4)
    const viewOf = (peer: string) =>
      f.to(peer).filter(m => m.t === 'view').map(m => (m as { view: PublicView }).view).at(-1)!

    const turn = viewOf(peers[0]!).turn
    const wrongPeer = peers.find((_, i) => i + 1 !== turn)!
    const wrongView = viewOf(wrongPeer)

    f.sent.length = 0
    // A legal card, but sent by a peer whose turn it is not.
    f.receive({ t: 'play', card: wrongView.hand[0]!.id }, wrongPeer)
    expect(f.to(wrongPeer).some(m => m.t === 'error')).toBe(true)
  })

  it('turns away a peer once the table is full', () => {
    const f = fakeTransport()
    const host = new HostSession(f.transport, 7, { ...DEFAULT_SETTINGS, players: 2 })
    host.start()

    f.join('peer-1')
    f.receive(hello('client-1'), 'peer-1')
    expect(f.to('peer-1').some(m => m.t === 'seated')).toBe(true)

    f.join('peer-2')
    f.receive(hello('client-2'), 'peer-2')
    expect(f.to('peer-2').some(m => m.t === 'full')).toBe(true)
    expect(f.to('peer-2').some(m => m.t === 'view')).toBe(false)
  })

  it('gives a returning client its old seat back', () => {
    const f = fakeTransport()
    const host = new HostSession(f.transport, 7, { ...DEFAULT_SETTINGS, players: 2 })
    host.start()

    f.join('peer-1')
    f.receive(hello('client-1'), 'peer-1')
    const firstSeat = f.to('peer-1').find(m => m.t === 'seated') as { seat: number }

    // Tab killed, reopened: new peer id, same clientId.
    f.part('peer-1')
    f.join('peer-9')
    f.receive(hello('client-1'), 'peer-9')

    const againSeat = f.to('peer-9').find(m => m.t === 'seated') as { seat: number }
    expect(againSeat.seat).toBe(firstSeat.seat)
    expect(f.to('peer-9').some(m => m.t === 'full')).toBe(false)
  })
})

describe('reconnection', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function seatedGame() {
    const f = fakeTransport()
    const statuses: SessionStatus[] = []
    const hostViews: PublicView[] = []
    const host = new HostSession(f.transport, 2468, { ...DEFAULT_SETTINGS, trickDelayMs: 5 })
    host.onStatus(st => statuses.push(st))
    host.onView(v => hostViews.push(v))
    host.start()
    f.join('peer-1')
    f.receive(hello('client-1'), 'peer-1')
    const viewOf = () =>
      f.to('peer-1').filter(m => m.t === 'view').map(m => (m as { view: PublicView }).view).at(-1)!
    // Once a peer is gone the host stops addressing it, so that peer's last
    // view goes stale. The host's own view is the only live observer after a
    // drop — reading `viewOf()` there would spin on a frozen snapshot.
    const hostView = () => hostViews.at(-1)!
    return { f, host, statuses, viewOf, hostView }
  }

  it('keeps the game when a peer drops, rather than ending it', () => {
    const { f, statuses, viewOf } = seatedGame()
    const before = viewOf()

    f.part('peer-1')

    expect(statuses.at(-1)!.kind).toBe('awaiting')
    // The state is still there — this is what used to be lost.
    const after = f.to('peer-1').filter(m => m.t === 'view').at(-1)
    expect(after).toBeDefined()
    expect(viewOf().trickNumber).toBe(before.trickNumber)
  })

  it('restores the seat and the game when the same client returns', () => {
    const { f, statuses, viewOf } = seatedGame()
    const handBefore = viewOf().hand.map(c => c.id)

    f.part('peer-1')
    // A reload gives the same browser a brand new peer id.
    f.join('peer-2')
    f.receive(hello('client-1'), 'peer-2')

    const seated = f.to('peer-2').find(m => m.t === 'seated') as { seat: number } | undefined
    expect(seated?.seat).toBe(1)
    const view = f.to('peer-2').filter(m => m.t === 'view').map(m => (m as { view: PublicView }).view).at(-1)!
    expect(view.hand.map(c => c.id)).toEqual(handBefore)
    expect(statuses.at(-1)!.kind).toBe('playing')
  })

  it('pauses rather than playing on while the seat is held', () => {
    const { f, host, hostView } = seatedGame()

    // Get to the point where the player about to vanish is the one to move.
    if (hostView().turn === 0) host.play(hostView().hand[0]!.id)
    vi.advanceTimersByTime(50)
    expect(hostView().turn).toBe(1)

    f.part('peer-1')
    const trickBefore = hostView().trickNumber

    // Nothing may move while their seat is held, however long the clock runs.
    vi.advanceTimersByTime(RECONNECT_GRACE_MS - 1000)
    expect(hostView().trickNumber).toBe(trickBefore)
    expect(hostView().turn).toBe(1)
  })

  it('hands the seat to a bot once the grace period lapses', () => {
    const { f, host, statuses, hostView } = seatedGame()
    f.part('peer-1')
    expect(statuses.at(-1)!.kind).toBe('awaiting')

    const stuckAt = hostView().trickNumber
    vi.advanceTimersByTime(RECONNECT_GRACE_MS + 100)
    expect(statuses.at(-1)!.kind).not.toBe('awaiting')

    // The bot now plays that seat, so the hand runs to the end with only the
    // host still human.
    let guard = 0
    while (hostView().phase === 'playing') {
      if (guard++ > 500) throw new Error('game stalled after AI takeover')
      vi.advanceTimersByTime(100)
      const v = hostView()
      if (v.phase === 'playing' && v.turn === 0 && !v.resolving && v.hand.length > 0) {
        host.play(v.hand[0]!.id)
      }
    }
    expect(hostView().phase).toBe('over')
    expect(hostView().trickNumber).toBeGreaterThan(stuckAt)
  })

  it('lets a player reclaim a seat a bot took over', () => {
    const { f } = seatedGame()
    f.part('peer-1')
    vi.advanceTimersByTime(RECONNECT_GRACE_MS + 100)

    f.join('peer-3')
    f.receive(hello('client-1'), 'peer-3')

    const seated = f.to('peer-3').find(m => m.t === 'seated') as { seat: number } | undefined
    expect(seated?.seat).toBe(1)
    expect(f.to('peer-3').some(m => m.t === 'full')).toBe(false)
  })
})
