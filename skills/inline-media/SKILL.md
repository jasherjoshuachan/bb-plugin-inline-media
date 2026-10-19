---
name: inline-media
description: Show a video or audio file as a playable player inline in your bb reply, with the ::video, ::audio or ::media directive. Use whenever your reply mentions a media file you produced (a render, screen capture, text-to-speech take, trimmed or downloaded clip) or one the user asked about or attached, so they can play it without leaving the thread.
---

# Inline media

The Inline Media plugin turns a directive line in your reply into a native video or audio player. The user presses play; nothing autoplays.

## When

Every time your reply names a video or audio file that you created or changed, or that the user asked about or attached, add a directive for it. Don't just print the path: the user can't click a path to play it.

## Syntax

Put the directive on its own line, with a blank line before and after it:

```
::video{file="out/demo.mp4"}
```

```
::audio{file="voiceover/take-2.m4a"}
```

`::media{file="..."}` picks the video or audio player from the file extension. Use it when you don't know which one fits.

## Attributes

| Attribute | Required | Meaning |
| --- | --- | --- |
| `file` | yes | Path to the file: relative to the workspace root (the folder you are working in), or see Rules. |
| `source` | no | `workspace` (default) or `thread-storage` for a file in this thread's storage folder. |
| `title` | no | Label shown above the player instead of the file name. |
| `start` | no | Where playback starts: seconds (`90`) or a time (`1:30`, `1:02:03`). |
| `loop` | no | Bare `loop` (or `loop="true"`) repeats playback. |
| `muted` | no | Bare `muted` starts with the sound off. |

Example with options:

```
::video{file="renders/intro.mp4" title="Intro, cut 3" start="0:04" muted}
```

Supported extensions: .mp4 .m4v .mov .webm .ogv (video) and .mp3 .m4a .aac .wav .ogg .oga .opus .flac (audio). Prefer H.264 .mp4 or .webm for video: HEVC or ProRes .mov files may play sound only, or not at all, depending on the user's machine.

## Rules

- One directive per file, on its own line with blank lines around it. Not inside a code block, list, table or sentence (there it stays text).
- `file` is one of:
  - a path relative to the workspace root, exactly as on disk: `out/demo.mp4`;
  - with `source="thread-storage"`, a path relative to this thread's storage folder (files the user uploaded are in `Attachments/`): `::video{file="Attachments/clip.mp4" source="thread-storage"}`;
  - an absolute path, only when the user attached that file by path (its message lists it, e.g. `/Users/.../video.mp4`) or it is inside Composer Dropzone's `.../plugins/composer-dropzone/drops/` folder. Copy it unchanged.
- Never `..`, `~`, URLs or other absolute paths: they are refused. To show a remote file, download it into the workspace first.
- Finish writing the file before you emit the directive; a missing file shows "File not found".
- Quote every value with double quotes; no `"` inside a value.
- Keep a short sentence saying what the clip is, so the reply still reads well if the player can't load.
- Directives render only in your replies, not in the user's messages. (The user can play media in any message with the Play media message action.)
