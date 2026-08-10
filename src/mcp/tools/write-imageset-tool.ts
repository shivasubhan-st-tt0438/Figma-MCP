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
    .describe("The Xcode asset name, e.g. 'ZWorkdriveLogo' (becomes <assetName>.imageset)"),
  group: z
    .string()
    .regex(/^[A-Za-z0-9_/]+$/, "Group must be letters, numbers, underscores, or slashes")
    .optional()
    .describe(
      "Optional subfolder inside the catalog, e.g. 'DataConnection' (becomes a path prefix)",
    ),
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
    if (result.status === "error") {
      return { isError: true, content: [{ type: "text" as const, text: result.message }] };
    }
    // Two content items: the machine-readable payload (for native/apply-figma-asset.sh
    // or the agent's own file writes) and a short human-readable status line.
    return {
      content: [
        { type: "text" as const, text: result.payload },
        { type: "text" as const, text: result.message },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Logger.error(`Error preparing imageset for ${params.nodeId}:`, message);
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Failed to prepare imageset: ${message}` }],
    };
  }
}

export const writeImagesetTool = {
  name: "write_imageset",
  description:
    "Export a Figma icon node as a vector PDF (native Figma export) and RETURN it, base64-encoded, as an Xcode .imageset for you to write into your own asset catalog — this server does not write to disk (it may be hosted remotely). The result is a JSON payload of files to create; save it and run native/apply-figma-asset.sh <your .xcassets dir> <payload.json> (it decodes the base64 PDF), or write the files yourself (decode the base64 entry to binary — never save the base64 text as-is).",
  parametersSchema,
  handler,
} as const;
