import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { hex, readable } from '../hooks/layout'
import { itunesArtworkUrl, itunesSearchUrl, nextRepeat } from '../hooks/player'

const COMMAND = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

const TRACK = {
  app: 'Music',
  state: 'playing',
  id: 'ABC',
  name: 'bad guy',
  artist: 'Billie Eilish',
  album: 'WHEN WE ALL FALL ASLEEP',
  position: 65,
  duration: 194,
  volume: 40,
}

const LRC = '[00:50.00]one\n[01:00.00]two\n[01:10.00]three\n[01:20.00]four'

function ok(stdout: string): ProcessRunResult {
  return { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

// Stands in for the host: osascript answers with fixed players, and every
// control call is recorded so a test can see what reached Music or Spotify.
function fakeHost(on: On, players: unknown[], now?: number) {
  // Polls read $.clock.now(), so every test gets one mock clock; mocking a second is not supported.
  const clock = mock.clock(on, now === undefined ? undefined : { now })
  const controls: string[][] = []
  const host = { favoriteAnswer: undefined as string | undefined, currentId: TRACK.id as string, isMusicRunning: true, playlists: [] as { name: string; count: number; smart: boolean }[], lyrics: { get: undefined as string | undefined, search: undefined as string | undefined }, requests: [] as string[], isStatusDown: false, playMode: undefined as string | undefined, modes: { Music: { shuffle: false, repeat: 'off' }, Spotify: { shuffle: false, repeat: 'off' } } as Record<string, { shuffle: boolean; repeat: string }> }
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    if (argv[0] === 'osascript' && argv.includes('AppleScript') && argv.some(a => a.includes('favorited'))) {
      const want = String(argv[argv.length - 2])
      const expected = String(argv[argv.length - 1])
      if (!host.isMusicRunning) return { value: ok('not-running|') }
      // The guarded script writes only while the expected song is still current.
      if (expected !== host.currentId) return { value: ok(`changed|${host.currentId}`) }
      controls.push(['favorite', want])
      return { value: ok(host.favoriteAnswer ?? `${host.currentId}|${want}`) }
    }
    if (argv[0] === 'osascript' && argv.includes('JavaScript') && argv.some(a => a.includes('userPlaylists'))) {
      const extra = argv.slice(6) // [osascript -l JavaScript -e script --, ...args]
      if (extra.length === 0) return { value: ok(host.isMusicRunning ? JSON.stringify(host.playlists) : 'not-running') }
      controls.push(['playlist', ...extra])
      return { value: ok(host.playlists.some(p => p.name === extra[0]) ? 'ok' : 'not-found') }
    }
    if (argv[0] === 'osascript' && argv.includes('JavaScript') && argv.some(a => a.includes('songRepeat')) && argv.indexOf('--') < argv.length - 1) {
      const [app, kind, value] = argv.slice(argv.indexOf('--') + 1) as [string, string, string]
      if (app === 'Music' && !host.isMusicRunning) return { value: ok('not-running') }
      controls.push(['playmode', app, kind, value])
      const mode = host.modes[app]!
      if (kind === 'shuffle') mode.shuffle = value === 'true'
      else mode.repeat = app === 'Spotify' && value === 'one' ? 'all' : value
      return { value: ok(host.playMode ?? JSON.stringify(mode)) }
    }
    if (argv[0] === 'osascript' && argv.includes('JavaScript')) {
      const extra = argv.slice(6)
      if (extra.length === 0 && host.isStatusDown) throw new Error('status is down') // no poll can answer // [osascript -l JavaScript -e script --, ...args]
      if (extra.length === 0) {
        const status = ['Music', 'Spotify'].map((app, i) => {
          const p = players[i]
          if (p === 'missing') return { app, isInstalled: false, isRunning: false, track: null }
          return { app, isInstalled: true, isRunning: p !== undefined, track: p ?? null }
        })
        return { value: ok(JSON.stringify(status)) }
      }
      controls.push(extra)
      return { value: ok('ok') }
    }
    if (argv[0] === 'curl') {
      const url = String(argv[argv.indexOf('--') + 1])
      for (const kind of ['get', 'search'] as const) {
        if (url.includes(`lrclib.net/api/${kind}`)) {
          host.requests.push(kind)
          const body = host.lyrics[kind]
          return { value: body === undefined ? { ...ok(''), exitCode: 22 } : ok(body) }
        }
      }
    }
    return { value: { ...ok(''), exitCode: 1 } }
  })
  return { controls, host, clock }
}

describe('music tool', () => {
  test('status reports the playing track', async ($, on) => {
    fakeHost(on, [TRACK, null])
    const ran = await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    expect(String(ran.result)).toContain('Music is playing: "bad guy" by Billie Eilish')
    expect(String(ran.result)).toContain('1:05/3:14')
  })

  test('status says so when nothing plays', async ($, on) => {
    fakeHost(on, [null, null])
    const ran = await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    expect(String(ran.result)).toContain('Nothing is playing')
  })

  test('next goes to the app that is playing', async ($, on) => {
    const { controls } = fakeHost(on, [null, { ...TRACK, app: 'Spotify', id: 'spotify:track:1' }])
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'next' })
    expect(controls).toEqual([['Spotify', 'next', '0']])
  })

  test('volume without a value is refused', async ($, on) => {
    const { controls } = fakeHost(on, [TRACK, null])
    const ran = await $.tool.call({ tool: 'mcp__now-playing__music', action: 'volume' })
    expect(ran.deny).toContain('needs a numeric value')
    expect(controls).toEqual([])
  })
})

describe('/music command', () => {
  test('prev maps to previous', async ($, on) => {
    const { controls } = fakeHost(on, [TRACK, null])
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    await $.command.run({ command: 'music', args: 'prev', ...COMMAND })
    expect(controls).toEqual([['Music', 'previous', '0']])
  })
})

describe('pane', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`shows the track and its buttons work on ${surface}`, async ($, on) => {
      const { controls } = fakeHost(on, [TRACK, null])
      await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
      const ui = await $.ui.mount({
        plugin: 'now-playing',
        surface,
        component: 'Pane',
        requestId: 'now-playing',
        props: { title: 'Now Playing', isFocused: true, bodyColumns: 40, placement: 'dock' } as never,
      })
      expect(await ui.find({ type: 'Text', text: 'bad guy' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Billie Eilish/ })).toBeDefined()
      await ui.press({ key: 'toggle' })
      await ui.press({ key: 'vol-up' })
      expect(controls).toEqual([
        ['Music', 'toggle', '0'],
        ['Music', 'volume', '50'],
      ])
      await ui.unmount()
    })
  }
})

describe('pane tabs', () => {
  test('the Spotify tab controls Spotify while Music plays', async ($, on) => {
    const { controls } = fakeHost(on, [TRACK, { ...TRACK, app: 'Spotify', state: 'paused', id: 'spotify:track:1', name: 'Angel' }])
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    const ui = await $.ui.mount({
      plugin: 'now-playing',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'now-playing',
      props: { title: 'Now Playing', isFocused: true, bodyColumns: 40, placement: 'dock' } as never,
    })
    expect(await ui.find({ type: 'Text', text: 'bad guy' })).toBeDefined()
    await ui.press({ key: 'tab-Spotify' })
    expect(await ui.find({ type: 'Text', text: 'Angel' })).toBeDefined()
    await ui.press({ key: 'next' })
    expect(controls).toEqual([['Spotify', 'next', '0']])
    await ui.unmount()
  })

  test('a closed app offers to open it', async ($, on) => {
    fakeHost(on, [TRACK])
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    const ui = await $.ui.mount({
      plugin: 'now-playing',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'now-playing',
      props: { title: 'Now Playing', isFocused: true, bodyColumns: 40, placement: 'dock' } as never,
    })
    await ui.press({ key: 'tab-Spotify' })
    expect(await ui.find({ key: 'open' })).toBeDefined()
    await ui.unmount()
  })
})

describe('exclusive playback', () => {
  test('starting Spotify pauses Music', async ($, on) => {
    const spotify = { ...TRACK, app: 'Spotify', state: 'paused', id: 'spotify:track:1', name: 'Angel' }
    const { controls } = fakeHost(on, [TRACK, spotify])
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    expect(controls).toEqual([])
    spotify.state = 'playing'
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    expect(controls).toEqual([['Music', 'pause', '0']])
  })

  test('exclusive off leaves both playing', async ($, on) => {
    const spotify = { ...TRACK, app: 'Spotify', state: 'paused', id: 'spotify:track:1', name: 'Angel' }
    const { controls } = fakeHost(on, [TRACK, spotify])
    mock.store(on)
    await $.command.run({ command: 'music', args: 'exclusive off', ...COMMAND })
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    spotify.state = 'playing'
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    expect(controls).toEqual([])
  })
})

describe('iTunes artwork fallback', () => {
  test('asks iTunes for the artist and song', async () => {
    const url = itunesSearchUrl({ ...TRACK, app: 'Music', state: 'playing', artist: 'Conan Gray', name: 'Lookalike' })
    expect(url).toBe('https://itunes.apple.com/search?media=music&entity=song&limit=1&term=Conan%20Gray%20Lookalike')
  })

  test('takes the first result at 600px', async () => {
    const body = JSON.stringify({ results: [{ artworkUrl100: 'https://x.mzstatic.com/a/b.jpg/100x100bb.jpg' }] })
    expect(itunesArtworkUrl(body)).toBe('https://x.mzstatic.com/a/b.jpg/600x600bb.jpg')
  })

  test('no result or bad JSON gives nothing', async () => {
    expect(itunesArtworkUrl('{"results":[]}')).toBe(undefined)
    expect(itunesArtworkUrl('<html>')).toBe(undefined)
  })
})

const PANE_PROPS = (bodyColumns: number) =>
  ({ title: 'Now Playing', isFocused: true, bodyColumns, placement: 'dock' }) as never

describe('centred pane', () => {
  test('title, artist and album rows are centred', async ($, on) => {
    fakeHost(on, [TRACK, null])
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    const ui = await $.ui.mount({ plugin: 'now-playing', surface: 'terminal', component: 'Pane', requestId: 'now-playing', props: PANE_PROPS(84) })
    for (const key of ['row-title-0', 'row-artist-0', 'row-album-0', 'row-transport']) {
      const row = await ui.find({ key })
      expect(row?.props.justifyContent).toBe('center')
    }
    expect((await ui.find({ key: 'row-title-0' }))?.text).toContain('bad guy')
    await ui.unmount()
  })

  test('a long CJK title in a narrow pane draws', async ($, on) => {
    fakeHost(on, [{ ...TRACK, name: '我不想你想你了 (Unplugged in the Woods) 我不想你想你了' }, null])
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    const ui = await $.ui.mount({ plugin: 'now-playing', surface: 'terminal', component: 'Pane', requestId: 'now-playing', props: PANE_PROPS(30) })
    expect((await ui.find({ key: 'row-title-0' }))?.text).toContain('我不想你想你了')
    await ui.unmount()
  })

  test('every wrapped title line is its own centred row', async ($, on) => {
    fakeHost(on, [{ ...TRACK, name: '我不想你想你了 (Unplugged in the Woods) 我不想你想你了' }, null])
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    const ui = await $.ui.mount({ plugin: 'now-playing', surface: 'terminal', component: 'Pane', requestId: 'now-playing', props: PANE_PROPS(30) })
    const rows = []
    for (let i = 0; ; i++) {
      const row = await ui.find({ key: `row-title-${i}` })
      if (row === undefined) break
      rows.push(row)
    }
    expect(rows.length).toBeGreaterThanOrEqual(2)
    for (const row of rows) expect(row.props.justifyContent).toBe('center')
    await ui.unmount()
  })

  test('a very narrow pane draws without a cover', async ($, on) => {
    fakeHost(on, [TRACK, null])
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    const ui = await $.ui.mount({ plugin: 'now-playing', surface: 'terminal', component: 'Pane', requestId: 'now-playing', props: PANE_PROPS(20) })
    expect((await ui.find({ key: 'row-title-0' }))?.text).toContain('bad guy')
    expect(await ui.find({ key: 'row-sleeve' })).toBeUndefined()
    await ui.unmount()
  })

  test('a stopped Apple Music offers Play', async ($, on) => {
    fakeHost(on, [null, null])
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    const ui = await $.ui.mount({ plugin: 'now-playing', surface: 'terminal', component: 'Pane', requestId: 'now-playing', props: PANE_PROPS(84) })
    expect((await ui.find({ key: 'row-message' }))?.text).toContain('Apple Music is stopped.')
    expect((await ui.find({ key: 'toggle' }))?.props.label).toBe('▶ Play')
    await ui.unmount()
  })

  test('a track with no duration draws 0:00 times', async ($, on) => {
    fakeHost(on, [{ ...TRACK, position: 0, duration: 0 }, null])
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    const ui = await $.ui.mount({ plugin: 'now-playing', surface: 'terminal', component: 'Pane', requestId: 'now-playing', props: PANE_PROPS(84) })
    const times = await ui.findAll({ type: 'Text', text: '0:00' })
    expect(times.length).toBe(2)
    await ui.unmount()
  })

  test('no record is mounted while there is no cover', async ($, on) => {
    fakeHost(on, [TRACK, null])
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    const ui = await $.ui.mount({ plugin: 'now-playing', surface: 'terminal', component: 'Pane', requestId: 'now-playing', props: PANE_PROPS(84) })
    expect(await ui.find({ key: 'record' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('player detection', () => {
  test('one installed player draws no tab row', async ($, on) => {
    fakeHost(on, [TRACK, 'missing'])
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    const ui = await $.ui.mount({ plugin: 'now-playing', surface: 'terminal', component: 'Pane', requestId: 'now-playing', props: PANE_PROPS(84) })
    expect(await ui.find({ key: 'row-tabs' })).toBeUndefined()
    expect(await ui.find({ key: 'row-title-0' })).toBeDefined()
    await ui.unmount()
  })

  test('no installed player says what to install', async ($, on) => {
    fakeHost(on, ['missing', 'missing'])
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    const ui = await $.ui.mount({ plugin: 'now-playing', surface: 'terminal', component: 'Pane', requestId: 'now-playing', props: PANE_PROPS(84) })
    expect((await ui.find({ key: 'row-message' }))?.text).toContain('Install Apple Music or Spotify')
    await ui.unmount()
  })

  test('before the first poll answers, it does not ask to install anything', async ($, on) => {
    fakeHost(on, [TRACK, undefined])
    const ui = await $.ui.mount({ plugin: 'now-playing', surface: 'terminal', component: 'Pane', requestId: 'now-playing', props: PANE_PROPS(84) })
    const message = (await ui.find({ key: 'row-message' }))?.text ?? ''
    expect(message).not.toContain('Install')
    expect(message).toContain('Apple Music is closed.')
    await ui.unmount()
  })

  test('the tool refuses an app that is not installed', async ($, on) => {
    const { controls } = fakeHost(on, [TRACK, 'missing'])
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    const ran = await $.tool.call({ tool: 'mcp__now-playing__music', action: 'next', app: 'Spotify' })
    expect(ran.deny).toContain('Spotify is not installed')
    expect(controls).toEqual([])
  })

  test('a player that quit keeps its tab and offers Open', async ($, on) => {
    fakeHost(on, [TRACK, undefined])
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    const ui = await $.ui.mount({ plugin: 'now-playing', surface: 'terminal', component: 'Pane', requestId: 'now-playing', props: PANE_PROPS(84) })
    await ui.press({ key: 'tab-Spotify' })
    expect((await ui.find({ key: 'row-message' }))?.text).toContain('Spotify is closed.')
    expect(await ui.find({ key: 'open' })).toBeDefined()
    await ui.unmount()
  })
})

describe('favorites', () => {
  test('♡ on Apple Music writes favorited true', async ($, on) => {
    const { controls, clock } = fakeHost(on, [{ ...TRACK, favorited: false }, null])
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    const ui = await $.ui.mount({ plugin: 'now-playing', surface: 'terminal', component: 'Pane', requestId: 'now-playing', props: PANE_PROPS(84) })
    expect((await ui.find({ key: 'fav' }))?.props.label).toBe('♡')
    await Promise.all([ui.press({ key: 'fav' }), clock.advance(1500)])
    expect(controls).toContainEqual(['favorite', 'true'])
    await ui.unmount()
  })

  test('the Spotify tab has no favorite button and the tool refuses it', async ($, on) => {
    const spotify = { ...TRACK, app: 'Spotify', id: 'spotify:track:1' }
    fakeHost(on, [null, spotify])
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    const ui = await $.ui.mount({ plugin: 'now-playing', surface: 'terminal', component: 'Pane', requestId: 'now-playing', props: PANE_PROPS(84) })
    expect(await ui.find({ key: 'fav' })).toBeUndefined()
    await ui.unmount()
    const ran = await $.tool.call({ tool: 'mcp__now-playing__music', action: 'favorite', app: 'Spotify' })
    expect(ran.deny).toBe('Favorites are only supported for Apple Music.')
  })

  test('a write that did not stick is reported', async ($, on) => {
    const { host, clock } = fakeHost(on, [{ ...TRACK, favorited: false }, null])
    host.favoriteAnswer = `${TRACK.id}|false`
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    const [ran] = await Promise.all([
      $.tool.call({ tool: 'mcp__now-playing__music', action: 'favorite' }),
      clock.advance(1500),
    ])
    expect(String(ran.result)).toContain('did not change')
  })

  test('a track change before the write changes nothing and says so', async ($, on) => {
    const { controls, host, clock } = fakeHost(on, [{ ...TRACK, favorited: false }, null])
    host.currentId = 'OTHER-TRACK'
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    const [ran] = await Promise.all([
      $.tool.call({ tool: 'mcp__now-playing__music', action: 'favorite' }),
      clock.advance(1500),
    ])
    expect(String(ran.result)).toBe('The song changed before the write; nothing was changed. Try again.')
    expect(controls.filter(c => c[0] === 'favorite')).toEqual([])
  })

  test('Apple Music not running reports it and writes nothing', async ($, on) => {
    const { controls, host, clock } = fakeHost(on, [{ ...TRACK, favorited: false }, null])
    host.isMusicRunning = false
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    const [ran] = await Promise.all([
      $.tool.call({ tool: 'mcp__now-playing__music', action: 'favorite' }),
      clock.advance(1500),
    ])
    expect(String(ran.result)).toBe('Apple Music is not running.')
    expect(controls.filter(c => c[0] === 'favorite')).toEqual([])
  })

  test('a Music track without a favorited property has no favorite button', async ($, on) => {
    fakeHost(on, [TRACK, null])
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    const ui = await $.ui.mount({ plugin: 'now-playing', surface: 'terminal', component: 'Pane', requestId: 'now-playing', props: PANE_PROPS(84) })
    expect(await ui.find({ key: 'fav' })).toBeUndefined()
    await ui.unmount()
  })

  test('the tool refuses favorite for Spotify when it is the only player', async ($, on) => {
    const { controls } = fakeHost(on, [null, { ...TRACK, app: 'Spotify', id: 'spotify:track:1' }])
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    const ran = await $.tool.call({ tool: 'mcp__now-playing__music', action: 'favorite' })
    expect(ran.deny).toBe('Favorites are only supported for Apple Music.')
    expect(controls).toEqual([])
  })

  test('/music favorite is an unknown argument and records no control', async ($, on) => {
    const { controls } = fakeHost(on, [{ ...TRACK, favorited: false }, null])
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    const ran = await $.command.run({ command: 'music', args: 'favorite', ...COMMAND })
    expect(String(ran.text)).toContain('Unknown /music argument "favorite"')
    expect(controls).toEqual([])
  })
})

describe('playlists', () => {
  const LISTS = [
    { name: 'Jpop', count: 976, smart: false },
    { name: 'Kpop ', count: 120, smart: false },
    { name: '中文流行', count: 559, smart: false },
  ]

  test('/music playlist lists them', async ($, on) => {
    const { host } = fakeHost(on, [TRACK, null])
    host.playlists = LISTS
    const ran = await $.command.run({ command: 'music', args: 'playlist', ...COMMAND })
    expect(ran.text).toContain('Jpop (976)')
    expect(ran.text).toContain('中文流行 (559)')
  })

  test('/music playlists lists them like /music playlist', async ($, on) => {
    const { host } = fakeHost(on, [TRACK, null])
    host.playlists = LISTS
    const ran = await $.command.run({ command: 'music', args: 'playlists', ...COMMAND })
    expect(ran.text).toContain('Jpop (976)')
    const plural = await $.command.run({ command: 'music', args: 'playlists jpop', ...COMMAND })
    expect(plural.text).toBe('Playing Jpop (976 songs).')
  })

  test('the tool trims the playlist name before matching and in messages', async ($, on) => {
    const { host } = fakeHost(on, [TRACK, null])
    host.playlists = LISTS
    const none = await $.tool.call({ tool: 'mcp__now-playing__music', action: 'play_playlist', name: ' jazz ' })
    expect(String(none.result)).toBe('No playlist matches "jazz". Try /music playlist to list them.')
    const found = await $.tool.call({ tool: 'mcp__now-playing__music', action: 'play_playlist', name: ' jpop ' })
    expect(String(found.result)).toBe('Playing Jpop (976 songs).')
  })

  test('/music playlist jpop plays Jpop by its exact name', async ($, on) => {
    const { controls, host } = fakeHost(on, [TRACK, null])
    host.playlists = LISTS
    const ran = await $.command.run({ command: 'music', args: 'playlist jpop', ...COMMAND })
    expect(controls).toContainEqual(['playlist', 'Jpop'])
    expect(ran.text).toBe('Playing Jpop (976 songs).')
  })

  test('the trailing-space name is found and passed as is', async ($, on) => {
    const { controls, host } = fakeHost(on, [TRACK, null])
    host.playlists = LISTS
    await $.command.run({ command: 'music', args: 'playlist kpop', ...COMMAND })
    expect(controls).toContainEqual(['playlist', 'Kpop '])
  })

  test('ambiguous and unknown names do not play', async ($, on) => {
    const { controls, host } = fakeHost(on, [TRACK, null])
    host.playlists = LISTS
    const many = await $.command.run({ command: 'music', args: 'playlist pop', ...COMMAND })
    expect(many.text).toBe('Several playlists match "pop": Jpop, Kpop. Be more specific.')
    const none = await $.command.run({ command: 'music', args: 'playlist jazz', ...COMMAND })
    expect(none.text).toBe('No playlist matches "jazz". Try /music playlist to list them.')
    expect(controls.filter(c => c[0] === 'playlist')).toEqual([])
  })

  test('the tool plays a playlist, refuses Spotify and a missing name', async ($, on) => {
    const { controls, host } = fakeHost(on, [TRACK, null])
    host.playlists = LISTS
    const ran = await $.tool.call({ tool: 'mcp__now-playing__music', action: 'play_playlist', name: '中文' })
    expect(String(ran.result)).toBe('Playing 中文流行 (559 songs).')
    expect(controls).toContainEqual(['playlist', '中文流行'])
    const spotify = await $.tool.call({ tool: 'mcp__now-playing__music', action: 'play_playlist', name: 'x', app: 'Spotify' })
    expect(spotify.deny).toBe('Playlists are only supported for Apple Music.')
    const missing = await $.tool.call({ tool: 'mcp__now-playing__music', action: 'play_playlist' })
    expect(missing.deny).toBe('play_playlist needs a playlist name.')
    const list = await $.tool.call({ tool: 'mcp__now-playing__music', action: 'list_playlists' })
    expect(String(list.result)).toContain('Jpop (976)')
  })

  test('a name that starts with a dash reaches the script as an argument', async ($, on) => {
    const { controls, host } = fakeHost(on, [TRACK, null])
    host.playlists = [{ name: '-e x', count: 3, smart: false }]
    const ran = await $.command.run({ command: 'music', args: 'playlist -e x', ...COMMAND })
    expect(controls).toContainEqual(['playlist', '-e x'])
    expect(ran.text).toBe('Playing -e x (3 songs).')
  })

  test('Apple Music not running is reported', async ($, on) => {
    const { host } = fakeHost(on, [TRACK, null])
    host.playlists = LISTS
    host.isMusicRunning = false
    const ran = await $.command.run({ command: 'music', args: 'playlist jpop', ...COMMAND })
    expect(ran.text).toBe('Apple Music is not running.')
  })
})

describe('smooth progress', () => {
  test('the 1 s tick moves the open pane without a new poll', async ($, on) => {
    const { clock, host } = fakeHost(on, [TRACK, null], 1_000_000) // playing at 65 s
    host.lyrics.get = JSON.stringify({ syncedLyrics: LRC })
    const spawns = residentHost(on)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true }) // starts the resident poller, tick and spin timers
    const ui = await $.ui.mount({ plugin: 'now-playing', surface: 'terminal', component: 'Pane', requestId: 'now-playing', props: PANE_PROPS(84) })
    await until(() => spawns.length === 1)
    spawns[0]!.push(MUSIC_STATUS) // the resident poller reads the track and fetches its lyrics
    await settleLoop()
    expect((await ui.find({ key: 'row-times' }))?.text).toContain('1:05')
    expect((await ui.find({ key: 'row-lyric-current' }))?.text).toBe('two')
    host.isStatusDown = true // from here on every poll throws, so only the tick can redraw
    await clock.advance(10_000)
    expect((await ui.find({ key: 'row-times' }))?.text).toContain('1:15')
    expect((await ui.find({ key: 'row-lyric-current' }))?.text).toBe('three')
    expect((await ui.find({ key: 'row-lyric-next' }))?.text).toBe('four')
    await ui.unmount()
  })

  test('the pane shows the position the clock has moved to since the poll', async ($, on) => {
    const { clock } = fakeHost(on, [TRACK, null], 1_000_000) // playing at 65 s
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    await clock.advance(10_000)
    const ui = await $.ui.mount({ plugin: 'now-playing', surface: 'terminal', component: 'Pane', requestId: 'now-playing', props: PANE_PROPS(84) })
    expect((await ui.find({ key: 'row-times' }))?.text).toContain('1:15')
    await ui.unmount()
  })

  test('a paused track does not move', async ($, on) => {
    const { clock } = fakeHost(on, [{ ...TRACK, state: 'paused' }, null], 1_000_000)
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    await clock.advance(10_000)
    const ui = await $.ui.mount({ plugin: 'now-playing', surface: 'terminal', component: 'Pane', requestId: 'now-playing', props: PANE_PROPS(84) })
    expect((await ui.find({ key: 'row-times' }))?.text).toContain('1:05')
    await ui.unmount()
  })
})

// The poll fetches lyrics in the background; one more status call lets its process calls resolve.
async function settle($: { tool: { call: (a: { tool: 'mcp__now-playing__music'; action: 'status' }) => Promise<unknown> } }) {
  await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
}

const mountPane = ($: Engine) =>
  $.ui.mount({ plugin: 'now-playing', surface: 'terminal', component: 'Pane', requestId: 'now-playing', props: PANE_PROPS(84) })

describe('lyrics', () => {
  test('three centred rows around the current line, current in the accent colour', async ($, on) => {
    const { host } = fakeHost(on, [TRACK, null]) // at 65 s → "two"
    host.lyrics.get = JSON.stringify({ syncedLyrics: LRC })
    const ui = await mountPane($)
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    await settle($)
    expect((await ui.find({ key: 'row-lyric-prev' }))?.text).toBe('one')
    const current = await ui.find({ key: 'row-lyric-current' })
    expect(current?.text).toBe('two')
    expect(current?.props.justifyContent).toBe('center')
    // With no cover the accent is the neutral grey, made readable.
    const line = await ui.find({ type: 'Text', text: 'two' })
    expect(line?.props.color).toBe(hex(readable(0x8a8a8a)))
    expect((await ui.find({ key: 'row-lyric-next' }))?.text).toBe('three')
    await ui.unmount()
  })

  test('falls back to search when /get has nothing', async ($, on) => {
    const { host } = fakeHost(on, [TRACK, null])
    host.lyrics.search = JSON.stringify([{ duration: TRACK.duration, syncedLyrics: LRC }])
    const ui = await mountPane($)
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    await settle($)
    expect(host.requests).toEqual(['get', 'search'])
    expect((await ui.find({ key: 'row-lyric-current' }))?.text).toBe('two')
    await ui.unmount()
  })

  test('no lyrics anywhere says so, once per song', async ($, on) => {
    const { host } = fakeHost(on, [TRACK, null])
    const ui = await mountPane($)
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    await settle($)
    await settle($)
    expect(host.requests).toEqual(['get', 'search'])
    expect((await ui.find({ key: 'row-lyric-none' }))?.text).toBe('No synced lyrics')
    expect(await ui.find({ key: 'row-lyric-current' })).toBeUndefined()
    await ui.unmount()
  })

  test('a new song never shows the old song\'s lines', async ($, on) => {
    const song = { ...TRACK }
    const { host } = fakeHost(on, [song, null])
    host.lyrics.get = JSON.stringify({ syncedLyrics: LRC })
    const ui = await mountPane($)
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    await settle($)
    song.id = 'NEW'
    song.name = 'Another'
    host.lyrics.get = undefined
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    await settle($)
    expect(await ui.find({ key: 'row-lyric-current' })).toBeUndefined()
    expect((await ui.find({ key: 'row-lyric-none' }))?.text).toBe('No synced lyrics')
    await ui.unmount()
  })

  test('/music lyrics off hides the rows and stops requests', async ($, on) => {
    const { host } = fakeHost(on, [TRACK, null])
    mock.store(on)
    host.lyrics.get = JSON.stringify({ syncedLyrics: LRC })
    const ran = await $.command.run({ command: 'music', args: 'lyrics off', ...COMMAND })
    expect(ran.text).toBe('Lyrics off.')
    const ui = await mountPane($)
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    await settle($)
    expect(host.requests).toEqual([])
    expect(await ui.find({ key: 'row-lyric-none' })).toBeUndefined()
    expect(await ui.find({ key: 'row-lyric-current' })).toBeUndefined()
    expect((await ui.find({ key: 'lyrics' }))?.props.label).toBe('lyrics off')
    await ui.unmount()
  })

  test('nothing is requested while the pane is closed, and the next poll after it opens asks', async ($, on) => {
    const { host } = fakeHost(on, [TRACK, null])
    host.lyrics.get = JSON.stringify({ syncedLyrics: LRC })
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    await settle($)
    expect(host.requests).toEqual([])
    const ui = await mountPane($)
    expect((await ui.find({ key: 'row-lyric-none' }))?.text).toBe('Looking for lyrics…')
    expect(host.requests).toEqual([]) // a render never fetches
    await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    await settle($)
    expect(host.requests).toEqual(['get'])
    expect((await ui.find({ key: 'row-lyric-current' }))?.text).toBe('two')
    await ui.unmount()
  })
})

describe('play mode', () => {
  const SPOTIFY = { ...TRACK, app: 'Spotify', id: 'spotify:track:1' }
  const call = (args: Record<string, unknown>) => ({ tool: 'mcp__now-playing__music', ...args }) as never

  test('s toggles shuffle on Music', async ($, on) => {
    const { controls, clock } = fakeHost(on, [{ ...TRACK, shuffle: false, repeat: 'off' }, null])
    await $.tool.call(call({ action: 'status' }))
    const ui = await mountPane($)
    await Promise.all([ui.press({ key: 'shuffle' }), clock.advance(1500)])
    expect(controls).toContainEqual(['playmode', 'Music', 'shuffle', 'true'])
    await ui.unmount()
  })

  test('r cycles Music repeat off, all, one, off', async ($, on) => {
    const track = { ...TRACK, shuffle: false, repeat: 'off' }
    const { controls, host, clock } = fakeHost(on, [track, null])
    await $.tool.call(call({ action: 'status' }))
    const ui = await mountPane($)
    for (const [now, next] of [['off', 'all'], ['all', 'one'], ['one', 'off']]) {
      track.repeat = now!
      await $.tool.call(call({ action: 'status' }))
      await Promise.all([ui.press({ key: 'repeat' }), clock.advance(1500)])
      expect(controls[controls.length - 1]).toEqual(['playmode', 'Music', 'repeat', next])
    }
    expect(host.modes.Music!.repeat).toBe('off')
    await ui.unmount()
  })

  test('Spotify repeat cycles off, all, off and never sends one', async ($, on) => {
    const track = { ...SPOTIFY, shuffle: false, repeat: 'off' }
    const { controls, clock } = fakeHost(on, [null, track])
    await $.tool.call(call({ action: 'status' }))
    for (const now of ['off', 'all']) {
      track.repeat = now
      await $.tool.call(call({ action: 'status' }))
      await Promise.all([$.tool.call(call({ action: 'repeat' })), clock.advance(1500)])
    }
    expect(controls.map(c => c[3])).toEqual(['all', 'off'])
  })

  test('the tool refuses repeat one on Spotify', async ($, on) => {
    const { controls } = fakeHost(on, [null, { ...SPOTIFY, shuffle: false, repeat: 'off' }])
    await $.tool.call(call({ action: 'status' }))
    const ran = await $.tool.call(call({ action: 'repeat', mode: 'one' }))
    expect(ran.deny).toBe('Spotify has no repeat-one; use "all" or "off".')
    expect(controls).toEqual([])
  })

  test('the tool reports the value read back', async ($, on) => {
    const { clock } = fakeHost(on, [{ ...TRACK, shuffle: false, repeat: 'off' }, null])
    await $.tool.call(call({ action: 'status' }))
    const [a] = await Promise.all([$.tool.call(call({ action: 'shuffle', mode: 'on' })), clock.advance(1500)])
    expect(a.result).toBe('Shuffle on (Apple Music).')
    const [b] = await Promise.all([$.tool.call(call({ action: 'repeat', mode: 'one' })), clock.advance(1500)])
    expect(b.result).toBe('Repeat one (Apple Music).')
  })

  test('Spotify results name Spotify', async ($, on) => {
    const { clock } = fakeHost(on, [null, { ...SPOTIFY, shuffle: true, repeat: 'off' }])
    await $.tool.call(call({ action: 'status' }))
    const [a] = await Promise.all([$.tool.call(call({ action: 'shuffle', mode: 'off' })), clock.advance(1500)])
    expect(a.result).toBe('Shuffle off (Spotify).')
    const [b] = await Promise.all([$.tool.call(call({ action: 'repeat', mode: 'off' })), clock.advance(1500)])
    expect(b.result).toBe('Repeat off (Spotify).')
  })

  test('a read-back that differs says it did not change', async ($, on) => {
    const { host, clock } = fakeHost(on, [{ ...TRACK, shuffle: false, repeat: 'off' }, null])
    host.playMode = JSON.stringify({ shuffle: false, repeat: 'off' })
    await $.tool.call(call({ action: 'status' }))
    const [a] = await Promise.all([$.tool.call(call({ action: 'shuffle', mode: 'on' })), clock.advance(1500)])
    expect(a.result).toBe('Shuffle did not change (Apple Music).')
    const [b] = await Promise.all([$.tool.call(call({ action: 'repeat', mode: 'all' })), clock.advance(1500)])
    expect(b.result).toBe('Repeat did not change (Apple Music).')
  })

  const dots = async (ui: Awaited<ReturnType<typeof mountPane>>) =>
    ((await ui.find({ key: 'row-playmode' }))?.text ?? '').split('●').length - 1

  test('on shows words, full strength, and an accent dot', async ($, on) => {
    fakeHost(on, [{ ...TRACK, shuffle: true, repeat: 'one' }, null])
    await $.tool.call(call({ action: 'status' }))
    const ui = await mountPane($)
    const shuffle = await ui.find({ key: 'shuffle' })
    const repeat = await ui.find({ key: 'repeat' })
    expect(shuffle?.props.label).toBe('⇄ Shuffle on')
    expect(repeat?.props.label).toBe('↻ Repeat one')
    expect(shuffle?.props.dimColor).not.toBe(true)
    expect(repeat?.props.dimColor).not.toBe(true)
    const marks = await ui.findAll({ type: 'Text', text: '●' })
    expect(marks.length).toBe(2)
    for (const m of marks) expect(m.props.color).toBe(hex(readable(0x8a8a8a)))
    expect(await dots(ui)).toBe(2)
    await ui.unmount()
  })

  test('repeat all reads Repeat all', async ($, on) => {
    fakeHost(on, [{ ...TRACK, shuffle: false, repeat: 'all' }, null])
    await $.tool.call(call({ action: 'status' }))
    const ui = await mountPane($)
    expect((await ui.find({ key: 'repeat' }))?.props.label).toBe('↻ Repeat all')
    expect((await ui.find({ key: 'shuffle' }))?.props.dimColor).toBe(true)
    expect(await dots(ui)).toBe(1)
    await ui.unmount()
  })

  test('off is dim, no dot, and the transport row has neither button', async ($, on) => {
    fakeHost(on, [{ ...TRACK, shuffle: false, repeat: 'off' }, null])
    await $.tool.call(call({ action: 'status' }))
    const ui = await mountPane($)
    const shuffle = await ui.find({ key: 'shuffle' })
    const repeat = await ui.find({ key: 'repeat' })
    expect(shuffle?.props.label).toBe('⇄ Shuffle off')
    expect(repeat?.props.label).toBe('↻ Repeat off')
    expect(shuffle?.props.dimColor).toBe(true)
    expect(repeat?.props.dimColor).toBe(true)
    expect(await dots(ui)).toBe(0)
    const transport = await ui.find({ key: 'row-transport' })
    expect(transport?.text ?? '').not.toMatch(/Shuffle|Repeat|⇄|↻/)
    expect(await ui.find({ key: 'row-playmode' })).toBeDefined()
    await ui.unmount()
  })

  test('a track without shuffle or repeat shows both off', async ($, on) => {
    fakeHost(on, [TRACK, null])
    await $.tool.call(call({ action: 'status' }))
    const ui = await mountPane($)
    expect((await ui.find({ key: 'shuffle' }))?.props.label).toBe('⇄ Shuffle off')
    expect((await ui.find({ key: 'repeat' }))?.props.label).toBe('↻ Repeat off')
    await ui.unmount()
  })

  test('/music shuffle and /music repeat route to the play mode', async ($, on) => {
    const { controls, clock } = fakeHost(on, [{ ...TRACK, shuffle: false, repeat: 'off' }, null])
    await $.tool.call(call({ action: 'status' }))
    const [a] = await Promise.all([$.command.run({ command: 'music', args: 'shuffle', ...COMMAND }), clock.advance(1500)])
    expect(String(a.text)).toBe('Shuffle on (Apple Music).')
    const [b] = await Promise.all([$.command.run({ command: 'music', args: 'repeat', ...COMMAND }), clock.advance(1500)])
    expect(String(b.text)).toBe('Repeat all (Apple Music).')
    expect(controls.map(c => c.slice(0, 3).join(' '))).toEqual(['playmode Music shuffle', 'playmode Music repeat'])
  })

  test('Music not running says so and the script writes nothing', async ($, on) => {
    const { controls, host, clock } = fakeHost(on, [{ ...TRACK, shuffle: false, repeat: 'off' }, null])
    await $.tool.call(call({ action: 'status' }))
    host.isMusicRunning = false
    const [ran] = await Promise.all([$.tool.call(call({ action: 'shuffle' })), clock.advance(1500)])
    expect(ran.result).toBe('Apple Music is not running.')
    expect(controls.filter(c => c[0] === 'playmode')).toEqual([])
  })

  test('describe appends shuffle and repeat only when on', async ($, on) => {
    fakeHost(on, [{ ...TRACK, shuffle: true, repeat: 'one' }, null])
    const ran = await $.tool.call(call({ action: 'status' }))
    expect(String(ran.result)).toContain(' Shuffle on. Repeat one.')
  })

  test('the play-mode row keeps its width when a mode turns on', async ($, on) => {
    const track = { ...TRACK, shuffle: false, repeat: 'off' }
    fakeHost(on, [track, null])
    await $.tool.call(call({ action: 'status' }))
    const ui = await mountPane($)
    const off = (await ui.find({ key: 'row-playmode' }))?.text ?? ''
    track.shuffle = true
    track.repeat = 'all'
    await $.tool.call(call({ action: 'status' }))
    const onText = (await ui.find({ key: 'row-playmode' }))?.text ?? ''
    expect(onText).toContain('●')
    expect(onText.length).toBe(off.length)
    await ui.unmount()
  })

  test('a second repeat while one is in flight is refused', async ($, on) => {
    const { controls, clock } = fakeHost(on, [{ ...TRACK, shuffle: false, repeat: 'off' }, null])
    await $.tool.call(call({ action: 'status' }))
    const [a, b] = await Promise.all([
      $.command.run({ command: 'music', args: 'repeat', ...COMMAND }),
      $.command.run({ command: 'music', args: 'repeat', ...COMMAND }),
      clock.advance(1500),
    ])
    const texts = [String(a.text), String(b.text)]
    expect(controls.filter(c => c[0] === 'playmode')).toHaveLength(1)
    expect(texts).toContain('Repeat is still changing; try again in a moment.')
    expect(texts.some(t => t.startsWith('Repeat all'))).toBe(true)
  })

  test('nextRepeat cycles', () => {
    expect(nextRepeat('Music', 'off')).toBe('all')
    expect(nextRepeat('Music', 'all')).toBe('one')
    expect(nextRepeat('Music', 'one')).toBe('off')
    expect(nextRepeat('Spotify', 'off')).toBe('all')
    expect(nextRepeat('Spotify', 'all')).toBe('off')
    expect(nextRepeat('Spotify', 'one')).toBe('off')
    expect(nextRepeat('Music', undefined)).toBe('all')
  })
})

describe('status for a named app', () => {
  test('status with app reports that app, not the active one', async ($, on) => {
    fakeHost(on, [TRACK, { ...TRACK, app: 'Spotify', state: 'paused', id: 'spotify:track:9', name: 'INORIBANA', artist: '平井 大' }])
    const ran = await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status', app: 'Spotify' })
    expect(String(ran.result)).toContain('Spotify is paused: "INORIBANA" by 平井 大')
  })

  test('status for an app with nothing loaded or closed says so', async ($, on) => {
    fakeHost(on, [TRACK, undefined])
    const closed = await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status', app: 'Spotify' })
    expect(String(closed.result)).toBe('Spotify is not running.')
  })
})

// Stands in for the resident osascript: each spawn is a stream the test feeds.
type FakeSpawn = { argv: string[]; push: (text: string) => void; end: () => void; closed: boolean }
function residentHost(on: On) {
  const spawns: FakeSpawn[] = []
  on('process.spawn', async function* (_$, e) {
    const queue: string[] = []
    let wake: (() => void) | undefined
    let isDone = false
    const s: FakeSpawn = {
      argv: [...e.argv],
      push: text => {
        queue.push(text)
        wake?.()
      },
      end: () => {
        isDone = true
        wake?.()
      },
      closed: false,
    }
    spawns.push(s)
    try {
      while (true) {
        if (queue.length > 0) {
          yield { stream: 'stdout' as const, text: queue.shift()! }
          continue
        }
        if (isDone) return { value: { code: 0, signal: null } }
        await new Promise<void>(resolve => {
          wake = resolve
        })
      }
    } finally {
      s.closed = true
    }
  })
  mock.store(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: e.name } }))
  return spawns
}

async function until(cond: () => boolean) {
  for (let i = 0; i < 5000 && !cond(); i++) await Promise.resolve()
  expect(cond()).toBe(true)
}
const settleLoop = async () => {
  for (let i = 0; i < 2000; i++) await Promise.resolve()
}

const statusLine = (...players: unknown[]) => `${JSON.stringify(players)}\n`
const MUSIC_STATUS = statusLine(
  { app: 'Music', isInstalled: true, isRunning: true, track: TRACK },
  { app: 'Spotify', isInstalled: false, isRunning: false, track: null },
)

describe('resident poller', () => {
  const start = ($: Engine) => $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  test('a streamed status line updates the pane with no one-shot status call', async ($, on) => {
    const { host } = fakeHost(on, [TRACK, null], 1_000_000)
    const spawns = residentHost(on)
    host.isStatusDown = true // a one-shot status poll would throw
    await start($)
    await until(() => spawns.length === 1)
    expect(spawns[0]!.argv.join(' ')).toContain('fileHandleWithStandardOutput')
    spawns[0]!.push(MUSIC_STATUS)
    await settleLoop()
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: 'bad guy' })).toBeDefined()
    await ui.unmount()
  })

  test('a line split across two chunks is read once it is whole', async ($, on) => {
    const { host } = fakeHost(on, [TRACK, null], 1_000_000)
    const spawns = residentHost(on)
    host.isStatusDown = true
    await start($)
    await until(() => spawns.length === 1)
    spawns[0]!.push(MUSIC_STATUS.slice(0, 40))
    await settleLoop()
    let ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: 'bad guy' })).toBeUndefined()
    await ui.unmount()
    spawns[0]!.push(MUSIC_STATUS.slice(40))
    await settleLoop()
    ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: 'bad guy' })).toBeDefined()
    await ui.unmount()
  })

  test('a spawn that ends is started again after a backoff', async ($, on) => {
    const { clock } = fakeHost(on, [TRACK, null], 1_000_000)
    const spawns = residentHost(on)
    await start($)
    await until(() => spawns.length === 1)
    spawns[0]!.end()
    await settleLoop()
    expect(spawns.length).toBe(1) // still inside the 1 s backoff
    await clock.advance(1000)
    await until(() => spawns.length === 2)
  })

  test('interval is 5000 with the pane closed and 2000 once it is open', async ($, on) => {
    fakeHost(on, [TRACK, null], 1_000_000)
    const spawns = residentHost(on)
    await start($)
    await until(() => spawns.length === 1)
    expect(spawns[0]!.argv.slice(-2)).toEqual(['--', '5000'])
    const ui = await mountPane($)
    spawns[0]!.push(MUSIC_STATUS) // the switch is noticed at the next line
    await until(() => spawns.length === 2)
    expect(spawns[0]!.closed).toBe(true)
    expect(spawns[1]!.argv.slice(-2)).toEqual(['--', '2000'])
    await ui.unmount()
  })

  test('three quick failures fall back to one-shot polling', async ($, on) => {
    const { clock } = fakeHost(on, [TRACK, null], 1_000_000)
    mock.store(on)
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('tool.register', (_$, e) => ({ value: { tool: e.name } }))
    on('process.spawn', async function* () {
      throw new Error('cannot spawn')
    })
    await start($)
    await settleLoop()
    await clock.advance(1000) // second try
    await settleLoop()
    await clock.advance(2000) // third try fails: one-shot polling takes over
    await settleLoop()
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: 'bad guy' })).toBeDefined()
    await ui.unmount()
  })

  test('the tool status still polls once, not through the resident loop', async ($, on) => {
    fakeHost(on, [TRACK, null], 1_000_000)
    const spawns = residentHost(on)
    await start($)
    await until(() => spawns.length === 1)
    const ran = await $.tool.call({ tool: 'mcp__now-playing__music', action: 'status' })
    expect(String(ran.result)).toContain('Music is playing: "bad guy"')
  })
})
