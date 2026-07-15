import type { SerializableDesign } from "./serializable-design.js";
import { dumpYaml } from "./yaml-dump.js";
import type { SimplifiedNode, StyleTypes, ResolvedTokenInfo } from "~/extractors/types.js";

/**
 * "native-json" / "native-yaml" output formats.
 *
 * The stock yaml/json formats keep every layout/fill/effect value hoisted into
 * `globalVars.styles` and reference it by id (e.g. `layout: "layout_75F81M"`).
 * That dedup is great for token budget but terrible for a native (AppKit)
 * consumer: padding/alignment/fixed-size live on the *parent* behind a ref, so
 * reading a node in isolation loses them — which is exactly how earlier reads
 * dropped the 20px container padding and the 74px right-aligned labels.
 *
 * The native formats fully **inline** every style ref onto its node and tag
 * each node with a coarse `role` (container/label/field/button/icon/popup/
 * image) so the consumer can map a Figma layer to a concrete `NS*` control /
 * asset / string. Design-token fills are inlined as full token objects
 * ({ token, values, themed, appkit }) so nothing requires a lookup elsewhere
 * in the document. Names and types are always preserved on every node.
 *
 * native-yaml is the same structure serialized as YAML — the preferred form
 * for LLM consumers (sequential reading, no cross-document indirection).
 */

/** Style-bearing fields on a SimplifiedNode that hold a globalVars ref id. */
const STYLE_REF_FIELDS = ["layout", "fills", "styles", "strokes", "effects", "textStyle"] as const;

/** A design-token fill inlined with everything a consumer needs in place. */
type InlineToken = { token: string } & ResolvedTokenInfo;

type NativeNode = Omit<SimplifiedNode, (typeof STYLE_REF_FIELDS)[number] | "children"> & {
  role: string;
  layout?: StyleTypes;
  fills?: StyleTypes | InlineToken | (unknown | InlineToken)[];
  styles?: StyleTypes;
  strokes?: StyleTypes | InlineToken | (unknown | InlineToken)[];
  effects?: StyleTypes;
  textStyle?: StyleTypes;
  children?: NativeNode[];
};

/**
 * Classify a node into a coarse role from its Figma type + layer name. Kept
 * deliberately simple and name-driven; the consumer refines from there.
 */
function classifyRole(node: SimplifiedNode): string {
  const name = node.name?.toLowerCase() ?? "";
  const type = node.type?.toUpperCase() ?? "";

  if (type === "TEXT") {
    if (/(field|input|placeholder|textbox|text field)/.test(name)) return "field";
    return "label";
  }
  if (type === "IMAGE-SVG" || type === "VECTOR" || /(icon|vector|glyph|logo)/.test(name)) {
    return "icon";
  }
  if (/(button|btn|\bcta\b)/.test(name)) return "button";
  if (/(dropdown|popup|pop up|select|combobox|menu)/.test(name)) return "popup";
  if (/(field|input|textfield|text field)/.test(name)) return "field";
  if (/(checkbox|check box)/.test(name)) return "checkbox";
  if (/(toggle|switch)/.test(name)) return "toggle";
  if (type === "INSTANCE" || type === "COMPONENT") return "component";
  if (type === "FRAME" || type === "GROUP") return "container";
  return type.toLowerCase() || "node";
}

function inlineNode(
  node: SimplifiedNode,
  styles: Record<string, StyleTypes>,
  tokens: Record<string, ResolvedTokenInfo>,
): NativeNode {
  const { children, ...rest } = node;
  const out = { ...rest } as NativeNode;
  out.role = classifyRole(node);

  for (const field of STYLE_REF_FIELDS) {
    const ref = node[field];
    if (typeof ref !== "string") continue;

    // A fill ref that IS a resolved token name inlines as the full token
    // object — plain value inlining would silently drop the token identity
    // (and with it the themed/appkit guidance).
    if ((field === "fills" || field === "strokes") && ref in tokens) {
      out[field] = { token: ref, ...tokens[ref] };
      continue;
    }

    if (ref in styles) {
      const value = styles[ref];
      // Multi-paint fills can contain token names as entries (a bound solid
      // under a gradient) — expand those in place too.
      if ((field === "fills" || field === "strokes") && Array.isArray(value)) {
        out[field] = value.map((entry) =>
          typeof entry === "string" && entry in tokens
            ? ({ token: entry, ...tokens[entry] } as InlineToken)
            : entry,
        );
      } else {
        out[field] = value;
      }
    }
  }

  if (children && children.length > 0) {
    out.children = children.map((child) => inlineNode(child, styles, tokens));
  }
  return out;
}

/** Shared builder for both native output formats. */
function buildNativeDesign(design: SerializableDesign): unknown {
  const styles = design.globalVars?.styles ?? {};
  const tokens = design.globalVars?.tokens ?? {};
  return {
    metadata: design.metadata,
    nodes: design.nodes.map((node) => inlineNode(node, styles, tokens)),
  };
}

export function toNativeJson(design: SerializableDesign): string {
  return JSON.stringify(buildNativeDesign(design), null, 2);
}

export function toNativeYaml(design: SerializableDesign): string {
  return dumpYaml(buildNativeDesign(design));
}
