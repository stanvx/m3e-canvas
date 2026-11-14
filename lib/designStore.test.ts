import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createDesign, isDesignId, listDesigns, readDesign, removeDesignDir, updateDesign } from "./designStore";
import type { Doc } from "./tokens";

const dir = mkdtempSync(path.join(tmpdir(), "m3e-store-"));
process.env.M3E_DATA_DIR = dir;

const doc = { title: "One", brief: "", paletteKey: "purple", groups: [], frames: [], frame: "phone" } as Doc;

afterAll(async () => {
  await removeDesignDir();
});

describe("design store", () => {
  it("writes a design, bumps its revision, and lists the newest first", async () => {
    const first = await createDesign({ ...doc, title: "First" });
    expect(isDesignId(first.id)).toBe(true);
    expect(first.rev).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await createDesign({ ...doc, title: "Second" });

    expect((await readDesign(first.id))?.doc.title).toBe("First");
    const names = (await listDesigns()).map((row) => row.title);
    expect(names[0]).toBe("Second");
    expect(names).toContain("First");

    const bumped = await updateDesign(first.id, 1, { ...doc, title: "First edited" });
    expect(bumped.ok).toBe(true);
    if (!bumped.ok) return;
    expect(bumped.record.rev).toBe(2);
    expect((await readDesign(first.id))?.doc.title).toBe("First edited");

    const stale = await updateDesign(first.id, 1, { ...doc, title: "Lost" });
    expect(stale.ok).toBe(false);
    if (stale.ok || !("conflict" in stale)) return;
    expect(stale.conflict.rev).toBe(2);
    expect(stale.conflict.doc.title).toBe("First edited");
  });

  it("rejects an id that could leave the design directory", async () => {
    expect(isDesignId("../secret")).toBe(false);
    expect(isDesignId("a/b/c")).toBe(false);
    expect(isDesignId("short")).toBe(false);
    expect(await readDesign("../secret")).toBeNull();
    const missing = await updateDesign("../../etc/passwd", 1, doc);
    expect(missing).toEqual({ ok: false, missing: true });
  });

  it("skips a file that is not a design", async () => {
    await mkdir(dir, { recursive: true });
    writeFileSync(path.join(dir, "not-json.json"), "{");
    await writeFile(path.join(dir, "also-bad.json"), JSON.stringify({ rev: "nope" }));
    const rows = await listDesigns();
    expect(rows.every((row) => row.id !== "not-json" && row.id !== "also-bad")).toBe(true);
  });
});
