import { describe, expect, it } from "vitest";
import { extractFromDesign } from "~/extractors/node-walker.js";
import { allExtractors } from "~/extractors/built-in.js";
import type { Node as FigmaNode } from "@figma/rest-api-spec";

function makeNode(overrides: Record<string, unknown>): FigmaNode {
  return { visible: true, ...overrides } as unknown as FigmaNode;
}

describe("visualsExtractor — fills", () => {
  it("omits fills entirely when every paint on the node is invisible", async () => {
    const node = makeNode({
      id: "1:1",
      name: "Ghost Rect",
      type: "RECTANGLE",
      fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, visible: false }],
    });

    const { nodes } = await extractFromDesign([node], allExtractors);

    expect(nodes[0].fills).toBeUndefined();
  });

  it("still emits fills when at least one paint is visible", async () => {
    const node = makeNode({
      id: "1:2",
      name: "Real Rect",
      type: "RECTANGLE",
      fills: [
        { type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, visible: false },
        { type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 }, visible: true },
      ],
    });

    const { nodes } = await extractFromDesign([node], allExtractors);

    expect(nodes[0].fills).toBeDefined();
  });
});
