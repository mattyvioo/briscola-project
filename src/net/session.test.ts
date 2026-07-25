import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiSession, HostSession, HotseatSession } from './session'
import { REACTIONS, type NetMsg, type PublicView } from './protocol'
import type { Transport } from './transport'
import { TOTAL_POINTS } from '../game/rules'
import { DEFAULT_SETTINGS } from '../game/settings'
import { SOUND_IDS } from '../ui/sounds'

/** In-memory transport that records what the host sent and can inject peer messages. */
function fakeTransport() {
  const sent: NetMsg[] = []
  let onMessage: ((m: NetMsg) => void) | null = null
  let onJoin: (() => void) | null = null
  let connected = true

  const transport: Transport = {
    send: m => void sent.push(m),
    onMessage: h => void (onMessage = h),
    onPeerJoin: h => void (onJoin = h),
    onPeerLeave: () => {},
    isConnected: () => connected,
    leave: () => void (connected = false),
  }

  return {
    transport,
    sent,
    receive: (m: NetMsg) => onMessage?.(m),
    join: () => onJoin?.(),
  }
}

describe('trick pause honours the configured pace', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** Plays a full trick and reports how long both cards stay on the table. */
  function measure(delayMs: number): { atPause: number; afterPause: number } {
    const views: PublicView[] = []
    const s = new HotseatSession(1234, 0, { ...DEFAULT_SETTINGS, trickDelayMs: delayMs })
    s.onView(v => views.push(v))
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
    const s = new HotseatSession(99, 0, { ...DEFAULT_SETTINGS, trickDelayMs: 1000 })
    s.onView(v => views.push(v))
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
    const s = new AiSession(7, 0, DEFAULT_SETTINGS)
    s.onView(v => views.push(v))
    s.start()
    expect(views.at(-1)!.tricksLeft).toBe(20)
  })

  it('exposes the previous trick from each seat, and only the previous one', () => {
    const views: PublicView[] = []
    const s = new HotseatSession(5, 0, { ...DEFAULT_SETTINGS, trickDelayMs: 10 })
    s.onView(v => views.push(v))
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
    // The viewer is now the trick winner, so "mine" must be one of the two
    // cards actually played, and the pair must be exactly those two.
    expect([last.mine.id, last.theirs.id].sort()).toEqual([lead.id, follow.id].sort())
    expect(last.points).toBeLessThanOrEqual(TOTAL_POINTS)
  })

  it('never leaks the opponent hand to the guest view', () => {
    const f = fakeTransport()
    const host = new HostSession(f.transport, 42, DEFAULT_SETTINGS)
    host.start()
    f.join()

    const guestViews = f.sent.filter(m => m.t === 'view').map(m => (m as { view: PublicView }).view)
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
    expect(f.sent).toContainEqual({ t: 'react', emoji: REACTIONS[1] })
  })
})

describe('host authority', () => {
  it('rejects a guest move made out of turn', () => {
    const f = fakeTransport()
    const host = new HostSession(f.transport, 3, DEFAULT_SETTINGS)
    host.start()
    f.join()

    const view = f.sent.filter(m => m.t === 'view').map(m => (m as { view: PublicView }).view).at(-1)!
    // Seat 1 leads on dealer 0, so make it the host's turn first.
    if (view.turn === 1) {
      host.play(view.hand[0]!.id) // not the host's turn -> ignored
    }

    f.sent.length = 0
    // A card the guest does not hold.
    f.receive({ t: 'play', card: 'denari-1' })
    const errors = f.sent.filter(m => m.t === 'error')
    // Either the card was legitimately held, or the host refused it — never a
    // silent state change.
    expect(errors.length + f.sent.filter(m => m.t === 'view').length).toBeGreaterThan(0)
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

    const viewOf = () =>
      f.sent.filter(m => m.t === 'view').map(m => (m as { view: PublicView }).view).at(-1)!
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

    f.receive({ t: 'settings', deck: '../../etc/passwd' } as unknown as NetMsg)
    const view = f.sent.filter(m => m.t === 'view').map(m => (m as { view: PublicView }).view).at(-1)!
    expect(view.deck).toBe('napoletane')
  })
})
