import type { Player, PlayerApp, RepeatMode, Track } from '../types'

export const APPS: readonly PlayerApp[] = ['Music', 'Spotify']

export const ACTIONS = ['play', 'pause', 'toggle', 'next', 'previous', 'volume', 'seek', 'favorite', 'unfavorite'] as const
export type Action = (typeof ACTIONS)[number]

// JXA: Application(name).running() never launches the app, and a missing app
// throws, so neither probe opens Music or Spotify behind the person's back.
const PROBE_JXA = `
function probe(name) {
  var a
  try { a = Application(name) } catch (e) { return { app: name, isInstalled: false, isRunning: false, track: null } }
  try { if (!a.running()) return { app: name, isInstalled: true, isRunning: false, track: null } }
  catch (e) { return { app: name, isInstalled: false, isRunning: false, track: null } }
  try {
    var state = a.playerState()
    if (state !== 'playing' && state !== 'paused') return { app: name, isInstalled: true, isRunning: true, track: null }
    var t = a.currentTrack()
    var r = { app: name, state: state, name: t.name(), artist: t.artist(), album: t.album(),
              position: a.playerPosition(), volume: a.soundVolume() }
    try { r.duration = t.duration() } catch (e) { r.duration = 0 }
    if (name === 'Spotify') {
      r.duration = r.duration / 1000; r.id = t.id(); r.artworkUrl = t.artworkUrl()
      try { r.shuffle = a.shuffling(); r.repeat = a.repeating() ? 'all' : 'off' } catch (e) {}
    } else {
      r.id = String(t.persistentID()); try { r.favorited = t.favorited() } catch (e) {}
      try { r.shuffle = a.shuffleEnabled(); r.repeat = a.songRepeat() } catch (e) {}
    }
    return { app: name, isInstalled: true, isRunning: true, track: r }
  } catch (e) { return { app: name, isInstalled: true, isRunning: true, track: null } }
}
`

export const STATUS_JXA = `${PROBE_JXA}function run() { return JSON.stringify([probe('Music'), probe('Spotify')]) }
`

// One resident osascript: argv[0] is the interval in ms; it writes one JSON
// status line per interval, straight to stdout (console.log goes to stderr, and
// a plain return prints only at exit). One process sends every Apple Event.
export const STATUS_LOOP_JXA = `${PROBE_JXA}ObjC.import('Foundation')
function emit(s) {
  $.NSFileHandle.fileHandleWithStandardOutput.writeData($(s + '\\n').dataUsingEncoding($.NSUTF8StringEncoding))
}
function run(argv) {
  var ms = Number(argv[0])
  while (true) {
    emit(JSON.stringify([probe('Music'), probe('Spotify')]))
    delay(ms / 1000)
  }
}
`

export const CONTROL_JXA = `
function run(argv) {
  var a = Application(argv[0]), act = argv[1], v = Number(argv[2])
  if (!a.running()) return 'not-running'
  // A stopped Music app has no current track, and a bare play() then does
  // nothing; start the whole library instead (it holds streamed songs too).
  var hasTrack = true
  try { a.currentTrack().name() } catch (e) { hasTrack = false }
  if (argv[0] === 'Music' && !hasTrack && (act === 'play' || act === 'toggle')) {
    a.play(a.playlists[0])
    return 'started-library'
  }
  switch (act) {
    case 'play': a.play(); break
    case 'pause': a.pause(); break
    case 'toggle': a.playpause(); break
    case 'next': a.nextTrack(); break
    case 'previous': a.previousTrack(); break
    case 'volume': a.soundVolume = Math.max(0, Math.min(100, Math.round(v))); break
    case 'seek': a.playerPosition = Math.max(0, v); break
    default: return 'unknown-action'
  }
  return 'ok'
}
`

// Sets shuffle or repeat. argv: app, kind ("shuffle" | "repeat"), value
// ("true"/"false", or "off"/"all"/"one"). It never launches the app. JXA writes
// land at once but read back stale, so it waits 1.5 s before reading back.
// Answers "not-running" or JSON {shuffle, repeat} as read back.
export const PLAYMODE_JXA = `
function run(argv) {
  var name = argv[0], kind = argv[1], value = argv[2]
  var a = Application(name)
  if (!a.running()) return 'not-running'
  var isMusic = name === 'Music'
  if (kind === 'shuffle') {
    if (isMusic) a.shuffleEnabled = value === 'true'
    else a.shuffling = value === 'true'
  } else if (isMusic) a.songRepeat = value
  else a.repeating = value !== 'off'
  delay(1.5)
  if (isMusic) return JSON.stringify({ shuffle: a.shuffleEnabled(), repeat: a.songRepeat() })
  return JSON.stringify({ shuffle: a.shuffling(), repeat: a.repeating() ? 'all' : 'off' })
}
`

// The next repeat mode in the cycle; Spotify has no repeat-one.
export function nextRepeat(app: PlayerApp, current: RepeatMode | undefined): RepeatMode {
  if (current === 'off' || current === undefined) return 'all'
  return current === 'all' && app === 'Music' ? 'one' : 'off'
}

// JXA writes to `favorited` land late and read back stale, so the write is
// AppleScript. argv: want ("true"/"false"), expected persistent ID. It never
// launches Music, and writes only while the expected song is still current.
// Answers "not-running|", "changed|<current id>" or "<id>|<value>" after a 1 s wait.
export const FAVORITE_APPLESCRIPT = `
on run argv
  if application "Music" is not running then return "not-running|"
  tell application "Music"
    set want to (item 1 of argv) is "true"
    set currentId to persistent ID of current track
    if currentId is not (item 2 of argv) then return "changed|" & currentId
    set favorited of current track to want
    delay 1
    return (persistent ID of current track) & "|" & (favorited of current track as string)
  end tell
end run
`

export const MUSIC_ARTWORK_APPLESCRIPT = `
on run argv
  tell application "Music" to set d to raw data of artwork 1 of current track
  set fh to open for access (POSIX file (item 1 of argv)) with write permission
  set eof fh to 0
  write d to fh
  close access fh
end run
`

export function parseStatus(stdout: string): Player[] {
  try {
    const list = JSON.parse(stdout) as unknown
    return Array.isArray(list)
      ? list.filter((p): p is Player => p !== null && typeof p === 'object' && APPS.includes((p as Player).app))
      : []
  } catch {
    return []
  }
}

// The app that is playing wins; otherwise a paused one, so the controls still
// have something to resume.
export function pickActive(players: readonly Player[]): Track | null {
  const tracks = players.flatMap(p => (p.track === null ? [] : [p.track]))
  return tracks.find(t => t.state === 'playing') ?? tracks.find(t => t.state === 'paused') ?? null
}

// Apple Music tracks streamed but not in the library have no artwork that
// scripting can read, so the cover falls back to Apple's public search API.
export function itunesSearchUrl(track: Track): string {
  const term = encodeURIComponent(`${track.artist} ${track.name}`)
  return `https://itunes.apple.com/search?media=music&entity=song&limit=1&term=${term}`
}

export function itunesArtworkUrl(stdout: string): string | undefined {
  try {
    const body = JSON.parse(stdout) as { results?: { artworkUrl100?: string }[] }
    return body.results?.[0]?.artworkUrl100?.replace(/\/\d+x\d+bb\./, '/600x600bb.')
  } catch {
    return undefined
  }
}

// Which app to pause: the ones that were playing while another just started.
export function toPause(before: Partial<Record<PlayerApp, string>>, players: readonly Player[]): PlayerApp[] {
  const started = players.filter(p => p.track?.state === 'playing' && before[p.app] !== undefined && before[p.app] !== 'playing')
  if (started.length === 0) return []
  return players
    .filter(p => p.track?.state === 'playing' && !started.some(s => s.app === p.app))
    .map(p => p.app)
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function progressBar(position: number, duration: number, width: number): string {
  const w = Math.max(4, width)
  if (duration <= 0) return '─'.repeat(w)
  const at = Math.min(w - 1, Math.floor((position / duration) * w))
  return '━'.repeat(at) + '●' + '─'.repeat(w - at - 1)
}

export function describe(track: Track | null): string {
  if (track === null) return 'Nothing is playing in Music or Spotify.'
  const time = track.duration > 0 ? ` (${formatTime(track.position)}/${formatTime(track.duration)})` : ''
  return `${track.app} is ${track.state}: "${track.name}" by ${track.artist} from "${track.album}"${time}, volume ${track.volume}.${track.favorited === true ? ' Favorite.' : ''}${track.shuffle === true ? ' Shuffle on.' : ''}${track.repeat === 'all' || track.repeat === 'one' ? ` Repeat ${track.repeat}.` : ''}`
}

export type PlaylistInfo = { name: string; count: number; smart: boolean }

// Read-only; never launches Music.
export const PLAYLISTS_JXA = `
function run() {
  var m = Application('Music')
  if (!m.running()) return 'not-running'
  var out = []
  m.userPlaylists().forEach(function (p) {
    try { out.push({ name: p.name(), count: p.tracks.length, smart: p.smart() }) } catch (e) {}
  })
  return JSON.stringify(out)
}
`

// Plays the user playlist named exactly argv[0]; never launches Music.
export const PLAY_PLAYLIST_JXA = `
function run(argv) {
  var m = Application('Music')
  if (!m.running()) return 'not-running'
  var lists = m.userPlaylists()
  for (var i = 0; i < lists.length; i++) {
    if (lists[i].name() === argv[0]) { lists[i].play(); return 'ok' }
  }
  return 'not-found'
}
`

export function parsePlaylists(stdout: string): PlaylistInfo[] | null {
  if (stdout.trim() === 'not-running') return null
  try {
    const list = JSON.parse(stdout) as unknown
    return Array.isArray(list)
      ? list.filter((p): p is PlaylistInfo => p !== null && typeof p === 'object' && typeof (p as PlaylistInfo).name === 'string')
      : []
  } catch {
    return []
  }
}

const normal = (s: string) => s.trim().replace(/\s+/g, ' ').toLocaleLowerCase()

// Exact, then prefix, then substring; the first tier with any hit decides.
export function matchPlaylist(lists: readonly PlaylistInfo[], query: string) {
  const q = normal(query)
  if (q === '') return { kind: 'none' } as const
  const ordered = [...lists.filter(p => !p.smart), ...lists.filter(p => p.smart)]
  const tiers = [
    (n: string) => n === q,
    (n: string) => n.startsWith(q),
    (n: string) => n.includes(q),
  ]
  for (const hit of tiers) {
    const found = ordered.filter(p => hit(normal(p.name)))
    if (found.length === 1) return { kind: 'one', playlist: found[0]! } as const
    if (found.length > 1) return { kind: 'many', names: found.map(p => p.name.trim()) } as const
  }
  return { kind: 'none' } as const
}

export function formatPlaylists(lists: readonly PlaylistInfo[]): string {
  if (lists.length === 0) return 'No playlists in Apple Music.'
  const lines = lists.filter(p => !p.smart).map(p => `${p.name.trim()} (${p.count})`)
  const smart = lists.filter(p => p.smart).map(p => p.name.trim())
  if (smart.length > 0) lines.push(`Smart playlists: ${smart.join(', ')}`)
  return lines.join('\n')
}
