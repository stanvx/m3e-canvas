import { z } from "zod";
import { CAROUSEL_LAYOUTS, COLOR_TOKENS, CONTRASTS, DATE_LAYOUTS, FONTS, KIND_ORDER, PALETTES, SHAPES, TEXT_TOKENS, TIME_LAYOUTS, TRANSITIONS, VARIANTS } from "../lib/tokens";

const id = z.string().min(1).describe("Optional; generated when omitted. Explicit ids must be unique across screens, groups and parts.");
const color = z.enum(COLOR_TOKENS.map((v) => v.key));
const variant = z.enum(VARIANTS.map((v) => v.key));
const action = z.strictObject({ to: z.string().describe('Screen id, "back", "link" or "menu".'), transition: z.enum(TRANSITIONS.map((v) => v.key)), url: z.string().optional() });
const corners = z.strictObject({ tl: z.number(), tr: z.number(), bl: z.number(), br: z.number() });

export const themeSchema = z.strictObject({
  dark: z.boolean().optional(), bothModes: z.boolean().optional(),
  contrast: z.enum(CONTRASTS.map((v) => v.key)).optional(),
  shape: z.enum(SHAPES.map((v) => v.key)).optional(),
  font: z.enum(FONTS.map((v) => v.key)).optional(),
  emphasized: z.boolean().optional(), motion: z.enum(["standard", "expressive"]).optional(),
});

export const partSchema = z.strictObject({
  id: id.optional(), kind: z.enum(KIND_ORDER),
  label: z.string().optional(), icon: z.string().nullable().optional().describe("Material symbol name, or null."),
  icon2: z.string().nullable().optional(), variant: variant.optional(), supporting: z.string().optional(),
  size: z.number().optional().describe("Width in dp for most parts; font size in sp for text; diameter for square controls."),
  size2: z.number().optional().describe("Height in dp for cards, boxes, images and buttons."),
  wrapWidth: z.number().positive().optional().describe("Text only: wrap within this width in dp; omitted keeps one line."),
  radiusTop: z.number().optional(), radiusBottom: z.number().optional(), corners: corners.optional(),
  tabs: z.array(z.strictObject({ label: z.string(), icon: z.string().nullable().optional(), src: z.string().optional() })).optional(),
  selected: z.number().optional().describe("Selected destination index for navigation, tabs and selects."),
  checked: z.boolean().optional().describe("Selection state for cards, chips, radios, checkboxes and switches."),
  switch: z.boolean().optional(), noImage: z.boolean().optional(),
  imagePos: z.enum(["top", "bottom", "leading", "trailing", "background"]).optional(), imageSize: z.number().positive().optional(),
  contentAlign: z.enum(["start", "center", "end"]).optional(), textAlign: z.enum(["start", "center", "end"]).optional(),
  textColor: z.enum(TEXT_TOKENS.map((v) => v.key)).optional(),
  value: z.number().optional(), wavy: z.boolean().optional(), railExpanded: z.boolean().optional(), railModal: z.boolean().optional(),
  trackThickness: z.number().int().min(2).max(16).optional(), contained: z.boolean().optional(),
  note: z.string().optional(), noteHistory: z.array(z.string()).optional(), bold: z.boolean().optional(), collapseOnScroll: z.boolean().optional(),
  fill: color.optional(), iconFill: z.union([color, z.literal("none")]).optional(), src: z.string().optional(),
  action: action.optional(), actions: z.record(z.string(), action).optional(),
  toggle: z.strictObject({ icon: z.string().nullable().optional(), variant: variant.optional(), label: z.string().optional() }).optional(),
  layout: z.enum([...CAROUSEL_LAYOUTS, ...DATE_LAYOUTS, ...TIME_LAYOUTS].map((v) => v.key)).optional(), count: z.number().optional(),
});

export const frameSchema = z.strictObject({
  id: id.optional(), name: z.string(), x: z.number().optional(), y: z.number().optional(),
  w: z.number().positive().optional(), h: z.number().positive().optional(), length: z.number().positive().optional(),
  bg: color.optional(), note: z.string().optional(), noteHistory: z.array(z.string()).optional(), place: z.enum(["top", "center", "bottom", "spread"]).optional(),
  swipe: z.strictObject({ left: z.string().optional(), right: z.string().optional(), up: z.string().optional(), down: z.string().optional() }).optional(),
});

export const documentSchema = z.strictObject({
  title: z.string().optional(), brief: z.string().optional(),
  paletteKey: z.enum([...PALETTES.map((v) => v.key), "custom"]).optional(),
  customPalette: z.record(z.string(), z.string()).optional(), dynamicColor: z.boolean().optional(),
  theme: themeSchema.optional(), frame: z.enum(["blank", "phone"]).optional(), platform: z.enum(["android", "web"]).optional(),
  promptEdit: z.string().optional(), promptOptions: z.array(z.string()).optional(),
  frames: z.array(frameSchema),
  groups: z.array(z.strictObject({
    id: id.optional(), screen: z.string().optional().describe("Frame id; x/y are relative to it. Omit x/y to stack and tidy."),
    x: z.number().optional(), y: z.number().optional(), axis: z.enum(["x", "y"]).optional(),
    locked: z.boolean().optional(), free: z.boolean().optional(),
    pos: z.record(z.string(), z.strictObject({ x: z.number(), y: z.number() })).optional(), items: z.array(partSchema).min(1),
  })),
});

// Patches clear optional fields with null; the shared validator checks the resulting document.
export const partPatchSchema = partSchema.omit({ id: true, noteHistory: true }).partial().extend(
  Object.fromEntries(Object.entries(partSchema.omit({ id: true, noteHistory: true }).shape).map(([key, value]) => [key, value.nullable().optional()])),
);
export const framePatchSchema = frameSchema.omit({ id: true, noteHistory: true }).partial().extend(
  Object.fromEntries(Object.entries(frameSchema.omit({ id: true, noteHistory: true }).shape).map(([key, value]) => [key, value.nullable().optional()])),
);
