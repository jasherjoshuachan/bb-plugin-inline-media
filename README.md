# bb-plugin-inline-media

Play videos and audio inline in [bb](https://getbb.app) threads.

An agent renders a clip, records a screen capture or generates a voice-over, then writes one line in its reply:

```
::video{file="out/demo.mp4"}
```

and you get a native player right in the thread. No switching to Finder, no opening the file somewhere else.

**Status: v0.1.** Directives, player, confined preview URLs and the agent skill are done. Play buttons on plain media file links are planned for v0.2 (see [PLAN.md](PLAN.md)).

## Install

```sh
bb plugin install git:https://github.com/jasherjoshuachan/bb-plugin-inline-media.git@v0.1.0
```

Requires bb 0.46 or later.

## Usage

Three directives, each on its own line in an assistant reply:

| Directive | Player |
|---|---|
| `::video{file="..."}` | `<video>` |
| `::audio{file="..."}` | `<audio>` |
| `::media{file="..."}` | picked from the extension |

Attributes:

| Attribute | Default | Meaning |
|---|---|---|
| `file` | required | Path relative to the thread's workspace (or thread storage) |
| `source` | `workspace` | `workspace` or `thread-storage` |
| `title` | file name | Label shown above the player |
| `start` | `0` | Start position: seconds (`90`) or a time (`1:30`, `1:02:03`) |
| `loop` | off | Bare `loop` or `loop="true"` |
| `muted` | off | Bare `muted` or `muted="true"` |

```
::video{file="renders/intro.mp4" title="Intro, cut 3" start="0:04" muted}
::audio{file="voiceover/take-2.m4a"}
::media{file="clip.webm" source="thread-storage" loop}
```

Supported files: `.mp4 .m4v .mov .webm .ogv` (video) and `.mp3 .m4a .aac .wav .ogg .oga .opus .flac` (audio), any letter case.

The player:

- Native controls, `preload="metadata"`, plays inline, never autoplays.
- Header with the name, duration once known, file size, and buttons to open the file in bb's side panel and copy its path.
- Starting one player pauses any other inline player that is playing.
- Videos are capped at 420 px high (setting `maxInlineHeight`).
- Preview URLs expire after 30 minutes. If one has expired when you press play or seek, the player gets a fresh URL and carries on where it was.
- A file the browser can't decode (for example an HEVC `.mov` on a machine without HEVC support) shows a clear message with Open in side panel, Open in another app and Try again. A video whose sound plays but whose picture can't be decoded says so.
- Invalid attributes show a small inline error with the original directive text instead of a player.

The plugin ships a skill (`skills/inline-media/SKILL.md`) that tells agents when to use the directive and the exact syntax.

### Composer Dropzone files

Large files dropped with the [Composer Dropzone](https://github.com/jasherjoshuachan/bb-plugin-composer-dropzone) plugin are saved outside the workspace and attached by absolute path. Inline Media accepts those absolute paths too, so an agent can play a video you dropped. Turn this off with `allowDropzoneFolder`.

## Security

Directive attributes are written by the model and treated as untrusted.

- **Media files only.** The server serves only the 13 extensions above. A directive can't be used to show source files, keys or databases.
- **Confined roots.** Relative paths resolve inside the thread's workspace or thread storage. `..` segments (with `/` or `\`, also percent-encoded), `~` paths, URLs and other schemes (`https:`, `file:`, `data:`) are refused, both in the browser and again on the server. The only absolute paths allowed are files inside Composer Dropzone's `drops` folder on the bb server machine, and only when `allowDropzoneFolder` is on; its in-progress `.partial` folder is never served.
- **Symlinks.** On the bb server's own machine, the server follows symlinks and refuses a file whose real location is outside the root. (For workspaces on a remote host, confinement is left to bb's host file service.)
- **No new transport.** Bytes are served by bb's own preview server through `bb.sdk.files.createPreview`: temporary URLs (30 minutes) that never reveal the host id or absolute path, with range requests so seeking works and nothing is buffered in the plugin. A preview covers the folder that holds the file, the same access bb's file viewer already has.
- **Nothing else.** No plugin HTTP routes, no network calls, no child processes, no `innerHTML`. Remote URLs are never fetched. The only runtime dependency is `zod`.

## Settings

Change them in bb's plugin settings or with `bb plugin config inline-media set <key> <value>`.

| Setting | Default | Meaning |
|---|---|---|
| `maxInlineHeight` | `420` | Largest inline video height in pixels (120 to 2000) |
| `allowDropzoneFolder` | `true` | Allow absolute paths inside Composer Dropzone's drops folder |
| `decorateLinks` | `true` | Reserved for v0.2's play buttons on media file links; no effect yet |

## How it works

- `app.tsx` registers the `video`, `audio` and `media` message directives. `lib/attributes.ts` validates the attributes; the player asks the server for a URL with the `mediaUrl` RPC.
- `server.ts` checks the path (`lib/paths.ts`, `lib/roots.ts`), finds the root (`bb.sdk.threads.get({ include: "environment" })` for the workspace, `bb.sdk.threads.storageLocation` for thread storage, `bb.storage.database().name` to locate the drops folder), and calls `bb.sdk.files.createPreview` on the file's folder. Preview roots are cached per folder until two minutes before they expire (`lib/preview-cache.ts`).
- The side-panel button uses the directive's `openWorkspaceFile` for workspace files and `useBbNavigate().experimental_openFilePreview` otherwise; both are feature-checked, so the button hides on a bb without them.

## Limitations

- Media links in messages don't get play buttons yet (v0.2).
- No poster frames, keyboard shortcuts or picture-in-picture button yet (v0.3).
- What plays depends on the browser engine bb runs in: H.264/AAC `.mp4`, `.webm` and `.mp3` are safe choices.
- Directives render only in assistant and sub-agent replies; bb keeps them as text in your own messages.

## Develop

```sh
npm install
npm run typecheck
npm test
npm run build      # bb plugin build -> dist/
bb plugin install path:$PWD
```

To try it, put a small clip in a thread's workspace and ask the agent to reply with `::video{file="<path>"}` on its own line.

## License

MIT
