import { MCPServer, error, object, text } from "mcp-use/server";
import { MCPClient } from "mcp-use";
import { z } from "zod";

const TARGET_MCP_URL =
  process.env.TARGET_MCP_URL || "https://young-surf-xt5j8.run.mcp-use.com/mcp";
const TARGET_MCP_BASE = TARGET_MCP_URL.replace(/\/mcp\/?$/, "");
const TARGET_SERVER_NAME = process.env.TARGET_SERVER_NAME || "remote_music";

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
    "Uses a remote MCP as a tool source and routes natural language play-song commands.",
  baseUrl: ORCH_BASE,
  host: "0.0.0.0",
});

// Proxy widget resources from remote MCP so client can load them (CSP/same-origin)
async function proxyToRemote(c: any, path: string) {
  const targetUrl = `${TARGET_MCP_BASE}${path}`;
  try {
    const res = await fetch(targetUrl);
    const headers = new Headers(res.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    return new Response(res.body, { status: res.status, headers });
  } catch (err: any) {
    return c.text(`Proxy error: ${err.message}`, 502);
  }
}
server.app.get("/widget-proxy/*", (c) => proxyToRemote(c, c.req.path.replace(/^\/widget-proxy/, "")));
server.app.get("/resources/widgets/*", (c) => proxyToRemote(c, c.req.path));

let remoteSession: Awaited<ReturnType<MCPClient["createSession"]>> | null = null;
let remoteTools: RemoteTool[] = [];

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

async function ensureRemoteConnected() {
  if (remoteSession) return;

  const client = MCPClient.fromDict({
    mcpServers: {
      [TARGET_SERVER_NAME]: {
        url: TARGET_MCP_URL,
      },
    },
  });

  remoteSession = await client.createSession(TARGET_SERVER_NAME);
  remoteTools = await remoteSession.listTools();

  const playToolNames = ["play", "play-song", "play_song"];
  for (const remoteTool of remoteTools) {
    const isPlayTool = playToolNames.includes(remoteTool.name.toLowerCase());
    server.tool(
      {
        name: `remote__${remoteTool.name}`,
        description: `[remote] ${remoteTool.description || remoteTool.name}`,
        schema: jsonSchemaToZod(remoteTool.inputSchema),
        ...(isPlayTool && {
          widget: {
            name: "music-player",
            invoking: "Searching for your song...",
            invoked: "Now playing",
          },
        }),
      },
      async (args: any) => {
        if (!remoteSession) return error("Remote MCP is not connected.");
        try {
          const result = await remoteSession.callTool(remoteTool.name, args);
          return formatRemoteResult(result);
        } catch (err: any) {
          return error(`Remote tool failed (${remoteTool.name}): ${err.message}`);
        }
      }
    );
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
      return object({
        targetMcpUrl: TARGET_MCP_URL,
        tools: remoteTools.map((tool) => ({
          name: tool.name,
          description: tool.description || "",
          inputSchema: tool.inputSchema || {},
        })),
      });
    } catch (err: any) {
      return error(`Failed to connect to remote MCP: ${err.message}`);
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
      "I only auto-route play-song intents right now. Use 'play-song' or call a specific 'remote__*' tool."
    );
  }
);

async function executePlaySongCommand(command: string) {
  try {
    await ensureRemoteConnected();
    if (!remoteSession) return error("Remote MCP is not connected.");

    const playTool = pickPlayTool(remoteTools);
    if (!playTool) {
      return error(
        "No remote play/music tool found. Use list-remote-tools to inspect available tools."
      );
    }

    const songQuery = extractSongQuery(command);
    const args = buildArgsFromSchema(playTool.inputSchema, songQuery, command);
    const result = await remoteSession.callTool(playTool.name, args);
    return formatRemoteResult(result);
  } catch (err: any) {
    return error(`Failed to execute play-song command: ${err.message}`);
  }
}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3002;
console.log(
  `music-intent-mcp starting on port ${PORT}. Target remote MCP: ${TARGET_MCP_URL}`
);

ensureRemoteConnected()
  .then(() => {
    console.log(
      `Connected to remote MCP with ${remoteTools.length} tool(s): ${remoteTools
        .map((t) => t.name)
        .join(", ")}`
    );
  })
  .catch((err) => {
    console.warn(`Remote MCP connection deferred: ${err.message}`);
  });

server.listen(PORT);
