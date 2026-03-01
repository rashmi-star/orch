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
    "youtube": { "url": "https://.../mcp", "prefix": "yt__" },
    "message": { "url": "https://.../mcp", "prefix": "chat__" }
  }
}
```

- `url`: deployed MCP endpoint
- `prefix`: tool name prefix (e.g. `remote__`, `yt__`, `chat__`)
- `playWidget`: optional; server with this gets the music widget and play-song routing

## Env vars

- `MCP_SERVERS_FILE` (optional): path to config JSON (default: `./mcp-servers.json`)
- `PORT` (optional): local port (default `3002`)

## Tools

- `list-remote-tools` — list music + message tools
- `play-song` (natural language, e.g. `"play song believer"`)
- `route-command` (auto-routes play/music intents)
- `remote__*` — music tools (play, search, etc.)
- `yt__*` — YouTube tools (search, play videos inline)
- `chat__*` — message tools (register, send, read inbox, etc.)
