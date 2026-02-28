# music-intent-mcp

MCP server built with `mcp-use` that:
- Connects to a remote MCP (`https://young-surf-xt5j8.run.mcp-use.com/mcp` by default)
- Exposes all remote tools as local tools named `remote__{toolName}`
- Adds intent routing for play requests via `play-song` and `route-command`

## Run

```powershell
cd C:\Users\rashm\Desktop\y\music-intent-mcp
npm install
npm run dev
```

Local MCP URL:
- `http://localhost:3002/mcp`

## Env vars

- `TARGET_MCP_URL` (optional): remote MCP URL
- `TARGET_SERVER_NAME` (optional): internal alias for remote server
- `PORT` (optional): local port (default `3002`)
- `MCP_URL` (required for deploy): **Must match your deployed URL exactly** (e.g. `https://young-voice-ngjrg.run.mcp-use.com`). Mismatch causes widget stream to fail (shows PREVIEW instead of Full Track). After deploy, visit `https://your-orch-url/config` to verify.

## Tools

- `list-remote-tools`
- `play-song` (natural language, e.g. `"play song believer"`)
- `route-command` (auto-routes play/music intents)
- `remote__*` passthrough tools dynamically registered from remote MCP
