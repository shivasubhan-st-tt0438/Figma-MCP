import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  openVariantCache,
  variantCacheStem,
  variantFetchEnabled,
} from "~/services/variant-cache.js";

const roots: string[] = [];
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "variant-cache-test-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("variantCacheStem", () => {
  it("keeps a readable name prefix but guarantees uniqueness/safety via the id", () => {
    expect(variantCacheStem("Push Button", "3032:65763")).toBe("push_button__3032_65763");
    // "/" and "=" in names would break a filename — slugged away.
    expect(variantCacheStem("Pills/Profile Letter", "9:1")).toBe("pills_profile_letter__9_1");
    expect(variantCacheStem("State=Secondary, Enabled=True", "a:b")).toBe(
      "state_secondary_enabled_true__a_b",
    );
  });

  it("falls back to the id alone when the name slugs to nothing", () => {
    expect(variantCacheStem("", "121:12408")).toBe("121_12408");
    expect(variantCacheStem("✅", "1:2")).toBe("1_2");
  });
});

describe("variantFetchEnabled", () => {
  const original = process.env.FIGMA_MCP_FETCH_VARIANTS;
  afterEach(() => {
    if (original === undefined) delete process.env.FIGMA_MCP_FETCH_VARIANTS;
    else process.env.FIGMA_MCP_FETCH_VARIANTS = original;
  });

  it("defaults to false when unset", () => {
    delete process.env.FIGMA_MCP_FETCH_VARIANTS;
    expect(variantFetchEnabled()).toBe(false);
  });

  it('is true only for the exact string "true"', () => {
    process.env.FIGMA_MCP_FETCH_VARIANTS = "true";
    expect(variantFetchEnabled()).toBe(true);

    process.env.FIGMA_MCP_FETCH_VARIANTS = "1";
    expect(variantFetchEnabled()).toBe(false);
  });
});

describe("openVariantCache", () => {
  const day1 = new Date(2026, 7, 12); // 2026-08-12 (month is 0-indexed)
  const day2 = new Date(2026, 7, 13); // 2026-08-13

  it("round-trips a value within the same day and misses on unknown stems", () => {
    const root = tmpRoot();
    const cache = openVariantCache(root, day1);

    expect(cache.get("push_button__x")).toBeUndefined();
    cache.set("push_button__x", "yaml: here");
    expect(cache.get("push_button__x")).toBe("yaml: here");
    expect(cache.date).toBe("2026-08-12");
  });

  it("wipes the previous day's cache when opened on a new day (fresh daily batch)", () => {
    const root = tmpRoot();

    const d1 = openVariantCache(root, day1);
    d1.set("slider__x", "old day");
    expect(readdirSync(root)).toContain("2026-08-12");

    // Next day: opening rotates — the previous day's dir is gone, so the stale
    // entry is a miss and will be re-fetched fresh.
    const d2 = openVariantCache(root, day2);
    expect(d2.get("slider__x")).toBeUndefined();
    expect(readdirSync(root)).toEqual(["2026-08-13"]);
    expect(existsSync(join(root, "2026-08-12"))).toBe(false);
  });

  it("keeps today's entries when reopened the same day (no wipe)", () => {
    const root = tmpRoot();
    openVariantCache(root, day1).set("a__1", "kept");
    // A second open on the same day must not clear today's own directory.
    expect(openVariantCache(root, day1).get("a__1")).toBe("kept");
  });
});
