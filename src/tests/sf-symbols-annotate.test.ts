import { describe, expect, it } from "vitest";
import { annotateSfSymbols } from "~/services/enrich-design.js";
import type { SimplifiedDesign } from "~/extractors/types.js";

function makeDesign(nodes: SimplifiedDesign["nodes"]): SimplifiedDesign {
  return { name: "design", nodes, components: {}, componentSets: {}, globalVars: { styles: {} } };
}

// U+100000 -> "circle" per the vendored SF_SYMBOL_NAMES table.
const CIRCLE_GLYPH = String.fromCodePoint(0x100000);

describe("annotateSfSymbols", () => {
  it("still rewrites PUA glyphs in text content and records sfSymbols (regression)", () => {
    const design = makeDesign([{ id: "1:1", name: "Label", type: "TEXT", text: CIRCLE_GLYPH }]);

    annotateSfSymbols(design);

    expect(design.nodes[0].text).toBe("{sf:circle}");
    expect(design.nodes[0].sfSymbols).toEqual(["circle"]);
  });

  it("rewrites a PUA glyph used as the layer name into a readable placeholder", () => {
    const design = makeDesign([{ id: "1:1", name: CIRCLE_GLYPH, type: "TEXT" }]);

    annotateSfSymbols(design);

    expect(design.nodes[0].name).toBe("{sf:circle}");
  });

  it("does not add name-glyph resolutions to sfSymbols (that field stays text-content-only)", () => {
    const design = makeDesign([{ id: "1:1", name: CIRCLE_GLYPH, type: "TEXT" }]);

    annotateSfSymbols(design);

    expect(design.nodes[0].sfSymbols).toBeUndefined();
  });

  it("leaves an ordinary layer name untouched", () => {
    const design = makeDesign([{ id: "1:1", name: "Chevron Icon", type: "FRAME" }]);

    annotateSfSymbols(design);

    expect(design.nodes[0].name).toBe("Chevron Icon");
  });
});
