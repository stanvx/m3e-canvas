import { describe, expect, it } from "vitest";
import { prepare } from "../lib/agent";
import { KIND_ORDER, makeItem } from "../lib/tokens";
import { documentSchema, framePatchSchema, partPatchSchema, partSchema } from "./schema";

describe("MCP authoring schemas", () => {
  it("accepts defaults for every kind and a document the editor can read", () => {
    for (const kind of KIND_ORDER) expect(partSchema.safeParse(makeItem(kind)).success, kind).toBe(true);
    const draft = { frames: [{ id: "home", name: "Home" }], groups: [{ screen: "home", items: [{ kind: "button", label: "Save" }] }] };
    const parsed = documentSchema.parse(draft);
    expect(prepare(parsed).ok).toBe(true);
    const prepared = prepare(parsed);
    if (prepared.ok) expect(documentSchema.safeParse(prepared.doc).success).toBe(true);
  });

  it("rejects misspelled fields and invalid enums without silently dropping them", () => {
    expect(partSchema.safeParse({ kind: "button", varient: "tonal" }).success).toBe(false);
    expect(partSchema.safeParse({ kind: "button", variant: "bright" }).success).toBe(false);
    expect(partSchema.safeParse({ label: "Save" }).success).toBe(false);
    expect(partPatchSchema.parse({ wrapWidth: null, checked: true })).toEqual({ wrapWidth: null, checked: true });
    expect(framePatchSchema.parse({ name: "Changed", length: null })).toEqual({ name: "Changed", length: null });
    expect(partPatchSchema.safeParse({ id: "new-id" }).success).toBe(false);
  });
});
