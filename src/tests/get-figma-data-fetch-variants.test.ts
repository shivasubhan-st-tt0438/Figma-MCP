import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getFigmaData } from "~/services/get-figma-data.js";
import type { FigmaService } from "~/services/figma.js";

// A design with one placed instance of a remote, custom (non-native,
// non-icon-library) component set — the case attachVariantData actually
// fetches a source-library UI for, so the gate/override has something to
// prove: with the env off, variantsFormatted only appears when this call's
// own fetchVariants override asks for it.
function makeRawNodeResponse() {
  return {
    data: {
      name: "test file",
      nodes: {
        "1:1": {
          document: {
            id: "1:1",
            name: "Screen",
            type: "FRAME",
            absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
            children: [
              {
                id: "1:2",
                name: "Cancel",
                type: "INSTANCE",
                componentId: "10:2",
                absoluteBoundingBox: { x: 0, y: 0, width: 56, height: 22 },
              },
            ],
          },
          components: {
            "10:2": { key: "compkey", name: "State=Secondary", componentSetId: "10:1" },
          },
          componentSets: {
            "10:1": {
              key: "setkey",
              name: "Push Button",
              remote: true,
              propertyDefinitions: {
                State: { type: "variant", defaultValue: "Primary", variantOptions: ["Primary"] },
              },
            },
          },
          styles: {},
        },
      },
    },
    rawSize: 100,
  };
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
          ],
        },
        components: {},
        componentSets: {},
        styles: {},
      },
    },
  };
}

function makeService(): FigmaService {
  const getRawNode = vi.fn(async (fileKey: string) => {
    if (fileKey === "LIB") return { data: makeSourceSetResponse(), rawSize: 0 };
    return makeRawNodeResponse();
  });
  return {
    getRawNode,
    getComponentSetByKey: vi.fn(async () => ({ meta: { file_key: "LIB", node_id: "9:1" } })),
    getFileMeta: vi.fn(async () => ({ name: "🧤 UI Content - macOS" })),
    getDevResources: vi.fn(async () => ({ dev_resources: [] })),
  } as unknown as FigmaService;
}

describe("get_figma_data fetchVariants override", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "fetch-variants-override-test-"));
    process.env.FIGMA_MCP_VARIANT_CACHE_DIR = cacheDir;
    delete process.env.FIGMA_MCP_FETCH_VARIANTS;
  });
  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
    delete process.env.FIGMA_MCP_VARIANT_CACHE_DIR;
    delete process.env.FIGMA_MCP_FETCH_VARIANTS;
  });

  it("skips the variant document when the env gate is off and fetchVariants is not passed", async () => {
    const service = makeService();

    const result = await getFigmaData(service, { fileKey: "fileA", nodeId: "1:1" }, "native-yaml");

    expect(result.variantsFormatted).toBeUndefined();
  });

  it("fetches the variant document when fetchVariants overrides an off env gate", async () => {
    const service = makeService();

    const result = await getFigmaData(
      service,
      { fileKey: "fileA", nodeId: "1:1", fetchVariants: true },
      "native-yaml",
    );

    expect(result.variantsFormatted).toBeDefined();
    // Proves a real source-library fetch happened, not just that the
    // (already-known) componentSet name/propertyDefinitions carried over.
    expect(result.variantsFormatted).toContain("State=Primary");
  });
});
