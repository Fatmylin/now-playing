# now-playing

A Now Playing pane for Apple Music and Spotify inside Claude Code.

<!-- screenshot: docs/screenshot.png -->

## Features

- A centred player pane (`/music`) with the cover drawn as half-block cells and a spinning vinyl record beside it. The cover is 56, 42 or 28 columns wide, depending on the pane width.
- Tabs for the players you have installed (Apple Music, Spotify). With one player installed there are no tabs.
- Transport (previous, play/pause, next), volume, shuffle and repeat (Apple Music: repeat off/all/one; Spotify: repeat off/all), and favorites for Apple Music.
- A status line showing `♪ title — artist`, with ⏸ when paused and ` ♥` for an Apple Music favorite.
- A `music` tool that Claude can call (`mcp__now-playing__music`): status, play, pause, toggle, next, previous, volume, seek, favorite, unfavorite, list_playlists, play_playlist, shuffle, repeat (optional `mode`).
- Play your Apple Music playlists by name, or ask Claude to.
- Synced lyrics from LRCLIB, the current line highlighted.
- Exclusive playback (on by default): starting one app pauses the other.
- Play resumes the current song, or starts your library when nothing is queued.

## Requirements

- macOS
- Apple Music and/or Spotify desktop app
- Claude Code 2.1.287 or newer
- `/tui fullscreen` to click the buttons. Hotkeys work either way once the pane has focus.

## Install

```
claude plugin marketplace add Fatmylin/now-playing
claude plugin install now-playing@now-playing
```

To try it from a local checkout:

```
claude --plugin-dir ./plugins/now-playing
```

## Usage

| Command | What it does |
| --- | --- |
| `/music` | Open the pane |
| `/music n` or `next` | Next track |
| `/music b`, `prev` or `previous` | Previous track |
| `/music k` or `toggle` | Play/pause |
| `/music play`, `/music pause` | Play or pause |
| `/music fav` | Toggle favorite on the current Apple Music song |
| `/music shuffle` | Toggle shuffle |
| `/music repeat` | Cycle repeat (Apple Music: off, all, one; Spotify: off, all) |
| `/music playlist` | List your Apple Music playlists |
| `/music playlist <name>` | Play a playlist (partial, case-insensitive name) |
| `/music art blocks` | Draw the cover as half-block cells (default) |
| `/music art image` | Draw the cover as a kitty-graphics image |
| `/music exclusive on`, `/music exclusive off` | Turn exclusive playback on or off |
| `/music lyrics on`, `/music lyrics off` | Show or hide synced lyrics (on by default) |

Hotkeys in the pane:

| Key | Action |
| --- | --- |
| `1`, `2` | Switch tab |
| `b`, `k`, `n` | Previous, play/pause, next |
| `d`, `u` | Volume down, up |
| `f` | Favorite (Apple Music only) |
| `s` | Shuffle on or off |
| `r` | Cycle repeat |
| `l` | Lyrics on or off |
| `o` | Open the player when it is closed |

## Permissions

macOS asks whether your terminal may control Music or Spotify (Automation). The prompt appears when Claude Code starts with a player running, because polling starts at session start, not only on the first `/music`. Allow it. If you denied it, re-enable it under System Settings › Privacy & Security › Automation.

## Known limits

- Playlists are Apple Music only.
- No Spotify search or favorites. Spotify's AppleScript interface has neither.
- No kitty images in attached background sessions. Use the default `blocks`.
- Covers for streamed Apple Music songs come from Apple's public iTunes Search API. The song's artist and title are sent to itunes.apple.com.
- With lyrics on (the default), each new song's artist, title, album and length are sent to lrclib.net when it plays while the Now Playing pane is open. Turn this off with `/music lyrics off`.
- The plugin API may change between Claude Code releases.

## License

MIT
