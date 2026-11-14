import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Doc } from "./tokens";

/* One JSON file per design. A rename is the commit, so a crash mid-write
 * leaves the previous file in place. The directory is the team's private disk. */

export type DesignRecord = { id: string; rev: number; updatedAt: string; doc: Doc };

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export const isDesignId = (id: string) => ID_RE.test(id);

export function designDir(): string {
  return process.env.M3E_DATA_DIR ?? path.join(process.cwd(), "data", "designs");
}

const chains = new Map<string, Promise<unknown>>();

/** Serialise writes for one id inside this process. One container, one writer. */
function lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(id) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  chains.set(id, run.then(() => undefined, () => undefined));
  return run;
}

async function fileOf(id: string): Promise<string> {
  if (!isDesignId(id)) throw new Error("bad id");
  return path.join(path.resolve(designDir()), `${id}.json`);
}

async function readFileRecord(id: string): Promise<DesignRecord | null> {
  try {
    const raw = await readFile(await fileOf(id), "utf8");
    const value = JSON.parse(raw) as DesignRecord;
    if (!value || typeof value.rev !== "number" || !value.doc) return null;
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeRecord(record: DesignRecord): Promise<void> {
  const file = await fileOf(record.id);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(record));
  await rename(tmp, file);
}

export function readDesign(id: string): Promise<DesignRecord | null> {
  if (!isDesignId(id)) return Promise.resolve(null);
  return readFileRecord(id);
}

export function createDesign(doc: Doc): Promise<DesignRecord> {
  const id = randomBytes(12).toString("base64url");
  const record: DesignRecord = { id, rev: 1, updatedAt: new Date().toISOString(), doc };
  return lock(id, async () => {
    await writeRecord(record);
    return record;
  });
}

export type WriteResult =
  | { ok: true; record: DesignRecord }
  | { ok: false; conflict: DesignRecord }
  | { ok: false; missing: true };

/** Replace a design when `expectedRev` is still current. */
export function updateDesign(id: string, expectedRev: number, doc: Doc): Promise<WriteResult> {
  if (!isDesignId(id)) return Promise.resolve({ ok: false, missing: true });
  return lock(id, async () => {
    const current = await readFileRecord(id);
    if (!current) return { ok: false, missing: true };
    if (current.rev !== expectedRev) return { ok: false, conflict: current };
    const record: DesignRecord = { id, rev: current.rev + 1, updatedAt: new Date().toISOString(), doc };
    await writeRecord(record);
    return { ok: true, record };
  });
}

export async function listDesigns(): Promise<{ id: string; rev: number; title: string; updatedAt: string }[]> {
  let names: string[] = [];
  try {
    names = await readdir(designDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const out: { id: string; rev: number; title: string; updatedAt: string }[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (!isDesignId(id)) continue;
    const record = await readFileRecord(id);
    if (!record) continue;
    out.push({ id, rev: record.rev, title: record.doc.title ?? "", updatedAt: record.updatedAt });
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** Test helper. Production never calls it. */
export async function removeDesignDir(): Promise<void> {
  await rm(designDir(), { recursive: true, force: true });
}
