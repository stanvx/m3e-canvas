import { isHex, schemeFromSeed } from "./color";
import { isProject } from "./project";
import { tidyFrame } from "./tidy";
import {
  BACK_TARGET,
  CAROUSEL_LAYOUTS,
  COLOR_TOKENS,
  CONTRASTS,
  DATE_LAYOUTS,
  FONTS,
  KIND_ORDER,
  KIND_SPEC,
  LINK_TARGET,
  MENU_TARGET,
  PALETTES,
  PHONE_MARGIN,
  SHAPES,
  TIME_LAYOUTS,
  TRANSITIONS,
  VARIANTS,
  type Action,
  type Doc,
  type Frame,
  type Group,
  type Item,
  type Kind,
  type Palette,
  type Theme,
  defaultPlatformOf,
  frameLengthOf,
  frameOfGroup,
  frameSizeOf,
  groupBounds,
  isCardAlign,
  isCardImagePos,
  isPlace,
  isPlatform,
  isTextToken,
  isTrackThickness,
  makeItem,
  normalizeTheme,
  paletteOf,
} from "./tokens";

/* The part of the canvas an agent can run without a browser: check a document,
 * fill in the coordinates it left out, tidy, and edit a stored design by id.
 * The editor stays the place a person draws; this module never touches the DOM. */

/** How far apart the guide tells an agent to set neighbouring screens. */
const SCREEN_GAP = 80;
const STACK_GAP = 16;
const PROBLEM_CAP = 40;

/** Parts Tidy pins to an edge. Kept in step with `isAnchored` in lib/tidy.ts:
 *  a part named here is dropped at the screen's origin and left for Tidy. */
const ANCHORED: ReadonlySet<string> = new Set([
  "navRail", "topAppBar", "tabs", "bottomNav", "bottomSheet",
  "toolbar", "snackbar", "fab", "extendedFab", "fabMenu", "dialog",
]);

const KINDS = new Set<string>(KIND_ORDER);
const VARIANTS_SET = new Set<string>(VARIANTS.map((v) => v.key));
const TRANSITION_KEYS = new Set<string>(TRANSITIONS.map((t) => t.key));
const COLOR_KEYS = new Set<string>(COLOR_TOKENS.map((c) => c.key));
const PALETTE_KEYS = new Set<string>([...PALETTES.map((p) => p.key), "custom"]);
const LAYOUTS = new Set<string>([...CAROUSEL_LAYOUTS, ...DATE_LAYOUTS, ...TIME_LAYOUTS].map((l) => l.key));

const SPECIAL_TARGETS = new Set([BACK_TARGET, LINK_TARGET, MENU_TARGET]);

export type Problem = { path: string; message: string };

export type Prepared = { ok: true; doc: Doc } | { ok: false; problems: Problem[] };

export type ThemePatch = {
  paletteKey?: string;
  /** A hex colour. It becomes the document's custom palette. */
  seed?: string;
  dark?: boolean;
  bothModes?: boolean;
  contrast?: string;
  shape?: string;
  font?: string;
  emphasized?: boolean;
  motion?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const cap = (problems: Problem[]): Problem[] =>
  problems.length <= PROBLEM_CAP
    ? problems
    : [...problems.slice(0, PROBLEM_CAP), { path: "", message: `${problems.length - PROBLEM_CAP} more problems were left out.` }];

/** One line per problem, so a tool result can be read straight through. */
export function formatProblems(problems: Problem[]): string {
  return problems.map((p) => (p.path ? `${p.path}: ${p.message}` : p.message)).join("\n");
}

function itemProblems(item: unknown, path: string): Problem[] {
  if (!isRecord(item)) return [{ path, message: "A part must be an object." }];
  const out: Problem[] = [];
  const bad = (field: string, message: string) => out.push({ path: `${path}.${field}`, message });
  if (typeof item.id !== "string" || item.id.length === 0) bad("id", "Give the part an id string.");
  if (typeof item.kind !== "string" || !KINDS.has(item.kind)) bad("kind", `Use one of: ${KIND_ORDER.join(", ")}.`);
  if (typeof item.label !== "string") bad("label", "label must be a string. Use an empty string when a part has no words.");
  if (typeof item.icon !== "string" && item.icon !== null) bad("icon", "icon must be a Material symbol name, or null.");
  if (!VARIANTS_SET.has(String(item.variant))) bad("variant", `Use one of: ${[...VARIANTS_SET].join(", ")}.`);
  if (item.supporting !== undefined && typeof item.supporting !== "string") bad("supporting", "supporting must be a string.");
  if (item.note !== undefined && typeof item.note !== "string") bad("note", "note must be a string.");
  if (item.layout !== undefined && (typeof item.layout !== "string" || !LAYOUTS.has(item.layout))) {
    bad("layout", `layout must be one of: ${[...LAYOUTS].join(", ")}.`);
  }
  for (const key of ["size", "size2", "radiusTop", "radiusBottom", "value", "count", "selected", "imageSize"] as const) {
    const value = item[key];
    if (value !== undefined && !Number.isFinite(value)) bad(key, `${key} must be a finite number.`);
  }
  if (item.trackThickness !== undefined && !isTrackThickness(item.trackThickness)) bad("trackThickness", "trackThickness must be a whole number of dp from 2 to 16.");
  if (item.imagePos !== undefined && !isCardImagePos(item.imagePos)) bad("imagePos", "imagePos is not a card image position.");
  if (item.contentAlign !== undefined && !isCardAlign(item.contentAlign)) bad("contentAlign", "contentAlign must be start, center or end.");
  if (item.textAlign !== undefined && !isCardAlign(item.textAlign)) bad("textAlign", "textAlign must be start, center or end.");
  if (item.textColor !== undefined && !isTextToken(item.textColor)) bad("textColor", "textColor is not a text colour role.");
  if (item.corners !== undefined) {
    const c = item.corners;
    if (!isRecord(c) || !["tl", "tr", "bl", "br"].every((k) => Number.isFinite(c[k]))) bad("corners", "corners needs numeric tl, tr, bl and br.");
  }
  if (item.tabs !== undefined) {
    if (!Array.isArray(item.tabs) || !item.tabs.every((tab) => isRecord(tab) && typeof tab.label === "string" && (tab.icon === undefined || typeof tab.icon === "string" || tab.icon === null))) {
      bad("tabs", "tabs must be a list of { label, icon? }.");
    }
  }
  for (const key of ["railExpanded", "railModal", "collapseOnScroll"] as const) {
    if (item[key] !== undefined && typeof item[key] !== "boolean") bad(key, `${key} must be true or false.`);
  }
  return out;
}

function actionProblems(action: unknown, path: string, frames: Set<string>): Problem[] {
  if (!isRecord(action)) return [{ path, message: "An action must be an object with to and transition." }];
  const out: Problem[] = [];
  if (typeof action.to !== "string" || action.to.length === 0) out.push({ path: `${path}.to`, message: "to must be a screen id, \"back\", \"link\" or \"menu\"." });
  else if (!frames.has(action.to) && !SPECIAL_TARGETS.has(action.to)) {
    out.push({ path: `${path}.to`, message: `No screen has id "${action.to}". Use a screen id, "back", "link" or "menu".` });
  }
  if (typeof action.transition !== "string" || !TRANSITION_KEYS.has(action.transition)) {
    out.push({ path: `${path}.transition`, message: `transition must be one of: ${[...TRANSITION_KEYS].join(", ")}.` });
  }
  if (action.to === LINK_TARGET && (typeof action.url !== "string" || action.url.trim().length === 0)) {
    out.push({ path: `${path}.url`, message: "A link action needs a url." });
  }
  return out;
}

function groupProblems(group: unknown, path: string): Problem[] {
  if (!isRecord(group)) return [{ path, message: "A group must be an object." }];
  const out: Problem[] = [];
  if (typeof group.id !== "string" || group.id.length === 0) out.push({ path: `${path}.id`, message: "Give the group an id string." });
  if (!Number.isFinite(group.x)) out.push({ path: `${path}.x`, message: "x must be a finite number." });
  if (!Number.isFinite(group.y)) out.push({ path: `${path}.y`, message: "y must be a finite number." });
  if (group.axis !== "x" && group.axis !== "y") out.push({ path: `${path}.axis`, message: "axis must be \"x\" or \"y\"." });
  if (group.locked !== undefined && typeof group.locked !== "boolean") out.push({ path: `${path}.locked`, message: "locked must be true or false." });
  if (!Array.isArray(group.items) || group.items.length === 0) out.push({ path: `${path}.items`, message: "A group needs at least one part." });
  else group.items.forEach((item, i) => out.push(...itemProblems(item, `${path}.items[${i}]`)));
  return out;
}

function frameProblems(frame: unknown, path: string): Problem[] {
  if (!isRecord(frame)) return [{ path, message: "A screen must be an object." }];
  const out: Problem[] = [];
  if (typeof frame.id !== "string" || frame.id.length === 0) out.push({ path: `${path}.id`, message: "Give the screen an id string." });
  if (typeof frame.name !== "string") out.push({ path: `${path}.name`, message: "name must be a string." });
  if (!Number.isFinite(frame.x)) out.push({ path: `${path}.x`, message: "x must be a finite number." });
  if (!Number.isFinite(frame.y)) out.push({ path: `${path}.y`, message: "y must be a finite number." });
  if (frame.w !== undefined && !(Number.isFinite(frame.w) && (frame.w as number) > 0)) out.push({ path: `${path}.w`, message: "w must be a positive number. Omit it for a phone screen." });
  if (frame.h !== undefined && !(Number.isFinite(frame.h) && (frame.h as number) > 0)) out.push({ path: `${path}.h`, message: "h must be a positive number. Omit it for a phone screen." });
  if (frame.length !== undefined && !(Number.isFinite(frame.length) && (frame.length as number) > 0)) out.push({ path: `${path}.length`, message: "length must be a positive number of dp." });
  if (frame.note !== undefined && typeof frame.note !== "string") out.push({ path: `${path}.note`, message: "note must be a string." });
  if (frame.place !== undefined && !isPlace(frame.place)) out.push({ path: `${path}.place`, message: "place must be top, center, bottom or spread." });
  if (frame.bg !== undefined && (typeof frame.bg !== "string" || !COLOR_KEYS.has(frame.bg))) out.push({ path: `${path}.bg`, message: `bg must be one of: ${[...COLOR_KEYS].join(", ")}.` });
  return out;
}

/** Why a value is not a document the editor can open, including links to screens
 *  that are not there. An empty list means the document is usable. */
export function explain(value: unknown): Problem[] {
  if (!isRecord(value)) return [{ path: "", message: "The document must be an object with frames and groups." }];
  const out: Problem[] = [];
  if (!Array.isArray(value.frames)) out.push({ path: "frames", message: "frames must be an array of screens." });
  else value.frames.forEach((frame, i) => out.push(...frameProblems(frame, `frames[${i}]`)));
  if (!Array.isArray(value.groups)) out.push({ path: "groups", message: "groups must be an array." });
  else value.groups.forEach((group, i) => out.push(...groupProblems(group, `groups[${i}]`)));
  if (value.platform !== undefined && !isPlatform(value.platform)) out.push({ path: "platform", message: "platform must be \"android\" or \"web\"." });
  if (value.promptOptions !== undefined && !(Array.isArray(value.promptOptions) && value.promptOptions.every((o) => typeof o === "string"))) {
    out.push({ path: "promptOptions", message: "promptOptions must be an array of strings." });
  }
  if (typeof value.paletteKey === "string" && !PALETTE_KEYS.has(value.paletteKey)) {
    out.push({ path: "paletteKey", message: `paletteKey must be one of: ${[...PALETTE_KEYS].join(", ")}.` });
  }
  if (out.length > 0 || !Array.isArray(value.frames) || !Array.isArray(value.groups)) return cap(out);

  const frames = new Set<string>();
  const seen = new Map<string, string>();
  const dup = (id: string, path: string) => {
    const first = seen.get(id);
    if (first) out.push({ path, message: `id "${id}" is already used at ${first}. Ids are unique across screens, groups and parts.` });
    else seen.set(id, path);
  };
  value.frames.forEach((frame, i) => {
    if (isRecord(frame) && typeof frame.id === "string") {
      dup(frame.id, `frames[${i}].id`);
      frames.add(frame.id);
    }
  });
  value.groups.forEach((group, gi) => {
    if (!isRecord(group)) return;
    if (typeof group.id === "string") dup(group.id, `groups[${gi}].id`);
    if (!Array.isArray(group.items)) return;
    group.items.forEach((item, ii) => {
      if (!isRecord(item)) return;
      if (typeof item.id === "string") dup(item.id, `groups[${gi}].items[${ii}].id`);
      if (item.action !== undefined) out.push(...actionProblems(item.action, `groups[${gi}].items[${ii}].action`, frames));
      if (item.actions !== undefined) {
        if (!isRecord(item.actions)) out.push({ path: `groups[${gi}].items[${ii}].actions`, message: "actions must be an object of slot name to action." });
        else for (const [slot, action] of Object.entries(item.actions)) out.push(...actionProblems(action, `groups[${gi}].items[${ii}].actions.${slot}`, frames));
      }
    });
  });
  value.frames.forEach((frame, i) => {
    if (!isRecord(frame) || frame.swipe === undefined) return;
    if (!isRecord(frame.swipe)) {
      out.push({ path: `frames[${i}].swipe`, message: "swipe must be an object of direction to screen id." });
      return;
    }
    for (const [dir, to] of Object.entries(frame.swipe)) {
      if (dir !== "left" && dir !== "right" && dir !== "up" && dir !== "down") {
        out.push({ path: `frames[${i}].swipe.${dir}`, message: "A swipe direction is left, right, up or down." });
      }
      if (typeof to !== "string" || !frames.has(to)) out.push({ path: `frames[${i}].swipe.${dir}`, message: `No screen has id "${String(to)}".` });
    }
  });
  return cap(out);
}

type Tagged = { group: Group; screen?: string; auto: boolean };

function idsOf(doc: { frames: { id: string }[]; groups: Group[] }): Set<string> {
  const used = new Set<string>();
  for (const frame of doc.frames) used.add(frame.id);
  for (const group of doc.groups) {
    used.add(group.id);
    for (const item of group.items) used.add(item.id);
  }
  return used;
}

function freshId(used: Set<string>, prefix: string): string {
  let n = used.size + 1;
  let id = `${prefix}${n}`;
  while (used.has(id)) id = `${prefix}${++n}`;
  used.add(id);
  return id;
}

function takeId(raw: unknown, used: Set<string>, prefix: string, path: string, problems: Problem[]): string {
  if (typeof raw !== "string" || raw.trim().length === 0) return freshId(used, prefix);
  if (used.has(raw)) {
    problems.push({ path, message: `id "${raw}" is already used. Ids are unique across screens, groups and parts.` });
    return raw;
  }
  used.add(raw);
  return raw;
}

function materializeItem(raw: Record<string, unknown>, id: string, path: string, problems: Problem[]): Item | null {
  if (typeof raw.kind !== "string" || !KINDS.has(raw.kind)) {
    problems.push({ path: `${path}.kind`, message: `Use one of: ${KIND_ORDER.join(", ")}.` });
    return null;
  }
  const next: Record<string, unknown> = { ...makeItem(raw.kind as Kind), id };
  for (const [key, value] of Object.entries(raw)) {
    if (key === "kind" || value === undefined) continue;
    next[key] = value;
  }
  return next as Item;
}

function materializeGroup(raw: unknown, path: string, used: Set<string>, problems: Problem[]): Tagged | null {
  if (!isRecord(raw)) {
    problems.push({ path, message: "A group must be an object." });
    return null;
  }
  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    problems.push({ path: `${path}.items`, message: "A group needs at least one part." });
    return null;
  }
  const items: Item[] = [];
  raw.items.forEach((item, i) => {
    if (!isRecord(item)) {
      problems.push({ path: `${path}.items[${i}]`, message: "A part must be an object." });
      return;
    }
    const built = materializeItem(item, takeId(item.id, used, "p", `${path}.items[${i}].id`, problems), `${path}.items[${i}]`, problems);
    if (built) items.push(built);
  });
  if (items.length !== raw.items.length) return null;
  if (raw.axis !== undefined && raw.axis !== "x" && raw.axis !== "y") {
    problems.push({ path: `${path}.axis`, message: "axis must be \"x\" or \"y\"." });
    return null;
  }
  const screen = typeof raw.screen === "string" && raw.screen.length > 0 ? raw.screen : undefined;
  const hasX = Number.isFinite(raw.x);
  const hasY = Number.isFinite(raw.y);
  if (raw.x !== undefined && !hasX) problems.push({ path: `${path}.x`, message: "x must be a finite number. Omit both x and y to stack the group." });
  if (raw.y !== undefined && !hasY) problems.push({ path: `${path}.y`, message: "y must be a finite number. Omit both x and y to stack the group." });
  if ((raw.x === undefined) !== (raw.y === undefined)) {
    problems.push({ path, message: "Set both x and y, or neither. Neither stacks the group on its screen." });
  }
  const group: Group = {
    id: takeId(raw.id, used, "g", `${path}.id`, problems),
    x: hasX ? (raw.x as number) : 0,
    y: hasY ? (raw.y as number) : 0,
    axis: raw.axis === "y" ? "y" : "x",
    items,
  };
  if (typeof raw.locked === "boolean") group.locked = raw.locked;
  if (raw.free === true) group.free = true;
  if (isRecord(raw.pos)) group.pos = raw.pos as Group["pos"];
  return { group, screen, auto: raw.x === undefined && raw.y === undefined };
}

function materializeFrame(raw: unknown, path: string, used: Set<string>, problems: Problem[]): Frame | null {
  if (!isRecord(raw)) {
    problems.push({ path, message: "A screen must be an object." });
    return null;
  }
  if (typeof raw.name !== "string") {
    problems.push({ path: `${path}.name`, message: "Give the screen a name." });
    return null;
  }
  if ((raw.x === undefined) !== (raw.y === undefined)) {
    problems.push({ path, message: "Set both x and y, or neither. Neither places the screen to the right of the last one." });
    return null;
  }
  const frame: Frame = {
    id: takeId(raw.id, used, "s", `${path}.id`, problems),
    name: raw.name,
    x: Number.isFinite(raw.x) ? (raw.x as number) : Number.NaN,
    y: Number.isFinite(raw.y) ? (raw.y as number) : Number.NaN,
  };
  if (typeof raw.note === "string") frame.note = raw.note;
  if (isPlace(raw.place)) frame.place = raw.place;
  if (typeof raw.bg === "string") frame.bg = raw.bg as Frame["bg"];
  if (Number.isFinite(raw.w) && (raw.w as number) > 0) frame.w = raw.w as number;
  if (Number.isFinite(raw.h) && (raw.h as number) > 0) frame.h = raw.h as number;
  if (Number.isFinite(raw.length) && (raw.length as number) > 0) frame.length = raw.length as number;
  if (isRecord(raw.swipe)) frame.swipe = raw.swipe as Frame["swipe"];
  return frame;
}

/** Screens that omitted a position line up to the right of whatever is already placed. */
function placeFrames(frames: Frame[]) {
  let cursor = 0;
  let any = false;
  for (const frame of frames) {
    if (Number.isFinite(frame.x)) {
      cursor = Math.max(cursor, frame.x + frameSizeOf(frame).w + SCREEN_GAP);
      any = true;
    }
  }
  if (!any) cursor = 0;
  for (const frame of frames) {
    if (Number.isFinite(frame.x) && Number.isFinite(frame.y)) continue;
    frame.x = cursor;
    frame.y = 0;
    cursor += frameSizeOf(frame).w + SCREEN_GAP;
  }
}

/** Lengthen a screen so parts stacked under it still count as on it. Membership
 *  for this pass uses the horizontal centre, so a part hanging below the current
 *  bottom is not missed the way frameOfGroup would miss it. */
function grow(doc: Doc): Doc {
  let changed = false;
  const frames = doc.frames.map((frame) => {
    const width = frameSizeOf(frame).w;
    const mine = doc.groups.filter((g) => {
      const bb = groupBounds(g, {});
      const cx = (bb.l + bb.r) / 2;
      return cx >= frame.x && cx <= frame.x + width && bb.b > frame.y;
    });
    if (mine.length === 0) return frame;
    const bottom = Math.max(...mine.map((g) => groupBounds(g, {}).b));
    const limit = frame.y + frameLengthOf(frame);
    /* A bar sitting on the bottom edge is already inside. Only a part that hangs
     * past the edge lengthens the screen, with a margin so the last row can breathe. */
    if (bottom <= limit + 1) return frame;
    changed = true;
    return { ...frame, length: Math.ceil(bottom - frame.y + PHONE_MARGIN) };
  });
  return changed ? { ...doc, frames } : doc;
}

function finish(doc: Doc, tidyScreens: Set<string> | "all"): Prepared {
  doc = grow(doc);
  const problems = explain(doc);
  if (problems.length > 0 || !isProject(doc)) {
    if (problems.length === 0) problems.push({ path: "", message: "The document is not one the editor can open." });
    return { ok: false, problems };
  }
  let groups = doc.groups;
  const screens = tidyScreens === "all" ? doc.frames.map((f) => f.id) : [...tidyScreens];
  for (const id of screens) {
    const frame = doc.frames.find((f) => f.id === id);
    if (!frame) continue;
    try {
      const next = tidyFrame(groups, frame, doc.frames, {});
      if (next) groups = next;
    } catch (error) {
      return { ok: false, problems: [{ path: `frames`, message: `Tidy failed on "${frame.name}": ${error instanceof Error ? error.message : "unknown error"}.` }] };
    }
  }
  const tidied = grow(groups === doc.groups ? doc : { ...doc, groups });
  const after = explain(tidied);
  if (after.length > 0 || !isProject(tidied)) {
    if (after.length === 0) after.push({ path: "", message: "Tidying produced a document the editor cannot open." });
    return { ok: false, problems: after };
  }
  return { ok: true, doc: tidied };
}

function stack(tagged: Tagged[], frames: Frame[]): { groups: Group[] } {
  const byScreen = new Map<string, Tagged[]>();
  const groups: Group[] = [];
  for (const tag of tagged) {
    if (!tag.auto) {
      const frame = tag.screen ? frames.find((f) => f.id === tag.screen) : undefined;
      const group = frame ? { ...tag.group, x: tag.group.x + frame.x, y: tag.group.y + frame.y } : tag.group;
      groups.push(group);
      continue;
    }
    const screen = tag.screen ?? (frames.length === 1 ? frames[0].id : undefined);
    if (!screen) continue;
    const list = byScreen.get(screen) ?? [];
    list.push(tag);
    byScreen.set(screen, list);
  }
  for (const [screen, list] of byScreen) {
    const frame = frames.find((f) => f.id === screen);
    if (!frame) continue;
    const anchored = list.filter((tag) => ANCHORED.has(tag.group.items[0].kind));
    const body = list.filter((tag) => !ANCHORED.has(tag.group.items[0].kind));
    /* Anchored parts overlap the body on purpose. Tidy pulls them to their edges
     * and does not merge them into the body, so the stack can start at the top. */
    for (const tag of anchored) groups.push({ ...tag.group, x: frame.x, y: frame.y });
    let cursor = frame.y;
    for (const tag of body) {
      const group = { ...tag.group, x: frame.x, y: cursor };
      groups.push(group);
      cursor = groupBounds(group, {}).b + STACK_GAP;
    }
  }
  return { groups };
}

function baseDoc(raw: Record<string, unknown>, frames: Frame[], groups: Group[]): Doc {
  const theme = isRecord(raw.theme) ? normalizeTheme(raw.theme as Partial<Theme>) : undefined;
  const paletteKey = typeof raw.paletteKey === "string" ? raw.paletteKey : "purple";
  const doc: Doc = {
    title: typeof raw.title === "string" ? raw.title : "",
    brief: typeof raw.brief === "string" ? raw.brief : "",
    paletteKey,
    frame: "phone",
    frames,
    groups,
  };
  if (theme) doc.theme = theme;
  if (isPlatform(raw.platform)) doc.platform = raw.platform;
  if (typeof raw.dynamicColor === "boolean") doc.dynamicColor = raw.dynamicColor;
  if (Array.isArray(raw.promptOptions) && raw.promptOptions.every((o) => typeof o === "string")) doc.promptOptions = raw.promptOptions as string[];
  if (typeof raw.promptEdit === "string") doc.promptEdit = raw.promptEdit;
  if (isRecord(raw.customPalette) && typeof raw.customPalette.primary === "string") {
    doc.customPalette = paletteOf("custom", raw.customPalette as Palette, doc.theme);
  }
  return doc;
}

/** Turn an agent's draft into a document. Coordinates may be omitted: a group
 *  with `screen` is stacked on that screen, and screens without a position sit
 *  80dp apart. Set `tidy` to false to keep hand-placed coordinates. */
export function prepare(input: unknown, options: { tidy?: boolean } = {}): Prepared {
  if (!isRecord(input)) return { ok: false, problems: [{ path: "", message: "The document must be an object." }] };
  if (!Array.isArray(input.frames)) return { ok: false, problems: [{ path: "frames", message: "frames must be an array of screens." }] };
  if (!Array.isArray(input.groups)) return { ok: false, problems: [{ path: "groups", message: "groups must be an array." }] };
  const problems: Problem[] = [];
  const used = new Set<string>();
  const frames = input.frames.map((frame, i) => materializeFrame(frame, `frames[${i}]`, used, problems)).filter((f): f is Frame => f !== null);
  const tagged = input.groups.map((group, i) => materializeGroup(group, `groups[${i}]`, used, problems)).filter((g): g is Tagged => g !== null);
  if (frames.length !== input.frames.length || tagged.length !== input.groups.length || problems.length > 0) {
    return { ok: false, problems: cap(problems.length ? problems : [{ path: "", message: "The document could not be read." }]) };
  }
  const frameIds = new Set(frames.map((f) => f.id));
  for (const tag of tagged) {
    if (tag.screen && !frameIds.has(tag.screen)) {
      problems.push({ path: `groups`, message: `screen "${tag.screen}" does not match a frame id. Frames: ${[...frameIds].join(", ") || "(none)"}.` });
    }
    if (tag.auto && !tag.screen && frames.length !== 1) {
      problems.push({ path: `groups`, message: `A group without x and y needs a screen id${frames.length ? ` (${[...frameIds].join(", ")})` : ""}.` });
    }
  }
  if (problems.length > 0) return { ok: false, problems: cap(problems) };
  placeFrames(frames);
  const laid = stack(tagged, frames);
  const doc = grow(baseDoc(input, frames, laid.groups));
  const stray = doc.groups.filter((g) => !frameOfGroup(g, doc.frames, {}));
  if (stray.length > 0) {
    return { ok: false, problems: stray.map((g) => ({ path: `groups`, message: `Group "${g.id}" does not sit on a screen. Set screen, or place x and y inside one.` })) };
  }
  if (options.tidy === false) return finish(doc, new Set());
  return finish(doc, "all");
}

function clone(doc: Doc): Doc {
  return structuredClone(doc);
}

function dropLinks(doc: Doc, frameId: string): Doc {
  return {
    ...doc,
    frames: doc.frames
      .filter((f) => f.id !== frameId)
      .map((f) => {
        if (!f.swipe) return f;
        const swipe = Object.fromEntries(Object.entries(f.swipe).filter(([, to]) => to !== frameId));
        return { ...f, swipe: Object.keys(swipe).length ? swipe : undefined };
      }),
    groups: doc.groups
      .filter((g) => frameOfGroup(g, doc.frames, {})?.id !== frameId)
      .map((g) => ({
        ...g,
        items: g.items.map((it) => {
          const next = { ...it };
          if (next.action?.to === frameId) next.action = undefined;
          if (next.actions) {
            const actions = Object.fromEntries(Object.entries(next.actions).filter(([, a]) => a.to !== frameId));
            next.actions = Object.keys(actions).length ? actions : undefined;
          }
          return next;
        }),
      })),
  };
}

function patchRecord<T extends object>(base: T, patch: Record<string, unknown>, allowed: Set<string>, path: string): { value: T; problems: Problem[] } {
  const problems: Problem[] = [];
  const next: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (!allowed.has(key)) {
      problems.push({ path: `${path}.${key}`, message: `"${key}" cannot be patched here.` });
      continue;
    }
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return { value: next as T, problems };
}

const FRAME_PATCH = new Set(["name", "x", "y", "w", "h", "bg", "note", "swipe", "place", "length"]);
const ITEM_PATCH = new Set([
  "kind", "label", "icon", "icon2", "variant", "supporting", "size", "radiusTop", "radiusBottom", "corners", "tabs",
  "selected", "switch", "noImage", "imagePos", "imageSize", "contentAlign", "textAlign", "textColor", "checked",
  "value", "wavy", "railExpanded", "railModal", "trackThickness", "contained", "note", "bold", "size2",
  "collapseOnScroll", "fill", "iconFill", "src", "action", "actions", "toggle", "layout", "count",
]);

function findItem(doc: Doc, id: string): { gi: number; ii: number } | null {
  for (let gi = 0; gi < doc.groups.length; gi++) {
    const ii = doc.groups[gi].items.findIndex((it) => it.id === id);
    if (ii >= 0) return { gi, ii };
  }
  return null;
}

/** Apply a batch of edits. Nothing is returned changed unless every edit is usable. */
export function applyOps(doc: Doc, ops: unknown): Prepared {
  if (!Array.isArray(ops) || ops.length === 0) return { ok: false, problems: [{ path: "operations", message: "operations must be a non-empty array." }] };
  let current = clone(doc);
  const tidyScreens = new Set<string>();
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const path = `operations[${i}]`;
    if (!isRecord(op) || typeof op.op !== "string") return { ok: false, problems: [{ path, message: "An operation needs an op name." }] };
    const step = applyOne(current, op, path, tidyScreens);
    if (!step.ok) return step;
    current = step.doc;
  }
  return finish(current, tidyScreens);
}

function applyOne(doc: Doc, op: Record<string, unknown>, path: string, tidyScreens: Set<string>): Prepared {
  const used = idsOf(doc);
  if (op.op === "set_doc") {
    const next = prepare(op.doc, { tidy: op.tidy !== false });
    return next;
  }
  if (op.op === "tidy") {
    const screen = typeof op.screen === "string" ? op.screen : undefined;
    if (screen && !doc.frames.some((f) => f.id === screen)) return { ok: false, problems: [{ path: `${path}.screen`, message: `No screen has id "${screen}".` }] };
    if (screen) tidyScreens.add(screen);
    else for (const frame of doc.frames) tidyScreens.add(frame.id);
    return { ok: true, doc };
  }
  if (op.op === "add_screen") {
    const problems: Problem[] = [];
    const frame = materializeFrame(op.frame, `${path}.frame`, used, problems);
    if (!frame || problems.length) return { ok: false, problems: cap(problems.length ? problems : [{ path, message: "frame is required." }]) };
    const frames = [...doc.frames, frame];
    placeFrames(frames);
    const parts = Array.isArray(op.parts) ? op.parts : [];
    const tagged: Tagged[] = [];
    parts.forEach((part, pi) => {
      const group = materializeGroup({ screen: frame.id, items: [part] }, `${path}.parts[${pi}]`, used, problems);
      if (group) tagged.push(group);
    });
    if (problems.length) return { ok: false, problems: cap(problems) };
    const laid = stack([...doc.groups.map((group) => ({ group, auto: false })), ...tagged], frames);
    tidyScreens.add(frame.id);
    return { ok: true, doc: { ...doc, frames, groups: laid.groups } };
  }
  if (op.op === "update_screen") {
    if (typeof op.id !== "string") return { ok: false, problems: [{ path: `${path}.id`, message: "id must be the screen's id." }] };
    if (!isRecord(op.patch)) return { ok: false, problems: [{ path: `${path}.patch`, message: "patch must be an object. Use null to clear a field." }] };
    const index = doc.frames.findIndex((f) => f.id === op.id);
    if (index < 0) return { ok: false, problems: [{ path: `${path}.id`, message: `No screen has id "${op.id}".` }] };
    const before = doc.frames[index];
    const patched = patchRecord(before, op.patch, FRAME_PATCH, `${path}.patch`);
    if (patched.problems.length) return { ok: false, problems: patched.problems };
    const after = patched.value;
    const dx = (Number.isFinite(after.x) ? after.x : before.x) - before.x;
    const dy = (Number.isFinite(after.y) ? after.y : before.y) - before.y;
    const frames = doc.frames.map((f, i) => (i === index ? after : f));
    const groups = dx || dy
      ? doc.groups.map((g) => (frameOfGroup(g, doc.frames, {})?.id === before.id ? { ...g, x: g.x + dx, y: g.y + dy } : g))
      : doc.groups;
    return { ok: true, doc: { ...doc, frames, groups } };
  }
  if (op.op === "remove_screen") {
    if (typeof op.id !== "string") return { ok: false, problems: [{ path: `${path}.id`, message: "id must be the screen's id." }] };
    if (!doc.frames.some((f) => f.id === op.id)) return { ok: false, problems: [{ path: `${path}.id`, message: `No screen has id "${op.id}".` }] };
    return { ok: true, doc: dropLinks(doc, op.id) };
  }
  if (op.op === "add_part") {
    if (typeof op.screen !== "string") return { ok: false, problems: [{ path: `${path}.screen`, message: "screen must be a frame id." }] };
    if (!doc.frames.some((f) => f.id === op.screen)) return { ok: false, problems: [{ path: `${path}.screen`, message: `No screen has id "${op.screen}".` }] };
    const problems: Problem[] = [];
    const raw: Record<string, unknown> = { screen: op.screen, axis: op.axis, items: [op.part] };
    if (op.x !== undefined || op.y !== undefined) {
      raw.x = op.x;
      raw.y = op.y;
    }
    const tag = materializeGroup(raw, path, used, problems);
    if (!tag || problems.length) return { ok: false, problems: cap(problems.length ? problems : [{ path, message: "part must be an object with a kind." }]) };
    const laid = stack([...doc.groups.map((group) => ({ group, auto: false })), tag], doc.frames);
    if (tag.auto) tidyScreens.add(op.screen);
    return { ok: true, doc: { ...doc, groups: laid.groups } };
  }
  if (op.op === "update_part") {
    if (typeof op.id !== "string") return { ok: false, problems: [{ path: `${path}.id`, message: "id must be the part's id." }] };
    if (!isRecord(op.patch)) return { ok: false, problems: [{ path: `${path}.patch`, message: "patch must be an object. Use null to clear a field." }] };
    const at = findItem(doc, op.id);
    if (!at) return { ok: false, problems: [{ path: `${path}.id`, message: `No part has id "${op.id}".` }] };
    const patched = patchRecord(doc.groups[at.gi].items[at.ii], op.patch, ITEM_PATCH, `${path}.patch`);
    if (patched.problems.length) return { ok: false, problems: patched.problems };
    if (typeof patched.value.kind !== "string" || !KINDS.has(patched.value.kind)) {
      return { ok: false, problems: [{ path: `${path}.patch.kind`, message: `Use one of: ${KIND_ORDER.join(", ")}.` }] };
    }
    const groups = doc.groups.map((g, gi) => gi === at.gi ? { ...g, items: g.items.map((it, ii) => ii === at.ii ? patched.value : it) } : g);
    return { ok: true, doc: { ...doc, groups } };
  }
  if (op.op === "remove_part") {
    if (typeof op.id !== "string") return { ok: false, problems: [{ path: `${path}.id`, message: "id must be the part's id." }] };
    const at = findItem(doc, op.id);
    if (!at) return { ok: false, problems: [{ path: `${path}.id`, message: `No part has id "${op.id}".` }] };
    const groups = doc.groups.flatMap((g, gi) => {
      if (gi !== at.gi) return [g];
      const items = g.items.filter((it) => it.id !== op.id);
      if (items.length === 0) return [];
      const pos = g.pos ? { ...g.pos } : undefined;
      if (pos) delete pos[op.id as string];
      return [{ ...g, items, pos: pos && Object.keys(pos).length ? pos : undefined }];
    });
    return { ok: true, doc: { ...doc, groups } };
  }
  if (op.op === "move_part") {
    if (typeof op.id !== "string") return { ok: false, problems: [{ path: `${path}.id`, message: "id must be the part's id." }] };
    if (!Number.isFinite(op.x) || !Number.isFinite(op.y)) return { ok: false, problems: [{ path, message: "x and y must be finite numbers." }] };
    const at = findItem(doc, op.id);
    if (!at) return { ok: false, problems: [{ path: `${path}.id`, message: `No part has id "${op.id}".` }] };
    const group = doc.groups[at.gi];
    if (group.items.length !== 1) return { ok: false, problems: [{ path: `${path}.id`, message: "That part shares a group. Move it by replacing the group, or remove and add it." }] };
    let x = op.x as number;
    let y = op.y as number;
    if (typeof op.screen === "string") {
      const frame = doc.frames.find((f) => f.id === op.screen);
      if (!frame) return { ok: false, problems: [{ path: `${path}.screen`, message: `No screen has id "${op.screen}".` }] };
      x += frame.x;
      y += frame.y;
    }
    const groups = doc.groups.map((g, gi) => (gi === at.gi ? { ...g, x, y } : g));
    return { ok: true, doc: { ...doc, groups } };
  }
  return { ok: false, problems: [{ path: `${path}.op`, message: `Unknown operation "${String(op.op)}". Use set_doc, add_screen, update_screen, remove_screen, add_part, update_part, remove_part, move_part or tidy.` }] };
}

/** Apply a palette, a seed colour, or the theme axes. Unknown values are reported
 *  rather than quietly replaced, so the caller can correct them. */
export function applyTheme(doc: Doc, patch: ThemePatch): Prepared {
  const problems: Problem[] = [];
  let paletteKey = doc.paletteKey;
  let customPalette = doc.customPalette;
  if (patch.seed !== undefined) {
    const seed = patch.seed.trim();
    if (!isHex(seed)) problems.push({ path: "seed", message: "seed must be a hex colour such as #6750A4." });
    else if (patch.paletteKey !== undefined && patch.paletteKey !== "custom") {
      problems.push({ path: "paletteKey", message: "A seed builds the custom palette. Omit paletteKey, or set it to \"custom\"." });
    } else {
      customPalette = schemeFromSeed(seed, "Custom");
      paletteKey = "custom";
    }
  } else if (patch.paletteKey !== undefined) {
    if (!PALETTE_KEYS.has(patch.paletteKey)) problems.push({ path: "paletteKey", message: `paletteKey must be one of: ${[...PALETTE_KEYS].join(", ")}.` });
    else {
      paletteKey = patch.paletteKey;
      if (patch.paletteKey !== "custom") customPalette = undefined;
    }
  }
  const themePatch: Partial<Theme> = {};
  if (patch.dark !== undefined) {
    if (typeof patch.dark !== "boolean") problems.push({ path: "dark", message: "dark must be true or false." });
    else themePatch.dark = patch.dark;
  }
  if (patch.bothModes !== undefined) {
    if (typeof patch.bothModes !== "boolean") problems.push({ path: "bothModes", message: "bothModes must be true or false." });
    else themePatch.bothModes = patch.bothModes;
  }
  if (patch.emphasized !== undefined) {
    if (typeof patch.emphasized !== "boolean") problems.push({ path: "emphasized", message: "emphasized must be true or false." });
    else themePatch.emphasized = patch.emphasized;
  }
  if (patch.contrast !== undefined) {
    if (!CONTRASTS.some((c) => c.key === patch.contrast)) problems.push({ path: "contrast", message: "contrast must be standard, medium or high." });
    else themePatch.contrast = patch.contrast as Theme["contrast"];
  }
  if (patch.shape !== undefined) {
    if (!SHAPES.some((s) => s.key === patch.shape)) problems.push({ path: "shape", message: "shape must be square, rounded or full." });
    else themePatch.shape = patch.shape as Theme["shape"];
  }
  if (patch.font !== undefined) {
    if (!FONTS.some((f) => f.key === patch.font)) problems.push({ path: "font", message: "font must be roboto, robotoFlex, robotoSerif or system." });
    else themePatch.font = patch.font as Theme["font"];
  }
  if (patch.motion !== undefined) {
    if (patch.motion !== "standard" && patch.motion !== "expressive") problems.push({ path: "motion", message: "motion must be standard or expressive." });
    else themePatch.motion = patch.motion;
  }
  if (problems.length) return { ok: false, problems };
  const next: Doc = { ...doc, paletteKey, theme: normalizeTheme({ ...doc.theme, ...themePatch }) };
  if (customPalette) next.customPalette = customPalette;
  else delete next.customPalette;
  return { ok: true, doc: next };
}

/** A short reading of a design: screens, parts and where they navigate. */
export function outline(doc: Doc, screenId?: string): string {
  const theme = normalizeTheme(doc.theme);
  const frames = screenId ? doc.frames.filter((f) => f.id === screenId) : doc.frames;
  const lines: string[] = [];
  const title = doc.title.trim() || "(untitled)";
  lines.push(doc.brief.trim() ? `${title} — ${doc.brief.trim()}` : title);
  lines.push(`palette: ${doc.paletteKey} · shape: ${theme.shape} · font: ${theme.font} · motion: ${theme.motion} · contrast: ${theme.contrast} · dark: ${theme.dark} · bothModes: ${theme.bothModes}`);
  if (frames.length === 0 && screenId) return `${lines.join("\n")}\nNo screen has id "${screenId}".`;
  for (const frame of frames) {
    const { w, h } = frameSizeOf(frame);
    const length = frameLengthOf(frame);
    const size = length > h ? `${w}×${h}, scrolls to ${length}` : `${w}×${h}`;
    lines.push("");
    lines.push(`${frame.id} (${frame.name}) ${size} @${frame.x},${frame.y}${frame.note ? ` — ${frame.note}` : ""}`);
    if (frame.swipe && Object.keys(frame.swipe).length) {
      lines.push(`  swipe: ${Object.entries(frame.swipe).map(([dir, to]) => `${dir} → ${to}`).join(", ")}`);
    }
    const mine = doc.groups.filter((g) => frameOfGroup(g, doc.frames, {})?.id === frame.id);
    for (const group of mine) {
      for (const item of group.items) lines.push(`  ${partLine(item)}`);
    }
  }
  if (!doc.frames.length) lines.push("", "(no screens)");
  return lines.join("\n");
}

function targetOf(action: Action | undefined): string {
  if (!action) return "";
  const where = action.to === LINK_TARGET && action.url ? action.url : action.to;
  return ` → ${where} ${action.transition}`;
}

function partLine(item: Item): string {
  const name = KIND_SPEC[item.kind]?.label ?? item.kind;
  const words = item.label.trim();
  const tabs = item.tabs?.map((tab) => tab.label).filter(Boolean).join(", ");
  const shown = words || tabs || "";
  return `${item.kind} ${item.id}${shown ? ` "${shown}"` : ""} (${name})${targetOf(item.action)}`;
}

/** The platform a prompt should name when the document never picked one. */
export function platformOf(doc: Doc) {
  return doc.platform ?? defaultPlatformOf(doc.frames, doc.frame);
}
