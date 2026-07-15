import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { Logger } from "~/utils/logger.js";

/**
 * Curated design-token → AppKit semantic color hints.
 *
 * Answers the consumer question: "which native color API does this design
 * token correspond to?" — a token that tracks the OS appearance must become
 * `NSColor.labelColor`-style semantic colors, not a hardcoded hex.
 *
 * Built-in defaults cover Apple-HIG-named tokens. The map can be extended
 * (or overridden) per project by dropping `appkit-map.json` into the same
 * directory as the DTCG color token exports (`--color-tokens-dir`).
 *
 * Component → native-control identification deliberately does NOT live here:
 * it is resolved from ground truth instead — the library file each component
 * was published from (see resolveComponentLibraries in enrich-design.ts). A
 * name-based table breaks the moment a designer renames a component; the
 * publishing library never lies.
 */

/** Token path (snake_case, as produced by color-tokens-file.ts) → AppKit color API. */
const DEFAULT_APPKIT_COLOR_HINTS: Record<string, string> = {
  // Text hierarchy — HIG label colors
  text_primary: "NSColor.labelColor",
  text_secondary: "NSColor.secondaryLabelColor",
  text_tertiary: "NSColor.tertiaryLabelColor",
  text_quaternary: "NSColor.quaternaryLabelColor",
  text_opaque_primary: "NSColor.labelColor",
  text_opaque_secondary: "NSColor.secondaryLabelColor",
  text_opaque_tertiary: "NSColor.tertiaryLabelColor",
  text_opaque_quaternary: "NSColor.quaternaryLabelColor",
  text_opaque_white: "NSColor.white",
  text_dark_primary: "NSColor.labelColor (dark appearance)",
  text_dark_secondary: "NSColor.secondaryLabelColor (dark appearance)",
  text_dark_tertiary: "NSColor.tertiaryLabelColor (dark appearance)",

  // Fields / fills
  fields_primary: "NSColor.textBackgroundColor",
  fills_primary: "NSColor.quaternaryLabelColor",

  // Materials — NSVisualEffectView, not flat colors
  materials_ultrathick: "NSVisualEffectView.Material.sheet (ultra thick)",
  materials_thick: "NSVisualEffectView.Material.sheet (thick)",
  materials_medium: "NSVisualEffectView.Material.sheet (medium)",
  materials_thin: "NSVisualEffectView.Material.sheet (thin)",
  materials_ultrathin: "NSVisualEffectView.Material.sheet (ultra thin)",
  material_ultra_thick: "NSVisualEffectView.Material.sheet (ultra thick)",
  material_thick: "NSVisualEffectView.Material.sheet (thick)",
  material_medium: "NSVisualEffectView.Material.sheet (medium)",
  material_thin: "NSVisualEffectView.Material.sheet (thin)",
  material_ultra_thin: "NSVisualEffectView.Material.sheet (ultra thin)",
  materials_controls_menu: "NSVisualEffectView.Material.menu",
  materials_controls_popover: "NSVisualEffectView.Material.popover",
  materials_controls_titlebar: "NSVisualEffectView.Material.titlebar",
  materials_controls_sidebar: "NSVisualEffectView.Material.sidebar",
  materials_controls_tooltip: "NSVisualEffectView.Material.toolTip",
  materials_controls_underwindowbackground: "NSVisualEffectView.Material.underWindowBackground",
  materials_controls_headerview: "NSVisualEffectView.Material.headerView",
  materials_controls_hud_dark: "NSVisualEffectView.Material.hudWindow",
  materials_controls_fullscreen_dark: "NSVisualEffectView.Material.fullScreenUI",

  // Accents — macOS system palette (light/dark values match NSColor.system*)
  accents_blue: "NSColor.systemBlue",
  accents_red: "NSColor.systemRed",
  accents_orange: "NSColor.systemOrange",
  accents_yellow: "NSColor.systemYellow",
  accents_green: "NSColor.systemGreen",
  accents_mint: "NSColor.systemMint",
  accents_teal: "NSColor.systemTeal",
  accents_cyan: "NSColor.systemCyan",
  accents_indigo: "NSColor.systemIndigo",
  accents_purple: "NSColor.systemPurple",
  accents_pink: "NSColor.systemPink",
  accents_brown: "NSColor.systemBrown",
  accents_gray: "NSColor.systemGray",
};

function loadJsonMap(dir: string | undefined, filename: string): Record<string, string> {
  if (!dir) return {};
  const path = join(dir, filename);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const entries = Object.entries(raw).filter(
      (pair): pair is [string, string] => typeof pair[1] === "string",
    );
    Logger.log(`Loaded ${entries.length} hint entries from ${path}`);
    return Object.fromEntries(entries);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Logger.log(`Failed to parse hint file ${path}: ${message}`);
    return {};
  }
}

/**
 * Token path → AppKit color hint. Project overrides in
 * `<colorTokensDir>/appkit-map.json` win over built-in defaults.
 */
export function loadAppkitColorHints(colorTokensDir: string | undefined): Record<string, string> {
  return { ...DEFAULT_APPKIT_COLOR_HINTS, ...loadJsonMap(colorTokensDir, "appkit-map.json") };
}
