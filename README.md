# UltraStarWebManager

A web manager for an **UltraStar** karaoke song library — browse, filter, preview and (soon) fix
your songs from any browser on your PC or local network.

Node.js + Express 5 on the server, Bootstrap 5 and plain ES modules in the browser (no framework,
no build step).

## Features

- **Song grid** with covers, artist and title overlaid on each cover, badges for duets, videos
  and file problems.
- **Fast filters** (in the browser): search by artist/title (accent-insensitive), then
  multiple-choice **Language, Decade, Genre, Edition, Tags** windows with song counts and
  UltraStar category images, plus **Duets** and **Warnings** (by type) filters. Filters are kept in the URL.
- **Audio preview**: 30-second excerpt from `#PREVIEWSTART` (or the medley, or 30% of the song),
  with fade-out, seekable progress bar and remembered volume.
- **Muted video** in sync with the preview, shifted by `#VIDEOGAP` like UltraStar Deluxe.
- **Video check and conversion**: format, codec and resolution in the details window; a warning
  for every video that is not MP4 H.264 or is larger than 1080p, with a one-click conversion
  (write access, needs ffmpeg).
- **Song details** window: information, timing, files present or missing, **ReplayGain** of the
  audio file, statistics, warnings and every other header of the `.txt`.
- **File checks**: each song lists its problems (missing headers or files, missing year or
  language, missing end line, encoding other than UTF-8 without BOM as required by format 1.1.0,
  folder or file names not following `Artist - Title [suffix]`…).
- **Playlists**: the `.upl` files of `PLAYLIST_DIR` become a **Playlists** filter, each one shown
  with a mosaic of its first covers. While a song plays, the **Playlists** button of the bottom bar
  lists them, ticked when they contain the song: tick to add it, untick to remove it (write access).
- **MusicBrainz** (write access): look up the **year, language and genre** of a song on
  [MusicBrainz](https://musicbrainz.org/) and keep the values you choose.
- **Editing** (write access): double-click a song's **Language, Genre, Year, Edition, Tags,
  Creator** or, for duets, **singer names (P1 / P2)** in the details window to edit it in place,
  picking existing values or creating new ones; dated backup, original encoding kept.
- **Bulk corrections** (write access, toolbox button in the top bar): simulate first, pick the
  files, then apply with a progress bar. Tools: convert every file to UTF-8 without BOM; convert
  videos to MP4 H.264 in batches (10 by default) in the background.
- **Preferences** (admin, gear button in the top bar): the expected **file naming** of each item
  (folder, `.txt`, duet `.txt`, audio, video, cover, background, vocals, instrumental), each one
  with an on/off switch, an editable pattern such as `{artist} - {title} [CO]` and a live example.
- **Rename to the naming rules** (write access): from the naming warning of a song, a window
  lists the folder and every file (current name → suggested name, editable, with conflicts) and
  the changes to each `.txt`, then renames everything at once, with undo.
- **Refresh** button to re-read the library without restarting the server.
- **Access levels** for sharing on a local network: read (can be public) < write < admin.
- **English and French** interface, mobile-friendly.

**Roadmap** — next: more editable fields, creating and renaming playlists, then
more bulk correction tools (tags, covers, preview start, video conversion…) with dry-run.

## Requirements

- Windows, macOS or Linux with **Node.js 22.9 or later** (LTS recommended)
- An UltraStar song library (`.txt` + audio/video/cover files)
- Optional: an **UltraStar Deluxe** installation, for its category images (`covers` folder)
- Optional: **ffmpeg** (with `ffprobe`), to convert videos to MP4 H.264

## Quick start

```bash
npm install
copy .env.example .env      # Windows (cp on macOS/Linux), then edit SONG_DIR
npm run dev                 # restarts automatically on every change
```

Open <http://127.0.0.1:3000>. On this PC you have full (admin) access, no key needed.

## Configuration (`.env`)

| Variable              | Description                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                | HTTP port (default `3000`)                                                                                                  |
| `HOST`                | `127.0.0.1` = this PC only (default); `0.0.0.0` = local network                                                             |
| `SONG_DIR`            | Root folder of the UltraStar songs (read-only)                                                                              |
| `PLAYLIST_DIR`        | Folder of the `.upl` playlists                                                                                              |
| `CATEGORY_COVERS_DIR` | Optional: UltraStar Deluxe `covers` folder (category images, read-only)                                                     |
| `READ_KEY`            | Key for **read** (browse, listen) — **empty = read is public**                                                              |
| `WRITE_KEY`           | Key for **write** (edit tags, covers, playlists, refresh the library)                                                       |
| `ADMIN_KEY`           | Key for **admin** (write + delete)                                                                                          |
| `ALLOWED_HOSTS`       | Extra host names allowed in the `Host` header, comma-separated                                                              |
| `TRUST_LOCALHOST`     | `true` (default): requests from this PC are admin without a key                                                             |
| `SESSION_DAYS`        | How long a sign-in lasts (default `30`)                                                                                     |
| `BACKUP_DIR`          | Dated backups of edited files (default: `backups/` in the project)                                                          |
| `SETTINGS_FILE`       | Preferences saved from the interface (default: `settings.json` in the project, ignored by git)                              |
| `FFMPEG_PATH`         | Full path of `ffmpeg.exe` (`ffprobe.exe` next to it); empty = `ffmpeg` from the `PATH`. Optional: only for video conversion |

Paths may contain spaces and parentheses, no quotes needed, e.g.
`CATEGORY_COVERS_DIR=C:\Program Files (x86)\UltraStar Deluxe\covers`.

## Using the interface

**Filters** — The chips open a window of tiles (tap to select several values). Several values of
the same chip are combined with OR, different chips with AND: _French OR English, AND 1990s_.
**Duets** and **⚠ Warnings** are on/off toggles; **Reset** clears everything but the sort.
Next to the sort menu: the **Videos** switch and the **Refresh** button (write access).

**Category images** — With `CATEGORY_COVERS_DIR` set, tiles and details show the UltraStar Deluxe
images; otherwise initials:

| Facet    | Image looked up in `covers/`                                  |
| -------- | ------------------------------------------------------------- |
| Language | `Language/French.jpg` (also handles `Finish.jpg` for Finnish) |
| Decade   | `Decade/1990.jpg`, then `1990.jpg`                            |
| Edition  | `ABBA.jpg`, `Duo.jpg`… (root of `covers`)                     |
| Tags     | `tag/love_song.jpg` (`_` stands for a space)                  |

Matching ignores case and accents. The folder is only read, never copied or modified.

**Audio preview** — Hover a cover and click ▶ (click again to pause). The excerpt starts at
`#PREVIEWSTART`, otherwise at the start of the medley (`#MEDLEYSTARTBEAT`), otherwise at 30% of
the song, and lasts 30 seconds with a fade-out. The player bar shows the whole song with the
excerpt highlighted: click, drag or use the arrow keys to jump — a new excerpt starts there.
`Esc` stops playback.

**Video** — When `#VIDEO` is a format browsers can play (`.mp4` H.264/VP9, `.webm`), it plays
**muted** above the player bar, in sync with the preview (play, pause, seek), at
_song time + `#VIDEOGAP`_ like UltraStar Deluxe. Browsers cannot play `.avi`, `.mkv`, `.mpg`
or old MPEG-4 Part 2 videos: no video window for those songs.

**Song details** — The **(i)** button at the bottom left of a cover opens a window, re-read from
the `.txt` each time: information (languages, editions, tags with their images, year, creator,
duet singers), timing (BPM, GAP, VIDEOGAP, preview start, medley, START/END), files (✔ present,
✘ missing), statistics (notes, phrases), warnings and all other headers.

**Warnings** — The ⚠ badge on a cover counts the problems found in its `.txt` (hover it, or open
the details). The **⚠ Warnings** chip opens the list of warning types (with **All warnings** first), each with its number of songs: pick one or several types.

**Playlists** — Set `PLAYLIST_DIR` to your UltraStar playlists folder. Each `.upl` file
(lines `Artist : Title`) is linked to the library by artist and title (case, accents and extra
spaces ignored) and appears in the **Playlists** filter. In the bottom bar, the **Playlists** button
(♫) opens a menu listing every playlist, ticked when it contains the song being played. With write
access, **tick** to add the song at the end of the playlist (`Artist : Title`, never twice) and
**untick** to remove it. Each change keeps the file's encoding and line endings, makes a dated
backup in `BACKUP_DIR/_playlists/`, writes atomically, and is refused if the playlist was changed
elsewhere since the menu was opened.

**MusicBrainz** (write access, needs internet) — In the details window, **Search on MusicBrainz**
looks up the song by artist and title. Choose the matching recording (album, year and match score
shown; a link opens it on musicbrainz.org): the **year** (first release), **languages** (lyrics
language of its releases, written the UltraStar way: `French`, `English`…) and **genres**
(community votes on the recording, its album and its artist) are shown next to the current
values. Tick what you want to keep (only missing values are ticked at first) and **Apply**: the
ticked values replace `#YEAR`, `#LANGUAGE` and `#GENRE`, with the same safe saving as below. The
server calls MusicBrainz itself (identified User-Agent, at most one request per second, answers
cached), so the browser page stays under the strict CSP.

**Editing** (write access) — In the details window, **double-click** the value of **Language**,
**Genre**, **Year**, **Edition**, **Tags**, **Creator** or, for duets, **Singer 1 / Singer 2**
(or click the ✏ that appears on hover, always visible on touch screens) to edit it in place.
Year and singers are a simple text field (Enter saves, Esc cancels; a singer name may contain
commas; old files using `#DUETSINGERP1` / `#DUETSINGERP2` keep those headers). The other fields
list the values already used in your library (pick one, keeping its exact spelling) or accept a
new one: press Enter to add, × to remove. **Save** with ✓ or
Enter in an empty input; **cancel** with ✕ or Esc. Saving:

1. refuses if the file was changed elsewhere since it was displayed (e.g. in Yass);
2. copies the original to `backups/<song folder>/<file>.<date>.txt` (history kept);
3. rewrites the file atomically, changing **only the edited header lines** and keeping its
   encoding (UTF-8, UTF-8 with BOM or Windows-1252) and line endings. A character that does not
   exist in a Windows-1252 file (emoji, Asian scripts…) is refused rather than corrupted;
4. updates the grid and filters immediately.

**Encoding fix** (write access) — Format 1.1.0 requires UTF-8 without BOM. When a song is in
Windows-1252 or has a BOM, its warning in the details window comes with a **Convert to UTF-8**
button: same safety steps (change check, dated backup, atomic write), same text and line endings;
the server checks that the new file decodes to exactly the same text before writing it.

**Video conversion** (write access, needs [ffmpeg](https://ffmpeg.org/), e.g. `winget install ffmpeg`,
then `FFMPEG_PATH` in `.env`) — The recommended video format is **MP4 H.264**: light to decode
for UltraStar Deluxe (which decodes on the CPU) and playable in browsers. Every other video
(`.avi`, `.mkv`, MP4 in HEVC, VP9, MPEG-4 Part 2…) gets a warning, and so does every video larger
than 1080p (4K…): heavy to decode, with no visible gain behind the lyrics. The details window shows the
video format and resolution (read from the MP4 header without ffmpeg; through `ffprobe` for other
formats) and, under the warning, a **Convert video to MP4 H.264** button:

1. a simulation first says what will happen, and asks for confirmation;
2. ffmpeg converts in the background (progress bar; one conversion at a time):
   H.264 High, CRF 22, keyframe every 2 s (fast start and seeking), no audio track (UltraStar
   plays the song's MP3), `faststart`, **original resolution kept**, except above 1920 × 1080
   where the video is reduced to fit 1080p, keeping its proportions (never enlarged);
3. the result is checked (must be MP4 H.264), the original video is copied to `BACKUP_DIR`, then:
   `clip.avi` becomes `clip.mp4`, `#VIDEO` is updated in the `.txt` (with its own backup) and the
   original is removed from the song folder; an MP4 in another codec is replaced under the same
   name. If anything fails, the song folder is left as it was.

**File names** — Format 1.1.0 asks the audio file to have the same name as the folder, the cover
to end with `[CO]`, the background with `[BG]`, and vocals / instrumental files to carry `[VOC]` /
`[INSTR]`; it sets no rule for the folder and the `.txt`. Following the community convention (as in
Karedi), every name is checked against `Artist - Title` (from `#ARTIST` and `#TITLE`):

| Item                 | Expected name                                                |
| -------------------- | ------------------------------------------------------------ |
| folder               | `Artist - Title`                                             |
| song file            | `Artist - Title.txt`; duet: `Artist - Title [DUET].txt`      |
| audio, video         | `Artist - Title.<ext>`                                       |
| cover, background    | `Artist - Title [CO].<ext>`, `Artist - Title [BG].<ext>`     |
| vocals, instrumental | `Artist - Title [VOC].<ext>`, `Artist - Title [INSTR].<ext>` |

Case, accents and extra spaces are ignored; a character Windows forbids in file names (`/ : ? *…`)
may be removed or replaced by `-`, `_` or a space (`AC/DC` → `AC-DC`); a duet mark at the end of the
title (`[DUET]`, `(Duet)`, `- DUO`) is ignored for the folder and media files. Each misnamed item
gets its own warning, showing the expected name.

**ReplayGain** — The details window shows the ReplayGain tags of the audio file (track and album
gain in dB, peak), read from its ID3v2 tag (`TXXX:REPLAYGAIN_*`, written by foobar2000, mp3tag,
beets…) or its APEv2 tag (written by MP3Gain). Only a few KB of the file are read, when the window
opens; nothing is written.
MP3 files without ReplayGain get a warning. Under it, **Calculate the ReplayGain** measures the song
with ffmpeg (`replaygain` filter, 89 dB reference like MP3Gain) and shows the track gain and peak;
**Write to the MP3** then stores them as `REPLAYGAIN_TRACK_GAIN` / `REPLAYGAIN_TRACK_PEAK` in the
ID3 tag. Only the tag is rewritten (same ID3 version, other frames such as the cover kept byte for
byte); the audio data is not touched. The MP3 is backed up first and written atomically.

**Music and video in the same file** — Some songs use the same MP4 for `#MP3` (or `#AUDIO`) and
`#VIDEO`: they get a warning, and are never converted (the conversion drops the soundtrack). Under
that warning, **Create the MP3 file** extracts the soundtrack into `<video name>.mp3` (ffmpeg,
LAME VBR quality 2) and points `#AUDIO` and/or `#MP3` to it, whichever the file uses; the video is
not touched and can then be converted normally. When another version of the song in the same folder
(e.g. `[DUET]`) already created that MP3, it is simply reused.

**Bulk corrections** (write access) — The toolbox button in the top bar opens the bulk
corrections window. Each tool works in three steps:

1. **Simulate**: lists the files concerned; nothing is written.
2. **Choose**: every file is checked; untick the ones to leave alone.
3. **Apply**: files are processed in batches of 50 with a progress bar, then a summary shows
   what was converted and what failed. Each file gets its dated backup; a file changed elsewhere
   since the simulation is skipped, never overwritten. The grid is reloaded afterwards.

Tools (one tab each):

- **UTF-8 encoding** — converts every file in Windows-1252 or with a BOM.
- **MP4 H.264 videos** — lists every video to convert (format, resolution, size, and the disk
  space needed for the backups of the originals). Choose the **batch size** (5, 10, 20, 50 or
  all, at most 200): the server converts the next videos of the selection one after the other,
  in the background, with low priority so the PC stays usable. You can close the window or the
  page; reopening it shows the progress again. **Stop after the current video** never leaves a
  half-converted file. At the end, a summary is shown and the list is simulated again, so the
  next batch is ready. Each video goes through the same safe steps as the conversion from the
  details window. Rough timing with a recent PC: 15–30 s for an SD clip, 1–2 min in 1080p.

## Sharing on the local network

The tool is meant for **this PC or a local network (intranet)**, never the Internet.

1. In `.env`: `HOST=0.0.0.0`, at least `WRITE_KEY` or `ADMIN_KEY` (12+ characters, all
   different). Leave `READ_KEY` empty to let everyone browse and listen without a key.
2. Start the server: the console prints the addresses to use, e.g.
   `Network: http://192.168.1.20:3000`. Allow Node.js on **private networks** in the Windows
   firewall prompt.
3. Other devices open that address. To edit, they click the sign-in button and enter a key.
   A sign-in link `http://<address>:3000/login?key=…` can also be opened once on a phone: the key
   is exchanged for a session cookie and removed from the address bar.

| Access level | Allows                                                                  |
| ------------ | ----------------------------------------------------------------------- |
| **read**     | Browse, filter, preview, song details (public when `READ_KEY` is empty) |
| **write**    | Read + edit songs (edition, tags, creator…), refresh the library        |
| **admin**    | Write + delete (this PC is admin by default)                            |

### Security measures

- Sessions are signed (HMAC-SHA256) in an `HttpOnly`, `SameSite=Strict` cookie; changing a key in
  `.env` signs everyone out. Five wrong keys block an address for 15 minutes.
- The API only answers the application itself: requests sent by other websites are refused
  (`Sec-Fetch-Site` / `Origin` checks; writes need JSON and the `X-USM-Request` header).
- Unknown `Host` headers are refused (DNS rebinding protection).
- Strict Content Security Policy, no inline scripts, no external resources: Bootstrap is served
  locally, so the tool also works offline.
- Every path coming from the browser is checked to stay inside the configured folders.

**Rename to the naming rules** (write access) — In the details window, the naming problems of a
song are grouped in one warning, with a **Rename to the naming rules** button. The rename works on
the whole **folder**: every `.txt` in it (classic, duet…) shares the music, video and cover, so
each `.txt` citing a renamed file is updated. The window shows:

- the folder and each file: current name, suggested name (editable, with a button to go back to
  the suggestion) and a status — compliant, renamed, conflict (forbidden character, name already
  taken, extension changed…) or not used (files cited by no `.txt` are never renamed);
- the changes to each `.txt` (`#MP3`, `#VIDEO`, `#COVER`…), and its new name.

**Rename** is available once there is no conflict. The preview stops first (Windows locks files
being read), each changed `.txt` gets its dated backup, files are renamed in two steps (so a
case-only change works on Windows), the `.txt` files are rewritten in their original encoding and
the folder is renamed last. If any step fails, everything already done is put back. A journal
is written to `BACKUP_DIR/renames/`, and **Undo this rename** restores the names and `.txt`
contents, provided nothing changed in the meantime. Playlists (`.upl`, "Artist : Title") and
UltraStar Deluxe scores (artist and title) are not affected.

**Preferences** (admin) — The gear button in the top bar opens the preferences. The **File
naming** section lists each item checked by the naming warnings: folder, song `.txt`, duet `.txt`,
audio, video, cover, background, vocals and instrumental. For each one: a box to turn the check on
or off, the pattern of the expected name (`{artist}` and `{title}` come from `#ARTIST` and
`#TITLE`; the extension is not checked) and an example of the result. **Default values** restores
`{artist} - {title}` with the `[DUET]`, `[CO]`, `[BG]`, `[VOC]` and `[INSTR]` suffixes. **Save**
writes `settings.json` (see `SETTINGS_FILE`), then re-reads the library so the warnings follow the
new patterns at once. Characters forbidden in Windows file names are refused.

## API

All responses are JSON: `{ data: … }` on success, `{ error: { code, message } }` on error
(`401 AUTH_REQUIRED`, `403 FORBIDDEN_ROLE`, `404 SONG_NOT_FOUND`, `503 SONG_DIR_NOT_CONFIGURED`…).

| Method | URL                                       | Access | Response                                                                                                                                                       |
| ------ | ----------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`                             | public | `{ status, version }`                                                                                                                                          |
| GET    | `/api/auth/me`                            | public | `{ data: { role, isLocal, signedIn, hasKeys } }`                                                                                                               |
| POST   | `/api/auth/login`                         | public | `{ key }` → session cookie, `{ data: { role } }`                                                                                                               |
| POST   | `/api/auth/logout`                        | public | Removes the session cookie                                                                                                                                     |
| GET    | `/login?key=…`                            | public | Sign-in link, redirects to `/`                                                                                                                                 |
| GET    | `/api/songs`                              | read   | `{ data: Song[], meta: { count, scannedAt, durationMs, … } }`                                                                                                  |
| GET    | `/api/songs/:id`                          | read   | Details re-read from the `.txt`: `{ data: { song, details } }`                                                                                                 |
| GET    | `/api/songs/:id/cover`                    | read   | Cover image (browser cache 7 days)                                                                                                                             |
| GET    | `/api/songs/:id/audio`                    | read   | Audio file, `Range` supported                                                                                                                                  |
| GET    | `/api/songs/:id/video`                    | read   | Video file, `Range` supported                                                                                                                                  |
| GET    | `/api/playlists`                          | read   | `{ data: [{ name, file, modifiedAt, songIds, missing }], meta: { configured } }`                                                                               |
| POST   | `/api/playlists/:file/songs`              | write  | Add a song: `{ songId, expectedModifiedAt }` → `{ data: { playlist, changed, backup } }`                                                                       |
| DELETE | `/api/playlists/:file/songs`              | write  | Remove a song: same body and answer                                                                                                                            |
| POST   | `/api/songs/:id/rename`                   | write  | `{ dryRun: true, overrides? }` → `{ data: plan }`; `{ overrides?, expected }` → `{ data: { songId, journal, renamed, backups } }`                              |
| POST   | `/api/renames/:journal/undo`              | write  | Undo a rename: `{ data: { songIds } }`                                                                                                                         |
| GET    | `/api/songs/:id/musicbrainz`              | write  | MusicBrainz recordings matching the song: `{ data: { candidates } }`                                                                                           |
| GET    | `/api/songs/:id/musicbrainz/:recordingId` | write  | Proposed values: `{ data: { suggestion: { year, languages, genres } } }` (`?artistId=&releaseGroupId=` optional)                                               |
| GET    | `/api/settings`                           | read   | `{ data: { naming }, meta: { defaults } }` — `naming.<kind> = { enabled, pattern }`                                                                            |
| PUT    | `/api/settings`                           | admin  | Same `{ naming }` → saved, library re-read, `{ data }` (`400 INVALID_SETTINGS` with `params: { kind, reason }`)                                                |
| GET    | `/api/facet-images`                       | read   | `{ data: { language, decade, edition, tag } }` values with an image                                                                                            |
| GET    | `/api/facet-images/:facet/:value`         | read   | Category image, e.g. `/language/French`                                                                                                                        |
| POST   | `/api/catalog/rescan`                     | write  | Re-reads every `.txt`: `{ data: { count, durationMs, … } }`                                                                                                    |
| PATCH  | `/api/songs/:id/headers`                  | write  | `{ values: { EDITION, TAGS, CREATOR, YEAR, GENRE, LANGUAGE, P1, P2 }, expectedModifiedAt, dryRun? }` → `{ data: { changes, song, backup } }`                   |
| POST   | `/api/songs/:id/convert-utf8`             | write  | `{ expectedModifiedAt, dryRun? }` → `{ data: { changed, from, song, backup } }`                                                                                |
| POST   | `/api/songs/:id/convert-video`            | write  | `{ expectedModifiedAt, dryRun? }` → `200 { data: { plan } }` (simulation) or `202 { data: { plan, job } }`                                                     |
| GET    | `/api/songs/:id/convert-video`            | write  | Progress of the last conversion: `{ data: { job } }` (`state`: running, done, error)                                                                           |
| POST   | `/api/songs/:id/extract-audio`            | write  | Create the MP3 of a video used as music: `{ expectedModifiedAt, dryRun? }` → `{ data: { plan, song, headers, backup } }`                                       |
| POST   | `/api/songs/:id/replaygain`               | write  | `{ dryRun: true }` → `{ data: { trackGain, trackPeak, audioModifiedAt } }`; `{ trackGain, trackPeak, expectedAudioModifiedAt }` → `{ data: { song, backup } }` |
| POST   | `/api/bulk/convert-video`                 | write  | `{ dryRun: true }` → `{ data: { available, items } }`; `{ items: [{ id, expectedModifiedAt }] }` (≤ 200) → `202 { data: { batch } }`                           |
| GET    | `/api/bulk/convert-video`                 | write  | Current or last batch: `{ data: { batch } }` (`state`: running, done, stopped)                                                                                 |
| POST   | `/api/bulk/convert-video/stop`            | write  | Stop the batch after the current video                                                                                                                         |
| POST   | `/api/bulk/convert-utf8`                  | write  | `{ dryRun: true }` → `{ data: { items } }`; `{ items: [{ id, expectedModifiedAt }] }` (≤ 200) → `{ data: { results } }`                                        |

The `Song` and `SongDetails` formats are described by their `@typedef` in
`src/services/catalogService.js`. Each song has a `warnings` list of
`{ code, message, params }` (English message; the UI translates `warnings.<CODE>`).

## Development

| Command            | Purpose                                     |
| ------------------ | ------------------------------------------- |
| `npm start`        | Starts the server                           |
| `npm run dev`      | Starts with automatic reload                |
| `npm test`         | Runs the tests (`node:test`, no dependency) |
| `npm run lint`     | Checks lint + formatting with Biome         |
| `npm run lint:fix` | Fixes what can be fixed automatically       |

Recommended: VS Code with the **Biome** extension (`biomejs.biome`) — format on save is
configured in `.vscode/settings.json`.

### Project layout

```
src/
  server.js        Server startup only
  app.js           Express setup (testable without starting a server)
  config/          Reads and validates .env
  middlewares/     Security headers, Host/Origin checks, access levels
  routes/          URL → access level → controller, nothing else
  controllers/     Reads the request, calls a service, responds
  services/        Catalog, category images, authentication, song editing, safe file writes
  parsers/         UltraStar .txt reading and header editing — pure functions, no disk access
  utils/           Small shared helpers (safe paths, text, concurrency, Windows-1252)
public/
  index.html       Single page (Bootstrap)
  js/              ES modules: api, filters, grid, player, video, details, i18n…
  locales/         Translations (en.json = reference, fr.json)
  img/vendor/      Third-party icons (Bootstrap Icons, UltraStar-Manager)
test/              Tests mirroring src/ and public/js; helpers/ builds temporary libraries
```

### Coding rules

1. **ESM** everywhere, `const` by default, `async/await`.
2. `// @ts-check` + **JSDoc** on exported functions: VS Code checks types without TypeScript.
3. **Parsers** never touch the disk; services never trust a browser path without checking it.
4. Every song/playlist write goes through `src/services/fileWriter.js`: **dated backup** in
   `BACKUP_DIR`, then **atomic write** (temporary file, then rename); original encoding and line
   endings kept; changes are previewed with a **dry-run** first.
5. Every API route declares its access level (`requireRole`) and has a refusal test.
6. No UI text hard-coded: keys in `public/locales/*.json` (a test checks every language has the
   same keys).
7. Every new parser, service or utility comes **with its tests**; `npm run lint && npm test` must
   pass before every commit.
8. Commit messages follow _Conventional Commits_: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`.

The UltraStar `.txt` format reference used by the parser (spec 1.1.0, <https://usdx.eu/format/>)
is summarised in `.claude/ultrastar-format.md`.

## Credits

- [Bootstrap](https://getbootstrap.com/) 5, MIT — served locally from `node_modules`.
- [Bootstrap Icons](https://icons.getbootstrap.com/) 1.13.2, MIT — only the icons used are copied
  into `public/img/vendor/bootstrap-icons/icons.svg` (license alongside).
- Video icon (`public/img/vendor/ultrastar-manager/video.png`) from
  [UltraStar-Manager](https://github.com/UltraStar-Deluxe/UltraStar-Manager), GPL-2.0.
- Category images are read from your own UltraStar Deluxe installation and are not included.
