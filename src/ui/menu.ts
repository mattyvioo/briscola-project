import { isValidRoomCode, normaliseRoomCode, ROOM_CODE_LENGTH } from '../net/protocol'
import { el } from './dom'
import { t } from './strings'

export interface MenuCallbacks {
  onHostOnline(): void
  onJoinOnline(code: string): void
  onPlayAi(): void
  onPlayHotseat(): void
}

export function menuScreen(callbacks: MenuCallbacks): HTMLElement {
  const root = el('div', { class: 'screen screen-menu' })

  const choice = (label: string, hint: string, onClick: () => void, variant = '') => {
    const button = el(
      'button',
      { class: `menu-item ${variant}`, type: 'button' },
      el('span', { class: 'menu-label', text: label }),
      el('span', { class: 'menu-hint', text: hint }),
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
    rulesCard(),
  )

  return root
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
export function lobbyScreen(code: string, onLeave: () => void): HTMLElement {
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
  )
}
