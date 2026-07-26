import { DIFFICULTIES, type Difficulty } from '../game/ai'
import { DECK_IDS, deckStyle, type DeckId } from '../game/decks'
import { MATCH_FORMATS, matchTarget, type MatchFormat } from '../game/match'
import { DELAY_OPTIONS, type MatchSettings } from '../game/settings'
import { PLAYER_COUNTS, type PlayerCount } from '../game/table'
import { isValidRoomCode, normaliseRoomCode, ROOM_CODE_LENGTH } from '../net/protocol'
import { suitPip } from './card'
import { el } from './dom'
import { t } from './strings'

export interface MenuCallbacks {
  onHostOnline(): void
  onJoinOnline(code: string): void
  onPlayAi(): void
  onPlayHotseat(): void
  /** Fires whenever a setting changes, so it can be persisted immediately. */
  onSettings(settings: MatchSettings): void
}

/**
 * Match settings.
 *
 * Pace is authoritative-side only — in an online game the host drives trick
 * timing, so the guest's choice would have no effect and is hidden. Deck style
 * is always shown because it is purely local presentation.
 */
export function settingsPanel(
  settings: MatchSettings,
  onChange: (next: MatchSettings) => void,
  opts: { showPace: boolean } = { showPace: true },
): HTMLElement {
  let current = settings

  const update = (patch: Partial<MatchSettings>) => {
    current = { ...current, ...patch }
    onChange(current)
    render()
  }

  const paceRow = el('div', { class: 'setting-options' })
  const deckRow = el('div', { class: 'setting-options' })
  const formatRow = el('div', { class: 'setting-options' })
  const difficultyRow = el('div', { class: 'setting-options' })
  const playersRow = el('div', { class: 'setting-options' })

  const sameFormat = (a: MatchFormat, b: MatchFormat) =>
    a.kind === b.kind && matchTarget(a) === matchTarget(b)

  function render() {
    playersRow.replaceChildren(
      ...PLAYER_COUNTS.map((n: PlayerCount) => {
        const b = el(
          'button',
          {
            class: `chip${n === current.players ? ' is-selected' : ''}`,
            type: 'button',
            'aria-pressed': n === current.players,
          },
          el('span', { class: 'chip-label', text: String(n) }),
          el('span', { class: 'chip-hint', text: n === 4 ? '2 v 2' : n === 3 ? 'a tre' : '1 v 1' }),
        )
        b.addEventListener('click', () => update({ players: n }))
        return b
      }),
    )

    difficultyRow.replaceChildren(
      ...DIFFICULTIES.map((d: Difficulty) => {
        const label = d === 'easy' ? t.diffEasy : d === 'hard' ? t.diffHard : t.diffNormal
        const b = el(
          'button',
          {
            class: `chip${d === current.difficulty ? ' is-selected' : ''}`,
            type: 'button',
            'aria-pressed': d === current.difficulty,
          },
          el('span', { class: 'chip-label', text: label }),
        )
        b.addEventListener('click', () => update({ difficulty: d }))
        return b
      }),
    )

    formatRow.replaceChildren(
      ...MATCH_FORMATS.map(opt => {
        const b = el(
          'button',
          {
            class: `chip${sameFormat(opt.format, current.format) ? ' is-selected' : ''}`,
            type: 'button',
            'aria-pressed': sameFormat(opt.format, current.format),
          },
          el('span', { class: 'chip-label', text: opt.label }),
          el('span', { class: 'chip-hint', text: opt.hint }),
        )
        b.addEventListener('click', () => update({ format: opt.format }))
        return b
      }),
    )

    paceRow.replaceChildren(
      ...DELAY_OPTIONS.map(opt => {
        const b = el(
          'button',
          {
            class: `chip${opt.ms === current.trickDelayMs ? ' is-selected' : ''}`,
            type: 'button',
            'aria-pressed': opt.ms === current.trickDelayMs,
          },
          el('span', { class: 'chip-label', text: opt.label }),
          el('span', { class: 'chip-hint', text: opt.hint }),
        )
        b.addEventListener('click', () => update({ trickDelayMs: opt.ms }))
        return b
      }),
    )

    deckRow.replaceChildren(
      ...DECK_IDS.map((id: DeckId) => {
        const style = deckStyle(id)
        const pips = el('span', { class: 'chip-pips' })
        for (const suit of ['denari', 'coppe', 'spade', 'bastoni'] as const) {
          const p = suitPip(suit, id)
          p.style.color = style.pipColor[suit]
          pips.appendChild(p)
        }
        const b = el(
          'button',
          {
            class: `chip chip-deck${id === current.deck ? ' is-selected' : ''}`,
            type: 'button',
            'aria-pressed': id === current.deck,
          },
          el('span', { class: 'chip-label', text: style.label }),
          pips,
        )
        b.addEventListener('click', () => update({ deck: id }))
        return b
      }),
    )
  }

  render()

  return el(
    'details',
    { class: 'settings' },
    el('summary', {}, el('span', { text: t.settings }), el('span', { class: 'muted small', text: t.settingsHint })),
    opts.showPace
      ? el(
          'div',
          { class: 'setting' },
          el('span', { class: 'field-label', text: t.players }),
          el('span', { class: 'muted small', text: t.playersHint }),
          playersRow,
        )
      : null,
    opts.showPace
      ? el(
          'div',
          { class: 'setting' },
          el('span', { class: 'field-label', text: t.difficulty }),
          el('span', { class: 'muted small', text: t.difficultyHint }),
          difficultyRow,
        )
      : null,
    opts.showPace
      ? el(
          'div',
          { class: 'setting' },
          el('span', { class: 'field-label', text: t.format }),
          el('span', { class: 'muted small', text: t.formatHint }),
          formatRow,
        )
      : null,
    opts.showPace
      ? el(
          'div',
          { class: 'setting' },
          el('span', { class: 'field-label', text: t.pace }),
          el('span', { class: 'muted small', text: t.paceHint }),
          paceRow,
        )
      : null,
    el(
      'div',
      { class: 'setting' },
      el('span', { class: 'field-label', text: t.cardStyle }),
      el('span', { class: 'muted small', text: t.cardStyleHint }),
      deckRow,
    ),
  )
}

export function menuScreen(callbacks: MenuCallbacks, settings: MatchSettings): HTMLElement {
  const root = el('div', { class: 'screen screen-menu' })
  let current = settings

  const choice = (label: string, hint: string, onClick: () => void, variant = '') => {
    const button = el(
      'button',
      { class: `menu-item ${variant}`, type: 'button' },
      el('span', { class: 'menu-label', text: label }),
      el('span', { class: 'menu-hint', text: hint }),
      // What this button will actually start. Without it you can tap "contro
      // il computer" and be surprised by a four-handed game because the table
      // size is buried in a collapsed settings panel.
      el('span', { class: 'menu-setup' }),
    )
    button.addEventListener('click', onClick)
    return button
  }

  const joinPanel = joinForm(callbacks)

  root.append(
    el(
      'header',
      { class: 'masthead' },
      el('h1', { class: 'title', text: t.appTitle }),
      el('p', { class: 'muted', text: t.tagline }),
    ),
    el(
      'div',
      { class: 'menu' },
      choice(t.playOnline, t.playOnlineHint, () => callbacks.onHostOnline(), 'menu-primary'),
      joinPanel,
      choice(t.playAi, t.playAiHint, () => callbacks.onPlayAi()),
      choice(t.playHotseat, t.playHotseatHint, () => callbacks.onPlayHotseat()),
    ),
    settingsPanel(settings, next => {
      current = next
      callbacks.onSettings(next)
      paintSetup()
    }),
    rulesCard(),
  )

  /** Keeps the "what you'll get" line on each mode button in step. */
  function paintSetup() {
    const difficulty =
      current.difficulty === 'easy'
        ? t.diffEasy
        : current.difficulty === 'hard'
          ? t.diffHard
          : t.diffNormal
    const format = MATCH_FORMATS.find(f => sameFormatAs(f.format, current.format))?.label ?? ''

    for (const node of root.querySelectorAll<HTMLElement>('.menu-item')) {
      const isAi = node.querySelector('.menu-label')?.textContent === t.playAi
      const line = node.querySelector('.menu-setup')
      if (!line) continue
      line.textContent = t.setupSummary(
        current.players,
        isAi ? `${format} · ${difficulty}` : format,
      )
    }
  }
  paintSetup()

  return root
}

function sameFormatAs(a: MatchFormat, b: MatchFormat): boolean {
  return a.kind === b.kind && matchTarget(a) === matchTarget(b)
}

function joinForm(callbacks: MenuCallbacks): HTMLElement {
  const input = el('input', {
    class: 'code-input',
    type: 'text',
    inputmode: 'latin',
    autocapitalize: 'characters',
    autocomplete: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    maxlength: ROOM_CODE_LENGTH,
    placeholder: t.roomCodePlaceholder,
    'aria-label': t.roomCodeLabel,
  })

  const submit = el('button', { class: 'btn btn-primary', type: 'submit', disabled: true }, t.join)

  input.addEventListener('input', () => {
    const cleaned = normaliseRoomCode(input.value)
    if (input.value !== cleaned) input.value = cleaned
    submit.toggleAttribute('disabled', !isValidRoomCode(cleaned))
  })

  const form = el(
    'form',
    { class: 'join-form' },
    el('label', { class: 'field-label', for: 'room-code', text: t.joinRoom }),
    el('div', { class: 'join-row' }, input, submit),
  )
  input.id = 'room-code'

  form.addEventListener('submit', event => {
    event.preventDefault()
    const code = normaliseRoomCode(input.value)
    if (isValidRoomCode(code)) callbacks.onJoinOnline(code)
  })

  return form
}

function rulesCard(): HTMLElement {
  return el(
    'details',
    { class: 'rules' },
    el('summary', { text: t.rulesTitle }),
    el('ul', {}, ...t.rules.map(rule => el('li', { text: rule }))),
  )
}

/** Shown to the host while the guest is still connecting. */
export function lobbyScreen(
  code: string,
  onLeave: () => void,
  settings: MatchSettings,
  onSettings: (next: MatchSettings) => void,
): HTMLElement {
  const copy = el('button', { class: 'btn btn-ghost', type: 'button' }, t.copy)
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code)
      copy.textContent = t.copied
      setTimeout(() => (copy.textContent = t.copy), 1500)
    } catch {
      // Clipboard access can be denied; the code is on screen either way.
      copy.textContent = t.copy
    }
  })

  const back = el('button', { class: 'btn btn-ghost', type: 'button' }, t.back)
  back.addEventListener('click', onLeave)

  return el(
    'div',
    { class: 'screen screen-lobby' },
    el(
      'div',
      { class: 'panel' },
      el('h2', { text: t.yourCode }),
      el('p', { class: 'muted', text: t.shareCode }),
      el('div', { class: 'code code-lg', text: code }),
      el('div', { class: 'panel-actions' }, copy, back),
      el('div', { class: 'spinner', 'aria-hidden': 'true' }),
      el('p', { class: 'muted small', text: t.waitingOpponent }),
    ),
    // Still adjustable here: settings only bite when the game is dealt, which
    // is the moment the opponent joins.
    settingsPanel(settings, onSettings),
  )
}
