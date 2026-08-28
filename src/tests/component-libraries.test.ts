import { afterEach, describe, expect, it } from "vitest";
import { resolveComponentLibraries } from "~/services/enrich-design.js";
import type { SimplifiedDesign } from "~/extractors/types.js";
import type { FigmaService } from "~/services/figma.js";

function makeDesign(): SimplifiedDesign {
  return {
    name: "design",
    nodes: [{ id: "1:5", name: "Button", type: "INSTANCE", componentId: "10:2" }],
    components: {
      "10:2": { key: "compkey", name: "Type=.xlsx", componentSetId: "10:1" },
    },
    componentSets: {
      "10:1": { key: "setkey", name: "Push Button", remote: true },
    },
    globalVars: { styles: {} },
  };
}

function stubService(libraryName: string): FigmaService {
  return {
    getComponentSetByKey: async () => ({ meta: { file_key: "LIB1" } }),
    getComponentByKey: async () => ({ meta: { file_key: "LIB1" } }),
    getFileMeta: async () => ({ name: libraryName }),
  } as unknown as FigmaService;
}

describe("resolveComponentLibraries — Apple kit vs team library", () => {
  it("marks Apple's macOS UI kit native on the node only — component set keeps neither native nor remote", async () => {
    const design = makeDesign();
    await resolveComponentLibraries(design, stubService("🟢 macOS 15 Sequoia (Library)"));

    expect(design.nodes[0].native).toBe(true);
    expect("native" in design.componentSets["10:1"]).toBe(false);
    expect("remote" in design.componentSets["10:1"]).toBe(false);
    expect("library" in design.componentSets["10:1"]).toBe(false);
    expect("library" in design.nodes[0]).toBe(false);
  });

  it("does NOT mark a team library that merely mentions macOS as native, and still strips remote", async () => {
    // Real regression: "🧤 UI Content - macOS" (the design team's own
    // component library) was stamped native by a bare /macos/i test, while
    // its pinned dev resources pointed at custom Swift classes.
    const design = makeDesign();
    await resolveComponentLibraries(design, stubService("🧤 UI Content - macOS"));

    expect(design.nodes[0].native).toBeUndefined();
    expect("native" in design.componentSets["10:1"]).toBe(false);
    expect("remote" in design.componentSets["10:1"]).toBe(false);
  });

  afterEach(() => {
    delete process.env.FIGMA_MCP_NATIVE_LIBRARY_PREFIX;
  });

  it("uses FIGMA_MCP_NATIVE_LIBRARY_PREFIX instead of the default 'macos' when set", async () => {
    process.env.FIGMA_MCP_NATIVE_LIBRARY_PREFIX = "ios";

    // "macOS 15 Sequoia (Library)" no longer matches once the prefix is "ios".
    const notNative = makeDesign();
    await resolveComponentLibraries(notNative, stubService("🟢 macOS 15 Sequoia (Library)"));
    expect(notNative.nodes[0].native).toBeUndefined();

    // A library named for the configured prefix is now treated as native.
    const nowNative = makeDesign();
    await resolveComponentLibraries(nowNative, stubService("🟢 iOS 18 (Library)"));
    expect(nowNative.nodes[0].native).toBe(true);
  });
});

describe("resolveComponentLibraries — variant-fetch targets & icon library", () => {
  function makeIconDesign(): SimplifiedDesign {
    return {
      name: "design",
      nodes: [
        {
          id: "1:5",
          name: "ic_lock",
          type: "INSTANCE",
          componentId: "10:2",
          componentProperties: { Size: "16", Colored: "No" },
        },
      ],
      components: { "10:2": { key: "compkey", name: "Size=16", componentSetId: "10:1" } },
      componentSets: { "10:1": { key: "setkey", name: "ic_lock", remote: true } },
      globalVars: { styles: {} },
    };
  }

  it("excludes an icon-library set from targets and strips its instance componentProperties", async () => {
    const design = makeIconDesign();
    const targets = await resolveComponentLibraries(design, stubService("🛑 Sheet Icons Library"));

    // No fetch target, and no variant list — the icon asset is all that matters.
    expect(targets.has("10:1")).toBe(false);
    // componentProperties (Size/Colored variant noise) stripped from the node.
    expect(design.nodes[0].componentProperties).toBeUndefined();
  });

  it("keeps a custom (non-native, non-icon) set as a target for fetching", async () => {
    const design = makeDesign();
    const targets = await resolveComponentLibraries(design, stubService("🧤 UI Content - macOS"));

    expect(targets.has("10:1")).toBe(true);
    expect(targets.get("10:1")!.native).toBe(false);
  });

  it("keeps a native set as a target, marked native (listed, but no UI fetched)", async () => {
    const design = makeDesign();
    const targets = await resolveComponentLibraries(
      design,
      stubService("🟢 macOS 15 Sequoia (Library)"),
    );

    expect(targets.has("10:1")).toBe(true);
    expect(targets.get("10:1")!.native).toBe(true);
  });
});
