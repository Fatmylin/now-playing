type Bmp = { width: number; height: number; pixel: (x: number, y: number) => number }

// The uncompressed 24/32-bit BMP `sips -s format bmp` writes, top-down or
// bottom-up, as a pixel reader answering 0xRRGGBB.
export function readBmp(bmp: Uint8Array): Bmp {
  const dv = new DataView(bmp.buffer, bmp.byteOffset, bmp.byteLength)
  const offset = dv.getUint32(10, true)
  const width = dv.getInt32(18, true)
  const rawHeight = dv.getInt32(22, true)
  const bytesPerPixel = dv.getUint16(28, true) / 8
  const height = Math.abs(rawHeight)
  const stride = Math.ceil((width * bytesPerPixel) / 4) * 4
  const pixel = (x: number, y: number) => {
    const at = offset + (rawHeight < 0 ? y : height - 1 - y) * stride + x * bytesPerPixel
    return ((bmp[at + 2] ?? 0) << 16) | ((bmp[at + 1] ?? 0) << 8) | (bmp[at] ?? 0)
  }
  return { width, height, pixel }
}

// A cover as Raster cells for terminals the engine draws no Image on: each
// cell is '▀', its foreground the upper pixel and its background the lower.
export function bmpToHalfBlocks(bmp: Uint8Array, columns: number, rows: number): string {
  const { width, height, pixel } = readBmp(bmp)
  const at = (x: number, y: number) =>
    pixel(Math.min(width - 1, Math.floor((x * width) / columns)), Math.min(height - 1, Math.floor((y * height) / (rows * 2))))
  const words = new Uint32Array(columns * rows * 3)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const i = (y * columns + x) * 3
      words[i] = 0x2580
      words[i + 1] = at(x, y * 2)
      words[i + 2] = at(x, y * 2 + 1)
    }
  }
  return toBase64(new Uint8Array(words.buffer))
}

// The cover's accent: the mean of its most saturated tenth, so a mostly grey
// sleeve with one red stripe answers red; a fully grey one answers its grey.
export function accentColor(bmp: Uint8Array): number {
  const { width, height, pixel } = readBmp(bmp)
  const scored: { c: number; s: number }[] = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = pixel(x, y)
      const r = c >> 16, g = (c >> 8) & 255, b = c & 255
      const max = Math.max(r, g, b), min = Math.min(r, g, b)
      // Saturation weighted by brightness, so near-black noise does not win.
      scored.push({ c, s: max === 0 ? 0 : ((max - min) / max) * (max / 255) })
    }
  }
  scored.sort((a, b) => b.s - a.s)
  const top = scored.slice(0, Math.max(1, Math.floor(scored.length / 10)))
  const mean = (shift: number) => Math.round(top.reduce((n, p) => n + ((p.c >> shift) & 255), 0) / top.length)
  return (mean(16) << 16) | (mean(8) << 8) | mean(0)
}

const DEFAULT_COLOR = 0x01000000

// The record peeking out from behind the sleeve: the right part of a vinyl
// disc whose centre sits under the cover, its label in the cover's accent and
// a sheen across the grooves at angle `theta`, which turns while it plays.
export function recordCells(columns: number, rows: number, theta: number, label: number): string {
  const h = rows * 2
  const radius = h / 2 - 1
  const cx = columns - 1 - radius
  const cy = h / 2 - 0.5
  const px = (x: number, y: number): number => {
    const dx = x - cx, dy = y - cy
    const d = Math.sqrt(dx * dx + dy * dy)
    if (d > radius) return DEFAULT_COLOR
    if (d < radius * 0.05) return DEFAULT_COLOR
    if (d < radius * 0.34) return label
    const a = Math.atan2(dy, dx)
    const off = Math.abs(((a - theta) % Math.PI + Math.PI * 1.5) % Math.PI - Math.PI / 2)
    const sheen = off < 0.18 ? 0x30 : off < 0.36 ? 0x14 : 0
    const groove = Math.floor(d) % 2 === 0 ? 0x0a : 0
    const v = 0x10 + groove + sheen
    return (v << 16) | (v << 8) | v
  }
  const words = new Uint32Array(columns * rows * 3)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const i = (y * columns + x) * 3
      words[i] = 0x2580
      words[i + 1] = px(x, y * 2)
      words[i + 2] = px(x, y * 2 + 1)
    }
  }
  return toBase64(new Uint8Array(words.buffer))
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? B64[n & 63]! : '='
  }
  return out
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64.indexOf(clean[i]!) << 18) | (B64.indexOf(clean[i + 1] ?? 'A') << 12) |
      ((B64.indexOf(clean[i + 2] ?? 'A') & 63) << 6) | (B64.indexOf(clean[i + 3] ?? 'A') & 63)
    if (o < out.length) out[o++] = (n >> 16) & 255
    if (o < out.length) out[o++] = (n >> 8) & 255
    if (o < out.length) out[o++] = n & 255
  }
  return out
}
