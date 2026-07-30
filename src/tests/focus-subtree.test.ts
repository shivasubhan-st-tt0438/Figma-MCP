import { describe, expect, it } from "vitest";
import {
  focusDesignSubtree,
  searchDesignByName,
  renderNameSearchListing,
} from "~/services/enrich-design.js";
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

  it("falls back to matching by name when the focus value isn't a node id", () => {
    const design = makeDesign();

    focusDesignSubtree(design, "Frame 1");

    expect(design.nodes).toHaveLength(1);
    expect(design.nodes[0].id).toBe("I3096:91050;1907:3787");
  });

  it("matches by name case-insensitively — data may be Title Case, user input may not be", () => {
    const design = makeDesign();

    focusDesignSubtree(design, "frame 1");

    expect(design.nodes).toHaveLength(1);
    expect(design.nodes[0].id).toBe("I3096:91050;1907:3787");
  });

  it("keeps every node sharing a duplicate name as a separate subtree, not just the first", () => {
    const design: SimplifiedDesign = {
      name: "design",
      nodes: [
        {
          id: "1:1",
          name: "Root",
          type: "FRAME",
          children: [
            { id: "1:2", name: "Icon", type: "IMAGE-SVG" },
            { id: "1:3", name: "ICON", type: "IMAGE-SVG" },
            { id: "1:4", name: "Other", type: "IMAGE-SVG" },
          ],
        },
      ],
      components: {},
      componentSets: {},
      globalVars: { styles: {} },
    };

    focusDesignSubtree(design, "icon");

    expect(design.nodes.map((n) => n.id).sort()).toEqual(["1:2", "1:3"]);
  });

  it("prefers an id match over a same-named fallback when both could apply", () => {
    // "1907:3787" is Frame 1's real id, so even if some other node were
    // (implausibly) named exactly "1907:3787", the id match wins.
    const design = makeDesign();

    focusDesignSubtree(design, "1907:3787");

    expect(design.nodes[0].name).toBe("Frame 1");
  });
});

describe("searchDesignByName", () => {
  function makeSearchDesign(): SimplifiedDesign {
    return {
      name: "design",
      nodes: [
        {
          id: "1:1",
          name: "Root",
          type: "FRAME",
          children: [
            {
              id: "1:2",
              name: "Table Style",
              type: "FRAME",
              // Nested nodes that also match the query — must be collapsed
              // into the outer "Table Style" match, not listed separately.
              children: [
                { id: "1:3", name: "Table style", type: "TEXT" },
                { id: "1:4", name: "Table style", type: "TEXT" },
              ],
            },
            { id: "1:5", name: "Sidebar", type: "FRAME" },
            { id: "1:6", name: "Style Table (large)", type: "FRAME" },
          ],
        },
      ],
      components: {},
      componentSets: {},
      globalVars: { styles: {} },
    };
  }

  it("matches token-AND, case-insensitively, in any word order", () => {
    const design = makeSearchDesign();

    const matches = searchDesignByName(design, "table style");

    // "Table Style" and "Style Table (large)" both contain both words;
    // "Sidebar" does not. The nested "Table style" TEXT nodes are collapsed
    // into their matching ancestor.
    expect(matches.map((m) => m.id).sort()).toEqual(["1:2", "1:6"]);
  });

  it("does not descend into a match (nested same-name hits are collapsed)", () => {
    const design = makeSearchDesign();

    const matches = searchDesignByName(design, "table style");
    const tableStyle = matches.find((m) => m.id === "1:2");

    expect(tableStyle).toBeDefined();
    // The three inner "Table style" nodes are NOT separate matches.
    expect(matches.some((m) => m.id === "1:3" || m.id === "1:4")).toBe(false);
  });

  it("records the ancestor path for each match", () => {
    const design = makeSearchDesign();

    const matches = searchDesignByName(design, "sidebar");

    expect(matches).toHaveLength(1);
    expect(matches[0].path).toBe("Root > Sidebar");
    expect(matches[0].type).toBe("FRAME");
  });

  it("returns nothing when not every token appears", () => {
    const design = makeSearchDesign();

    // "Sidebar" contains neither "table" nor "style".
    expect(searchDesignByName(design, "sidebar table")).toEqual([]);
  });
});

describe("renderNameSearchListing", () => {
  it("lists each match with id/name/type/path", () => {
    const listing = renderNameSearchListing("table style", [
      { id: "1:2", name: "Table Style", type: "FRAME", path: "Root > Table Style" },
    ]);

    expect(listing).toContain("1 node(s) matched");
    expect(listing).toContain("id: 1:2");
    expect(listing).toContain("name: Table Style");
    expect(listing).toContain("path: Root > Table Style");
  });

  it("says so plainly when there are no matches", () => {
    const listing = renderNameSearchListing("nonexistent", []);

    expect(listing).toContain("No node name matched");
    expect(listing).toContain("nonexistent");
  });
});
