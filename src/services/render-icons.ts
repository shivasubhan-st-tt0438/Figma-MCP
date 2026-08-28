import type { SimplifiedDesign, SimplifiedNode } from "~/extractors/types.js";
import type { FigmaService } from "~/services/figma.js";
import { Logger } from "~/utils/logger.js";

/**
 * For every icon in the (already scoped) tree, fetch a Figma render URL (vector
 * PDF) and stamp it on that node as `iconUrl` — a downloadable link per icon, in
 * place, so a consumer never has to enumerate node ids to render them.
 *
 * Why stamp in place instead of returning a separate id→url list: the
 * serialized output strips compound instance ids to their last segment
 * (compactId), so an id read back from the output is NOT renderable. Stamping
 * the URL directly onto the node sidesteps that entirely — and handles repeated
 * instances of the same component correctly (each tree node gets its own URL,
 * where a list keyed by the stripped id would collide).
 *
 * "Icon" = any IMAGE-SVG node (node-walker renames VECTOR → IMAGE-SVG and gives
 * that type to SVG-only containers collapsed by collapseSvgContainers), at ANY
 * size — no size floor, so genuinely small icons are never dropped (the
 * tradeoff: hairline slivers/dividers get a URL too). Still skips nodes inside a
 * `native: true` instance — those descendants are Figma's visual decomposition
 * of a stock AppKit control, which the app renders via the real control, never a
 * picture, so they're not assets worth rendering regardless of size.
 *
 * One batched /images call for every icon. Best-effort, like every other
 * enrichment pass: a render failure — or a node Figma won't export on its own
 * (its URL comes back null, e.g. some deeply-nested native-library
 * instance-internal nodes) — logs and leaves that node unstamped. Never throws.
 *
 * Returns the number of icons actually stamped (0 if there were none, or the
 * render call failed) — callers use this to skip attaching anything
 * icon-related (e.g. the download_icons.py script) to a response that has
 * nothing to download.
 */
// Not enabled yet: the design system's known icon-name prefixes. Uncomment
// the allowlist check below (in the visit walker) to reject any IMAGE-SVG
// node whose name doesn't start with one of these.
// const ALLOWED_ICON_NAME_PREFIXES = [
//   "ic_",
//   "control_",
//   "cursor_",
//   "es_",
//   "style_",
//   "logo_",
//   "ext_",
//   "fileicon_",
// ];

export async function collectIconRenderUrls(
  design: SimplifiedDesign,
  figmaService: FigmaService,
  fileKey: string,
): Promise<number> {
  const iconNodes: SimplifiedNode[] = [];
  const visit = (nodes: SimplifiedNode[], insideNative: boolean): void => {
    for (const node of nodes) {
      const stillInsideNative = insideNative || node.native === true;
      if (node.type === "IMAGE-SVG" && !stillInsideNative) {
        // Not enabled yet: uncomment to reject icons whose name doesn't
        // start with one of the design system's known icon-name prefixes.
        // if (!ALLOWED_ICON_NAME_PREFIXES.some((prefix) => node.name.startsWith(prefix))) continue;
        iconNodes.push(node);
      }
      if (node.children) visit(node.children, stillInsideNative);
    }
  };
  visit(design.nodes, false);
  if (iconNodes.length === 0) return 0;

  let urls: Record<string, string>;
  try {
    urls = await figmaService.getNodeRenderUrls(
      fileKey,
      iconNodes.map((n) => n.id),
      "pdf",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Logger.log(`Skipping icon render URLs (${iconNodes.length} icons): ${message}`);
    return 0;
  }

  let stamped = 0;
  for (const node of iconNodes) {
    const url = urls[node.id];
    if (url) {
      node.iconUrl = url;
      stamped++;
    }
  }
  Logger.log(`Stamped render URLs on ${stamped}/${iconNodes.length} icon node(s).`);
  return stamped;
}
