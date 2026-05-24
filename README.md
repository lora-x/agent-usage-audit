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

## Features

- Inclusive start/end date filter.
- Unified table across active and archived sessions.
- Session token totals, estimated Codex credits, and estimated dollars.
- Click any session ID to open a formatted full log page.
- Use "Show raw JSON" on the log page when you need the underlying JSONL event objects.
