import type { Card, CardId, Suit } from '../game/deck'
import type { DeckId } from '../game/decks'
import type { Seat } from '../game/rules'
import type { SoundId } from '../ui/sounds'

/**
 * What a player is allowed to see. The host holds the full GameState and
 * derives one of these per seat, so a guest's browser never receives the
 * opponent's hand or the contents of the stock.
 */
export interface PublicView {
  /** My own cards. */
  readonly hand: readonly Card[]
  /** How many cards the opponent holds — not which ones. */
  readonly opponentCards: number
  readonly trumpCard: Card
  readonly trumpSuit: Suit
  readonly trumpTaken: boolean
  /** Cards still to be drawn, including the face-up briscola. */
  readonly stockLeft: number
  /**
   * Cards face-up on the table: empty between tricks, one while a lead awaits
   * a response, two during the pause after a trick resolves.
   */
  readonly table: readonly { readonly seat: Seat; readonly card: Card }[]
  readonly turn: Seat
  readonly mySeat: Seat
  readonly myPoints: number
  readonly opponentPoints: number
  readonly trickNumber: number
  /** Tricks still to play, including the one in progress. Counts down from 20. */
  readonly tricksLeft: number
  /**
   * The previous trick, so a player can check what was just played. Only ever
   * the most recent one. Carries every play with its seat, so the same shape
   * works at a 2, 3 or 4 player table.
   */
  readonly lastTrick: {
    readonly plays: readonly { readonly seat: Seat; readonly card: Card }[]
    readonly winner: Seat
    readonly iWon: boolean
    readonly points: number
  } | null
  readonly phase: 'playing' | 'over'
  /**
   * Card artwork both players see. Shared rather than per-player: choosing a
   * deck is part of setting up the match, and having each side quietly look at
   * different cards makes it impossible to talk about the game ("the king of
   * cups" / "which king?").
   */
  readonly deck: DeckId
  /**
   * True while a completed trick is being shown before it is swept up. The UI
   * blocks input and highlights the winner during this window.
   */
  readonly resolving: boolean
  /** Who took the trick currently being shown, if any. */
  readonly lastWinner: Seat | null
}

export interface TrickSummary {
  readonly plays: readonly CardId[]
  readonly winner: Seat
  readonly points: number
}

/**
 * Emoji you can throw at your opponent. A fixed set rather than free text:
 * it keeps the wire format trivial to validate and means nobody can send
 * arbitrary strings into the other player's DOM.
 */
export const REACTIONS = ['👏', '😂', '😱', '🤔', '😎', '🔥', '😭', '🍀'] as const
export type Reaction = (typeof REACTIONS)[number]

export function isReaction(value: unknown): value is Reaction {
  return typeof value === 'string' && (REACTIONS as readonly string[]).includes(value)
}

/** Guest → host. The guest only ever expresses intent. */
export type ClientMsg =
  | { readonly t: 'hello' }
  | { readonly t: 'play'; readonly card: CardId }
  | { readonly t: 'rematch' }
  | { readonly t: 'react'; readonly emoji: Reaction }
  | { readonly t: 'sound'; readonly sound: SoundId }
  /** Ask the host to change a shared setting; the host is still the authority. */
  | { readonly t: 'settings'; readonly deck: DeckId }

/** Host → guest. The host is authoritative. */
export type HostMsg =
  | { readonly t: 'view'; readonly view: PublicView }
  | { readonly t: 'trick'; readonly trick: TrickSummary }
  | { readonly t: 'react'; readonly emoji: Reaction }
  | { readonly t: 'sound'; readonly sound: SoundId }
  | { readonly t: 'error'; readonly message: string }

export type NetMsg = ClientMsg | HostMsg

/**
 * Room codes are shown to humans and typed on phone keyboards, so the alphabet
 * drops the characters that get misread: 0/O, 1/I/L, 5/S, 8/B.
 */
const CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY2346789'
export const ROOM_CODE_LENGTH = 6

export function makeRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ROOM_CODE_LENGTH))
  return Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
}

/** Normalises user input: uppercase, strip anything not in the alphabet. */
export function normaliseRoomCode(input: string): string {
  return input
    .toUpperCase()
    .split('')
    .filter(ch => CODE_ALPHABET.includes(ch))
    .join('')
    .slice(0, ROOM_CODE_LENGTH)
}

export function isValidRoomCode(code: string): boolean {
  return normaliseRoomCode(code).length === ROOM_CODE_LENGTH
}
