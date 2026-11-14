import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getLang, setGlobalLang, type Lang } from "../lib/i18n";
import { removeDesignDir } from "../lib/designStore";
import { createFromDraft } from "./service";
import { start } from "./server";

const dir = mkdtempSync(path.join(tmpdir(), "m3e-http-"));
process.env.M3E_DATA_DIR = dir;
process.env.M3E_MCP_TOKEN = "test-token";

let server: Server;
let base = "";
let previousLang: Lang = "ja";

beforeAll(async () => {
  previousLang = getLang();
  server = await start(0, "127.0.0.1");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  setGlobalLang(previousLang);
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  await removeDesignDir();
  delete process.env.M3E_MCP_TOKEN;
});

const mcp = (body: unknown, token?: string) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

describe("mcp http", () => {
  it("refuses a public bind without a token", async () => {
    const saved = process.env.M3E_MCP_TOKEN;
    delete process.env.M3E_MCP_TOKEN;
    try {
      expect(() => start(0, "0.0.0.0")).toThrow(/M3E_MCP_TOKEN/);
    } finally {
      process.env.M3E_MCP_TOKEN = saved;
    }
  });

  it("requires the bearer token and then lists the tools", async () => {
    const denied = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(denied.status).toBe(401);

    const listed = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }, "test-token");
    const text = await listed.text();
    expect(listed.status, text).toBe(200);
    expect(text).toContain("m3e_create_design");
    expect(text).toContain("m3e_screenshot");
  });

  it("publishes field schemas and returns compact write receipts", async () => {
    const rpc = async (method: string, params?: unknown) => {
      const response = await mcp({ jsonrpc: "2.0", id: 10, method, params }, "test-token");
      expect(response.status).toBe(200);
      const payload = await response.text();
      const body = JSON.parse(payload.startsWith("event:") ? payload.split("\n").find((line) => line.startsWith("data: "))!.slice(6) : payload);
      expect(body.error).toBeUndefined();
      return body.result;
    };
    const listed = await rpc("tools/list");
    const create = listed.tools.find((tool: { name: string }) => tool.name === "m3e_create_design");
    const fields = create.inputSchema.properties.doc.properties.groups.items.properties;
    expect(fields.screen.type).toBe("string");
    expect(fields.items.items.required).toContain("kind");
    expect(fields.items.items.properties.variant.enum).toContain("outlined");
    expect(fields.items.items.properties.wrapWidth.type).toBe("number");
    const call = (name: string, args: unknown) => rpc("tools/call", { name, arguments: args });
    const created = await call("m3e_create_design", { doc: {
      title: "Compact", frames: [{ id: "home", name: "Home" }],
      groups: [{ screen: "home", items: [{ id: "save", kind: "button", label: "Save" }] }],
    } });
    expect(created.isError).not.toBe(true);
    const id = created.structuredContent.id;
    const receipt = (result: typeof created, rev: number) => {
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ id, rev, url: `${base}/d/${id}/` });
      expect(result.content[0].text).not.toContain("Save");
    };
    receipt(created, 1);
    receipt(await call("m3e_edit_design", { id, operations: [{ op: "update_part", id: "save", patch: { label: "Done" } }] }), 2);
    receipt(await call("m3e_set_theme", { id, shape: "full" }), 3);
    const read = await call("m3e_get_design", { id });
    expect(read.structuredContent.share).toContain("#docz=");
    expect(read.structuredContent.outline).toContain("Done");
    const resources = await rpc("resources/list");
    expect(resources.resources).toContainEqual(expect.objectContaining({ uri: "m3e://guide" }));
  });

  it("serves a stored design and rejects a stale write", async () => {
    const health = await fetch(`${base}/api/health`);
    expect(await health.json()).toEqual({ ok: true });

    const created = await createFromDraft({
      title: "Recipes",
      brief: "Save and search recipes.",
      paletteKey: "purple",
      frames: [{ id: "home", name: "Home" }],
      groups: [{ screen: "home", items: [{ id: "bar", kind: "topAppBar", label: "Recipes", icon: "menu" }] }],
    }, base);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const got = await fetch(`${base}/api/designs/${created.id}`);
    expect(got.status).toBe(200);
    const record = await got.json();
    expect(record.rev).toBe(1);
    expect(record.doc.title).toBe("Recipes");

    const stale = await fetch(`${base}/api/designs/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rev: 0, doc: record.doc }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).rev).toBe(1);

    const saved = await fetch(`${base}/api/designs/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rev: 1, doc: { ...record.doc, title: "Recipes edited" } }),
    });
    expect(saved.status).toBe(200);
    expect((await saved.json()).rev).toBe(2);

    const missing = await fetch(`${base}/api/designs/not-an-id`);
    expect(missing.status).toBe(404);
  });
});
