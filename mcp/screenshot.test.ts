import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const screenshot = vi.fn(async () => Buffer.from("png"));
  const page = {
    goto: vi.fn(async () => {}), waitForSelector: vi.fn(async () => {}),
    getAttribute: vi.fn(async () => "home"), locator: vi.fn(() => ({ waitFor: vi.fn(async () => {}), screenshot })),
  };
  const contexts: { close: ReturnType<typeof vi.fn> }[] = [];
  const browser = {
    on: vi.fn(), close: vi.fn(async () => {}),
    newContext: vi.fn(async () => {
      const context = { newPage: vi.fn(async () => page), close: vi.fn(async () => {}) };
      contexts.push(context);
      return context;
    }),
  };
  return { browser, page, contexts, launch: vi.fn(async () => browser) };
});
vi.mock("playwright-core", () => ({ chromium: { launch: fake.launch } }));
import { closeScreenshotBrowser, screenshotDesign } from "./screenshot";

let time = 0;
beforeEach(() => {
  vi.clearAllMocks();
  fake.contexts.length = 0;
  vi.stubEnv("M3E_CHROME", process.execPath);
  vi.spyOn(Date, "now").mockReturnValue(time += 61_000);
});
afterEach(async () => {
  await closeScreenshotBrowser();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("screenshot browser lifecycle", () => {
  it("shares one launch across concurrent shots and closes isolated contexts", async () => {
    const results = await Promise.all([screenshotDesign("http://canvas/a"), screenshotDesign("http://canvas/b")]);
    expect(results).toEqual([{ png: Buffer.from("png") }, { png: Buffer.from("png") }]);
    expect(fake.launch).toHaveBeenCalledTimes(1);
    expect(fake.browser.newContext).toHaveBeenCalledTimes(2);
    expect(fake.browser.close).not.toHaveBeenCalled();
    for (const context of fake.contexts) expect(context.close).toHaveBeenCalledTimes(1);
    const disconnected = fake.browser.on.mock.calls.find(([event]) => event === "disconnected")?.[1];
    disconnected();
    await screenshotDesign("http://canvas/c");
    expect(fake.launch).toHaveBeenCalledTimes(2);
  });

  it("reports launch errors, retries the next launch and cleans up navigation failures", async () => {
    fake.launch.mockRejectedValueOnce(new Error("launch failed"));
    expect(await screenshotDesign("http://canvas/a")).toHaveProperty("error", expect.stringContaining("launch failed"));
    fake.page.goto.mockRejectedValueOnce(new Error("navigation failed"));
    expect(await screenshotDesign("http://canvas/b")).toHaveProperty("error", expect.stringContaining("navigation failed"));
    expect(fake.contexts[0].close).toHaveBeenCalledOnce();
    expect(await screenshotDesign("http://canvas/c")).toHaveProperty("png");
    expect(fake.launch).toHaveBeenCalledTimes(2);
  });

  it("keeps the twelve per minute cap", async () => {
    for (let i = 0; i < 12; i++) expect(await screenshotDesign("http://canvas/a")).toHaveProperty("png");
    expect(await screenshotDesign("http://canvas/a")).toHaveProperty("error", expect.stringContaining("12 per minute"));
    expect(fake.browser.newContext).toHaveBeenCalledTimes(12);
  });
});
