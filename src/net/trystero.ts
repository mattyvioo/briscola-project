import { joinRoom } from '@trystero-p2p/mqtt'
import type { JsonValue } from '@trystero-p2p/mqtt'
import type { NetMsg } from './protocol'
import type { Transport } from './transport'

/**
 * Trystero over public MQTT relays — upstream rates MQTT as the most robust of
 * the decentralised strategies, and it needs no server of ours.
 *
 * The room code doubles as the `password`, which encrypts the WebRTC session
 * descriptions on the relay. Anyone who has not been told the code cannot
 * usefully join, and the relay operator cannot read the handshake.
 */
const APP_ID = 'briscola-p2p-vio'

/** Trystero caps action names at 12 bytes; one channel carrying JSON is plenty. */
const ACTION = 'msg'

export function connect(roomCode: string): Transport {
  const room = joinRoom({ appId: APP_ID, password: roomCode }, roomCode)

  // Our messages are plain JSON-shaped objects, but their readonly unions
  // don't structurally satisfy Trystero's open-ended JsonValue. Cast once here
  // rather than loosening the protocol types everywhere else.
  const action = room.makeAction<JsonValue>(ACTION)

  let connected = false
  const messageHandlers: ((msg: NetMsg) => void)[] = []
  const joinHandlers: (() => void)[] = []
  const leaveHandlers: (() => void)[] = []

  action.onMessage = data => {
    const msg = data as NetMsg
    for (const h of messageHandlers) h(msg)
  }

  room.onPeerJoin = () => {
    connected = true
    for (const h of joinHandlers) h()
  }

  room.onPeerLeave = () => {
    connected = Object.keys(room.getPeers()).length > 0
    for (const h of leaveHandlers) h()
  }

  return {
    send(msg) {
      // Broadcasts to every peer in the room — in a 1v1 game, the opponent.
      // A send can reject if the channel closed mid-flight; that is a dropped
      // peer, which onPeerLeave already reports, so swallow it here.
      void action.send(msg as unknown as JsonValue).catch(() => {})
    },
    onMessage(handler) {
      messageHandlers.push(handler)
    },
    onPeerJoin(handler) {
      joinHandlers.push(handler)
    },
    onPeerLeave(handler) {
      leaveHandlers.push(handler)
    },
    isConnected() {
      return connected
    },
    leave() {
      void room.leave()
    },
  }
}
