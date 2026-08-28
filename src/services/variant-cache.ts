import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { slugifyPath } from "~/utils/slugify.js";

/**
 * Per-day, on-disk cache of fetched component-variant YAML.
 *
 * The full variant set of a component (all its states, fetched from its source
 * library) is expensive — a cross-file Tier-1 fetch — but changes rarely: only
 * when the design team republishes the component. So it's cached to disk and
 * reused within a day, and refreshed once per day (the design team may update
 * components overnight; a fresh batch each morning picks that up without ever
 * serving day-old variants).
 *
 * "Refresh per day" is realized structurally: each day's cache lives in its own
 * `<root>/<YYYY-MM-DD>/` directory, and opening the cache for a new day deletes
 * every other day's directory. That makes "is this from a previous day?" a
 * directory check, not a per-file date parse, and makes the wipe atomic from
 * the reader's perspective (a stale day's files are gone before any read).
 */

const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;

// Disambiguates concurrent temp files written by set() within one process.
let tmpSeq = 0;

/**
 * Cache root directory. Read directly from the environment (like
 * FIGMA_MCP_DEBUG_DIR in logger.ts) rather than threaded through the config
 * chain — it's server infrastructure, not a per-request option, so it needs no
 * CLI flag or tool parameter. Defaults to a stable per-OS temp location so the
 * feature works with zero configuration; a daily-refreshed cache is fine to
 * lose to a temp cleanup.
 */
export function variantCacheDir(): string {
  return process.env.FIGMA_MCP_VARIANT_CACHE_DIR || join(tmpdir(), "figma-mcp-variant-cache");
}

/**
 * Whether the whole variant-fetch feature (the second `variantData` document —
 * source-library UI for custom sets, cross-file `/nodes` calls, disk cache)
 * runs at all. Read directly from the environment, same reasoning as
 * variantCacheDir: server infrastructure, not a per-request option.
 *
 * Defaults to OFF. Unlike icon rendering (one call, opt-in per fetch via
 * `downloadIcons`), this feature's cost is structural — every remote
 * component set costs a cross-file Tier-1 `/nodes` call the first time it's
 * seen — so it must be an explicit, deliberate opt-in at the server level,
 * not something that silently starts spending rate-limit budget the moment
 * someone fetches with a native output format.
 */
export function variantFetchEnabled(): boolean {
  return process.env.FIGMA_MCP_FETCH_VARIANTS === "true";
}

/** YYYY-MM-DD in the server's local timezone. */
function dateStamp(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Today's cache date — for callers that need it when the cache itself couldn't open. */
export function variantCacheDate(now: Date = new Date()): string {
  return dateStamp(now);
}

export interface VariantCache {
  /** The day this cache is scoped to (YYYY-MM-DD), stamped into each entry. */
  readonly date: string;
  /** Cached YAML for a stem, or undefined on a miss. */
  get(stem: string): string | undefined;
  /** Write YAML for a stem (atomic rename, so a concurrent read never tears). */
  set(stem: string, yaml: string): void;
}

/**
 * Filesystem-safe, unique, human-readable filename stem for one component set.
 * The name is a best-effort readable prefix; `id` (the set's stable publish key
 * or node id) is what guarantees uniqueness — component names collide ("N/A"
 * repeats, duplicates exist) and carry "/" and "=" that a raw name can't put in
 * a filename. Falls back to the id alone when the name slugs to nothing.
 */
export function variantCacheStem(name: string, id: string): string {
  const slug = slugifyPath(name);
  const safeId = id.replace(/[^a-zA-Z0-9]+/g, "_");
  return slug ? `${slug}__${safeId}` : safeId;
}

/**
 * Open (creating if needed) the cache directory for today, wiping any other
 * day's directory in the process. `now` is injectable so the daily-rotation
 * behavior is testable without waiting for midnight.
 */
export function openVariantCache(cacheRoot: string, now: Date = new Date()): VariantCache {
  const date = dateStamp(now);
  const todayDir = join(cacheRoot, date);

  if (existsSync(cacheRoot)) {
    for (const entry of readdirSync(cacheRoot)) {
      if (DATE_DIR.test(entry) && entry !== date) {
        rmSync(join(cacheRoot, entry), { recursive: true, force: true });
      }
    }
  }
  mkdirSync(todayDir, { recursive: true });

  return {
    date,
    get(stem) {
      const file = join(todayDir, `${stem}.yaml`);
      return existsSync(file) ? readFileSync(file, "utf8") : undefined;
    },
    set(stem, yaml) {
      const final = join(todayDir, `${stem}.yaml`);
      // Write-then-rename: rename is atomic on the same filesystem, so a reader
      // (another dev on the shared server) never sees a half-written file.
      const tmp = `${final}.tmp-${process.pid}-${tmpSeq++}`;
      writeFileSync(tmp, yaml, "utf8");
      renameSync(tmp, final);
    },
  };
}
