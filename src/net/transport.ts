import type { NetMsg } from './protocol'

/** Opaque per-connection id. Changes on every page load. */
export type PeerId = string

/**
 * The one thing the session layer needs from the network: send a message to
 * the other players, and be told when one arrives or a peer comes and goes.
 *
 * Keeping this an interface means the game logic never imports Trystero, and
 * swapping the signaling strategy (or writing a fake for tests) touches one
 * file.
 */
export interface Transport {
  /**
   * Sends to one peer, or to everyone when `target` is omitted.
   *
   * Targeting is not an optimisation. The host derives one view per seat and
   * each of those contains that seat's hand, so broadcasting them at a three
   * or four player table would deal everybody's cards face up. Anything
   * carrying a hand must name its recipient.
   */
  send(msg: NetMsg, target?: PeerId): void
  onMessage(handler: (msg: NetMsg, from: PeerId) => void): void
  onPeerJoin(handler: (peer: PeerId) => void): void
  onPeerLeave(handler: (peer: PeerId) => void): void
  /** Currently connected peers. */
  peers(): PeerId[]
  /** True once at least one peer is connected. */
  isConnected(): boolean
  leave(): void
}
