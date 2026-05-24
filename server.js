#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const url = require("url");

const PORT = Number(process.env.PORT || 8765);
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const ACTIVE_ROOT = path.join(CODEX_HOME, "sessions");
const ARCHIVED_ROOT = path.join(CODEX_HOME, "archived_sessions");

const RATES = {
  "gpt-5.5": { label: "GPT-5.5", input: 125, cached: 12.5, output: 750 },
  "gpt-5.4": { label: "GPT-5.4", input: 62.5, cached: 6.25, output: 375 },
  "gpt-5.4-mini": { label: "GPT-5.4-Mini", input: 18.75, cached: 1.875, output: 113 },
  "gpt-5.3-codex": { label: "GPT-5.3-Codex", input: 43.75, cached: 4.375, output: 350 },
  "gpt-5.2": { label: "GPT-5.2", input: 43.75, cached: 4.375, output: 350 },
  "codex-auto-review": { label: "GPT-5.3-Codex review", input: 43.75, cached: 4.375, output: 350 },
  "codex-mini-latest": { label: "Codex Mini", input: 3.75, cached: 0.375, output: 15 },
};

const CREDIT_TO_USD = 0.04;

function send(res, status, body, contentType = "text/html; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendJson(res, status, body) {
  send(res, status, JSON.stringify(body), "application/json; charset=utf-8");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function safeText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/password\s*[:=]?\s*\S+/gi, "password: [redacted]")
    .replace(/api[_ -]?key\s*[:=]?\s*\S+/gi, "api key: [redacted]");
}

function parseDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return value;
}

function dateRange(start, end) {
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  const days = [];
  for (let d = startDate; d <= endDate; d = new Date(d.getTime() + 86400000)) {
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

function activeDirForDay(day) {
  const [year, month, date] = day.split("-");
  return path.join(ACTIVE_ROOT, year, month, date);
}

function filesForDay(day) {
  const files = [];
  const activeDir = activeDirForDay(day);
  if (fs.existsSync(activeDir)) {
    for (const name of fs.readdirSync(activeDir)) {
      if (name.endsWith(".jsonl") && name.includes(day)) {
        files.push({ kind: "active", filePath: path.join(activeDir, name) });
      }
    }
  }
  if (fs.existsSync(ARCHIVED_ROOT)) {
    for (const name of fs.readdirSync(ARCHIVED_ROOT)) {
      if (name.endsWith(".jsonl") && name.includes(day)) {
        files.push({ kind: "archived", filePath: path.join(ARCHIVED_ROOT, name) });
      }
    }
  }
  return files;
}

function sessionIdFromName(name) {
  const match = name.match(/rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([^.]+)\.jsonl$/);
  return match ? match[1] : "";
}

function dayFromName(name) {
  const match = name.match(/rollout-(\d{4}-\d{2}-\d{2})T/);
  return match ? match[1] : "";
}

function timeFromName(name) {
  const match = name.match(/T(\d{2})-(\d{2})-(\d{2})-/);
  return match ? `${match[1]}:${match[2]}:${match[3]}` : "";
}

function userTextFromEvent(event) {
  if (event.type === "event_msg" && event.payload?.type === "user_message") {
    return safeText(event.payload.message || "");
  }
  if (event.type === "response_item" && event.payload?.role === "user") {
    return safeText(
      (event.payload.content || [])
        .map((part) => part.text || part.input_text || "")
        .filter(Boolean)
        .join(" "),
    );
  }
  return "";
}

function parseJsonl(filePath, kind) {
  const name = path.basename(filePath);
  const lines = fs.readFileSync(filePath, "utf8").split(/\n/).filter(Boolean);
  let meta = null;
  let model = "";
  let firstUser = "";
  let lastUser = "";
  let lastUsage = null;
  let usageEvents = 0;
  let lastTimestamp = "";

  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    lastTimestamp = event.timestamp || lastTimestamp;
    if (event.type === "session_meta") {
      meta = event.payload || {};
      model = meta.model || model;
    }
    if (event.payload?.model) model = event.payload.model;
    const usage = event.payload?.info?.total_token_usage;
    if (usage) {
      lastUsage = usage;
      usageEvents += 1;
    }
    const userText = userTextFromEvent(event);
    if (userText) {
      if (!firstUser) firstUser = userText;
      lastUser = userText;
    }
  }

  const input = Number(lastUsage?.input_tokens || 0);
  const cached = Number(lastUsage?.cached_input_tokens || 0);
  const output = Number(lastUsage?.output_tokens || 0);
  const total = Number(lastUsage?.total_tokens || 0);
  const reasoning = Number(lastUsage?.reasoning_output_tokens || 0);
  const uncached = Math.max(0, input - cached);
  const rate = RATES[model] || RATES["gpt-5.5"];
  const credits = (uncached * rate.input + cached * rate.cached + output * rate.output) / 1_000_000;
  const effectiveModel = model || "gpt-5.5";

  return {
    id: meta?.id || sessionIdFromName(name),
    day: dayFromName(name),
    time: timeFromName(name),
    kind,
    file: filePath,
    fileName: name,
    cwd: meta?.cwd || "",
    model: effectiveModel,
    modelLabel: rate.label,
    title: summarizeTitle(lastUser || firstUser, meta?.cwd || "", model),
    firstUser: firstUser.slice(0, 300),
    lastUser: lastUser.slice(0, 300),
    lines: lines.length,
    usageEvents,
    lastTimestamp,
    input,
    cached,
    uncached,
    output,
    reasoning,
    total,
    credits,
    dollars: credits * CREDIT_TO_USD,
  };
}

function summarizeTitle(text, cwd, model) {
  const value = safeText(text);
  if (/approval assessment/i.test(value) || model === "codex-auto-review") {
    return "Auto-review/background task";
  }
  if (/how many tokens?/i.test(value)) return "Usage check";
  if (/from here, can you see|count also may/i.test(value)) return "Usage audit";
  if (/AGENTS\.md/.test(value)) return path.basename(cwd || "session");
  return value.slice(0, 90) || path.basename(cwd || "session");
}

function getSessions(start, end) {
  return dateRange(start, end)
    .flatMap(filesForDay)
    .map(({ filePath, kind }) => parseJsonl(filePath, kind))
    .sort((a, b) => `${a.day}T${a.time}`.localeCompare(`${b.day}T${b.time}`) || a.kind.localeCompare(b.kind));
}

function findSession(id) {
  if (!/^[a-zA-Z0-9-]+$/.test(id || "")) return null;
  const roots = [ACTIVE_ROOT, ARCHIVED_ROOT].filter(fs.existsSync);
  const stack = [...roots];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(id)) {
        const kind = fullPath.startsWith(ARCHIVED_ROOT) ? "archived" : "active";
        return { kind, filePath: fullPath };
      }
    }
  }
  return null;
}

function totalsFor(rows) {
  const totals = {
    sessions: rows.length,
    modelCount: 0,
    total: 0,
    input: 0,
    cached: 0,
    uncached: 0,
    output: 0,
    reasoning: 0,
    credits: 0,
    dollars: 0,
  };
  const models = new Set();
  for (const row of rows) {
    if (row.model) models.add(row.model);
    for (const key of ["total", "input", "cached", "uncached", "output", "reasoning", "credits", "dollars"]) {
      totals[key] += row[key] || 0;
    }
  }
  totals.modelCount = models.size;
  return totals;
}

function apiSessions(req, res, query) {
  const start = parseDay(query.start);
  const end = parseDay(query.end);
  if (!start || !end || start > end) {
    sendJson(res, 400, { error: "Use valid inclusive start and end dates in YYYY-MM-DD format." });
    return;
  }
  const rows = getSessions(start, end);
  sendJson(res, 200, { rows, totals: totalsFor(rows), rates: RATES, creditToUsd: CREDIT_TO_USD });
}

function apiSession(req, res, id, query = {}) {
  const found = findSession(id);
  if (!found) {
    sendJson(res, 404, { error: `No session found for ID ${id}` });
    return;
  }
  const summary = parseJsonl(found.filePath, found.kind);
  const includeRaw = query.raw === "1";
  const events = fs
    .readFileSync(found.filePath, "utf8")
    .split(/\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        const event = JSON.parse(line);
        return normalizeEvent(event, index + 1, includeRaw);
      } catch (error) {
        return { line: index + 1, type: "parse_error", timestamp: "", label: "Parse error", text: line, raw: includeRaw ? line : null };
      }
    });
  sendJson(res, 200, { summary, events });
}

function normalizeEvent(event, line, includeRaw = false) {
  const payload = event.payload || {};
  const base = {
    line,
    timestamp: event.timestamp || "",
    type: event.type || "",
    raw: includeRaw ? event : null,
    label: event.type || "event",
    text: "",
    role: "",
    conversation: false,
    source: event.type || "",
  };

  if (event.type === "session_meta") {
    base.label = "Session metadata";
    base.text = `${payload.originator || "Codex"} ${payload.model || ""} ${payload.cwd || ""}`.trim();
    return base;
  }
  if (event.type === "event_msg") {
    if (payload.type === "user_message") {
      base.role = "user";
      base.label = "user message";
      base.conversation = true;
      base.source = "event_msg";
    } else if (payload.type === "agent_message" || payload.type === "final_answer") {
      base.role = "assistant";
      base.label = "assistant event_msg";
      base.conversation = true;
      base.source = "event_msg";
    } else {
      base.label = payload.type || "event_msg";
    }
    base.text = safeText(payload.message || JSON.stringify(payload));
    return base;
  }
  if (event.type === "response_item") {
    const itemType = payload.type || "";
    base.role = payload.role || "";
    base.label = payload.role ? `${payload.role} ${itemType}` : itemType || "response_item";
    if ((payload.role === "user" || payload.role === "assistant") && itemType === "message") {
      base.label = payload.role === "assistant" ? "assistant response_item" : "user message";
      base.conversation = true;
      base.source = "response_item";
    }
    if (payload.name) base.label = `${payload.name}()`;
    base.text = summarizePayload(payload);
    return base;
  }
  base.text = summarizePayload(payload);
  return base;
}

function summarizePayload(payload) {
  if (!payload) return "";
  if (payload.message) return safeText(payload.message);
  if (payload.arguments) return safeText(payload.arguments);
  if (payload.output) return safeText(payload.output).slice(0, 8000);
  if (Array.isArray(payload.content)) {
    return safeText(
      payload.content
        .map((part) => part.text || part.input_text || part.output_text || "")
        .filter(Boolean)
        .join("\n\n"),
    );
  }
  if (payload.info?.total_token_usage) {
    return `Usage: ${JSON.stringify(payload.info.total_token_usage)}`;
  }
  return safeText(JSON.stringify(payload)).slice(0, 8000);
}

function pageShell(body, script = "") {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Codex Usage Viewer</title>
  <style>${CSS}</style>
</head>
<body>
${body}
<script>${script}</script>
</body>
</html>`;
}

function indexPage() {
  const today = new Date().toISOString().slice(0, 10);
  return pageShell(`
<main class="app">
  <header class="topbar">
    <div>
      <h1>Codex Usage Viewer</h1>
      <p>Local-only usage summaries from <code>${escapeHtml(CODEX_HOME)}</code></p>
    </div>
    <a class="ghost" href="/session/lookup">Open by ID</a>
  </header>

  <section class="controls" aria-label="Date range">
    <label>Start date <input id="start" type="date" value="${today}" /></label>
    <label>End date <input id="end" type="date" value="${today}" /></label>
    <button id="load">Load sessions</button>
  </section>

  <section class="summary" id="summary"></section>
  <section class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Date</th><th>Time</th><th>Session</th><th>Identify</th>
          <th>Model</th>
          <th class="num"><button class="sort-button" data-sort="total">Tokens <span data-sort-icon="total"></span></button></th>
          <th class="num"><button class="sort-button" data-sort="credits">Credits <span data-sort-icon="credits"></span></button></th>
          <th class="num"><button class="sort-button" data-sort="dollars">Est. $ <span data-sort-icon="dollars"></span></button></th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
  </section>
</main>`, INDEX_JS);
}

function sessionPage(id) {
  return pageShell(`
<main class="app log-app">
  <header class="topbar">
    <div>
      <h1>Session Log</h1>
      <p><code>${escapeHtml(id)}</code></p>
    </div>
    <a class="ghost" href="/">Back to table</a>
  </header>
  <section id="sessionSummary" class="summary"></section>
  <p id="rateCardNote" class="rate-card-note"></p>
  <section class="log-tools">
    <input id="filter" type="search" placeholder="Filter visible log text..." />
    <div class="toggle-group">
      <span class="toggle-group-label">Content</span>
      <label class="toggle-chip"><input id="assistantToggle" type="checkbox" /> <span>Show assistant</span></label>
      <label class="toggle-chip"><input id="assistantEventToggle" type="checkbox" /> <span>Assistant event_msg</span></label>
    </div>
    <div class="toggle-group">
      <span class="toggle-group-label">Display</span>
      <label class="toggle-chip"><input id="expandAllToggle" type="checkbox" /> <span>Expand all</span></label>
      <label class="toggle-chip"><input id="rawToggle" type="checkbox" /> <span>Raw JSON</span></label>
    </div>
  </section>
  <section id="loadingState" class="loading-state">Loading session log...</section>
  <section id="events" class="events"></section>
</main>`, SESSION_JS.replaceAll("__SESSION_ID__", JSON.stringify(id)));
}

function lookupPage() {
  return pageShell(`
<main class="app narrow">
  <header class="topbar">
    <div>
      <h1>Open Session by ID</h1>
      <p>Paste a full or partial session ID.</p>
    </div>
    <a class="ghost" href="/">Back</a>
  </header>
  <section class="controls">
    <label>Session ID <input id="sessionId" placeholder="019e5a49-93f3-..." /></label>
    <button id="open">Open log</button>
  </section>
</main>`, `
document.getElementById("open").addEventListener("click", () => {
  const id = document.getElementById("sessionId").value.trim();
  if (id) location.href = "/session/" + encodeURIComponent(id);
});
document.getElementById("sessionId").addEventListener("keydown", (event) => {
  if (event.key === "Enter") document.getElementById("open").click();
});
`);
}

const CSS = `
:root {
  color-scheme: light;
  --bg: #f6f7f9;
  --surface: #ffffff;
  --surface-2: #eef2f7;
  --text: #17202a;
  --muted: #607083;
  --line: #d8dee8;
  --accent: #1167b1;
  --accent-2: #0b4f88;
  --good: #0f766e;
  --warn: #b45309;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .92em; }
.app { width: min(1440px, calc(100vw - 40px)); margin: 0 auto; padding: 28px 0 56px; }
.narrow { width: min(780px, calc(100vw - 40px)); }
.topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 22px; }
h1 { margin: 0; font-size: 30px; line-height: 1.15; letter-spacing: 0; }
p { margin: 8px 0 0; color: var(--muted); }
.ghost, button {
  appearance: none; border: 1px solid var(--line); background: var(--surface); color: var(--text);
  min-height: 38px; border-radius: 8px; padding: 0 14px; display: inline-flex; align-items: center;
  text-decoration: none; font-weight: 650; cursor: pointer;
}
button { background: var(--accent); border-color: var(--accent); color: white; }
button:hover { background: var(--accent-2); }
.ghost:hover { border-color: #a9b7c8; }
.controls, .log-tools {
  display: flex; align-items: end; gap: 14px; flex-wrap: wrap; background: var(--surface);
  border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin-bottom: 16px;
}
.log-tools { align-items: stretch; }
label { display: grid; gap: 6px; color: var(--muted); font-size: 13px; font-weight: 650; }
input {
  min-height: 38px; min-width: 190px; border: 1px solid var(--line); border-radius: 8px;
  padding: 0 10px; font: inherit; color: var(--text); background: white;
}
input[type="search"] { width: min(640px, 100%); }
.toggle-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fbfcfe;
}
.toggle-group-label {
  font-size: 12px;
  font-weight: 750;
  text-transform: uppercase;
  letter-spacing: .04em;
  color: var(--muted);
}
.toggle-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 0 10px 0 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: white;
  color: var(--text);
  font-size: 13px;
  font-weight: 650;
  cursor: pointer;
  user-select: none;
}
.toggle-chip input {
  min-width: 16px;
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--accent);
}
.toggle-chip:hover { border-color: #bfd0e4; background: #f7fbff; }
.toggle-chip:has(input:checked) {
  border-color: #9dc2e6;
  background: #edf6ff;
  color: var(--accent-2);
}
.summary { display: grid; grid-template-columns: repeat(6, minmax(130px, 1fr)); gap: 10px; margin-bottom: 16px; }
.rate-card-note {
  margin: -4px 0 16px;
  color: var(--muted);
  font-size: 13px;
}
.rate-card-note a { color: var(--accent); text-decoration: none; }
.rate-card-note a:hover { text-decoration: underline; }
.metric { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 12px; min-height: 76px; }
.metric .label { color: var(--muted); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
.metric .value { margin-top: 8px; font-size: 20px; font-weight: 750; white-space: nowrap; }
.table-wrap { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; overflow: auto; }
table { width: 100%; border-collapse: collapse; min-width: 1120px; }
th, td { border-bottom: 1px solid var(--line); padding: 10px 12px; text-align: left; vertical-align: top; font-size: 14px; }
th { position: sticky; top: 0; background: var(--surface-2); color: #334155; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; z-index: 1; }
tr:hover td { background: #f9fbfd; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.sort-button {
  min-height: 26px; padding: 0; border: 0; background: transparent; color: inherit; font: inherit;
  letter-spacing: inherit; text-transform: inherit; display: inline-flex; justify-content: flex-end;
  gap: 4px; width: 100%; cursor: pointer;
}
.sort-button:hover { color: var(--accent); background: transparent; }
.pill { display: inline-flex; align-items: center; min-height: 24px; padding: 0 8px; border-radius: 999px; background: var(--surface-2); font-size: 12px; font-weight: 700; color: #475569; }
.session-link { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-weight: 750; color: var(--accent); text-decoration: none; }
.session-link:hover { text-decoration: underline; }
.group-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 0;
  background: transparent;
  color: var(--accent);
  font: inherit;
  font-weight: 750;
  padding: 0;
}
.group-toggle:hover { background: transparent; color: var(--accent-2); }
.group-toggle-arrow { display: inline-block; width: 12px; text-align: center; color: var(--muted); }
.row-group td { background: #f8fbff; font-weight: 650; }
.row-child td { background: #fcfdff; }
.row-child td:first-child { padding-left: 24px; }
.events { display: grid; gap: 10px; }
.loading-state {
  display: none;
  align-items: center;
  justify-content: center;
  min-height: 120px;
  margin-bottom: 16px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  color: var(--muted);
  font-size: 14px;
  font-weight: 650;
}
.loading .loading-state { display: flex; }
.loading .events { display: none; }
.event { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.event-head { display: flex; justify-content: space-between; gap: 12px; padding: 10px 12px; background: #f8fafc; border-bottom: 1px solid var(--line); }
.event-title { display: flex; gap: 8px; align-items: center; min-width: 0; }
.event-title strong { overflow-wrap: anywhere; }
.event-meta { color: var(--muted); font-size: 12px; white-space: nowrap; }
.event-text { padding: 12px; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.45; }
.expand-message {
  margin: 0 12px 12px; min-height: 30px; border-color: #c8d4e3; color: var(--accent);
  background: white; font-size: 13px;
}
.expand-message:hover { background: #f3f8ff; color: var(--accent-2); }
.raw { display: none; margin: 0; padding: 12px; background: #101827; color: #e5edf7; overflow: auto; font-size: 12px; line-height: 1.45; }
.show-raw .raw { display: block; }
.show-raw .event-text { border-bottom: 1px solid var(--line); }
.muted { color: var(--muted); }
@media (max-width: 900px) {
  .app { width: min(100vw - 24px, 1440px); padding-top: 18px; }
  .topbar { display: grid; }
  .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
`;

const INDEX_JS = `
const fmt = new Intl.NumberFormat("en-US");
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const params = new URLSearchParams(location.search);
if (params.get("start")) document.getElementById("start").value = params.get("start");
if (params.get("end")) document.getElementById("end").value = params.get("end");
let allRows = [];
let sortState = { key: "total", direction: "desc" };
const expandedGroups = new Set();
const AUTO_REVIEW_TITLE = "Auto-review/background task";

function metric(label, value) {
  return '<div class="metric"><div class="label">' + label + '</div><div class="value">' + value + '</div></div>';
}

function renderSummary(t) {
  document.getElementById("summary").innerHTML = [
    metric("Sessions", fmt.format(t.sessions)),
    metric("Models", fmt.format(t.modelCount || 0)),
    metric("Tokens", fmt.format(t.total)),
    metric("Uncached input", fmt.format(t.uncached)),
    metric("Cached input", fmt.format(t.cached)),
    metric("Credits", fmt.format(Math.round(t.credits * 100) / 100)),
    metric("Estimated dollars", money.format(t.dollars)),
  ].join("");
}

function rowSortValue(row) {
  return Number(row[sortState.key] || 0);
}

function compareRows(a, b) {
  const diff = rowSortValue(b) - rowSortValue(a);
  if (diff !== 0) return sortState.direction === "desc" ? diff : -diff;
  return (String(a.day) + "T" + String(a.time)).localeCompare(String(b.day) + "T" + String(b.time)) || String(a.id).localeCompare(String(b.id));
}

function isAutoReviewRow(row) {
  return (row.title || "") === AUTO_REVIEW_TITLE;
}

function aggregateAutoReviewRows(rows) {
  const first = rows[0] || {};
  const last = rows[rows.length - 1] || {};
  const allModels = new Set(rows.map((row) => row.model).filter(Boolean));
  const dayLabel = first.day === last.day
    ? first.day
    : String(first.day) + " → " + String(last.day);
  return {
    type: "group",
    key: AUTO_REVIEW_TITLE,
    title: AUTO_REVIEW_TITLE,
    day: dayLabel,
    time: String(rows.length) + " sessions",
    sessionCount: rows.length,
    model: allModels.size === 1 ? rows[0].model : "mixed",
    total: rows.reduce((sum, row) => sum + Number(row.total || 0), 0),
    credits: rows.reduce((sum, row) => sum + Number(row.credits || 0), 0),
    dollars: rows.reduce((sum, row) => sum + Number(row.dollars || 0), 0),
    children: rows,
    cwd: rows[0]?.cwd || "",
    id: "group:" + AUTO_REVIEW_TITLE,
  };
}

function visibleTableItems() {
  const rows = [...allRows].sort(compareRows);
  const autoRows = rows.filter(isAutoReviewRow);
  const regularRows = rows.filter((row) => !isAutoReviewRow(row));
  const topLevel = regularRows.map((row) => ({ type: "row", row }));
  if (!autoRows.length) return topLevel;
  const group = aggregateAutoReviewRows(autoRows);
  topLevel.push({ type: "group", row: group });
  const sortedTopLevel = topLevel.sort((a, b) => compareRows(a.row, b.row));
  const output = [];
  for (const item of sortedTopLevel) {
    output.push(item);
    if (item.type === "group" && expandedGroups.has(item.row.key)) {
      output.push(...autoRows.map((row) => ({ type: "child", row, parent: item.row.key })));
    }
  }
  return output;
}

function renderSortIndicators() {
  document.querySelectorAll("[data-sort-icon]").forEach((icon) => {
    const key = icon.getAttribute("data-sort-icon");
    icon.textContent = key === sortState.key ? (sortState.direction === "desc" ? "↓" : "↑") : "";
  });
}

function renderRows() {
  renderSortIndicators();
  document.getElementById("rows").innerHTML = visibleTableItems().map((item) => renderTableRow(item)).join("");
}

function renderTableRow(item) {
  const row = item.row;
  const title = row.title || row.lastUser || row.firstUser || row.fileName;
  const modelText = row.model || "";
  const isGroup = item.type === "group";
  const isChild = item.type === "child";
  const sessionCell = isGroup
    ? '<button class="group-toggle" data-group-toggle="' + escapeHtml(row.key) + '" aria-expanded="' + (expandedGroups.has(row.key) ? "true" : "false") + '">' +
      '<span class="group-toggle-arrow">' + (expandedGroups.has(row.key) ? "▾" : "▸") + '</span>' +
      '<span>' + fmt.format(row.sessionCount) + ' sessions</span></button>'
    : '<a class="session-link" target="_blank" href="/session/' + encodeURIComponent(row.id) + '">' + row.id.slice(0, 8) + '</a>';
  const extraClass = isGroup ? " row-group" : isChild ? " row-child" : "";
  const identifyHtml = isGroup
    ? '<span>' + escapeHtml(title) + '</span><div class="muted">grouped</div>'
    : escapeHtml(title);
  return '<tr class="' + extraClass.trim() + '">' +
    '<td>' + escapeHtml(row.day) + '</td>' +
    '<td>' + escapeHtml(row.time) + '</td>' +
    '<td>' + sessionCell + '</td>' +
    '<td>' + identifyHtml + '<div class="muted">' + escapeHtml(row.cwd || "") + '</div></td>' +
    '<td>' + escapeHtml(modelText) + '<div class="muted">' + escapeHtml(row.model || "") + '</div></td>' +
    '<td class="num">' + fmt.format(row.total) + '</td>' +
    '<td class="num">' + fmt.format(Math.round(row.credits * 100) / 100) + '</td>' +
    '<td class="num">' + money.format(row.dollars) + '</td>' +
    '</tr>';
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[ch]));
}

async function loadSessions() {
  const start = document.getElementById("start").value;
  const end = document.getElementById("end").value;
  history.replaceState(null, "", "/?start=" + encodeURIComponent(start) + "&end=" + encodeURIComponent(end));
  const response = await fetch("/api/sessions?start=" + encodeURIComponent(start) + "&end=" + encodeURIComponent(end));
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Failed to load sessions");
  renderSummary(data.totals);
  allRows = data.rows;
  renderRows();
}
document.getElementById("load").addEventListener("click", () => loadSessions().catch((error) => alert(error.message)));
document.querySelectorAll("[data-sort]").forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.getAttribute("data-sort");
    if (sortState.key === key) {
      sortState.direction = sortState.direction === "desc" ? "asc" : "desc";
    } else {
      sortState = { key, direction: "desc" };
    }
    renderRows();
  });
});
document.getElementById("rows").addEventListener("click", (event) => {
  const button = event.target.closest("[data-group-toggle]");
  if (!button) return;
  const key = button.getAttribute("data-group-toggle");
  if (expandedGroups.has(key)) expandedGroups.delete(key);
  else expandedGroups.add(key);
  renderRows();
});
loadSessions().catch((error) => {
  document.getElementById("summary").innerHTML = '<div class="metric"><div class="label">Error</div><div class="value">' + escapeHtml(error.message) + '</div></div>';
});
`;

const SESSION_JS = `
const sessionId = __SESSION_ID__;
const fmt = new Intl.NumberFormat("en-US");
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
let allEvents = [];
const expandedLines = new Set();
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[ch]));
}
function metric(label, value) {
  return '<div class="metric"><div class="label">' + label + '</div><div class="value">' + value + '</div></div>';
}
function renderSessionSummary(s) {
  document.getElementById("sessionSummary").innerHTML = [
    metric("Date/time", s.day + " " + s.time),
    metric("Model", escapeHtml(s.model || "unknown")),
    metric("Tokens", fmt.format(s.total)),
    metric("Credits", fmt.format(Math.round(s.credits * 100) / 100)),
    metric("Est. dollars", money.format(s.dollars)),
    metric("Events", fmt.format(s.lines)),
  ].join("");
  document.getElementById("rateCardNote").innerHTML = 'Pricing basis: <a href="https://help.openai.com/en/articles/20001106-codex-rate-card" target="_blank" rel="noreferrer">Codex rate card</a> as of May 24, 2026.';
}
function firstWords(text, limit) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  return {
    text: words.slice(0, limit).join(" "),
    truncated: words.length > limit,
  };
}
function setLoading(isLoading) {
  document.body.classList.toggle("loading", isLoading);
}
function renderEvents() {
  const filter = document.getElementById("filter").value.toLowerCase();
  const showRaw = document.getElementById("rawToggle").checked;
  const showAssistant = document.getElementById("assistantToggle").checked;
  const showAssistantEvents = document.getElementById("assistantEventToggle").checked;
  const expandAll = document.getElementById("expandAllToggle").checked;
  document.getElementById("events").classList.toggle("show-raw", showRaw);
  const rows = allEvents.filter((event) => {
    if (!showRaw && !event.conversation) return false;
    if (!showRaw && event.role === "assistant" && !showAssistant) return false;
    if (!showRaw && event.role === "assistant" && event.source === "event_msg" && !showAssistantEvents) return false;
    const haystack = [event.type, event.label, event.text, event.timestamp].join(" ").toLowerCase();
    return !filter || haystack.includes(filter);
  });
  document.getElementById("events").innerHTML = rows.map((event) => {
    const text = event.text || "(no display text)";
    const preview = firstWords(text, 100);
    const expanded = showRaw || expandAll || expandedLines.has(event.line) || !preview.truncated;
    const visibleText = expanded ? text : preview.text + " ...";
    const expandButton = !showRaw && !expandAll && preview.truncated
      ? '<button class="expand-message" data-expand-line="' + event.line + '">' + (expandedLines.has(event.line) ? "Collapse" : "Show full message") + '</button>'
      : "";
    return '<article class="event">' +
      '<div class="event-head"><div class="event-title"><span class="pill">' + escapeHtml(event.type || "event") + '</span><strong>' + escapeHtml(event.label) + '</strong></div>' +
      '<div class="event-meta">line ' + event.line + ' · ' + escapeHtml(event.timestamp) + '</div></div>' +
      '<div class="event-text">' + escapeHtml(visibleText) + '</div>' +
      expandButton +
      '<pre class="raw">' + escapeHtml(event.raw ? JSON.stringify(event.raw, null, 2) : "Raw JSON not loaded yet.") + '</pre>' +
      '</article>';
  }).join("");
}
async function loadSession() {
  setLoading(true);
  const includeRaw = document.getElementById("rawToggle").checked;
  const response = await fetch("/api/session/" + encodeURIComponent(sessionId) + (includeRaw ? "?raw=1" : ""));
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Failed to load session");
  renderSessionSummary(data.summary);
  allEvents = data.events;
  renderEvents();
  setLoading(false);
}
document.getElementById("filter").addEventListener("input", renderEvents);
document.getElementById("assistantToggle").addEventListener("change", renderEvents);
document.getElementById("assistantEventToggle").addEventListener("change", renderEvents);
document.getElementById("expandAllToggle").addEventListener("change", renderEvents);
document.getElementById("rawToggle").addEventListener("change", () => loadSession().catch((error) => alert(error.message)));
document.getElementById("events").addEventListener("click", (event) => {
  const button = event.target.closest("[data-expand-line]");
  if (!button) return;
  const line = Number(button.getAttribute("data-expand-line"));
  if (expandedLines.has(line)) expandedLines.delete(line);
  else expandedLines.add(line);
  renderEvents();
});
loadSession().catch((error) => {
  setLoading(false);
  document.getElementById("sessionSummary").innerHTML = '<div class="metric"><div class="label">Error</div><div class="value">' + escapeHtml(error.message) + '</div></div>';
});
`;

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname || "/");

  try {
    if (pathname === "/") return send(res, 200, indexPage());
    if (pathname === "/session/lookup") return send(res, 200, lookupPage());
    if (pathname.startsWith("/session/")) {
      return send(res, 200, sessionPage(pathname.replace(/^\/session\//, "")));
    }
    if (pathname === "/api/sessions") return apiSessions(req, res, parsed.query);
    if (pathname.startsWith("/api/session/")) {
      return apiSession(req, res, pathname.replace(/^\/api\/session\//, ""), parsed.query);
    }
    send(res, 404, "Not found", "text/plain; charset=utf-8");
  } catch (error) {
    sendJson(res, 500, { error: error.message, stack: error.stack });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Codex Usage Viewer running at http://127.0.0.1:${PORT}`);
  console.log(`Reading active sessions from ${ACTIVE_ROOT}`);
  console.log(`Reading archived sessions from ${ARCHIVED_ROOT}`);
});
