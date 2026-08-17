import type { SimplifiedDesign } from "~/extractors/types.js";

export function wrapForSerialization(design: SimplifiedDesign) {
  const { nodes, globalVars, componentVariantReferences, variantData, unnamedAssets, ...metadata } =
    design;
  return {
    metadata,
    // Right after metadata (which carries `guide`) and BEFORE `nodes` — a
    // consumer reads the guide, then immediately sees what to flag/catalog,
    // before it starts reading the tree itself.
    ...(unnamedAssets && { unnamedAssets }),
    nodes,
    globalVars,
    // Pulled out to its own trailing key (not left in `metadata`, which
    // serializes first) so it reads as an appendix after the main tree in
    // every format — see attachComponentVariantReferences in enrich-design.ts.
    ...(componentVariantReferences && { componentVariantReferences }),
    // Carried out of `metadata` too. The native serializer emits it as a
    // SECOND document (and, when present, drops components/componentSets from
    // the primary metadata since this holds that data enriched). Never inlined
    // into the primary tree. See buildNativeDesign / serializeVariantDocument.
    ...(variantData && { variantData }),
  };
}

export type SerializableDesign = ReturnType<typeof wrapForSerialization>;
