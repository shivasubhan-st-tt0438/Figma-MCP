import { describe, expect, it, vi } from "vitest";
import { getFigmaDataBatch } from "~/services/get-figma-data.js";
import type { FigmaService } from "~/services/figma.js";

function makeRawNodeResponse(nodeId: string, name: string) {
  return {
    data: {
      name: "test file",
      nodes: {
        [nodeId]: {
          document: {
            id: nodeId,
            name,
            type: "FRAME",
            clipsContent: true,
            absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
          },
          components: {},
          componentSets: {},
          styles: {},
        },
      },
    },
    rawSize: 100,
  };
}

function makeService(): FigmaService {
  const getRawNode = vi.fn(async (fileKey: string, nodeId: string) => {
    if (fileKey === "fileA") return makeRawNodeResponse(nodeId, "Screen A");
    if (fileKey === "fileB") return makeRawNodeResponse(nodeId, "Screen B");
    throw new Error(`Unexpected file key: ${fileKey}`);
  });
  const getDevResources = vi.fn(async () => ({ dev_resources: [] }));
  return { getRawNode, getDevResources } as unknown as FigmaService;
}

describe("getFigmaDataBatch", () => {
  it("returns one independent formatted result per target, guide attached only to the first", async () => {
    const service = makeService();

    const { entries } = await getFigmaDataBatch(
      service,
      [
        { fileKey: "fileA", nodeId: "1:1" },
        { fileKey: "fileB", nodeId: "2:1" },
      ],
      "native-yaml",
    );

    expect(entries).toHaveLength(2);
    expect(entries[0].error).toBeUndefined();
    expect(entries[1].error).toBeUndefined();
    expect(entries[0].formatted).toContain("guide:");
    expect(entries[1].formatted).not.toContain("guide:");
    expect(entries[0].metrics).toBeDefined();
    expect(entries[1].metrics).toBeDefined();
    expect(entries[0].formatted).toContain("Screen A");
    expect(entries[1].formatted).toContain("Screen B");
  });

  it("isolates a per-target failure — one broken target doesn't break the rest of the batch", async () => {
    const getRawNode = vi.fn(async (fileKey: string, nodeId: string) => {
      if (fileKey === "broken") throw new Error("404 Not Found");
      return makeRawNodeResponse(nodeId, "Screen B");
    });
    const getDevResources = vi.fn(async () => ({ dev_resources: [] }));
    const service = { getRawNode, getDevResources } as unknown as FigmaService;

    const { entries } = await getFigmaDataBatch(
      service,
      [
        { fileKey: "broken", nodeId: "1:1" },
        { fileKey: "fileB", nodeId: "2:1" },
      ],
      "native-yaml",
    );

    expect(entries).toHaveLength(2);
    expect(entries[0].error).toContain("404 Not Found");
    expect(entries[0].formatted).toBeUndefined();
    expect(entries[1].error).toBeUndefined();
    expect(entries[1].formatted).toContain("Screen B");
    // guide moves to the first SUCCEEDING target when the first target failed
    expect(entries[1].formatted).toContain("guide:");
  });
});
