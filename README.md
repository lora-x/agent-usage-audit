# Codex Usage Viewer

Local-only webpage for reviewing Codex session usage logs.

## Run

```bash
node server.js
```

Then open:

```text
http://127.0.0.1:8765
```

The viewer reads both:

- `~/.codex/sessions`
- `~/.codex/archived_sessions`

If your Codex data lives somewhere else, set `CODEX_HOME` before starting:

```bash
CODEX_HOME=/path/to/codex node server.js
```

No AI, network service, package install, or dashboard server is required.
The viewer also shows the model used for each session and prices tokens using the model-specific Codex rate card.

## Rate Card

Reference used by the viewer:

- [Codex rate card](https://help.openai.com/en/articles/20001106-codex-rate-card)

Snapshot shown here is for May 24, 2026:

| Model | Input tokens | Cached input tokens | Output tokens |
| --- | ---: | ---: | ---: |
| GPT-5.5 | 125 credits | 12.50 credits | 750 credits |
| GPT-5.4 | 62.50 credits | 6.250 credits | 375 credits |
| GPT-5.4-Mini | 18.75 credits | 1.875 credits | 113 credits |
| GPT-5.3-Codex | 43.75 credits | 4.375 credits | 350 credits |
| GPT-5.2 | 43.75 credits | 4.375 credits | 350 credits |
| GPT-5.3-Codex-Spark | research preview | research preview | research preview |
| GPT-Image-2.0 (image) | 200 credits | 50 credits | 750 credits |
| GPT-Image-2.0 (text) | 125 credits | 31.25 credits | 250 credits |

## Features

- Inclusive start/end date filter.
- Unified table across active and archived sessions.
- Session token totals, estimated Codex credits, and estimated dollars.
- Click any session ID to open a formatted full log page.
- Use "Show raw JSON" on the log page when you need the underlying JSONL event objects.
