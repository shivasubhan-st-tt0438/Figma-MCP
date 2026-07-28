import { describe, expect, it } from "vitest";
import { resolveVariableFillNames } from "~/services/resolve-variable-names.js";
import type { SimplifiedDesign } from "~/extractors/types.js";
import type { FigmaService } from "~/services/figma.js";
import type { ColorTokensByMode } from "~/services/color-tokens-file.js";

function makeDesign(): SimplifiedDesign {
  return {
    name: "design",
    nodes: [
      {
        id: "1:1",
        name: "Label",
        type: "TEXT",
        fills: "fill_ABC123",
        fillVariableIds: { 0: "VariableID:123" },
      },
    ],
    components: {},
    componentSets: {},
    globalVars: { styles: { fill_ABC123: ["#000000"] } },
  };
}

function makeLocalTokens(path: string, variableId: string): ColorTokensByMode {
  const token = { path, qualified: true, variableId, hex: "#000000", alpha: 1 };
  return { Light: { byVariableId: new Map([[variableId, token]]), all: [token] } };
}

const noOpService = {} as FigmaService;

describe("resolveVariableFillNames — appkit hint filtering", () => {
  it("drops a plain NSColor.* hint — redundant with Light Theme Only, sometimes misleading", async () => {
    const design = makeDesign();
    await resolveVariableFillNames(
      design,
      noOpService,
      "f",
      makeLocalTokens("text_primary", "VariableID:123"),
      { text_primary: "NSColor.labelColor" },
    );

    expect(design.globalVars.tokens?.text_primary?.appkit).toBeUndefined();
  });

  it("keeps a Material/VisualEffect hint — the only signal this token isn't a flat color", async () => {
    const design = makeDesign();
    await resolveVariableFillNames(
      design,
      noOpService,
      "f",
      makeLocalTokens("materials_ultrathick", "VariableID:123"),
      { materials_ultrathick: "NSVisualEffectView.Material.sheet (ultra thick)" },
    );

    expect(design.globalVars.tokens?.materials_ultrathick?.appkit).toBe(
      "NSVisualEffectView.Material.sheet (ultra thick)",
    );
  });
});
