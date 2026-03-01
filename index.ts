import { MCPServer, error, object, text } from "mcp-use/server";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { MCPClient } from "mcp-use";
import { z } from "zod";
import { readFileSync } from "fs";
import { join } from "path";

// Load MCP servers from config file - add new URLs here, no code changes needed
const CONFIG_PATH = process.env.MCP_SERVERS_FILE || join(process.cwd(), "mcp-servers.json");

interface ServerConfig {
  url: string;
  prefix: string;
  playWidget?: string; // if set, all tools from this server get the widget (auto-reflects when MCP adds tools)
  icon?: string;
}

const DEFAULT_ICONS: Record<string, string> = {
  music: "🎵",
  youtube: "▶️",
  message: "💬",
};

type McpServersConfig = Record<string, ServerConfig>;

function loadMcpConfig(): { mcpServers: McpServersConfig } {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as { mcpServers?: McpServersConfig };
    if (!parsed.mcpServers || typeof parsed.mcpServers !== "object") {
      throw new Error("mcpServers must be an object");
    }
    return { mcpServers: parsed.mcpServers };
  } catch (err: any) {
    console.warn(`Could not load ${CONFIG_PATH}, using defaults: ${err.message}`);
    return {
      mcpServers: {
        music: {
          url: "https://young-surf-xt5j8.run.mcp-use.com/mcp",
          prefix: "remote__",
          playWidget: "music-player",
        },
        youtube: { url: "https://still-thunder-8btdl.run.mcp-use.com/mcp", prefix: "yt__" },
        message: { url: "https://summer-poetry-bwin6.run.mcp-use.com/mcp", prefix: "chat__" },
      },
    };
  }
}

const { mcpServers } = loadMcpConfig();
const SERVER_NAMES = Object.keys(mcpServers);

// Map: widget name -> MCP base URL (for proxy routing)
const WIDGET_TO_BASE: Record<string, string> = {};
for (const [name, cfg] of Object.entries(mcpServers)) {
  if (cfg.playWidget) {
    WIDGET_TO_BASE[cfg.playWidget] = cfg.url.replace(/\/mcp\/?$/, "");
  }
}

const MUSIC_SERVER = SERVER_NAMES.find((k) => mcpServers[k].playWidget === "music-player") || SERVER_NAMES[0];
const TARGET_MCP_URL = mcpServers[MUSIC_SERVER]?.url || "https://young-surf-xt5j8.run.mcp-use.com/mcp";
const TARGET_MCP_BASE = TARGET_MCP_URL.replace(/\/mcp\/?$/, "");

function getProxyBaseForPath(path: string): string {
  for (const [widgetName, base] of Object.entries(WIDGET_TO_BASE)) {
    if (path.includes(widgetName)) return base;
  }
  return TARGET_MCP_BASE;
}

type RemoteTool = {
  name: string;
  description?: string;
  inputSchema?: any;
};

const ORCH_BASE = process.env.MCP_URL || "http://localhost:3002";
const server = new MCPServer({
  name: "music-intent-mcp",
  title: "Music Intent MCP",
  version: "1.0.0",
  description:
    "Orchestrates music, YouTube, and message MCPs. Routes play to music, exposes yt__ and chat__ tools.",
  baseUrl: ORCH_BASE,
  host: "0.0.0.0",
});

// Proxy widget resources from remote MCP so client can load them (CSP/same-origin)
async function proxyToRemote(c: any, path: string, rewriteHtml = false) {
  const proxyBase = getProxyBaseForPath(path);
  const targetUrl = `${proxyBase}${path}`;
  const host = c.req.header("host");
  const proto =
    c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() ||
    (ORCH_BASE.startsWith("https") ? "https" : "http");
  const base = host ? `${proto}://${host}` : ORCH_BASE;
  try {
    const res = await fetch(targetUrl);
    const headers = new Headers(res.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    let body: BodyInit = res.body ?? new Blob();
    if (rewriteHtml && res.ok) {
      const ct = res.headers.get("content-type") || "";
      const isHtml = ct.includes("text/html");
      const isJs = ct.includes("javascript") || /\.(m?js|tsx?)(\?|$)/.test(path);
      const text = await res.text();
      const targetEsc = proxyBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const orchWidgetPath = `${base}/widget-proxy/mcp-use/widgets`;
      let rewritten = text;
      if (isHtml) {
        const baseScript = `<script>window.__WIDGET_BASE_URL__="${base.replace(/\/$/, "")}";</script>`;
        rewritten = rewritten
          .replace(/<head\b[^>]*>/, (m) => m + baseScript)
          .replace(/<html\b[^>]*>/, (m) => (text.includes("<head") ? m : m + baseScript));
      }
      rewritten = rewritten
        .replace(new RegExp(targetEsc + "/mcp-use/widgets/", "g"), `${orchWidgetPath}/`)
        .replace(new RegExp(targetEsc + "/mcp-use/public", "g"), `${base}/widget-proxy/mcp-use/public`)
        .replace(/<base href="[^"]*"\s*\/>/, `<base href="${base}" />`)
        .replace(/(src|href)=["']\/mcp-use\/widgets\/([^"']*)["']/g, '$1="/widget-proxy/mcp-use/widgets/$2"');
      if (isHtml || isJs) {
        rewritten = rewritten.replace(/window\.location\.origin/g, "(window.__WIDGET_BASE_URL__||window.location.origin)");
      }
      body = rewritten;
    }
    return new Response(body, { status: res.status, headers });
  } catch (err: any) {
    return c.text(`Proxy error: ${err.message}`, 502);
  }
}
server.app.get("/widget-proxy/*", (c) =>
  proxyToRemote(c, c.req.path.replace(/^\/widget-proxy/, ""), true)
);
server.app.get("/resources/widgets/*", (c) => proxyToRemote(c, c.req.path));
server.app.get("/mcp-use/widgets/*", (c) => proxyToRemote(c, c.req.path));
server.app.get("/stream/*", (c) => proxyToRemote(c, c.req.path));

// Debug: verify MCP_URL matches your deployed URL (e.g. https://young-voice-ngjrg.run.mcp-use.com)
server.app.get("/config", (c) => {
  const host = c.req.header("host");
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
  const requestBase = host ? `${proto}://${host}` : null;
  return c.json({
    MCP_URL: ORCH_BASE,
    requestHost: requestBase,
    match: requestBase ? ORCH_BASE === requestBase : "unknown",
    note: "Set MCP_URL env to your deployed URL if they don't match. Mismatch causes stream/preview to fail.",
  });
});

// Orch dashboard: MCP icons; click copies @server for next message
server.app.get("/", (c) => {
  const host = c.req.header("host");
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
  const base = host ? `${proto}://${host}` : ORCH_BASE;
  const mcps = Object.entries(mcpServers).map(([name, cfg]) => ({
    name,
    icon: cfg.icon ?? DEFAULT_ICONS[name] ?? "🔗",
    prefix: cfg.prefix,
    atTag: `@${name}`,
  }));
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Orch – MCP Hub</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; background: #0f0f12; color: #e4e4e7; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 1.5rem; }
    h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 0.5rem; }
    .sub { color: #71717a; font-size: 0.9rem; margin-bottom: 2rem; }
    .grid { display: flex; flex-wrap: wrap; gap: 1rem; justify-content: center; }
    .mcp { background: #18181b; border: 1px solid #27272a; border-radius: 12px; padding: 1.25rem 1.5rem; cursor: pointer; transition: all 0.15s; display: flex; align-items: center; gap: 0.75rem; min-width: 140px; }
    .mcp:hover { border-color: #3f3f46; background: #27272a; transform: translateY(-2px); }
    .mcp:active { transform: translateY(0); }
    .mcp-icon { font-size: 1.75rem; }
    .mcp-name { font-weight: 500; text-transform: capitalize; }
    .mcp-tag { font-size: 0.75rem; color: #71717a; margin-top: 0.25rem; }
    .toast { position: fixed; bottom: 1.5rem; left: 50%; transform: translateX(-50%); background: #27272a; padding: 0.5rem 1rem; border-radius: 8px; font-size: 0.9rem; opacity: 0; transition: opacity 0.2s; pointer-events: none; }
    .toast.show { opacity: 1; }
  </style>
</head>
<body>
  <h1>Orch</h1>
  <p class="sub">Click an MCP to copy its @tag for your next message</p>
  <div class="grid">
    ${mcps
      .map(
        (m) => `
    <button class="mcp" data-tag="${m.atTag}" title="Copy ${m.atTag}">
      <span class="mcp-icon">${m.icon}</span>
      <div>
        <div class="mcp-name">${m.name}</div>
        <div class="mcp-tag">${m.atTag}</div>
      </div>
    </button>`
      )
      .join("")}
  </div>
  <div class="toast" id="toast">Copied!</div>
  <script>
    document.querySelectorAll('.mcp').forEach(btn => {
      btn.addEventListener('click', async () => {
        const tag = btn.dataset.tag + ' ';
        try {
          await navigator.clipboard.writeText(tag);
          const t = document.getElementById('toast');
          t.textContent = 'Copied ' + tag.trim() + ' – paste in your next message';
          t.classList.add('show');
          setTimeout(() => t.classList.remove('show'), 2000);
        } catch (e) {
          prompt('Copy this for your next message:', tag);
        }
      });
    });
  </script>
</body>
</html>`;
  return c.html(html);
});

// Register widget resources for each server with playWidget (config-driven, no code change for new MCPs)
for (const [serverName, cfg] of Object.entries(mcpServers)) {
  const widgetName = cfg.playWidget;
  if (!widgetName) continue;

  const widgetBase = cfg.url.replace(/\/mcp\/?$/, "");
  server.resource(
    {
      name: `${widgetName}-widget`,
      uri: `ui://widget/${widgetName}.html`,
      description: `${widgetName} widget (proxied from ${serverName} MCP)`,
      mimeType: RESOURCE_MIME_TYPE,
    },
    async () => {
      const res = await fetch(`${widgetBase}/mcp-use/widgets/${widgetName}`);
      if (!res.ok) {
        return { contents: [{ uri: `ui://widget/${widgetName}.html`, mimeType: "text/plain", text: "Widget unavailable" }] };
      }
      const html = await res.text();
      const base = widgetBase.replace(/\/$/, "");
      const baseScript = `<script>window.__WIDGET_BASE_URL__="${base}";</script>`;
      const rewritten = html
        .replace(/<head\b[^>]*>/, (m) => m + baseScript)
        .replace(/<html\b[^>]*>/, (m) => (html.includes("<head") ? m : m + baseScript))
        .replace(/<base href="[^"]*"\s*\/>/, `<base href="${base}/" />`)
        .replace(/window\.location\.origin/g, "(window.__WIDGET_BASE_URL__||window.location.origin)");
      return {
        contents: [
          {
            uri: `ui://widget/${widgetName}.html`,
            mimeType: RESOURCE_MIME_TYPE,
            text: rewritten,
            _meta: {
              ui: {
                prefersBorder: false,
                domain: base,
                csp: {
                  connectDomains: [base, "https://www.youtube.com", "https://youtube.com", "https://i.ytimg.com", "https://api.audius.co", "https://cdnt-preview.dzcdn.net"],
                  resourceDomains: [base, "https://i.ytimg.com", "https://img.youtube.com", "https://cdnt-preview.dzcdn.net", "https://cdn-images.dzcdn.net"],
                },
              },
            },
          },
        ],
      };
    }
  );
}

type Session = Awaited<ReturnType<MCPClient["createSession"]>>;
const sessions: Record<string, Session | null> = {};
const toolsByServer: Record<string, RemoteTool[]> = {};

function jsonSchemaPropertyToZod(prop: any): z.ZodType {
  if (!prop) return z.any();
  if (prop.enum && Array.isArray(prop.enum) && prop.enum.length > 0) {
    return z.enum(prop.enum as [string, ...string[]]);
  }
  switch (prop.type) {
    case "string":
      return z.string();
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(z.any());
    case "object":
      return z.record(z.string(), z.any());
    default:
      return z.any();
  }
}

function jsonSchemaToZod(inputSchema: any): z.ZodObject<any> {
  if (!inputSchema || !inputSchema.properties) {
    return z.object({});
  }

  const required: string[] = inputSchema.required || [];
  const shape: Record<string, z.ZodType> = {};

  for (const [key, prop] of Object.entries(inputSchema.properties as Record<string, any>)) {
    let field = jsonSchemaPropertyToZod(prop);
    if (prop.description) field = field.describe(prop.description);
    if (!required.includes(key)) field = field.optional();
    shape[key] = field;
  }

  return z.object(shape);
}

/** All MCP base URLs that may appear in tool results (for widget URL rewriting) */
const ALL_MCP_BASES = [...new Set([TARGET_MCP_BASE, ...Object.values(WIDGET_TO_BASE)])];

/** Recursively rewrite remote MCP URLs to orch proxy so client can load widgets */
function rewriteWidgetUrls(obj: any): any {
  if (obj == null) return obj;
  if (typeof obj === "string") {
    let s = obj;
    for (const base of ALL_MCP_BASES) {
      const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      s = s.replace(new RegExp(esc, "g"), `${ORCH_BASE}/widget-proxy`);
    }
    return s;
  }
  if (Array.isArray(obj)) return obj.map(rewriteWidgetUrls);
  if (typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, rewriteWidgetUrls(v)])
    );
  }
  return obj;
}

/**
 * Pass through full remote result so widgets (music player UI) render.
 * Rewrite widget URLs to go through orch proxy (same-origin for client).
 */
function formatRemoteResult(result: any) {
  if (result?.isError) {
    const message = result.content?.[0]?.text || "Remote tool returned an error";
    return error(message);
  }
  if (result?.content?.length || result?.structuredContent != null || result?._meta != null) {
    return rewriteWidgetUrls(JSON.parse(JSON.stringify(result)));
  }
  return text("Remote tool executed successfully.");
}

function extractSongQuery(command: string): string {
  const trimmed = command.trim();
  const cleaned = trimmed.replace(
    /^(please\s+)?(can you\s+)?(could you\s+)?(would you\s+)?/i,
    ""
  );
  const match =
    cleaned.match(/(?:play|start|put on)\s+(?:song\s+)?(.+)/i) ||
    cleaned.match(/(?:play)\s+(.+)/i);
  return match?.[1]?.trim() || cleaned;
}

function scorePlayTool(tool: RemoteTool): number {
  const name = tool.name.toLowerCase();
  const desc = (tool.description || "").toLowerCase();
  let score = 0;

  if (name === "play" || name === "play-song" || name === "play_song") score += 100;
  if (name.includes("play")) score += 30;
  if (name.includes("song") || name.includes("music") || name.includes("track")) score += 20;
  if (desc.includes("play")) score += 15;
  if (desc.includes("song") || desc.includes("music") || desc.includes("track")) score += 10;
  return score;
}

function pickPlayTool(tools: RemoteTool[]): RemoteTool | null {
  const ranked = [...tools]
    .map((tool) => ({ tool, score: scorePlayTool(tool) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  return ranked.length > 0 ? ranked[0].tool : null;
}

function buildArgsFromSchema(inputSchema: any, songQuery: string, rawCommand: string): Record<string, any> {
  const properties = inputSchema?.properties || {};
  const required = new Set<string>((inputSchema?.required || []) as string[]);
  const args: Record<string, any> = {};

  for (const [key, prop] of Object.entries(properties as Record<string, any>)) {
    const lowerKey = key.toLowerCase();
    const propType = prop?.type;

    if (
      /song|track|title|query|search|name|prompt|text|message/.test(lowerKey) &&
      (required.has(key) || /song|track|title|query|search/.test(lowerKey))
    ) {
      args[key] = songQuery;
      continue;
    }

    if (/command|input|utterance/.test(lowerKey) && required.has(key)) {
      args[key] = rawCommand;
      continue;
    }

    if (/url|uri/.test(lowerKey) && /^https?:\/\//i.test(songQuery) && required.has(key)) {
      args[key] = songQuery;
      continue;
    }

    if (required.has(key)) {
      if (propType === "boolean") args[key] = false;
      else if (propType === "number" || propType === "integer") args[key] = 1;
      else if (propType === "array") args[key] = [];
      else if (propType === "object") args[key] = {};
      else args[key] = songQuery;
    }
  }

  return args;
}

let mcpClient: InstanceType<typeof MCPClient> | null = null;

async function ensureRemoteConnected() {
  if (mcpClient) return;

  const clientConfig: Record<string, { url: string }> = {};
  for (const [name, cfg] of Object.entries(mcpServers)) {
    clientConfig[name] = { url: cfg.url };
  }

  mcpClient = MCPClient.fromDict({ mcpServers: clientConfig });

  for (const serverName of SERVER_NAMES) {
    const session = await mcpClient.createSession(serverName);
    sessions[serverName] = session;
    toolsByServer[serverName] = await session.listTools();
  }

  for (const [serverName, config] of Object.entries(mcpServers)) {
    const serverTools = toolsByServer[serverName] || [];
    const session = sessions[serverName];
    const widgetName = config.playWidget;

    for (const tool of serverTools) {
      const prefixedName = `${config.prefix}${tool.name}`;

      server.tool(
        {
          name: prefixedName,
          description: `[${serverName}] ${tool.description || tool.name}`,
          schema: jsonSchemaToZod(tool.inputSchema),
          ...(widgetName && {
            widget: {
              name: widgetName,
              invoking: "Loading...",
              invoked: "Done",
            },
          }),
        },
        async (args: any) => {
          if (!session) return error(`${serverName} MCP is not connected.`);
          try {
            const result = await session.callTool(tool.name, args);
            if (result?.isError) {
              const msg = (result.content?.[0] as { text?: string })?.text || "Tool failed";
              return error(msg);
            }
            if (result?.content?.length || result?.structuredContent != null || result?._meta != null) {
              return formatRemoteResult(result);
            }
            return text("Done.");
          } catch (err: any) {
            return error(`${serverName} tool failed (${tool.name}): ${(err as Error).message}`);
          }
        }
      );
    }
  }
}

server.tool(
  {
    name: "list-remote-tools",
    description: "List tools available in the connected remote MCP server.",
    schema: z.object({}),
  },
  async () => {
    try {
      await ensureRemoteConnected();
      const out: Record<string, { url: string; tools: { name: string; description: string }[] }> = {};
      for (const [name, cfg] of Object.entries(mcpServers)) {
        const tools = toolsByServer[name] || [];
        out[name] = { url: cfg.url, tools: tools.map((t) => ({ name: t.name, description: t.description || "" })) };
      }
      return object(out);
    } catch (err: any) {
      return error(`Failed to connect: ${err.message}`);
    }
  }
);

server.tool(
  {
    name: "play-song",
    description:
      "Handle a natural-language play request (e.g. 'play song believer') by selecting and calling the best remote play tool.",
    schema: z.object({
      command: z.string().min(1).describe("Natural language command from user"),
    }),
    widget: {
      name: "music-player",
      invoking: "Searching for your song...",
      invoked: "Now playing",
    },
  },
  async ({ command }) => {
    return executePlaySongCommand(command);
  }
);

server.tool(
  {
    name: "route-command",
    description:
      "Route a plain user command. Supports @music, @youtube, @message to target a specific MCP. E.g. '@music play believer' or '@youtube search coldplay'.",
    schema: z.object({
      command: z.string().min(1),
    }),
    widget: {
      name: "music-player",
      invoking: "Searching for your song...",
      invoked: "Now playing",
    },
  },
  async ({ command }) => {
    const trimmed = command.trim();
    const atMatch = trimmed.match(/^@(\w+)\s+(.+)$/);
    let target: string | null = null;
    let rest = trimmed;

    if (atMatch) {
      target = atMatch[1].toLowerCase();
      rest = atMatch[2].trim();
      if (!mcpServers[target]) {
        target = null;
        rest = trimmed;
      }
    }

    // @music or implicit play/music keywords
    const lower = rest.toLowerCase();
    const isPlayIntent =
      target === "music" ||
      (/\b(play|start|put on)\b/.test(lower) && /\b(song|music|track)\b/.test(lower));

    if (isPlayIntent && rest) {
      return executePlaySongCommand(rest);
    }

    // @youtube: try search tool for "search X" or plain query
    if (target === "youtube" && rest) {
      await ensureRemoteConnected();
      const searchMatch = rest.match(/^search\s+(.+)$/i) || (rest ? [null, rest] : null);
      const query = searchMatch?.[1]?.trim() || rest;
      const searchTool = (toolsByServer["youtube"] || []).find(
        (t) => t.name.toLowerCase().includes("search")
      );
      if (searchTool && query) {
        const args = buildArgsFromSchema(searchTool.inputSchema, query, rest);
        return executeRemoteTool("youtube", searchTool.name, args);
      }
      return text(`For YouTube use: yt__search "query" or yt__play "url". Try: yt__search "${rest.slice(0, 30)}"`);
    }

    // @message: guidance
    if (target === "message") {
      return text("For messages use: chat__send, chat__read, chat__register. Example: chat__send { to, body }");
    }

    // Generic @target: show available tools
    if (target && mcpServers[target]) {
      await ensureRemoteConnected();
      const tools = (toolsByServer[target] || []).slice(0, 5).map((t) => `${mcpServers[target].prefix}${t.name}`).join(", ");
      return text(`@${target} tools: ${tools || "none"}${rest ? `. For "${rest}" try the matching tool.` : ""}`);
    }

    return text(
      "Use @music, @youtube, @message to target an MCP. Or: play-song, list-remote-tools. Visit / for the dashboard."
    );
  }
);

async function executeRemoteTool(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<any> {
  await ensureRemoteConnected();
  const session = sessions[serverName];
  const cfg = mcpServers[serverName];
  if (!session || !cfg) return error(`${serverName} MCP is not connected.`);
  const tool = (toolsByServer[serverName] || []).find((t) => t.name === toolName);
  if (!tool) return error(`Tool ${toolName} not found on ${serverName}.`);
  try {
    const result = await session.callTool(toolName, args);
    if (result?.isError) {
      const msg = (result.content?.[0] as { text?: string })?.text || "Tool failed";
      return error(msg);
    }
    if (result?.content?.length || result?.structuredContent != null || result?._meta != null) {
      return formatRemoteResult(result);
    }
    return text("Done.");
  } catch (err: any) {
    return error(`${serverName} tool failed: ${err.message}`);
  }
}

async function executePlaySongCommand(command: string) {
  try {
    await ensureRemoteConnected();
    const musicSession = sessions[MUSIC_SERVER];
    const musicTools = toolsByServer[MUSIC_SERVER] || [];
    if (!musicSession) return error("Music MCP is not connected.");

    const playTool = pickPlayTool(musicTools);
    if (!playTool) {
      return error(
        "No remote play/music tool found. Use list-remote-tools to inspect available tools."
      );
    }

    const songQuery = extractSongQuery(command);
    const args = buildArgsFromSchema(playTool.inputSchema, songQuery, command);
    const result = await musicSession.callTool(playTool.name, args);
    return formatRemoteResult(result);
  } catch (err: any) {
    return error(`Failed to execute play-song command: ${err.message}`);
  }
}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3002;
console.log(
  `music-intent-mcp starting on port ${PORT}. Target remote MCP: ${TARGET_MCP_URL}`
);
console.log(
  `MCP_URL (ORCH_BASE): ${ORCH_BASE} — must match deployed URL for widget stream to work`
);

ensureRemoteConnected()
  .then(() => {
    const counts = SERVER_NAMES.map((n) => `${n}: ${(toolsByServer[n] || []).length}`).join(", ");
    console.log(`Connected: ${counts} tools`);
  })
  .catch((err) => {
    console.warn(`Remote MCP connection deferred: ${err.message}`);
  });

server.listen(PORT);
