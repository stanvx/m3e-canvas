/** The stored design this page is editing, from `/d/<id>` or `?design=<id>`. */
export function liveDesignId(): string | null {
  if (typeof window === "undefined") return null;
  const query = new URLSearchParams(window.location.search).get("design");
  if (query) return query;
  const match = window.location.pathname.match(/\/d\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

/** The screen a `?shot=` view should frame. An empty string means the first screen.
 *  Null means this is an ordinary visit. */
export function shotFrameId(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  if (!params.has("shot")) return null;
  return params.get("shot") ?? "";
}

/** Prefix for the design API. Empty in the container, where the page and the API
 *  share an origin. `NEXT_PUBLIC_M3E_API` points elsewhere during `next dev`. */
export function designApi(path: string): string {
  const base = (process.env.NEXT_PUBLIC_M3E_API ?? "").replace(/\/$/, "");
  return `${base}${path}`;
}

/** A polled revision is applied when it is newer than the one on screen and no
 *  local save is waiting to be written. */
export function shouldApplyRemote(rev: number, seen: number | null, localPending: boolean): boolean {
  if (localPending) return false;
  return seen === null || rev > seen;
}
