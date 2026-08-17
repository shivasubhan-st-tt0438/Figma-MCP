import type { SimplifiedDesign, SimplifiedNode } from "~/extractors/types.js";

/**
 * Surface assets in the tree that carry no design-system name, so the consumer
 * can catalog them (see the guide) instead of silently shipping raw values.
 * Three kinds, all classified structurally (no guessing):
 *
 * - **Colors**: a fill paint that is a raw hex/rgba AND is not a resolved token
 *   name. A design-system color is bound to a Variable (resolved to a token
 *   name by resolveVariableFillNames, or left with a `fillVariableIds`
 *   breadcrumb); a raw hex with no token is a hardcoded color.
 * - **Icons**: an IMAGE-SVG whose name is a Figma default/placeholder
 *   (Vector, Rectangle, Group, …) rather than a real icon name.
 * - **Fonts**: a TEXT node with real text but no `textStyleName` — it uses a
 *   raw font instead of a named Figma text style.
 *
 * Runs after resolution, on the already-scoped tree. Results are deduped.
 */

const GENERIC_ICON_NAME =
  /^(vector|rectangle|ellipse|group|line|star|polygon|union|subtract|frame|shape|path|oval|mask|clip|boolean|component)\b/i;

function isRawColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value) || /^rgba?\(/i.test(value);
}

/** Last segment of a compound instance id — matches how the output displays ids, so the same underlying icon isn't listed once per instance path. */
function compactId(id: string): string {
  const i = id.lastIndexOf(";");
  return i >= 0 ? id.slice(i + 1) : id;
}

/** "SF Pro 13/600" — enough for the consumer to identify a raw font. */
function fontSignature(design: SimplifiedDesign, node: SimplifiedNode): string | undefined {
  if (!node.textStyle) return undefined;
  const style = design.globalVars.styles[node.textStyle];
  if (!style || typeof style !== "object" || Array.isArray(style)) return undefined;
  const s = style as { fontFamily?: string; fontSize?: number; fontWeight?: number };
  if (!s.fontFamily) return undefined;
  return `${s.fontFamily} ${s.fontSize ?? "?"}/${s.fontWeight ?? "?"}`;
}

export function flagUnnamedAssets(design: SimplifiedDesign): void {
  const tokens = design.globalVars.tokens ?? {};
  const colors = new Set<string>();
  const fonts = new Set<string>();
  const icons: { name: string; id: string }[] = [];
  const seenIcon = new Set<string>();

  const visit = (nodes: SimplifiedNode[]): void => {
    for (const node of nodes) {
      // Colors: only inspect fills whose ref key isn't itself a resolved token
      // (a single-paint resolved fill is keyed by the token name).
      if (typeof node.fills === "string" && !tokens[node.fills]) {
        const arr = design.globalVars.styles[node.fills];
        if (Array.isArray(arr)) {
          for (const paint of arr) {
            if (typeof paint === "string" && isRawColor(paint) && !tokens[paint]) colors.add(paint);
          }
        }
      }

      if (node.type === "IMAGE-SVG" && node.name && GENERIC_ICON_NAME.test(node.name)) {
        const cid = compactId(node.id);
        if (!seenIcon.has(cid)) {
          icons.push({ name: node.name, id: cid });
          seenIcon.add(cid);
        }
      }

      if (node.type === "TEXT" && node.text && !node.textStyleName) {
        const sig = fontSignature(design, node);
        if (sig) fonts.add(sig);
      }

      if (node.children) visit(node.children);
    }
  };
  visit(design.nodes);

  if (colors.size === 0 && icons.length === 0 && fonts.size === 0) return;
  design.unnamedAssets = {
    ...(colors.size > 0 && { colors: [...colors].sort() }),
    ...(icons.length > 0 && { icons }),
    ...(fonts.size > 0 && { fonts: [...fonts].sort() }),
  };
}
