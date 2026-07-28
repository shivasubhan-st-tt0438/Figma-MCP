import { describe, expect, it, vi } from "vitest";
import { attachDevResources } from "~/services/enrich-design.js";
import type { SimplifiedDesign } from "~/extractors/types.js";
import type { FigmaService } from "~/services/figma.js";

function makeDesign(): SimplifiedDesign {
  return {
    name: "design",
    nodes: [
      {
        id: "1:1",
        name: "Frame",
        type: "FRAME",
        children: [{ id: "1:2", name: "Button", type: "INSTANCE" }],
      },
    ],
    components: {},
    componentSets: {},
    globalVars: { styles: {} },
  };
}

function stubService(impl: () => Promise<unknown>): FigmaService {
  return { getDevResources: impl } as unknown as FigmaService;
}

async function resolveOne(name: string, url: string) {
  const service = stubService(async () => ({
    dev_resources: [{ id: "r1", name, url, file_key: "f", node_id: "1:2" }],
  }));
  const design = makeDesign();
  await attachDevResources(design, service, "f");
  return design.nodes[0].children![0].implementedBy;
}

describe("attachDevResources", () => {
  it("a plain class name gets no scopePath — symbol names the whole type", async () => {
    const result = await resolveOne(
      "ZSDialogWindow",
      "https://native/Pods/ZSMacUIFramework/native/ZSSheetUIFramework/SheetView/DialogBox/ZSDialogWindow.swift",
    );
    expect(result).toEqual([
      {
        file: "native/Pods/ZSMacUIFramework/native/ZSSheetUIFramework/SheetView/DialogBox/ZSDialogWindow.swift",
        symbol: "ZSDialogWindow",
      },
    ]);
  });

  it("ClassName_variableName splits into a 2-element scopePath", async () => {
    const result = await resolveOne(
      "ZSDialogWindow_isEditable",
      "https://native/ZSDialogWindow.swift",
    );
    expect(result).toEqual([
      {
        file: "native/ZSDialogWindow.swift",
        symbol: "ZSDialogWindow_isEditable",
        scopePath: ["ZSDialogWindow", "isEditable"],
      },
    ]);
  });

  it("ClassName_functionName_variableName splits into a 3-element scopePath", async () => {
    const result = await resolveOne(
      "ZSDialogWindow_handleSave_isEditable",
      "https://native/ZSDialogWindow.swift",
    );
    expect(result![0].scopePath).toEqual(["ZSDialogWindow", "handleSave", "isEditable"]);
  });

  it("functionName_variableName (no class) still splits correctly", async () => {
    const result = await resolveOne("handleSave_isEditable", "https://native/Helpers.swift");
    expect(result![0].scopePath).toEqual(["handleSave", "isEditable"]);
  });

  it("drops any link that does not end in .swift entirely (no field added)", async () => {
    const service = stubService(async () => ({
      dev_resources: [
        { id: "r1", name: "Storybook", url: "https://sb.example", file_key: "f", node_id: "1:2" },
        {
          id: "r2",
          name: "Ticket",
          url: "https://jira.example/T-1",
          file_key: "f",
          node_id: "1:2",
        },
      ],
    }));

    const design = makeDesign();
    await attachDevResources(design, service, "f");

    expect(design.nodes[0].children![0].implementedBy).toBeUndefined();
  });

  it("leaves the tree untouched when the endpoint fails (missing scope etc.)", async () => {
    const service = stubService(async () => {
      throw new Error("403 Forbidden");
    });

    const design = makeDesign();
    await attachDevResources(design, service, "f");

    expect(design.nodes[0].implementedBy).toBeUndefined();
    expect(design.nodes[0].children![0].implementedBy).toBeUndefined();
  });
});

describe("attachDevResources — component variant references", () => {
  const REF_FILE_KEY = "refFile";
  const REF_NODE_ID = "9:1";
  const SET_NODE_ID = "9:2";

  function makeSectionRawResponse() {
    return {
      name: "sheetmac_components",
      nodes: {
        [REF_NODE_ID]: {
          document: {
            id: REF_NODE_ID,
            name: "Pushbuttons",
            type: "SECTION",
            clipsContent: true,
            layoutMode: "HORIZONTAL",
            itemSpacing: 20,
            paddingLeft: 10,
            paddingRight: 10,
            paddingTop: 10,
            paddingBottom: 10,
            absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 100 },
            children: [
              {
                id: "9:10",
                name: "Push Button",
                type: "INSTANCE",
                absoluteBoundingBox: { x: 10, y: 10, width: 56, height: 22 },
                componentId: "9:20",
                componentProperties: {
                  State: { type: "VARIANT", value: "Secondary" },
                  Enabled: { type: "VARIANT", value: "False" },
                },
              },
              {
                id: "9:11",
                name: "Push Button",
                type: "INSTANCE",
                absoluteBoundingBox: { x: 90, y: 10, width: 56, height: 22 },
                componentId: "9:21",
                componentProperties: {
                  State: { type: "VARIANT", value: "Secondary" },
                  Enabled: { type: "VARIANT", value: "True" },
                },
              },
            ],
          },
          components: {
            "9:20": {
              key: "k1",
              name: "State=Secondary, Enabled=False",
              componentSetId: SET_NODE_ID,
            },
            "9:21": {
              key: "k2",
              name: "State=Secondary, Enabled=True",
              componentSetId: SET_NODE_ID,
            },
          },
          componentSets: {
            [SET_NODE_ID]: { key: "setKey", name: "Push Button" },
          },
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
                variantOptions: ["Primary", "Secondary", "Destructive"],
              },
              Enabled: { type: "VARIANT", defaultValue: "True", variantOptions: ["True", "False"] },
            },
          },
        },
      },
    };
  }

  function stubServiceWithRawNode(
    getRawNodeCalls: { fileKey: string; nodeId: string; depth?: number | null }[],
  ) {
    const getRawNode = vi.fn(async (fileKey: string, nodeId: string, depth?: number | null) => {
      getRawNodeCalls.push({ fileKey, nodeId, depth });
      if (nodeId === REF_NODE_ID) return { data: makeSectionRawResponse(), rawSize: 0 };
      if (nodeId === SET_NODE_ID) return { data: makeSetDefinitionRawResponse(), rawSize: 0 };
      throw new Error(`Unexpected getRawNode call: ${fileKey}/${nodeId}`);
    });
    return getRawNode;
  }

  function makeDesignWithVariantLink(nodeIds: string[]): SimplifiedDesign {
    return {
      name: "design",
      nodes: nodeIds.map((id) => ({ id, name: id, type: "INSTANCE" })),
      components: {},
      componentSets: {},
      globalVars: { styles: {} },
    };
  }

  it("attaches componentVariantReferences with core details, stripped of relational noise", async () => {
    const calls: { fileKey: string; nodeId: string; depth?: number | null }[] = [];
    const getRawNode = stubServiceWithRawNode(calls);
    const service = {
      getDevResources: async () => ({
        dev_resources: [
          {
            id: "r1",
            name: "Push Button variants",
            url: `https://www.figma.com/design/${REF_FILE_KEY}/sheetmac_components?node-id=${REF_NODE_ID.replace(":", "-")}`,
            file_key: "f",
            node_id: "cancel-button",
          },
        ],
      }),
      getRawNode,
    } as unknown as FigmaService;

    const design = makeDesignWithVariantLink(["cancel-button"]);
    await attachDevResources(design, service, "f");

    expect(design.componentVariantReferences).toHaveLength(1);
    const entry = design.componentVariantReferences![0] as Record<string, unknown>;
    expect(entry.fileKey).toBe(REF_FILE_KEY);
    expect(entry.nodeId).toBe(REF_NODE_ID);

    // full theoretical matrix (from enrichComponentSetDefinitions) is present
    const componentSets = entry.componentSets as Record<string, { propertyDefinitions?: unknown }>;
    expect(componentSets[SET_NODE_ID].propertyDefinitions).toMatchObject({
      State: { variantOptions: ["Primary", "Secondary", "Destructive"] },
    });

    // actually-instantiated variants, core details intact, relational noise stripped
    const nodes = entry.nodes as Record<string, unknown>[];
    expect(nodes).toHaveLength(1);
    const section = nodes[0];
    expect(section.parentId).toBeUndefined();
    expect(section.siblingIndex).toBeUndefined();
    const sectionLayout = section.layout as Record<string, unknown>;
    expect(sectionLayout.gap).toBeUndefined();
    expect(sectionLayout.padding).toBeUndefined();
    expect(sectionLayout.mode).toBe("row");

    const variants = section.children as Record<string, unknown>[];
    expect(variants).toHaveLength(2);
    for (const variant of variants) {
      expect(variant.parentId).toBeUndefined();
      expect(variant.parentName).toBeUndefined();
      expect(variant.siblingIndex).toBeUndefined();
      const variantLayout = variant.layout as Record<string, unknown> | undefined;
      if (variantLayout) expect(variantLayout.locationRelativeToParent).toBeUndefined();
      expect(variant.componentProperties).toBeDefined();
    }
  });

  it("dedupes identical links across multiple consuming nodes (e.g. Cancel + OK) to a single fetch and entry", async () => {
    const calls: { fileKey: string; nodeId: string; depth?: number | null }[] = [];
    const getRawNode = stubServiceWithRawNode(calls);
    const sameUrl = `https://www.figma.com/design/${REF_FILE_KEY}/sheetmac_components?node-id=${REF_NODE_ID.replace(":", "-")}`;
    const service = {
      getDevResources: async () => ({
        dev_resources: [
          {
            id: "r1",
            name: "Push Button variants",
            url: sameUrl,
            file_key: "f",
            node_id: "cancel-button",
          },
          {
            id: "r2",
            name: "Push Button variants",
            url: sameUrl,
            file_key: "f",
            node_id: "ok-button",
          },
        ],
      }),
      getRawNode,
    } as unknown as FigmaService;

    const design = makeDesignWithVariantLink(["cancel-button", "ok-button"]);
    await attachDevResources(design, service, "f");

    expect(design.componentVariantReferences).toHaveLength(1);
    // one fetch for the section + one for the componentSet definitions — not doubled
    const sectionFetches = calls.filter((c) => c.nodeId === REF_NODE_ID);
    expect(sectionFetches).toHaveLength(1);
  });

  it("leaves componentVariantReferences unset when no dev resource is a Figma design URL", async () => {
    const service = stubService(async () => ({
      dev_resources: [
        {
          id: "r1",
          name: "Ticket",
          url: "https://jira.example/T-1",
          file_key: "f",
          node_id: "1:2",
        },
      ],
    }));
    const design = makeDesign();
    await attachDevResources(design, service, "f");
    expect(design.componentVariantReferences).toBeUndefined();
  });
});
