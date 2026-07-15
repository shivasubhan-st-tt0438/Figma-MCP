import { z } from "zod";
import type { FigmaService } from "~/services/figma.js";

const parametersSchema = z.object({
  fileKey: z
    .string()
    .regex(/^[a-zA-Z0-9]+$/, "File key must be alphanumeric")
    .describe("The key of the Figma file containing the nodes to render"),
  nodeIds: z
    .string()
    .regex(
      /^I?\d+[:|-]\d+(?:;\d+[:|-]\d+)*$/,
      "Node ID must be like '1234:5678' or 'I5666:180910;1:10515;1:10336'",
    )
    .array()
    .min(1)
    .describe(
      "Array of node IDs to render. Each ID is formatted as '1234:5678'. The returned URLs serve the raster (PNG) pixels for those nodes.",
    ),
  format: z
    .enum(["png", "svg", "pdf"])
    .default("png")
    .describe(
      "Export format. Use 'png' for raster pixels, 'svg' for vector, 'pdf' for vector PDF.",
    ),
  pngScale: z
    .number()
    .positive()
    .optional()
    .default(2)
    .describe("Export scale for PNG format. Defaults to 2 (2×/Retina). Ignored for svg and pdf."),
});

export type GetRenderUrlsParams = z.infer<typeof parametersSchema>;

async function handler(params: GetRenderUrlsParams, figmaService: FigmaService) {
  const { fileKey, nodeIds, format, pngScale } = parametersSchema.parse(params);

  // Normalise - to : in nodeIds (MCP input quirk)
  const normalised = nodeIds.map((id) => id.replace(/-/g, ":"));

  const urls = await figmaService.getNodeRenderUrls(fileKey, normalised, format, { pngScale });

  const entries = normalised.map((id) => ({
    nodeId: id,
    url: urls[id] ?? null,
    format,
  }));

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ fileKey, renders: entries }, null, 2),
      },
    ],
  };
}

export const getRenderUrlsTool = {
  name: "get_render_urls",
  description:
    "Get direct render URLs (raster PNG, vector SVG, or vector PDF) for one or more Figma nodes without downloading them. Use the returned URLs to fetch the actual pixel/vector data. For PNG, the URL serves a raster image at the requested scale (default 2×). Pass these URLs to a fetch/download step to obtain the actual bytes.",
  parametersSchema: parametersSchema.shape,
  handler,
};
