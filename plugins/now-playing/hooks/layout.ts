// How the pane sizes its cover: the largest of 56, 42 or 28 columns whose
// sleeve (cover plus the record peeking out) fits the width.
export const ART_SIZES = [56, 42, 28] as const
export type ArtSize = (typeof ART_SIZES)[number]
// art 0 means the pane is too narrow for any cover.
export type Layout = { art: ArtSize | 0; peek: number }

export function peekFor(art: number): number {
  return Math.round(art * 0.42)
}

export function layoutFor(columns: number): Layout {
  for (const art of ART_SIZES) {
    if (art + peekFor(art) <= columns) return { art, peek: peekFor(art) }
  }
  return columns < 28 ? { art: 0, peek: 0 } : { art: 28, peek: 0 }
}

// Terminal columns a character takes: East Asian Wide/Fullwidth are 2.
const WIDE: [number, number][] = [
  [0x1100, 0x115f], [0x2e80, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x20000, 0x3fffd],
]

function columnsOf(char: string): number {
  const code = char.codePointAt(0) ?? 0
  return WIDE.some(([lo, hi]) => code >= lo && code <= hi) ? 2 : 1
}

// Text split into lines of at most `width` columns, at spaces when possible.
// `Text` cannot centre its own wrapped lines, so the pane draws one row each.
export function wrapLines(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  let used = 0
  let breakAt = -1 // index in `line` just after the last space
  for (const char of text) {
    const w = columnsOf(char)
    if (used + w > width && line !== '') {
      if (breakAt > 0 && char !== ' ') {
        lines.push(line.slice(0, breakAt).trimEnd())
        line = line.slice(breakAt)
      } else {
        lines.push(line.trimEnd())
        line = ''
      }
      used = [...line].reduce((n, c) => n + columnsOf(c), 0)
      breakAt = -1
      if (char === ' ' && line === '') continue
    }
    line += char
    used += w
    if (char === ' ') breakAt = line.length
  }
  lines.push(line.trimEnd())
  return lines.length > 0 ? lines : ['']
}

// Dark accents vanish on a dark terminal: lift them to a readable brightness.
export function readable(color: number): number {
  const r = color >> 16, g = (color >> 8) & 255, b = color & 255
  const luma = 0.299 * r + 0.587 * g + 0.114 * b
  if (luma >= 110) return color
  const k = 110 / Math.max(1, luma)
  const lift = (c: number) => Math.min(255, Math.round(c * k + 20))
  return (lift(r) << 16) | (lift(g) << 8) | lift(b)
}

export function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}
