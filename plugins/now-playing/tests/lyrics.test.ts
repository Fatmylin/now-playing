import { describe, expect, test } from 'claude-code/testing'

import {
  currentIndex,
  lrclibGetUrl,
  lrclibSearchUrl,
  lyricWindow,
  parseLrc,
  pickSynced,
  positionNow,
  stripTitleSuffix,
  titleCandidates,
} from '../hooks/lyrics'

describe('parseLrc', () => {
  test('reads two- and three-digit fractions and bare seconds', async () => {
    expect(parseLrc('[00:17.47] 曾經也 輕易相信\n[01:02.123]b\n[02:03]c')).toEqual([
      { at: 17.47, text: '曾經也 輕易相信' },
      { at: 62.123, text: 'b' },
      { at: 123, text: 'c' },
    ])
  })

  test('expands several stamps on one line and sorts', async () => {
    expect(parseLrc('[01:20.00][00:10.00]chorus\n[00:30.00]verse')).toEqual([
      { at: 10, text: 'chorus' },
      { at: 30, text: 'verse' },
      { at: 80, text: 'chorus' },
    ])
  })

  test('ignores metadata, applies offset, keeps empty lines', async () => {
    const lines = parseLrc('[ar:Someone]\n[ti:Song]\n[offset:500]\n[00:10.00]one\n[00:12.00]\n[00:14.00]two')
    expect(lines).toEqual([
      { at: 9.5, text: 'one' },
      { at: 11.5, text: '' },
      { at: 13.5, text: 'two' },
    ])
  })

  test('no stamps gives no lines', async () => {
    expect(parseLrc('just some text\n\n')).toEqual([])
  })
})

const LINES = [
  { at: 10, text: 'one' },
  { at: 20, text: 'two' },
  { at: 30, text: 'three' },
]

describe('lyric window', () => {
  test('before the first line', async () => {
    expect(currentIndex(LINES, 5)).toBe(-1)
    expect(lyricWindow(LINES, 5)).toEqual({ prev: '', current: '', next: 'one' })
  })

  test('exactly on a stamp and between stamps', async () => {
    expect(lyricWindow(LINES, 20)).toEqual({ prev: 'one', current: 'two', next: 'three' })
    expect(lyricWindow(LINES, 25)).toEqual({ prev: 'one', current: 'two', next: 'three' })
  })

  test('after the last line and seeking back', async () => {
    expect(lyricWindow(LINES, 99)).toEqual({ prev: 'two', current: 'three', next: '' })
    expect(lyricWindow(LINES, 11)).toEqual({ prev: '', current: 'one', next: 'two' })
  })

  test('a one-line song and an empty song', async () => {
    expect(lyricWindow([{ at: 0, text: 'only' }], 3)).toEqual({ prev: '', current: 'only', next: '' })
    expect(lyricWindow([], 3)).toEqual({ prev: '', current: '', next: '' })
  })
})

describe('lrclib helpers', () => {
  test('titleCandidates adds a CJK title without its trailing Latin run', async () => {
    expect(titleCandidates('甲乙丙丁Strangers')).toEqual(['甲乙丙丁Strangers', '甲乙丙丁'])
    expect(titleCandidates('告白氣球 Love Confession')).toEqual(['告白氣球 Love Confession', '告白氣球'])
    expect(titleCandidates('Lookalike')).toEqual(['Lookalike'])
    expect(titleCandidates('我不想你想你了 (Unplugged in the Woods)')).toEqual(['我不想你想你了'])
    expect(titleCandidates('ABC甲乙')).toEqual(['ABC甲乙'])
    expect(titleCandidates('Strangers')).toEqual(['Strangers'])
  })

  test('lrclibSearchUrl can search with a given title', async () => {
    expect(lrclibSearchUrl({ artist: '李佳薇', name: '甲乙丙丁Strangers' }, '甲乙丙丁')).toBe(
      `https://lrclib.net/api/search?artist_name=${encodeURIComponent('李佳薇')}&track_name=${encodeURIComponent('甲乙丙丁')}`,
    )
  })

  test('stripTitleSuffix drops a trailing bracket or dash suffix', async () => {
    expect(stripTitleSuffix('我不想你想你了 (Unplugged in the Woods)')).toBe('我不想你想你了')
    expect(stripTitleSuffix('Song - Remastered 2011')).toBe('Song')
    expect(stripTitleSuffix('Lookalike')).toBe('Lookalike')
    expect(stripTitleSuffix('(Intro)')).toBe('(Intro)')
  })

  test('URLs are encoded and use whole-second duration', async () => {
    expect(lrclibGetUrl({ artist: 'Sufjan Stevens', name: 'Mystery of Love', album: 'Call Me By Your Name', duration: 248.6 })).toBe(
      'https://lrclib.net/api/get?artist_name=Sufjan%20Stevens&track_name=Mystery%20of%20Love&album_name=Call%20Me%20By%20Your%20Name&duration=249',
    )
    expect(lrclibSearchUrl({ artist: '八三夭', name: '我不想你想你了 (Unplugged in the Woods)' })).toBe(
      `https://lrclib.net/api/search?artist_name=${encodeURIComponent('八三夭')}&track_name=${encodeURIComponent('我不想你想你了')}`,
    )
  })

  test('pickSynced takes the first synced, non-instrumental result', async () => {
    expect(pickSynced(JSON.stringify({ syncedLyrics: '[00:01.00]a' }))).toBe('[00:01.00]a')
    expect(pickSynced(JSON.stringify([{ duration: 90, syncedLyrics: '' }, { duration: 90, syncedLyrics: null }, { duration: 90, syncedLyrics: '[00:02.00]b' }]), 90)).toBe('[00:02.00]b')
    expect(pickSynced(JSON.stringify({ instrumental: true, syncedLyrics: '[00:01.00]x' }))).toBe(undefined)
    expect(pickSynced('<html>')).toBe(undefined)
    expect(pickSynced(JSON.stringify([]))).toBe(undefined)
  })

  test('pickSynced on a search array keeps only records within 5 s of the length', async () => {
    const far = { duration: 234, syncedLyrics: '[00:01.00]far' }
    const near = { duration: 196, syncedLyrics: '[00:01.00]near' }
    expect(pickSynced(JSON.stringify([far, near]), 194)).toBe('[00:01.00]near')
    expect(pickSynced(JSON.stringify([far, { duration: 300, syncedLyrics: '[00:01.00]x' }]), 194)).toBe(undefined)
    // A search result is trusted only with a length to match against.
    expect(pickSynced(JSON.stringify([far, near]))).toBe(undefined)
    expect(pickSynced(JSON.stringify([far]), 0)).toBe(undefined)
    expect(pickSynced(JSON.stringify([near]), -1)).toBe(undefined)
    expect(pickSynced(JSON.stringify({ duration: 10, syncedLyrics: '[00:01.00]g' }), 194)).toBe('[00:01.00]g')
    expect(pickSynced(JSON.stringify([null, { duration: 194, syncedLyrics: '[00:01.00]a' }]), 194)).toBe('[00:01.00]a')
    expect(pickSynced(JSON.stringify([7, null, { duration: 194, syncedLyrics: '[00:01.00]a' }]), 194)).toBe('[00:01.00]a')
  })
})

describe('positionNow', () => {
  const t = { state: 'playing' as const, position: 60, duration: 100 }
  test('playing advances with the clock', async () => {
    expect(positionNow(t, 1_000, 11_000)).toBe(70)
  })
  test('paused stays put', async () => {
    expect(positionNow({ ...t, state: 'paused' }, 1_000, 11_000)).toBe(60)
  })
  test('clamps at the duration; duration 0 does not clamp', async () => {
    expect(positionNow(t, 0, 999_000)).toBe(100)
    expect(positionNow({ ...t, duration: 0 }, 0, 50_000)).toBe(110)
  })
  test('a clock behind polledAt never moves backwards', async () => {
    expect(positionNow(t, 5_000, 4_000)).toBe(60)
  })
})
