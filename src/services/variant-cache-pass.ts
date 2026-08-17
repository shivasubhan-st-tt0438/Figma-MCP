import yaml from "js-yaml";
import type { FigmaService } from "~/services/figma.js";
import type { SimplifiedDesign } from "~/extractors/types.js";
import type { VariantSetTarget } from "~/services/enrich-design.js";
import {
  openVariantCache,
  variantCacheDir,
  variantCacheStem,
  variantCacheDate,
  type VariantCache,
} from "~/services/variant-cache.js";
import { fetchVariantSetNodes } from "~/services/variant-fetch.js";
import { dumpYaml } from "~/utils/yaml-dump.js";
import { Logger } from "~/utils/logger.js";

/**
 * Build the consolidated variant document and attach it as design.variantData,
 * to be emitted as a SECOND YAML alongside the primary tree.
 *
 * For EVERY remote component set referenced in the tree, the document carries
 * the set's metadata — name, a native/icon tag, and the propDefs matrix that
 * lists all its variants (already computed on the primary by
 * enrichComponentSetDefinitions, no extra call). That keeps a node's compId
 * resolvable once components/componentSets move out of the primary YAML.
 *
 * For CUSTOM sets only (not native, not icons) it additionally fetches and
 * carries the set's full variant UI from its source library: a native control
 * renders its own states, and an icon's content is the asset itself, so
 * fetching their per-variant UI would be wasted cost — their variants are
 * still fully *listed* via propDefs, only the UI tree is skipped.
 *
 * Fetched UI is cached to disk by publish key (stable across files) and reused
 * within the day; see variant-cache.ts for the daily-refresh rotation.
 */
export async function attachVariantData(
  design: SimplifiedDesign,
  targets: Map<string, VariantSetTarget>,
  figmaService: FigmaService,
  now: Date = new Date(),
): Promise<void> {
  if (targets.size === 0) return;

  let cache: VariantCache | undefined;
  try {
    cache = openVariantCache(variantCacheDir(), now);
  } catch (error) {
    // Best-effort: an unwritable cache dir must not break the fetch — run
    // without caching (re-fetching each time) rather than failing.
    Logger.log(`Variant cache unavailable, proceeding without it: ${String(error)}`);
  }

  const buildEntry = (
    target: VariantSetTarget,
    nodes: unknown[] | undefined,
  ): Record<string, unknown> => {
    const set = design.componentSets[target.setId];
    return {
      name: target.name,
      ...(target.native && { native: true }),
      // The variant list. Long key here; the native serializer's compactOutput
      // shortens it to `propDefs`, same as the primary — so cached fragments
      // stay in the pipeline's own idiom. (Icon-library sets never reach here;
      // they're excluded from targets upstream, in resolveComponentLibraries.)
      ...(set?.propertyDefinitions && { propertyDefinitions: set.propertyDefinitions }),
      // The variant UI, for custom sets only.
      ...(nodes && nodes.length > 0 && { nodes }),
    };
  };

  const entriesBySetId = new Map<string, Record<string, unknown>>();
  const toFetch: VariantSetTarget[] = [];

  for (const target of targets.values()) {
    const stem = variantCacheStem(target.name, target.publishKey);
    const cached = cache?.get(stem);
    if (cached !== undefined) {
      entriesBySetId.set(target.setId, yaml.load(cached) as Record<string, unknown>);
      continue;
    }
    // Custom, resolvable sets are the only ones whose UI we fetch (native sets
    // map to NS* and render themselves; icon sets are already excluded from
    // targets upstream).
    const fetchUi = !target.native && Boolean(target.source);
    if (fetchUi) {
      toFetch.push(target);
      continue;
    }
    // Native / unresolvable: metadata-only entry (still lists variants via
    // propDefs), cached so it isn't reconsidered again today.
    const entry = buildEntry(target, undefined);
    entriesBySetId.set(target.setId, entry);
    cache?.set(stem, dumpYaml(entry));
  }

  if (toFetch.length > 0) {
    const fetched = await fetchVariantSetNodes(toFetch, figmaService);
    for (const target of toFetch) {
      const nodes = fetched.get(target.setId);
      const entry = buildEntry(target, nodes);
      entriesBySetId.set(target.setId, entry);
      // Cache only a successful UI fetch — a miss stays uncached so it's
      // retried next time rather than caching a set with no UI.
      if (nodes && nodes.length > 0) {
        cache?.set(variantCacheStem(target.name, target.publishKey), dumpYaml(entry));
      }
    }
  }

  const componentSets: Record<string, unknown> = {};
  for (const [setId, entry] of entriesBySetId) componentSets[setId] = entry;

  // Carry the component→set linkage for compId resolution, but drop components
  // whose set was excluded from targets (icon-library sets) — those instances
  // had their componentProperties stripped and need no variant lookup.
  const components: typeof design.components = {};
  for (const [compId, component] of Object.entries(design.components)) {
    if (!component.componentSetId || targets.has(component.componentSetId)) {
      components[compId] = component;
    }
  }

  design.variantData = {
    date: cache?.date ?? variantCacheDate(now),
    components,
    componentSets,
  };
}
