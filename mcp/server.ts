import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { isDesignId, readDesign, updateDesign } from "../lib/designStore";
import { isProject } from "../lib/project";
import { setGlobalLang } from "../lib/i18n";
import { mcpHandler } from "./tools";

/* The canvas and the MCP endpoint in one process. GitHub Pages cannot run this:
 * `npm run build` still writes the static app to out/, and this server serves
 * that folder plus /mcp and /api/designs. */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

let publicBase = process.env.M3E_PUBLIC_URL ?? "http://127.0.0.1:8787";

const handler = mcpHandler(() => publicBase);
const nodeHandler = toNodeHandler(handler);
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

function loopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function mcpAllowed(req: IncomingMessage): boolean {
  const expected = process.env.M3E_MCP_TOKEN;
  if (!expected) return loopback(req.socket.remoteAddress);
  return req.headers.authorization === `Bearer ${expected}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, PUT, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
  });
  res.end(payload);
}

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleDesign(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }
  const pathname = url.pathname.replace(/\/$/, "") || "/";
  if (pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }
  const id = decodeURIComponent(pathname.split("/").pop() ?? "");
  if (!isDesignId(id)) {
    sendJson(res, 404, { error: "Not found." });
    return;
  }
  if (req.method === "GET") {
    const record = await readDesign(id);
    if (!record) {
      sendJson(res, 404, { error: "No design with that id." });
      return;
    }
    sendJson(res, 200, record);
    return;
  }
  if (req.method === "PUT") {
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: "Expected a JSON body under 1 MB." });
      return;
    }
    if (!body || typeof body !== "object") {
      sendJson(res, 400, { error: "doc is not a document the editor can open." });
      return;
    }
    const parsed = body as { rev?: unknown; doc?: unknown };
    if (!isProject(parsed.doc)) {
      sendJson(res, 400, { error: "doc is not a document the editor can open." });
      return;
    }
    const rev = parsed.rev;
    if (typeof rev !== "number") {
      sendJson(res, 400, { error: "rev must be the revision you last read." });
      return;
    }
    const written = await updateDesign(id, rev, parsed.doc);
    if (!written.ok && "missing" in written) {
      sendJson(res, 404, { error: "No design with that id." });
      return;
    }
    if (!written.ok) {
      sendJson(res, 409, written.conflict);
      return;
    }
    sendJson(res, 200, { id: written.record.id, rev: written.record.rev });
    return;
  }
  sendJson(res, 405, { error: "Use GET or PUT." });
}

function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }
  const root = resolve(process.cwd(), "out");
  const prefix = root.endsWith(sep) ? root : root + sep;
  let file = resolve(root, url.pathname.replace(/^\/+/, ""));
  if (file !== root && !file.startsWith(prefix)) {
    res.writeHead(403).end();
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  const missing = !existsSync(file) || !statSync(file).isFile();
  if (missing && extname(url.pathname)) {
    res.writeHead(404).end();
    return;
  }
  if (missing) file = join(root, "index.html");
  if (!existsSync(file)) {
    sendJson(res, 503, { error: "The canvas has not been built. Run npm run build." });
    return;
  }
  const type = MIME[extname(file)] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

async function onRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname.replace(/\/$/, "") || "/";
  if (pathname === "/mcp") {
    if (!mcpAllowed(req)) {
      sendJson(res, 401, { error: "Send Authorization: Bearer <M3E_MCP_TOKEN>." });
      return;
    }
    const host = req.headers.host?.split(":")[0] ?? "";
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    }
    await nodeHandler(req, res);
    return;
  }
  if (pathname === "/api/health" || pathname.startsWith("/api/designs/")) {
    await handleDesign(req, res, url);
    return;
  }
  serveStatic(req, res, url);
}

export function start(port = Number(process.env.PORT ?? 8787), host = process.env.M3E_HOST ?? "127.0.0.1") {
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && !process.env.M3E_MCP_TOKEN) {
    throw new Error("Set M3E_MCP_TOKEN before listening beyond loopback. The MCP endpoint is private.");
  }
  setGlobalLang("en");
  const server = createServer((req, res) => {
    onRequest(req, res).catch((error) => {
      if (!res.headersSent) sendJson(res, 500, { error: error instanceof Error ? error.message : "failed" });
      else res.end();
    });
  });
  return new Promise<typeof server>((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : port;
      if (!process.env.M3E_PUBLIC_URL) publicBase = `http://127.0.0.1:${bound}`;
      resolveReady(server);
    });
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  start()
    .then((server) => {
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : "";
      console.log(`M3E Canvas MCP on ${publicBase} (port ${bound})`);
      console.log("MCP endpoint: /mcp");
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
