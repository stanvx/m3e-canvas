import { describe, expect, it } from "vitest";
import questions from "./questions.json";
import { explain, outline, prepare } from "../lib/agent";
import { buildPrompt } from "../lib/prompt";
import { PHONE_W, frameSizeOf } from "../lib/tokens";

/* The ten read-only questions a model is asked about one fixture. The checks
 * answer them from the outline, the prompt and the document, with no model. */
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

type Question = {
  question: string;
  includes?: string[];
  excludes?: string[];
  explainEmpty?: boolean;
  phonesOnly?: boolean;
  promptScreen?: string;
};

const list = questions as Question[];

describe("design questions", () => {
  const prepared = prepare(home);
  if (!prepared.ok) throw new Error("fixture did not prepare");
  const doc = prepared.doc;

  it("asks ten questions and each answer is in the document", () => {
    expect(list).toHaveLength(10);
    const reading = outline(doc);
    for (const q of list) {
      const text = q.promptScreen ? buildPrompt(doc, {}, q.promptScreen, "en") : reading;
      for (const part of q.includes ?? []) expect(text, q.question).toContain(part);
      for (const part of q.excludes ?? []) expect(text, q.question).not.toContain(part);
      if (q.explainEmpty) expect(explain(doc), q.question).toEqual([]);
      if (q.phonesOnly) {
        expect(doc.frames.length, q.question).toBeGreaterThan(0);
        for (const frame of doc.frames) expect(frameSizeOf(frame).w, q.question).toBe(PHONE_W);
      }
    }
  });
});
