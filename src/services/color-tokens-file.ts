import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { Logger } from "~/utils/logger.js";
import { slugify } from "~/utils/slugify.js";

/**
 * A single resolved color token, flattened from a nested DTCG
 * (Design Tokens Community Group) JSON export — the format produced when
 * exporting Figma Variable collections (e.g. via Figma's built-in variable
 * export, or plugins like "Tokens Studio").
 */
export type ColorToken = {
  /** Full snake_case group + leaf name, e.g. "text_opaque_secondary" or "text_vibrant_secondary" */
  path: string;
  /**
   * True when the token's group carries an explicit qualifier (e.g. "Text - Opaque",
   * "Text - Vibrant (...)") rather than being the plain base group (e.g. "Text").
   * Used by resolve-variable-names.ts to avoid collapsing distinct qualified
   * variants down to the plain name when they share an identical color.
   */
  qualified: boolean;
  /** Figma's own variable ID, from the $extensions."com.figma.variableId" field */
  variableId: string;
  hex: string;
  alpha: number;
};

/** Parsed color tokens for one mode (e.g. "Light" or "Dark"), indexed two ways. */
export type ColorTokenMap = {
  /** variableId (e.g. "VariableID:207:14853" or bare "207:14853") -> token */
  byVariableId: Map<string, ColorToken>;
  /** all tokens, for hex+alpha fallback matching */
  all: ColorToken[];
};

type DTCGValue = {
  colorSpace?: string;
  components?: number[];
  alpha?: number;
  hex?: string;
};

type DTCGNode = {
  $type?: string;
  $value?: DTCGValue | string;
  $extensions?: { "com.figma.variableId"?: string };
  [key: string]: unknown;
};

/**
 * Recursively flatten a DTCG token JSON tree into a flat list of ColorTokens.
 * Skips non-color tokens (e.g. the "Mode" string token some exports include).
 */
function flatten(node: DTCGNode, pathParts: string[], out: ColorToken[]): void {
  if (node.$type === "color" && node.$value && typeof node.$value === "object") {
    const value = node.$value as DTCGValue;
    if (value.hex) {
      const variableId = node.$extensions?.["com.figma.variableId"] ?? "";
      // A group is "qualified" when its own name carries a " - " modifier
      // suffix (e.g. "Text - Opaque", "Text - Vibrant (...)") rather than
      // being the plain base group (e.g. "Text"). Only ancestor groups count
      // — the leaf name itself (last part) is excluded.
      const qualified = pathParts.slice(0, -1).some((part) => part.includes(" - "));
      out.push({
        path: pathParts.map(slugify).filter(Boolean).join("_"),
        qualified,
        variableId,
        hex: value.hex.toUpperCase(),
        alpha: value.alpha ?? 1,
      });
    }
    return;
  }
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith("$")) continue;
    if (child && typeof child === "object") {
      flatten(child as DTCGNode, [...pathParts, key], out);
    }
  }
}

function buildMap(tokens: ColorToken[]): ColorTokenMap {
  const byVariableId = new Map<string, ColorToken>();
  for (const token of tokens) {
    if (!token.variableId) continue;
    byVariableId.set(token.variableId, token);
    // Also index by the bare id (without "VariableID:" prefix) and by just the
    // local-id suffix after the last "/", to match the various ID shapes seen
    // in bound-variable references (see resolve-variable-names.ts).
    const bare = token.variableId.replace(/^VariableID:/, "");
    byVariableId.set(bare, token);
    const suffix = bare.includes("/") ? bare.split("/").pop() : undefined;
    if (suffix) byVariableId.set(suffix, token);
  }
  return { byVariableId, all: tokens };
}

function loadOneFile(path: string): ColorTokenMap | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as DTCGNode;
    const tokens: ColorToken[] = [];
    flatten(raw, [], tokens);
    return buildMap(tokens);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Logger.log(`Failed to parse color token file ${path}: ${message}`);
    return undefined;
  }
}

export type ColorTokensByMode = Record<string, ColorTokenMap>;

/**
 * Load all "*.tokens.json" files from a directory (DTCG format, one file per
 * mode — e.g. "Light.tokens.json", "Dark.tokens.json"). The mode name is
 * derived from the filename (case-insensitive, ".tokens.json" stripped).
 * Missing directory/files are handled gracefully — returns an empty object,
 * letting callers fall back to their existing behavior.
 */
export function loadColorTokensDir(dir: string | undefined): ColorTokensByMode {
  if (!dir || !existsSync(dir)) return {};

  // Every "*.tokens.json" in the directory is loaded — not just Light/Dark.
  // Figma libraries often have several variable collections (base palette,
  // semantic aliases, per-surface collections); a hardcoded filename list
  // silently drops all but two of them, leaving their variable IDs
  // unresolvable.
  const candidates = readdirSync(dir).filter((f) => /\.tokens\.json$/i.test(f));
  const result: ColorTokensByMode = {};

  for (const filename of candidates) {
    const path = join(dir, filename);
    const map = loadOneFile(path);
    if (map) {
      const modeName = filename.replace(/\.tokens\.json$/i, "");
      result[modeName] = map;
      Logger.log(`Loaded ${map.all.length} color tokens from ${path}`);
    }
  }

  return result;
}
