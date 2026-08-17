import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchVariantSetNodes } from "~/services/variant-fetch.js";
import { HttpError } from "~/utils/fetch-json.js";
import { tagError } from "~/utils/error-meta.js";
import type { VariantSetTarget } from "~/services/enrich-design.js";
import type { FigmaService } from "~/services/figma.js";

// Mirrors exactly what FigmaService.requestWithSize actually throws on a 429:
// the original HttpError tagged with http_status via tagError, then wrapped in
// a new Error that preserves it via `cause` (see figma.ts:91-95). Building the
// real shape here (not a simplified stand-in) is what makes this test prove
// the retry logic actually works against production error shapes.
function make429(retryAfterSeconds?: string): Error {
  const httpError = new HttpError("Too Many Requests", {
    responseHeaders: retryAfterSeconds ? { "retry-after": retryAfterSeconds } : {},
    responseBody: undefined,
  });
  tagError(httpError, { http_status: 429 });
  return new Error("Figma API rate limit hit (429).", { cause: httpError });
}

function makeTarget(setId: string, fileKey: string, nodeId: string): VariantSetTarget {
  return {
    setId,
    name: "Push Button",
    publishKey: `pk-${setId}`,
    native: false,
    source: { fileKey, nodeId },
  };
}

function makeSourceResponse(nodeId: string) {
  return {
    name: "lib",
    nodes: {
      [nodeId]: {
        document: { id: nodeId, name: "Push Button", type: "COMPONENT_SET", children: [] },
        components: {},
        componentSets: {},
        styles: {},
      },
    },
  };
}

describe("fetchVariantSetNodes — 429 retry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sleeps for the exact Retry-After duration, then succeeds — never a fixed guess when the header is present", async () => {
    let calls = 0;
    const getRawNode = vi.fn(async () => {
      calls++;
      if (calls === 1) throw make429("5"); // Figma says wait exactly 5s
      return { data: makeSourceResponse("9:1"), rawSize: 0 };
    });
    const service = { getRawNode } as unknown as FigmaService;

    const promise = fetchVariantSetNodes([makeTarget("s1", "LIB", "9:1")], service);

    // Give the first (failing) call a tick to run and schedule its sleep.
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    // Advancing by less than 5s must NOT trigger the retry yet.
    await vi.advanceTimersByTimeAsync(4999);
    expect(calls).toBe(1);

    // The remaining 1ms crosses the exact Retry-After boundary.
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);

    const result = await promise;
    expect(result.get("s1")).toBeDefined();
  });

  it("defaults to a 60s sleep when Figma sends no Retry-After header", async () => {
    let calls = 0;
    const getRawNode = vi.fn(async () => {
      calls++;
      if (calls === 1) throw make429(); // no header at all
      return { data: makeSourceResponse("9:1"), rawSize: 0 };
    });
    const service = { getRawNode } as unknown as FigmaService;

    const promise = fetchVariantSetNodes([makeTarget("s1", "LIB", "9:1")], service);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(calls).toBe(1); // not yet — must wait the full default minute

    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);

    await promise;
  });

  it("gives up after 3 retries and skips the library — never fetches forever", async () => {
    const getRawNode = vi.fn(async () => {
      throw make429("1"); // Retry-After is whole seconds per HTTP spec; keep sleeps short but real
    });
    const service = { getRawNode } as unknown as FigmaService;

    const promise = fetchVariantSetNodes([makeTarget("s1", "LIB", "9:1")], service);
    // Initial call + 3 retries = 4 total attempts, each gated by a 1s sleep.
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result.has("s1")).toBe(false); // best-effort skip, not a thrown error
    expect(getRawNode).toHaveBeenCalledTimes(4);
  });

  it("does NOT sleep/retry a non-429 error — fails fast instead", async () => {
    const getRawNode = vi.fn(async () => {
      throw new Error("403 File not exportable");
    });
    const service = { getRawNode } as unknown as FigmaService;

    const result = await fetchVariantSetNodes([makeTarget("s1", "LIB", "9:1")], service);

    expect(getRawNode).toHaveBeenCalledTimes(1); // no retry loop entered at all
    expect(result.has("s1")).toBe(false);
  });
});
