// Matches emoji / pictographic markers used as group-name prefixes in Figma
// design-system names (e.g. the sparkle emoji before every variable
// collection group, or the cross-mark deprecation markers on styles).
const EMOJI_PATTERN = /[\u{1F000}-\u{1FFFF}☀-➿]/gu;
// Variation selectors (U+FE0F) and ZWJ (U+200D) combine with an adjacent base
// character rather than standing alone, so they're matched as plain
// alternatives here — not inside a character class — which is both what
// no-misleading-character-class wants and clearer to a reader: this strips
// the two codepoints outright, independent of whatever they were combining
// with, rather than asserting a "combined character" a class can't express.
// Written as explicit \u escapes rather than the literal invisible
// characters — an invisible codepoint sitting raw in source is exactly what
// Trojan-Source-style scanners (rightly) flag, escaped or not.
const COMBINING_MARKS = /\uFE0F|\u200D/g;

/**
 * Normalize a design-system name segment into a snake_case slug: drops
 * parenthetical descriptions (e.g. "(Blending Mode: Plus Lighter & Plus
 * Darker)"), strips emoji/variation-selector markers, and collapses any run
 * of non-alphanumeric characters into a single underscore.
 */
export function slugify(segment: string): string {
  return segment
    .replace(/\(.*?\)/g, " ")
    .replace(EMOJI_PATTERN, "")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Slugify a "/"-grouped design-system path (e.g. a "Text - Opaque/Primary"
 * group prefixed with a sparkle emoji) into "text_opaque_primary". Empty
 * segments (e.g. an all-emoji group) are dropped.
 */
export function slugifyPath(path: string): string {
  return path.split("/").map(slugify).filter(Boolean).join("_");
}
