import { describe, expect, it } from "vitest";
import { applyOps, applyTheme, explain, formatProblems, outline, prepare } from "./agent";
import { isProject } from "./project";
import { frameRect, groupBounds, type Doc } from "./tokens";

const home = {
  title: "Recipes",
  brief: "Save and search recipes.",
  paletteKey: "purple",
  theme: { shape: "rounded", font: "roboto", motion: "expressive", contrast: "standard", dark: false, bothModes: true, emphasized: false },
  frames: [
    { id: "home", name: "Home", note: "Lists the saved recipes." },
    { id: "detail", name: "Recipe" },
  ],
  groups: [
    { screen: "home", items: [{ id: "bar", kind: "topAppBar", label: "Recipes", icon: "menu", icon2: "search" }] },
    { screen: "home", items: [{ id: "row", kind: "listItem", label: "Tomato soup", supporting: "30 min", icon: "restaurant", action: { to: "detail", transition: "slide" } }] },
    { screen: "home", items: [{ id: "nav", kind: "bottomNav", label: "", icon: null, tabs: [{ label: "Home", icon: "home" }, { label: "Search", icon: "search" }, { label: "Saved", icon: "bookmark" }] }] },
    { screen: "detail", items: [{ id: "dbar", kind: "topAppBar", label: "Soup", icon: "arrow_back", action: { to: "back", transition: "slideLeft" } }] },
  ],
};

const part = (doc: Doc, id: string) => {
  const group = doc.groups.find((g) => g.items.some((it) => it.id === id));
  if (!group) throw new Error(`missing ${id}`);
  return group;
};

describe("prepare", () => {
  it("places omitted screens 80 apart and pins bars to the edges", () => {
    const result = prepare(home);
    expect(result.ok, result.ok ? "" : formatProblems(result.problems)).toBe(true);
    if (!result.ok) return;
    expect(isProject(result.doc)).toBe(true);
    expect(result.doc.frames.map((f) => f.x)).toEqual([0, 412 + 80]);
    const frame = result.doc.frames[0];
    const bar = groupBounds(part(result.doc, "bar"), {});
    const nav = groupBounds(part(result.doc, "nav"), {});
    const rect = frameRect(frame);
    expect(bar.t).toBe(rect.t);
    expect(nav.b).toBe(rect.b);
    expect(groupBounds(part(result.doc, "row"), {}).t).toBeGreaterThan(bar.b);
    expect(part(result.doc, "row").items[0].action?.to).toBe("detail");
  });

  it("keeps canvas coordinates that name no screen", () => {
    const result = prepare({
      frames: [{ id: "home", name: "Home", x: 0, y: 0 }],
      groups: [{ id: "g", x: 16, y: 120, axis: "y", items: [{ id: "t", kind: "text", label: "Hello", icon: null, variant: "filled" }] }],
    });
    expect(result.ok, result.ok ? "" : formatProblems(result.problems)).toBe(true);
    if (!result.ok) return;
    expect(part(result.doc, "t").items[0].label).toBe("Hello");
  });

  it("reports a dangling action and a duplicate id", () => {
    const dangling = prepare({
      frames: [{ id: "home", name: "Home" }],
      groups: [{ screen: "home", items: [{ id: "go", kind: "button", label: "Open", icon: null, action: { to: "missing", transition: "fade" } }] }],
    });
    expect(dangling.ok).toBe(false);
    if (dangling.ok) return;
    expect(formatProblems(dangling.problems)).toMatch(/missing/);

    const dup = prepare({
      frames: [{ id: "home", name: "Home" }, { id: "home", name: "Other" }],
      groups: [],
    });
    expect(dup.ok).toBe(false);
    if (dup.ok) return;
    expect(formatProblems(dup.problems)).toMatch(/already used/);
  });

  it("accepts a document explain already cleared", () => {
    const result = prepare(home);
    if (!result.ok) throw new Error(formatProblems(result.problems));
    expect(explain(result.doc)).toEqual([]);
  });
});

describe("edits", () => {
  const ready = () => {
    const result = prepare(home);
    if (!result.ok) throw new Error(formatProblems(result.problems));
    return result.doc;
  };

  it("adds, updates and removes a part, and refuses the whole batch when one step is bad", () => {
    const doc = ready();
    const added = applyOps(doc, [{ op: "add_part", screen: "detail", part: { id: "note", kind: "text", label: "A note", icon: null } }]);
    expect(added.ok, added.ok ? "" : formatProblems(added.problems)).toBe(true);
    if (!added.ok) return;
    expect(part(added.doc, "note").items[0].label).toBe("A note");

    const renamed = applyOps(added.doc, [{ op: "update_part", id: "note", patch: { label: "Updated", note: "for the cook" } }]);
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(part(renamed.doc, "note").items[0].note).toBe("for the cook");
    const cleared = applyOps(renamed.doc, [{ op: "update_part", id: "note", patch: { note: null } }]);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(part(cleared.doc, "note").items[0].note).toBeUndefined();

    const bad = applyOps(doc, [
      { op: "update_part", id: "row", patch: { label: "Changed" } },
      { op: "remove_part", id: "nope" },
    ]);
    expect(bad.ok).toBe(false);
    expect(part(doc, "row").items[0].label).toBe("Tomato soup");
  });

  it("removes a screen and the links that pointed at it", () => {
    const next = applyOps(ready(), [{ op: "remove_screen", id: "detail" }]);
    expect(next.ok, next.ok ? "" : formatProblems(next.problems)).toBe(true);
    if (!next.ok) return;
    expect(next.doc.frames.map((f) => f.id)).toEqual(["home"]);
    expect(part(next.doc, "row").items[0].action).toBeUndefined();
    expect(next.doc.groups.some((g) => g.items.some((it) => it.id === "dbar"))).toBe(false);
  });

  it("moves parts with a screen when the screen moves", () => {
    const next = applyOps(ready(), [{ op: "update_screen", id: "home", patch: { x: 40, y: 10 } }]);
    expect(next.ok, next.ok ? "" : formatProblems(next.problems)).toBe(true);
    if (!next.ok) return;
    const before = ready();
    const dx = part(next.doc, "bar").x - part(before, "bar").x;
    expect(dx).toBe(40);
    expect(part(next.doc, "bar").y - part(before, "bar").y).toBe(10);
  });

  it("builds a custom palette from a seed and a preset clears it", () => {
    const seeded = applyTheme(ready(), { seed: "#6750A4", shape: "full", motion: "expressive" });
    expect(seeded.ok, seeded.ok ? "" : formatProblems(seeded.problems)).toBe(true);
    if (!seeded.ok) return;
    expect(seeded.doc.paletteKey).toBe("custom");
    expect(seeded.doc.customPalette?.seed?.toLowerCase()).toBe("#6750a4");
    expect(seeded.doc.theme?.shape).toBe("full");
    const named = applyTheme(seeded.doc, { paletteKey: "teal" });
    expect(named.ok).toBe(true);
    if (!named.ok) return;
    expect(named.doc.paletteKey).toBe("teal");
    expect(named.doc.customPalette).toBeUndefined();
    const broken = applyTheme(seeded.doc, { seed: "purple" });
    expect(broken.ok).toBe(false);
  });

  it("outlines the screens and the navigation", () => {
    const text = outline(ready());
    expect(text).toMatch(/Recipes — Save and search recipes/);
    expect(text).toMatch(/home \(Home\)/);
    expect(text).toMatch(/Tomato soup/);
    expect(text).toMatch(/→ detail slide/);
    expect(text).toMatch(/shape: rounded/);
  });
});
