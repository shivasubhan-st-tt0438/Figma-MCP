import type { Node as FigmaDocumentNode, Style } from "@figma/rest-api-spec";
import type { SimplifiedTextStyle } from "~/transformers/text.js";
import type { SimplifiedLayout } from "~/transformers/layout.js";
import type { SimplifiedFill, SimplifiedStroke } from "~/transformers/style.js";
import type { SimplifiedEffects } from "~/transformers/effects.js";
import type {
  SimplifiedComponentDefinition,
  SimplifiedComponentSetDefinition,
  SimplifiedPropertyDefinition,
} from "~/transformers/component.js";

export type StyleTypes =
  | SimplifiedTextStyle
  | SimplifiedFill[]
  | SimplifiedLayout
  | SimplifiedStroke
  | SimplifiedEffects
  | string;

export type GlobalVars = {
  styles: Record<string, StyleTypes>;
  /**
   * Metadata for every design token (Figma Variable) that was resolved to a
   * friendly name during this fetch, keyed by the token path used in `styles`
   * (e.g. "accents_brown"). Answers the "semantic or static?" question a
   * native consumer must get right: `themed: true` means the token has
   * different values per appearance mode and must map to a semantic/dynamic
   * color, never a hardcoded hex.
   */
  tokens?: Record<string, ResolvedTokenInfo>;
};

export type ResolvedTokenInfo = {
  /** Color value per appearance mode, e.g. { Light: "#A2845E", Dark: "#AC8E68" }. */
  values: Record<string, string>;
  /** True when the token's value differs across appearance modes. */
  themed: boolean;
  /** Suggested AppKit API for this token (e.g. "NSColor.systemBrown"), when known. */
  appkit?: string;
};

export interface TraversalContext {
  globalVars: GlobalVars;
  extraStyles?: Record<string, Style>;
  currentDepth: number;
  parent?: FigmaDocumentNode;
  traversalState: TraversalState;
  /**
   * Per-call mutable counter shared with the caller. Lives on the context so
   * walker recursion can increment it without touching module-global state —
   * concurrent extractFromDesign calls (e.g. overlapping HTTP requests) each
   * own their counter and never collide.
   */
  nodeCounter: NodeCounter;
  /** Zero-based index of this node among its parent's children. */
  siblingIndex?: number;
}

/**
 * Mutable progress counter passed into traversal. Callers can read `count`
 * during traversal (for live progress indicators) and after it returns
 * (as the final node-walked metric).
 */
export type NodeCounter = { count: number };

export interface TraversalState {
  componentPropertyDefinitions: Record<string, Record<string, SimplifiedPropertyDefinition>>;
  /**
   * Sequential counter for inline text-style override IDs (`ts1`, `ts2`, ...).
   * Lives on the traversal state so every text node in a run shares the same
   * namespace, which lets `{tsN}…{/tsN}` references appear inline in text
   * content with short, readable identifiers.
   */
  tsCounter: number;
}

export interface TraversalOptions {
  maxDepth?: number;
  nodeFilter?: (node: FigmaDocumentNode) => boolean;
  /**
   * Called after children are processed, allowing modification of the parent node
   * and control over which children to include in the output.
   *
   * @param node - Original Figma node
   * @param result - SimplifiedNode being built (can be mutated)
   * @param children - Processed children
   * @returns Children to include (return empty array to omit children)
   */
  afterChildren?: (
    node: FigmaDocumentNode,
    result: SimplifiedNode,
    children: SimplifiedNode[],
  ) => SimplifiedNode[];
  /**
   * Optional caller-supplied counter. The walker increments it as it processes
   * nodes, so callers that need a live readout (e.g. progress heartbeats) or a
   * post-call metric can read from the same object. If omitted, the walker
   * creates its own internal counter.
   */
  nodeCounter?: NodeCounter;
}

/**
 * An extractor function that can modify a SimplifiedNode during traversal.
 *
 * @param node - The current Figma node being processed
 * @param result - SimplifiedNode object being built—this can be mutated inside the extractor
 * @param context - Traversal context including globalVars and parent info. This can also be mutated inside the extractor.
 */
export type ExtractorFn = (
  node: FigmaDocumentNode,
  result: SimplifiedNode,
  context: TraversalContext,
) => void;

export interface SimplifiedDesign {
  name: string;
  nodes: SimplifiedNode[];
  components: Record<string, SimplifiedComponentDefinition>;
  componentSets: Record<string, SimplifiedComponentSetDefinition>;
  globalVars: GlobalVars;
  /**
   * Consumption rules embedded in the output itself (serialized under
   * metadata.guide). Downstream consumers are typically LLMs reading this
   * document with no access to this repo's docs — the rules that prevent the
   * known misreadings (treating absoluteBoundingBox as constraints,
   * rebuilding native controls from their visual decomposition, missing
   * token indirection) must travel with the data.
   */
  guide?: string[];
  /**
   * Every variant of a component whose designer pinned a Figma-design-URL
   * Dev Resources link (as opposed to a .swift path — see attachDevResources
   * in enrich-design.ts) on a node present in this fetch. A screen only ever
   * shows the one variant that's actually placed there; this carries the
   * full state matrix (fetched fresh, in the same call) so implementing all
   * of it doesn't require a second round-trip. Deduplicated by the link's
   * target ({fileKey, nodeId}) — two different consuming nodes (e.g. a
   * Cancel and an OK button that are both instances of the same component)
   * pointing at the same reference link produce one shared entry here, not
   * two. Each entry is already fully self-contained (styles inlined, not
   * globalVars refs, regardless of this response's own output format) and
   * stripped of fields that only describe this specific reference layout —
   * siblingIndex, parentName, and the gap/padding/
   * locationRelativeToParent that only exist to arrange documentation
   * swatches — since none of that is real app layout. Loosely typed (not
   * SimplifiedNode) because the shape is post-inlining (see NativeNode in
   * native-json.ts) — importing that type here would create a cycle.
   */
  componentVariantReferences?: Record<string, unknown>[];
  /**
   * Consolidated component-variant document, emitted as a SECOND YAML
   * alongside the primary tree (see attachVariantData in variant-cache-pass.ts
   * and the two-document serialization in native-json.ts). Present only when
   * the fetch resolved remote component sets. Holds what the primary's
   * `components`/`componentSets` sections used to carry (so those are omitted
   * from the primary when this is present, and a node's `compId` resolves
   * here instead), ENRICHED per set with its full fetched variant UI — for
   * custom sets only; native/icon sets carry metadata + a tag but no UI
   * (a native control renders its own states; an icon's content is the asset).
   * Loosely typed for the same reason as componentVariantReferences: the set
   * entries hold post-inlining NativeNode data, importing which would cycle.
   */
  variantData?: {
    date: string;
    components: Record<string, SimplifiedComponentDefinition>;
    componentSets: Record<string, unknown>;
  };
  /**
   * Assets in the (scoped) tree that carry NO design-system name — a color used
   * as a raw hex/rgba instead of a bound Variable, an icon with a placeholder
   * name (Vector/Rectangle/…), or text in a raw font with no named text style.
   * Surfaced so the consumer can catalog them into a real asset folder (see the
   * guide) instead of silently shipping unnamed assets. Deduped.
   */
  unnamedAssets?: {
    colors?: string[];
    icons?: { name: string; id: string }[];
    fonts?: string[];
  };
}

export interface SimplifiedNode {
  id: string;
  name: string;
  type: string; // e.g. FRAME, TEXT, INSTANCE, RECTANGLE, etc.
  // text
  text?: string;
  textStyle?: string;
  /**
   * The design-system name of the Figma TEXT style this node uses (e.g.
   * "Body/Regular", "❇️ Emphasized/Title 3"), when it references a named
   * shared style. Absent means the text uses a raw/unnamed font — which the
   * unnamed-asset flagging pass surfaces. Captured at extraction because
   * native inlining collapses `textStyle` to raw values, losing the name.
   */
  textStyleName?: string;
  /**
   * The numeric font weight that `**bold**` inside `text` maps to. Only emitted
   * when a text node has per-character bold overrides heavier than its base
   * `style.fontWeight`, so the consumer knows how to realize markdown bold.
   */
  boldWeight?: number;
  // appearance
  fills?: string;
  styles?: string;
  strokes?: string;
  // Non-stylable stroke properties are kept on the node when stroke uses a named color style
  strokeWeight?: string;
  strokeDashes?: number[];
  strokeWeights?: string;
  effects?: string;
  opacity?: number;
  borderRadius?: string;
  /**
   * Raw Figma Variable IDs (e.g. "VariableID:<hash>/2443:1606") bound to this
   * node's fill paints, keyed by index into the resolved fills array (a fill
   * can be multiple layered paints, each independently bindable). Only present
   * while a bound variable is detected AND not yet resolved to a friendly name
   * (see resolveVariableFillNames) — resolved entries are removed and the
   * corresponding paint (or the whole `fills` key, for single-paint fills) is
   * renamed to the token path instead of an auto-generated `fill_XXXXXX` id.
   * Entries left in place are diagnostics: resolution wasn't possible (missing
   * token scope, unsupported plan, or a library variable absent from the local
   * token exports).
   */
  fillVariableIds?: Record<number, string>;
  /**
   * SF Symbol names for private-use-area glyphs found in `text`, in order of
   * appearance (e.g. ["chevron.down"] for "􀆈"). Unknown codepoints surface as
   * "U+XXXXX" placeholders. Present only when `text` contains PUA characters.
   */
  sfSymbols?: string[];
  /**
   * A downloadable Figma render URL (vector PDF) for this icon, stamped by
   * collectIconRenderUrls when the fetch was called with `downloadIcons: true`
   * and this node is an icon (type IMAGE-SVG, any size, not native
   * decomposition). Fetch the URL to get the bytes — the server never writes
   * files. The URL has no extension/filename; save the download as
   * `<node name>.pdf` using this node's own `name` (its real Figma icon name),
   * not the URL's random id. Present only on icons that actually rendered.
   */
  iconUrl?: string;
  /**
   * This node already has a real Swift implementation — a designer pinned a
   * Dev Resources link ending in .swift (Figma's widget requires something
   * URL-shaped, so a bare file path gets an "https://" prefix bolted on to
   * pass validation; stripped here). `file` is its repo-relative path.
   * `symbol` is the Swift class name this node is implemented by — the entire
   * name the designer typed, taken verbatim (no decomposition, even if it
   * contains underscores). Takes priority over native — see attachDevResources
   * in enrich-design.ts.
   */
  implementedBy?: { file: string; symbol: string }[];
  // layout & alignment
  layout?: string;
  /**
   * True when this instance's component was published from Apple's macOS UI
   * kit Figma library: the instance IS the stock AppKit control its
   * component name describes ("Pop-Up Button" → NSPopUpButton). Absent = the
   * design team's own custom component. The publishing library's own name
   * (e.g. "macOS 15 Sequoia (Library)") is resolved internally to compute
   * this boolean but not persisted on the node — once native/custom is
   * decided, the library name itself has nothing left to add.
   */
  native?: boolean;
  componentId?: string;
  componentProperties?: Record<string, boolean | string>;
  componentPropertyReferences?: Record<string, string>;
  // spatial metadata — parent reference and sibling order. Only the name is
  // kept: the id would just duplicate the tree's own nesting (a consumer
  // already sees the parent as the enclosing block) while being a longer,
  // opaque compound-instance string — the name is the only part that adds
  // readable signal.
  parentName?: string;
  siblingIndex?: number;
  // canvas-absolute size only — no x/y (see nodeMetaExtractor for why)
  absoluteBoundingBox?: { width: number; height: number };
  // visual transform
  rotation?: number;
  blendMode?: string;
  strokeAlign?: "INSIDE" | "OUTSIDE" | "CENTER";
  /**
   * Present (and false) only when this node is hidden in the design. Absent
   * means visible — the common case. A hidden node still appears in the tree
   * (see shouldProcessNode in node-walker.ts) because hidden UI is often
   * meaningful app state (a toggled-off badge/avatar/icon in this instance),
   * not decorative cruft to silently drop.
   */
  visible?: false;
  // children
  children?: SimplifiedNode[];
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
