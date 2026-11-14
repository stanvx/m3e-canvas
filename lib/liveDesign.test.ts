import { afterEach, describe, expect, it, vi } from "vitest";
import { designApi, liveDesignId, shotFrameId, shouldApplyRemote } from "./liveDesign";

function at(url: string) {
  const parsed = new URL(url);
  vi.stubGlobal("window", { location: { search: parsed.search, pathname: parsed.pathname } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_M3E_API;
});

describe("live design address", () => {
  it("reads an id from the query or the /d/ path", () => {
    expect(liveDesignId()).toBeNull();
    at("http://localhost/?design=abc_def-12");
    expect(liveDesignId()).toBe("abc_def-12");
    at("http://localhost/d/abc%2012/");
    expect(liveDesignId()).toBe("abc 12");
    at("http://localhost/other");
    expect(liveDesignId()).toBeNull();
  });

  it("treats an empty shot as the first screen and a missing one as a normal visit", () => {
    at("http://localhost/");
    expect(shotFrameId()).toBeNull();
    at("http://localhost/?shot=");
    expect(shotFrameId()).toBe("");
    at("http://localhost/?shot=home");
    expect(shotFrameId()).toBe("home");
  });

  it("prefixes the API when next dev points elsewhere", () => {
    expect(designApi("/api/designs/abc")).toBe("/api/designs/abc");
    process.env.NEXT_PUBLIC_M3E_API = "http://127.0.0.1:8787/";
    expect(designApi("/api/designs/abc")).toBe("http://127.0.0.1:8787/api/designs/abc");
  });
});

describe("shouldApplyRemote", () => {
  it("takes the first revision and anything newer, and waits out a local save", () => {
    expect(shouldApplyRemote(1, null, false)).toBe(true);
    expect(shouldApplyRemote(2, 1, false)).toBe(true);
    expect(shouldApplyRemote(1, 1, false)).toBe(false);
    expect(shouldApplyRemote(3, 1, true)).toBe(false);
  });
});
