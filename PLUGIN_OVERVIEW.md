Play videos and audio inline in agent replies.

## What you get

- A native video or audio player in the thread when an agent writes `::video{file="out/demo.mp4"}`, `::audio{file="memo.m4a"}` or `::media{file="..."}` on its own line.
- File name, duration and size above the player, with buttons to open the file in the side panel and copy its path.
- Nothing autoplays, and starting one player pauses the others.
- A clear message, with fallbacks, when a file can't be played in this browser.
- A bundled skill that tells agents when and how to show media inline.

## How it works

Only media files (13 common video and audio extensions) inside the thread's workspace or thread storage are played, plus large files dropped with Composer Dropzone. Paths with `..`, `~` or URLs are refused. Files are streamed through bb's own short-lived preview URLs, so seeking works and nothing is copied. Nothing leaves the machine, and the plugin needs no account, API key or external service.
