import type {
  SimplifiedDesign,
  SimplifiedNode,
  ResolvedTokenInfo,
  StyleTypes,
} from "~/extractors/types.js";
import type { ColorTokensByMode, ColorToken, ColorTokenMap } from "~/services/color-tokens-file.js";

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace(/^#/, "");
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

/** Render a token's color as the same string format used in fill arrays. */
function tokenColorString(token: ColorToken): string {
  if (token.alpha >= 0.995) return token.hex.startsWith("#") ? token.hex : `#${token.hex}`;
  const { r, g, b } = hexToRgb(token.hex);
  // Figma exports carry float noise (0.8500000238418579); 3 decimals is
  // beyond any perceptible alpha difference.
  const alpha = Math.round(token.alpha * 1000) / 1000;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Whether an AppKit hint is worth keeping in the output. Plain `NSColor.*`
 * hints are dropped: the LIGHT THEME ONLY directive already tells a consumer
 * to prefer the token's fixed Light value over any adaptive semantic color.
 * `NSVisualEffectView.Material.*` hints are kept: they're the only signal that
 * a token is a blur/vibrancy material, not a flat color.
 */
function isUsefulAppkitHint(hint: string): boolean {
  return !hint.startsWith("NSColor.");
}

/**
 * Record token metadata (per-mode Light/Dark values, themed flag, AppKit hint)
 * under globalVars.tokens so consumers can answer "semantic or static?" and
 * get the real Dark value without a live API call. themed=true means the
 * value differs across modes and must map to a dynamic color, never a hex.
 */
function recordTokenInfo(
  design: SimplifiedDesign,
  token: ColorToken,
  localTokens: ColorTokensByMode,
  appkitHints: Record<string, string>,
): void {
  design.globalVars.tokens ??= {};
  if (design.globalVars.tokens[token.path]) return;

  const values: Record<string, string> = {};
  for (const [mode, modeMap] of Object.entries(localTokens)) {
    const modeToken = modeMap.byVariableId.get(token.variableId);
    if (modeToken) values[mode] = tokenColorString(modeToken);
  }
  if (Object.keys(values).length === 0) values.value = tokenColorString(token);

  const distinct = new Set(Object.values(values));
  const info: ResolvedTokenInfo = { values, themed: distinct.size > 1 };
  const appkit = appkitHints[token.path];
  if (appkit && isUsefulAppkitHint(appkit)) info.appkit = appkit;

  design.globalVars.tokens[token.path] = info;
}

/**
 * Resolve fill paints bound to Figma Variables into friendly token names, by
 * EXACT variable-ID match against the local color-token exports (the "Colors -
 * HIG" DTCG JSON files) only. A matched paint's `fill_XXXXXX` key is renamed to
 * the token's snake_case path and its Light/Dark values are recorded under
 * globalVars.tokens.
 *
 * Deliberately ID-only:
 * - NO color/hex fallback — a color match can mislabel two genuinely different
 *   semantic tokens that happen to share a value, and the snapshot color can
 *   lag the variable's live value. A bound paint whose ID isn't in the exports
 *   is left exactly as-is (its `fillVariableIds` breadcrumb stays); the
 *   unnamed-asset flagging pass surfaces it rather than this guessing.
 * - NO live Variables API — that endpoint is Enterprise/`file_variables:read`-
 *   gated. The local exports carry the same per-mode values (including Dark)
 *   for a paid seat, so nothing is lost by dropping it.
 *
 * Pure/synchronous now — no network.
 */
export function resolveVariableFillNames(
  design: SimplifiedDesign,
  localTokens: ColorTokensByMode = {},
  appkitHints: Record<string, string> = {},
): SimplifiedDesign {
  const nodesWithVariableFills: SimplifiedNode[] = [];
  collectNodesWithFillVariables(design.nodes, nodesWithVariableFills);
  if (nodesWithVariableFills.length === 0) return design;

  const localTokenModes = Object.values(localTokens);

  for (const node of nodesWithVariableFills) {
    if (!node.fillVariableIds || !node.fills) continue;

    for (const [indexKey, variableId] of Object.entries(node.fillVariableIds)) {
      const paintIndex = Number(indexKey);
      const currentValue: StyleTypes | undefined = design.globalVars.styles[node.fills];
      const paintEntry: unknown = Array.isArray(currentValue)
        ? currentValue[paintIndex]
        : undefined;

      // Style values are shared via dedup: an earlier node bound to the same
      // (value, variable) pair may have already replaced this paint entry with
      // its token name. Recognize that as resolved.
      if (typeof paintEntry === "string" && design.globalVars.tokens?.[paintEntry]) {
        removeResolvedBinding(node, paintIndex);
        continue;
      }

      let matched: ColorToken | undefined;
      for (const modeMap of localTokenModes) {
        matched = matchLocalTokenById(variableId, modeMap);
        if (matched) break;
      }

      if (matched) {
        applyTokenToPaint(design, node, paintIndex, matched.path);
        recordTokenInfo(design, matched, localTokens, appkitHints);
        removeResolvedBinding(node, paintIndex);
      }
      // No match → left as-is; flagged later as an unnamed color.
    }
  }

  return design;
}

/**
 * Apply a resolved token name to one paint of a node's fill. Single-paint fills
 * rename the whole globalVars key; multi-paint fills replace the bound paint's
 * color string in place, leaving the other paints (gradients, overlays) alone.
 */
function applyTokenToPaint(
  design: SimplifiedDesign,
  node: SimplifiedNode,
  paintIndex: number,
  tokenPath: string,
): void {
  if (!node.fills) return;
  const currentValue = design.globalVars.styles[node.fills];
  if (!Array.isArray(currentValue)) return;

  if (currentValue.length === 1) {
    const friendlyKey = resolveFriendlyKey(design, tokenPath, currentValue);
    design.globalVars.styles[friendlyKey] = currentValue;
    node.fills = friendlyKey;
    return;
  }

  const entry = currentValue[paintIndex];
  if (typeof entry === "string" && entry !== tokenPath) {
    (currentValue as unknown[])[paintIndex] = tokenPath;
  }
}

/** Drop a resolved binding; remove the whole record once every paint is resolved. */
function removeResolvedBinding(node: SimplifiedNode, paintIndex: number): void {
  if (!node.fillVariableIds) return;
  delete node.fillVariableIds[paintIndex];
  if (Object.keys(node.fillVariableIds).length === 0) {
    delete node.fillVariableIds;
  }
}

/**
 * Match a bound variable ID against a local color token map (full ID / bare ID
 * / local-id suffix — the map is pre-indexed under all three by
 * color-tokens-file.ts).
 */
function matchLocalTokenById(variableId: string, modeMap: ColorTokenMap): ColorToken | undefined {
  const direct = modeMap.byVariableId.get(variableId);
  if (direct) return direct;
  const bare = variableId.replace(/^VariableID:/, "");
  const suffix = bare.includes("/") ? bare.split("/").pop() : undefined;
  return suffix ? modeMap.byVariableId.get(suffix) : undefined;
}

function collectNodesWithFillVariables(nodes: SimplifiedNode[], out: SimplifiedNode[]): void {
  for (const node of nodes) {
    if (node.fillVariableIds) out.push(node);
    if (node.children) collectNodesWithFillVariables(node.children, out);
  }
}

/**
 * Pick a globalVars key for the resolved variable name, disambiguating with a
 * suffix if a different value is already registered under that name.
 */
function resolveFriendlyKey(
  design: SimplifiedDesign,
  variableName: string,
  value: unknown,
): string {
  const existing = design.globalVars.styles[variableName];
  if (!existing || JSON.stringify(existing) === JSON.stringify(value)) {
    return variableName;
  }
  return `${variableName} (variable)`;
}
