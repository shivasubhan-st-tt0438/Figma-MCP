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
      "The Xcode color asset name, e.g. 'primaryGreenColor' (becomes <assetName>.colorset)",
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
    .describe("Optional subfolder inside the catalog, e.g. 'ColorSet' (becomes a path prefix)"),
};

const parametersSchema = z.object(parameters);
export type WriteColorsetToolParams = z.infer<typeof parametersSchema>;

async function handler(params: WriteColorsetToolParams, _extra: ToolExtra) {
  try {
    const result = writeColorset(parametersSchema.parse(params));
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
    Logger.error(`Error preparing colorset ${params.assetName}:`, message);
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Failed to prepare colorset: ${message}` }],
    };
  }
}

export const writeColorsetTool = {
  name: "write_colorset",
  description:
    "Format a Figma fill color as an Xcode .colorset (the repo's exact srgb hex-byte format) and RETURN it for you to write into your own asset catalog — this server does not write to disk (it may be hosted remotely). The result is a JSON payload of files to create; save it and run native/apply-figma-asset.sh <your .xcassets dir> <payload.json>, or write the file yourself. Check your catalog for an existing colorset with the same color and reuse it instead of duplicating.",
  parametersSchema,
  handler,
} as const;
