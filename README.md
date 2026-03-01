# music-intent-mcp

MCP server built with `mcp-use` that:
- Connects to **music** (young-surf-xt5j8), **YouTube** (still-thunder-8btdl), **message** (summer-poetry-bwin6)
- Exposes `remote__*` (music), `yt__*` (YouTube), `chat__*` (message)
- Routes play requests via `play-song` and `route-command`

## Run

```powershell
cd C:\Users\rashm\Desktop\y\music-intent-mcp
npm install
npm run dev
```

Local MCP URL:
- `http://localhost:3002/mcp`

## Config: `mcp-servers.json`

Add or edit MCP servers in `mcp-servers.json` — no code changes needed:

```json
{
  "mcpServers": {
    "music": { "url": "https://.../mcp", "prefix": "remote__", "playWidget": "music-player" },
    "youtube": { "url": "https://.../mcp", "prefix": "yt__", "playWidget": "youtube-player" },
    "message": { "url": "https://.../mcp", "prefix": "chat__" }
  }
}
```

- `url`: deployed MCP endpoint
- `prefix`: tool name prefix (e.g. `remote__`, `yt__`, `chat__`)
- `playWidget`: optional; widget name. Orch proxies it, registers the resource, and adds the widget to **all tools** from that server — new tools the MCP adds are picked up automatically.

## Config: Google Sheet (alternative)

Set `MCP_SERVERS_SHEET` to your sheet URL to load MCPs from a Google Sheet instead of JSON. Edit the sheet to add MCPs — no redeploy needed (orch fetches on startup).

**Sheet format** (first row = headers):

| name   | url                                      | prefix   | playWidget     | icon |
|--------|------------------------------------------|----------|----------------|------|
| music  | https://young-surf-xt5j8.run.mcp-use.com/mcp | remote__ | music-player   | 🎵   |
| youtube| https://still-thunder-8btdl.run.mcp-use.com/mcp | yt__     | youtube-player | ▶️   |
| message| https://summer-poetry-bwin6.run.mcp-use.com/mcp | chat__   |                | 💬   |

**Required:** Share the sheet as "Anyone with the link can view" so orch can fetch the CSV export. When `MCP_SERVERS_SHEET` is set, the sheet is the **only** source of truth — no fallback to `mcp-servers.json`.

**Webhook (no redeploy):** Add a Google Apps Script trigger so orch reloads when you edit the sheet:

1. In your sheet: **Extensions → Apps Script**
2. Paste this (replace `ORCH_URL` and `SECRET` if using one):
```javascript
function onEdit() {
  const ORCH_URL = "https://young-voice-nqjrg.run.mcp-use.com";
  const SECRET = ""; // optional: set RELOAD_SECRET in orch env
  const url = ORCH_URL + "/api/reload" + (SECRET ? "?secret=" + encodeURIComponent(SECRET) : "");
  UrlFetchApp.fetch(url, { method: "post", muteHttpExceptions: true });
}
```
3. **Triggers** (clock icon) → Add trigger → `onEdit` → From spreadsheet → On edit
4. Set `RELOAD_SECRET` env in orch if you use a secret. When you edit the sheet, the script calls the webhook → orch exits → platform restarts it → fresh config.

## Env vars

- `MCP_SERVERS_FILE` (optional): path to config JSON (default: `./mcp-servers.json`)
- `MCP_SERVERS_SHEET` (optional): Google Sheet URL — use sheet instead of JSON
- `PORT` (optional): local port (default `3002`)

## Tools

- `list-remote-tools` — list music + message tools
- `play-song` (natural language, e.g. `"play song believer"`)
- `route-command` (auto-routes play/music intents)
- `remote__*` — music tools (play, search, etc.)
- `yt__*` — YouTube tools (search, play videos inline)
- `chat__*` — message tools (register, send, read inbox, etc.)
