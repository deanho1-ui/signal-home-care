---
name: video-to-agent
description: Watch a video (YouTube, TikTok, Reels, a local file) and turn it into reconciled notes or a Claude Code skill. Use when the user shares a video link and wants notes, a summary, timestamps, the steps it teaches, or an agent built from it — including "take notes on my saved TikToks" and "build me a skill that does what this tutorial does".
---

# Video → notes → agent

Two models read the video independently and their disagreements are surfaced
rather than smoothed over:

- **Gemini watches it.** Native video understanding — frames, on-screen text,
  audio, timestamps. A tutorial's value is usually in strings you must retype
  exactly (a command, a plugin name, a URL), and those are read off the screen.
- **Claude checks it.** Claude never sees the video. It takes Gemini's factual
  claims and searches the public web for each one. A misheard plugin name or a
  dead URL shows up here as a conflict.
- **Conflicts are flagged, not averaged.** A claim that failed the check is
  never promoted into a procedure step.

## Prerequisites

| | |
|---|---|
| `GEMINI_API_KEY` | Required. Free tier is enough: <https://aistudio.google.com/apikey> |
| `ANTHROPIC_API_KEY` | Required for the cross-check. Already a repo secret for the weekly refresh. |
| `yt-dlp` | Only for non-YouTube videos (TikTok, Reels, X). `brew install yt-dlp` / `pipx install yt-dlp` |

## Running it

```bash
node scripts/watch.mjs "<video-url>"                       # → notes/<slug>.md
node scripts/watch.mjs "<url>" --ask "what tools does it name?"
node scripts/watch.mjs "<url>" --spec                      # → also notes/<slug>.spec.json
node scripts/watch.mjs "<url>" --no-verify                 # skip the web cross-check (faster, less trustworthy)
node scripts/watch.mjs "<url>" --out briefs --keep         # custom output dir; keep the download
```

## Building a skill from a video

1. Run with `--spec`. You get notes plus `notes/<slug>.spec.json`.
2. **Read the notes' `⚠️ Conflicts` and `Couldn't make out` sections yourself.**
   The spec's `open_questions` lists what did not survive the check — resolve
   those with the user before building on them.
3. Hand the spec to the `skill-creator` skill to generate the skill.

Never skip step 2. The spec deliberately keeps unverified material out of
`procedure`, so anything the video was confident about but the web could not
confirm is waiting there for a human decision.

## Working with a batch of saved videos

Loop the script over the links, then read the resulting markdown files:

```bash
while read -r url; do node scripts/watch.mjs "$url" --out notes/tiktok; done < links.txt
```

For Signal's purposes the useful follow-up is comparing notes across videos —
recurring hooks, formats and product mentions — and feeding that into a trend
brief.

## Things that are not true

- **You cannot convert a TikTok link into a YouTube link.** The video only
  exists on TikTok. The script downloads it with `yt-dlp` and uploads the file
  to Gemini instead; that is what makes non-YouTube platforms work.
- **Gemini's YouTube ingest needs a public or unlisted URL.** Private videos
  fail. Download those first and pass the local path's URL through yt-dlp.
- **`gemini-2.5-flash` no longer serves new API keys.** The API still lists it,
  but `generateContent` returns 404 pointing at `gemini-3.6-flash` — which is
  the default here, verified working on video. `gemini-3.8-flash` also exists
  and returned 503 (demand spike) when tried; `gemini-3.5-flash` and
  `gemini-3-flash-preview` both work too.
- Free-tier Gemini has per-day request and video-length limits. A long video
  may need `WATCH_GEMINI_MODEL` pointed at a larger model and a paid key.

## Tuning

| Env | Default |
|---|---|
| `WATCH_GEMINI_MODEL` | `gemini-3.6-flash` |
| `WATCH_CLAUDE_MODEL` | `claude-sonnet-5` |
