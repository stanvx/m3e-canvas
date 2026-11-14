import { createMcpHandler, McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";
import { PALETTES } from "../lib/tokens";
import { screenshotDesign } from "./screenshot";
import { createFromDraft, editStored, guideText, listStored, previewFor, readStored, themeStored } from "./service";

const paletteKeys = [...PALETTES.map((p) => p.key), "custom"] as unknown as [string, ...string[]];

const operation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set_doc"), doc: z.record(z.string(), z.unknown()), tidy: z.boolean().optional() }).describe("Replace the design with a new document."),
  z.object({
    op: z.literal("add_screen"),
    frame: z.record(z.string(), z.unknown()).describe("Screen. name is required. Omit x and y to place it to the right."),
    parts: z.array(z.record(z.string(), z.unknown())).optional().describe("Parts to stack on the new screen, each a part object."),
  }),
  z.object({ op: z.literal("update_screen"), id: z.string(), patch: z.record(z.string(), z.unknown()).describe("Fields to change. null clears a field. Moving x or y moves the screen's parts.") }),
  z.object({ op: z.literal("remove_screen"), id: z.string() }).describe("Delete a screen, its parts, and links that pointed at it."),
  z.object({
    op: z.literal("add_part"),
    screen: z.string(),
    part: z.record(z.string(), z.unknown()).describe("A part. kind is required. label, icon and variant are filled in when omitted."),
    x: z.number().optional(),
    y: z.number().optional(),
    axis: z.enum(["x", "y"]).optional(),
  }).describe("Add a part. Omit x and y to stack it and tidy the screen. With x and y, they are relative to the screen."),
  z.object({ op: z.literal("update_part"), id: z.string(), patch: z.record(z.string(), z.unknown()).describe("Fields to change. null clears a field.") }),
  z.object({ op: z.literal("remove_part"), id: z.string() }),
  z.object({
    op: z.literal("move_part"),
    id: z.string(),
    x: z.number(),
    y: z.number(),
    screen: z.string().optional().describe("When set, x and y are relative to this screen."),
  }),
  z.object({ op: z.literal("tidy"), screen: z.string().optional().describe("Omit to tidy every screen.") }),
]);

const ui = (id?: string) => ({ ui: { resourceUri: id ? `ui://m3e/design/${id}` : "ui://m3e/design/{id}" } });

type Result = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean; _meta?: Record<string, unknown> };

function textResult(text: string, extra?: { id?: string; data?: Record<string, unknown>; error?: boolean }): Result {
  return {
    content: [{ type: "text", text }],
    structuredContent: extra?.data,
    isError: extra?.error,
    _meta: extra?.id ? ui(extra.id) : undefined,
  };
}

/** Stateless MCP handler. `base` is the canvas origin used in links. */
export function mcpHandler(base: () => string) {
  return createMcpHandler(() => {
    const server = new McpServer({ name: "m3e-canvas", version: "0.1.0" });
    const origin = () => base().replace(/\/$/, "");

    server.registerTool(
      "m3e_get_guide",
      {
        title: "Read the design guide",
        description: "The M3E Canvas document format, plus how these tools place, tidy and store a design. Read this before creating a design.",
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async () => textResult(guideText()),
    );

    server.registerTool(
      "m3e_create_design",
      {
        title: "Create a design",
        description: "Validate a design, place anything that omitted coordinates, tidy it, and store it. Returns an id, a live canvas url, and an outline. Read m3e_get_guide for the document shape. A group may set screen to a frame id and omit x and y.",
        inputSchema: z.object({
          doc: z.record(z.string(), z.unknown()).describe("The design document: title, brief, paletteKey, theme, frames, groups."),
          tidy: z.boolean().optional().describe("Set false to keep the coordinates you sent. Default true."),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        _meta: ui(),
      },
      async ({ doc, tidy }) => {
        const result = await createFromDraft(doc, origin(), tidy !== false);
        if (!result.ok) return textResult(result.text, { error: true, data: { problems: result.problems } });
        return textResult(result.text, { id: result.id, data: { id: result.id, rev: result.rev, url: result.url, share: result.share, outline: result.outline } });
      },
    );

    server.registerTool(
      "m3e_get_design",
      {
        title: "Read a design",
        description: "Read a stored design. outline is the short form an edit should start from. prompt is the coding prompt for one screen or the whole app. json is the document.",
        inputSchema: z.object({
          id: z.string(),
          format: z.enum(["outline", "prompt", "json"]).optional().describe("Default outline."),
          screen: z.string().optional().describe("Limit the reading to this frame id."),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: ui(),
      },
      async ({ id, format, screen }) => {
        const result = await readStored(id, format ?? "outline", screen, origin());
        if (!result.ok) return textResult(result.text, { error: true });
        return textResult(result.text, { id, data: { id, rev: result.rev, url: result.url } });
      },
    );

    server.registerTool(
      "m3e_edit_design",
      {
        title: "Edit a design",
        description: "Apply a batch of operations to a stored design. The batch is saved only when every operation is valid. Use m3e_get_design first so ids match the current design.",
        inputSchema: z.object({ id: z.string(), operations: z.array(operation).min(1) }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        _meta: ui(),
      },
      async ({ id, operations }) => {
        const result = await editStored(id, operations, origin());
        if (!result.ok) return textResult(result.text, { error: true, data: { problems: result.problems } });
        return textResult(result.text, { id, data: { id, rev: result.rev, url: result.url, outline: result.outline } });
      },
    );

    server.registerTool(
      "m3e_set_theme",
      {
        title: "Set the theme",
        description: "Change the palette, or build a custom palette from a seed colour, and set shape, type, motion and contrast. A named paletteKey clears a custom palette.",
        inputSchema: z.object({
          id: z.string(),
          paletteKey: z.enum(paletteKeys).optional(),
          seed: z.string().optional().describe("Hex colour, for example #6750A4. Becomes the custom palette."),
          dark: z.boolean().optional(),
          bothModes: z.boolean().optional(),
          contrast: z.enum(["standard", "medium", "high"]).optional(),
          shape: z.enum(["square", "rounded", "full"]).optional(),
          font: z.enum(["roboto", "robotoFlex", "robotoSerif", "system"]).optional(),
          emphasized: z.boolean().optional(),
          motion: z.enum(["standard", "expressive"]).optional(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: ui(),
      },
      async ({ id, ...patch }) => {
        const result = await themeStored(id, patch, origin());
        if (!result.ok) return textResult(result.text, { error: true, data: { problems: result.problems } });
        return textResult(result.text, { id, data: { id, rev: result.rev, url: result.url, outline: result.outline } });
      },
    );

    server.registerTool(
      "m3e_screenshot",
      {
        title: "Photograph a screen",
        description: "Render one screen in the canvas and return a PNG. Use it to check spacing, bars and labels. Pass a frame id, or omit it for the first screen.",
        inputSchema: z.object({ id: z.string(), screen: z.string().optional() }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: ui(),
      },
      async ({ id, screen }) => {
        const current = await readStored(id, "outline", screen, origin());
        if (!current.ok) return textResult(current.text, { error: true });
        const shot = screen ? `?shot=${encodeURIComponent(screen)}` : "?shot=";
        const pictured = await screenshotDesign(`${origin()}/d/${id}/${shot}`);
        if ("error" in pictured) return textResult(pictured.error, { error: true, id });
        return {
          content: [
            { type: "text" as const, text: `Screenshot of ${id}${screen ? ` / ${screen}` : ""}.` },
            { type: "image" as const, data: pictured.png.toString("base64"), mimeType: "image/png" },
          ],
          _meta: ui(id),
        };
      },
    );

    server.registerTool(
      "m3e_list_designs",
      {
        title: "List stored designs",
        description: "Ids, titles and revisions of the designs stored on this server, newest first.",
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async () => {
        const result = await listStored();
        return textResult(result.text, { data: { designs: result.designs } });
      },
    );

    server.registerResource(
      "design-preview",
      new ResourceTemplate("ui://m3e/design/{id}", { list: undefined }),
      { mimeType: "text/html;profile=mcp-app", description: "Inline HTML preview of a stored M3E Canvas design." },
      async (uri, variables) => {
        const raw = variables.id;
        const id = Array.isArray(raw) ? raw[0] : raw;
        const html = id ? await previewFor(id, origin()) : null;
        if (!html) throw new Error(`No design has id "${id ?? ""}".`);
        return { contents: [{ uri: uri.href, mimeType: "text/html;profile=mcp-app", text: html }] };
      },
    );

    server.registerPrompt(
      "sketch",
      {
        title: "Sketch an app",
        description: "Ask for a Material 3 Expressive sketch, then store it with the M3E tools.",
        argsSchema: z.object({ brief: z.string().describe("What the app is and which screens it needs.") }),
      },
      ({ brief }) => ({
        messages: [{
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Read m3e_get_guide, then create the design with m3e_create_design. Check it with m3e_screenshot and fix it with m3e_edit_design.\n\n${brief}`,
          },
        }],
      }),
    );

    return server;
  }, { responseMode: "json" });
}
