export type PlayerApp = 'Music' | 'Spotify'

export type RepeatMode = 'off' | 'one' | 'all'

export type Track = {
  app: PlayerApp
  state: 'playing' | 'paused'
  id: string
  name: string
  artist: string
  album: string
  position: number
  duration: number
  volume: number
  artworkUrl?: string
  favorited?: boolean // Apple Music only
  shuffle?: boolean
  repeat?: RepeatMode // Spotify's repeating is shown as 'all'
}

// One app as the last poll saw it: closed, open with nothing loaded, or a track.
export type Player = { app: PlayerApp; isInstalled: boolean; isRunning: boolean; track: Track | null }

// cells: the cover as half-block Raster cells per drawn width (28, 42, 56);
// accent: the cover's most saturated colour, for the record label and the bar.
export type Cover = {
  trackId: string
  file: string
  generation: number
  cells: Partial<Record<'28' | '42' | '56', string>>
  accent?: number
}

// blocks: the cover as half-block Raster cells (any truecolor terminal);
// image: the PNG through the kitty graphics protocol (Ghostty/kitty run directly).
export type ArtMode = 'blocks' | 'image'

declare module 'claude-code' {
  interface McpToolInputs {
    'mcp__now-playing__music': {
      action: 'status' | 'play' | 'pause' | 'toggle' | 'next' | 'previous' | 'volume' | 'seek' | 'favorite' | 'unfavorite' | 'list_playlists' | 'play_playlist' | 'shuffle' | 'repeat'
      app?: PlayerApp
      value?: number
      name?: string
      mode?: string
    }
  }
  interface PluginState {
    'now-playing': {
      track: Track | null
      players: Player[]
      // The tab the person picked; null follows whichever app is playing.
      source: PlayerApp | null
      covers: Partial<Record<PlayerApp, Cover>>
      artMode: ArtMode
      // Bumped once a second while a track plays, to redraw the pane.
      tick: number
      lyricsOn: boolean
      // Bumped when a lyrics fetch lands, to redraw the pane.
      lyricsRev: number
    }
  }
}
