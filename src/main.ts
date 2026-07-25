import './ui/styles.css'

import { freshDeck } from './game/deck'
import { randomSeed } from './game/rng'
import { isValidRoomCode, makeRoomCode, normaliseRoomCode } from './net/protocol'
import {
  AiSession,
  GuestSession,
  HostSession,
  HotseatSession,
  type Session,
  type SessionStatus,
} from './net/session'
import { connect } from './net/trystero'
import { preloadCards } from './ui/card'
import { clear } from './ui/dom'
import { lobbyScreen, menuScreen } from './ui/menu'
import { TableView } from './ui/table'

const app = document.querySelector<HTMLElement>('#app')!

let session: Session | null = null
let table: TableView | null = null

function teardown() {
  session?.leave()
  session = null
  table?.destroy()
  table = null
  clear(app)
}

function show(node: HTMLElement) {
  clear(app)
  app.appendChild(node)
}

function goHome() {
  teardown()
  history.replaceState(null, '', location.pathname)
  show(
    menuScreen({
      onHostOnline: hostOnline,
      onJoinOnline: joinOnline,
      onPlayAi: playAi,
      onPlayHotseat: playHotseat,
    }),
  )
}

/** Wires a session to a fresh table view and puts it on screen. */
function startTable(
  next: Session,
  mode: 'online' | 'ai' | 'hotseat',
  roomCode: string | null,
  onStarted: () => void,
) {
  session = next
  table = new TableView(
    mode,
    {
      onPlay: card => next.play(card),
      onRematch: () => next.rematch(),
      onLeave: goHome,
      onHandoff: () => next.confirmHandoff(),
    },
    roomCode,
  )

  next.onView(view => table?.update(view))
  next.onStatus((status: SessionStatus) => table?.setStatus(status))

  show(table.root)
  onStarted()
}

function playAi() {
  const s = new AiSession(randomSeed(), 0)
  startTable(s, 'ai', null, () => s.start())
}

function playHotseat() {
  const s = new HotseatSession(randomSeed(), 0)
  startTable(s, 'hotseat', null, () => s.start())
}

/** `code` is supplied when the room was named up front by a #host= link. */
function hostOnline(code: string = makeRoomCode()) {
  const transport = connect(code)
  const s = new HostSession(transport, randomSeed())

  // Show the lobby until the guest actually connects, so the host has
  // somewhere to copy the code from.
  show(lobbyScreen(code, goHome))
  session = s

  transport.onPeerJoin(() => {
    // Only swap to the table the first time; a reconnect keeps the board up.
    if (table) return
    startTable(s, 'online', code, () => s.start())
  })

  // Record the room in the URL as a *host* link. Using the bare "#CODE" form
  // here would be wrong: that is the guest link, so reloading the page would
  // silently demote the host to a second guest and the room would never form.
  history.replaceState(null, '', `${HOST_HASH_PREFIX}${code}`)
}

function joinOnline(rawCode: string) {
  const code = normaliseRoomCode(rawCode)
  const transport = connect(code)
  const s = new GuestSession(transport)
  startTable(s, 'online', code, () => s.start())
}

const HOST_HASH_PREFIX = '#host='

/**
 * Two shapes of shared link:
 *
 *   …/#ABC234        join an existing room  (send this one to your opponent)
 *   …/#host=ABC234   open that room as host (keep this one)
 *
 * Which means a room can be set up in advance and both links handed out at
 * once, rather than the host having to create a game and read the code off
 * the lobby screen first.
 */
function roomFromUrl(): { role: 'host' | 'guest'; code: string } | null {
  const raw = location.hash.slice(1)

  if (raw.toLowerCase().startsWith('host=')) {
    const code = normaliseRoomCode(raw.slice('host='.length))
    return isValidRoomCode(code) ? { role: 'host', code } : null
  }

  const code = normaliseRoomCode(raw)
  return isValidRoomCode(code) ? { role: 'guest', code } : null
}

/**
 * Sends the app wherever the current URL says it should be.
 *
 * This has to run on `hashchange` as well as at startup. Opening a room link
 * while the app is already loaded — coming back to your own host link after
 * leaving a game, say — only changes the fragment, which the browser handles
 * as a same-document navigation: no reload, so a startup-only read would leave
 * the page sitting on whatever screen it was already showing while the other
 * player waits in a lobby that never fills.
 *
 * `history.replaceState` (used by goHome and hostOnline) deliberately does not
 * fire `hashchange`, so this cannot loop.
 */
function route() {
  const room = roomFromUrl()
  if (!room) {
    goHome()
    return
  }
  // Drop any session already in flight before starting another one.
  teardown()
  if (room.role === 'host') hostOnline(room.code)
  else joinOnline(room.code)
}

preloadCards(freshDeck())

window.addEventListener('hashchange', route)
route()
