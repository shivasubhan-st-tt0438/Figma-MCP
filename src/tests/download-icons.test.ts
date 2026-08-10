import { afterEach, describe, expect, it, vi } from "vitest";
import { collectIconAssets } from "~/services/download-icons.js";
import type { SimplifiedDesign, SimplifiedNode } from "~/extractors/types.js";
import type { FigmaService } from "~/services/figma.js";

function makeService(requestedIds: string[][], urls: Record<string, string> = {}): FigmaService {
  const getNodeRenderUrls = vi.fn(async (_fileKey: string, ids: string[]) => {
    requestedIds.push(ids);
    return urls;
  });
  return { getNodeRenderUrls } as unknown as FigmaService;
}

function makeDesign(nodes: SimplifiedNode[]): SimplifiedDesign {
  return { name: "design", nodes, components: {}, componentSets: {}, globalVars: { styles: {} } };
}

describe("collectIconAssets", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("collects an icon at the 16px floor (inclusive)", async () => {
    const requested: string[][] = [];
    const service = makeService(requested);
    const design = makeDesign([
      {
        id: "1:1",
        name: "chevron",
        type: "IMAGE-SVG",
        absoluteBoundingBox: { width: 16, height: 16 },
      },
    ]);

    await collectIconAssets(design, service, "f");

    expect(requested.flat()).toEqual(["1:1"]);
  });

  it("rejects a node under 16px on either axis, keeps ones at or above on both (no max cap)", async () => {
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

    await collectIconAssets(design, service, "f");

    expect(requested.flat().sort()).toEqual(["1:3", "1:4"]);
  });

  it("by default leaves a rejected node in the tree, just without an iconFile stamp", async () => {
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

    await collectIconAssets(design, service, "f");

    expect(requested).toHaveLength(0);
    expect(design.nodes.map((n) => n.id)).toEqual(["1:1", "1:2"]);
    expect(design.nodes.every((n) => n.iconFile === undefined)).toBe(true);
  });

  it("prunes rejected nodes from the tree when pruneRejected is true", async () => {
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

    await collectIconAssets(design, service, "f", true);

    expect(requested).toHaveLength(0);
    expect(design.nodes).toHaveLength(0);
  });

  it("skips every descendant of a native: true instance regardless of size, and keeps them by default", async () => {
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

    await collectIconAssets(design, service, "f");

    expect(requested.flat()).toEqual(["1:3"]);
    // Kept by default — no iconFile stamp, but still present under the Titlebar.
    expect(design.nodes.map((n) => n.id)).toEqual(["1:1", "1:3"]);
    expect(design.nodes[0].children?.map((n) => n.id)).toEqual(["1:2"]);
  });

  it("prunes native-decomposition descendants when pruneRejected is true", async () => {
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

    await collectIconAssets(design, service, "f", true);

    expect(requested.flat()).toEqual(["1:3"]);
    expect(design.nodes.map((n) => n.id)).toEqual(["1:1", "1:3"]);
    expect(design.nodes[0].children).toEqual([]);
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

    await collectIconAssets(design, service, "f");

    expect(requested).toHaveLength(0);
    expect(design.nodes).toHaveLength(1);
  });

  it("returns each icon as a base64 file and stamps iconFile on the node — never writes to disk", async () => {
    const requested: string[][] = [];
    const service = makeService(requested, { "1:1": "https://figma.example/render.pdf" });
    // The bytes come back over the MCP connection, not via a client S3 pull —
    // stub fetch to stand in for Figma's render URL.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode("%PDF-1.7").buffer,
      })),
    );
    const node: SimplifiedNode = {
      id: "1:1",
      name: "chevron down",
      type: "IMAGE-SVG",
      absoluteBoundingBox: { width: 20, height: 20 },
    };
    const design = makeDesign([node]);

    const files = await collectIconAssets(design, service, "f");

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("chevron_down_1_1.pdf");
    expect(files[0].encoding).toBe("base64");
    // Round-trips to the real bytes, not the base64 text.
    expect(Buffer.from(files[0].content, "base64").toString()).toBe("%PDF-1.7");
    // Node references the file it appears under in the payload.
    expect(node.iconFile).toBe("chevron_down_1_1.pdf");
  });
});
