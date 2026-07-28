import type { SimplifiedDesign } from "~/extractors/types.js";

export function wrapForSerialization(design: SimplifiedDesign) {
  const { nodes, globalVars, componentVariantReferences, ...metadata } = design;
  return {
    metadata,
    nodes,
    globalVars,
    // Pulled out to its own trailing key (not left in `metadata`, which
    // serializes first) so it reads as an appendix after the main tree in
    // every format — see attachComponentVariantReferences in enrich-design.ts.
    ...(componentVariantReferences && { componentVariantReferences }),
  };
}

export type SerializableDesign = ReturnType<typeof wrapForSerialization>;
