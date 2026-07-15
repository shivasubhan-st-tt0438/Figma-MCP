import type { SimplifiedDesign, SimplifiedNode } from "~/extractors/types.js";
import type { FigmaService } from "~/services/figma.js";
import { downloadFigmaImage } from "~/utils/common.js";
import { slugify } from "~/utils/slugify.js";
import { Logger } from "~/utils/logger.js";

/**
 * Auto-download every icon node in the fetched tree as a vector PDF — the
 * same native Figma PDF export write_imageset uses — and stamp `iconFile`
 * on each one with the saved filename. Lets a consumer skip a separate
 * download_figma_images round-trip per icon: the fetch itself hands back a
 * ready-to-use local asset alongside the design data.
 *
 * Scoped to nodes already classified `IMAGE-SVG` by node-walker.ts (which
 * renames every raw VECTOR node to IMAGE-SVG, and also gives that type to
 * SVG-only containers collapsed by collapseSvgContainers — see built-in.ts).
 * This is a deliberate proxy for "icon, not image": a full raster photo/logo
 * an icon might be cropped from is an IMAGE-fill FRAME/RECTANGLE, never
 * IMAGE-SVG, so this check alone already enforces the icon-vs-image
 * distinction from PROJECT_DIRECTIVE without any extra name-based heuristic.
 *
 * Best-effort like every other enrichment pass: a render-API failure or a
 * single icon's download failure is logged and skipped, never thrown — a
 * broken icon download must not break the fetch itself.
 */
export async function downloadIcons(
  design: SimplifiedDesign,
  figmaService: FigmaService,
  fileKey: string,
  imageDir: string,
): Promise<void> {
  const iconNodes: SimplifiedNode[] = [];
  const visit = (nodes: SimplifiedNode[]): void => {
    for (const node of nodes) {
      if (node.type === "IMAGE-SVG") iconNodes.push(node);
      if (node.children) visit(node.children);
    }
  };
  visit(design.nodes);
  if (iconNodes.length === 0) return;

  let urls: Record<string, string>;
  try {
    urls = await figmaService.getNodeRenderUrls(
      fileKey,
      iconNodes.map((n) => n.id),
      "pdf",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Logger.log(`Skipping icon auto-download (${iconNodes.length} icons): ${message}`);
    return;
  }

  await Promise.all(
    iconNodes.map(async (node) => {
      const url = urls[node.id];
      if (!url) return;
      // nodeId suffix guarantees uniqueness even when several icons share a
      // generic layer name like "Vector".
      const fileName = `${slugify(node.name) || "icon"}_${node.id.replace(/[:;]/g, "_")}.pdf`;
      try {
        await downloadFigmaImage(fileName, imageDir, url);
        node.iconFile = fileName;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        Logger.log(`Failed to download icon ${node.id} (${fileName}): ${message}`);
      }
    }),
  );
}
