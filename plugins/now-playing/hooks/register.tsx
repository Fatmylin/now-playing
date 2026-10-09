import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ArtMode, Cover, Player, PlayerApp, RepeatMode, Track } from '../types'
import {
  ACTIONS,
  APPS,
  CONTROL_JXA,
  FAVORITE_APPLESCRIPT,
  MUSIC_ARTWORK_APPLESCRIPT,
  PLAYLISTS_JXA,
  PLAYMODE_JXA,
  PLAY_PLAYLIST_JXA,
  STATUS_JXA,
  STATUS_LOOP_JXA,
  describe,
  formatPlaylists,
  itunesArtworkUrl,
  itunesSearchUrl,
  matchPlaylist,
  nextRepeat,
  parsePlaylists,
  parseStatus,
  pickActive,
  toPause,
} from './player'
import type { Action, PlaylistInfo } from './player'
import { accentColor, bmpToHalfBlocks, fromBase64, recordCells } from './artwork'
import { ART_SIZES, layoutFor, readable } from './layout'
import { lrclibGetUrl, lrclibSearchUrl, lyricWindow, parseLrc, pickSynced, positionNow, titleCandidates } from './lyrics'
import type { LyricLine } from './lyrics'
import { initialPoller, mayRestartForInterval, onResidentEnded, parsePidLine, splitLines } from './poller'
import { paneTree } from './pane'
import type { PaneView } from './pane'

const PANE = 'now-playing'
const PANE_COLUMNS = 84
const POLL_MS = 2000
const POLL_CLOSED_MS = 5000
const SPIN_MS = 150
const ALIASES: Record<string, string> = { n: 'next', b: 'previous', prev: 'previous', k: 'toggle' }
const LABELS: Record<PlayerApp, string> = { Music: 'Apple Music', Spotify: 'Spotify' }
const NEUTRAL = 0x8a8a8a

const trackAtom = atom({ plugin: 'now-playing', key: 'track' } as const, null)
const playersAtom = atom({ plugin: 'now-playing', key: 'players' } as const, [])
const sourceAtom = atom({ plugin: 'now-playing', key: 'source' } as const, null)
const coversAtom = atom({ plugin: 'now-playing', key: 'covers' } as const, {})
const artModeAtom = atom({ plugin: 'now-playing', key: 'artMode' } as const, 'blocks')
const tickAtom = atom({ plugin: 'now-playing', key: 'tick' } as const, 0)
const lyricsOnAtom = atom({ plugin: 'now-playing', key: 'lyricsOn' } as const, true)
const lyricsRevAtom = atom({ plugin: 'now-playing', key: 'lyricsRev' } as const, 0)

const LRCLIB_AGENT = 'User-Agent: now-playing (https://github.com/Fatmylin/now-playing)'
const LYRICS_CACHE_MAX = 50
// Per track id; a miss or a failure is remembered as 'none' for the session.
const lyricsCache = new Map<string, { status: 'found'; lines: LyricLine[] } | { status: 'none' }>()
const lyricsLoading = new Set<string>()

let isPolling = false
// Status results are applied one at a time, so a one-shot poll and a resident line never double-pause.
let applying: Promise<unknown> = Promise.resolve()
// A play-mode write waits ~1.5 s for its read-back; presses of that kind meanwhile are refused.
const playModeBusy = { shuffle: false, repeat: false }
// When each app's position was read, and whether the 1 s tick should redraw.
const polledAt: Partial<Record<PlayerApp, number>> = {}
let isTicking = false
// Lyrics are looked up only while the pane is mounted: set by its render, cleared on close.
let isPaneOpen = false
let lastStatus: string | undefined
const coverFor: Partial<Record<PlayerApp, string>> = {}
let coverDir: string | undefined
// Exclusive playback: what each app was doing at the last poll.
let isExclusive = true
let lastStates: Partial<Record<PlayerApp, string>> = {}
// The record as last drawn, so the spin timer repaints just its cells.
let theta = 0
let record: { columns: number; rows: number; label: number; isPlaying: boolean } | null = null

async function osascript($: EngineInterface, script: string, args: string[] = [], lang = 'JavaScript') {
  return $.process.run(['osascript', '-l', lang, '-e', script, '--', ...args], { timeoutMs: 10000 })
}

async function curl($: EngineInterface, args: string[]) {
  return $.process.run(['curl', '-sfL', '--proto', '=https', '--proto-redir', '=https', '--max-time', '10', ...args], { timeoutMs: 15000 })
}

// The pane is open: poll fast; closed: slowly.
const wantedMs = () => (isPaneOpen ? POLL_MS : POLL_CLOSED_MS)

async function poll($: EngineInterface): Promise<Track | null> {
  if (isPolling) return read($, trackAtom)
  isPolling = true
  try {
    const { stdout } = await osascript($, STATUS_JXA)
    return await applyStatus($, parseStatus(stdout))
  } catch {
    return read($, trackAtom)
  } finally {
    isPolling = false
  }
}

function applyStatus($: EngineInterface, players: Player[]): Promise<Track | null> {
  const run = applying.then(() => applyNow($, players))
  applying = run.catch(() => undefined)
  return run
}

async function applyNow($: EngineInterface, players: Player[]): Promise<Track | null> {
  const polledNow = await $.clock.now()
  // One app just started while another plays: pause the other.
  if (isExclusive) {
    for (const app of toPause(lastStates, players)) await osascript($, CONTROL_JXA, [app, 'pause', '0'])
  }
  lastStates = Object.fromEntries(players.map(p => [p.app, p.track?.state ?? 'idle']))

  const track = pickActive(players)
  // The position and the time it was read change together.
  for (const p of players) polledAt[p.app] = polledNow
  await update($, playersAtom, () => players)
  await update($, trackAtom, () => track)

  const status =
    track === null
      ? undefined
      : `${track.state === 'playing' ? '♪' : '⏸'} ${track.name} — ${track.artist}${track.app === 'Music' && track.favorited === true ? ' ♥' : ''}`
  if (status !== lastStatus) {
    lastStatus = status
    $.ui.status(status)
  }
  for (const player of players) {
    if (player.track !== null && player.track.id !== coverFor[player.app]) {
      coverFor[player.app] = player.track.id
      // A cover that cannot be fetched is simply not drawn.
      void fetchCover($, player.track).catch(() => undefined)
    }
  }
  if (isPaneOpen && (await read($, lyricsOnAtom))) {
    const picked = await read($, sourceAtom)
    for (const p of players) {
      if (p.track !== null && (p.app === track?.app || p.app === picked)) void fetchLyrics($, p.track).catch(() => undefined)
    }
  }
  return track
}

const debug = ($: EngineInterface, text: string) => $.ui.log(text, { to: 'debug' })

// $.clock.sleep belongs to a dispatch; a wait that outlives one uses a timer.
const wait = ($: EngineInterface, ms: number) => new Promise<void>(resolve => void $.clock.after(ms, resolve))

// A pane that flips open and closed (a render, then a denied blit) must not respawn the child each time.
let lastSwitchAt = -Infinity
let isPollerRunning = false

// Kills a stalled resident by pid, but only a pid that still runs our loop script.
async function killStalled($: EngineInterface, pid: number | undefined) {
  if (pid === undefined) return
  const seen = await $.process.run(['ps', '-p', String(pid), '-o', 'command='], { timeoutMs: 5000 })
  if (seen.exitCode !== 0 || !seen.stdout.includes('fileHandleWithStandardOutput')) {
    debug($, `now-playing: pid ${pid} is not the resident poller; not killing it`)
    return
  }
  await $.process.run(['kill', String(pid)], { timeoutMs: 5000 })
}

// One resident osascript at `ms`, one status line per interval. Returns how it
// ended: 'switch' when the pane opened or closed (the caller restarts it at the
// other interval; at most once per 30 s), 'ended' when the process ended,
// errored or stalled (no output for 3 intervals + 10 s).
async function runResident($: EngineInterface, ms: number): Promise<'switch' | 'ended'> {
  let buffer = ''
  let pid: number | undefined
  const stream = $.process.spawn({ argv: ['osascript', '-l', 'JavaScript', '-e', STATUS_LOOP_JXA, '--', String(ms)] })
  const it = stream[Symbol.asyncIterator]()
  try {
    while (true) {
      let timer: { cancel: () => void } | undefined
      const stalled = new Promise<'stall'>(resolve => {
        timer = $.clock.after(3 * ms + 10_000, () => resolve('stall'))
      })
      const got = await Promise.race([it.next(), stalled]).finally(() => timer?.cancel())
      if (got === 'stall') {
        debug($, 'now-playing: resident poller silent; restarting it')
        // return() may queue behind the pending next(), so the child is killed by pid.
        await killStalled($, pid).catch(() => undefined)
        void it.return?.(undefined as never).catch(() => undefined)
        return 'ended'
      }
      if (got.done) return 'ended'
      const chunk = got.value
      if (chunk.stream !== 'stdout') continue
      const split = splitLines(buffer, chunk.text)
      buffer = split.rest
      for (const line of split.lines) {
        if (line.trim() === '') continue
        const first = parsePidLine(line)
        if (first !== undefined) {
          pid = first
          continue
        }
        await applyStatus($, parseStatus(line)).catch(() => undefined)
      }
      if (wantedMs() !== ms) {
        const now = await $.clock.now()
        if (mayRestartForInterval(lastSwitchAt, now)) {
          lastSwitchAt = now
          await it.return?.(undefined as never)
          return 'switch'
        }
      }
    }
  } catch (error) {
    debug($, `now-playing: resident poller error: ${String(error)}`)
    void it.return?.(undefined as never).catch(() => undefined)
  }
  return 'ended'
}

// Lives for the session and never ends on an error: the resident loop,
// restarted with a backoff when it ends, and one-shot polling for 5 minutes
// after 3 quick failures.
async function pollerLoop($: EngineInterface) {
  if (isPollerRunning) return
  isPollerRunning = true
  let state = initialPoller
  while (true) {
    try {
      const startedAt = await $.clock.now()
      const ended = await runResident($, wantedMs())
      if (ended === 'switch') {
        debug($, `now-playing: poll interval now ${wantedMs()} ms`)
        continue
      }
      const now = await $.clock.now()
      const out = onResidentEnded(state, now, now - startedAt)
      state = out.state
      if (out.step.kind === 'restart') {
        debug($, `now-playing: resident poller ended; restarting in ${out.step.delayMs} ms`)
        await wait($, out.step.delayMs)
        continue
      }
      debug($, `now-playing: resident poller failed repeatedly; one-shot polling for ${out.step.retryMs} ms`)
      const until = (await $.clock.now()) + out.step.retryMs
      while ((await $.clock.now()) < until) {
        await poll($)
        await wait($, wantedMs())
      }
      debug($, 'now-playing: retrying the resident poller')
    } catch (error) {
      debug($, `now-playing: poller loop error: ${String(error)}`)
      try {
        await wait($, 5000)
      } catch {
        // keep looping: a failed wait must not end the poller
      }
    }
  }
}

async function fetchLyrics($: EngineInterface, track: Track) {
  if (lyricsCache.has(track.id) || lyricsLoading.has(track.id)) return
  lyricsLoading.add(track.id)
  try {
    let synced: string | undefined
    const got = await curl($, ['-H', LRCLIB_AGENT, '-o', '-', '--', lrclibGetUrl(track)])
    if (got.exitCode === 0) synced = pickSynced(got.stdout)
    // Lyrics turned off while /get was in flight: no /search, nothing cached.
    if (synced === undefined && !(await read($, lyricsOnAtom))) return
    const titles = titleCandidates(track.name)
    for (let i = 0; i < titles.length && synced === undefined; i++) {
      // The first search is covered by the check above; re-check before a second.
      if (i > 0 && !(await read($, lyricsOnAtom))) return
      const found = await curl($, ['-H', LRCLIB_AGENT, '-o', '-', '--', lrclibSearchUrl(track, titles[i])])
      if (found.exitCode === 0) synced = pickSynced(found.stdout, track.duration)
    }
    const lines = synced === undefined ? [] : parseLrc(synced)
    lyricsCache.set(track.id, lines.length > 0 ? { status: 'found', lines } : { status: 'none' })
  } catch {
    lyricsCache.set(track.id, { status: 'none' })
  } finally {
    lyricsLoading.delete(track.id)
    while (lyricsCache.size > LYRICS_CACHE_MAX) lyricsCache.delete(lyricsCache.keys().next().value!)
    await update($, lyricsRevAtom, n => n + 1)
  }
}

async function setLyricsOn($: EngineInterface, on: boolean) {
  await update($, lyricsOnAtom, () => on)
  await $.store.set('lyrics', on)
}

async function fetchCover($: EngineInterface, track: Track) {
  if (coverDir === undefined) {
    const home = (await $.env.get('HOME')) ?? '/tmp'
    coverDir = `${home}/Library/Caches/claude-now-playing`
    await $.process.run(['mkdir', '-p', coverDir])
  }
  // One file set per app, so the two tabs never overwrite each other's cover.
  const raw = `${coverDir}/cover-${track.app}.raw`
  const png = `${coverDir}/cover-${track.app}.png`
  let isFetched = false
  if (track.app === 'Music') {
    isFetched = (await osascript($, MUSIC_ARTWORK_APPLESCRIPT, [raw], 'AppleScript')).exitCode === 0
    if (!isFetched) {
      const search = await curl($, ['-o', '-', '--', itunesSearchUrl(track)])
      const url = search.exitCode === 0 ? itunesArtworkUrl(search.stdout) : undefined
      isFetched = url !== undefined && (await curl($, ['-o', raw, '--', url])).exitCode === 0
    }
  } else if (track.artworkUrl) {
    isFetched = (await curl($, ['-o', raw, '--', track.artworkUrl])).exitCode === 0
  }
  const converted =
    isFetched
      ? await $.process.run(['sips', '-s', 'format', 'png', '-Z', '400', raw, '--out', png])
      : undefined
  const cells: Cover['cells'] = {}
  let accent: number | undefined
  if (converted?.exitCode === 0) {
    for (const size of ART_SIZES) {
      const bmp = await coverBmp($, png, size)
      if (bmp === undefined) continue
      cells[`${size}`] = bmpToHalfBlocks(bmp, size, size / 2)
      if (size === 28) accent = accentColor(bmp)
    }
  }
  // A newer track may have started while this one's cover was fetched.
  if (coverFor[track.app] !== track.id) return
  await update($, coversAtom, prev => {
    const { [track.app]: old, ...rest } = prev
    if (converted?.exitCode !== 0) return rest
    const cover: Cover = { trackId: track.id, file: png, generation: (old?.generation ?? 0) + 1, cells, accent }
    return { ...rest, [track.app]: cover }
  })
}

// The cover resized by sips to a square BMP of `size` pixels, as bytes.
async function coverBmp($: EngineInterface, png: string, size: number): Promise<Uint8Array | undefined> {
  const bmp = png.replace(/\.png$/, `-${size}.bmp`)
  const resized = await $.process.run(['sips', '-s', 'format', 'bmp', '-z', String(size), String(size), png, '--out', bmp])
  if (resized.exitCode !== 0) return undefined
  const { exitCode, stdout } = await $.process.run(['base64', '-i', bmp])
  return exitCode === 0 ? fromBase64(stdout) : undefined
}

async function control($: EngineInterface, action: Action, app?: PlayerApp, value?: number) {
  const target = app ?? (await read($, trackAtom))?.app
  if (target === undefined) return 'Nothing is playing in Music or Spotify, and no app was named.'
  const current = (await read($, playersAtom)).find(p => p.app === target)?.track
  const arg =
    action === 'volume' && value === undefined ? String(current?.volume ?? 50) : String(value ?? 0)
  const { stdout, exitCode, stderr } = await osascript($, CONTROL_JXA, [target, action, arg])
  if (exitCode !== 0) return `${target} ${action} failed: ${stderr.trim()}`
  if (stdout.trim() === 'not-running') return `${target} is not running.`
  await poll($)
  let after = (await read($, playersAtom)).find(p => p.app === target)?.track ?? null
  // Starting the library takes Music a moment to load its first track.
  for (let i = 0; i < 6 && after === null && stdout.trim() === 'started-library'; i++) {
    await $.clock.sleep(500)
    await poll($)
    after = (await read($, playersAtom)).find(p => p.app === target)?.track ?? null
  }
  return after === null ? `${target} has nothing loaded.` : describe(after)
}

async function listPlaylists($: EngineInterface): Promise<PlaylistInfo[] | null> {
  const { exitCode, stdout } = await osascript($, PLAYLISTS_JXA)
  return exitCode === 0 ? parsePlaylists(stdout) : []
}

async function playPlaylist($: EngineInterface, query: string): Promise<string> {
  const lists = await listPlaylists($)
  if (lists === null) return 'Apple Music is not running.'
  const match = matchPlaylist(lists, query)
  if (match.kind === 'none') return `No playlist matches "${query}". Try /music playlist to list them.`
  if (match.kind === 'many') return `Several playlists match "${query}": ${match.names.join(', ')}. Be more specific.`
  const { name, count } = match.playlist
  const { exitCode, stdout, stderr } = await osascript($, PLAY_PLAYLIST_JXA, [name])
  if (exitCode !== 0) return `Could not play ${name.trim()}: ${stderr.trim()}`
  if (stdout.trim() === 'not-running') return 'Apple Music is not running.'
  if (stdout.trim() === 'not-found') return `No playlist matches "${query}". Try /music playlist to list them.`
  await poll($)
  return `Playing ${name.trim()} (${count} songs).`
}

// Apple Music only. The script writes only while `before` is still the
// current song, then waits ~1 s before reading back.
async function setFavorite($: EngineInterface, want: boolean): Promise<string> {
  const before = (await read($, playersAtom)).find(p => p.app === 'Music')?.track ?? null
  if (before === null) return 'Nothing is playing in Apple Music.'
  const { exitCode, stdout, stderr } = await osascript($, FAVORITE_APPLESCRIPT, [String(want), before.id], 'AppleScript')
  if (exitCode !== 0) return `Favorite failed: ${stderr.trim()}`
  const [id, value] = stdout.trim().split('|')
  await poll($)
  if (id === 'not-running') return 'Apple Music is not running.'
  if (id === 'changed') return 'The song changed before the write; nothing was changed. Try again.'
  if (id !== before.id) return `The track changed during the write; "${before.name}" was not checked.`
  const isFavorite = value === 'true'
  if (isFavorite !== want) return `Favorite did not change: "${before.name}" is ${isFavorite ? '' : 'not '}a favorite.`
  return isFavorite ? `Added "${before.name}" to Favorites.` : `Removed "${before.name}" from Favorites.`
}

// Shuffle or repeat on the shown/named app. `mode` sets ("on"/"off", or
// "off"/"all"/"one"); without it shuffle toggles and repeat cycles. The script
// waits for the app to settle, and the result is what it read back.
async function setPlayMode($: EngineInterface, kind: 'shuffle' | 'repeat', mode: string | undefined, app?: PlayerApp): Promise<string> {
  if (playModeBusy[kind]) return `${kind === 'shuffle' ? 'Shuffle' : 'Repeat'} is still changing; try again in a moment.`
  playModeBusy[kind] = true
  try {
    return await writePlayMode($, kind, mode, app)
  } finally {
    playModeBusy[kind] = false
  }
}

async function writePlayMode($: EngineInterface, kind: 'shuffle' | 'repeat', mode: string | undefined, app?: PlayerApp): Promise<string> {
  await poll($)
  const target = app ?? (await read($, trackAtom))?.app
  if (target === undefined) return 'Nothing is playing in Music or Spotify, and no app was named.'
  const current = (await read($, playersAtom)).find(p => p.app === target)?.track
  const label = LABELS[target]
  let value: string
  if (kind === 'shuffle') {
    value = String(mode === undefined ? !(current?.shuffle ?? false) : mode === 'on')
  } else {
    value = mode ?? nextRepeat(target, current?.repeat)
    if (target === 'Spotify' && value === 'one') return 'Spotify has no repeat-one; use "all" or "off".'
  }
  const { exitCode, stdout, stderr } = await osascript($, PLAYMODE_JXA, [target, kind, value])
  if (exitCode !== 0) return `${kind === 'shuffle' ? 'Shuffle' : 'Repeat'} failed: ${stderr.trim()}`
  if (stdout.trim() === 'not-running') return `${label} is not running.`
  await poll($)
  let back: { shuffle?: boolean; repeat?: RepeatMode }
  try {
    back = JSON.parse(stdout) as typeof back
  } catch {
    return `${kind === 'shuffle' ? 'Shuffle' : 'Repeat'} failed: unreadable answer from ${label}.`
  }
  if (kind === 'shuffle') {
    const isOn = back.shuffle === true
    return isOn === (value === 'true') ? `Shuffle ${isOn ? 'on' : 'off'} (${label}).` : `Shuffle did not change (${label}).`
  }
  return back.repeat === value
    ? `Repeat ${back.repeat} (${label}).`
    : `Repeat did not change (${label}).`
}

async function openApp($: EngineInterface, app: PlayerApp) {
  const { exitCode, stderr } = await $.process.run(['open', '-a', app])
  if (exitCode !== 0) $.ui.toast(`Could not open ${app}: ${stderr.trim()}`)
  await poll($)
}

// A play-mode press redraws the pane on success; anything else is a toast.
async function notify($: EngineInterface, work: Promise<string>, what: string) {
  try {
    const result = await work
    if (!/^(Shuffle|Repeat) (on|off|all|one) \(/.test(result)) $.ui.toast(result)
  } catch (error) {
    $.ui.toast(`${what} failed: ${String(error)}`)
  }
}

// Redraws the pane once a second, only while it shows a playing track.
async function tickOnce($: EngineInterface) {
  if (isTicking) await update($, tickAtom, n => n + 1)
}

// Turns the record's sheen while the shown app plays; repaints only its cells.
async function spin($: EngineInterface) {
  if (record === null || !record.isPlaying) return
  theta = (theta + 0.22) % (Math.PI * 2)
  const cells = recordCells(record.columns, record.rows, theta, record.label)
  const drawn = await $.ui.blit({ requestId: PANE, key: 'record', cells })
  if (drawn.deny !== undefined) {
    record = null
    isTicking = false
    isPaneOpen = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'music',
      description: 'Now Playing pane for Apple Music / Spotify',
      argumentHint: '[toggle|next|prev|play|pause|fav|playlist [name]|shuffle|repeat|art blocks|art image|exclusive on|exclusive off|lyrics on|lyrics off]',
      immediate: true,
    })
    await $.tool.register({
      name: 'music',
      description:
        'Read or control what Apple Music or Spotify is playing on this Mac. ' +
        'action "status" reports the current track; play/pause/toggle/next/previous control playback; ' +
        '"volume" sets volume to value (0-100); "seek" jumps to value seconds; ' +
        '"favorite"/"unfavorite" add or remove the current Apple Music song from Favorites. ' +
        '"shuffle" toggles shuffle and "repeat" cycles repeat (off, all, one; Spotify has no one), or set them with mode ("on"/"off" for shuffle, "off"/"all"/"one" for repeat). ' +
        '"list_playlists" lists the user\'s Apple Music playlists; "play_playlist" plays one by name (partial names work). ' +
        'app defaults to whichever app is currently playing.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', ...ACTIONS, 'list_playlists', 'play_playlist', 'shuffle', 'repeat'] },
          app: { type: 'string', enum: [...APPS] },
          value: { type: 'number' },
          name: { type: 'string' },
          mode: { type: 'string' },
        },
        required: ['action'],
      },
    })
    const saved = await $.store.get('artMode')
    if (saved === 'blocks' || saved === 'image') await update($, artModeAtom, () => saved)
    isExclusive = (await $.store.get('exclusive')) !== false
    if ((await $.store.get('lyrics')) === false) await update($, lyricsOnAtom, () => false)
    void pollerLoop($).catch(error => debug($, `now-playing: poller loop stopped: ${String(error)}`))
    $.clock.every(1000, () => void tickOnce($).catch(() => undefined))
    $.clock.every(SPIN_MS, () => void spin($).catch(() => undefined))

    return next(e)
  })

  on('ui.close', ($, e, next) => {
    if (e.id === PANE) {
      isTicking = false
      isPaneOpen = false
      record = null
    }
    return next(e)
  })

  on('command.run', { command: 'music' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === '') {
      await $.ui.open({ id: PANE, title: 'Now Playing', focus: true, columns: PANE_COLUMNS })
      return { text: describe(await poll($)) }
    }
    const art = /^art\s+(blocks|image)$/.exec(arg)?.[1] as ArtMode | undefined
    if (art !== undefined) {
      await update($, artModeAtom, () => art)
      await $.store.set('artMode', art)
      return { text: `Cover art now drawn as ${art}.` }
    }
    const exclusive = /^exclusive\s+(on|off)$/.exec(arg)?.[1]
    if (exclusive !== undefined) {
      isExclusive = exclusive === 'on'
      await $.store.set('exclusive', isExclusive)
      return {
        text: isExclusive
          ? 'Exclusive playback on: starting one app pauses the other.'
          : 'Exclusive playback off: Music and Spotify can play together.',
      }
    }
    const lyrics = /^lyrics\s+(on|off)$/.exec(arg)?.[1]
    if (lyrics !== undefined) {
      await setLyricsOn($, lyrics === 'on')
      return { text: lyrics === 'on' ? 'Lyrics on.' : 'Lyrics off.' }
    }
    const playlist = /^playlists?(?:\s+(.+))?$/i.exec(e.args.trim())
    if (playlist !== null) {
      if (playlist[1] === undefined) {
        const lists = await listPlaylists($)
        return { text: lists === null ? 'Apple Music is not running.' : formatPlaylists(lists) }
      }
      return { text: await playPlaylist($, playlist[1].trim()) }
    }
    if (arg === 'fav') {
      await poll($)
      const music = (await read($, playersAtom)).find(p => p.app === 'Music')?.track
      return { text: await setFavorite($, !(music?.favorited ?? false)) }
    }
    if (arg === 'shuffle' || arg === 'repeat') return { text: await setPlayMode($, arg, undefined) }
    const action = ALIASES[arg] ?? arg
    if (
      !(ACTIONS as readonly string[]).includes(action) ||
      ['volume', 'seek', 'favorite', 'unfavorite'].includes(action)
    ) {
      return {
        text: `Unknown /music argument "${arg}". Use toggle (k), next (n), prev (b), play, pause, fav, playlist [name], shuffle, repeat, art blocks|image, exclusive on|off or lyrics on|off.`,
      }
    }
    return { text: await control($, action as Action) }
  })

  on('tool.call', { tool: 'mcp__now-playing__music' }, async ($, e) => {
    const action = String(e.action)
    const app = APPS.find(a => a === e.app)
    const value = typeof e.value === 'number' ? e.value : undefined
    if (action === 'status') {
      const active = await poll($)
      if (app === undefined) return { result: describe(active) }
      // A named app reports itself, not whichever app happens to be active.
      const player = (await read($, playersAtom)).find(p => p.app === app)
      if (player === undefined || !player.isInstalled) return { result: `${app} is not installed.` }
      if (!player.isRunning) return { result: `${app} is not running.` }
      return { result: player.track === null ? `${app} has nothing loaded.` : describe(player.track) }
    }
    if (action === 'list_playlists' || action === 'play_playlist') {
      if (app === 'Spotify') return { deny: 'Playlists are only supported for Apple Music.' }
      if (action === 'list_playlists') {
        const lists = await listPlaylists($)
        return { result: lists === null ? 'Apple Music is not running.' : formatPlaylists(lists) }
      }
      if (typeof e.name !== 'string' || e.name.trim() === '') return { deny: 'play_playlist needs a playlist name.' }
      return { result: await playPlaylist($, e.name.trim()) }
    }
    if (action === 'shuffle' || action === 'repeat') {
      const mode = typeof e.mode === 'string' ? e.mode.trim().toLowerCase() : undefined
      const allowed = action === 'shuffle' ? ['on', 'off'] : ['off', 'all', 'one']
      if (mode !== undefined && !allowed.includes(mode)) {
        return { deny: `Unknown mode "${mode}" for ${action}; use ${allowed.map(m => `"${m}"`).join(', ')}.` }
      }
      if (app !== undefined && (await read($, playersAtom)).find(p => p.app === app)?.isInstalled === false) {
        return { deny: `${app} is not installed.` }
      }
      // Refuse before any write: Spotify has no repeat-one.
      const target = app ?? (await read($, trackAtom))?.app
      if (action === 'repeat' && mode === 'one' && target === 'Spotify') {
        return { deny: 'Spotify has no repeat-one; use "all" or "off".' }
      }
      return { result: await setPlayMode($, action, mode, app) }
    }
    if (!(ACTIONS as readonly string[]).includes(action)) return { deny: `Unknown action "${action}".` }
    if (action === 'favorite' || action === 'unfavorite') {
      const active = await read($, trackAtom)
      if (app === 'Spotify' || (app === undefined && active?.app === 'Spotify')) {
        return { deny: 'Favorites are only supported for Apple Music.' }
      }
      return { result: await setFavorite($, action === 'favorite') }
    }
    if ((action === 'volume' || action === 'seek') && value === undefined) {
      return { deny: `Action "${action}" needs a numeric value.` }
    }
    if (app !== undefined && (await read($, playersAtom)).find(p => p.app === app)?.isInstalled === false) {
      return { deny: `${app} is not installed.` }
    }
    return { result: await control($, action as Action, app, value) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const players = await read($, playersAtom)
    const active = await read($, trackAtom)
    const picked = await read($, sourceAtom)
    const covers = await read($, coversAtom)
    const artMode = await read($, artModeAtom)
    await read($, tickAtom) // subscribes the pane to the 1 s redraw
    const lyricsOn = await read($, lyricsOnAtom)
    await read($, lyricsRevAtom) // redraws when a lyrics fetch lands
    const now = await $.clock.now()
    const width = Math.max(1, e.props.bodyColumns)

    // An empty list means no poll has answered yet, which is not the same as
    // a poll that found nothing installed.
    const installed = players.filter(p => p.isInstalled)
    const shown: PlayerApp = picked ?? active?.app ?? installed[0]?.app ?? 'Music'
    const player = players.find(p => p.app === shown)
    const track = player?.track ?? null

    // The pane redraws on success; a control that failed says so in a toast.
    const press = (action: Action, value?: number) => async () => {
      try {
        const result = await control($, action, shown, value)
        if (!result.startsWith(`${shown} is playing`) && !result.startsWith(`${shown} is paused`)) $.ui.toast(result)
      } catch (error) {
        $.ui.toast(`${action} failed: ${String(error)}`)
      }
    }

    const cover = covers[shown]
    const hasCover = track !== null && cover !== undefined && cover.trackId === track.id
    const accent = readable(hasCover && cover.accent !== undefined ? cover.accent : NEUTRAL)
    const layout = layoutFor(width)

    const state: PaneView['state'] =
      players.length > 0 && installed.length === 0 ? 'none-installed' : player === undefined || !player.isRunning ? 'closed' : track === null ? 'stopped' : 'track'

    const position = track === null ? 0 : positionNow(track, polledAt[track.app] ?? now, now)
    let lyrics: PaneView['lyrics'] = { status: 'off' }
    if (track !== null && state === 'track' && lyricsOn) {
      const entry = lyricsCache.get(track.id)
      lyrics =
        entry === undefined
          ? { status: 'loading' }
          : entry.status === 'none'
            ? { status: 'none' }
            : { status: 'found', ...lyricWindow(entry.lines, position) }
    }
    isTicking = state === 'track' && track?.state === 'playing'
    isPaneOpen = true

    // The sleeve: the cover, with the record peeking out from behind it.
    // Image and Raster are the terminal's alone; the engine draws an Image
    // only where it detects kitty graphics, so half-block cells are the default.
    record = null
    let sleeve = null
    if (track !== null && state === 'track' && e.surface === 'terminal' && layout.art !== 0) {
      const { Box, Image, Raster } = $.ui.resolve(e)
      const size = layout.art
      const artRows = size / 2
      const cells = hasCover ? cover.cells[`${size}`] : undefined
      const art =
        hasCover && (artMode === 'image' || cells === undefined) ? (
          <Image
            key="cover"
            source={{ file: cover.file, format: 'png', generation: cover.generation }}
            columns={size}
            rows={artRows}
            alt={`${track.album} cover (try /music art blocks)`}
          />
        ) : cells !== undefined ? (
          <Raster key="cover" columns={size} rows={artRows} cells={cells} />
        ) : null
      if (art !== null) {
        record = layout.peek > 0 ? { columns: layout.peek, rows: artRows, label: accent, isPlaying: track.state === 'playing' } : null
        sleeve = (
          <Box flexDirection="row">
            {art}
            {record !== null && (
              <Raster key="record" columns={record.columns} rows={record.rows} cells={recordCells(record.columns, record.rows, theta, accent)} />
            )}
          </Box>
        )
      }
    }

    const view: PaneView = {
      width,
      tabs: installed.map(({ app }) => ({
        app,
        label: LABELS[app],
        isShown: app === shown,
        isPlaying: players.find(p => p.app === app)?.track?.state === 'playing',
      })),
      shown,
      shownLabel: LABELS[shown],
      canFavorite: shown === 'Music' && track?.favorited !== undefined,
      state,
      track,
      position,
      lyrics,
      accent,
      layout,
      sleeve,
      handlers: {
        toggleLyrics: () => void setLyricsOn($, !lyricsOn),
        pickTab: app => void update($, sourceAtom, () => app),
        open: () => void openApp($, shown),
        press,
        toggleShuffle: () => playModeBusy.shuffle || void notify($, setPlayMode($, 'shuffle', undefined, shown), 'Shuffle'),
        cycleRepeat: () => playModeBusy.repeat || void notify($, setPlayMode($, 'repeat', undefined, shown), 'Repeat'),
        toggleFavorite: () =>
          void (async () => {
            try {
              const result = await setFavorite($, !(track?.favorited ?? false))
              if (!result.startsWith('Added') && !result.startsWith('Removed')) $.ui.toast(result)
            } catch (error) {
              $.ui.toast(`Favorite failed: ${String(error)}`)
            }
          })(),
      },
    }
    return paneTree($.ui.resolve(e), view)
  })
}
