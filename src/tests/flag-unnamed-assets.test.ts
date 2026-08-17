import { describe, expect, it } from "vitest";
import { flagUnnamedAssets } from "~/services/flag-unnamed-assets.js";
import type { SimplifiedDesign } from "~/extractors/types.js";

function makeDesign(): SimplifiedDesign {
  return {
    name: "d",
    nodes: [
      // raw hex fill, no variable → flagged color
      { id: "1", name: "Box", type: "RECTANGLE", fills: "fill_ABC" },
      // fill keyed by a resolved token → NOT flagged
      { id: "2", name: "Box2", type: "RECTANGLE", fills: "text_primary" },
      // placeholder icon name → flagged icon
      { id: "3", name: "Vector", type: "IMAGE-SVG" },
      // real icon name → NOT flagged
      { id: "4", name: "ic_lock", type: "IMAGE-SVG" },
      // text with a raw font (no style name) → flagged font
      { id: "5", name: "Label", type: "TEXT", text: "Hi", textStyle: "style_1" },
      // text with a named text style → NOT flagged
      {
        id: "6",
        name: "Label2",
        type: "TEXT",
        text: "Yo",
        textStyle: "Body/Regular",
        textStyleName: "Body/Regular",
      },
    ],
    components: {},
    componentSets: {},
    globalVars: {
      styles: {
        fill_ABC: ["#FFFFFF"],
        text_primary: ["#000000"],
        style_1: { fontFamily: "SF Pro", fontSize: 13, fontWeight: 400 },
        "Body/Regular": { fontFamily: "SF Pro", fontSize: 15, fontWeight: 600 },
      },
      tokens: { text_primary: { values: { Light: "#000000" }, themed: false } },
    },
  };
}

describe("flagUnnamedAssets", () => {
  it("flags raw colors, placeholder icons, and unstyled fonts — never the named ones", () => {
    const design = makeDesign();
    flagUnnamedAssets(design);

    expect(design.unnamedAssets?.colors).toEqual(["#FFFFFF"]); // text_primary excluded (it's a token)
    expect(design.unnamedAssets?.icons).toEqual([{ name: "Vector", id: "3" }]); // ic_lock excluded
    expect(design.unnamedAssets?.fonts).toEqual(["SF Pro 13/400"]); // Body/Regular excluded
  });

  it("emits nothing when every asset is named", () => {
    const design = makeDesign();
    // Remove the three unnamed nodes, keep only the named ones.
    design.nodes = design.nodes.filter((n) => ["2", "4", "6"].includes(n.id));
    flagUnnamedAssets(design);

    expect(design.unnamedAssets).toBeUndefined();
  });
});
