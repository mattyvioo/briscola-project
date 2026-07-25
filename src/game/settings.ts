import { DEFAULT_DECK, isDeckId, type DeckId } from './decks'
import { isMatchFormat, type MatchFormat } from './match'
import { isPlayerCount, type PlayerCount } from './table'

/**
 * Match settings chosen before the game starts.
 *
 * In an online game the *host's* settings govern: the host owns the state, so
 * a guest choosing its own pace or table size would just desynchronise the
 * boards. Deck style is the one setting either side may change — the host
 * still applies it and rebroadcasts, so both boards stay in step.
 */
export interface MatchSettings {
  /** How long a completed trick stays face-up, in milliseconds. */
  readonly trickDelayMs: number
  readonly deck: DeckId
  /** How many hands decide the partita. */
  readonly format: MatchFormat
  /** Seats at the table, human or otherwise. */
  readonly players: PlayerCount
}

export interface DelayOption {
  readonly ms: number
  readonly label: string
  readonly hint: string
}

/**
 * Deliberately coarse. The point is "do I get to see what they played?", and
 * a slider of exact milliseconds would be a worse way to ask that.
 */
export const DELAY_OPTIONS: readonly DelayOption[] = [
  { ms: 800, label: 'Veloce', hint: '0,8 s' },
  { ms: 1400, label: 'Normale', hint: '1,4 s' },
  { ms: 2500, label: 'Rilassato', hint: '2,5 s' },
  { ms: 4000, label: 'Molto lento', hint: '4 s' },
]

export const DEFAULT_SETTINGS: MatchSettings = {
  trickDelayMs: 1400,
  deck: DEFAULT_DECK,
  format: { kind: 'single' },
  players: 2,
}

const STORAGE_KEY = 'briscola.settings'

/** Clamps anything loaded from storage or the network back into range. */
export function normaliseSettings(value: unknown): MatchSettings {
  const raw = (value ?? {}) as Partial<Record<keyof MatchSettings, unknown>>
  const ms = Number(raw.trickDelayMs)
  return {
    trickDelayMs: Number.isFinite(ms) ? Math.min(8000, Math.max(300, ms)) : DEFAULT_SETTINGS.trickDelayMs,
    deck: isDeckId(raw.deck) ? raw.deck : DEFAULT_SETTINGS.deck,
    format: isMatchFormat(raw.format) ? raw.format : DEFAULT_SETTINGS.format,
    players: isPlayerCount(raw.players) ? raw.players : DEFAULT_SETTINGS.players,
  }
}

export function loadSettings(): MatchSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored ? normaliseSettings(JSON.parse(stored)) : DEFAULT_SETTINGS
  } catch {
    // Private browsing, disabled storage, corrupt JSON — defaults are fine.
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(settings: MatchSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Persisting preferences is a nicety, never a hard failure.
  }
}
