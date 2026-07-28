import type { GetFileResponse, GetFileNodesResponse } from "@figma/rest-api-spec";
import { FigmaService } from "~/services/figma.js";
import {
  simplifyRawFigmaObject,
  allExtractors,
  collapseSvgContainers,
} from "~/extractors/index.js";
import { writeLogs } from "~/utils/logger.js";
import { serializeResult, type OutputFormat } from "~/utils/serialize.js";
import { wrapForSerialization } from "~/utils/serializable-design.js";
import { tagError } from "~/utils/error-meta.js";
import {
  type GetFigmaDataMetrics,
  measureSimplifiedDesign,
  countNamedStyles,
  detectVariables,
} from "~/services/get-figma-data-metrics.js";
import { resolveVariableFillNames } from "~/services/resolve-variable-names.js";
import { loadColorTokensDir } from "~/services/color-tokens-file.js";
import { loadAppkitColorHints } from "~/services/design-hints.js";
import {
  parseVariantProperties,
  enrichComponentSetDefinitions,
  resolveComponentLibraries,
  pruneNativeDecoration,
  focusDesignSubtree,
  attachDevResources,
  attachDevResourcesBatch,
  annotateSfSymbols,
  addConsumptionGuide,
} from "~/services/enrich-design.js";
import { downloadIcons } from "~/services/download-icons.js";
import type { SimplifiedDesign } from "~/extractors/types.js";

export type { GetFigmaDataMetrics } from "~/services/get-figma-data-metrics.js";

export type GetFigmaDataInput = {
  fileKey: string;
  nodeId?: string;
  depth?: number;
  /**
   * Auto-download every icon (IMAGE-SVG node) in the fetched tree as a vector
   * PDF into hooks.imageDir, and stamp iconFile on each one — see
   * download-icons.ts. Requires hooks.imageDir; silently skipped without it.
   */
  downloadIcons?: boolean;
  /**
   * Scope the result to just the subtree rooted at this node id, dropping all
   * sibling branches — for a huge instance where only one frame is wanted.
   * Accepts the full instance-internal id ("I3096:91050;1907:3787") or the
   * bare local id ("1907:3787"); see focusDesignSubtree. No-op if it matches
   * nothing (full tree returned).
   */
  focusNodeId?: string;
};

export type GetFigmaDataResult = {
  formatted: string;
  metrics: GetFigmaDataMetrics;
};

export type GetFigmaDataOutcome = {
  input: GetFigmaDataInput;
  outputFormat: OutputFormat;
  durationMs: number;
  metrics?: GetFigmaDataMetrics;
  error?: unknown;
};

/**
 * Live progress reader exposed to onSimplifyStart so callers can render
 * heartbeats showing real-time node counts. Closes over the per-call counter
 * the walker is incrementing — no module-global state involved.
 */
export type SimplifyProgress = {
  getNodeCount: () => number;
};

export type GetFigmaDataHooks = {
  onFetchStart?: () => void | Promise<void>;
  onFetchComplete?: () => void | Promise<void>;
  onSimplifyStart?: (progress: SimplifyProgress) => void | Promise<void>;
  onSimplifyComplete?: () => void | Promise<void>;
  onSerializeStart?: () => void | Promise<void>;
  /**
   * Fires exactly once per call, after the pipeline completes (success or
   * failure). Lets shells observe outcomes without embedding telemetry
   * bookkeeping in the core. Observer errors are swallowed silently — a
   * broken observer must never break the pipeline.
   */
  onComplete?: (outcome: GetFigmaDataOutcome) => void;
  /**
   * Optional directory of DTCG color token JSON exports (e.g. "Light.tokens.json",
   * "Dark.tokens.json") used to resolve Figma Variable-bound fills to friendly
   * names before falling back to the live Variables API. See resolveVariableFillNames.
   */
  colorTokensDir?: string;
  /** Base directory for icon PDFs when input.downloadIcons is set. See download-icons.ts. */
  imageDir?: string;
};

/**
 * Shared pipeline for "get figma data": fetch raw response, simplify, serialize.
 * Used by both the MCP `get_figma_data` tool and the `fetch` CLI command, which
 * differ only in how they wrap this pipeline (progress notifications vs. plain
 * stdout) and how they report errors (MCP envelope vs. process exit).
 *
 * Hooks are optional — the MCP tool uses them to drive progress heartbeats; the
 * CLI passes none.
 */
export async function getFigmaData(
  figmaService: FigmaService,
  input: GetFigmaDataInput,
  outputFormat: OutputFormat,
  hooks: GetFigmaDataHooks = {},
): Promise<GetFigmaDataResult> {
  const { fileKey, nodeId, depth, downloadIcons: shouldDownloadIcons, focusNodeId } = input;
  const startedAt = Date.now();
  let metrics: GetFigmaDataMetrics | undefined;
  let caughtError: unknown;
  // Per-call counter shared with the walker. Lives in the call closure so
  // overlapping HTTP requests each have their own — no module-global state.
  const nodeCounter = { count: 0 };

  try {
    await hooks.onFetchStart?.();
    let rawResult: { data: GetFileResponse | GetFileNodesResponse; rawSize: number };
    const fetchStart = Date.now();
    try {
      if (nodeId) {
        rawResult = await figmaService.getRawNode(fileKey, nodeId, depth);
      } else {
        rawResult = await figmaService.getRawFile(fileKey, depth);
      }
    } catch (error) {
      tagError(error, { phase: "fetch" });
    } finally {
      await hooks.onFetchComplete?.();
    }
    const fetchMs = Date.now() - fetchStart;
    const rawApiResponse = rawResult.data;
    const rawSizeKb = rawResult.rawSize / 1024;

    await hooks.onSimplifyStart?.({ getNodeCount: () => nodeCounter.count });
    let simplifiedDesign;
    const simplifyStart = Date.now();
    try {
      simplifiedDesign = await simplifyRawFigmaObject(rawApiResponse, allExtractors, {
        maxDepth: depth,
        afterChildren: collapseSvgContainers,
        nodeCounter,
      });
      // Best-effort: replace auto-generated fill_XXXXXX names with the real Figma
      // Variable name wherever a bound variable can be resolved. Tries local DTCG
      // color token files first (free, unambiguous ID match, with a hex+alpha
      // fallback), then the live Variables API for anything still unresolved.
      // Silently falls back to the synthetic name (today's behavior) if neither
      // source can resolve a given variable.
      const localTokens = loadColorTokensDir(hooks.colorTokensDir);
      const appkitHints = loadAppkitColorHints(hooks.colorTokensDir);
      simplifiedDesign = await resolveVariableFillNames(
        simplifiedDesign,
        figmaService,
        fileKey,
        localTokens,
        appkitHints,
      );

      // Enrichment passes: structured variant state, component-set property
      // definitions (one extra batched /nodes call), component source
      // libraries (native vs. custom, resolved via the published-components
      // API), Dev Mode resource links (one /dev_resources call), and SF
      // Symbol names for private-use glyphs. All best-effort.
      parseVariantProperties(simplifiedDesign);
      await enrichComponentSetDefinitions(simplifiedDesign, figmaService, fileKey);
      await resolveComponentLibraries(simplifiedDesign, figmaService);
      await attachDevResources(simplifiedDesign, figmaService, fileKey);
      // Runs AFTER dev-resources attachment, not before: a .swift link
      // pinned on an exact node that turns out to be purely decorative
      // must still resolve before that node is potentially pruned away.
      pruneNativeDecoration(simplifiedDesign);
      annotateSfSymbols(simplifiedDesign);
      // Scope to the requested subtree BEFORE downloading icons, so a focused
      // fetch only downloads that subtree's icons — not the whole instance's.
      if (focusNodeId) {
        focusDesignSubtree(simplifiedDesign, focusNodeId);
      }
      if (shouldDownloadIcons && hooks.imageDir) {
        await downloadIcons(simplifiedDesign, figmaService, fileKey, hooks.imageDir);
      }
      addConsumptionGuide(simplifiedDesign, outputFormat);
    } catch (error) {
      tagError(error, { phase: "simplify" });
    } finally {
      await hooks.onSimplifyComplete?.();
    }
    const simplifyMs = Date.now() - simplifyStart;

    writeLogs("figma-simplified.json", simplifiedDesign);

    const rawNodeCount = nodeCounter.count;
    const hasVariables = detectVariables(rawApiResponse);
    const namedStyleCount = countNamedStyles(rawApiResponse);
    const measured = measureSimplifiedDesign(simplifiedDesign);

    await hooks.onSerializeStart?.();
    const serializeStart = Date.now();
    let formatted: string;
    try {
      formatted = serializeResult(wrapForSerialization(simplifiedDesign), outputFormat);
    } catch (error) {
      tagError(error, { phase: "serialize" });
    }
    const simplifiedSizeKb = Buffer.byteLength(formatted, "utf8") / 1024;
    const serializeMs = Date.now() - serializeStart;

    metrics = {
      rawSizeKb,
      simplifiedSizeKb,
      rawNodeCount,
      simplifiedNodeCount: measured.simplifiedNodeCount,
      maxDepth: measured.maxDepth,
      namedStyleCount,
      componentCount: measured.componentCount,
      instanceCount: measured.instanceCount,
      textNodeCount: measured.textNodeCount,
      imageNodeCount: measured.imageNodeCount,
      componentPropertyCount: measured.componentPropertyCount,
      hasVariables,
      fetchMs,
      simplifyMs,
      serializeMs,
    };
    return { formatted, metrics };
  } catch (error) {
    caughtError = error;
    throw error;
  } finally {
    if (hooks.onComplete) {
      // Observer errors must never break the pipeline — e.g. a telemetry
      // failure should not mask the tool's real result or its original error.
      try {
        hooks.onComplete({
          input,
          outputFormat,
          durationMs: Date.now() - startedAt,
          metrics,
          error: caughtError,
        });
      } catch {
        // intentionally empty
      }
    }
  }
}

type TargetProcessingResult = {
  design: SimplifiedDesign;
  fileKey: string;
  nodeId?: string;
  rawSizeKb: number;
  rawNodeCount: number;
  namedStyleCount: number;
  hasVariables: boolean;
  fetchMs: number;
  simplifyMs: number;
};

/**
 * Per-target fetch + simplify + per-tree enrichment — everything from
 * getFigmaData's pipeline EXCEPT attachDevResources and addConsumptionGuide.
 * Those two move to the batch level in getFigmaDataBatch (via
 * attachDevResourcesBatch) so they can be deduplicated across every target
 * in the batch instead of running once per target — see that function's doc
 * comment for why.
 */
async function fetchAndEnrichTarget(
  figmaService: FigmaService,
  target: GetFigmaDataInput,
  hooks: Pick<GetFigmaDataHooks, "colorTokensDir" | "imageDir">,
): Promise<TargetProcessingResult> {
  const { fileKey, nodeId, depth, downloadIcons: shouldDownloadIcons, focusNodeId } = target;
  const nodeCounter = { count: 0 };

  const fetchStart = Date.now();
  let rawResult: { data: GetFileResponse | GetFileNodesResponse; rawSize: number };
  try {
    rawResult = nodeId
      ? await figmaService.getRawNode(fileKey, nodeId, depth)
      : await figmaService.getRawFile(fileKey, depth);
  } catch (error) {
    tagError(error, { phase: "fetch" });
  }
  const fetchMs = Date.now() - fetchStart;
  const rawApiResponse = rawResult.data;
  const rawSizeKb = rawResult.rawSize / 1024;

  const simplifyStart = Date.now();
  let simplifiedDesign = await simplifyRawFigmaObject(rawApiResponse, allExtractors, {
    maxDepth: depth,
    afterChildren: collapseSvgContainers,
    nodeCounter,
  });
  const localTokens = loadColorTokensDir(hooks.colorTokensDir);
  const appkitHints = loadAppkitColorHints(hooks.colorTokensDir);
  simplifiedDesign = await resolveVariableFillNames(
    simplifiedDesign,
    figmaService,
    fileKey,
    localTokens,
    appkitHints,
  );

  parseVariantProperties(simplifiedDesign);
  await enrichComponentSetDefinitions(simplifiedDesign, figmaService, fileKey);
  await resolveComponentLibraries(simplifiedDesign, figmaService);
  // pruneNativeDecoration is NOT called here — in the batch path, dev
  // resources are attached later at the batch level (attachDevResourcesBatch,
  // in getFigmaDataBatch), after every target has run this function. Pruning
  // here would risk removing a node a later .swift link needs to match
  // before that attachment ever runs. See getFigmaDataBatch for where it
  // actually happens (after attachDevResourcesBatch, before serialization).
  annotateSfSymbols(simplifiedDesign);
  // Scope before icon download (same reason as the single-target path). Safe
  // to run here even though pruneNativeDecoration/dev-resources happen later
  // at the batch level: dropping this target's sibling branches only discards
  // nodes (and any dev-resource links pinned on them) the caller explicitly
  // didn't want — nodes kept in the focused subtree still resolve normally.
  if (focusNodeId) {
    focusDesignSubtree(simplifiedDesign, focusNodeId);
  }
  if (shouldDownloadIcons && hooks.imageDir) {
    await downloadIcons(simplifiedDesign, figmaService, fileKey, hooks.imageDir);
  }
  const simplifyMs = Date.now() - simplifyStart;

  return {
    design: simplifiedDesign,
    fileKey,
    nodeId,
    rawSizeKb,
    rawNodeCount: nodeCounter.count,
    namedStyleCount: countNamedStyles(rawApiResponse),
    hasVariables: detectVariables(rawApiResponse),
    fetchMs,
    simplifyMs,
  };
}

export type GetFigmaDataBatchEntryResult = {
  fileKey: string;
  nodeId?: string;
  formatted?: string;
  metrics?: GetFigmaDataMetrics;
  /** Set instead of formatted/metrics when this one target's fetch failed — isolated, never breaks the rest of the batch. */
  error?: string;
};

export type GetFigmaDataBatchResult = {
  entries: GetFigmaDataBatchEntryResult[];
};

export type GetFigmaDataBatchHooks = Pick<
  GetFigmaDataHooks,
  "colorTokensDir" | "imageDir" | "onFetchStart" | "onSerializeStart"
>;

/**
 * Batch counterpart to getFigmaData: fetches N independent targets (each its
 * own fileKey/nodeId) in one call and returns one formatted result per
 * target — for exactly the case of "the user gave me several Figma links to
 * fetch together." Exists so two otherwise-per-target costs get
 * deduplicated across the whole batch instead of paid once per target:
 *
 * - design.guide (the directive/consumption-rule text) is attached to only
 *   the FIRST target's output; every later target in the same response
 *   already has it a few sections up in the same tool result, so repeating
 *   it there is pure waste (see addConsumptionGuide's doc comment for why
 *   it's NOT similarly safe to just drop across separate, independent
 *   calls).
 * - component-variant-reference fetches (attachDevResourcesBatch): if two
 *   different requested screens both use the same component and both carry
 *   a Dev Resources link to the same reference canvas, that reference is
 *   fetched and attached exactly once, to the first target that needs it.
 *
 * Each target is fetched/simplified/per-tree-enriched independently and in
 * parallel; a failure on one target is isolated to its own entry (`error`
 * set, `formatted`/`metrics` absent) and never breaks the rest of the batch.
 *
 * Deliberately coarser progress hooks than getFigmaData's per-phase ones — a
 * batch is N independent fetches running concurrently, so per-phase hooks
 * for a single fetch don't map cleanly onto "progress" here.
 */
export async function getFigmaDataBatch(
  figmaService: FigmaService,
  targets: GetFigmaDataInput[],
  outputFormat: OutputFormat,
  hooks: GetFigmaDataBatchHooks = {},
): Promise<GetFigmaDataBatchResult> {
  await hooks.onFetchStart?.();

  // `ok` is a literal-typed discriminant (not just an undefined check on
  // `design`) so the two branches narrow cleanly below — a plain truthiness
  // check on `design` doesn't let TS conclude the failure branch can never
  // carry the success branch's extra fields (rawSizeKb, fetchMs, ...).
  const processed = await Promise.all(
    targets.map(async (target) => {
      try {
        const result = await fetchAndEnrichTarget(figmaService, target, hooks);
        return { ok: true as const, ...result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false as const,
          fileKey: target.fileKey,
          nodeId: target.nodeId,
          error: message,
        };
      }
    }),
  );

  const succeeded = processed.filter((p): p is { ok: true } & TargetProcessingResult => p.ok);

  if (succeeded.length > 0) {
    await attachDevResourcesBatch(
      succeeded.map((p) => ({ design: p.design, fileKey: p.fileKey })),
      figmaService,
    );
    for (const p of succeeded) pruneNativeDecoration(p.design);
    addConsumptionGuide(succeeded[0].design, outputFormat);
  }

  await hooks.onSerializeStart?.();

  const entries: GetFigmaDataBatchEntryResult[] = processed.map((p) => {
    if (!p.ok) {
      return { fileKey: p.fileKey, nodeId: p.nodeId, error: p.error };
    }
    const serializeStart = Date.now();
    const formatted = serializeResult(wrapForSerialization(p.design), outputFormat);
    const serializeMs = Date.now() - serializeStart;
    const simplifiedSizeKb = Buffer.byteLength(formatted, "utf8") / 1024;
    const measured = measureSimplifiedDesign(p.design);

    const metrics: GetFigmaDataMetrics = {
      rawSizeKb: p.rawSizeKb,
      simplifiedSizeKb,
      rawNodeCount: p.rawNodeCount,
      simplifiedNodeCount: measured.simplifiedNodeCount,
      maxDepth: measured.maxDepth,
      namedStyleCount: p.namedStyleCount,
      componentCount: measured.componentCount,
      instanceCount: measured.instanceCount,
      textNodeCount: measured.textNodeCount,
      imageNodeCount: measured.imageNodeCount,
      componentPropertyCount: measured.componentPropertyCount,
      hasVariables: p.hasVariables,
      fetchMs: p.fetchMs,
      simplifyMs: p.simplifyMs,
      serializeMs,
    };

    return { fileKey: p.fileKey, nodeId: p.nodeId, formatted, metrics };
  });

  return { entries };
}
