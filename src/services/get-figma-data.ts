import type { GetFileResponse, GetFileNodesResponse } from "@figma/rest-api-spec";
import { FigmaService } from "~/services/figma.js";
import {
  simplifyRawFigmaObject,
  allExtractors,
  collapseSvgContainers,
} from "~/extractors/index.js";
import { writeLogs, debugSlug } from "~/utils/logger.js";
import { serializeResult, serializeVariantDocument, type OutputFormat } from "~/utils/serialize.js";
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
  searchDesignByName,
  renderNameSearchListing,
  attachDevResources,
  attachDevResourcesBatch,
  annotateSfSymbols,
  addConsumptionGuide,
  loadIconDownloadScript,
} from "~/services/enrich-design.js";
import { collectIconRenderUrls } from "~/services/render-icons.js";
import { attachVariantData } from "~/services/variant-cache-pass.js";
import { flagUnnamedAssets } from "~/services/flag-unnamed-assets.js";
import type { SimplifiedDesign } from "~/extractors/types.js";

export type { GetFigmaDataMetrics } from "~/services/get-figma-data-metrics.js";

export type GetFigmaDataInput = {
  fileKey: string;
  nodeId?: string;
  depth?: number;
  /**
   * Stamp a downloadable render URL (vector PDF) onto every icon (IMAGE-SVG,
   * any size, not native decomposition) in the scoped subtree, as the node's
   * `iconUrl` — "give me links for all the icons here" without enumerating ids.
   * The icon's Figma name is already on the node (`name`), so a consumer can
   * save each as `<name>.pdf`. One batched /images call. See
   * collectIconRenderUrls.
   */
  downloadIcons?: boolean;
  /**
   * Scope the result to just the subtree(s) matching this node id or layer
   * name, dropping all sibling branches — for a huge instance where only one
   * frame is wanted. Accepts the full instance-internal id
   * ("I3096:91050;1907:3787"), the bare local id ("1907:3787"), or a plain
   * layer name ("Frame 1", case-insensitive) as a fallback when no id is on
   * hand; see focusDesignSubtree/findFocusMatches. A miss returns a search
   * listing (see `find`) rather than the full tree.
   */
  focusNodeId?: string;
  /**
   * Discovery: find a node by exact NAME (case-insensitive) without knowing
   * its id (see searchDesignByName). Exactly one match auto-focuses to it
   * (same as passing its id as focusNodeId); zero or many matches return a
   * compact candidate listing to pick a focusNodeId from — never the full
   * tree, and never any enrichment API call (see getFigmaData) — an
   * ambiguous/missing name costs one raw fetch, nothing more. Takes
   * precedence over focusNodeId.
   */
  find?: string;
};

export type GetFigmaDataResult = {
  formatted: string;
  metrics: GetFigmaDataMetrics;
  /** The second document (component-variant data), when the native format emitted one. */
  variantsFormatted?: string;
  /**
   * The icon-download script's own source, included whenever this fetch used
   * `downloadIcons` — shipped fresh from the server every time rather than
   * assumed to already exist in the consumer's repo. See loadIconDownloadScript.
   */
  iconScript?: string;
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
  const { fileKey, nodeId, depth, focusNodeId, find, downloadIcons } = input;
  const startedAt = Date.now();
  let metrics: GetFigmaDataMetrics | undefined;
  let caughtError: unknown;
  // When a `find` (or a focusNodeId miss) resolves to zero or many nodes, the
  // response is a compact candidate listing instead of the serialized design —
  // held here so the serialize step emits it in place of the full tree.
  let findListing: string | undefined;
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

    // Dump the raw files-API response HERE (the one primary fetch) rather than
    // inside FigmaService.getRawNode/getRawFile — those also run for enrichment
    // sub-calls (component-set defs, etc.), which would produce extra raw JSONs
    // per request. One user fetch → one raw JSON.
    const debugId = debugSlug(fileKey, nodeId);
    writeLogs(`figma-raw-${debugId}.json`, rawApiResponse);

    await hooks.onSimplifyStart?.({ getNodeCount: () => nodeCounter.count });
    let simplifiedDesign;
    const simplifyStart = Date.now();
    try {
      simplifiedDesign = await simplifyRawFigmaObject(rawApiResponse, allExtractors, {
        maxDepth: depth,
        afterChildren: collapseSvgContainers,
        nodeCounter,
      });

      // Resolve `find`/`focusNodeId` BEFORE any enrichment API call — matching
      // is name/id lookup over the tree extractors already built, so it needs
      // no enrichment to run. `find` is discovery: one match auto-focuses;
      // zero or many produce a candidate listing (findListing) instead of the
      // full tree. A focusNodeId miss falls back to the same listing rather
      // than dumping everything — the very thing the caller was trying to
      // narrow down. Doing this first means an ambiguous/missing name costs
      // exactly one raw fetch and nothing else: no variable/library/dev-resource
      // API calls are spent enriching a tree the caller can't even see yet
      // (see the `if (!findListing)` gate below) — this also keeps every
      // enrichment pass that DOES run scoped to the focused subtree, not the
      // whole file, when focus succeeds.
      if (find) {
        const matches = searchDesignByName(simplifiedDesign, find);
        if (matches.length === 1) {
          focusDesignSubtree(simplifiedDesign, matches[0].id);
        } else {
          findListing = renderNameSearchListing(find, matches);
        }
      } else if (focusNodeId) {
        const matched = focusDesignSubtree(simplifiedDesign, focusNodeId);
        if (!matched) {
          findListing = renderNameSearchListing(
            focusNodeId,
            searchDesignByName(simplifiedDesign, focusNodeId),
          );
        }
      }

      // A candidate listing is a directory of ids, not design data — every
      // enrichment pass below makes at least one Figma API call, so none of
      // them run against a tree the caller can't consume yet. Rate limits are
      // shared with the eventual disambiguated re-fetch; spending them here
      // would only make that next call more likely to get throttled.
      if (!findListing) {
        // Replace auto-generated fill_XXXXXX names with the real Figma Variable
        // name by EXACT variable-ID match against the local DTCG color token
        // exports (Colors - HIG). ID-only: no color/hex guessing, no live
        // Variables API. A bound fill whose id isn't in the exports is left as
        // a raw value and surfaced later by the unnamed-asset flagging pass.
        const localTokens = loadColorTokensDir(hooks.colorTokensDir);
        const appkitHints = loadAppkitColorHints(hooks.colorTokensDir);
        simplifiedDesign = resolveVariableFillNames(simplifiedDesign, localTokens, appkitHints);

        // Structured variant state, component-set property definitions (one
        // extra batched /nodes call), component source libraries (native vs.
        // custom, resolved via the published-components API), Dev Mode
        // resource links (one /dev_resources call), and SF Symbol names for
        // private-use glyphs. All best-effort, and — since focus already ran
        // above — scoped to whatever subtree survived it.
        parseVariantProperties(simplifiedDesign);
        await enrichComponentSetDefinitions(simplifiedDesign, figmaService, fileKey);
        const variantTargets = await resolveComponentLibraries(simplifiedDesign, figmaService);
        // Fetch + cache the full variant set of every remote component (UI for
        // custom sets; metadata-only for native/icon) into a second document.
        // Runs on the resolved targets from the line above — no extra key
        // lookups. Native formats only: they're the ones that move
        // components/componentSets into the second document; other formats
        // keep the single-document shape unchanged.
        if (outputFormat.startsWith("native-")) {
          await attachVariantData(simplifiedDesign, variantTargets, figmaService);
        }
        await attachDevResources(simplifiedDesign, figmaService, fileKey);
        // Runs AFTER dev-resources attachment, not before: a .swift link
        // pinned on an exact node that turns out to be purely decorative
        // must still resolve before that node is potentially pruned away.
        pruneNativeDecoration(simplifiedDesign);
        annotateSfSymbols(simplifiedDesign);
        // After pruning/focus so we only render icons that survived into the
        // scoped tree — one batched /images call, stamped inline as iconUrl.
        if (downloadIcons) {
          await collectIconRenderUrls(simplifiedDesign, figmaService, fileKey);
        }
        // Last, on the final pruned/scoped tree: surface colors/icons/fonts
        // that carry no design-system name.
        flagUnnamedAssets(simplifiedDesign);
        addConsumptionGuide(simplifiedDesign, outputFormat);
      }
    } catch (error) {
      tagError(error, { phase: "simplify" });
    } finally {
      await hooks.onSimplifyComplete?.();
    }
    const simplifyMs = Date.now() - simplifyStart;

    const rawNodeCount = nodeCounter.count;
    const hasVariables = detectVariables(rawApiResponse);
    const namedStyleCount = countNamedStyles(rawApiResponse);
    const measured = measureSimplifiedDesign(simplifiedDesign);

    await hooks.onSerializeStart?.();
    const serializeStart = Date.now();
    let formatted: string;
    let variantsFormatted: string | undefined;
    try {
      const wrapped = wrapForSerialization(simplifiedDesign);
      formatted = findListing ?? serializeResult(wrapped, outputFormat);
      // No second document for a candidate listing (findListing) — that's a
      // directory of ids, not design data.
      variantsFormatted = findListing ? undefined : serializeVariantDocument(wrapped, outputFormat);
    } catch (error) {
      tagError(error, { phase: "serialize" });
    }
    const simplifiedSizeKb = Buffer.byteLength(formatted, "utf8") / 1024;
    const serializeMs = Date.now() - serializeStart;

    const finalExt = outputFormat.includes("json")
      ? "json"
      : outputFormat === "tree"
        ? "txt"
        : "yaml";
    writeLogs(`figma-final-${debugId}.${finalExt}`, formatted);
    if (variantsFormatted) writeLogs(`figma-variants-${debugId}.${finalExt}`, variantsFormatted);

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
    return {
      formatted,
      metrics,
      variantsFormatted,
      iconScript: downloadIcons ? loadIconDownloadScript() : undefined,
    };
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
  downloadIcons?: boolean;
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
  outputFormat: OutputFormat,
  hooks: Pick<GetFigmaDataHooks, "colorTokensDir">,
): Promise<TargetProcessingResult> {
  const { fileKey, nodeId, depth, focusNodeId, downloadIcons } = target;
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

  // Primary-fetch raw dump only (see the single-target path for why it lives
  // here, not in FigmaService) — one raw JSON per target.
  writeLogs(`figma-raw-${debugSlug(fileKey, nodeId)}.json`, rawApiResponse);

  const simplifyStart = Date.now();
  let simplifiedDesign = await simplifyRawFigmaObject(rawApiResponse, allExtractors, {
    maxDepth: depth,
    afterChildren: collapseSvgContainers,
    nodeCounter,
  });
  const localTokens = loadColorTokensDir(hooks.colorTokensDir);
  const appkitHints = loadAppkitColorHints(hooks.colorTokensDir);
  simplifiedDesign = resolveVariableFillNames(simplifiedDesign, localTokens, appkitHints);

  parseVariantProperties(simplifiedDesign);
  await enrichComponentSetDefinitions(simplifiedDesign, figmaService, fileKey);
  const variantTargets = await resolveComponentLibraries(simplifiedDesign, figmaService);
  if (outputFormat.startsWith("native-")) {
    await attachVariantData(simplifiedDesign, variantTargets, figmaService);
  }
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
  // Render icons on the post-focus tree (same batched /images approach as the
  // single-target path), stamped inline as iconUrl.
  if (downloadIcons) {
    await collectIconRenderUrls(simplifiedDesign, figmaService, fileKey);
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
    downloadIcons,
  };
}

export type GetFigmaDataBatchEntryResult = {
  fileKey: string;
  nodeId?: string;
  formatted?: string;
  metrics?: GetFigmaDataMetrics;
  /** The second document (component-variant data) for this target, when the native format emitted one. */
  variantsFormatted?: string;
  /** The icon-download script's source, when this target used downloadIcons. See loadIconDownloadScript. */
  iconScript?: string;
  /** Set instead of formatted/metrics when this one target's fetch failed — isolated, never breaks the rest of the batch. */
  error?: string;
};

export type GetFigmaDataBatchResult = {
  entries: GetFigmaDataBatchEntryResult[];
};

export type GetFigmaDataBatchHooks = Pick<
  GetFigmaDataHooks,
  "colorTokensDir" | "onFetchStart" | "onSerializeStart"
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
        const result = await fetchAndEnrichTarget(figmaService, target, outputFormat, hooks);
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
    for (const p of succeeded) flagUnnamedAssets(p.design);
    addConsumptionGuide(succeeded[0].design, outputFormat);
  }

  await hooks.onSerializeStart?.();

  const entries: GetFigmaDataBatchEntryResult[] = processed.map((p) => {
    if (!p.ok) {
      return { fileKey: p.fileKey, nodeId: p.nodeId, error: p.error };
    }
    const serializeStart = Date.now();
    const wrapped = wrapForSerialization(p.design);
    const formatted = serializeResult(wrapped, outputFormat);
    const variantsFormatted = serializeVariantDocument(wrapped, outputFormat);
    const serializeMs = Date.now() - serializeStart;

    const finalExt = outputFormat.includes("json")
      ? "json"
      : outputFormat === "tree"
        ? "txt"
        : "yaml";
    writeLogs(`figma-final-${debugSlug(p.fileKey, p.nodeId)}.${finalExt}`, formatted);
    if (variantsFormatted)
      writeLogs(`figma-variants-${debugSlug(p.fileKey, p.nodeId)}.${finalExt}`, variantsFormatted);
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

    return {
      fileKey: p.fileKey,
      nodeId: p.nodeId,
      formatted,
      variantsFormatted,
      iconScript: p.downloadIcons ? loadIconDownloadScript() : undefined,
      metrics,
    };
  });

  return { entries };
}
