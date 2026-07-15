import { z } from "zod";
import type { FigmaService } from "~/services/figma.js";
import { writeImageset } from "~/services/write-imageset.js";
import { Logger } from "~/utils/logger.js";
import type { ToolExtra } from "../progress.js";

const parameters = {
  fileKey: z
    .string()
    .regex(/^[a-zA-Z0-9]+$/, "File key must be alphanumeric")
    .describe("The key of the Figma file containing the icon"),
  nodeId: z
    .string()
    .regex(
      /^I?\d+[:|-]\d+(?:;\d+[:|-]\d+)*$/,
      "Node ID must be like '1234:5678' or 'I5666:180910;1:10515;1:10336'",
    )
    .describe("The ID of the icon node to export as a vector PDF"),
  assetName: z
    .string()
    .regex(/^[A-Za-z0-9_]+$/, "Asset name must be letters, numbers, or underscores (no extension)")
    .describe("The Xcode asset name, e.g. 'ZWorkdriveLogo' (creates <assetName>.imageset)"),
  assetCatalogPath: z
    .string()
    .describe(
      "Path to the target .xcassets directory (absolute, or relative to the server cwd), e.g. 'ZSheet/Assets.xcassets'. Must already exist.",
    ),
  group: z
    .string()
    .regex(/^[A-Za-z0-9_/]+$/, "Group must be letters, numbers, underscores, or slashes")
    .optional()
    .describe("Optional subfolder inside the catalog, e.g. 'DataConnection'"),
  overwrite: z
    .boolean()
    .optional()
    .default(false)
    .describe("Replace the imageset if it already exists. Defaults to false (skip if present)."),
};

const parametersSchema = z.object(parameters);
export type WriteImagesetToolParams = z.infer<typeof parametersSchema>;

async function handler(
  params: WriteImagesetToolParams,
  figmaService: FigmaService,
  _extra: ToolExtra,
) {
  try {
    const result = await writeImageset(figmaService, parametersSchema.parse(params));
    return {
      isError: result.status === "error",
      content: [{ type: "text" as const, text: result.message }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Logger.error(`Error writing imageset for ${params.nodeId}:`, message);
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Failed to write imageset: ${message}` }],
    };
  }
}

export const writeImagesetTool = {
  name: "write_imageset",
  description:
    "Export a Figma icon node as a vector PDF (native Figma export) and write it as an Xcode .imageset into an existing asset catalog, with a standard single-scale Contents.json. Skips if the imageset already exists unless overwrite is set.",
  parametersSchema,
  handler,
} as const;
