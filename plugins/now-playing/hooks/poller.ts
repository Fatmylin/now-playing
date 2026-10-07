// Pure helpers for the resident status poller: line framing and the
// restart / fallback policy. Nothing here touches the engine.

export const RESTART_BASE_MS = 1000
export const RESTART_CAP_MS = 30_000
export const FALLBACK_AFTER = 3
export const FAILURE_WINDOW_MS = 60_000
export const RETRY_RESIDENT_MS = 300_000
// A resident that streamed this long before ending was healthy: its end is a fresh start.
export const HEALTHY_RUN_MS = 30_000

// A chunk ends wherever the child's write did: append it, return the whole
// lines and keep the unfinished tail.
export function splitLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const parts = (buffer + chunk).split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts, rest }
}

// 1 s, 2 s, 4 s ... capped at 30 s, by consecutive failure number (1-based).
export function backoffMs(consecutive: number): number {
  return Math.min(RESTART_BASE_MS * 2 ** Math.max(0, consecutive - 1), RESTART_CAP_MS)
}

export type PollerState = { failures: number[]; consecutive: number }
export const initialPoller: PollerState = { failures: [], consecutive: 0 }
export type PollerStep = { kind: 'restart'; delayMs: number } | { kind: 'fallback'; retryMs: number }

// The resident process ended or errored at `now` after running `ranMs`.
// Restart after a backoff; the third failure within 60 s falls back to
// one-shot polling and retries the resident loop after 5 minutes.
export function onResidentEnded(state: PollerState, now: number, ranMs: number): { state: PollerState; step: PollerStep } {
  const base = ranMs >= HEALTHY_RUN_MS ? initialPoller : state
  const failures = [...base.failures, now].filter(t => now - t < FAILURE_WINDOW_MS)
  const consecutive = base.consecutive + 1
  if (failures.length >= FALLBACK_AFTER) {
    return { state: initialPoller, step: { kind: 'fallback', retryMs: RETRY_RESIDENT_MS } }
  }
  return { state: { failures, consecutive }, step: { kind: 'restart', delayMs: backoffMs(consecutive) } }
}
