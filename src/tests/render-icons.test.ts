import { describe, expect, it, vi } from "vitest";
import { collectIconRenderUrls } from "~/services/render-icons.js";
import type { SimplifiedDesign, SimplifiedNode } from "~/extractors/types.js";
import type { FigmaService } from "~/services/figma.js";

function makeService(requestedIds: string[][], urls: Record<string, string> = {}): FigmaService {
  const getNodeRenderUrls = vi.fn(async (_fileKey: string, ids: string[], _format: string) => {
    requestedIds.push(ids);
    return urls;
  });
  return { getNodeRenderUrls } as unknown as FigmaService;
}

function makeDesign(nodes: SimplifiedNode[]): SimplifiedDesign {
  return { name: "d", nodes, components: {}, componentSets: {}, globalVars: { styles: {} } };
}

describe("collectIconRenderUrls", () => {
  it("stamps iconUrl on every icon-sized IMAGE-SVG node, in one batched render call", async () => {
    const requested: string[][] = [];
    const service = makeService(requested, {
      "1:1": "https://figma/render/a.pdf",
      "1:2": "https://figma/render/b.pdf",
    });
    const design = makeDesign([
      {
        id: "1:1",
        name: "chevron",
        type: "IMAGE-SVG",
        absoluteBoundingBox: { width: 16, height: 16 },
      },
      {
        id: "1:2",
        name: "gear",
        type: "IMAGE-SVG",
        absoluteBoundingBox: { width: 24, height: 24 },
      },
    ]);

    await collectIconRenderUrls(design, service, "f");

    // One batched call for both ids.
    expect(requested).toHaveLength(1);
    expect(requested[0].sort()).toEqual(["1:1", "1:2"]);
    expect(design.nodes[0].iconUrl).toBe("https://figma/render/a.pdf");
    expect(design.nodes[1].iconUrl).toBe("https://figma/render/b.pdf");
  });

  it("renders every IMAGE-SVG regardless of size (no size floor — small icons kept)", async () => {
    const requested: string[][] = [];
    const service = makeService(requested, {
      "1:1": "https://figma/render/a.pdf",
      "1:2": "https://figma/render/b.pdf",
      "1:3": "https://figma/render/c.pdf",
    });
    const design = makeDesign([
      {
        id: "1:1",
        name: "tiny sliver",
        type: "IMAGE-SVG",
        absoluteBoundingBox: { width: 1, height: 300 },
      },
      {
        id: "1:2",
        name: "small icon",
        type: "IMAGE-SVG",
        absoluteBoundingBox: { width: 12, height: 12 },
      },
      {
        id: "1:3",
        name: "icon",
        type: "IMAGE-SVG",
        absoluteBoundingBox: { width: 20, height: 20 },
      },
    ]);

    await collectIconRenderUrls(design, service, "f");

    // All three requested — including the sub-16px and 1px nodes.
    expect(requested[0].sort()).toEqual(["1:1", "1:2", "1:3"]);
    expect(design.nodes[0].iconUrl).toBe("https://figma/render/a.pdf");
    expect(design.nodes[1].iconUrl).toBe("https://figma/render/b.pdf");
    expect(design.nodes[2].iconUrl).toBe("https://figma/render/c.pdf");
  });

  it("skips every descendant of a native: true instance (its icons are stock-control decomposition)", async () => {
    const requested: string[][] = [];
    const service = makeService(requested, { "1:3": "https://figma/render/real.pdf" });
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

    await collectIconRenderUrls(design, service, "f");

    expect(requested.flat()).toEqual(["1:3"]);
    expect(design.nodes[0].children?.[0].iconUrl).toBeUndefined();
    expect(design.nodes[1].iconUrl).toBe("https://figma/render/real.pdf");
  });

  it("leaves a node unstamped when its render URL comes back null/missing (best-effort)", async () => {
    const requested: string[][] = [];
    // "1:2" is requested but not present in the returned url map (Figma couldn't
    // export it on its own) — it must stay unstamped, without breaking "1:1".
    const service = makeService(requested, { "1:1": "https://figma/render/a.pdf" });
    const design = makeDesign([
      { id: "1:1", name: "ok", type: "IMAGE-SVG", absoluteBoundingBox: { width: 20, height: 20 } },
      {
        id: "1:2",
        name: "unexportable",
        type: "IMAGE-SVG",
        absoluteBoundingBox: { width: 20, height: 20 },
      },
    ]);

    await collectIconRenderUrls(design, service, "f");

    expect(design.nodes[0].iconUrl).toBe("https://figma/render/a.pdf");
    expect(design.nodes[1].iconUrl).toBeUndefined();
  });

  it("never calls the render API when there are no IMAGE-SVG nodes", async () => {
    const requested: string[][] = [];
    const service = makeService(requested);
    const design = makeDesign([
      {
        id: "1:1",
        name: "row",
        type: "FRAME",
        children: [{ id: "1:2", name: "label", type: "TEXT" }],
      },
    ]);

    await collectIconRenderUrls(design, service, "f");

    expect(requested).toHaveLength(0);
  });
});
