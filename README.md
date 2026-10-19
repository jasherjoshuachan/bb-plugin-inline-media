# bb-plugin-inline-media

Play videos and audio inline in [bb](https://getbb.app) threads.

An agent renders a clip, records a screen capture or generates a voice-over, then writes one line in its reply:

```
::video{file="out/demo.mp4"}
```

and you get a native player right in the thread. No switching to Finder, no opening the file somewhere else.

**Status: v0.2.** Three ways to play a file, from most to least stable: directives in agent replies, a Play media action on any message, and best-effort play buttons on media file links.

## Install

```sh
bb plugin install git:https://github.com/jasherjoshuachan/bb-plugin-inline-media.git@v0.2.0
```

Requires bb 0.46 or later.

## Three ways to play

| Route | Where | Stability |
|---|---|---|
| 1. Directives | `::video{file=...}` in agent replies | Stable: the official `messageDirective` slot |
| 2. Play media | Message action on any message, user or agent | Stable: the official `messageAction` and `threadPanelAction` slots, message data from the SDK |
| 3. Play buttons on links | ▶ after media file links in rendered messages | Best effort: reads bb's DOM, setting `decorateLinks` |

Routes 1 and 2 use only public SDK surfaces, so they keep working when bb's UI changes. Route 3 is a convenience: if bb changes how it draws links, the buttons stop appearing and nothing else breaks.

### 1. Directives in agent replies

Three directives, each on its own line in an assistant reply:

| Directive | Player |
|---|---|
| `::video{file="..."}` | `<video>` |
| `::audio{file="..."}` | `<audio>` |
| `::media{file="..."}` | picked from the extension |

Attributes:

| Attribute | Default | Meaning |
|---|---|---|
| `file` | required | Path relative to the thread's workspace (or thread storage), or an allowed absolute path (see [Security](#security)) |
| `source` | `workspace` | `workspace` or `thread-storage` |
| `title` | file name | Label shown above the player |
| `start` | `0` | Start position: seconds (`90`) or a time (`1:30`, `1:02:03`) |
| `loop` | off | Bare `loop` or `loop="true"` |
| `muted` | off | Bare `muted` or `muted="true"` |

```
::video{file="renders/intro.mp4" title="Intro, cut 3" start="0:04" muted}
::audio{file="voiceover/take-2.m4a"}
::media{file="Attachments/clip.webm" source="thread-storage" loop}
```

The plugin ships a skill (`skills/inline-media/SKILL.md`) that tells agents to add a directive whenever a reply mentions a media file they produced or the user asked about.

### 2. Play media (message action)

Every message, yours or the agent's, gets a **Play media** action in its action bar. It reads the message through the SDK (`useSdk().threads.message`), finds every media file it refers to, and opens a **Media** tab in the side panel with a player for each one:

- attachments: files attached by path (Composer Dropzone links originals like `/Users/you/Projects/site/out/video.mp4`), uploaded files (played from thread storage's `Attachments/` folder);
- `@` path mentions;
- directives, markdown links (including `file://` links), backticked paths and bare paths in the text.

If the message has none, you get a "No video or audio in this message" toast.

### 3. Play buttons on links (best effort)

A content script adds a small ▶ after links to media files in rendered messages; clicking it opens the player under the link, clicking again closes it. Turn it off with `decorateLinks`.

It relies only on these signals in bb's DOM, recorded from bb 0.46.1 (`lib/link-decorator.ts`):

| Selector | What it is |
|---|---|
| `[data-timeline-row-id]` | One timeline row. The value starts with the thread id (`thr_x:assistant:…`); user rows end in `:user-seed:<seq>`, the message sequence |
| `[data-markdown-preview]` | The rendered message body inside that row |
| `a[href^="file:"]` | A local file link; bb rewrites workspace links to `file:///<absolute path>` |

If none match, nothing happens. The script never throws into bb, never edits bb's nodes (it only inserts its own elements after them, marked `data-inline-media-owned`), and removes everything it added when the plugin stops or the setting is turned off. The players render through an app overlay (`experimental_appOverlay`) that portals them into those elements, so this route needs a bb that has that slot; without it, the route is simply off. Attachment chips have no stable markup, so they get no button: use Play media for them.

## The player

- Native controls, `preload="metadata"`, plays inline, never autoplays.
- Header with the name, duration once known, file size, and buttons to open the file in bb's side panel, **Reveal in Finder**, and copy its path.
- **First-frame poster:** once a video's metadata loads, a hidden, muted copy (never played, never attached to the page) seeks to min(1 s, duration / 10) and that frame becomes the poster. Kept in memory per URL; any failure leaves the plain player.
- **Reveal in Finder** shows the file in Finder. It appears only when the file is on the Mac running bb's server.
- Starting one player pauses any other inline player that is playing.
- Videos are capped at 420 px high (setting `maxInlineHeight`).
- Preview URLs expire after 30 minutes. If one has expired when you press play or seek, the player gets a fresh URL and carries on where it was.
- A file the browser can't decode (for example an HEVC `.mov` on a machine without HEVC support) shows a clear message with Open in side panel, Open in another app, Reveal in Finder and Try again. A video whose sound plays but whose picture can't be decoded says so.
- Invalid directive attributes show a small inline error with the original text instead of a player.

Supported files: `.mp4 .m4v .mov .webm .ogv` (video) and `.mp3 .m4a .aac .wav .ogg .oga .opus .flac` (audio), any letter case.

## Security

Directive attributes, message text and link targets are treated as untrusted. The server is the only place that touches files, and it decides every request itself.

- **Media files only.** The server serves only the 13 extensions above, so nothing here can be used to show source files, keys or databases.
- **Confined roots.** Relative paths resolve inside the thread's workspace or thread storage. `..` segments (with `/` or `\`, also percent-encoded), `~` paths, URLs and other schemes (`https:`, `file:`, `data:`) are refused, in the browser and again on the server.
- **Absolute paths** are served only when one of these holds:
  1. the file is inside Composer Dropzone's `drops` folder on the bb server machine (setting `allowDropzoneFolder`; its in-progress `.partial` folder is never served);
  2. the file is inside the thread's own workspace or thread storage, in which case it is served exactly like the relative path;
  3. the user attached exactly that file to a message in this thread. The server checks with bb's SDK: the thread's prompt history (`bb.sdk.threads.promptHistory`, each `localFile` has a host and path) and, when the caller names a message, that message's attachments (`bb.sdk.threads.message`). The path must match exactly and the attachment's host must be the bb server's machine.
- **Protected locations** are never served by absolute path, even when attached: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.docker`, `~/.config`, every `~/.claude*`, bb's data folder (except the drops folder), `~/Library/Keychains` and `~/Library/Cookies`. The check runs on the path as given and again after symlinks are followed.
- **Previews cover a folder.** bb's preview URLs are minted for the folder that holds the file. So a file is refused when that folder is your home folder, a folder above it, or a folder above a protected location (move the file into a subfolder).
- **Symlinks.** On the bb server's own machine, the server follows symlinks and refuses a workspace file whose real location is outside the root. (For workspaces on a remote host, confinement is left to bb's host file service.)
- **No new transport.** Bytes are served by bb's own preview server through `bb.sdk.files.createPreview`: temporary URLs (30 minutes) that never reveal the host id or absolute path, with range requests so seeking works and nothing is buffered in the plugin.
- **Reveal in Finder** resolves the file with the same rules, then runs `/usr/bin/open -R <file>` with an argument vector (no shell), only on macOS and only for files on the bb server's own machine.
- **Nothing else.** No plugin HTTP routes, no network calls, no other child processes, no `innerHTML`. Remote URLs are never fetched. The only runtime dependency is `zod`.

## Settings

Change them in bb's plugin settings or with `bb plugin config inline-media set <key> <value>`.

| Setting | Default | Meaning |
|---|---|---|
| `maxInlineHeight` | `420` | Largest inline video height in pixels (120 to 2000) |
| `allowDropzoneFolder` | `true` | Allow absolute paths inside Composer Dropzone's drops folder |
| `decorateLinks` | `true` | Play buttons after media file links in messages (best effort) |

## How it works

- `app.tsx` registers the `video`, `audio` and `media` message directives (`app.slots.messageDirective`), the Play media action (`app.slots.messageAction`), the Media panel (`app.slots.threadPanelAction`), and for route 3 an app overlay bridge (`app.slots.experimental_appOverlay`) plus a content script (`app.contentScripts.register`).
- `lib/attributes.ts` validates directive attributes; `lib/extract.ts` finds media references in a message; `lib/link-decorator.ts` finds and decorates file links; `lib/poster.ts` draws poster frames.
- `server.ts` has two RPCs, `mediaUrl` and `reveal`. It checks the path (`lib/paths.ts`, `lib/roots.ts`, `lib/authorize.ts`), finds the root (`bb.sdk.threads.get({ include: "environment" })` for the workspace, `bb.sdk.threads.storageLocation` for thread storage, `bb.storage.database().name` to locate bb's data and drops folders), and calls `bb.sdk.files.createPreview` on the file's folder. Preview roots are cached per folder until two minutes before they expire (`lib/preview-cache.ts`).
- The side-panel button uses the directive's `openWorkspaceFile` for workspace files and `useBbNavigate().experimental_openFilePreview` otherwise; both are feature-checked, so the button hides on a bb without them.

## Limitations

- No keyboard shortcuts or picture-in-picture button yet (v0.3).
- Uploaded attachments are played from thread storage's `Attachments/` folder, where bb copies them by their original name; if bb renamed a copy, the player says File not found.
- What plays depends on the browser engine bb runs in: H.264/AAC `.mp4`, `.webm` and `.mp3` are safe choices.
- Directives render only in assistant and sub-agent replies; bb keeps them as text in your own messages. Use Play media there.

## Develop

```sh
npm install
npm run typecheck
npm test
npm run build      # bb plugin build -> dist/
bb plugin install path:$PWD
```

The link decorator tests run against timeline markup captured from bb with headless Chrome and sanitized (`test/fixtures/`).

## License

MIT
