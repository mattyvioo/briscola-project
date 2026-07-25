import type { NetMsg } from './protocol'

/**
 * The one thing the session layer needs from the network: send a message to
 * the other player, and be told when one arrives or the peer comes and goes.
 *
 * Keeping this an interface means the game logic never imports Trystero, and
 * swapping the signaling strategy (or writing a fake for tests) touches one
 * file.
 */
export interface Transport {
  send(msg: NetMsg): void
  onMessage(handler: (msg: NetMsg) => void): void
  onPeerJoin(handler: () => void): void
  onPeerLeave(handler: () => void): void
  /** True once a peer is connected. */
  isConnected(): boolean
  leave(): void
}
