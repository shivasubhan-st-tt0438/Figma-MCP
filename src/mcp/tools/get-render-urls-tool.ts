import { z } from "zod";
import type { FigmaService } from "~/services/figma.js";
import { compactId } from "~/utils/native-json.js";
import { Logger } from "~/utils/logger.js";

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
      "Array of node IDs to render, each formatted as '1234:5678'. Pass every node you want in one call — the response returns one downloadable URL per node. The URLs serve the chosen format (vector PDF by default) for those nodes.",
    ),
  format: z
    .enum(["png", "svg", "pdf"])
    .default("pdf")
    .describe(
      "Export format. Defaults to 'pdf' (vector PDF — the app's icon/asset format). Use 'svg' for vector markup, or 'png' for raster pixels.",
    ),
  pngScale: z
    .number()
    .positive()
    .optional()
    .default(2)
    .describe("Export scale for PNG format. Defaults to 2 (2×/Retina). Ignored for svg and pdf."),
});

export type GetRenderUrlsParams = z.infer<typeof parametersSchema>;

/**
 * Best-effort node names for the render result, so a caller can save each
 * download as `<name>.<ext>` instead of a random URL id. One batched /nodes
 * call at depth 0 (node headers only — no subtree). Any failure just omits
 * names; the URLs still come back.
 */
async function fetchNames(
  figmaService: FigmaService,
  fileKey: string,
  ids: string[],
): Promise<Record<string, string>> {
  try {
    const res = await figmaService.getRawNode(fileKey, ids.join(","), 0);
    const nodes = res.data.nodes as Record<string, { document?: { name?: string } } | undefined>;
    const names: Record<string, string> = {};
    for (const id of ids) {
      const name = nodes[id]?.document?.name;
      if (name) names[id] = name;
    }
    return names;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Logger.log(`Could not resolve render node names (${ids.length} ids): ${message}`);
    return {};
  }
}

async function handler(params: GetRenderUrlsParams, figmaService: FigmaService) {
  const { fileKey, nodeIds, format, pngScale } = parametersSchema.parse(params);

  // Normalise - to : in nodeIds (MCP input quirk)
  const normalised = nodeIds.map((id) => id.replace(/-/g, ":"));

  const [urls, names] = await Promise.all([
    figmaService.getNodeRenderUrls(fileKey, normalised, format, { pngScale }),
    fetchNames(figmaService, fileKey, normalised),
  ]);

  const entries = normalised.map((id) => ({
    // Stripped to the last segment (the icon's own id) — matches how the node
    // appears in a get_figma_data tree; the full override chain isn't needed
    // to identify it, and the URL already carries the render.
    nodeId: compactId(id),
    // The node's real Figma name — save the download as `<name>.<format>`
    // (the URL has no filename). Absent if the name couldn't be resolved.
    ...(names[id] ? { name: names[id] } : {}),
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
    "Get direct, downloadable render URLs for one or more Figma nodes (icons, images, any node) — the single tool for pulling asset bytes. Returns one entry per node: its Figma `name`, its `nodeId`, and a `url`; download the url yourself (the server does not write files) and save it as `<name>.<format>` (the url has no filename). Defaults to vector PDF (the app's icon/asset format); pass format 'svg' for vector markup or 'png' for raster (at the requested scale, default 2×). Pass all the node ids you want in one call.",
  parametersSchema: parametersSchema.shape,
  handler,
};
