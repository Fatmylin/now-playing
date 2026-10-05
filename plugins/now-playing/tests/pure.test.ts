import { describe, expect, test } from 'claude-code/testing'

import { accentColor, bmpToHalfBlocks, fromBase64, recordCells, toBase64 } from '../hooks/artwork'
import { hex, layoutFor, readable, wrapLines } from '../hooks/layout'
import { formatPlaylists, matchPlaylist, parsePlaylists } from '../hooks/player'

// A 2x2 24-bit BMP: row 0 red, green; row 1 blue, white. Rows pad to 8 bytes.
function bmp2x2(isTopDown: boolean): Uint8Array {
  const header = new Uint8Array(54)
  const dv = new DataView(header.buffer)
  header[0] = 0x42
  header[1] = 0x4d
  dv.setUint32(10, 54, true)
  dv.setUint32(14, 40, true)
  dv.setInt32(18, 2, true)
  dv.setInt32(22, isTopDown ? -2 : 2, true)
  dv.setUint16(28, 24, true)
  const top = [0, 0, 255, 0, 255, 0, 0, 0]
  const bottom = [255, 0, 0, 255, 255, 255, 0, 0]
  const rows = isTopDown ? [...top, ...bottom] : [...bottom, ...top]
  const out = new Uint8Array(54 + rows.length)
  out.set(header)
  out.set(rows, 54)
  return out
}

const words = (b64: string) => [...new Uint32Array(fromBase64(b64).buffer)]
const WANT = [0x2580, 0xff0000, 0x0000ff, 0x2580, 0x00ff00, 0xffffff]

describe('artwork', () => {
  test('half blocks read top-down and bottom-up BMPs alike', async () => {
    expect(words(bmpToHalfBlocks(bmp2x2(true), 2, 1))).toEqual(WANT)
    expect(words(bmpToHalfBlocks(bmp2x2(false), 2, 1))).toEqual(WANT)
  })

  test('base64 round-trips every padding length', async () => {
    for (const len of [0, 1, 2, 3, 4, 5, 100]) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) & 255)
      expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes])
    }
    expect(toBase64(Uint8Array.of(1, 2, 3, 4))).toBe('AQIDBA==')
  })

  test('accent picks the most saturated colour', async () => {
    const c = accentColor(bmp2x2(true))
    expect([0xff0000, 0x00ff00, 0x0000ff]).toContain(c)
  })

  test('record cells have one triplet per cell', async () => {
    expect(words(recordCells(18, 21, 0.6, 0xaa7854)).length).toBe(18 * 21 * 3)
  })
})

describe('layout helpers', () => {
  test('hex pads to six digits', async () => {
    expect(hex(0x00ff00)).toBe('#00ff00')
  })

  test('readable lifts dark colours and keeps light ones', async () => {
    expect(readable(0xffffff)).toBe(0xffffff)
    const lifted = readable(0x101010)
    expect(lifted).not.toBe(0x101010)
  })

  test('layoutFor picks the largest cover whose sleeve fits', async () => {
    expect(layoutFor(84)).toEqual({ art: 56, peek: 24 })
    expect(layoutFor(80)).toEqual({ art: 56, peek: 24 })
    expect(layoutFor(79)).toEqual({ art: 42, peek: 18 })
    expect(layoutFor(60)).toEqual({ art: 42, peek: 18 })
    expect(layoutFor(45)).toEqual({ art: 28, peek: 12 })
    expect(layoutFor(30)).toEqual({ art: 28, peek: 0 })
  })
})

describe('wrapLines', () => {
  test('breaks ASCII at a space', async () => {
    expect(wrapLines('hello brave world', 11)).toEqual(['hello brave', 'world'])
  })
  test('counts CJK characters as two columns', async () => {
    const lines = wrapLines('我不想你想你了', 8)
    expect(lines.length).toBe(2)
    expect(lines.join('')).toBe('我不想你想你了')
    for (const line of lines) expect([...line].length * 2).toBeLessThanOrEqual(8)
  })
  test('empty text is one empty line', async () => {
    expect(wrapLines('', 10)).toEqual([''])
  })
  test('a character wider than the width gets its own line', async () => {
    expect(wrapLines('我', 1)).toEqual(['我'])
  })
})

describe('very narrow layout', () => {
  test('below 28 columns there is no cover and no peek', async () => {
    expect(layoutFor(20)).toEqual({ art: 0, peek: 0 })
  })
})

const LISTS = [
  { name: '中文流行', count: 559, smart: false },
  { name: '崩壞:星穹鐵道', count: 419, smart: false },
  { name: 'eng', count: 475, smart: false },
  { name: 'EDM', count: 6, smart: false },
  { name: 'Jpop', count: 976, smart: false },
  { name: 'Kpop ', count: 120, smart: false },
  { name: "Jojo's Bizarre Adventure -Stone Ocean (Original Soundtrack)", count: 60, smart: false },
  { name: 'Recently Added', count: 25, smart: true },
]

describe('playlists', () => {
  test('exact beats prefix beats contains, ignoring case and spaces', async () => {
    expect(matchPlaylist(LISTS, 'kpop')).toEqual({ kind: 'one', playlist: LISTS[5] })
    expect(matchPlaylist(LISTS, ' JPOP ')).toEqual({ kind: 'one', playlist: LISTS[4] })
    expect(matchPlaylist(LISTS, '中文')).toEqual({ kind: 'one', playlist: LISTS[0] })
    expect(matchPlaylist(LISTS, '星穹')).toEqual({ kind: 'one', playlist: LISTS[1] })
    expect(matchPlaylist(LISTS, "jojo's")).toEqual({ kind: 'one', playlist: LISTS[6] })
  })

  test('two matches in the winning tier are ambiguous; nothing is none', async () => {
    expect(matchPlaylist(LISTS, 'e')).toEqual({ kind: 'many', names: ['eng', 'EDM'] })
    expect(matchPlaylist(LISTS, 'classical')).toEqual({ kind: 'none' })
    expect(matchPlaylist(LISTS, '   ')).toEqual({ kind: 'none' })
  })

  test('formatting lists regular playlists then smart ones', async () => {
    const text = formatPlaylists(LISTS)
    expect(text.split('\n')[0]).toBe('中文流行 (559)')
    expect(text).toContain('Kpop (120)')
    expect(text.split('\n').at(-1)).toBe('Smart playlists: Recently Added')
    expect(formatPlaylists([])).toBe('No playlists in Apple Music.')
  })

  test('parsePlaylists reads JSON and not-running', async () => {
    expect(parsePlaylists('not-running')).toBe(null)
    expect(parsePlaylists(JSON.stringify(LISTS))?.length).toBe(8)
    expect(parsePlaylists('garbage')).toEqual([])
  })
})
