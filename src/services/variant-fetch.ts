import type { GetFileNodesResponse } from "@figma/rest-api-spec";
import type { FigmaService } from "~/services/figma.js";
import type { VariantSetTarget } from "~/services/enrich-design.js";
import { simplifyRawFigmaObject, allExtractors } from "~/extractors/index.js";
import { inlineNode, type NativeNode } from "~/utils/native-json.js";
import { getErrorMeta } from "~/utils/error-meta.js";
import { HttpError } from "~/utils/fetch-json.js";
import { Logger } from "~/utils/logger.js";

/**
 * Fetch the full variant set (every state) of remote component sets from their
 * source libraries and return each set's inlined UI nodes, keyed by the set's
 * id in the fetched design.
 *
 * Two cost controls are baked in:
 * - **Batched by source file**: `/nodes` takes many ids per call, so all sets
 *   from one library are fetched in a single Tier-1 request. Only a different
 *   source file forces another call. Files are fetched sequentially (not in
 *   parallel) so a rate-limit sleep spaces calls out instead of bursting the
 *   shared limit.
 * - **No icon downloads**: the fetched subtree is simplified as design data
 *   only; IMAGE-SVG nodes stay as node data (the icon reference) — the variant
 *   YAML is design, never binary assets.
 *
 * Best-effort: a library that fails (403/permission/network) or a single set
 * missing from the response is logged and skipped, never thrown — a broken
 * source must not break the primary fetch.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Figma's Retry-After (seconds) from the 429's HttpError, or 60s if absent. */
function retryAfterMs(error: unknown): number {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current instanceof HttpError) {
      const raw = current.responseHeaders["retry-after"];
      const secs = raw ? parseInt(raw, 10) : NaN;
      if (Number.isFinite(secs) && secs > 0) return secs * 1000;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return 60_000;
}

/**
 * Run `fn`, and on a Figma 429 sleep (honoring Retry-After, default 60s) then
 * retry — up to `maxSleeps` times. Non-429 errors propagate immediately.
 */
async function withRateLimitRetry<T>(fn: () => Promise<T>, maxSleeps = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxSleeps || getErrorMeta(error).http_status !== 429) throw error;
      const ms = retryAfterMs(error);
      Logger.log(
        `Variant fetch rate-limited (429); sleeping ${Math.round(ms / 1000)}s then retrying ` +
          `(attempt ${attempt + 1}/${maxSleeps}).`,
      );
      await sleep(ms);
    }
  }
}

/**
 * Fetch and inline the variant UI for the given targets. Callers pass only
 * targets worth fetching (uncached custom sets with a resolved `source`;
 * native and icon-library sets are filtered out upstream).
 * Returns setId → inlined nodes; a target that couldn't be fetched is simply
 * absent from the map.
 */
export async function fetchVariantSetNodes(
  targets: VariantSetTarget[],
  figmaService: FigmaService,
): Promise<Map<string, NativeNode[]>> {
  const byFile = new Map<string, VariantSetTarget[]>();
  for (const target of targets) {
    if (!target.source) continue;
    const group = byFile.get(target.source.fileKey);
    if (group) group.push(target);
    else byFile.set(target.source.fileKey, [target]);
  }

  const result = new Map<string, NativeNode[]>();
  for (const [fileKey, fileTargets] of byFile) {
    const ids = fileTargets.map((t) => t.source!.nodeId);
    let raw: { data: GetFileNodesResponse };
    try {
      raw = await withRateLimitRetry(() => figmaService.getRawNode(fileKey, ids.join(","), 2));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Logger.log(`Skipping variant fetch for library ${fileKey} (${ids.length} sets): ${message}`);
      continue;
    }

    for (const target of fileTargets) {
      const entry = raw.data.nodes[target.source!.nodeId];
      if (!entry?.document) continue;
      // Simplify just this one set node. No collapseSvgContainers and no icon
      // download — the variant subtree is kept as design data.
      const single = { ...raw.data, nodes: { [target.source!.nodeId]: entry } };
      const simplified = await simplifyRawFigmaObject(single, allExtractors, { maxDepth: 2 });
      const styles = simplified.globalVars.styles;
      const tokens = simplified.globalVars.tokens ?? {};
      const nodes = simplified.nodes.map((node) => {
        const inlined = inlineNode(node, styles, tokens);
        // The set root's position among OTHER sets in the source library is
        // meaningless here; variant internals (the real UI) are left intact.
        delete inlined.siblingIndex;
        delete inlined.parentName;
        return inlined;
      });
      result.set(target.setId, nodes);
    }
  }
  return result;
}
