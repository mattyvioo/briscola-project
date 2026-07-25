import { CARD_BACK_IMAGE, cardImage, cardName, parseCard, type Card, type CardId } from '../game/deck'
import { el } from './dom'

/** A face-up card. Rendered as a button when the player can actually play it. */
export function cardFace(card: Card, opts: { playable?: boolean } = {}): HTMLElement {
  const img = el('img', {
    class: 'card-img',
    src: cardImage(card),
    alt: cardName(card),
    draggable: false,
    loading: 'eager',
  })

  if (opts.playable) {
    return el('button', { class: 'card card-playable', type: 'button', 'data-card': card.id }, img)
  }
  return el('div', { class: 'card', 'data-card': card.id, role: 'img', 'aria-label': cardName(card) }, img)
}

export function cardFaceById(id: CardId, opts: { playable?: boolean } = {}): HTMLElement {
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
 * Preloads every card image at startup. The deck is ~1.7 MB total, and having
 * it in cache avoids a blank frame when a card is drawn mid-game.
 */
export function preloadCards(cards: readonly Card[]) {
  for (const card of cards) {
    const img = new Image()
    img.src = cardImage(card)
  }
  new Image().src = CARD_BACK_IMAGE
}
