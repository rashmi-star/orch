import { MCPServer, error, object, text } from "mcp-use/server";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { MCPClient } from "mcp-use";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

// Load MCP servers from config file or Google Sheet
const CONFIG_PATH = process.env.MCP_SERVERS_FILE || join(process.cwd(), "mcp-servers.json");
const MCP_SERVERS_SHEET = process.env.MCP_SERVERS_SHEET || "";

interface ServerConfig {
  url: string;
  prefix: string;
  playWidget?: string;
  icon?: string;
}

const DEFAULT_ICONS: Record<string, string> = {
  music: "🎵",
  youtube: "▶️",
  message: "💬",
};

type McpServersConfig = Record<string, ServerConfig>;

const DEFAULT_MCP_SERVERS: McpServersConfig = {
  music: { url: "https://young-surf-xt5j8.run.mcp-use.com/mcp", prefix: "remote__", playWidget: "music-player" },
  youtube: { url: "https://still-thunder-8btdl.run.mcp-use.com/mcp", prefix: "yt__" },
  message: { url: "https://summer-poetry-bwin6.run.mcp-use.com/mcp", prefix: "chat__" },
};

function loadMcpConfigFromFile(): { mcpServers: McpServersConfig } {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as { mcpServers?: McpServersConfig };
    if (!parsed.mcpServers || typeof parsed.mcpServers !== "object") {
      throw new Error("mcpServers must be an object");
    }
    return { mcpServers: parsed.mcpServers };
  } catch (err: any) {
    console.warn(`Could not load ${CONFIG_PATH}, using defaults: ${err.message}`);
    return { mcpServers: { ...DEFAULT_MCP_SERVERS } };
  }
}

async function loadMcpConfigFromSheet(sheetUrl: string): Promise<{ mcpServers: McpServersConfig }> {
  const match = sheetUrl.match(/\/d\/([a-zA-Z0-9_-]+)(?:\/.*gid=(\d+))?/);
  const id = match?.[1] || sheetUrl;
  const gid = match?.[2] || "0";
  const exportUrl = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
  const res = await fetch(exportUrl);
  if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`);
  const csv = await res.text();
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error("Sheet must have header + at least one row");
  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const nameIdx = headers.findIndex((h) => /^name$/.test(h));
  const urlIdx = headers.findIndex((h) => /^url$/.test(h));
  if (nameIdx < 0 || urlIdx < 0) throw new Error("Sheet must have 'name' and 'url' columns");
  const prefixIdx = headers.findIndex((h) => /^prefix$/.test(h));
  const widgetIdx = headers.findIndex((h) => /^playwidget|play_widget|widget$/.test(h));
  const iconIdx = headers.findIndex((h) => /^icon$/.test(h));
  const mcpServers: McpServersConfig = {};
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCsvLine(lines[i]);
    const name = (vals[nameIdx] || "").trim().toLowerCase().replace(/\s+/g, "-");
    const url = (vals[urlIdx] || "").trim();
    if (!name || !url) continue;
    const prefix = (prefixIdx >= 0 ? vals[prefixIdx] : "")?.trim() || `${name}__`;
    const normalized = url.replace(/\/+$/, "") + (url.endsWith("/mcp") ? "" : "/mcp");
    mcpServers[name] = {
      url: normalized,
      prefix,
      ...(widgetIdx >= 0 && vals[widgetIdx]?.trim() && { playWidget: vals[widgetIdx].trim() }),
      ...(iconIdx >= 0 && vals[iconIdx]?.trim() && { icon: vals[iconIdx].trim() }),
    };
  }
  if (Object.keys(mcpServers).length === 0) throw new Error("No valid MCP rows in sheet");
  return { mcpServers };
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

async function loadMcpConfig(): Promise<{ mcpServers: McpServersConfig }> {
  if (MCP_SERVERS_SHEET) {
    try {
      const cfg = await loadMcpConfigFromSheet(MCP_SERVERS_SHEET);
      console.log(`Loaded ${Object.keys(cfg.mcpServers).length} MCPs from Google Sheet`);
      return cfg;
    } catch (err: any) {
      console.warn(`Sheet load failed (${err.message}), falling back to file`);
    }
  }
  return loadMcpConfigFromFile();
}

// Config loaded at startup (async for sheet support)
const { mcpServers } = await loadMcpConfig();
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

// Webhook: trigger reload when sheet is edited (Google Apps Script can call this)
// Set RELOAD_SECRET env to require ?secret=xxx in the request
server.app.post("/api/reload", async (c) => {
  const secret = process.env.RELOAD_SECRET;
  if (secret) {
    const q = c.req.query("secret") || c.req.header("x-reload-secret");
    if (q !== secret) return c.json({ error: "Unauthorized" }, 401);
  }
  if (!MCP_SERVERS_SHEET) {
    return c.json({ error: "MCP_SERVERS_SHEET not set. Webhook only works with Google Sheet config." }, 400);
  }
  console.log("Reload webhook received – exiting to trigger restart");
  setTimeout(() => process.exit(0), 500);
  return c.json({ ok: true, message: "Restarting to reload config from sheet" });
});

// API: get current MCPs (from file or sheet)
server.app.get("/api/mcp", async (c) => {
  try {
    const { mcpServers } = await loadMcpConfig();
    return c.json({ mcpServers });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// API: add new MCP (writes to file only; disabled when using sheet)
server.app.post("/api/mcp", async (c) => {
  if (MCP_SERVERS_SHEET) {
    return c.json({ error: "Using Google Sheet. Edit the sheet to add MCPs, then redeploy." }, 400);
  }
  try {
    const body = await c.req.json() as { name?: string; url?: string; prefix?: string; playWidget?: string; icon?: string };
    const name = String(body.name || "").trim().toLowerCase().replace(/\s+/g, "-");
    const url = String(body.url || "").trim();
    const prefix = String(body.prefix || "").trim() || `${name}__`;
    if (!name || !url) return c.json({ error: "name and url required" }, 400);
    if (!/^https?:\/\//.test(url)) return c.json({ error: "url must start with https://" }, 400);
    const { mcpServers } = loadMcpConfigFromFile();
    if (mcpServers[name]) return c.json({ error: `MCP "${name}" already exists` }, 400);
    const normalized = url.replace(/\/+$/, "") + (url.endsWith("/mcp") ? "" : "/mcp");
    mcpServers[name] = { url: normalized, prefix, ...(body.playWidget && { playWidget: body.playWidget }), ...(body.icon && { icon: body.icon }) };
    writeFileSync(CONFIG_PATH, JSON.stringify({ mcpServers }, null, 2), "utf-8");
    return c.json({ ok: true, message: `Added ${name}. Restart orch to apply.` });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Orch dashboard: MCP icons + add form (or sheet link when using sheet)
server.app.get("/", (c) => c.html(buildOrchHubHtml(ORCH_BASE, !MCP_SERVERS_SHEET)));

// Orch hub – dashboard HTML (with add form when at /; widget version has no form)
function buildOrchHubHtml(base: string, includeAddForm = false): string {
  const mcps = Object.entries(mcpServers).map(([name, cfg]) => ({
    name,
    icon: cfg.icon ?? DEFAULT_ICONS[name] ?? "🔗",
    atTag: `@${name}`,
  }));
  const addForm = includeAddForm ? `
  <div class="orch-add">
    <h3 class="orch-add-title">Add deployed MCP</h3>
    <form id="addForm" class="orch-form">
      <input name="name" placeholder="Name (e.g. my-mcp)" required class="orch-input" />
      <input name="url" type="url" placeholder="https://xxx.run.mcp-use.com/mcp" required class="orch-input" />
      <input name="prefix" placeholder="Prefix (e.g. my__)" class="orch-input" />
      <input name="playWidget" placeholder="Widget (e.g. music-player)" class="orch-input" />
      <button type="submit" class="orch-btn">Add</button>
    </form>
    <p class="orch-note">Restart orch to apply new MCPs</p>
    <div id="addMsg" class="orch-msg"></div>
  </div>` : (MCP_SERVERS_SHEET ? `
  <div class="orch-add">
    <h3 class="orch-add-title">Config from Google Sheet</h3>
    <p class="orch-note">Edit the sheet to add MCPs, then redeploy orch.</p>
    <a href="${MCP_SERVERS_SHEET}" target="_blank" rel="noopener" class="orch-btn" style="display:inline-block;text-align:center;text-decoration:none;margin-top:8px">Open Sheet</a>
  </div>` : "");
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--orch-radius:16px;--orch-purple:#8b5cf6;--orch-bg:#0a0a0f;--orch-surface:rgba(255,255,255,0.04);--orch-border:rgba(255,255,255,0.06);--orch-text:#f0f0f5;--orch-muted:rgba(255,255,255,0.45)}
body{font-family:Inter,-apple-system,sans-serif;background:var(--orch-bg);color:var(--orch-text);font-size:14px;padding:20px;max-width:480px;margin:0 auto}
.orch-root{border-radius:var(--orch-radius);border:1px solid var(--orch-border);overflow:hidden;background:linear-gradient(180deg,rgba(139,92,246,0.06) 0%,transparent 50%)}
.orch-header{padding:16px 20px 12px;border-bottom:1px solid var(--orch-border)}
.orch-title{font-size:15px;font-weight:650;color:#fff}
.orch-sub{font-size:12px;color:var(--orch-muted);margin-top:4px}
.orch-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:10px;padding:16px 20px 20px}
.orch-card{background:var(--orch-surface);border:1px solid var(--orch-border);border-radius:12px;padding:14px 16px;cursor:pointer;display:flex;align-items:center;gap:12px;transition:all .2s}
.orch-card:hover{border-color:rgba(139,92,246,0.35);background:rgba(139,92,246,0.08);transform:translateY(-1px)}
.orch-icon{font-size:24px;width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.06);flex-shrink:0}
.orch-card:hover .orch-icon{background:rgba(139,92,246,0.2)}
.orch-card-body{min-width:0}
.orch-name{font-weight:600;font-size:13px;text-transform:capitalize;color:#fff}
.orch-tag{font-size:11px;color:var(--orch-muted);margin-top:2px;font-family:ui-monospace,monospace}
.orch-toast{position:fixed;bottom:1rem;left:50%;transform:translateX(-50%);background:rgba(15,15,20,0.95);padding:0.5rem 1rem;border-radius:8px;font-size:12px;border:1px solid var(--orch-border);opacity:0;transition:opacity .2s;pointer-events:none}
.orch-toast.show{opacity:1}
.orch-add{margin-top:20px;padding:16px;border:1px solid var(--orch-border);border-radius:var(--orch-radius);background:var(--orch-surface)}
.orch-add-title{font-size:13px;font-weight:600;margin-bottom:12px;color:var(--orch-muted)}
.orch-form{display:flex;flex-direction:column;gap:8px}
.orch-input{background:rgba(0,0,0,0.3);border:1px solid var(--orch-border);border-radius:8px;padding:8px 12px;color:#fff;font-size:13px}
.orch-input::placeholder{color:var(--orch-muted)}
.orch-btn{background:var(--orch-purple);color:#fff;border:none;border-radius:8px;padding:10px;font-weight:600;cursor:pointer;font-size:13px}
.orch-btn:hover{opacity:0.9}
.orch-note{font-size:11px;color:var(--orch-muted);margin-top:8px}
.orch-msg{font-size:12px;margin-top:8px;min-height:1.2em}
.orch-msg.ok{color:#4ade80}
.orch-msg.err{color:#f87171}
</style></head>
<body>
<div class="orch-root">
  <div class="orch-header">
    <h2 class="orch-title">Orch hub</h2>
    <p class="orch-sub">Click an MCP to copy its @tag for your next message</p>
  </div>
  <div class="orch-grid">${mcps.map((m) => `<button class="orch-card" data-tag="${m.atTag}" title="Copy ${m.atTag}"><span class="orch-icon">${m.icon}</span><div class="orch-card-body"><div class="orch-name">${m.name}</div><div class="orch-tag">${m.atTag}</div></div></button>`).join("")}</div>
</div>${addForm}
<div class="orch-toast" id="toast">Copied!</div>
<script>
document.querySelectorAll('.orch-card').forEach(btn=>{btn.addEventListener('click',async()=>{const tag=btn.dataset.tag+' ';try{await navigator.clipboard.writeText(tag);const t=document.getElementById('toast');t.textContent='Copied '+tag.trim();t.classList.add('show');setTimeout(()=>t.classList.remove('show'),1500)}catch(e){prompt('Copy:',tag)}})});
${includeAddForm ? `
const form=document.getElementById('addForm');const msg=document.getElementById('addMsg');
form.addEventListener('submit',async(e)=>{e.preventDefault();msg.textContent='';msg.className='orch-msg';
const fd=new FormData(form);const r=await fetch('/api/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:fd.get('name'),url:fd.get('url'),prefix:fd.get('prefix')||undefined,playWidget:fd.get('playWidget')||undefined})});
const j=await r.json();msg.textContent=j.error||j.message;msg.className='orch-msg '+(j.error?'err':'ok');if(j.ok)form.reset();});
` : ""}
</script></body></html>`;
}

server.resource(
  {
    name: "orch-dashboard-widget",
    uri: "ui://widget/orch-dashboard.html",
    description: "Orch MCP hub – click icons to copy @tags",
    mimeType: RESOURCE_MIME_TYPE,
  },
  async () => {
    const base = ORCH_BASE.replace(/\/$/, "");
    const html = buildOrchHubHtml(base, false);
    return {
      contents: [{ uri: "ui://widget/orch-dashboard.html", mimeType: RESOURCE_MIME_TYPE, text: html }],
    };
  }
);

server.tool(
  {
    name: "orch-hub",
    description: "Show the Orch MCP hub in chat. Click an MCP icon to copy its @tag for your next message.",
    schema: z.object({}),
    widget: { name: "orch-dashboard", invoking: "Loading hub...", invoked: "Orch hub" },
  },
  async () => text("Orch hub – click an MCP above to copy its @tag, then paste in your next message.")
);

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
