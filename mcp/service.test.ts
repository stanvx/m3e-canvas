import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { removeDesignDir } from "../lib/designStore";
import { createFromDraft, editStored, listStored, readStored, themeStored } from "./service";

const dir = mkdtempSync(path.join(tmpdir(), "m3e-service-"));
process.env.M3E_DATA_DIR = dir;

const draft = {
  title: "Recipes",
  brief: "Save and search recipes.",
  paletteKey: "purple",
  frames: [
    { id: "home", name: "Home" },
    { id: "detail", name: "Recipe" },
  ],
  groups: [
    { screen: "home", items: [{ id: "row", kind: "listItem", label: "Tomato soup", icon: "restaurant", action: { to: "detail", transition: "slide" } }] },
  ],
};

afterAll(async () => {
  await removeDesignDir();
});

describe("stored designs", () => {
  it("stores a draft, edits it, and refuses a dangling link", async () => {
    const created = await createFromDraft(draft, "http://canvas.test");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.url).toBe(`http://canvas.test/d/${created.id}/`);
    expect(created.rev).toBe(1);
    expect(created.outline).toMatch(/Tomato soup/);

    const read = await readStored(created.id, "outline", "home", "http://canvas.test");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.text).toMatch(/home \(Home\)/);
    expect(read.text).not.toMatch(/detail \(Recipe\)/);

    const edited = await editStored(created.id, [{ op: "update_part", id: "row", patch: { label: "Pea soup" } }], "http://canvas.test");
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.rev).toBe(2);
    expect(edited.outline).toMatch(/Pea soup/);

    const themed = await themeStored(created.id, { seed: "#6750A4", shape: "full" }, "http://canvas.test");
    expect(themed.ok).toBe(true);
    if (!themed.ok) return;
    expect(themed.outline).toMatch(/palette: custom/);
    expect(themed.outline).toMatch(/shape: full/);

    const listed = await listStored();
    expect(listed.designs.map((row) => row.id)).toContain(created.id);

    const broken = await createFromDraft({
      frames: [{ id: "home", name: "Home" }],
      groups: [{ screen: "home", items: [{ id: "go", kind: "button", label: "Open", icon: null, action: { to: "missing", transition: "fade" } }] }],
    }, "http://canvas.test");
    expect(broken.ok).toBe(false);
    if (broken.ok) return;
    expect(broken.text).toMatch(/missing/);
    expect((await listStored()).designs).toHaveLength(1);
  });
});
