import type { Card, CardId } from '../game/deck'
import { freshDeck, parseCard } from '../game/deck'
import { DECK_IDS, deckStyle, suitName, type DeckId } from '../game/decks'
import { other, TOTAL_POINTS, type Seat } from '../game/rules'
import { matchTarget } from '../game/match'
import { REACTIONS, type PublicView, type Reaction } from '../net/protocol'
import type { SessionStatus } from '../net/session'
import { cardBack, cardFace, preloadDeck, suitPip } from './card'
import { clear, el, syncKeyed } from './dom'
import {
  isMuted,
  playSound,
  setMuted,
  SOUND_IDS,
  SOUND_LABELS,
  unlockAudio,
  type SoundId,
} from './sounds'
import { t } from './strings'

export interface TableCallbacks {
  onPlay(card: CardId): void
  onRematch(): void
  onLeave(): void
  onHandoff(): void
  onReact(emoji: Reaction): void
  onSound(sound: SoundId): void
  onDeck(deck: DeckId): void
}

type Mode = 'online' | 'ai' | 'hotseat'

/**
 * Spamming reactions is the point, so the cooldown only exists to stop a
 * held-down button saturating the data channel. The visible cap is what keeps
 * the screen readable.
 */
const REACTION_COOLDOWN_MS = 80
const MAX_FLOATING_REACTIONS = 14
/** Sounds overlap badly, so they get a real (if still short) gate. */
const SOUND_COOLDOWN_MS = 350

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
  private lastTrickBox: HTMLElement
  private reactionBar: HTMLElement
  private reactionLayer: HTMLElement
  private soundTray: HTMLElement
  private deckBtn: HTMLElement
  private matchChip: HTMLElement

  private view: PublicView | null = null
  private status: SessionStatus = { kind: 'waiting' }
  private lastReactionAt = 0
  private lastSoundAt = 0

  constructor(
    private mode: Mode,
    /** Fallback until the first view arrives; after that the view decides. */
    private deck: DeckId,
    private callbacks: TableCallbacks,
    private roomCode: string | null = null,
  ) {
    this.matchChip = el('div', { class: 'match-chip', hidden: true })
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
    this.lastTrickBox = el('div', { class: 'last-trick', hidden: true })
    this.reactionLayer = el('div', { class: 'reaction-layer', 'aria-hidden': 'true' })
    this.soundTray = el('div', { class: 'sound-tray', hidden: true })
    this.reactionBar = this.buildReactionBar()

    const leave = el('button', { class: 'btn-ghost btn-leave', type: 'button' }, t.leave)
    leave.addEventListener('click', () => this.callbacks.onLeave())

    // Cycling the deck mid-game is the quickest control that fits in the HUD,
    // and since the deck is shared it changes both boards at once.
    this.deckBtn = el('button', {
      class: 'btn-ghost btn-deck',
      type: 'button',
      'aria-label': t.cardStyle,
      title: t.deckShared,
      text: '🂠',
    })
    this.deckBtn.addEventListener('click', () => {
      const ids = DECK_IDS
      const next = ids[(ids.indexOf(this.deck) + 1) % ids.length]!
      this.callbacks.onDeck(next)
    })

    this.root = el(
      'div',
      { class: `table table-${mode}` },
      el(
        'div',
        { class: 'hud' },
        el('div', { class: 'score score-theirs' }, this.nameTheirs, this.hudTheirs),
        el('div', { class: 'hud-mid' }, this.matchChip, this.deckBtn, leave),
        el('div', { class: 'score score-mine' }, this.nameMine, this.hudMine),
      ),
      this.opponentHand,
      el('div', { class: 'board' }, this.stock, this.trick, this.lastTrickBox),
      this.banner,
      this.myHand,
      el('div', { class: 'bar-wrap' }, this.soundTray, this.reactionBar),
      this.reactionLayer,
      this.overlay,
    )

    // One delegated listener rather than one per card, so re-renders stay cheap.
    this.myHand.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('.card-playable')
      const id = button?.dataset['card'] as CardId | undefined
      if (id && this.canPlay()) this.callbacks.onPlay(id)
    })

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

  private labels(view: PublicView): { mine: string; theirs: string } {
    if (this.mode !== 'hotseat') return { mine: t.you, theirs: t.opponent }
    return { mine: t.player(view.mySeat + 1), theirs: t.player(other(view.mySeat) + 1) }
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
    // Deck style is shared match state, so follow whatever the view says. When
    // the opponent switches it, warm the new artwork so cards don't pop in.
    if (view.deck !== this.deck) preloadDeck(freshDeck(), view.deck)
    this.deck = view.deck
    this.deckBtn.title = `${deckStyle(view.deck).label} — ${t.deckShared}`

    const { mine, theirs } = this.labels(view)
    this.nameMine.textContent = mine
    this.nameTheirs.textContent = theirs
    this.hudMine.textContent = String(view.myPoints)
    this.hudTheirs.textContent = String(view.opponentPoints)

    this.renderMatch(view)
    this.renderOpponentHand(view)
    this.renderMyHand(view)
    this.renderStock(view)
    this.renderTrick(view)
    this.renderLastTrick(view)
    this.renderBanner()
    this.renderOverlay()
  }

  // --- reactions ----------------------------------------------------------

  private buildReactionBar(): HTMLElement {
    const bar = el('div', { class: 'reaction-bar' })

    for (const emoji of REACTIONS) {
      const b = el('button', {
        class: 'reaction-btn',
        type: 'button',
        'aria-label': `${t.sendReaction} ${emoji}`,
        text: emoji,
      })
      b.addEventListener('click', () => this.sendReaction(emoji))
      bar.appendChild(b)
    }

    // Sounds live in a tray rather than a second permanent row: vertical space
    // is the scarce resource on a phone in landscape.
    const toggle = el('button', {
      class: 'reaction-btn bar-toggle',
      type: 'button',
      'aria-label': t.soundboard,
      text: '🔊',
    })
    toggle.addEventListener('click', () => {
      unlockAudio()
      this.soundTray.hidden = !this.soundTray.hidden
      toggle.classList.toggle('is-open', !this.soundTray.hidden)
    })
    bar.appendChild(toggle)

    for (const id of SOUND_IDS) {
      const { icon, label } = SOUND_LABELS[id]
      const b = el('button', {
        class: 'sound-btn',
        type: 'button',
        title: label,
        'aria-label': label,
        text: icon,
      })
      b.addEventListener('click', () => this.sendSound(id))
      this.soundTray.appendChild(b)
    }

    const mute = el('button', {
      class: 'sound-btn sound-mute',
      type: 'button',
      'aria-label': t.mute,
      text: isMuted() ? '🔇' : '🔈',
    })
    mute.addEventListener('click', () => {
      setMuted(!isMuted())
      mute.textContent = isMuted() ? '🔇' : '🔈'
    })
    this.soundTray.appendChild(mute)

    return bar
  }

  private sendReaction(emoji: Reaction) {
    const now = Date.now()
    if (now - this.lastReactionAt < REACTION_COOLDOWN_MS) return
    this.lastReactionAt = now
    this.callbacks.onReact(emoji)
    this.showReaction(emoji, 'mine')
  }

  private sendSound(id: SoundId) {
    const now = Date.now()
    if (now - this.lastSoundAt < SOUND_COOLDOWN_MS) return
    this.lastSoundAt = now
    unlockAudio()
    playSound(id)
    this.callbacks.onSound(id)
    this.showReaction(SOUND_LABELS[id].icon as Reaction, 'mine')
  }

  /** Plays a sound the opponent triggered, and shows what caused it. */
  playRemoteSound(id: SoundId) {
    playSound(id)
    this.showReaction(SOUND_LABELS[id].icon as Reaction, 'theirs')
  }

  /** Floats an emoji up from the relevant side of the table. */
  showReaction(emoji: string, from: 'mine' | 'theirs') {
    // Cap the layer: spamming is encouraged, an unreadable screen is not.
    const live = this.reactionLayer.children
    while (live.length >= MAX_FLOATING_REACTIONS) live[0]!.remove()

    const node = el('span', { class: `reaction reaction-${from}`, text: emoji })
    // Jitter horizontally so a burst doesn't stack into one illegible pile.
    node.style.setProperty('--drift', `${Math.round((Math.random() - 0.5) * 90)}px`)
    node.style.setProperty('--delay', `${Math.round(Math.random() * 90)}ms`)
    this.reactionLayer.appendChild(node)
    node.addEventListener('animationend', () => node.remove())
  }

  /** Match score, shown only when a partita spans more than one hand. */
  private renderMatch(view: PublicView) {
    const m = view.match
    if (m.format.kind === 'single') {
      this.matchChip.hidden = true
      return
    }
    this.matchChip.hidden = false
    const mine = m.myScore
    const best = Math.max(...m.scores.filter((_, i) => i !== m.myTeam), 0)
    clear(this.matchChip)
    this.matchChip.append(
      el('span', { class: 'match-label', text: t.matchScore }),
      el('span', { class: 'match-value', text: `${mine}\u2013${best}` }),
    )
    this.matchChip.title = `${t.handNumber(m.handNumber)} \u00b7 ${matchTarget(m.format) ?? ''}`
  }

  // --- board --------------------------------------------------------------

  private renderOpponentHand(view: PublicView) {
    const keys = Array.from({ length: view.opponentCards }, (_, i) => `back-${i}`)
    syncKeyed(this.opponentHand, keys, () => cardBack())
  }

  private renderMyHand(view: PublicView) {
    const playable = this.canPlay()
    // The deck is part of the key: nodes are reused by key, so keying on the
    // card id alone would leave the old artwork in place when the deck changes.
    syncKeyed(
      this.myHand,
      view.hand.map(c => `${view.deck}:${c.id}`),
      key =>
        cardFace(parseCard(key.split(':')[1] as CardId), {
          deck: this.deck,
          playable: true,
          trump: view.trumpSuit,
        }),
      (node, _key, index) => {
        node.classList.toggle('is-disabled', !playable)
        node.toggleAttribute('disabled', !playable)
        node.style.setProperty('--i', String(index))
      },
    )
    this.myHand.classList.toggle('hand-active', playable)
  }

  /**
   * The briscola sits beside the stock rather than tucked under it: it is the
   * single most important fact on the table and it was previously half hidden
   * behind the deck.
   */
  private renderStock(view: PublicView) {
    clear(this.stock)

    const faceDown = view.stockLeft - (view.trumpTaken ? 0 : 1)

    if (faceDown > 0) {
      this.stock.appendChild(el('div', { class: 'deck' }, cardBack()))
    }

    if (!view.trumpTaken) {
      this.stock.appendChild(
        el(
          'div',
          { class: 'trump' },
          cardFace(view.trumpCard, { deck: this.deck, trump: view.trumpSuit }),
          el('span', { class: 'trump-label', text: t.briscola }),
        ),
      )
    }

    // Turns left, not cards left: "how much game is there still to play" is
    // what people actually want to know, and it keeps counting after the
    // stock is empty.
    this.stock.appendChild(
      el(
        'div',
        { class: 'turns' },
        el('span', { class: 'turns-value', text: String(view.tricksLeft) }),
        el('span', { class: 'turns-label', text: t.turnsLeft(view.tricksLeft) }),
      ),
    )
  }

  private renderTrick(view: PublicView) {
    clear(this.trick)
    for (const played of view.table) {
      const isMine = played.seat === view.mySeat
      this.trick.appendChild(
        el(
          'div',
          {
            class: `played ${isMine ? 'played-mine' : 'played-theirs'}${
              view.resolving && view.lastWinner === played.seat ? ' played-winner' : ''
            }`,
          },
          cardFace(played.card, { deck: this.deck, trump: view.trumpSuit }),
        ),
      )
    }
    this.trick.classList.toggle('trick-resolving', view.resolving)
  }

  /** A small recap of the previous trick, so you can check what was played. */
  private renderLastTrick(view: PublicView) {
    const last = view.lastTrick
    // Hide it while the current trick is still on the table, otherwise the
    // same two cards appear twice and it reads as a bug.
    if (!last || view.resolving || view.phase === 'over') {
      this.lastTrickBox.hidden = true
      clear(this.lastTrickBox)
      return
    }

    clear(this.lastTrickBox)
    this.lastTrickBox.hidden = false
    this.lastTrickBox.appendChild(
      el(
        'div',
        { class: `last-trick-inner ${last.iWon ? 'is-won' : 'is-lost'}` },
        el('span', { class: 'last-trick-title', text: t.lastTrick }),
        el(
          'div',
          { class: 'last-trick-cards' },
          // Shown in play order, with the winning card marked, so the recap
          // reads the same way at a 2, 3 or 4 player table.
          ...last.plays.map(p =>
            this.miniCard(p.card, p.seat === view.mySeat ? t.you : t.opponent, p.seat === last.winner),
          ),
        ),
        el('span', {
          class: 'last-trick-result',
          text: `${last.iWon ? t.wonTrick : t.lostTrick} · ${last.points}`,
        }),
      ),
    )
  }

  private miniCard(card: Card, who: string, won = false): HTMLElement {
    return el(
      'div',
      { class: `mini${won ? ' mini-won' : ''}` },
      cardFace(card, { deck: this.deck }),
      el('span', { class: 'mini-who', text: who }),
    )
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
    this.banner.textContent =
      this.mode === 'hotseat' ? (yourTurn ? t.yourTurn : '') : yourTurn ? t.yourTurn : t.opponentTurn
    this.banner.classList.toggle('banner-active', yourTurn && !v.resolving)
  }

  private renderOverlay() {
    const v = this.view

    // Reactions only make sense when there is another browser to receive them.
    this.reactionBar.hidden = this.mode !== 'online' || this.status.kind !== 'playing'
    if (this.reactionBar.hidden) this.soundTray.hidden = true

    if (this.status.kind === 'handoff') return this.showOverlay(this.handoffPanel(this.status.seat))
    if (this.status.kind === 'disconnected') return this.showOverlay(this.disconnectedPanel())
    if (this.status.kind === 'full') return this.showOverlay(this.fullPanel())
    if (this.status.kind === 'waiting') return this.showOverlay(this.waitingPanel())
    if (v && v.phase === 'over' && !v.resolving) return this.showOverlay(this.resultPanel(v))

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

  private fullPanel(): HTMLElement {
    return el(
      'div',
      { class: 'panel' },
      el('h2', { text: t.roomFull }),
      el('p', { class: 'muted', text: t.roomFullHint }),
      this.primaryButton(t.leave, () => this.callbacks.onLeave()),
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

    // A hand inside an undecided partita reads differently from the partita
    // itself ending — otherwise "Hai vinto" appears five times in a best-of-5.
    const m = view.match
    const multiHand = m.format.kind !== 'single'
    const matchOver = !multiHand || m.decided

    let heading: string
    if (matchOver && multiHand) {
      heading = m.winners.length > 1
        ? t.matchDraw
        : m.winners[0] === m.myTeam
          ? t.matchWon
          : t.matchLost
    } else if (this.mode === 'hotseat') {
      heading = drew ? t.draw : t.playerWins((mine > theirs ? view.mySeat : other(view.mySeat)) + 1)
    } else if (multiHand) {
      heading = drew ? t.draw : mine > theirs ? t.handWon : t.handLost
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
      multiHand
        ? el('p', {
            class: 'muted small',
            text: `${t.matchScore} ${m.myScore}\u2013${Math.max(...m.scores.filter((_, i) => i !== m.myTeam), 0)}`,
          })
        : null,
      el(
        'div',
        { class: 'panel-actions' },
        this.primaryButton(
          !multiHand ? t.rematch : matchOver ? t.newMatch : t.nextHand,
          () => this.callbacks.onRematch(),
        ),
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

/** Suit name plus its pip — used in the banner and settings preview. */
export function suitChip(view: { trumpSuit: Card['suit'] }, deck: DeckId): HTMLElement {
  return el(
    'span',
    { class: 'suit-chip' },
    suitPip(view.trumpSuit, deck),
    el('span', { text: suitName(view.trumpSuit, deck) }),
  )
}
