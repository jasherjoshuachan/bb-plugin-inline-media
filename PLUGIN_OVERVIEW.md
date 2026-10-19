Play videos and audio inline in bb threads: in agent replies, from any message, and from media file links.

## What you get

- A native video or audio player in the thread when an agent writes `::video{file="out/demo.mp4"}`, `::audio{file="memo.m4a"}` or `::media{file="..."}` on its own line.
- File name, duration and size above the player, with buttons to open the file in the side panel and copy its path.
- Nothing autoplays, and starting one player pauses the others.
- A clear message, with fallbacks, when a file can't be played in this browser.
- A Play media action on any message, yours or the agent's: it finds the message's videos and audio (attachments, links, paths) and plays them in a side panel.
- Play buttons after media file links in messages (best effort; turn off with a setting).
- A first-frame poster for videos, and Reveal in Finder for files on your Mac.
- A bundled skill that tells agents when and how to show media inline.

## How it works

Only media files (13 common video and audio extensions) are played: from the thread's workspace or thread storage, files you attached by path, and large files dropped with Composer Dropzone. Private folders such as ~/.ssh are always refused. Paths with `..`, `~` or URLs are refused. Files are streamed through bb's own short-lived preview URLs, so seeking works and nothing is copied. Nothing leaves the machine, and the plugin needs no account, API key or external service.
