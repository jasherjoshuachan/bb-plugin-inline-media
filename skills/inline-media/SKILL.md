---
name: inline-media
description: Show a video or audio file from the workspace as a playable player inline in your bb reply, with the ::video, ::audio or ::media directive. Use after you render, record, download or generate a media file (a screen capture, a rendered clip, a text-to-speech take, a trimmed recording) and the user should watch or listen to it, or when the user asks to see or hear a media file in the workspace.
---

# Inline media

The Inline Media plugin turns a directive line in your reply into a native video or audio player. The user presses play; nothing autoplays.

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
| `file` | yes | Path to the file, relative to the thread's workspace root (the folder you are working in). |
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

- Use a workspace-relative path, exactly as it exists on disk: `out/demo.mp4`, not `./../demo.mp4` and not `/Users/.../demo.mp4`. Paths with `..`, `~` or a URL are refused.
- Make sure the file exists before you emit the directive (finish writing it first). A missing file shows "File not found".
- Never use the directive for remote URLs (`https://...`). It only plays local files. Download the file into the workspace first if the user wants to play it here, or just give the link.
- One directive per file, each on its own line. Don't put it inside a code block, a list item, a table or a sentence; there it stays plain text.
- Quote every value with double quotes. Don't put a `"` inside a value.
- The one absolute path allowed is a large file the user dropped with the Composer Dropzone plugin: its message names a path inside `.../plugins/composer-dropzone/drops/`. You may pass that path as `file` unchanged.
- Directives only render in your replies, not in the user's messages.
- Keep a short sentence around it saying what the clip is, so the reply still makes sense if the player can't load.
