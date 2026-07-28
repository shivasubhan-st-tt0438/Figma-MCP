import { describe, expect, it, vi } from "vitest";
import { downloadIcons } from "~/services/download-icons.js";
import type { SimplifiedDesign, SimplifiedNode } from "~/extractors/types.js";
import type { FigmaService } from "~/services/figma.js";

function makeService(requestedIds: string[][]): FigmaService {
  const getNodeRenderUrls = vi.fn(async (_fileKey: string, ids: string[]) => {
    requestedIds.push(ids);
    return {};
  });
  return { getNodeRenderUrls } as unknown as FigmaService;
}

function makeDesign(nodes: SimplifiedNode[]): SimplifiedDesign {
  return { name: "design", nodes, components: {}, componentSets: {}, globalVars: { styles: {} } };
}

describe("downloadIcons", () => {
  it("collects an icon at the 20px floor (inclusive)", async () => {
    const requested: string[][] = [];
    const service = makeService(requested);
    const design = makeDesign([
      {
        id: "1:1",
        name: "chevron",
        type: "IMAGE-SVG",
        absoluteBoundingBox: { width: 20, height: 20 },
      },
    ]);

    await downloadIcons(design, service, "f", "/tmp/out");

    expect(requested.flat()).toEqual(["1:1"]);
  });

  it("rejects a node under 20px on either axis, keeps ones at or above on both (no max cap)", async () => {
    const requested: string[][] = [];
    const service = makeService(requested);
    const design = makeDesign([
      {
        id: "1:1",
        name: "thin width",
        type: "IMAGE-SVG",
        absoluteBoundingBox: { width: 10, height: 40 },
      },
      {
        id: "1:2",
        name: "thin height",
        type: "IMAGE-SVG",
        absoluteBoundingBox: { width: 40, height: 10 },
      },
      {
        id: "1:3",
        name: "normal icon",
        type: "IMAGE-SVG",
        absoluteBoundingBox: { width: 24, height: 24 },
      },
      // min-only floor deliberately does NOT cap max size — a large square-ish
      // shape passes here on purpose (pull it out with an explicit render if
      // it's actually a background, not an icon).
      {
        id: "1:4",
        name: "big shape",
        type: "IMAGE-SVG",
        absoluteBoundingBox: { width: 180, height: 120 },
      },
    ]);

    await downloadIcons(design, service, "f", "/tmp/out");

    expect(requested.flat().sort()).toEqual(["1:3", "1:4"]);
  });

  it("rejects a hairline sliver on either orientation", async () => {
    const requested: string[][] = [];
    const service = makeService(requested);
    const design = makeDesign([
      {
        id: "1:1",
        name: "v divider",
        type: "IMAGE-SVG",
        absoluteBoundingBox: { width: 1, height: 300 },
      },
      {
        id: "1:2",
        name: "h divider",
        type: "IMAGE-SVG",
        absoluteBoundingBox: { width: 300, height: 1 },
      },
    ]);

    await downloadIcons(design, service, "f", "/tmp/out");

    expect(requested).toHaveLength(0);
  });

  it("skips every descendant of a native: true instance, regardless of size", async () => {
    const requested: string[][] = [];
    const service = makeService(requested);
    const design = makeDesign([
      {
        id: "1:1",
        name: "Titlebar",
        type: "INSTANCE",
        native: true,
        children: [
          {
            id: "1:2",
            name: "traffic lights",
            type: "IMAGE-SVG",
            absoluteBoundingBox: { width: 52, height: 24 },
          },
        ],
      },
      {
        id: "1:3",
        name: "real icon",
        type: "IMAGE-SVG",
        absoluteBoundingBox: { width: 20, height: 20 },
      },
    ]);

    await downloadIcons(design, service, "f", "/tmp/out");

    expect(requested.flat()).toEqual(["1:3"]);
  });

  it("does nothing when every IMAGE-SVG node is filtered out (never calls getNodeRenderUrls)", async () => {
    const requested: string[][] = [];
    const service = makeService(requested);
    const design = makeDesign([
      {
        id: "1:1",
        name: "sliver",
        type: "IMAGE-SVG",
        absoluteBoundingBox: { width: 1, height: 300 },
      },
    ]);

    await downloadIcons(design, service, "f", "/tmp/out");

    expect(requested).toHaveLength(0);
  });
});
