import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { attachVariantData } from "~/services/variant-cache-pass.js";
import type { VariantSetTarget } from "~/services/enrich-design.js";
import type { SimplifiedDesign } from "~/extractors/types.js";
import type { FigmaService } from "~/services/figma.js";
import { wrapForSerialization } from "~/utils/serializable-design.js";
import { serializeResult, serializeVariantDocument } from "~/utils/serialize.js";

const DAY = new Date(2026, 7, 13);
let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "variant-pass-test-"));
  process.env.FIGMA_MCP_VARIANT_CACHE_DIR = cacheDir;
});
afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
  delete process.env.FIGMA_MCP_VARIANT_CACHE_DIR;
});

// A design with one placed Push Button instance (custom), plus a native set
// and an icon set referenced elsewhere. Only the custom set should be fetched.
function makeDesign(): SimplifiedDesign {
  return {
    name: "design",
    nodes: [
      {
        id: "n1",
        name: "Cancel",
        type: "INSTANCE",
        componentId: "c1",
        // The CURRENT variant lives here on the node, not in metadata.
        componentProperties: { State: "Secondary" },
      },
    ],
    components: {
      c1: { key: "ck1", name: "State=Secondary", componentSetId: "set-custom" },
    },
    componentSets: {
      "set-custom": {
        key: "pk-custom",
        name: "Push Button",
        propertyDefinitions: {
          State: {
            type: "variant",
            defaultValue: "Primary",
            variantOptions: ["Primary", "Secondary"],
          },
        },
      },
      "set-native": {
        key: "pk-native",
        name: "Slider",
        propertyDefinitions: {
          Value: { type: "variant", defaultValue: "0%", variantOptions: ["0%", "50%"] },
        },
      },
    },
    globalVars: { styles: {} },
  };
}

// Icon-library sets are excluded upstream (resolveComponentLibraries), so
// attachVariantData only ever sees custom + native targets.
function makeTargets(): Map<string, VariantSetTarget> {
  return new Map<string, VariantSetTarget>([
    [
      "set-custom",
      {
        setId: "set-custom",
        name: "Push Button",
        publishKey: "pk-custom",
        native: false,
        source: { fileKey: "LIB", nodeId: "9:1" },
      },
    ],
    [
      "set-native",
      {
        setId: "set-native",
        name: "Slider",
        publishKey: "pk-native",
        native: true,
        source: { fileKey: "LIB", nodeId: "9:2" },
      },
    ],
  ]);
}

function makeSourceSetResponse() {
  return {
    name: "macOS kit",
    nodes: {
      "9:1": {
        document: {
          id: "9:1",
          name: "Push Button",
          type: "COMPONENT_SET",
          children: [
            {
              id: "9:1:1",
              name: "State=Primary",
              type: "COMPONENT",
              absoluteBoundingBox: { x: 0, y: 0, width: 56, height: 22 },
            },
            {
              id: "9:1:2",
              name: "State=Secondary",
              type: "COMPONENT",
              absoluteBoundingBox: { x: 60, y: 0, width: 56, height: 22 },
            },
          ],
        },
        components: {},
        componentSets: {},
        styles: {},
      },
    },
  };
}

function stubService(idsSeen: string[]): FigmaService {
  const getRawNode = vi.fn(async (fileKey: string, ids: string, _depth?: number | null) => {
    idsSeen.push(ids);
    return { data: makeSourceSetResponse(), rawSize: 0 };
  });
  return { getRawNode } as unknown as FigmaService;
}

describe("attachVariantData", () => {
  it("fetches UI for custom sets only; native gets the variant list but no UI", async () => {
    const idsSeen: string[] = [];
    const service = stubService(idsSeen);
    const design = makeDesign();

    await attachVariantData(design, makeTargets(), service, DAY);

    // Only the custom set's source node was fetched — never the native one.
    expect(idsSeen).toEqual(["9:1"]);

    const sets = design.variantData!.componentSets as Record<string, Record<string, unknown>>;
    // Custom: has the fetched variant UI.
    expect(sets["set-custom"].nodes).toBeDefined();
    expect(sets["set-custom"].propertyDefinitions).toBeDefined();
    // Native: variant list kept (propertyDefinitions), tagged, but no UI.
    expect(sets["set-native"].native).toBe(true);
    expect(sets["set-native"].propertyDefinitions).toBeDefined();
    expect(sets["set-native"].nodes).toBeUndefined();
    // components carried through for compId resolution.
    expect(design.variantData!.components.c1).toBeDefined();
  });

  it("reuses the disk cache on a second run within the day (no re-fetch)", async () => {
    const idsSeen: string[] = [];
    const service = stubService(idsSeen);

    await attachVariantData(makeDesign(), makeTargets(), service, DAY);
    expect(idsSeen).toEqual(["9:1"]);

    // Second run, same day: cache hit, so the custom set is NOT fetched again.
    await attachVariantData(makeDesign(), makeTargets(), service, DAY);
    expect(idsSeen).toEqual(["9:1"]);
  });
});

describe("two-document serialization", () => {
  it("drops components/componentSets from the primary but keeps the node's current variant (props)", async () => {
    const service = stubService([]);
    const design = makeDesign();
    await attachVariantData(design, makeTargets(), service, DAY);

    const wrapped = wrapForSerialization(design);
    const primary = serializeResult(wrapped, "native-yaml");
    const variantDoc = serializeVariantDocument(wrapped, "native-yaml");

    // Primary no longer carries the metadata sections...
    expect(primary).not.toContain("componentSets:");
    expect(primary).not.toContain("components:");
    // ...but the instance's current variant is still on the node.
    expect(primary).toContain("props:");
    expect(primary).toContain("Secondary");

    // The second document carries the variant data.
    expect(variantDoc).toBeDefined();
    expect(variantDoc).toContain("Push Button");
    expect(variantDoc).toContain("propDefs:"); // propertyDefinitions compacted
  });
});
