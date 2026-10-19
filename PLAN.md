# bb-plugin-inline-media: plan

Play videos and audio inline in bb threads, from agent replies and from file links.

## Goals

1. Agent replies can show a playable video or audio inline: `::video{file="out/demo.mp4"}`, `::audio{file="memo.m4a"}`.
2. Links to local media files (`.mp4 .mov .m4v .webm .mp3 .m4a .wav .ogg .flac .aac .opus`) in thread messages get an inline ▶ toggle that expands a player under the link.
3. No network, no new file access beyond what bb already confines, nothing autoplays.

Not goals: transcoding, editing, thumbnails generated server-side (v2), side-panel viewers (Office Viewer and File Manager already do that).

## Design

### 1. Directive (stable SDK surface)
- `app.slots.messageDirective({ id: "video" | "audio" | "media", component })`.
- Attributes (all untrusted): `file` (required), `source` (`workspace` default, `thread-storage`), `title`, `start` (seconds), `loop`, `muted`.
- Renders only in assistant and nested-agent messages (bb's rule). Invalid attributes render a small inline error that quotes the original directive. (v0.1: unknown attributes are ignored rather than rejected, so a newer skill can add optional ones without breaking older installs.)
- A bundled skill (`skills/inline-media/SKILL.md`) tells agents when to emit the directive (after rendering a video, recording a screen capture, generating audio) and the exact syntax.

### 2. Local-link playback (content script, best effort)
- No SDK slot overrides file links, so a content script with a `MutationObserver` decorates anchors inside message bodies whose target is a media file. It adds a small ▶ button after the link. Clicking it mounts the same player component below the link.
- It is DOM-dependent, so it sits behind a setting (`decorateLinks`, default on) and is fully isolated: it adds sibling elements only and never rewrites bb's nodes.
- It works in user messages too, which covers "I attached this video, look".

### 3. Bytes: confined preview URLs
- Server RPC `mediaUrl({ path, source, threadId })`:
  - Extension allowlist only (media types above); everything else is rejected.
  - Resolves the path against the thread's workspace root or thread storage via `bb.sdk.files` / environment lookup. It rejects `..` and absolute paths outside the workspace.
  - The single extra allowed root is Composer Dropzone's `drops/` folder, so large dropped videos play too.
  - Calls `bb.sdk.files.createPreview({ rootPath: <dir>, ttlMs: 30 min })` and returns `baseUrl + encodeURIComponent(name)`. bb's preview server handles range requests, so seeking works and nothing is loaded into memory.
- No plugin HTTP routes. Preview URLs expire and never reveal the host id or absolute root.

### 4. Player
- Native `<video controls preload="metadata" playsinline>` / `<audio controls preload="metadata">`, max height 420 px, rounded, follows bb's theme.
- Header line: file name, size, duration once known; buttons for open in side panel (`openWorkspaceFile`) and copy path.
- An unsupported codec (for example HEVC `.mov` on a machine without hardware decode) shows a clear message and an "Open in Finder / side panel" fallback.
- One player at a time plays: starting one pauses the others.

### 5. Settings
`decorateLinks` (bool), `maxInlineHeight` (number), `allowDropzoneFolder` (bool).

## Security checklist
- Attributes and link targets are attacker-controlled: allowlist extensions, confine roots, never fetch remote URLs (http(s) links are left alone).
- No `child_process`, no outbound network, no `innerHTML`; React components only.
- Range-served preview URLs with expiry; no long-lived tokens.
- Pin the SDK, keep the dependencies to `zod` only.

## Tests
- Unit: path and extension validation, attribute parsing (`node --test`).
- SDK frontend harness for the directive component (bad attrs → fallback).
- E2E: headless Chrome against the local bb (same approach as composer-dropzone): a reply containing the directive, a message with a media link, seeking (range requests), and an expired URL refresh.

## Milestones
1. v0.1: directive and player and `mediaUrl` RPC and skill (about 1 day). **Done** (0.1.0).
2. v0.2: Play media message action and Media panel, link decoration content script, attached-by-path absolute files, Reveal in Finder, first-frame posters. **Done** (0.2.0).
3. v0.3: keyboard shortcuts, a picture-in-picture button.

## Open questions
- ~~Final directive names (`video`/`audio` vs one `media`).~~ Decided in v0.1: all three. `video` and `audio` force the element, `media` picks it from the extension.
- Submit both plugins to the bb-community marketplace once they've had a week of daily use?

## v0.1 notes
- `mediaUrl` also returns `sizeBytes` (read locally when the file is on the bb server's machine, `null` for remote hosts), `expiresAtMs`, and a live-file `target` for bb's side panel.
- On the bb server's machine the server resolves symlinks and refuses files whose real path leaves the root, and reports missing files as `not-found` without minting a preview.
- `start` accepts seconds or `m:ss` / `h:mm:ss`. Booleans accept a bare attribute, `true/false`, `1/0`, `yes/no`, `on/off`.
- An expired preview is re-minted at most once a minute after a playback error, resuming at the same position.
- Tests: unit tests for path, root, attribute, cache and registry logic, plus `mediaUrl` behavior tests against the SDK's fake plugin host with a real temporary workspace. The frontend harness test and the headless E2E are still to do.

## v0.2 notes
- Goal: playback must not break when bb's UI changes. Three routes, two of them on stable SDK surfaces only:
  1. Directives (`messageDirective`); the skill now asks agents to add one whenever a reply mentions a media file they produced or the user asked about or attached.
  2. Play media (`messageAction` + `threadPanelAction`): the message is read with `useSdk().threads.message({ threadId, seq: message.experimental_messageSeq })`, and `lib/extract.ts` collects attachments (`localFileDetails`/`localFilePaths`), path and attachment mentions, directives, markdown and `file://` links, backticked and bare paths. Uploaded attachments are played from thread storage's `Attachments/<name>`. An app-overlay bridge hands the SDK client to the action so it can toast "No video or audio in this message" without opening a panel; without the bridge the panel shows that instead.
  3. Link buttons (content script, best effort): selectors `[data-timeline-row-id] [data-markdown-preview] a[href^="file:"]`, captured from bb 0.46.1. Players render through `experimental_appOverlay` + `createPortal` so they keep the plugin's React context (`createRoot` from the shimmed `react-dom/client` would lose `useRpc`/`useSettings`). Off when that slot is missing or `decorateLinks` is off.
- Absolute paths: besides drops, the server now serves (a) paths inside the thread's own workspace or thread storage, mapped to the relative path (bb renders every workspace link as `file:///<absolute path>`, so route 3 needs this), and (b) files the user attached by path, verified with `bb.sdk.threads.promptHistory` (`localFile` host + path, exact match, host must be the bb server's) and, with a `message: { seq }` reference, `bb.sdk.threads.message`. Protected locations are refused by path and by real path; a preview folder that is or contains the home folder or a protected folder is refused.
- `reveal` RPC: same resolution, then `/usr/bin/open -R` with an argument vector; `mediaUrl` returns `canReveal`.
- Posters: hidden detached muted `<video>`, seek to min(1 s, duration / 10), canvas JPEG, cached per URL; failures are silent.
- Tests: extraction, authorization, roots, the decorator against sanitized DOM fixtures (linkedom), posters and the mount store with fakes, and `mediaUrl`/`reveal` against the SDK's fake plugin host with real temporary files.
