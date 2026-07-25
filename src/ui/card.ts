import { parseCard, type Card, type CardId, type Suit } from '../game/deck'
import { CARD_BACK_IMAGE, cardImage, cardName, deckStyle, type DeckId } from '../game/decks'
import { el } from './dom'

export interface CardOptions {
  readonly deck: DeckId
  readonly playable?: boolean
  /** Trump suit, so cards belonging to it can be badged. */
  readonly trump?: Suit | null
}

/**
 * A face-up card. Rendered as a button when the player can actually play it.
 *
 * Cards of the trump suit get a small pip badge in the corner. Briscola gives
 * no visual cue that a card is trump — you are expected to remember the suit —
 * and on a phone, at 60px wide, that is a genuinely hard read.
 */
export function cardFace(card: Card, opts: CardOptions): HTMLElement {
  const children: HTMLElement[] = [
    el('img', {
      class: 'card-img',
      src: cardImage(card, opts.deck),
      alt: cardName(card, opts.deck),
      draggable: false,
    }),
  ]

  const isTrump = opts.trump != null && card.suit === opts.trump
  if (isTrump) children.push(trumpBadge(card.suit, opts.deck))

  const cls = `card${isTrump ? ' card-trump' : ''}`

  if (opts.playable) {
    return el(
      'button',
      { class: `${cls} card-playable`, type: 'button', 'data-card': card.id },
      ...children,
    )
  }
  return el(
    'div',
    { class: cls, 'data-card': card.id, role: 'img', 'aria-label': cardName(card, opts.deck) },
    ...children,
  )
}

/** The little corner marker showing "this one is briscola". */
export function trumpBadge(suit: Suit, deck: DeckId): HTMLElement {
  const style = deckStyle(deck)
  const badge = el('span', { class: 'trump-badge', 'aria-hidden': 'true' })
  badge.style.setProperty('--pip', style.pipColor[suit])
  badge.appendChild(suitPip(suit, deck))
  return badge
}

/** The suit glyph on its own — used by the badge and the settings preview. */
export function suitPip(suit: Suit, deck: DeckId): HTMLElement {
  const style = deckStyle(deck)

  if (style.pipKind === 'text') {
    return el('span', { class: 'pip pip-text', text: style.pip[suit] })
  }

  // Built via the SVG namespace; el() creates HTML elements, which would not
  // render as SVG.
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', 'pip pip-svg')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', style.pip[suit])
  path.setAttribute('fill', 'currentColor')
  svg.appendChild(path)
  return svg as unknown as HTMLElement
}

export function cardFaceById(id: CardId, opts: CardOptions): HTMLElement {
  return cardFace(parseCard(id), opts)
}

/** A face-down card. Purely decorative, so it is hidden from screen readers. */
export function cardBack(): HTMLElement {
  return el(
    'div',
    { class: 'card card-back', 'aria-hidden': 'true' },
    el('img', { class: 'card-img', src: CARD_BACK_IMAGE, alt: '', draggable: false }),
  )
}

/**
 * Preloads a deck's images. Only the selected style is fetched — pulling all
 * three would be several megabytes for artwork the player never sees.
 */
export function preloadDeck(cards: readonly Card[], deck: DeckId) {
  for (const card of cards) {
    const img = new Image()
    img.src = cardImage(card, deck)
  }
  new Image().src = CARD_BACK_IMAGE
}
