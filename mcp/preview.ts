import { frameOfGroup, frameSizeOf, normalizeTheme, paletteOf, type Doc, type Frame, type Item } from "../lib/tokens";

const esc = (value: string) =>
  value.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));

/** A self-contained HTML sketch of the screens. MCP Apps can frame this without
 *  reaching the canvas; the screenshot tool is what shows the real rendering. */
export function previewHtml(doc: Doc, opts: { id: string; url?: string } = { id: "" }): string {
  const palette = paletteOf(doc.paletteKey, doc.customPalette, normalizeTheme(doc.theme));
  const screens = doc.frames.map((frame) => screenHtml(doc, frame, palette)).join("");
  const open = opts.url ? `<p class="open"><a href="${esc(opts.url)}">Open the live canvas</a></p>` : "";
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(doc.title || "M3E Canvas")}</title>
<style>
  :root { color-scheme: ${normalizeTheme(doc.theme).dark ? "dark" : "light"}; }
  body { margin: 0; background: ${palette.surfaceContainerLow}; color: ${palette.onSurface}; font: 14px/1.4 system-ui, sans-serif; }
  header { padding: 16px 20px 0; }
  h1 { font-size: 18px; margin: 0; }
  p { margin: 4px 0 0; color: ${palette.onSurfaceVariant}; }
  .row { display: flex; gap: 16px; overflow-x: auto; padding: 16px 20px 28px; }
  .phone { width: 220px; flex: 0 0 auto; background: ${palette.surface}; border: 1px solid ${palette.outlineVariant}; border-radius: 20px; overflow: hidden; }
  .phone h2 { font-size: 12px; margin: 0; padding: 8px 10px; color: ${palette.onSurfaceVariant}; }
  .screen { min-height: 360px; display: flex; flex-direction: column; }
  .part { padding: 8px 12px; border-top: 1px solid ${palette.outlineVariant}; }
  .part b { font-weight: 600; }
  .kind { color: ${palette.onSurfaceVariant}; font-size: 11px; }
  .bar { background: ${palette.primaryContainer}; color: ${palette.onPrimaryContainer}; }
  .nav { margin-top: auto; background: ${palette.surfaceContainer}; }
  a { color: ${palette.primary}; }
</style>
</head>
<body>
<header>
  <h1>${esc(doc.title || "Untitled")}</h1>
  <p>${esc(doc.brief || "")}</p>
  ${open}
</header>
<div class="row">${screens || "<p>No screens yet.</p>"}</div>
</body>
</html>`;
}

function screenHtml(doc: Doc, frame: Frame, palette: ReturnType<typeof paletteOf>): string {
  const { w, h } = frameSizeOf(frame);
  const parts = doc.groups
    .filter((g) => frameOfGroup(g, doc.frames, {})?.id === frame.id)
    .flatMap((g) => g.items)
    .map((item) => partHtml(item))
    .join("");
  return `<section class="phone" style="background:${palette.surface}">
    <h2>${esc(frame.name)} · ${w}×${h}</h2>
    <div class="screen">${parts}</div>
  </section>`;
}

function partHtml(item: Item): string {
  const words = item.label.trim() || item.tabs?.map((tab) => tab.label).filter(Boolean).join(" · ") || "";
  const role = item.kind === "topAppBar" || item.kind === "tabs" ? "bar" : item.kind === "bottomNav" ? "nav" : "";
  return `<div class="part ${role}"><div class="kind">${esc(item.kind)} ${esc(item.id)}</div><b>${esc(words)}</b></div>`;
}
