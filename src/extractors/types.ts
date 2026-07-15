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
  /**
   * Present (true) when the token name was inferred by matching the paint's
   * resolved color against the local token files, because the bound variable
   * ID wasn't in them. A color match can mislabel: the paint color the API
   * returns for a variable-bound fill is a resolution-time snapshot that can
   * lag the variable's live value (library update not yet accepted, different
   * mode), so the nearest-color token may be a genuinely different semantic
   * token. Absent = resolved by exact variable ID, fully trustworthy.
   */
  approx?: true;
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
}

export interface SimplifiedNode {
  id: string;
  name: string;
  type: string; // e.g. FRAME, TEXT, INSTANCE, RECTANGLE, etc.
  // text
  text?: string;
  textStyle?: string;
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
   * Filename of this icon's auto-downloaded vector PDF, relative to the
   * server's --image-dir. Present only when the fetch was called with
   * downloadIcons: true (see download-icons.ts) and this node is icon-shaped
   * (type IMAGE-SVG). Points at a file already saved to disk — no separate
   * download_figma_images call needed for this icon.
   */
  iconFile?: string;
  // layout & alignment
  layout?: string;
  /**
   * Source library file name of this instance's component ("macOS 15
   * Sequoia (Library)"), copied from its componentSet — placed on the node
   * so a sequential reader sees it without a componentId → componentSet join.
   */
  library?: string;
  /**
   * True when `library` is Apple's macOS UI kit: the instance IS the stock
   * AppKit control its component name describes ("Pop-Up Button" →
   * NSPopUpButton). Absent = the design team's own custom component.
   */
  native?: boolean;
  componentId?: string;
  componentProperties?: Record<string, boolean | string>;
  componentPropertyReferences?: Record<string, string>;
  // spatial metadata — parent reference and sibling order
  parentId?: string;
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
