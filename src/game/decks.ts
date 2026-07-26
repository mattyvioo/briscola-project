import type { Card, Rank, Suit } from './deck'

/**
 * Card artwork styles. The rules never change — only the pictures and the
 * names people use for the suits and courts.
 *
 * See public/cards/CREDITS.md for sources and licences.
 */
/**
 * `bergamasche` is deliberately absent: the artwork is 40 separate Commons
 * files and the fetch reliably trips their rate limiter, so the pack is only
 * partially downloaded. `scripts/fetch-cards.mjs` still knows how to build it —
 * once public/cards/bergamasche holds all 40 cards, add it back here.
 */
export const DECK_IDS = ['napoletane', 'francesi'] as const
export type DeckId = (typeof DECK_IDS)[number]

export const DEFAULT_DECK: DeckId = 'napoletane'

export interface DeckStyle {
  readonly id: DeckId
  /** Shown in the settings picker. */
  readonly label: string
  readonly hint: string
  /** Suit names as printed on that deck. */
  readonly suits: Readonly<Record<Suit, string>>
  /** Court names — Fante/Cavallo/Re on Italian decks, Jack/Queen/King on French. */
  readonly courts: Readonly<Record<8 | 9 | 10, string>>
  /**
   * Glyph for the trump badge: a Unicode pip on the French deck, an inline SVG
   * path on the Italian ones (whose suits have no Unicode equivalent).
   */
  readonly pip: Readonly<Record<Suit, string>>
  readonly pipKind: 'text' | 'svg'
  /** Colour of the pip, so red suits read as red. */
  readonly pipColor: Readonly<Record<Suit, string>>
}

const ITALIAN_SUITS = {
  denari: 'Denari',
  coppe: 'Coppe',
  spade: 'Spade',
  bastoni: 'Bastoni',
} as const

const ITALIAN_COURTS = { 8: 'Fante', 9: 'Cavallo', 10: 'Re' } as const

/**
 * Minimal glyphs for the four Italian suits, drawn here rather than fetched:
 * they need to be legible at ~14px on a card corner, where a scan of the real
 * pip would be mud, and it keeps the badge recolourable via `currentColor`.
 *
 * Paths are authored against a 0 0 24 24 viewBox.
 */
const ITALIAN_PIPS = {
  // A coin: ring with a centre dot.
  denari:
    'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 3a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm0 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  // A chalice: bowl, stem, foot.
  coppe:
    'M6 3h12v5a6 6 0 0 1-4.5 5.8V18h3.5v3h-10v-3H10.5v-4.2A6 6 0 0 1 6 8V3zm2.5 2.5V8a3.5 3.5 0 0 0 7 0V5.5h-7z',
  // A straight sword: blade, crossguard, pommel.
  spade:
    'M11 2h2v12h-2V2zm-4 12h10v2h-4v6h-2v-6H7v-2zm5 8.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z',
  // A knobbed baton, laid diagonally.
  bastoni:
    'M17.2 3.2a2.8 2.8 0 0 1 3.6 4.2l-13 13a2.8 2.8 0 0 1-4-4l13-13zm-1.4 2.6-11.2 11.2a1 1 0 0 0 1.4 1.4L17.2 7.2a1 1 0 0 0-1.4-1.4z',
} as const

const ITALIAN_PIP_COLORS = {
  denari: '#c8992a',
  coppe: '#b8342c',
  spade: '#2f5fa8',
  bastoni: '#3e7a35',
} as const

export const DECK_STYLES: Readonly<Record<DeckId, DeckStyle>> = {
  napoletane: {
    id: 'napoletane',
    label: 'Napoletane',
    hint: 'Il mazzo classico del Sud',
    suits: ITALIAN_SUITS,
    courts: ITALIAN_COURTS,
    pip: ITALIAN_PIPS,
    pipKind: 'svg',
    pipColor: ITALIAN_PIP_COLORS,
  },
  francesi: {
    id: 'francesi',
    label: 'Francesi',
    hint: 'Cuori, quadri, picche, fiori',
    suits: {
      denari: 'Quadri',
      coppe: 'Cuori',
      spade: 'Picche',
      bastoni: 'Fiori',
    },
    courts: { 8: 'Jack', 9: 'Donna', 10: 'Re' },
    pip: { denari: '♦', coppe: '♥', spade: '♠', bastoni: '♣' },
    pipKind: 'text',
    pipColor: {
      denari: '#d3352c',
      coppe: '#d3352c',
      spade: '#1a1a1a',
      bastoni: '#1a1a1a',
    },
  },
}

export function deckStyle(id: DeckId): DeckStyle {
  return DECK_STYLES[id] ?? DECK_STYLES[DEFAULT_DECK]
}

export function isDeckId(value: unknown): value is DeckId {
  return typeof value === 'string' && (DECK_IDS as readonly string[]).includes(value)
}

/** Path to a card face for the given style, relative to the site root. */
export function cardImage(card: Card, deck: DeckId): string {
  return `cards/${deck}/${card.suit}-${card.rank}.webp`
}

/** All decks share one card back. */
export const CARD_BACK_IMAGE = 'cards/back.webp'

/** e.g. "Cavallo di spade", or "Donna di picche" on the French deck. */
export function cardName(card: Card, deck: DeckId): string {
  const style = deckStyle(deck)
  const rank: string =
    card.rank >= 8
      ? style.courts[card.rank as 8 | 9 | 10]
      : RANK_WORDS[card.rank as Exclude<Rank, 8 | 9 | 10>]
  return `${rank} di ${style.suits[card.suit]}`
}

const RANK_WORDS: Readonly<Record<1 | 2 | 3 | 4 | 5 | 6 | 7, string>> = {
  1: 'Asso',
  2: 'Due',
  3: 'Tre',
  4: 'Quattro',
  5: 'Cinque',
  6: 'Sei',
  7: 'Sette',
}

export function suitName(suit: Suit, deck: DeckId): string {
  return deckStyle(deck).suits[suit]
}


/**
 * Table colour. Only the cloth, its shading and the rail change — every other
 * surface on the table derives from those, so a theme is a handful of CSS
 * variables rather than a second stylesheet.
 */
export const TABLE_THEMES = ['green', 'burgundy', 'midnight', 'wood'] as const
export type TableTheme = (typeof TABLE_THEMES)[number]

export const DEFAULT_TABLE: TableTheme = 'green'

export const TABLE_LABELS: Readonly<Record<TableTheme, string>> = {
  green: 'Verde',
  burgundy: 'Bordeaux',
  midnight: 'Notte',
  wood: 'Legno',
}

/** Swatch colours for the picker, matching the cloth each theme paints. */
export const TABLE_SWATCHES: Readonly<Record<TableTheme, string>> = {
  green: '#176c44',
  burgundy: '#7d1c2d',
  midnight: '#1f4480',
  wood: '#8a5c2e',
}

export function isTableTheme(value: unknown): value is TableTheme {
  return typeof value === 'string' && (TABLE_THEMES as readonly string[]).includes(value)
}
