import {
  applyNote,
  buildReturnedAssetPayload,
  type ReturnedAssetFile,
} from "~/utils/returned-asset.js";

export type WriteColorsetParams = {
  assetName: string;
  /** Light/universal color as hex: "#089949", "089949", or "#089949FF". */
  hex: string;
  /** Optional alpha 0..1 (overrides any alpha encoded in hex). Default 1. */
  alpha?: number;
  /** Optional dark-appearance color as hex. */
  darkHex?: string;
  darkAlpha?: number;
  /** Optional subfolder inside the catalog, becomes a path prefix. */
  group?: string;
};

export type WriteColorsetResult =
  | { status: "error"; message: string }
  | { status: "content"; payload: string; message: string };

type Rgba = { r: number; g: number; b: number; a: number };

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

/**
 * Format a Figma fill as an Xcode `.colorset` in the repo's exact srgb hex-byte
 * form, and return it for the client to write. Pure (no IO): the caller's
 * catalog lives on the client, so this only produces the Contents.json — see
 * returned-asset.ts for why the write moved client-side.
 *
 * The old server-side "reuse an existing matching colorset" scan is gone with
 * the write: the server can't see the client's catalog to dedupe. That's now
 * the client's job (see the returned note).
 */
export function writeColorset(params: WriteColorsetParams): WriteColorsetResult {
  const { assetName, hex, alpha, darkHex, darkAlpha, group } = params;

  let light: Rgba;
  try {
    light = parseHex(hex, alpha);
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
  }
  const dark = darkHex ? parseHex(darkHex, darkAlpha) : undefined;

  const folder = `${assetName}.colorset`;
  const rel = group ? `${group}/${folder}` : folder;
  const files: ReturnedAssetFile[] = [
    { path: `${rel}/Contents.json`, encoding: "utf8", content: buildContentsJson(light, dark) },
  ];

  const note = applyNote(
    `Xcode srgb hex-byte color format for ${hex}${dark ? ` (+ dark ${darkHex})` : ""} is already applied. ` +
      `Before adding, check whether a colorset with an identical color already exists in your catalog and reuse it instead of duplicating.`,
  );

  return {
    status: "content",
    payload: buildReturnedAssetPayload(rel, files, note),
    message: `Prepared ${folder} — write it into your .xcassets catalog (see payload).`,
  };
}
