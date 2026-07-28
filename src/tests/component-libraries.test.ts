import { describe, expect, it } from "vitest";
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
  it("marks Apple's macOS UI kit native (platform name first, emoji prefix ok) — library name itself is not persisted", async () => {
    const design = makeDesign();
    await resolveComponentLibraries(design, stubService("🟢 macOS 15 Sequoia (Library)"));

    expect(design.componentSets["10:1"].native).toBe(true);
    expect(design.nodes[0].native).toBe(true);
    expect("library" in design.componentSets["10:1"]).toBe(false);
    expect("library" in design.nodes[0]).toBe(false);
  });

  it("does NOT mark a team library that merely mentions macOS as native", async () => {
    // Real regression: "🧤 UI Content - macOS" (the design team's own
    // component library) was stamped native by a bare /macos/i test, while
    // its pinned dev resources pointed at custom Swift classes.
    const design = makeDesign();
    await resolveComponentLibraries(design, stubService("🧤 UI Content - macOS"));

    expect(design.componentSets["10:1"].native).toBeUndefined();
    expect(design.nodes[0].native).toBeUndefined();
  });
});
