import type { SimplifiedDesign, SimplifiedNode } from "~/extractors/types.js";
import type { FigmaService } from "~/services/figma.js";
import { downloadFigmaImage } from "~/utils/common.js";
import { slugify } from "~/utils/slugify.js";
import { Logger } from "~/utils/logger.js";

/**
 * IMAGE-SVG is a type-level proxy for "icon, not image" (see below), but type
 * alone doesn't rule out a decorative shape that happens to collapse to the
 * same type. isIconSized applies one deliberately simple rule: reject a node
 * whose width OR height is under MIN_ICON_DIMENSION. That drops hairline
 * slivers (1px dividers, stray sub-pixel markers) while keeping every real
 * glyph — most icons in this app are 20x20 or larger.
 *
 * Intentionally NOT a ratio or max-size check. A permissive size floor plus
 * the explicit get_render_urls escape hatch — for the messy, ungrouped cases
 * where the auto-filter can't know the right unit to render — was chosen over
 * an ever-tuned geometric heuristic. The tradeoff, accepted on purpose: a
 * large square-ish background or a >=20px-tall bar still passes here; pull
 * those out with an explicit render when precision matters.
 */
const MIN_ICON_DIMENSION = 20;

function isIconSized(box: { width: number; height: number }): boolean {
  const { width, height } = box;
  return width >= MIN_ICON_DIMENSION && height >= MIN_ICON_DIMENSION;
}

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
 * IMAGE-SVG. But two categories of non-icon IMAGE-SVG node still slip
 * through that type check alone, so two more filters run before download:
 *
 * 1. Size — a hairline divider or stray sliver can satisfy
 *    collapseSvgContainers' "all children SVG-eligible" rule just as well as
 *    a real glyph; isIconSized rejects anything under the icon size floor on
 *    either axis.
 * 2. Native-control descendants — a node inside a `native: true` instance's
 *    subtree is Figma's own visual decomposition of a STOCK AppKit control
 *    (e.g. the traffic-light dots inside a native Titlebar), per the "Native
 *    vs Custom Components" consumption rule. The app uses the real control,
 *    never a static picture of its internals, so these are never real
 *    assets worth downloading regardless of shape.
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
  let skippedAsNativeDecomposition = 0;
  let skippedAsTooSmall = 0;

  const visit = (nodes: SimplifiedNode[], insideNative: boolean): void => {
    for (const node of nodes) {
      const stillInsideNative = insideNative || node.native === true;
      if (node.type === "IMAGE-SVG") {
        if (stillInsideNative) {
          skippedAsNativeDecomposition++;
        } else if (!node.absoluteBoundingBox || !isIconSized(node.absoluteBoundingBox)) {
          skippedAsTooSmall++;
        } else {
          iconNodes.push(node);
        }
      }
      if (node.children) visit(node.children, stillInsideNative);
    }
  };
  visit(design.nodes, false);

  if (skippedAsNativeDecomposition > 0 || skippedAsTooSmall > 0) {
    Logger.log(
      `Icon auto-download: skipped ${skippedAsNativeDecomposition} node(s) inside native-control visual decomposition and ${skippedAsTooSmall} node(s) too small to be icons (under ${MIN_ICON_DIMENSION}px on an axis) — not real icon assets.`,
    );
  }
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
