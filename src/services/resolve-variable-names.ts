import type { LocalVariable } from "@figma/rest-api-spec";
import type {
  SimplifiedDesign,
  SimplifiedNode,
  ResolvedTokenInfo,
  StyleTypes,
} from "~/extractors/types.js";
import type { FigmaService } from "~/services/figma.js";
import type { ColorTokensByMode, ColorToken, ColorTokenMap } from "~/services/color-tokens-file.js";
import { slugifyPath } from "~/utils/slugify.js";
import { Logger } from "~/utils/logger.js";

/**
 * Parse a single solid paint entry (as stored in globalVars.styles fill
 * arrays) into {r,g,b,a} (0-255 channels, 0-1 alpha). Returns undefined for
 * gradients, images, or anything not a plain hex/rgba string — those can't be
 * matched against a color token file.
 */
function parseSolidPaint(
  entry: unknown,
): { r: number; g: number; b: number; a: number } | undefined {
  if (typeof entry !== "string") return undefined;

  if (entry.startsWith("#")) {
    const hex = entry.slice(1);
    if (hex.length !== 6) return undefined;
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: 1,
    };
  }

  const match = entry.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/);
  if (!match) return undefined;
  return {
    r: parseInt(match[1], 10),
    g: parseInt(match[2], 10),
    b: parseInt(match[3], 10),
    a: parseFloat(match[4]),
  };
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace(/^#/, "");
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

/** Prefer the qualified/detailed group variant over the plain base group when multiple tokens share the same color — e.g. "text_opaque_secondary" or "text_vibrant_secondary" over the less specific "text_secondary". */
function specificityScore(token: ColorToken): number {
  let score = token.path.length;
  if (!token.qualified) score += 1000; // heavily deprioritize the plain, less-detailed group
  return score;
}

/**
 * Find the best-matching color token for a resolved paint color, tolerating
 * small rounding differences (±1 per channel, ±0.01 alpha). When multiple
 * tokens share the exact same color, prefers the more detailed/qualified group name.
 */
function matchByColor(
  resolved: { r: number; g: number; b: number; a: number },
  tokens: ColorToken[],
): ColorToken | undefined {
  const candidates = tokens.filter((t) => {
    const rgb = hexToRgb(t.hex);
    return (
      Math.abs(rgb.r - resolved.r) <= 1 &&
      Math.abs(rgb.g - resolved.g) <= 1 &&
      Math.abs(rgb.b - resolved.b) <= 1 &&
      Math.abs(t.alpha - resolved.a) <= 0.01
    );
  });
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => specificityScore(a) - specificityScore(b));
  return candidates[0];
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
 * Record token metadata (per-mode values, themed flag, AppKit hint) under
 * globalVars.tokens so consumers can answer "semantic or static?" without
 * re-deriving it. themed=true means the token's value differs across
 * appearance modes and must map to a dynamic color, never a hardcoded hex.
 */
function recordTokenInfo(
  design: SimplifiedDesign,
  token: ColorToken,
  localTokens: ColorTokensByMode,
  appkitHints: Record<string, string>,
  approx: boolean,
): void {
  design.globalVars.tokens ??= {};
  const existing = design.globalVars.tokens[token.path];
  if (existing) {
    // An exact-ID resolution outranks an earlier color-match of the same
    // token — clear the approx flag rather than leaving a stale warning.
    if (!approx) delete existing.approx;
    return;
  }

  const values: Record<string, string> = {};
  for (const [mode, modeMap] of Object.entries(localTokens)) {
    const modeToken = modeMap.byVariableId.get(token.variableId);
    if (modeToken) values[mode] = tokenColorString(modeToken);
  }
  if (Object.keys(values).length === 0) values.value = tokenColorString(token);

  const distinct = new Set(Object.values(values));
  const info: ResolvedTokenInfo = {
    values,
    themed: distinct.size > 1,
  };
  const appkit = appkitHints[token.path];
  if (appkit) info.appkit = appkit;
  if (approx) info.approx = true;

  design.globalVars.tokens[token.path] = info;
}

/**
 * Post-processing pass: attempts to resolve fill paints bound to Figma
 * Variables (design tokens) into friendly names. Single-paint fills get their
 * auto-generated `fill_XXXXXX` globalVars key renamed to the token's full
 * snake_case group + leaf name (e.g. "text_opaque_secondary"); in multi-paint
 * fills the bound paint's color string is replaced with the token name in
 * place (the actual values stay available under `globalVars.tokens`).
 *
 * Resolution order, per bound paint (see `fillVariableIds`):
 * 1. Local color token files (DTCG JSON, all "*.tokens.json" in the
 *    configured directory) — matched first by exact variable ID, since that's
 *    unambiguous and free (no API call). If the ID isn't present in the local
 *    files, fall back to matching that paint's resolved color (hex + alpha),
 *    preferring the more detailed/qualified group name when multiple tokens
 *    share the same color (e.g. "text_opaque_secondary" over the plain
 *    "text_secondary") — this is a best-effort match, since two genuinely
 *    different semantic tokens can legitimately share an identical color AND
 *    the snapshot color itself can lag the variable's live value (library
 *    update not yet accepted). Color-matched tokens are therefore flagged
 *    `approx: true` in globalVars.tokens so consumers can tell them apart
 *    from exact-ID resolutions.
 * 2. The live Variables API for this file, if local files didn't resolve it —
 *    matched by exact ID only (see matchVariable). Silently skipped if it
 *    403s (missing `file_variables:read` scope, unsupported plan, etc.).
 * 3. Otherwise, left exactly as-is — the synthetic `fill_XXXXXX` name stays,
 *    and the entry remains in `fillVariableIds` as a diagnostic breadcrumb.
 */
export async function resolveVariableFillNames(
  design: SimplifiedDesign,
  figmaService: FigmaService,
  fileKey: string,
  localTokens: ColorTokensByMode = {},
  appkitHints: Record<string, string> = {},
): Promise<SimplifiedDesign> {
  const nodesWithVariableFills: SimplifiedNode[] = [];
  collectNodesWithFillVariables(design.nodes, nodesWithVariableFills);

  if (nodesWithVariableFills.length === 0) {
    return design;
  }

  const localTokenModes = Object.values(localTokens);
  const allLocalTokens = localTokenModes.flatMap((m) => m.all);

  const stillUnresolved: { node: SimplifiedNode; paintIndex: number; variableId: string }[] = [];

  // Pass 1: local token files (ID match, then per-paint color match) — no API call.
  for (const node of nodesWithVariableFills) {
    if (!node.fillVariableIds || !node.fills) continue;

    for (const [indexKey, variableId] of Object.entries(node.fillVariableIds)) {
      const paintIndex = Number(indexKey);
      const currentValue: StyleTypes | undefined = design.globalVars.styles[node.fills];
      const paintEntry: unknown = Array.isArray(currentValue)
        ? currentValue[paintIndex]
        : undefined;

      // Style values are shared via dedup: an earlier node bound to the same
      // (value, variable) pair may have already replaced this paint entry
      // with its token name. Recognize that as resolved instead of failing
      // the color parse and leaving a stale diagnostic binding behind.
      if (typeof paintEntry === "string" && design.globalVars.tokens?.[paintEntry]) {
        removeResolvedBinding(node, paintIndex);
        continue;
      }

      let matched: ColorToken | undefined;
      let matchedByColor = false;
      for (const modeMap of localTokenModes) {
        matched = matchLocalTokenById(variableId, modeMap);
        if (matched) break;
      }
      if (!matched) {
        const resolvedColor = parseSolidPaint(paintEntry);
        if (resolvedColor) {
          matched = matchByColor(resolvedColor, allLocalTokens);
          matchedByColor = matched !== undefined;
        }
      }

      if (matched) {
        applyTokenToPaint(design, node, paintIndex, matched.path);
        recordTokenInfo(design, matched, localTokens, appkitHints, matchedByColor);
        removeResolvedBinding(node, paintIndex);
      } else {
        stillUnresolved.push({ node, paintIndex, variableId });
      }
    }
  }

  if (stillUnresolved.length === 0) {
    return design;
  }

  // Pass 2: live Variables API, only for whatever local files couldn't resolve.
  let variablesById: Map<string, LocalVariable>;
  try {
    const response = await figmaService.getVariables(fileKey);
    variablesById = buildVariableLookup(response.meta.variables);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Logger.log(
      `Skipping live Variable API resolution for ${fileKey} (keeping auto-generated names for the rest): ${message}`,
    );
    return design;
  }

  for (const { node, paintIndex, variableId } of stillUnresolved) {
    if (!node.fills) continue;

    const variable = matchVariable(variableId, variablesById);
    if (!variable) continue;

    // Normalize live variable names ("❌ Text/Secondary") into the same
    // snake_case convention the local token files produce ("text_secondary"),
    // so consumers see one naming scheme regardless of resolution source.
    const friendly = slugifyPath(variable.name) || variable.name;
    applyTokenToPaint(design, node, paintIndex, friendly);
    recordLiveTokenInfo(design, friendly, variable, appkitHints);
    removeResolvedBinding(node, paintIndex);
  }

  return design;
}

/**
 * Record token metadata for a variable resolved via the live Variables API.
 * Per-mode values come from the variable's own valuesByMode when they are
 * plain colors (aliases and non-color values are skipped — the name is still
 * the valuable part).
 */
function recordLiveTokenInfo(
  design: SimplifiedDesign,
  tokenPath: string,
  variable: LocalVariable,
  appkitHints: Record<string, string>,
): void {
  design.globalVars.tokens ??= {};
  if (design.globalVars.tokens[tokenPath]) return;

  const values: Record<string, string> = {};
  for (const [modeId, value] of Object.entries(variable.valuesByMode ?? {})) {
    if (value && typeof value === "object" && "r" in value && "g" in value && "b" in value) {
      const c = value as { r: number; g: number; b: number; a?: number };
      const r = Math.round(c.r * 255);
      const g = Math.round(c.g * 255);
      const b = Math.round(c.b * 255);
      const a = Math.round((c.a ?? 1) * 1000) / 1000;
      values[modeId] =
        a >= 0.995
          ? `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0").toUpperCase()).join("")}`
          : `rgba(${r}, ${g}, ${b}, ${a})`;
    }
  }
  if (Object.keys(values).length === 0) return;

  const distinct = new Set(Object.values(values));
  const info: ResolvedTokenInfo = { values, themed: distinct.size > 1 };
  const appkit = appkitHints[tokenPath];
  if (appkit) info.appkit = appkit;
  design.globalVars.tokens[tokenPath] = info;
}

/**
 * Apply a resolved token name to one paint of a node's fill. Single-paint
 * fills keep the historical behavior of renaming the whole globalVars key;
 * multi-paint fills replace the bound paint's color string in place, which
 * keeps the other paints (gradients, overlays) untouched.
 *
 * Multi-paint values are shared via dedup, so the in-place replacement is
 * visible to every node referencing the same style — which is correct, since
 * an identical (value, binding) pair means the same design intent.
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
    // SimplifiedFill's string variants are hex/rgba template-literal types;
    // a resolved token name is intentionally neither — its color values live
    // under globalVars.tokens[tokenPath].
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
 * Match a bound variable ID against a local color token map. Same flexible
 * matching as matchVariable (full ID / bare ID / local-id suffix) since the
 * token map is pre-indexed under all three forms by color-tokens-file.ts.
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

/** Index variables by both their full local id and their raw id, for flexible matching. */
function buildVariableLookup(variables: Record<string, LocalVariable>): Map<string, LocalVariable> {
  const map = new Map<string, LocalVariable>();
  for (const [id, variable] of Object.entries(variables)) {
    map.set(id, variable);
    map.set(`VariableID:${id}`, variable);
  }
  return map;
}

/**
 * Match a bound variable ID against the file's Variables response. Imported/library
 * variables use the form "VariableID:<sourceHash>/<localId>" — try the full string
 * first, then fall back to just the local-id suffix after the last "/".
 */
function matchVariable(
  variableId: string,
  lookup: Map<string, LocalVariable>,
): LocalVariable | undefined {
  const direct = lookup.get(variableId);
  if (direct) return direct;

  const suffix = variableId.includes("/") ? variableId.split("/").pop() : undefined;
  if (suffix) {
    return lookup.get(suffix) ?? lookup.get(`VariableID:${suffix}`);
  }
  return undefined;
}

/**
 * Pick a globalVars key for the resolved variable name, disambiguating with
 * a suffix in case a different value is already registered under that name
 * (mirrors the existing named-Style disambiguation pattern used elsewhere).
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
