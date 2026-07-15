import { z } from "zod";
import { writeColorset } from "~/services/write-colorset.js";
import { Logger } from "~/utils/logger.js";
import type { ToolExtra } from "../progress.js";

const HEX = /^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const parameters = {
  assetName: z
    .string()
    .regex(/^[A-Za-z0-9_]+$/, "Asset name must be letters, numbers, or underscores")
    .describe(
      "The Xcode color asset name, e.g. 'primaryGreenColor' (creates <assetName>.colorset)",
    ),
  assetCatalogPath: z
    .string()
    .describe(
      "Path to the target .xcassets directory (absolute, or relative to the server cwd), e.g. 'ZSheet/Assets.xcassets'. Must already exist.",
    ),
  hex: z
    .string()
    .regex(HEX, "hex must be like #089949, 089949, or #089949FF")
    .describe("Light/universal color hex"),
  alpha: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Optional alpha 0..1 (overrides hex alpha). Default 1."),
  darkHex: z.string().regex(HEX).optional().describe("Optional dark-appearance color hex"),
  darkAlpha: z.number().min(0).max(1).optional().describe("Optional dark-appearance alpha 0..1"),
  group: z
    .string()
    .regex(/^[A-Za-z0-9_/]+$/, "Group must be letters, numbers, underscores, or slashes")
    .optional()
    .describe("Optional subfolder inside the catalog, e.g. 'ColorSet'"),
  reuse: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Return an existing colorset whose color matches instead of creating a duplicate. Default true.",
    ),
  overwrite: z
    .boolean()
    .optional()
    .default(false)
    .describe("Replace the colorset if it already exists. Default false."),
};

const parametersSchema = z.object(parameters);
export type WriteColorsetToolParams = z.infer<typeof parametersSchema>;

async function handler(params: WriteColorsetToolParams, _extra: ToolExtra) {
  try {
    const result = writeColorset(parametersSchema.parse(params));
    return {
      isError: result.status === "error",
      content: [{ type: "text" as const, text: result.message }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Logger.error(`Error writing colorset ${params.assetName}:`, message);
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Failed to write colorset: ${message}` }],
    };
  }
}

export const writeColorsetTool = {
  name: "write_colorset",
  description:
    "Map a Figma fill color to an Xcode .colorset in an existing asset catalog, using the repo's exact srgb hex-byte format. Reuses an existing colorset whose universal color matches (to avoid duplicates) unless reuse is false. Skips if the named colorset already exists unless overwrite is set.",
  parametersSchema,
  handler,
} as const;
