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
  annotateSfSymbols,
  addConsumptionGuide,
} from "~/services/enrich-design.js";
import { downloadIcons } from "~/services/download-icons.js";

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
  const { fileKey, nodeId, depth, downloadIcons: shouldDownloadIcons } = input;
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
      // API), and SF Symbol names for private-use glyphs. All best-effort.
      parseVariantProperties(simplifiedDesign);
      await enrichComponentSetDefinitions(simplifiedDesign, figmaService, fileKey);
      await resolveComponentLibraries(simplifiedDesign, figmaService);
      annotateSfSymbols(simplifiedDesign);
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
