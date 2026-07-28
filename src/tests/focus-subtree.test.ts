import { describe, expect, it } from "vitest";
import { focusDesignSubtree } from "~/services/enrich-design.js";
import type { SimplifiedDesign, SimplifiedNode } from "~/extractors/types.js";

// A small instance tree mirroring the real shape: an INSTANCE root whose
// children are instance-internal frames with compound "I<inst>;<local>" ids.
function makeDesign(): SimplifiedDesign {
  const frame1: SimplifiedNode = {
    id: "I3096:91050;1907:3787",
    name: "Frame 1",
    type: "FRAME",
    componentId: "10:1",
    children: [{ id: "I3096:91050;1907:3800", name: "Icon", type: "IMAGE-SVG" }],
  };
  const frame3465342: SimplifiedNode = {
    id: "I3096:91050;1907:3790",
    name: "Frame 3465342",
    type: "FRAME",
    componentId: "20:1",
    children: [{ id: "I3096:91050;1907:3801", name: "Junk", type: "FRAME" }],
  };
  return {
    name: "design",
    nodes: [
      {
        id: "3096:91050",
        name: "Grid / V4",
        type: "INSTANCE",
        children: [
          {
            id: "I3096:91050;1907:3784",
            name: "Frame",
            type: "FRAME",
            children: [frame1, frame3465342],
          },
        ],
      },
    ],
    components: {
      "10:1": { key: "k10", name: "Kept", componentSetId: "10:0" },
      "20:1": { key: "k20", name: "Dropped", componentSetId: "20:0" },
    },
    componentSets: {
      "10:0": { key: "s10", name: "KeptSet" },
      "20:0": { key: "s20", name: "DroppedSet" },
    },
    globalVars: { styles: {} },
  };
}

describe("focusDesignSubtree", () => {
  it("scopes the tree to the matched subtree, dropping sibling branches", () => {
    const design = makeDesign();

    focusDesignSubtree(design, "I3096:91050;1907:3787");

    expect(design.nodes).toHaveLength(1);
    expect(design.nodes[0].name).toBe("Frame 1");
    // The sibling Frame 3465342 and its subtree are gone.
    expect(JSON.stringify(design.nodes)).not.toContain("Frame 3465342");
  });

  it("matches a bare local id (no instance prefix) against the compound node id", () => {
    const design = makeDesign();

    focusDesignSubtree(design, "1907:3787");

    expect(design.nodes).toHaveLength(1);
    expect(design.nodes[0].name).toBe("Frame 1");
  });

  it("matches a hyphenated local id (Figma URL form)", () => {
    const design = makeDesign();

    focusDesignSubtree(design, "1907-3787");

    expect(design.nodes[0].name).toBe("Frame 1");
  });

  it("drops component/componentSet definitions no longer referenced by the kept subtree", () => {
    const design = makeDesign();

    focusDesignSubtree(design, "1907:3787");

    expect(Object.keys(design.components)).toEqual(["10:1"]);
    expect(Object.keys(design.componentSets)).toEqual(["10:0"]);
  });

  it("leaves the full tree untouched when nothing matches", () => {
    const design = makeDesign();
    const before = JSON.stringify(design);

    focusDesignSubtree(design, "9999:9999");

    expect(JSON.stringify(design)).toBe(before);
  });

  it("keeps only the ancestor when a focus id would also match a nested descendant", () => {
    // Two nodes whose ids both end in the same local segment — a match must
    // not be duplicated by also keeping the nested one.
    const design: SimplifiedDesign = {
      name: "design",
      nodes: [
        {
          id: "I1:1;5:5",
          name: "Outer",
          type: "FRAME",
          children: [{ id: "I1:1;9:9;5:5", name: "Inner", type: "FRAME" }],
        },
      ],
      components: {},
      componentSets: {},
      globalVars: { styles: {} },
    };

    focusDesignSubtree(design, "5:5");

    expect(design.nodes).toHaveLength(1);
    expect(design.nodes[0].name).toBe("Outer");
  });
});
