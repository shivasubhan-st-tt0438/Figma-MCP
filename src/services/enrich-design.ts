import type { SimplifiedDesign, SimplifiedNode } from "~/extractors/types.js";
import type { FigmaService } from "~/services/figma.js";
import type { OutputFormat } from "~/utils/serialize.js";
import { parseVariantName, simplifyPropertyDefinitions } from "~/transformers/component.js";
import { SF_SYMBOL_NAMES } from "~/data/sf-symbols.js";
import { Logger } from "~/utils/logger.js";

/**
 * Post-traversal enrichment passes. Each pass adds a piece of context a
 * native-code consumer would otherwise have to guess:
 *
 * - variant state:      which variant every component name encodes
 * - variant definitions: every state a component set can be in + its default
 * - native hints:       which AppKit control a component set maps to
 * - SF Symbol names:    what the unrenderable PUA glyphs in text actually are
 *
 * All passes are best-effort and mutate the design in place — a failure in
 * any of them must never break the fetch itself.
 */

/**
 * Parse "Prop=Value, Prop=Value" component names into structured
 * variantProperties on each component definition.
 */
export function parseVariantProperties(design: SimplifiedDesign): void {
  for (const component of Object.values(design.components)) {
    if (!component.componentSetId) continue;
    const props = parseVariantName(component.name);
    if (props) component.variantProperties = props;
  }
}

/**
 * Fetch the COMPONENT_SET nodes referenced by this design and copy their
 * componentPropertyDefinitions (VARIANT options + defaults) into
 * metadata.componentSets. One batched /nodes call for all sets; sets living
 * in external library files come back null and are skipped silently.
 */
export async function enrichComponentSetDefinitions(
  design: SimplifiedDesign,
  figmaService: FigmaService,
  fileKey: string,
): Promise<void> {
  const setIds = Object.keys(design.componentSets).filter(
    (id) => !design.componentSets[id].propertyDefinitions,
  );
  if (setIds.length === 0) return;

  let response;
  try {
    // depth=1: we only need the set node's own componentPropertyDefinitions,
    // not its variant children.
    response = await figmaService.getRawNode(fileKey, setIds.join(","), 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Logger.log(`Skipping component-set definition fetch (${setIds.length} sets): ${message}`);
    return;
  }

  for (const [id, entry] of Object.entries(response.data.nodes)) {
    const target = design.componentSets[id];
    if (!target || !entry?.document) continue;
    const doc = entry.document as {
      componentPropertyDefinitions?: Record<
        string,
        { type: string; defaultValue: boolean | string; variantOptions?: string[] }
      >;
    };
    if (doc.componentPropertyDefinitions) {
      const defs = simplifyPropertyDefinitions(doc.componentPropertyDefinitions);
      if (Object.keys(defs).length > 0) target.propertyDefinitions = defs;
    }
  }
}

/**
 * Names Apple's official macOS UI kit Figma libraries across releases
 * ("macOS 15 Sequoia (Library)", "macOS 14 Sonoma", …). Components published
 * from these files ARE stock AppKit controls; everything else is custom.
 */
const APPLE_MACOS_LIBRARY = /macos/i;

/**
 * Resolve which library file every remote component was published from, and
 * stamp `library` (the file's name) + `native` (is it Apple's macOS UI kit?)
 * onto component sets, set-less components, and every INSTANCE node.
 *
 * This replaces the old name→NSClass guessing table (design-hints.ts): the
 * library is ground truth the designer can't accidentally break by renaming
 * a component — Figma's own inspect panel shows the same "Component instance
 * (macOS 15 Sequoia (Library))" provenance. Components local to the fetched
 * file get no stamp at all: local by definition means the design team drew
 * it, i.e. custom.
 *
 * Cost: one /component_sets/:key (or /components/:key) call per unique
 * remote key, plus one /files/:key/meta call per unique library file
 * (typically 1-2). All best-effort — an unpublished key or missing library
 * access logs and leaves the component unstamped (treated as custom).
 *
 * The per-node copy exists because consumers read the tree sequentially — a
 * fact that requires a componentId → componentSet join hundreds of lines
 * away gets missed.
 */
export async function resolveComponentLibraries(
  design: SimplifiedDesign,
  figmaService: FigmaService,
): Promise<void> {
  const remoteSets = Object.values(design.componentSets).filter((s) => s.remote);
  // Components inside a set inherit the set's library; only set-less
  // components need their own lookup.
  const looseComponents = Object.values(design.components).filter(
    (c) => c.remote && !c.componentSetId,
  );
  if (remoteSets.length === 0 && looseComponents.length === 0) return;

  const fileKeyByComponentKey = new Map<string, string>();
  await Promise.all([
    ...[...new Set(remoteSets.map((s) => s.key))].map(async (key) => {
      try {
        const res = await figmaService.getComponentSetByKey(key);
        fileKeyByComponentKey.set(key, res.meta.file_key);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        Logger.log(`Could not resolve component set ${key} to a library: ${message}`);
      }
    }),
    ...[...new Set(looseComponents.map((c) => c.key))].map(async (key) => {
      try {
        const res = await figmaService.getComponentByKey(key);
        fileKeyByComponentKey.set(key, res.meta.file_key);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        Logger.log(`Could not resolve component ${key} to a library: ${message}`);
      }
    }),
  ]);

  const libraryNameByFileKey = new Map<string, string>();
  await Promise.all(
    [...new Set(fileKeyByComponentKey.values())].map(async (fileKey) => {
      try {
        const meta = await figmaService.getFileMeta(fileKey);
        libraryNameByFileKey.set(fileKey, meta.name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        Logger.log(`Could not resolve library file ${fileKey} name: ${message}`);
      }
    }),
  );

  const stamp = (target: { library?: string; native?: boolean }, componentKey: string): void => {
    const fileKey = fileKeyByComponentKey.get(componentKey);
    const library = fileKey ? libraryNameByFileKey.get(fileKey) : undefined;
    if (!library) return;
    target.library = library;
    if (APPLE_MACOS_LIBRARY.test(library)) target.native = true;
  };
  for (const set of remoteSets) stamp(set, set.key);
  for (const component of looseComponents) stamp(component, component.key);

  const originByComponentId = new Map<string, { library?: string; native?: boolean }>();
  for (const [componentId, component] of Object.entries(design.components)) {
    const origin = component.componentSetId
      ? design.componentSets[component.componentSetId]
      : component;
    if (origin?.library) originByComponentId.set(componentId, origin);
  }
  if (originByComponentId.size === 0) return;

  const visit = (nodes: SimplifiedNode[]): void => {
    for (const node of nodes) {
      if (node.componentId) {
        const origin = originByComponentId.get(node.componentId);
        if (origin) {
          node.library = origin.library;
          if (origin.native) node.native = true;
        }
      }
      if (node.children) visit(node.children);
    }
  };
  visit(design.nodes);
}

/** SF Symbols occupy Unicode planes 15-16 (private use). */
const PUA_START = 0xf0000;

/**
 * Annotate every text node whose content contains private-use-area glyphs
 * with the corresponding SF Symbol names, in order of appearance, AND
 * replace the glyph in the text itself with a readable "{sf:name}"
 * placeholder. The raw PUA character is invisible/mojibake to every consumer
 * (and unrenderable by AppKit string APIs anyway) — leaving it in `text`
 * invites treating it as literal content. Unknown codepoints (symbols newer
 * than the vendored table) surface as "{sf:U+XXXXX}" so they stay greppable
 * rather than silently invisible.
 */
export function annotateSfSymbols(design: SimplifiedDesign): void {
  const visit = (nodes: SimplifiedNode[]): void => {
    for (const node of nodes) {
      if (node.text) {
        const names: string[] = [];
        let rewritten = "";
        for (const ch of node.text) {
          const cp = ch.codePointAt(0)!;
          if (cp >= PUA_START) {
            const name = SF_SYMBOL_NAMES[cp] ?? `U+${cp.toString(16).toUpperCase()}`;
            names.push(name);
            rewritten += `{sf:${name}}`;
          } else {
            rewritten += ch;
          }
        }
        if (names.length > 0) {
          node.sfSymbols = names;
          node.text = rewritten;
        }
      }
      if (node.children) visit(node.children);
    }
  };
  visit(design.nodes);
}

/**
 * Consumption rules that hold regardless of output format — shared between
 * the per-response embedded guide (design.guide, works with every MCP
 * client) and the server's MCP `instructions` (sent once at session init,
 * see mcp/index.ts — support varies by client, so the embedded copy is the
 * reliable fallback, not a replacement).
 */
export const CONSUMPTION_GUIDE: readonly string[] = [
  "layout: mode/gap/padding/sizing map to NSStackView (orientation, spacing, edgeInsets); sizing hug = size-to-content, fill = stretch. Add width/height constraints ONLY when sizing is 'fixed' (value in layout dimensions). absoluteBoundingBox is the rendered size for reference/verification — never hardcode it as constraints alongside stack layout.",
  "instance nodes with native: true come from Apple's macOS UI kit Figma library (library names the source file) — implement the stock AppKit control the component name describes (component 'Pop-Up Button' → NSPopUpButton). Their children are Figma's visual decomposition of that control (drawn cursors, selection frames, placeholder layers, chevron glyphs) — mine them for strings/icons/state, do NOT rebuild them as views. Instances without native: true are this app's own custom components — map them to the app's custom Swift classes, not stock AppKit.",
  "{sf:name} inside text is an SF Symbol — set it via NSImage(systemSymbolName:) on the control (names also listed under the node's sfSymbols); it is not literal string content.",
  "boxShadow may list multiple comma-separated shadow layers; NSView supports a single NSShadow — match the dominant (largest-blur) layer unless a pixel-exact focus ring justifies custom layer drawing.",
];

/** Describes where a design-token fill/stroke resolves to — differs by output format (see native-json.ts). */
const TOKEN_INDIRECTION_NATIVE =
  "fills/strokes with snake_case names are design tokens, inlined in place as { token, values, themed, appkit } — no lookup elsewhere in the document. themed: true means the design defines different Light and Dark values — but per the LIGHT THEME ONLY rule below, implement the Light value (values.Light); values.Dark is reference data, not something to build. approx: true means the token name was inferred by color match (the bound variable's ID wasn't in the local token exports) — treat it as a best guess and verify against the design, because the API's color snapshot for a variable-bound fill can lag the variable's live value.";
const TOKEN_INDIRECTION_REF =
  "fills/strokes with snake_case names are design tokens — per-mode values under globalVars.tokens[name]. themed: true means the design defines different Light and Dark values — but per the LIGHT THEME ONLY rule below, implement the Light value (values.Light); values.Dark is reference data, not something to build. approx: true means the token name was inferred by color match (the bound variable's ID wasn't in the local token exports) — treat it as a best guess and verify against the design, because the API's color snapshot for a variable-bound fill can lag the variable's live value.";

/**
 * Project directive: how to behave when using this MCP, not how to parse its
 * output (that's CONSUMPTION_GUIDE). Baked directly into this fork rather
 * than loaded from an external project file — this server is a customized
 * bridge for one specific app, handed out as a self-contained unit, so the
 * directive must travel with the MCP itself with zero setup by whoever
 * receives it. Deliberately self-contained (no "see other doc" pointers):
 * anyone who has this server has everything in this array, nothing else.
 */
export const PROJECT_DIRECTIVE: readonly string[] = [
  "IDENTITY: this is a custom Figma MCP built for a native macOS app written in Swift/AppKit. For any task that implements, updates, or compares against a Figma design, use this MCP's own tools (get_figma_data, download_figma_images, write_imageset, write_colorset) as the source of truth — never guess a color, spacing value, or icon name, and never browse Figma directly instead of calling a tool.",
  "ARCHITECTURE: UI framework is AppKit only — never SwiftUI. Preferred pattern is VIPER (View/Interactor/Presenter/Entity/Router) for document/module-level work; a simpler MVP (Model/View/Presenter) is acceptable for small, self-contained features. Match whatever pattern the surrounding code in that area already uses rather than forcing one pattern everywhere; if neither fits, pick the closest reasonable pattern and state which one you chose and why.",
  "ASSET & VALUE FIDELITY WORKFLOW — required before writing UI code from a Figma fetch: (1) fetch the target node(s) with get_figma_data, passing downloadIcons: true — every icon (IMAGE-SVG node) in the tree is then auto-downloaded as a vector PDF and each icon node's output carries iconFile with the saved filename, so there is no separate per-icon download step to orchestrate; use download_figma_images only for non-icon raster IMAGE fills (photos/logos) that downloadIcons does not cover — never reference any Figma asset without it being pulled down and inspected; (2) compare the downloaded assets and every resolved color/value against what the app currently has (existing image assets, colors, layout constants already in the codebase); (3) match Figma's values exactly — do not round, approximate, or silently substitute an existing 'close enough' value; (4) exception: deviate from the literal Figma value only when applying it as-is would create a genuine inconsistency in the running app (e.g. the exact asset can't be produced cleanly, the color is shared across many call sites and a global change would be wrong, or the design node is ambiguous between multiple existing implementations); (5) always disclose deviations — if you change or override a fetched value for any reason, tell the user explicitly which value you changed, from what to what, and the specific cause. Never change a value silently.",
  "LARGE FETCHES — split into sub-modules, verify one at a time: if a fetched node tree is too large to hold and implement correctly in one pass (many nodes, deep nesting, a large native-yaml/native-json output), do not implement it in one shot. Re-fetch it broken up instead — call get_figma_data again with the nodeId of one child section/screen/component at a time rather than consuming the whole parent tree at once. Implement and verify each sub-module fully (it compiles, matches the fetched values, no regressions) before moving to the next; only wire sub-modules together after every one of them is individually confirmed correct.",
  "ICON vs IMAGE — export the icon, not the image: an asset frequently has both an Icon representation (cropped tight to the visible glyph — the one actually placed in the app UI, small, usually a VECTOR/IMAGE-SVG node) and an Image representation (the larger/uncropped source artwork it was cut from). When a container has both, resolve the nodeId from the Icon child/section specifically and pass THAT to write_imageset — never the Image one, even though the Image node is often easier to spot (larger, sits earlier in the layer list). Before calling write_imageset, sanity-check that the chosen node's absoluteBoundingBox roughly matches the icon's actual on-screen size in the design — a full/uncropped Image node will be visibly larger or a different aspect ratio than the icon slot it's meant to fill; if it doesn't match, you picked the wrong node.",
  "LIGHT THEME ONLY — implement against Light mode values; the UI must not change when the system switches to dark: always use a token's Light value (values.Light), never values.Dark; add no dark-mode branches, no NSAppearance/effectiveAppearance observers, and no dark variants in asset-catalog colorsets you create. Be careful with adaptive AppKit semantic colors (NSColor.labelColor and friends): they flip automatically with the system appearance, so unless the app or the containing window/view is explicitly pinned to light (NSAppearance .aqua), prefer the fixed Light value from the fetch over the adaptive color — even when the token metadata suggests an appkit name. If a task ever genuinely requires dark-mode support, that is a user decision — ask first, don't add it on your own.",
  "TYPOGRAPHY & VALUE DRIFT — never alter fetched values, never revert them later: font size, font weight, line height, letter spacing, colors and alpha come only from the fetched textStyle/fills — never round, 'normalize', or swap them for a value that merely feels more standard (fontSize 13 stays 13; weight 510 stays 510, not 500 or 'medium'). This applies equally to later edits: when modifying code previously implemented from a fetch, do not touch font/color/spacing values outside the requested change — a later edit that silently reverts a previously-correct fetched value is a regression, not a cleanup. Before finishing any UI change, re-read the fetched values for every text node you touched and confirm each fontSize/fontWeight/color you wrote matches exactly; if you believe a fetched value is a design mistake, say so to the user and ask — never adjust it silently.",
  "ICONS — FIGMA IS THE ONLY SOURCE, NEVER SUBSTITUTE: every icon in the implemented UI must come from this exact Figma fetch — either the auto-downloaded vector PDF (iconFile, from downloadIcons: true) written into the app's asset catalog via write_imageset, or the exact SF Symbol name the design itself encodes ({sf:name} in text — that IS Figma's own choice of icon, not an external substitution, so using it is required, not prohibited). Never pick a 'close enough' system icon, a different SF Symbol that merely looks similar, or any icon from outside this fetch — not from memory, not from a generic icon set, not by guessing a plausible SF Symbol name that wasn't actually in the data. If the exact icon can't be resolved (download failed, node ambiguous, no {sf:name} present), stop and tell the user exactly which icon is missing and why — never silently render a placeholder or substitute as if it were the real asset.",
];

/**
 * Embed consumption rules into the output itself. These correct the known
 * ways downstream code-generating consumers misread this format; they must
 * live in the document because the consumer usually has nothing else.
 */
export function addConsumptionGuide(design: SimplifiedDesign, outputFormat: OutputFormat): void {
  const tokenRule = outputFormat.startsWith("native-")
    ? TOKEN_INDIRECTION_NATIVE
    : TOKEN_INDIRECTION_REF;
  design.guide = [
    ...CONSUMPTION_GUIDE.slice(0, 2),
    tokenRule,
    ...CONSUMPTION_GUIDE.slice(2),
    ...PROJECT_DIRECTIVE,
  ];
}
