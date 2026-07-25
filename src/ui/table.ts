import type { CardId } from '../game/deck'
import { parseCard } from '../game/deck'
import { other, TOTAL_POINTS, type Seat } from '../game/rules'
import type { PublicView } from '../net/protocol'
import type { SessionStatus } from '../net/session'
import { cardBack, cardFace } from './card'
import { clear, el, syncKeyed } from './dom'
import { t } from './strings'

export interface TableCallbacks {
  onPlay(card: CardId): void
  onRematch(): void
  onLeave(): void
  onHandoff(): void
}

type Mode = 'online' | 'ai' | 'hotseat'

export class TableView {
  readonly root: HTMLElement

  private hudMine: HTMLElement
  private hudTheirs: HTMLElement
  private nameMine: HTMLElement
  private nameTheirs: HTMLElement
  private opponentHand: HTMLElement
  private myHand: HTMLElement
  private trick: HTMLElement
  private stock: HTMLElement
  private banner: HTMLElement
  private overlay: HTMLElement

  private view: PublicView | null = null
  private status: SessionStatus = { kind: 'waiting' }

  constructor(
    private mode: Mode,
    private callbacks: TableCallbacks,
    private roomCode: string | null = null,
  ) {
    this.nameTheirs = el('span', { class: 'score-name' })
    this.hudTheirs = el('span', { class: 'score-value', text: '0' })
    this.nameMine = el('span', { class: 'score-name' })
    this.hudMine = el('span', { class: 'score-value', text: '0' })

    this.opponentHand = el('div', { class: 'hand hand-opponent' })
    this.myHand = el('div', { class: 'hand hand-mine' })
    this.trick = el('div', { class: 'trick' })
    this.stock = el('div', { class: 'stock' })
    this.banner = el('div', { class: 'banner', role: 'status', 'aria-live': 'polite' })
    this.overlay = el('div', { class: 'overlay', hidden: true })

    const leave = el('button', { class: 'btn-ghost btn-leave', type: 'button' }, t.leave)
    leave.addEventListener('click', () => this.callbacks.onLeave())

    this.root = el(
      'div',
      { class: `table table-${mode}` },
      el(
        'div',
        { class: 'hud' },
        el('div', { class: 'score score-theirs' }, this.nameTheirs, this.hudTheirs),
        leave,
        el('div', { class: 'score score-mine' }, this.nameMine, this.hudMine),
      ),
      this.opponentHand,
      el('div', { class: 'board' }, this.stock, this.trick),
      this.banner,
      this.myHand,
      this.overlay,
    )

    // One delegated listener rather than one per card, so re-renders stay cheap.
    this.myHand.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('.card-playable')
      const id = button?.dataset['card'] as CardId | undefined
      if (id && this.canPlay()) this.callbacks.onPlay(id)
    })

    // Number keys as a desktop shortcut for the three cards in hand.
    this.onKeydown = this.onKeydown.bind(this)
    window.addEventListener('keydown', this.onKeydown)
  }

  destroy() {
    window.removeEventListener('keydown', this.onKeydown)
  }

  private onKeydown(event: KeyboardEvent) {
    if (!this.canPlay()) return
    const index = Number(event.key) - 1
    const hand = this.view?.hand
    if (!hand || index < 0 || index >= hand.length) return
    event.preventDefault()
    this.callbacks.onPlay(hand[index]!.id)
  }

  private canPlay(): boolean {
    const v = this.view
    return (
      v !== null &&
      v.phase === 'playing' &&
      !v.resolving &&
      v.turn === v.mySeat &&
      this.status.kind === 'playing'
    )
  }

  /** "Tu"/"Avversario" online and vs the AI; numbered players in hotseat. */
  private labels(view: PublicView): { mine: string; theirs: string } {
    if (this.mode !== 'hotseat') return { mine: t.you, theirs: t.opponent }
    return {
      mine: t.player(view.mySeat + 1),
      theirs: t.player(other(view.mySeat) + 1),
    }
  }

  setStatus(status: SessionStatus) {
    this.status = status
    // Playability depends on the status as well as the view, so the hand has
    // to be re-rendered here too. Without this a session that reports
    // "playing" *after* its first view leaves the cards permanently disabled.
    if (this.view) this.renderMyHand(this.view)
    this.renderOverlay()
    this.renderBanner()
  }

  update(view: PublicView) {
    this.view = view

    const { mine, theirs } = this.labels(view)
    this.nameMine.textContent = mine
    this.nameTheirs.textContent = theirs
    this.hudMine.textContent = String(view.myPoints)
    this.hudTheirs.textContent = String(view.opponentPoints)

    this.renderOpponentHand(view)
    this.renderMyHand(view)
    this.renderStock(view)
    this.renderTrick(view)
    this.renderBanner()
    this.renderOverlay()
  }

  private renderOpponentHand(view: PublicView) {
    // Face-down cards have no identity to key on, so index is the key.
    const keys = Array.from({ length: view.opponentCards }, (_, i) => `back-${i}`)
    syncKeyed(this.opponentHand, keys, () => cardBack())
  }

  private renderMyHand(view: PublicView) {
    const playable = this.canPlay()
    syncKeyed(
      this.myHand,
      view.hand.map(c => c.id),
      key => cardFace(parseCard(key as CardId), { playable: true }),
      (node, _key, index) => {
        node.classList.toggle('is-disabled', !playable)
        node.toggleAttribute('disabled', !playable)
        node.style.setProperty('--i', String(index))
      },
    )
    this.myHand.classList.toggle('hand-active', playable)
  }

  private renderStock(view: PublicView) {
    clear(this.stock)

    // stockLeft counts the face-up briscola, so the face-down pile is one less
    // until the briscola has been taken.
    const faceDown = view.stockLeft - (view.trumpTaken ? 0 : 1)

    if (!view.trumpTaken) {
      this.stock.appendChild(el('div', { class: 'trump' }, cardFace(view.trumpCard)))
    }
    if (faceDown > 0) {
      this.stock.appendChild(
        el(
          'div',
          { class: 'deck' },
          cardBack(),
          el('span', { class: 'deck-count', 'aria-label': t.cardsLeft(view.stockLeft) }, String(faceDown)),
        ),
      )
    }
    this.stock.classList.toggle('stock-empty', view.stockLeft === 0)
  }

  private renderTrick(view: PublicView) {
    clear(this.trick)
    for (const played of view.table) {
      const isMine = played.seat === view.mySeat
      const wrapper = el(
        'div',
        {
          class: `played ${isMine ? 'played-mine' : 'played-theirs'}${
            view.resolving && view.lastWinner === played.seat ? ' played-winner' : ''
          }`,
        },
        cardFace(played.card),
      )
      this.trick.appendChild(wrapper)
    }
    this.trick.classList.toggle('trick-resolving', view.resolving)
  }

  private renderBanner() {
    const v = this.view
    if (!v) {
      this.banner.textContent = ''
      return
    }
    if (this.status.kind === 'waiting') {
      this.banner.textContent = t.waitingOpponent
      return
    }
    if (v.phase === 'over') {
      this.banner.textContent = ''
      return
    }
    const yourTurn = v.turn === v.mySeat
    if (this.mode === 'hotseat') {
      this.banner.textContent = yourTurn ? t.yourTurn : ''
    } else {
      this.banner.textContent = yourTurn ? t.yourTurn : t.opponentTurn
    }
    this.banner.classList.toggle('banner-active', yourTurn && !v.resolving)
  }

  private renderOverlay() {
    const v = this.view

    if (this.status.kind === 'handoff') {
      this.showOverlay(this.handoffPanel(this.status.seat))
      return
    }
    if (this.status.kind === 'disconnected') {
      this.showOverlay(this.disconnectedPanel())
      return
    }
    if (this.status.kind === 'waiting') {
      this.showOverlay(this.waitingPanel())
      return
    }
    if (v && v.phase === 'over' && !v.resolving) {
      this.showOverlay(this.resultPanel(v))
      return
    }
    this.overlay.hidden = true
    clear(this.overlay)
  }

  private showOverlay(panel: HTMLElement) {
    clear(this.overlay)
    this.overlay.appendChild(panel)
    this.overlay.hidden = false
  }

  private waitingPanel(): HTMLElement {
    return el(
      'div',
      { class: 'panel' },
      el('div', { class: 'spinner', 'aria-hidden': 'true' }),
      el('h2', { text: t.waitingOpponent }),
      this.roomCode ? el('p', { class: 'muted', text: t.shareCode }) : null,
      this.roomCode ? el('div', { class: 'code code-lg', text: this.roomCode }) : null,
      this.ghostButton(t.leave, () => this.callbacks.onLeave()),
    )
  }

  private disconnectedPanel(): HTMLElement {
    return el(
      'div',
      { class: 'panel' },
      el('h2', { text: t.opponentLeft }),
      this.primaryButton(t.leave, () => this.callbacks.onLeave()),
    )
  }

  private handoffPanel(seat: Seat): HTMLElement {
    return el(
      'div',
      { class: 'panel panel-handoff' },
      el('h2', { text: t.handoffTitle }),
      el('p', { class: 'muted', text: t.handoffBody(seat + 1) }),
      this.primaryButton(t.handoffAction, () => this.callbacks.onHandoff()),
    )
  }

  private resultPanel(view: PublicView): HTMLElement {
    const mine = view.myPoints
    const theirs = view.opponentPoints
    const drew = mine === theirs

    let heading: string
    if (this.mode === 'hotseat') {
      heading = drew ? t.draw : t.playerWins((mine > theirs ? view.mySeat : other(view.mySeat)) + 1)
    } else {
      heading = drew ? t.draw : mine > theirs ? t.youWin : t.youLose
    }

    const { mine: mineLabel, theirs: theirsLabel } = this.labels(view)
    const outcomeClass = drew ? 'is-draw' : mine > theirs ? 'is-win' : 'is-loss'

    return el(
      'div',
      { class: `panel panel-result ${outcomeClass}` },
      el('h2', { text: heading }),
      el('p', { class: 'muted', text: t.finalScore }),
      el(
        'div',
        { class: 'final-score' },
        el('div', { class: 'final-side' }, el('span', { class: 'muted', text: mineLabel }), el('strong', { text: String(mine) })),
        el('span', { class: 'final-sep', text: '–' }),
        el('div', { class: 'final-side' }, el('span', { class: 'muted', text: theirsLabel }), el('strong', { text: String(theirs) })),
      ),
      el('p', { class: 'muted small', text: `${mine + theirs} / ${TOTAL_POINTS}` }),
      el(
        'div',
        { class: 'panel-actions' },
        this.primaryButton(t.rematch, () => this.callbacks.onRematch()),
        this.ghostButton(t.leave, () => this.callbacks.onLeave()),
      ),
    )
  }

  private primaryButton(label: string, onClick: () => void): HTMLElement {
    const b = el('button', { class: 'btn btn-primary', type: 'button' }, label)
    b.addEventListener('click', onClick)
    return b
  }

  private ghostButton(label: string, onClick: () => void): HTMLElement {
    const b = el('button', { class: 'btn btn-ghost', type: 'button' }, label)
    b.addEventListener('click', onClick)
    return b
  }
}
