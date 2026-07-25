/**
 * A stable id for this browser, persisted across reloads.
 *
 * The transport's peer id is minted fresh on every page load, so it cannot
 * tell "a new player joined" from "the same player came back after their tab
 * was killed". Mobile browsers discard backgrounded tabs routinely, so that
 * distinction is what makes reconnection possible at all.
 *
 * It identifies a *browser*, not a person, and is only ever sent to peers who
 * already hold the room code.
 */
const KEY = 'briscola.clientId'

let cached: string | null = null

export function clientId(): string {
  if (cached) return cached
  try {
    const stored = localStorage.getItem(KEY)
    if (stored) {
      cached = stored
      return stored
    }
  } catch {
    // Private browsing or storage disabled — fall through to a session-only id.
  }

  const fresh = crypto.randomUUID()
  cached = fresh
  try {
    localStorage.setItem(KEY, fresh)
  } catch {
    // Without storage the id lasts only as long as the page, which means no
    // reconnection. Everything else still works.
  }
  return fresh
}

export function isClientId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64
}
