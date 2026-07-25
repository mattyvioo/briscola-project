import { joinRoom } from '@trystero-p2p/mqtt'
import type { JsonValue } from '@trystero-p2p/mqtt'
import type { NetMsg } from './protocol'
import type { PeerId, Transport } from './transport'

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

  const messageHandlers: ((msg: NetMsg, from: PeerId) => void)[] = []
  const joinHandlers: ((peer: PeerId) => void)[] = []
  const leaveHandlers: ((peer: PeerId) => void)[] = []

  action.onMessage = (data, context) => {
    const msg = data as NetMsg
    for (const h of messageHandlers) h(msg, context.peerId)
  }

  room.onPeerJoin = peerId => {
    for (const h of joinHandlers) h(peerId)
  }

  room.onPeerLeave = peerId => {
    for (const h of leaveHandlers) h(peerId)
  }

  const peers = () => Object.keys(room.getPeers())

  return {
    send(msg, target) {
      // A send can reject if the channel closed mid-flight; that is a dropped
      // peer, which onPeerLeave already reports, so swallow it here.
      void action
        .send(msg as unknown as JsonValue, target ? { target } : undefined)
        .catch(() => {})
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
    peers,
    isConnected() {
      return peers().length > 0
    },
    leave() {
      void room.leave()
    },
  }
}
