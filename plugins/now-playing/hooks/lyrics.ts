// Pure helpers for synced lyrics (LRCLIB) and the smoothed play position.

export type LyricLine = { at: number; text: string }

const STAMP = /^\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/

// LRC text to time-sorted lines. Several stamps on one line repeat it; tags
// such as [ar:..] are skipped; [offset:+ms] shifts every line earlier.
export function parseLrc(text: string): LyricLine[] {
  let offset = 0
  const lines: LyricLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim()
    const meta = /^\[offset:\s*([+-]?\d+)\s*\]$/i.exec(trimmed)
    if (meta !== null) {
      offset = Number(meta[1]) / 1000
      continue
    }
    const stamps: number[] = []
    let rest = trimmed
    for (let m = STAMP.exec(rest); m !== null; m = STAMP.exec(rest)) {
      const fraction = m[3] === undefined ? 0 : Number(m[3]) / 10 ** m[3].length
      stamps.push(Number(m[1]) * 60 + Number(m[2]) + fraction)
      rest = rest.slice(m[0].length)
    }
    for (const at of stamps) lines.push({ at, text: rest.trim() })
  }
  return lines
    .map(line => ({ at: Math.max(0, Math.round((line.at - offset) * 1000) / 1000), text: line.text }))
    .sort((a, b) => a.at - b.at)
}

export function currentIndex(lines: readonly LyricLine[], position: number): number {
  let index = -1
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i]?.at ?? Infinity) <= position) index = i
    else break
  }
  return index
}

export function lyricWindow(lines: readonly LyricLine[], position: number) {
  const i = currentIndex(lines, position)
  if (i < 0) return { prev: '', current: '', next: lines[0]?.text ?? '' }
  return { prev: lines[i - 1]?.text ?? '', current: lines[i]?.text ?? '', next: lines[i + 1]?.text ?? '' }
}

// "Song (Live)" or "Song - Remastered 2011" searches better as "Song".
export function stripTitleSuffix(title: string): string {
  const stripped = title
    .replace(/\s*[([（【][^)\]）】]*[)\]）】]\s*$/, '')
    .replace(/\s+-\s+.*$/, '')
    .trim()
  return stripped === '' ? title : stripped
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const TRAILING_PUNCT = /[\s\p{P}]+$/u
const cjkCount = (text: string) => [...text].filter(c => CJK.test(c)).length
const TRAILING_LATIN = /\s*[A-Za-z0-9][A-Za-z0-9 .,'!?&:;+_-]*$/

// Search titles to try, in order. A CJK title with an English subtitle glued on
// ("甲乙丙丁Strangers") is also tried without that trailing Latin run.
export function titleCandidates(title: string): string[] {
  const first = stripTitleSuffix(title)
  const out = [first]
  if (CJK.test(first)) {
    const bare = first.replace(TRAILING_LATIN, '').replace(TRAILING_PUNCT, '')
    // A one-character remainder searches too loosely and can match another song.
    if (bare !== first && cjkCount(bare) >= 2) out.push(bare)
  }
  return out
}

const enc = encodeURIComponent

export function lrclibGetUrl(t: { artist: string; name: string; album: string; duration: number }): string {
  return `https://lrclib.net/api/get?artist_name=${enc(t.artist)}&track_name=${enc(t.name)}&album_name=${enc(t.album)}&duration=${Math.round(t.duration)}`
}

export function lrclibSearchUrl(t: { artist: string; name: string }, title?: string): string {
  return `https://lrclib.net/api/search?artist_name=${enc(t.artist)}&track_name=${enc(title ?? stripTitleSuffix(t.name))}`
}

type LrclibRecord = { syncedLyrics?: unknown; instrumental?: unknown; duration?: unknown }

// The synced lyrics of a /get object or the first usable /search result.
// For a search array, `duration` (seconds) is required and keeps only records within 5 s of it.
export function pickSynced(jsonText: string, duration?: number): string | undefined {
  let body: unknown
  try {
    body = JSON.parse(jsonText)
  } catch {
    return undefined
  }
  const isSearch = Array.isArray(body)
  const items: unknown[] = Array.isArray(body) ? body : body !== null && typeof body === 'object' ? [body] : []
  const records = items.filter((r): r is LrclibRecord => r !== null && typeof r === 'object')
  // A search result is trusted only with a length to match against.
  const hasLength = duration !== undefined && duration > 0
  if (isSearch && !hasLength) return undefined
  const matchLength = isSearch
  const hit = records.find(
    r =>
      r.instrumental !== true &&
      typeof r.syncedLyrics === 'string' &&
      r.syncedLyrics !== '' &&
      (!matchLength || (typeof r.duration === 'number' && Math.abs(r.duration - duration!) <= 5)),
  )
  return hit?.syncedLyrics as string | undefined
}

// Where the song is now, from the last poll's position and the time since.
export function positionNow(
  t: { state: 'playing' | 'paused'; position: number; duration: number },
  polledAt: number,
  now: number,
): number {
  if (t.state !== 'playing') return t.position
  const at = t.position + Math.max(0, now - polledAt) / 1000
  return t.duration > 0 ? Math.min(t.duration, at) : at
}
