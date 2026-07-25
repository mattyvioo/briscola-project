import { outcomeForTeam, TOTAL_POINTS } from './rules'
import type { TableConfig } from './table'

/**
 * A *partita* — the sequence of hands that decides who actually won.
 *
 * A single hand is the default because that is what the game shipped with, but
 * Briscola is normally played either to a number of hands won or to a running
 * points total, so both are offered.
 */
export type MatchFormat =
  | { readonly kind: 'single' }
  /** First side to win `target` hands. "Best of 3" is target 2. */
  | { readonly kind: 'bestOf'; readonly target: number }
  /** First side past `target` accumulated card points. */
  | { readonly kind: 'points'; readonly target: number }

export const MATCH_FORMATS: readonly { format: MatchFormat; label: string; hint: string }[] = [
  { format: { kind: 'single' }, label: 'Singola', hint: 'una mano' },
  { format: { kind: 'bestOf', target: 2 }, label: 'Al meglio di 3', hint: '2 mani vinte' },
  { format: { kind: 'bestOf', target: 3 }, label: 'Al meglio di 5', hint: '3 mani vinte' },
  { format: { kind: 'points', target: 301 }, label: 'A 301 punti', hint: 'punti cumulativi' },
  { format: { kind: 'points', target: 1001 }, label: 'A 1001 punti', hint: 'punti cumulativi' },
]

export interface MatchState {
  readonly format: MatchFormat
  /** Hands won, per team. */
  readonly handsWon: readonly number[]
  /** Card points accumulated across hands, per team. */
  readonly points: readonly number[]
  /** 1-based; the hand currently being played. */
  readonly handNumber: number
  /** Teams that have won the match. More than one means a dead heat. */
  readonly winners: readonly number[]
  readonly decided: boolean
}

export function newMatch(format: MatchFormat, teams: number): MatchState {
  return {
    format,
    handsWon: Array(teams).fill(0),
    points: Array(teams).fill(0),
    handNumber: 1,
    winners: [],
    decided: false,
  }
}

/**
 * Folds a finished hand into the match.
 *
 * `handPoints` is the card points each team took in the hand just played —
 * they always sum to 120.
 */
export function recordHand(
  match: MatchState,
  config: TableConfig,
  handPoints: readonly number[],
): MatchState {
  const points = match.points.map((p, i) => p + (handPoints[i] ?? 0))
  const handsWon = match.handsWon.map((w, i) =>
    outcomeForTeam(config, handPoints, i) === 'win' ? w + 1 : w,
  )

  const next: MatchState = {
    ...match,
    points,
    handsWon,
    handNumber: match.handNumber + 1,
    winners: [],
    decided: false,
  }

  return { ...next, ...decide(next) }
}

function decide(match: MatchState): { winners: number[]; decided: boolean } {
  const { format } = match

  if (format.kind === 'single') {
    // One hand and it is over; the hand's own result is the match result.
    const best = Math.max(...match.points)
    return { winners: leadersAt(match.points, best), decided: true }
  }

  const race = format.kind === 'bestOf' ? match.handsWon : match.points
  const best = Math.max(...race)
  if (best < format.target) return { winners: [], decided: false }

  // A points race can be crossed by two teams in the same hand; a hands race
  // cannot, since only one side wins a hand.
  return { winners: leadersAt(race, best), decided: true }
}

function leadersAt(values: readonly number[], best: number): number[] {
  return values.flatMap((v, i) => (v === best ? [i] : []))
}

/** Whatever the format is racing towards, or null for a single hand. */
export function matchTarget(format: MatchFormat): number | null {
  return format.kind === 'single' ? null : format.target
}

/** The number to show next to each team, given the format. */
export function matchScores(match: MatchState): readonly number[] {
  return match.format.kind === 'points' ? match.points : match.handsWon
}

export function isMatchFormat(value: unknown): value is MatchFormat {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { kind?: unknown; target?: unknown }
  if (v.kind === 'single') return true
  if (v.kind !== 'bestOf' && v.kind !== 'points') return false
  // Only the offered targets, so a peer cannot ask for a 10-million point game.
  return MATCH_FORMATS.some(
    f => f.format.kind === v.kind && matchTarget(f.format) === v.target,
  )
}

export const MAX_HAND_POINTS = TOTAL_POINTS
