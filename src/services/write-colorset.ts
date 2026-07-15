import fs from "fs";
import path from "path";
import { Logger } from "~/utils/logger.js";

export type WriteColorsetParams = {
  assetName: string;
  assetCatalogPath: string;
  /** Light/universal color as hex: "#089949", "089949", or "#089949FF". */
  hex: string;
  /** Optional alpha 0..1 (overrides any alpha encoded in hex). Default 1. */
  alpha?: number;
  /** Optional dark-appearance color as hex. */
  darkHex?: string;
  darkAlpha?: number;
  group?: string;
  /** Return an existing matching colorset instead of creating one. Default true. */
  reuse?: boolean;
  overwrite?: boolean;
};

export type WriteColorsetResult = {
  status: "written" | "reused" | "skipped-exists" | "error";
  name?: string;
  colorsetDir?: string;
  message: string;
};

type Rgba = { r: number; g: number; b: number; a: number };

/** Shape of an entry in an Xcode colorset's Contents.json "colors" array. Component
 * values are read via componentToByte, which accepts 0xNN hex, 0..1 float, or 0..255
 * int forms — whichever form the file (ours or a hand-authored one) happens to use. */
type XcodeColorEntry = {
  appearances?: Array<{ appearance: string; value: string }>;
  color?: {
    "color-space"?: string;
    components?: {
      red?: string | number;
      green?: string | number;
      blue?: string | number;
      alpha?: string | number;
    };
  };
};

function parseHex(hex: string, alphaOverride?: number): Rgba {
  let h = hex.trim().replace(/^#/, "");
  let a = 1;
  if (h.length === 8) {
    a = parseInt(h.slice(6, 8), 16) / 255;
    h = h.slice(0, 6);
  } else if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return { r, g, b, a: alphaOverride ?? a };
}

/** Parse a single Xcode color component (0xNN | 0..1 float | 0..255 int) to a 0..255 int. */
function componentToByte(v: string): number {
  const s = v.trim();
  if (s.startsWith("0x") || s.startsWith("0X")) return parseInt(s, 16);
  if (s.includes(".")) return Math.round(parseFloat(s) * 255);
  const n = parseInt(s, 10);
  return n; // already 0..255
}

function byteHex(n: number): string {
  return "0x" + n.toString(16).toUpperCase().padStart(2, "0");
}

function colorEntry(c: Rgba, dark = false) {
  const entry: Record<string, unknown> = {};
  if (dark) entry.appearances = [{ appearance: "luminosity", value: "dark" }];
  entry.color = {
    "color-space": "srgb",
    components: {
      alpha: c.a.toFixed(3),
      blue: byteHex(c.b),
      green: byteHex(c.g),
      red: byteHex(c.r),
    },
  };
  entry.idiom = "universal";
  return entry;
}

function buildContentsJson(light: Rgba, dark?: Rgba): string {
  const colors: unknown[] = [colorEntry(light)];
  if (dark) colors.push(colorEntry(dark, true));
  return JSON.stringify({ colors, info: { author: "xcode", version: 1 } }, null, 2) + "\n";
}

/** Read the universal (non-dark) color of a colorset, if parseable. */
function readUniversalColor(contentsPath: string): Rgba | undefined {
  try {
    const json = JSON.parse(fs.readFileSync(contentsPath, "utf8")) as {
      colors?: XcodeColorEntry[];
    };
    const colors: XcodeColorEntry[] = json.colors ?? [];
    const universal = colors.find((c) => !c.appearances) ?? colors[0];
    const comp = universal?.color?.components;
    if (!comp) return undefined;
    return {
      r: componentToByte(String(comp.red)),
      g: componentToByte(String(comp.green)),
      b: componentToByte(String(comp.blue)),
      a: parseFloat(String(comp.alpha ?? "1")),
    };
  } catch {
    return undefined;
  }
}

function colorsMatch(a: Rgba, b: Rgba): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && Math.abs(a.a - b.a) < 0.005;
}

function findExistingColorset(catalogDir: string, target: Rgba): string | undefined {
  const stack = [catalogDir];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name.endsWith(".colorset")) {
        const c = readUniversalColor(path.join(full, "Contents.json"));
        if (c && colorsMatch(c, target)) return entry.name.replace(/\.colorset$/, "");
      } else {
        stack.push(full);
      }
    }
  }
  return undefined;
}

/**
 * Map a Figma fill to an Xcode `.colorset`. Reuses an existing colorset whose
 * universal color matches (so we don't duplicate `primaryGreenColor` etc.),
 * otherwise creates a new one in the repo's exact srgb hex-byte format.
 */
export function writeColorset(params: WriteColorsetParams): WriteColorsetResult {
  const {
    assetName,
    assetCatalogPath,
    hex,
    alpha,
    darkHex,
    darkAlpha,
    group,
    reuse = true,
    overwrite = false,
  } = params;

  const catalogDir = path.resolve(assetCatalogPath);
  if (!catalogDir.endsWith(".xcassets")) {
    return {
      status: "error",
      message: `assetCatalogPath must point to a .xcassets directory: ${catalogDir}`,
    };
  }
  if (!fs.existsSync(catalogDir) || !fs.statSync(catalogDir).isDirectory()) {
    return { status: "error", message: `Asset catalog does not exist: ${catalogDir}` };
  }

  let light: Rgba;
  try {
    light = parseHex(hex, alpha);
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
  }
  const dark = darkHex ? parseHex(darkHex, darkAlpha) : undefined;

  if (reuse && !dark) {
    const existing = findExistingColorset(catalogDir, light);
    if (existing) {
      return {
        status: "reused",
        name: existing,
        message: `Reused existing colorset '${existing}' matching ${hex}`,
      };
    }
  }

  const groupDir = group ? path.join(catalogDir, group) : catalogDir;
  const colorsetDir = path.join(groupDir, `${assetName}.colorset`);
  if (!path.resolve(colorsetDir).startsWith(catalogDir + path.sep)) {
    return {
      status: "error",
      message: `Resolved colorset path escapes the catalog: ${colorsetDir}`,
    };
  }

  if (fs.existsSync(colorsetDir) && !overwrite) {
    return {
      status: "skipped-exists",
      name: assetName,
      colorsetDir,
      message: `Colorset already exists (pass overwrite to replace): ${colorsetDir}`,
    };
  }

  fs.mkdirSync(colorsetDir, { recursive: true });
  fs.writeFileSync(path.join(colorsetDir, "Contents.json"), buildContentsJson(light, dark), "utf8");

  Logger.log(`Wrote colorset ${assetName} → ${colorsetDir}`);
  return {
    status: "written",
    name: assetName,
    colorsetDir,
    message: `Wrote ${assetName}.colorset (${hex}) to ${colorsetDir}`,
  };
}
