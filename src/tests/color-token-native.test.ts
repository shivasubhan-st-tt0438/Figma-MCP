import { describe, expect, it } from "vitest";
import { resolveVariableFillNames } from "~/services/resolve-variable-names.js";
import type { SimplifiedDesign } from "~/extractors/types.js";
import type { FigmaService } from "~/services/figma.js";
import type { ColorTokensByMode, ColorToken } from "~/services/color-tokens-file.js";

function makeDesign(fillValue: `#${string}`, variableId: string): SimplifiedDesign {
  return {
    name: "design",
    nodes: [
      {
        id: "1:1",
        name: "Label",
        type: "TEXT",
        fills: "fill_ABC123",
        fillVariableIds: { 0: variableId },
      },
    ],
    components: {},
    componentSets: {},
    globalVars: { styles: { fill_ABC123: [fillValue] } },
  };
}

function localTokensWith(token: ColorToken, indexById: boolean): ColorTokensByMode {
  const byVariableId = new Map<string, ColorToken>(indexById ? [[token.variableId, token]] : []);
  return { Light: { byVariableId, all: [token] } };
}

const noOpService = {} as FigmaService;

describe("color token native flag — matched against local HIG token files", () => {
  it("marks native: true when resolved by exact variable id", async () => {
    const design = makeDesign("#000000", "VariableID:123");
    const token: ColorToken = {
      path: "text_primary",
      qualified: true,
      variableId: "VariableID:123",
      hex: "#000000",
      alpha: 1,
    };

    await resolveVariableFillNames(design, noOpService, "f", localTokensWith(token, true));

    expect(design.globalVars.tokens?.text_primary?.native).toBe(true);
    expect(design.globalVars.tokens?.text_primary?.approx).toBeUndefined();
  });

  it("marks native: true (alongside approx: true) when resolved only by color-value fallback", async () => {
    // The bound variable id ("VariableID:999") is NOT in the local export's
    // byVariableId map, so resolution falls back to matching the fill's
    // resolved color (#000000) against the HIG token's hex+alpha.
    const design = makeDesign("#000000", "VariableID:999");
    const token: ColorToken = {
      path: "text_primary",
      qualified: true,
      variableId: "VariableID:111",
      hex: "#000000",
      alpha: 1,
    };

    await resolveVariableFillNames(design, noOpService, "f", localTokensWith(token, false));

    expect(design.globalVars.tokens?.text_primary?.native).toBe(true);
    expect(design.globalVars.tokens?.text_primary?.approx).toBe(true);
  });
});

describe("color token native flag — resolved via the live Variables API only", () => {
  it("leaves native absent when the token never matched the local HIG export", async () => {
    const design = makeDesign("#336699", "VariableID:777");
    const service = {
      getVariables: async () => ({
        meta: {
          variables: {
            "777": {
              id: "777",
              name: "Accent/Brand",
              key: "k777",
              variableCollectionId: "vc1",
              resolvedType: "COLOR",
              valuesByMode: { mode1: { r: 0.2, g: 0.4, b: 0.6, a: 1 } },
              remote: false,
              description: "",
              hiddenFromPublishing: false,
              scopes: [],
              codeSyntax: {},
            },
          },
          variableCollections: {},
        },
      }),
    } as unknown as FigmaService;

    // No local tokens at all — forces resolution to Pass 2 (live API).
    await resolveVariableFillNames(design, service, "f", {});

    const info = design.globalVars.tokens?.accent_brand;
    expect(info).toBeDefined();
    expect(info?.native).toBeUndefined();
  });
});
