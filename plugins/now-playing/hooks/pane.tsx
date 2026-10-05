import type { Elements, RenderChildren } from 'claude-code'

import type { PlayerApp, Track } from '../types'
import { hex, wrapLines } from './layout'
import type { Layout } from './layout'
import { formatTime } from './player'
import type { Action } from './player'

export type PaneHandlers = {
  pickTab: (app: PlayerApp) => void
  open: () => void
  press: (action: Action, value?: number) => () => void
  toggleFavorite: () => void
  toggleLyrics: () => void
  toggleShuffle: () => void
  cycleRepeat: () => void
}
export type LyricsView =
  | { status: 'off' }
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'found'; prev: string; current: string; next: string }
export type PaneView = {
  width: number
  tabs: { app: PlayerApp; label: string; isShown: boolean; isPlaying: boolean }[]
  shown: PlayerApp
  shownLabel: string
  canFavorite: boolean
  state: 'none-installed' | 'closed' | 'stopped' | 'track'
  track: Track | null
  position: number // seconds, advanced from the last poll
  lyrics: LyricsView
  accent: number
  layout: Layout
  sleeve: unknown | null // the cover + record row, built in register.tsx (Image/Raster are terminal-only)
  handlers: PaneHandlers
}

export function paneTree(ui: Pick<Elements['desktop'], 'Box' | 'Text' | 'Button'>, view: PaneView) {
  const { Box, Text, Button } = ui
  const row = (key: string, ...children: RenderChildren[]) => (
    <Box key={key} flexDirection="row" justifyContent="center" width={view.width}>
      {children}
    </Box>
  )
  const tabs =
    view.tabs.length > 1
      ? row(
          'row-tabs',
          <Box flexDirection="row" columnGap={3}>
            {view.tabs.map((t, i) => (
              <Button
                key={`tab-${t.app}`}
                label={t.isPlaying ? `${t.label} ♪` : t.label}
                hotkey={String(i + 1)}
                plain
                dimColor={!t.isShown}
                onPress={() => view.handlers.pickTab(t.app)}
              />
            ))}
          </Box>,
        )
      : null
  const label = view.shownLabel

  if (view.state === 'none-installed') {
    return (
      <Box flexDirection="column">
        {row('row-message', <Text dimColor>Install Apple Music or Spotify to use this player.</Text>)}
      </Box>
    )
  }
  if (view.state === 'closed') {
    return (
      <Box flexDirection="column" rowGap={1}>
        {tabs}
        {row('row-message', <Text dimColor>{label} is closed.</Text>)}
        {row('row-action', <Button key="open" label={`Open ${label}`} hotkey="o" plain onPress={view.handlers.open} />)}
      </Box>
    )
  }
  if (view.state === 'stopped' || view.track === null) {
    return (
      <Box flexDirection="column" rowGap={1}>
        {tabs}
        {row('row-message', <Text dimColor>{label} is stopped.</Text>)}
        {row(
          'row-action',
          <Button
            key="toggle"
            label="▶ Play"
            hotkey="k"
            plain
            onPress={view.handlers.press('play')}
          />,
        )}
      </Box>
    )
  }

  const track = view.track
  const isPlaying = track.state === 'playing'
  const isShuffle = track.shuffle === true
  const isRepeat = track.repeat === 'all' || track.repeat === 'one'
  const played = track.duration > 0 ? Math.min(view.width - 1, Math.floor((view.position / track.duration) * view.width)) : 0
  return (
    <Box flexDirection="column">
      {tabs}
      <Box height={1} />
      {view.sleeve !== null && row('row-sleeve', view.sleeve as RenderChildren)}
      <Box height={1} />
      {wrapLines(track.name, view.width).map((line, i) => row(`row-title-${i}`, <Text bold>{line}</Text>))}
      {wrapLines(track.artist, view.width).map((line, i) => row(`row-artist-${i}`, <Text>{line}</Text>))}
      {wrapLines(track.album, view.width).map((line, i) => row(`row-album-${i}`, <Text dimColor>{line}</Text>))}
      {view.lyrics.status !== 'off' && <Box height={1} />}
      {view.lyrics.status === 'found' && row('row-lyric-prev', <Text dimColor wrap="truncate-end">{view.lyrics.prev || ' '}</Text>)}
      {view.lyrics.status === 'found' && row('row-lyric-current', <Text bold color={hex(view.accent)} wrap="truncate-end">{view.lyrics.current || ' '}</Text>)}
      {view.lyrics.status === 'found' && row('row-lyric-next', <Text dimColor wrap="truncate-end">{view.lyrics.next || ' '}</Text>)}
      {(view.lyrics.status === 'none' || view.lyrics.status === 'loading') &&
        row('row-lyric-none', <Text dimColor>{view.lyrics.status === 'none' ? 'No synced lyrics' : 'Looking for lyrics…'}</Text>)}
      <Box height={1} />
      <Box key="row-bar" flexDirection="row" width={view.width}>
        <Text color={hex(view.accent)}>{'━'.repeat(played)}</Text>
        <Text color={hex(view.accent)} bold>╸</Text>
        <Text dimColor>{'─'.repeat(Math.max(0, view.width - played - 1))}</Text>
      </Box>
      <Box key="row-times" flexDirection="row" justifyContent="space-between" width={view.width}>
        <Text dimColor>{formatTime(view.position)}</Text>
        <Text dimColor>{formatTime(track.duration)}</Text>
      </Box>
      <Box height={1} />
      {row(
        'row-transport',
        <Box flexDirection="row" columnGap={4}>
          <Button key="prev" label="⏮" hotkey="b" plain onPress={view.handlers.press('previous')} />
          <Button key="toggle" label={isPlaying ? '⏸' : '▶'} hotkey="k" plain onPress={view.handlers.press('toggle')} />
          <Button key="next" label="⏭" hotkey="n" plain onPress={view.handlers.press('next')} />
          {view.canFavorite && (
            <Button key="fav" label={track.favorited === true ? '♥' : '♡'} hotkey="f" plain onPress={view.handlers.toggleFavorite} />
          )}
        </Box>,
      )}
      {row(
        'row-playmode',
        <Box flexDirection="row" columnGap={3}>
          <Box flexDirection="row" columnGap={1}>
            {isShuffle ? <Text color={hex(view.accent)}>●</Text> : <Text> </Text>}
            <Button key="shuffle" label={`⇄ Shuffle ${isShuffle ? 'on' : 'off'}`} hotkey="s" plain dimColor={!isShuffle} onPress={view.handlers.toggleShuffle} />
            {/* "on" is one column narrower than "off"; keep the row's width fixed */}
            {isShuffle && <Text> </Text>}
          </Box>
          <Box flexDirection="row" columnGap={1}>
            {isRepeat ? <Text color={hex(view.accent)}>●</Text> : <Text> </Text>}
            <Button key="repeat" label={`↻ Repeat ${track.repeat ?? 'off'}`} hotkey="r" plain dimColor={!isRepeat} onPress={view.handlers.cycleRepeat} />
          </Box>
        </Box>,
      )}
      {row(
        'row-volume',
        <Box flexDirection="row" columnGap={1}>
          <Button key="vol-down" label="−" hotkey="d" plain dimColor onPress={view.handlers.press('volume', track.volume - 10)} />
          <Text dimColor>vol {track.volume}</Text>
          <Button key="vol-up" label="+" hotkey="u" plain dimColor onPress={view.handlers.press('volume', track.volume + 10)} />
          <Button key="lyrics" label={view.lyrics.status === 'off' ? 'lyrics off' : 'lyrics on'} hotkey="l" plain dimColor onPress={view.handlers.toggleLyrics} />
        </Box>,
      )}
    </Box>
  )
}
