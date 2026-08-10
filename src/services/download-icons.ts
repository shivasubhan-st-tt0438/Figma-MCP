import type { SimplifiedDesign, SimplifiedNode } from "~/extractors/types.js";
import type { FigmaService } from "~/services/figma.js";
import type { ReturnedAssetFile } from "~/utils/returned-asset.js";
import { slugify } from "~/utils/slugify.js";
import { Logger } from "~/utils/logger.js";

/**
 * IMAGE-SVG is a type-level proxy for "icon, not image" (see below), but type
 * alone doesn't rule out a decorative shape that happens to collapse to the
 * same type. isIconSized applies one deliberately simple rule: reject a node
 * whose width OR height is under MIN_ICON_DIMENSION. That drops hairline
 * slivers (1px dividers, stray sub-pixel markers) while keeping every real
 * glyph — most icons in this app are 16x16 or larger.
 *
 * Intentionally NOT a ratio or max-size check. A permissive size floor plus
 * the explicit get_render_urls escape hatch — for the messy, ungrouped cases
 * where the auto-filter can't know the right unit to render — was chosen over
 * an ever-tuned geometric heuristic. The tradeoff, accepted on purpose: a
 * large square-ish background or a >=16px-tall bar still passes here; pull
 * those out with an explicit render when precision matters.
 */
const MIN_ICON_DIMENSION = 16;

function isIconSized(box: { width: number; height: number }): boolean {
  const { width, height } = box;
  return width >= MIN_ICON_DIMENSION && height >= MIN_ICON_DIMENSION;
}

/**
 * Collect every icon node in the fetched tree as a vector PDF, base64-encoded,
 * and return them for the CLIENT to write — stamping `iconFile` (the filename
 * a node's icon appears under in the returned payload) on each one.
 *
 * This used to write the PDFs to the server's --image-dir. That only reaches
 * the caller when the server shares its filesystem (stdio on the same machine);
 * hosted over HTTP the files land on the host, useless to a remote client. So
 * the bytes now ride back in the tool response instead (as a second payload,
 * see get-figma-data.ts), applied client-side via native/apply-figma-asset.sh.
 * The bytes travel the already-open MCP connection rather than the client
 * pulling Figma's short-lived signed URLs itself — proxy-robust, no expiry.
 *
 * Scoped to nodes already classified `IMAGE-SVG` by node-walker.ts (which
 * renames every raw VECTOR node to IMAGE-SVG, and also gives that type to
 * SVG-only containers collapsed by collapseSvgContainers — see built-in.ts).
 * This is a deliberate proxy for "icon, not image": a full raster photo/logo
 * an icon might be cropped from is an IMAGE-fill FRAME/RECTANGLE, never
 * IMAGE-SVG. But two categories of non-icon IMAGE-SVG node still slip
 * through that type check alone, so two more filters run before collecting:
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
 *    assets worth collecting regardless of shape.
 *
 * Best-effort like every other enrichment pass: a render-API failure or a
 * single icon's fetch failure is logged and skipped, never thrown — a broken
 * icon must not break the fetch itself.
 *
 * `pruneRejected` (default false) controls what happens to a rejected
 * candidate (either reason): pruned from `design` entirely, or left in place
 * as a plain node with no `iconFile` stamp. Default false because a rejected
 * node is still real layout information — a sub-floor divider is a real
 * visible separator, not noise — so dropping it loses signal a consumer might
 * need. Set true to reclaim the token cost instead, on the assumption that
 * icon-shaped rejects are noise for that specific consumer. Either way, a
 * candidate that passes both checks but fails at the actual render/fetch step
 * below is a runtime hiccup, not a rejection — it always stays in the tree
 * without an `iconFile` stamp, same as any other best-effort miss.
 */
export async function collectIconAssets(
  design: SimplifiedDesign,
  figmaService: FigmaService,
  fileKey: string,
  pruneRejected = false,
): Promise<ReturnedAssetFile[]> {
  const iconNodes: SimplifiedNode[] = [];
  let skippedAsNativeDecomposition = 0;
  let skippedAsTooSmall = 0;

  const visit = (nodes: SimplifiedNode[], insideNative: boolean): SimplifiedNode[] =>
    nodes.filter((node) => {
      const stillInsideNative = insideNative || node.native === true;
      if (node.type === "IMAGE-SVG") {
        if (stillInsideNative) {
          skippedAsNativeDecomposition++;
          if (pruneRejected) return false;
        } else if (!node.absoluteBoundingBox || !isIconSized(node.absoluteBoundingBox)) {
          skippedAsTooSmall++;
          if (pruneRejected) return false;
        } else {
          iconNodes.push(node);
        }
      }
      if (node.children) node.children = visit(node.children, stillInsideNative);
      return true;
    });
  design.nodes = visit(design.nodes, false);

  if (skippedAsNativeDecomposition > 0 || skippedAsTooSmall > 0) {
    const action = pruneRejected ? "pruned" : "skipped";
    Logger.log(
      `Icon collection: ${action} ${skippedAsNativeDecomposition} node(s) inside native-control visual decomposition and ${skippedAsTooSmall} node(s) too small to be icons (under ${MIN_ICON_DIMENSION}px on an axis) — not real icon assets.`,
    );
  }
  if (iconNodes.length === 0) return [];

  let urls: Record<string, string>;
  try {
    urls = await figmaService.getNodeRenderUrls(
      fileKey,
      iconNodes.map((n) => n.id),
      "pdf",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Logger.log(`Skipping icon collection (${iconNodes.length} icons): ${message}`);
    return [];
  }

  const files: ReturnedAssetFile[] = [];
  await Promise.all(
    iconNodes.map(async (node) => {
      const url = urls[node.id];
      if (!url) return;
      // nodeId suffix guarantees uniqueness even when several icons share a
      // generic layer name like "Vector".
      const fileName = `${slugify(node.name) || "icon"}_${node.id.replace(/[:;]/g, "_")}.pdf`;
      try {
        const res = await fetch(url);
        if (!res.ok) {
          Logger.log(
            `Failed to fetch icon ${node.id} (${fileName}): ${res.status} ${res.statusText}`,
          );
          return;
        }
        const base64 = Buffer.from(await res.arrayBuffer()).toString("base64");
        // push is synchronous — safe under the event loop's single thread even
        // though these fetches run concurrently. Order doesn't matter here.
        files.push({ path: fileName, encoding: "base64", content: base64 });
        node.iconFile = fileName;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        Logger.log(`Failed to fetch icon ${node.id} (${fileName}): ${message}`);
      }
    }),
  );
  return files;
}
