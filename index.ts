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
  playWidget?: string;
}

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

// Find music server (has playWidget) for widget resource and play-song
const MUSIC_SERVER = SERVER_NAMES.find((k) => mcpServers[k].playWidget) || SERVER_NAMES[0];
const TARGET_MCP_URL = mcpServers[MUSIC_SERVER]?.url || "https://young-surf-xt5j8.run.mcp-use.com/mcp";
const TARGET_MCP_BASE = TARGET_MCP_URL.replace(/\/mcp\/?$/, "");

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
  const targetUrl = `${TARGET_MCP_BASE}${path}`;
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
      const targetEsc = TARGET_MCP_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const proxyBase = `${base}/widget-proxy/mcp-use/widgets`;
      let rewritten = text;
      if (isHtml) {
        const baseScript = `<script>window.__WIDGET_BASE_URL__="${base.replace(/\/$/, "")}";</script>`;
        rewritten = rewritten
          .replace(/<head\b[^>]*>/, (m) => m + baseScript)
          .replace(/<html\b[^>]*>/, (m) => (text.includes("<head") ? m : m + baseScript));
      }
      rewritten = rewritten
        .replace(new RegExp(targetEsc + "/mcp-use/widgets/", "g"), `${proxyBase}/`)
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

// Register ui://widget/music-player.html - ChatGPT expects HTML with text/html;profile=mcp-app, NOT a URL.
server.resource(
  {
    name: "music-player-widget",
    uri: "ui://widget/music-player.html",
    description: "Music player widget UI (proxied from remote MCP)",
    mimeType: RESOURCE_MIME_TYPE,
  },
  async () => {
    const res = await fetch(`${TARGET_MCP_BASE}/mcp-use/widgets/music-player`);
    if (!res.ok) {
      return { contents: [{ uri: "ui://widget/music-player.html", mimeType: "text/plain", text: "Widget unavailable" }] };
    }
    const html = await res.text();
    const base = TARGET_MCP_BASE.replace(/\/$/, "");
    // Point widget to music-player-mcp directly - it exposes /mcp-use/widgets and /stream.
    // Orch gateway doesn't expose custom routes, so we load from the backend that does.
    const baseScript = `<script>window.__WIDGET_BASE_URL__="${base}";</script>`;
    const rewritten = html
      .replace(/<head\b[^>]*>/, (m) => m + baseScript)
      .replace(/<html\b[^>]*>/, (m) => (html.includes("<head") ? m : m + baseScript))
      .replace(/<base href="[^"]*"\s*\/>/, `<base href="${base}/" />`)
      .replace(/window\.location\.origin/g, "(window.__WIDGET_BASE_URL__||window.location.origin)");
    // No URL rewriting - keep original paths; base href makes them resolve to music-player-mcp
    return {
      contents: [
        {
          uri: "ui://widget/music-player.html",
          mimeType: RESOURCE_MIME_TYPE,
          text: rewritten,
          _meta: {
            ui: {
              prefersBorder: false,
              domain: base,
              csp: {
                connectDomains: [base, "https://api.audius.co", "https://cdnt-preview.dzcdn.net"],
                resourceDomains: [base, "https://cdnt-preview.dzcdn.net", "https://cdn-images.dzcdn.net"],
              },
            },
          },
        },
      ],
    };
  }
);

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

/** Recursively rewrite remote MCP URLs to orch proxy so client can load widgets */
function rewriteWidgetUrls(obj: any): any {
  if (obj == null) return obj;
  if (typeof obj === "string") {
    return obj.replace(
      new RegExp(TARGET_MCP_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
      `${ORCH_BASE}/widget-proxy`
    );
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

  const playToolNames = ["play", "play-song", "play_song"];
  const musicTools = toolsByServer[MUSIC_SERVER] || [];

  for (const [serverName, config] of Object.entries(mcpServers)) {
    const serverTools = toolsByServer[serverName] || [];
    const session = sessions[serverName];
    const isMusicServer = serverName === MUSIC_SERVER;

    for (const tool of serverTools) {
      const prefixedName = `${config.prefix}${tool.name}`;
      const isPlayTool = isMusicServer && playToolNames.includes(tool.name.toLowerCase());
      const widgetName = config.playWidget;

      server.tool(
        {
          name: prefixedName,
          description: `[${serverName}] ${tool.description || tool.name}`,
          schema: jsonSchemaToZod(tool.inputSchema),
          ...(isPlayTool &&
            widgetName && {
              widget: {
                name: widgetName,
                invoking: "Searching for your song...",
                invoked: "Now playing",
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
            if (isMusicServer && (result?.content?.length || result?.structuredContent != null || result?._meta != null)) {
              return formatRemoteResult(result);
            }
            if (result?.content?.length || result?.structuredContent != null || result?._meta != null) {
              return result as any;
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
      "Route a plain user command. If it asks to play music/song, this calls play-song. Otherwise returns guidance.",
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
    const lower = command.toLowerCase();
    if (/\b(play|start|put on)\b/.test(lower) && /\b(song|music|track)\b/.test(lower)) {
      return executePlaySongCommand(command);
    }
    return text(
      "I route play-song to music. Use chat__* for messages, yt__* for YouTube. Try 'play-song' or 'list-remote-tools'."
    );
  }
);

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
