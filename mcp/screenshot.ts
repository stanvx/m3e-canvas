import type { Browser, BrowserContext } from "playwright-core";
import { existsSync } from "node:fs";

const shots: number[] = [];
let browserPromise: Promise<Browser> | undefined;

async function sharedBrowser(executablePath: string): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = import("playwright-core").then(({ chromium }) => chromium.launch({
      executablePath,
      args: process.env.M3E_NO_SANDBOX === "1" ? ["--no-sandbox", "--disable-dev-shm-usage"] : ["--disable-dev-shm-usage"],
    }));
    const pending = browserPromise;
    pending.then((browser) => browser.on("disconnected", () => {
      if (browserPromise === pending) browserPromise = undefined;
    }), () => {
      if (browserPromise === pending) browserPromise = undefined;
    });
  }
  return browserPromise;
}

export async function closeScreenshotBrowser() {
  const pending = browserPromise;
  browserPromise = undefined;
  if (pending) await pending.then((browser) => browser.close(), () => {});
}

function chromePath(): string | undefined {
  const candidates = [
    process.env.M3E_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

/** PNG of one screen as the canvas paints it. Needs Chrome and a built (or
 *  running) canvas at `url`. Twelve shots a minute keeps a container from
 *  being asked to render in a loop. */
export async function screenshotDesign(url: string): Promise<{ png: Buffer } | { error: string }> {
  const now = Date.now();
  while (shots.length && now - shots[0] > 60_000) shots.shift();
  if (shots.length >= 12) return { error: "Screenshot limit reached (12 per minute). Wait and call m3e_screenshot again." };
  const executablePath = chromePath();
  if (!executablePath) {
    return { error: "No Chrome or Chromium found. Set M3E_CHROME to the browser binary. On the container image it is /usr/bin/chromium." };
  }
  shots.push(now);
  let context: BrowserContext | undefined;
  try {
    const browser = await sharedBrowser(executablePath);
    context = await browser.newContext({ viewport: { width: 480, height: 1000 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });
    await page.waitForSelector("html[data-m3e-shot]", { timeout: 15_000 });
    const id = await page.getAttribute("html", "data-m3e-shot");
    if (!id) return { error: "The canvas did not name a screen to photograph." };
    const handle = page.locator(`[data-screen=${JSON.stringify(id)}]`);
    await handle.waitFor({ timeout: 5_000 });
    const png = await handle.screenshot({ type: "png" });
    return { png };
  } catch (error) {
    const message = error instanceof Error ? error.message : "screenshot failed";
    return { error: `Could not photograph the screen. ${message} The canvas must be serving ${url}. Run npm run build, then start this server, or set M3E_PUBLIC_URL to a running canvas.` };
  } finally {
    await context?.close().catch(() => {});
  }
}
