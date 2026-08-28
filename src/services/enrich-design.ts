import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { SimplifiedDesign, SimplifiedNode } from "~/extractors/types.js";
import type { FigmaService } from "~/services/figma.js";
import type { OutputFormat } from "~/utils/serialize.js";
import { parseVariantName, simplifyPropertyDefinitions } from "~/transformers/component.js";
import { SF_SYMBOL_NAMES } from "~/data/sf-symbols.js";
import { slugify } from "~/utils/slugify.js";
import { Logger } from "~/utils/logger.js";
import { simplifyRawFigmaObject, allExtractors } from "~/extractors/index.js";
import { inlineNode, type NativeNode } from "~/utils/native-json.js";
import { tryParseFigmaUrl } from "~/utils/figma-url.js";

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
 * The slugified prefix that identifies Apple's own platform UI kit (default
 * "macos", matching "macOS 15 Sequoia (Library)", "macOS 14 Sonoma", …).
 * Read directly from the environment — like variantCacheDir/variantFetchEnabled
 * in variant-cache.ts — since it's a server-wide fact about which Figma
 * library is Apple's kit, not something that varies per request. Overriding
 * it is for porting this server to a different platform's kit (e.g. an iOS
 * library named "iOS 18 (Library)"), not a per-fetch concern.
 */
function nativeLibraryPrefix(): string {
  return slugify(process.env.FIGMA_MCP_NATIVE_LIBRARY_PREFIX || "macos");
}

/**
 * Detects Apple's official platform UI kit Figma libraries across releases.
 * Components published from these files ARE stock AppKit controls;
 * everything else is custom.
 *
 * Matches the configured prefix at the START of the slugified name (emoji
 * prefixes and parentheticals stripped) — NOT anywhere in it. A bare
 * /macos/i test misclassified the design team's own component library
 * "🧤 UI Content - macOS" as Apple's kit, stamping custom components
 * native: true while their pinned dev resources correctly pointed at custom
 * Swift classes. Apple names its kits with the platform first; team
 * libraries that merely target macOS mention it elsewhere in the name.
 */
function isAppleMacosLibrary(libraryName: string): boolean {
  return slugify(libraryName).startsWith(nativeLibraryPrefix());
}

/**
 * Detects the design system's icon library (e.g. "🛑 Sheet Icons Library").
 * Components published from it are pure icon assets — their "variants" are
 * size/color, not UI states — so they get no source fetch, no variant list,
 * and their componentProperties are stripped (see resolveComponentLibraries).
 * Name-based like isAppleMacosLibrary (emoji/case stripped by slugify), so it
 * needs no hardcoded file key and survives the library being re-keyed.
 */
function isIconLibrary(libraryName: string): boolean {
  const slug = slugify(libraryName);
  return slug.includes("icon") && slug.includes("library");
}

/**
 * One remote component set's identity + where its full variant set lives,
 * produced by resolveComponentLibraries and consumed by the variant-cache
 * pass. `source` is absent when the publish-key → file lookup failed (the set
 * can still be listed, just not fetched).
 */
export interface VariantSetTarget {
  /** The set's id in the fetched design — what a node's compId → compSetId resolves to. */
  setId: string;
  /** Human-readable set name, e.g. "Push Button". */
  name: string;
  /** Stable publish key — the cross-file-stable cache identity for this set. */
  publishKey: string;
  /** True when the set is Apple's macOS kit: agent maps to the real NS* control, ignores the variant UI. */
  native: boolean;
  /** Source library file + the set's node within it; absent when key resolution failed. */
  source?: { fileKey: string; nodeId: string };
}

/**
 * Resolve which library file every remote component was published from, and
 * stamp `native` (is it Apple's macOS UI kit?) onto every INSTANCE node.
 * `remote`/`native` on component sets and set-less components are scratch
 * state for this resolution only — the only copy that survives into the
 * output lives on the node, since consumers read the tree sequentially and a
 * componentId → componentSet join hundreds of lines away would get missed.
 * The library file's own name is resolved purely to make that one boolean
 * decision — it's never persisted anywhere; once native/custom is decided,
 * the name string itself has nothing left to add downstream.
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
 */
export async function resolveComponentLibraries(
  design: SimplifiedDesign,
  figmaService: FigmaService,
): Promise<Map<string, VariantSetTarget>> {
  const remoteSets = Object.values(design.componentSets).filter((s) => s.remote);
  // Components inside a set inherit the set's library; only set-less
  // components need their own lookup.
  const looseComponents = Object.values(design.components).filter(
    (c) => c.remote && !c.componentSetId,
  );
  if (remoteSets.length === 0 && looseComponents.length === 0) return new Map();

  // `remote` (read above) and `native` (stamped below) are working state for
  // this function alone — strip both before returning so neither ever
  // reaches the output; only the per-node stamp is meant to be visible.
  const stripWorkingState = (): void => {
    for (const set of Object.values(design.componentSets)) {
      delete set.remote;
      delete set.native;
    }
    for (const component of Object.values(design.components)) {
      delete component.remote;
      delete component.native;
    }
  };

  // node_id (alongside file_key) is captured because the variant-cache pass
  // needs the set's own node in its source library to fetch its full variant
  // set — the same resolution that decides native/custom already returns it,
  // so capturing it here avoids a second round of getComponentSetByKey calls.
  const fileKeyByComponentKey = new Map<string, string>();
  const nodeIdByComponentKey = new Map<string, string>();
  await Promise.all([
    ...[...new Set(remoteSets.map((s) => s.key))].map(async (key) => {
      try {
        const res = await figmaService.getComponentSetByKey(key);
        fileKeyByComponentKey.set(key, res.meta.file_key);
        if (res.meta.node_id) nodeIdByComponentKey.set(key, res.meta.node_id);
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

  // Classify each remote set by its SOURCE LIBRARY NAME (ground truth from
  // getFileMeta above — never guessed from the component's own layer name):
  //   Apple's macOS kit    -> native (map to NS*; keep variantOptions + props)
  //   Sheet Icons Library  -> icon   (no fetch, no variant list, strip props;
  //                                    the icon asset on the node is all that matters)
  //   anything else remote -> custom (fetch its variant UI)
  const libraryOf = (componentKey: string): string | undefined => {
    const fileKey = fileKeyByComponentKey.get(componentKey);
    return fileKey ? libraryNameByFileKey.get(fileKey) : undefined;
  };
  const iconLibrarySetIds = new Set<string>();
  for (const [setId, set] of Object.entries(design.componentSets)) {
    if (!set.remote) continue;
    const library = libraryOf(set.key);
    if (!library) continue;
    if (isAppleMacosLibrary(library)) set.native = true;
    else if (isIconLibrary(library)) iconLibrarySetIds.add(setId);
  }
  for (const component of looseComponents) {
    const library = libraryOf(component.key);
    if (library && isAppleMacosLibrary(library)) component.native = true;
  }

  const nativeComponentIds = new Set<string>();
  const iconComponentIds = new Set<string>();
  for (const [componentId, component] of Object.entries(design.components)) {
    const setId = component.componentSetId;
    const origin = setId ? design.componentSets[setId] : component;
    if (origin?.native) nativeComponentIds.add(componentId);
    if (setId && iconLibrarySetIds.has(setId)) iconComponentIds.add(componentId);
  }

  if (nativeComponentIds.size > 0 || iconComponentIds.size > 0) {
    const visit = (nodes: SimplifiedNode[]): void => {
      for (const node of nodes) {
        if (node.componentId) {
          if (nativeComponentIds.has(node.componentId)) node.native = true;
          // Icon-library instance: strip componentProperties (Size/Colored
          // variant noise) — the icon asset on the node is the real content.
          if (iconComponentIds.has(node.componentId)) delete node.componentProperties;
        }
        if (node.children) visit(node.children);
      }
    };
    visit(design.nodes);
  }

  // Variant-fetch targets: one per remote SET, EXCLUDING icon-library sets
  // (no fetch and no variant-doc entry for them at all). Loose components
  // aren't variant families. `source` absent = key resolution failed (skip).
  const targets = new Map<string, VariantSetTarget>();
  for (const [setId, set] of Object.entries(design.componentSets)) {
    if (!set.remote || iconLibrarySetIds.has(setId)) continue;
    const fileKey = fileKeyByComponentKey.get(set.key);
    const nodeId = nodeIdByComponentKey.get(set.key);
    targets.set(setId, {
      setId,
      name: set.name,
      publishKey: set.key,
      native: set.native === true,
      source: fileKey && nodeId ? { fileKey, nodeId } : undefined,
    });
  }

  stripWorkingState();
  return targets;
}

/**
 * Drops the children of a `native: true` instance when nothing in that
 * subtree is worth mining. Per the "Native vs Custom Components" consumption
 * rule, a native instance's children are Figma's own visual decomposition of
 * a stock AppKit control (drawn cursors, chevrons, the traffic-light dots
 * inside a native Titlebar) — real information only when one of them carries
 * actual text or a bound property (e.g. a Title's Label child with real
 * content); otherwise it's a redraw of something the app never builds itself
 * (the real control draws its own chrome), pure token cost with nothing to
 * mine.
 *
 * Must run after resolveComponentLibraries, which is what stamps `native` in
 * the first place. Recurses into kept subtrees so a nested native instance
 * (e.g. a native Window Controls INSTANCE inside a native Titlebar INSTANCE)
 * still gets its own independent prune decision.
 */
export function pruneNativeDecoration(design: SimplifiedDesign): void {
  const hasMineableContent = (nodes: SimplifiedNode[]): boolean => {
    for (const node of nodes) {
      if (node.text || node.componentPropertyReferences) return true;
      if (node.children && hasMineableContent(node.children)) return true;
    }
    return false;
  };

  const visit = (nodes: SimplifiedNode[]): void => {
    for (const node of nodes) {
      if (node.native === true && node.children && !hasMineableContent(node.children)) {
        delete node.children;
        continue;
      }
      if (node.children) visit(node.children);
    }
  };
  visit(design.nodes);
}

/**
 * Whether a fetched node's id refers to the node the caller asked to focus on.
 *
 * The Figma REST API cannot fetch an instance-internal node (one with an
 * `I<instance>;<local>;...` id) on its own — it only ever returns the whole
 * instance — so the only way to scope a fetch to "just Frame 1 inside this
 * instance" is to prune the built tree by id after the fact. But the id a
 * caller has on hand comes in two forms, and both must resolve to the same
 * node:
 *   - the full compound id copied from a prior fetch's output
 *     (e.g. "I3096:91050;1907:3787")
 *   - the bare local id Figma's Dev Mode shows / puts in a URL when that same
 *     frame is selected (e.g. "1907:3787" or "1907-3787")
 * so matching is by trailing `;`-segment, not string equality, after
 * normalizing "-" to ":" and dropping a leading "I". A single-segment focus
 * id matches any node whose final segment equals it; a multi-segment focus id
 * must match as a whole suffix.
 */
function nodeMatchesFocusId(nodeId: string, focusId: string): boolean {
  const normalize = (s: string): string => s.replace(/-/g, ":").replace(/^I/, "");
  const node = normalize(nodeId);
  const focus = normalize(focusId);
  if (node === focus) return true;
  if (node.endsWith(`;${focus}`)) return true;
  // Single-segment focus id (no ";") against the node's innermost segment.
  return !focus.includes(";") && node.split(";").pop() === focus;
}

/**
 * Find every node whose id or name matches focusNodeId. Id match is tried
 * first (see nodeMatchesFocusId); if nothing matches by id, falls back to a
 * case-insensitive `name` match — lets a caller say "frame 1" without having
 * to match the layer's actual title-cased name exactly, or copy an id out of
 * a prior fetch's output. Unlike ids, names aren't unique (the same design
 * can have several nodes literally named e.g. "Frame 3465463"), so the name
 * fallback returns EVERY matching node, not just one — the caller sees all of
 * them as separate subtrees rather than one silently picked at random.
 *
 * Either way, a match is never searched for more matches inside its own
 * subtree: a descendant sharing the same id is impossible (ids are unique),
 * but a descendant sharing the same NAME is possible, and keeping it too
 * would duplicate content already inside the kept ancestor's subtree.
 */
function findFocusMatches(
  nodes: SimplifiedNode[],
  focusNodeId: string,
): { roots: SimplifiedNode[]; matchedBy: "id" | "name" | "none" } {
  const idRoots: SimplifiedNode[] = [];
  const collectById = (level: SimplifiedNode[]): void => {
    for (const node of level) {
      if (nodeMatchesFocusId(node.id, focusNodeId)) {
        idRoots.push(node);
      } else if (node.children) {
        collectById(node.children);
      }
    }
  };
  collectById(nodes);
  if (idRoots.length > 0) return { roots: idRoots, matchedBy: "id" };

  const focusNameLower = focusNodeId.toLowerCase();
  const nameRoots: SimplifiedNode[] = [];
  const collectByName = (level: SimplifiedNode[]): void => {
    for (const node of level) {
      if (node.name.toLowerCase() === focusNameLower) {
        nameRoots.push(node);
      } else if (node.children) {
        collectByName(node.children);
      }
    }
  };
  collectByName(nodes);
  if (nameRoots.length > 0) return { roots: nameRoots, matchedBy: "name" };

  return { roots: [], matchedBy: "none" };
}

/**
 * Scope the design to just the subtree(s) rooted at `focusNodeId`, dropping
 * every sibling branch. For a huge instance where the caller only cares about
 * one frame (and the rest blows the token budget), this is the only way to
 * narrow the result — the API can't fetch an instance-internal node alone
 * (see findFocusMatches). Runs BEFORE all enrichment (variants/libraries/
 * dev-resources/SF symbols/icons) so every enrichment API call afterward is
 * scoped to the kept subtree, not the whole file — a miss short-circuits to a
 * search listing (see get-figma-data.ts) before spending a single enrichment
 * call on a tree the caller can't consume yet.
 *
 * Best-effort: if nothing matches, the tree is left untouched and a warning is
 * logged — returning an empty result would be strictly worse than returning
 * the whole thing the caller was trying to narrow down.
 *
 * Also drops component/componentSet definitions no longer referenced by any
 * surviving node — pure id-keyed lookup tables, safe to trim once their only
 * referents are gone. `globalVars` styles are intentionally NOT pruned here:
 * style refs are spread across many node fields and a missed one would dangle.
 */
export function focusDesignSubtree(design: SimplifiedDesign, focusNodeId: string): boolean {
  const { roots, matchedBy } = findFocusMatches(design.nodes, focusNodeId);

  if (matchedBy === "none") {
    // Deliberately does NOT prune here — the caller decides what a miss means
    // (get-figma-data turns it into a search listing rather than dumping the
    // full tree, which is the exact thing that was too big to want).
    Logger.log(`focusNodeId "${focusNodeId}" matched no node id or name in the fetched tree.`);
    return false;
  }
  if (matchedBy === "name" && roots.length > 1) {
    Logger.log(
      `focusNodeId "${focusNodeId}" matched ${roots.length} nodes by name (not unique in this tree) — keeping all of them as separate subtrees.`,
    );
  }
  design.nodes = roots;

  // Drop now-orphaned component/componentSet entries.
  const referencedComponentIds = new Set<string>();
  const collectComponentIds = (nodes: SimplifiedNode[]): void => {
    for (const node of nodes) {
      if (node.componentId) referencedComponentIds.add(node.componentId);
      if (node.children) collectComponentIds(node.children);
    }
  };
  collectComponentIds(design.nodes);

  const referencedSetIds = new Set<string>();
  const keptComponents: typeof design.components = {};
  for (const [id, comp] of Object.entries(design.components)) {
    if (referencedComponentIds.has(id)) {
      keptComponents[id] = comp;
      if (comp.componentSetId) referencedSetIds.add(comp.componentSetId);
    }
  }
  design.components = keptComponents;

  const keptSets: typeof design.componentSets = {};
  for (const [id, set] of Object.entries(design.componentSets)) {
    if (referencedSetIds.has(id)) keptSets[id] = set;
  }
  design.componentSets = keptSets;
  return true;
}

export interface NameSearchMatch {
  id: string;
  name: string;
  type: string;
  /** Ancestor names from the fetched root down to this node, " > "-joined. */
  path: string;
}

/**
 * Find nodes by NAME, for discovery: the answer to "I want the Table Style
 * component but don't have its id, and the full tree is too big to eyeball."
 * The server already holds the whole tree in memory (Figma returns the entire
 * instance regardless), so it can grep it and hand back just a compact index
 * of hits — id + name + type + path — instead of serializing everything.
 *
 * Matching is exact (case-insensitive) against the whole name: "Frame 1"
 * matches a node literally named "Frame 1", never "Frame 15" or "Frame
 * 3465341" just because they share a substring. A token/substring match
 * would over-match badly in a large file — most layer names share common
 * words or digits — turning a lookup meant to disambiguate into one that
 * multiplies the ambiguity instead.
 *
 * A match is never searched inside for more matches: the outermost matching
 * node's subtree already contains any nested hits, so stopping there collapses
 * a match and any inner descendants sharing its exact name down to the one
 * container the caller almost certainly meant.
 */
export function searchDesignByName(design: SimplifiedDesign, query: string): NameSearchMatch[] {
  const target = query.trim().toLowerCase();
  if (!target) return [];

  const matches: NameSearchMatch[] = [];
  const visit = (nodes: SimplifiedNode[], ancestors: string[]): void => {
    for (const node of nodes) {
      if (node.name.toLowerCase() === target) {
        matches.push({
          id: node.id,
          name: node.name,
          type: node.type,
          path: [...ancestors, node.name].join(" > "),
        });
        // Don't descend — the kept subtree already contains any nested hits.
      } else if (node.children) {
        visit(node.children, [...ancestors, node.name]);
      }
    }
  };
  visit(design.nodes, []);
  return matches;
}

/**
 * Render a name-search result as a compact, AI-readable listing — the output
 * returned when a `find` (or a `focusNodeId` miss) resolves to zero or many
 * nodes rather than exactly one. Deliberately format-agnostic (not the design
 * serializer): it's a directory of candidates telling the agent which id to
 * re-fetch with focusNodeId, not design data to consume.
 */
export function renderNameSearchListing(query: string, matches: NameSearchMatch[]): string {
  const MAX = 100;
  const shown = matches.slice(0, MAX);
  const lines: string[] = [];

  if (matches.length === 0) {
    lines.push(`# No node name matched all words in "${query}".`);
    lines.push(
      `# Try a single distinctive word, or fetch without 'find' to see the tree (may be large).`,
    );
    return lines.join("\n");
  }

  lines.push(`# ${matches.length} node(s) matched "${query}" by name (case-insensitive).`);
  lines.push(`# Re-fetch with focusNodeId set to the id of the one you want.`);
  if (matches.length > MAX) lines.push(`# (showing first ${MAX})`);
  lines.push("matches:");
  for (const m of shown) {
    lines.push(`  - id: ${m.id}`);
    lines.push(`    name: ${m.name}`);
    lines.push(`    type: ${m.type}`);
    lines.push(`    path: ${m.path}`);
  }
  return lines.join("\n");
}

/**
 * Attach existing Swift implementations pinned via Figma's Dev Resources
 * panel onto the exact nodes they target. Figma's widget only accepts a
 * value that parses as a URL, so a designer pinning "this node IS already
 * implemented here" pastes a bare repo-relative file path with an
 * "https://" bolted on the front to pass validation (e.g.
 * "https://native/Pods/.../ZSDialogWindow.swift") — the scheme is stripped
 * here.
 *
 * The resource's `name` is free text — Figma has no concept of "kind" for
 * it. Whatever the designer typed is taken verbatim as `symbol`, the Swift
 * class name this node is implemented by. No decomposition: the entire name
 * is the class name, even if it contains underscores.
 *
 * A dev resource whose link is itself a Figma design URL (rather than a
 * .swift path) is treated as a component-variant reference instead — see
 * attachComponentVariantReferences below. Anything else (a ticket, a spec
 * doc) is neither, so it's dropped.
 *
 * Always-on: one unfiltered /dev_resources call per fetch, matched locally
 * against the fetched subtree (exact node-id match only; a link pinned
 * inside a library's master component doesn't resolve onto instances —
 * that data lives in the library file, not this one). Best-effort like
 * every enrichment pass: a missing scope (403) or a file with no matching
 * links simply leaves nodes unstamped.
 */
export async function attachDevResources(
  design: SimplifiedDesign,
  figmaService: FigmaService,
  fileKey: string,
): Promise<void> {
  let resources: DevResourceLink[];
  try {
    resources = (await figmaService.getDevResources(fileKey)).dev_resources ?? [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Logger.log(`Skipping dev-resource links for ${fileKey}: ${message}`);
    return;
  }
  if (resources.length === 0) return;

  const { implementationsByNodeId, variantLinkTargetsByNodeId } = parseDevResourceLinks(resources);
  attachImplementedBy(design, implementationsByNodeId);

  const distinctTargets = findPresentVariantTargets(design, variantLinkTargetsByNodeId);
  if (distinctTargets.size === 0) return;

  const references = (
    await Promise.all(
      [...distinctTargets.values()].map((target) =>
        fetchComponentVariantReference(target, figmaService),
      ),
    )
  ).filter((r): r is Record<string, unknown> => r !== undefined);

  if (references.length > 0) design.componentVariantReferences = references;
}

/**
 * Batch counterpart to attachDevResources — used when multiple Figma targets
 * are fetched in a single get_figma_data call (see getFigmaDataBatch in
 * get-figma-data.ts). Two things get deduplicated across the WHOLE batch
 * rather than per target:
 *
 * 1. The /dev_resources call itself — fetched once per unique file key, not
 *    once per target, even when several targets share a file.
 * 2. Component-variant-reference fetches — if two different requested
 *    screens both carry a Dev Resources link to the identical component
 *    (e.g. a Cancel and an OK button on DIFFERENT screens, both Push Button
 *    instances), that reference is fetched once and attached ONLY to the
 *    first screen (in the order given) that needs it. Every later screen in
 *    the same batch that references the identical target gets nothing added
 *    for it — the caller already has the answer a few sections earlier in
 *    the very same response, so repeating it is pure waste, not the
 *    correctness gap it would be across separate, independent tool calls
 *    (where the caller's context may have moved on by the time a later call
 *    happens — see the design.guide comment on addConsumptionGuide).
 *
 * implementedBy is NOT deduplicated across entries — it's cheap (one
 * file+symbol pair) and always specific to the exact node it's pinned to,
 * unlike componentVariantReferences which can be an entire subtree.
 */
export async function attachDevResourcesBatch(
  entries: { design: SimplifiedDesign; fileKey: string }[],
  figmaService: FigmaService,
): Promise<void> {
  const resourcesByFileKey = new Map<string, DevResourceLink[]>();
  await Promise.all(
    [...new Set(entries.map((e) => e.fileKey))].map(async (fileKey) => {
      try {
        resourcesByFileKey.set(
          fileKey,
          (await figmaService.getDevResources(fileKey)).dev_resources ?? [],
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        Logger.log(`Skipping dev-resource links for ${fileKey}: ${message}`);
        resourcesByFileKey.set(fileKey, []);
      }
    }),
  );

  const perEntryTargets = entries.map((entry) => {
    const resources = resourcesByFileKey.get(entry.fileKey) ?? [];
    const { implementationsByNodeId, variantLinkTargetsByNodeId } =
      parseDevResourceLinks(resources);
    attachImplementedBy(entry.design, implementationsByNodeId);
    return findPresentVariantTargets(entry.design, variantLinkTargetsByNodeId);
  });

  const allDistinctTargets = new Map<string, VariantLinkTarget>();
  for (const targets of perEntryTargets) {
    for (const [key, target] of targets) allDistinctTargets.set(key, target);
  }
  if (allDistinctTargets.size === 0) return;

  const fetched = new Map<string, Record<string, unknown> | undefined>();
  await Promise.all(
    [...allDistinctTargets.entries()].map(async ([key, target]) => {
      fetched.set(key, await fetchComponentVariantReference(target, figmaService));
    }),
  );

  const claimed = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const toAttach: Record<string, unknown>[] = [];
    for (const key of perEntryTargets[i].keys()) {
      if (claimed.has(key)) continue;
      const ref = fetched.get(key);
      if (!ref) continue;
      toAttach.push(ref);
      claimed.add(key);
    }
    if (toAttach.length > 0) entries[i].design.componentVariantReferences = toAttach;
  }
}

interface DevResourceLink {
  name: string;
  url: string;
  node_id: string;
}

type ImplementedByEntry = { file: string; symbol: string };
type VariantLinkTarget = { fileKey: string; nodeId: string };

/**
 * Pure parse: split a file's raw dev-resource links into Swift implementedBy
 * assignments and Figma-design-URL variant-reference targets, both keyed by
 * the node they're pinned to. No I/O, no tree mutation — shared by the
 * single-target (attachDevResources) and batch (attachDevResourcesBatch)
 * paths so the same parsing rules apply regardless of how many targets are
 * being fetched together.
 */
function parseDevResourceLinks(resources: DevResourceLink[]): {
  implementationsByNodeId: Map<string, ImplementedByEntry[]>;
  variantLinkTargetsByNodeId: Map<string, VariantLinkTarget>;
} {
  const implementationsByNodeId = new Map<string, ImplementedByEntry[]>();
  const variantLinkTargetsByNodeId = new Map<string, VariantLinkTarget>();

  for (const resource of resources) {
    if (resource.url.toLowerCase().endsWith(".swift")) {
      const entries = implementationsByNodeId.get(resource.node_id) ?? [];
      entries.push({
        file: resource.url.replace(/^https?:\/\//i, ""),
        symbol: resource.name,
      });
      implementationsByNodeId.set(resource.node_id, entries);
      continue;
    }

    const target = tryParseFigmaUrl(resource.url);
    if (target?.nodeId) {
      variantLinkTargetsByNodeId.set(resource.node_id, {
        fileKey: target.fileKey,
        nodeId: target.nodeId,
      });
    }
  }

  return { implementationsByNodeId, variantLinkTargetsByNodeId };
}

function attachImplementedBy(
  design: SimplifiedDesign,
  implementationsByNodeId: Map<string, ImplementedByEntry[]>,
): void {
  if (implementationsByNodeId.size === 0) return;
  const visit = (nodes: SimplifiedNode[]): void => {
    for (const node of nodes) {
      const implementations = implementationsByNodeId.get(node.id);
      if (implementations) node.implementedBy = implementations;
      if (node.children) visit(node.children);
    }
  };
  visit(design.nodes);
}

/**
 * Distinct variant-reference targets actually present in this one tree,
 * keyed by "fileKey:nodeId" — a node whose dev-resource link exists but
 * isn't in the fetched subtree contributes nothing (matches the existing
 * implementedBy matching rule: exact node-id presence only).
 */
function findPresentVariantTargets(
  design: SimplifiedDesign,
  targetsByNodeId: Map<string, VariantLinkTarget>,
): Map<string, VariantLinkTarget> {
  if (targetsByNodeId.size === 0) return new Map();

  const present = new Set<string>();
  const visit = (nodes: SimplifiedNode[]): void => {
    for (const node of nodes) {
      if (targetsByNodeId.has(node.id)) present.add(node.id);
      if (node.children) visit(node.children);
    }
  };
  visit(design.nodes);

  const distinct = new Map<string, VariantLinkTarget>();
  for (const nodeId of present) {
    const target = targetsByNodeId.get(nodeId)!;
    distinct.set(`${target.fileKey}:${target.nodeId}`, target);
  }
  return distinct;
}

/**
 * Fetches and builds ONE component-variant-reference entry — the expensive,
 * shareable part of resolving a Dev Resources variant link. Extracted so a
 * batch fetch (attachDevResourcesBatch) can call it exactly once per
 * distinct target even when several requested screens reference the same
 * component, instead of once per screen.
 *
 * WHY this data is worth fetching at all: a screen's fetch only ever shows
 * the one variant actually placed there — a button's other State x Enabled
 * combinations are invisible to a fetch of just that screen. A designer
 * pins ONE Dev Resources link (the URL of a canvas where every variant is
 * placed as a real instance) on any node using that component; this
 * resolves it in the SAME response, no second get_figma_data round-trip
 * required from the caller.
 *
 * The returned entry carries the target's componentSets (with full
 * propertyDefinitions.variantOptions, resolved via enrichComponentSetDefinitions)
 * alongside the instances actually found on the reference canvas — the two
 * can disagree (a set may define 6 valid combinations while the reference
 * canvas currently only demonstrates 4), and that gap is exactly what a
 * consumer needs to notice and flag rather than silently assuming the
 * canvas is exhaustive.
 *
 * Best-effort like every enrichment pass: returns undefined on failure,
 * logged but never thrown — one broken reference must never break the rest
 * of the response.
 */
async function fetchComponentVariantReference(
  target: VariantLinkTarget,
  figmaService: FigmaService,
): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await figmaService.getRawNode(target.fileKey, target.nodeId, 2);
    const simplified = await simplifyRawFigmaObject(raw.data, allExtractors, { maxDepth: 2 });
    await enrichComponentSetDefinitions(simplified, figmaService, target.fileKey);
    annotateSfSymbols(simplified);

    const styles = simplified.globalVars.styles;
    const tokens = simplified.globalVars.tokens ?? {};
    const nodes = simplified.nodes.map((node) => {
      const inlined = inlineNode(node, styles, tokens);
      stripReferenceRelationalFields(inlined);
      return inlined;
    });

    return {
      fileKey: target.fileKey,
      nodeId: target.nodeId,
      ...(Object.keys(simplified.componentSets).length > 0 && {
        componentSets: simplified.componentSets,
      }),
      nodes,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Logger.log(
      `Skipping component variant reference ${target.fileKey}/${target.nodeId}: ${message}`,
    );
    return undefined;
  }
}

/**
 * Strip fields that only describe THIS reference canvas's own documentation
 * layout — sibling order, parent linkage, and the gap/padding/position that
 * exist purely to arrange swatches for a human reader — never real app
 * layout. Everything else (componentProperties, fills, effects, text, ...)
 * is exactly the "core detail of the variant" this attachment exists for,
 * and stays untouched.
 */
function stripReferenceRelationalFields(node: NativeNode): void {
  delete node.siblingIndex;
  delete node.parentName;
  if (node.layout && typeof node.layout === "object" && !Array.isArray(node.layout)) {
    const layout = node.layout as {
      gap?: unknown;
      padding?: unknown;
      locationRelativeToParent?: unknown;
    };
    delete layout.gap;
    delete layout.padding;
    delete layout.locationRelativeToParent;
  }
  if (node.children) {
    for (const child of node.children) stripReferenceRelationalFields(child);
  }
}

/** SF Symbols occupy Unicode planes 15-16 (private use). */
const PUA_START = 0xf0000;

/**
 * Replace every private-use-area glyph in a string with a readable
 * "{sf:name}" placeholder, returning both the rewritten string and the
 * ordered list of names found. Unknown codepoints (symbols newer than the
 * vendored table) surface as "{sf:U+XXXXX}" so they stay greppable rather
 * than silently invisible.
 */
function rewritePuaGlyphs(value: string): { rewritten: string; names: string[] } {
  const names: string[] = [];
  let rewritten = "";
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (cp >= PUA_START) {
      const name = SF_SYMBOL_NAMES[cp] ?? `U+${cp.toString(16).toUpperCase()}`;
      names.push(name);
      rewritten += `{sf:${name}}`;
    } else {
      rewritten += ch;
    }
  }
  return { rewritten, names };
}

/**
 * Annotate every text node whose content contains private-use-area glyphs
 * with the corresponding SF Symbol names, in order of appearance, AND
 * replace the glyph in the text itself with a readable "{sf:name}"
 * placeholder. The raw PUA character is invisible/mojibake to every consumer
 * (and unrenderable by AppKit string APIs anyway) — leaving it in `text`
 * invites treating it as literal content.
 *
 * Also rewrites `name` the same way, without adding to `sfSymbols` (that
 * field is documented as text-content glyphs specifically) — a layer can
 * literally be named after an SF Symbol glyph (a designer pasted the icon
 * character as the layer name, not just as text), which otherwise surfaces
 * as an unrenderable character that looks blank in most fonts/editors.
 */
export function annotateSfSymbols(design: SimplifiedDesign): void {
  const visit = (nodes: SimplifiedNode[]): void => {
    for (const node of nodes) {
      if (node.text) {
        const { rewritten, names } = rewritePuaGlyphs(node.text);
        if (names.length > 0) {
          node.sfSymbols = names;
          node.text = rewritten;
        }
      }
      const { rewritten: rewrittenName, names: nameGlyphs } = rewritePuaGlyphs(node.name);
      if (nameGlyphs.length > 0) {
        node.name = rewrittenName;
      }
      if (node.children) visit(node.children);
    }
  };
  visit(design.nodes);
}

/**
 * Walk up from a starting directory until a `package.json` is found. Used to
 * locate the MCP package root regardless of whether this module is running
 * as TypeScript source (src/services/) or bundled (dist/) — the bundler's
 * chunk-splitting depth isn't stable, so a fixed number of `..` segments
 * would break in one context or the other. package.json is always exactly
 * one level above `dist/`, however deep the running file's own path is.
 */
function findPackageRoot(startDir: string): string {
  let dir = startDir;
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not locate the MCP package root from ${startDir}`);
    }
    dir = parent;
  }
  return dir;
}

const PACKAGE_ROOT = findPackageRoot(dirname(fileURLToPath(import.meta.url)));

/**
 * Split a directive markdown file into one string per `## ` heading, each
 * rendered as "Heading: body text" with the body's internal whitespace
 * collapsed to single spaces — the body can be wrapped across multiple lines
 * in the source file for readability without affecting the flattened output.
 */
function parseMarkdownRules(markdown: string): string[] {
  const sections = markdown.split(/^## /m).slice(1);
  return sections.map((section) => {
    const newlineIndex = section.indexOf("\n");
    const heading = section.slice(0, newlineIndex).trim();
    const body = section
      .slice(newlineIndex + 1)
      .trim()
      .replace(/\s+/g, " ");
    return `${heading}: ${body}`;
  });
}

function loadPromptMarkdown(filename: string): string {
  return readFileSync(join(PACKAGE_ROOT, "prompts", filename), "utf8");
}

/**
 * The icon-download script's own source, read fresh from the package's
 * `assets/` directory (ships alongside `prompts/`, listed in package.json's
 * `files`) and handed to the consumer as a response content block — never
 * assumed to already exist in whatever repo the agent happens to be working
 * in. This server is a self-contained unit; a static path like
 * `native/download_icons.py` only works by coincidence when the consuming
 * repo happens to already have that exact file, which breaks the moment this
 * MCP is pointed at a different project. Shipping the source with every
 * relevant response means the agent always has a current copy, with zero
 * setup, regardless of which repo it's operating in.
 */
export function loadIconDownloadScript(): string {
  return readFileSync(join(PACKAGE_ROOT, "assets", "download_icons.py"), "utf8");
}

/**
 * Consumption rules that hold regardless of output format — shared between
 * the per-response embedded guide (design.guide, works with every MCP
 * client) and the server's MCP `instructions` (sent once at session init,
 * see mcp/index.ts — support varies by client, so the embedded copy is the
 * reliable fallback, not a replacement).
 *
 * Source of truth is prompts/consumption-guide.md, not this array — edit
 * prose there, in plain readable Markdown, rather than as TypeScript string
 * literals.
 */
export const CONSUMPTION_GUIDE: readonly string[] = parseMarkdownRules(
  loadPromptMarkdown("consumption-guide.md"),
);

/** Describes where a design-token fill/stroke resolves to — differs by output format (see native-json.ts). */
const TOKEN_INDIRECTION_NATIVE =
  "fills/strokes with snake_case names are design tokens, inlined in place as { token, values, themed, appkit? } — no lookup elsewhere in the document. Every token here is an EXACT variable-ID match against the design-system exports (no color-guessing), so the name is trustworthy. themed: true means the design defines different Light and Dark values — but per the LIGHT THEME ONLY rule below, implement the Light value (values.Light); values.Dark is reference data, not something to build. appkit, when present, means this token is a material/vibrancy effect (NSVisualEffectView.Material.*), not a flat color — build it as such; absent means it's a plain color, use the Light value directly (a suggested NSColor name is deliberately not included there, since Light Theme Only already overrides it). A raw hex/rgba fill (not a token name) is a color with no design-system name — see the unnamedAssets list, don't hardcode it silently.";
const TOKEN_INDIRECTION_REF =
  "fills/strokes with snake_case names are design tokens — per-mode values under globalVars.tokens[name]. Every token is an EXACT variable-ID match against the design-system exports (no color-guessing), so the name is trustworthy. themed: true means the design defines different Light and Dark values — but per the LIGHT THEME ONLY rule below, implement the Light value (values.Light); values.Dark is reference data, not something to build. appkit, when present, means this token is a material/vibrancy effect (NSVisualEffectView.Material.*), not a flat color — build it as such; absent means it's a plain color, use the Light value directly. A raw hex/rgba fill (not a token name) is a color with no design-system name — see the unnamedAssets list, don't hardcode it silently.";

/**
 * Project directive: how to behave when using this MCP, not how to parse its
 * output (that's CONSUMPTION_GUIDE). Source of truth is
 * prompts/project-directive.md, not this array — this server is a
 * customized bridge for one specific app, handed out as a self-contained
 * unit, so the directive must travel with the MCP itself with zero setup by
 * whoever receives it (the prompts/ directory ships alongside dist/, not
 * loaded from anywhere outside the package). Deliberately self-contained (no
 * "see other doc" pointers): anyone who has this server has everything in
 * this array, nothing else.
 */
export const PROJECT_DIRECTIVE: readonly string[] = parseMarkdownRules(
  loadPromptMarkdown("project-directive.md"),
);

/**
 * Embed consumption rules into the output itself. These correct the known
 * ways downstream code-generating consumers misread this format; they must
 * live in the document because the consumer usually has nothing else.
 *
 * variantData/unnamedAssets guidance lives as static rules in
 * project-directive.md ("Component Variants", "Unnamed Assets") rather than
 * conditionally injected here — same treatment as componentVariantReferences,
 * which has always described its own "when present" case as a permanent rule.
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
