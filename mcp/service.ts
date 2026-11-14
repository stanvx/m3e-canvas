import { readFileSync } from "node:fs";
import path from "node:path";
import { applyOps, applyTheme, formatProblems, outline, platformOf, prepare, type Prepared, type ThemePatch } from "../lib/agent";
import { createDesign, listDesigns, readDesign, updateDesign, type DesignRecord } from "../lib/designStore";
import { buildPrompt } from "../lib/prompt";
import { shareLink } from "../lib/share";
import { frameOfGroup, type Doc } from "../lib/tokens";
import { previewHtml } from "./preview";

export const GUIDE_ADDENDUM = `
## When you are connected to the M3E Canvas MCP server

Do not build a share link yourself. Use the tools. They check the document and tell you what to fix.

- \`m3e_create_design\` stores a document and returns its id and live url. You may omit \`x\` and \`y\`. Put \`"screen": "<frame id>"\` on a group to stack it on that screen; Tidy then pins bars and lays the body out. Screens that omit \`x\` and \`y\` sit 80dp apart. Coordinates without \`screen\` stay canvas coordinates, as in the guide above.
- \`m3e_edit_design\` changes a stored design. Send \`operations\`: \`add_screen\`, \`update_screen\`, \`remove_screen\`, \`add_part\`, \`update_part\`, \`remove_part\`, \`move_part\`, \`tidy\`, \`set_doc\`. A patch value of \`null\` clears that field. The batch is saved only when every step is valid.
- \`m3e_set_theme\` sets \`paletteKey\`, or a \`seed\` hex such as \`#6750A4\` for a custom palette, plus \`shape\`, \`font\`, \`motion\`, \`contrast\`, \`dark\`, \`bothModes\` and \`emphasized\`.
- \`m3e_get_design\` reads a design back as an outline, the coding prompt, or JSON.
- \`m3e_screenshot\` returns a PNG of one screen so you can look at it.
- The same call carries an inline preview. The live url opens the canvas, and edits from you and from the person on that page share the one design.
`.trim();

export function guideText(): string {
  const guide = readFileSync(path.join(process.cwd(), "public", "agent.md"), "utf8");
  return `${guide}\n\n${GUIDE_ADDENDUM}\n`;
}

function receipt(record: DesignRecord, base: string) {
  const root = base.replace(/\/$/, "");
  return { id: record.id, rev: record.rev, url: `${root}/d/${record.id}/` };
}

function fail(prepared: Extract<Prepared, { ok: false }>) {
  return { ok: false as const, problems: prepared.problems, text: formatProblems(prepared.problems) };
}

export async function createFromDraft(input: unknown, base: string, tidy = true) {
  const prepared = prepare(input, { tidy });
  if (!prepared.ok) return fail(prepared);
  const record = await createDesign(prepared.doc);
  const view = receipt(record, base);
  return { ok: true as const, ...view, text: createdText(view) };
}

function createdText(view: ReturnType<typeof receipt>): string {
  return `Stored ${view.id} (rev ${view.rev}).\nLive canvas: ${view.url}`;
}

export async function editStored(id: string, operations: unknown, base: string) {
  const current = await readDesign(id);
  if (!current) return { ok: false as const, problems: [{ path: "id", message: `No design has id "${id}".` }], text: `No design has id "${id}".` };
  const prepared = applyOps(current.doc, operations);
  if (!prepared.ok) return fail(prepared);
  const written = await updateDesign(id, current.rev, prepared.doc);
  if (!written.ok) {
    const message = "missing" in written ? `No design has id "${id}".` : `Design ${id} changed (now rev ${written.conflict.rev}). Read it again and retry.`;
    return { ok: false as const, problems: [{ path: "id", message }], text: message };
  }
  const view = receipt(written.record, base);
  return { ok: true as const, ...view, text: createdText(view) };
}

export async function themeStored(id: string, patch: ThemePatch, base: string) {
  const current = await readDesign(id);
  if (!current) return { ok: false as const, problems: [{ path: "id", message: `No design has id "${id}".` }], text: `No design has id "${id}".` };
  const prepared = applyTheme(current.doc, patch);
  if (!prepared.ok) return fail(prepared);
  const written = await updateDesign(id, current.rev, prepared.doc);
  if (!written.ok) {
    const message = "missing" in written ? `No design has id "${id}".` : `Design ${id} changed (now rev ${written.conflict.rev}). Read it again and retry.`;
    return { ok: false as const, problems: [{ path: "id", message }], text: message };
  }
  const view = receipt(written.record, base);
  return { ok: true as const, ...view, text: createdText(view) };
}

export async function readStored(id: string, format: "outline" | "prompt" | "json", screen: string | undefined, base: string) {
  const current = await readDesign(id);
  if (!current) return { ok: false as const, text: `No design has id "${id}".` };
  if (screen && !current.doc.frames.some((f) => f.id === screen)) return { ok: false as const, text: `No screen has id "${screen}".` };
  const view = { ...receipt(current, base), share: await shareLink(current.doc, base.replace(/\/$/, "")), outline: outline(current.doc, screen) };
  if (format === "json") {
    const doc = screen ? projectScreen(current.doc, screen) : current.doc;
    return { ok: true as const, ...view, text: JSON.stringify(doc, null, 2) };
  }
  if (format === "prompt") {
    const text = buildPrompt({ ...current.doc, platform: platformOf(current.doc) }, {}, screen, "en");
    return { ok: true as const, ...view, text };
  }
  const text = `${view.url}\n\n${view.outline}`;
  return { ok: true as const, ...view, text };
}

function projectScreen(doc: Doc, screen: string): Doc {
  return {
    ...doc,
    frames: doc.frames.filter((f) => f.id === screen),
    groups: doc.groups.filter((g) => frameOfGroup(g, doc.frames, {})?.id === screen),
  };
}

export async function previewFor(id: string, base: string): Promise<string | null> {
  const current = await readDesign(id);
  if (!current) return null;
  const root = base.replace(/\/$/, "");
  return previewHtml(current.doc, { id, url: `${root}/d/${id}/` });
}

export async function listStored() {
  const rows = await listDesigns();
  const text = rows.length
    ? rows.map((row) => `${row.id}  rev ${row.rev}  ${row.title || "(untitled)"}  ${row.updatedAt}`).join("\n")
    : "No designs stored yet.";
  return { designs: rows, text };
}
