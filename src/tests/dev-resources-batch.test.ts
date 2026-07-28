import { describe, expect, it, vi } from "vitest";
import { attachDevResourcesBatch } from "~/services/enrich-design.js";
import type { SimplifiedDesign } from "~/extractors/types.js";
import type { FigmaService } from "~/services/figma.js";

const REF_FILE_KEY = "refFile";
const REF_NODE_ID = "9:1";
const SET_NODE_ID = "9:2";
const REF_URL = `https://www.figma.com/design/${REF_FILE_KEY}/sheetmac_components?node-id=${REF_NODE_ID.replace(":", "-")}`;

function makeScreenDesign(instanceNodeId: string): SimplifiedDesign {
  return {
    name: "screen",
    nodes: [{ id: instanceNodeId, name: "Push Button", type: "INSTANCE" }],
    components: {},
    componentSets: {},
    globalVars: { styles: {} },
  };
}

function makeSectionRawResponse() {
  return {
    name: "sheetmac_components",
    nodes: {
      [REF_NODE_ID]: {
        document: {
          id: REF_NODE_ID,
          name: "Pushbuttons",
          type: "SECTION",
          absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 100 },
          children: [
            {
              id: "9:10",
              name: "Push Button",
              type: "INSTANCE",
              absoluteBoundingBox: { x: 10, y: 10, width: 56, height: 22 },
              componentId: "9:20",
              componentProperties: { State: { type: "VARIANT", value: "Primary" } },
            },
          ],
        },
        components: {
          "9:20": { key: "k1", name: "State=Primary", componentSetId: SET_NODE_ID },
        },
        componentSets: { [SET_NODE_ID]: { key: "setKey", name: "Push Button" } },
        styles: {},
      },
    },
  };
}

function makeSetDefinitionRawResponse() {
  return {
    name: "sheetmac_components",
    nodes: {
      [SET_NODE_ID]: {
        document: {
          id: SET_NODE_ID,
          name: "Push Button",
          type: "COMPONENT_SET",
          componentPropertyDefinitions: {
            State: {
              type: "VARIANT",
              defaultValue: "Primary",
              variantOptions: ["Primary", "Secondary"],
            },
          },
        },
      },
    },
  };
}

function makeServiceWithRawNodeTracking(getDevResources: FigmaService["getDevResources"]) {
  const getRawNodeCalls: string[] = [];
  const getRawNode = vi.fn(async (_fileKey: string, nodeId: string) => {
    getRawNodeCalls.push(nodeId);
    if (nodeId === REF_NODE_ID) return { data: makeSectionRawResponse(), rawSize: 0 };
    if (nodeId === SET_NODE_ID) return { data: makeSetDefinitionRawResponse(), rawSize: 0 };
    throw new Error(`Unexpected getRawNode call: ${nodeId}`);
  });
  const service = { getDevResources, getRawNode } as unknown as FigmaService;
  return { service, getRawNodeCalls };
}

describe("attachDevResourcesBatch", () => {
  it("fetches /dev_resources once per unique file key, not once per entry", async () => {
    const getDevResources = vi.fn(async () => ({ dev_resources: [] }));
    const service = { getDevResources } as unknown as FigmaService;

    await attachDevResourcesBatch(
      [
        { design: makeScreenDesign("a:1"), fileKey: "shared" },
        { design: makeScreenDesign("a:2"), fileKey: "shared" },
      ],
      service,
    );

    expect(getDevResources).toHaveBeenCalledTimes(1);
  });

  it("attaches a component-variant reference shared by two screens only to the first, fetched once", async () => {
    const getDevResources = vi.fn(async () => ({
      dev_resources: [
        {
          id: "r1",
          name: "Push Button variants",
          url: REF_URL,
          file_key: "f",
          node_id: "cancel-button",
        },
      ],
    }));
    const { service, getRawNodeCalls } = makeServiceWithRawNodeTracking(getDevResources);

    const screen1 = makeScreenDesign("cancel-button");
    const screen2 = makeScreenDesign("cancel-button"); // same node id, different screen

    await attachDevResourcesBatch(
      [
        { design: screen1, fileKey: "f" },
        { design: screen2, fileKey: "f" },
      ],
      service,
    );

    expect(screen1.componentVariantReferences).toHaveLength(1);
    expect(screen2.componentVariantReferences).toBeUndefined();
    expect(getRawNodeCalls.filter((id) => id === REF_NODE_ID)).toHaveLength(1);
  });

  it("attaches implementedBy independently per entry — not deduplicated like variant references", async () => {
    const getDevResources = vi.fn(async () => ({
      dev_resources: [
        {
          id: "r1",
          name: "ZSPushButton",
          url: "https://native/ZSPushButton.swift",
          file_key: "f",
          node_id: "shared-node-id",
        },
      ],
    }));
    const service = { getDevResources } as unknown as FigmaService;

    const screen1 = makeScreenDesign("shared-node-id");
    const screen2 = makeScreenDesign("shared-node-id");

    await attachDevResourcesBatch(
      [
        { design: screen1, fileKey: "f" },
        { design: screen2, fileKey: "f" },
      ],
      service,
    );

    expect(screen1.nodes[0].implementedBy).toEqual([
      { file: "native/ZSPushButton.swift", symbol: "ZSPushButton" },
    ]);
    expect(screen2.nodes[0].implementedBy).toEqual([
      { file: "native/ZSPushButton.swift", symbol: "ZSPushButton" },
    ]);
  });
});
