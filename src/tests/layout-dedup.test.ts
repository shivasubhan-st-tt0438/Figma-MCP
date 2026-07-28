import { describe, expect, it } from "vitest";
import { extractFromDesign } from "~/extractors/node-walker.js";
import { allExtractors } from "~/extractors/built-in.js";
import type { Node as FigmaNode } from "@figma/rest-api-spec";
import type { SimplifiedLayout } from "~/transformers/layout.js";

function makeNode(overrides: Record<string, unknown>): FigmaNode {
  return { visible: true, ...overrides } as unknown as FigmaNode;
}

async function extractOne(node: FigmaNode) {
  const { nodes, globalVars } = await extractFromDesign([node], allExtractors);
  const result = nodes[0];
  const layout =
    typeof result.layout === "string"
      ? (globalVars.styles[result.layout] as SimplifiedLayout)
      : undefined;
  return { result, layout };
}

describe("layout.dimensions vs absoluteBoundingBox dedup", () => {
  it("drops layout.dimensions entirely when both axes duplicate absoluteBoundingBox", async () => {
    const { result, layout } = await extractOne(
      makeNode({
        id: "1:1",
        name: "Fixed Box",
        type: "RECTANGLE",
        absoluteBoundingBox: { x: 0, y: 0, width: 50, height: 30 },
        layoutSizingHorizontal: "FIXED",
        layoutSizingVertical: "FIXED",
      }),
    );

    expect(result.absoluteBoundingBox).toEqual({ width: 50, height: 30 });
    expect(layout?.dimensions).toBeUndefined();
  });
});

describe("layout.sizing omission", () => {
  it("omits sizing entirely when neither axis is part of any auto-layout system", async () => {
    const { layout } = await extractOne(
      makeNode({
        id: "1:3",
        name: "Section",
        type: "SECTION",
        absoluteBoundingBox: { x: 0, y: 0, width: 330, height: 264 },
        // no layoutSizingHorizontal / layoutSizingVertical at all
      }),
    );

    expect(layout?.sizing).toBeUndefined();
  });

  it("keeps sizing when at least one axis resolves", async () => {
    const { layout } = await extractOne(
      makeNode({
        id: "1:4",
        name: "Fixed Width",
        type: "RECTANGLE",
        absoluteBoundingBox: { x: 0, y: 0, width: 50, height: 30 },
        layoutSizingHorizontal: "FIXED",
      }),
    );

    expect(layout?.sizing).toBeDefined();
    expect(layout?.sizing?.horizontal).toBe("fixed");
  });
});
