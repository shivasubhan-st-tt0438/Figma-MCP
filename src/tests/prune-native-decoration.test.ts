import { describe, expect, it } from "vitest";
import { pruneNativeDecoration } from "~/services/enrich-design.js";
import type { SimplifiedDesign } from "~/extractors/types.js";

function makeDesign(nodes: SimplifiedDesign["nodes"]): SimplifiedDesign {
  return { name: "design", nodes, components: {}, componentSets: {}, globalVars: { styles: {} } };
}

describe("pruneNativeDecoration", () => {
  it("drops children of a native instance when nothing in the subtree is mineable (e.g. traffic lights)", () => {
    const design = makeDesign([
      {
        id: "1:1",
        name: "Window Controls",
        type: "INSTANCE",
        native: true,
        children: [
          { id: "1:2", name: "Close", type: "FRAME" },
          { id: "1:3", name: "Minimize", type: "FRAME" },
          { id: "1:4", name: "Zoom", type: "FRAME" },
        ],
      },
    ]);

    pruneNativeDecoration(design);

    expect(design.nodes[0].children).toBeUndefined();
  });

  it("keeps children of a native instance when one has real text", () => {
    const design = makeDesign([
      {
        id: "1:1",
        name: "Title",
        type: "INSTANCE",
        native: true,
        children: [{ id: "1:2", name: "Label", type: "TEXT", text: "Insert Timelines" }],
      },
    ]);

    pruneNativeDecoration(design);

    expect(design.nodes[0].children).toHaveLength(1);
  });

  it("keeps children of a native instance when one has componentPropertyReferences, even with no text yet", () => {
    const design = makeDesign([
      {
        id: "1:1",
        name: "Title",
        type: "INSTANCE",
        native: true,
        children: [
          {
            id: "1:2",
            name: "Label",
            type: "TEXT",
            componentPropertyReferences: { text: "Title" },
          },
        ],
      },
    ]);

    pruneNativeDecoration(design);

    expect(design.nodes[0].children).toHaveLength(1);
  });

  it("gives a nested native instance its own independent prune decision", () => {
    const design = makeDesign([
      {
        id: "1:1",
        name: "Titlebar",
        type: "INSTANCE",
        native: true,
        children: [
          { id: "1:2", name: "Title", type: "TEXT", text: "Insert Timelines" },
          {
            id: "1:3",
            name: "Window Controls",
            type: "INSTANCE",
            native: true,
            children: [{ id: "1:4", name: "Close", type: "FRAME" }],
          },
        ],
      },
    ]);

    pruneNativeDecoration(design);

    // Outer Titlebar keeps its children (the Title has real text) ...
    expect(design.nodes[0].children).toHaveLength(2);
    // ... but the nested Window Controls still gets pruned on its own merits.
    const windowControls = design.nodes[0].children!.find((n) => n.id === "1:3")!;
    expect(windowControls.children).toBeUndefined();
  });

  it("leaves non-native nodes untouched regardless of their children's content", () => {
    const design = makeDesign([
      {
        id: "1:1",
        name: "Custom Group",
        type: "FRAME",
        children: [{ id: "1:2", name: "Decoration", type: "FRAME" }],
      },
    ]);

    pruneNativeDecoration(design);

    expect(design.nodes[0].children).toHaveLength(1);
  });
});
