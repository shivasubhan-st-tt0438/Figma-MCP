import type { Component, ComponentSet } from "@figma/rest-api-spec";

export interface SimplifiedPropertyDefinition {
  type: string;
  defaultValue: boolean | string;
  /** For VARIANT properties: every value this property can take. */
  variantOptions?: string[];
}

export interface SimplifiedComponentDefinition {
  key: string;
  name: string;
  componentSetId?: string;
  propertyDefinitions?: Record<string, SimplifiedPropertyDefinition>;
  /**
   * Structured variant state parsed from Figma's "Prop=Value, Prop=Value"
   * component names (e.g. "Expanded=No, Auth=Yes" → { Expanded: "No",
   * Auth: "Yes" }). This is the variant that is actually rendered wherever
   * an instance references this component.
   */
  variantProperties?: Record<string, string>;
  /** True when the component lives in another (library) file, not this one. */
  remote?: boolean;
  /** Source library file name, resolved via the published-components API (see enrich-design.ts). */
  library?: string;
  /** True when `library` is Apple's macOS UI kit — the instance IS a stock AppKit control. */
  native?: boolean;
}

export interface SimplifiedComponentSetDefinition {
  key: string;
  name: string;
  description?: string;
  propertyDefinitions?: Record<string, SimplifiedPropertyDefinition>;
  /** True when the component set lives in another (library) file, not this one. */
  remote?: boolean;
  /** Source library file name, resolved via the published-components API (see enrich-design.ts). */
  library?: string;
  /** True when `library` is Apple's macOS UI kit — instances ARE stock AppKit controls. */
  native?: boolean;
}

/**
 * Strip the #nodeId suffix from Figma property names.
 * "On Sale#341:0" → "On Sale"
 */
export function stripPropertyNameSuffix(name: string): string {
  const hashIndex = name.indexOf("#");
  return hashIndex === -1 ? name : name.substring(0, hashIndex);
}

/**
 * Simplify componentPropertyDefinitions from the raw Figma format to a flat
 * Record of property name → default value. Extracts BOOLEAN, TEXT, and
 * VARIANT properties (VARIANT keeps its full option list so consumers know
 * every state the component can be in and which one is the default).
 */
export function simplifyPropertyDefinitions(
  definitions: Record<
    string,
    { type: string; defaultValue: boolean | string; variantOptions?: string[] }
  >,
): Record<string, SimplifiedPropertyDefinition> {
  const result: Record<string, SimplifiedPropertyDefinition> = {};
  for (const [name, def] of Object.entries(definitions)) {
    if (def.type === "BOOLEAN" || def.type === "TEXT" || def.type === "VARIANT") {
      result[stripPropertyNameSuffix(name)] = {
        type: def.type.toLowerCase(),
        defaultValue: def.defaultValue,
        ...(def.type === "VARIANT" && def.variantOptions
          ? { variantOptions: def.variantOptions }
          : {}),
      };
    }
  }
  return result;
}

/**
 * Simplify componentPropertyReferences from the raw Figma format.
 * Strips #nodeId suffixes from property names and renames "characters" key to "text"
 * to match SimplifiedNode's text field.
 * Only handles "visible" (BOOLEAN) and "characters" (TEXT) references for Phase 1.
 */
export function simplifyPropertyReferences(
  references: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(references)) {
    if (key === "visible" || key === "characters") {
      const outputKey = key === "characters" ? "text" : key;
      result[outputKey] = stripPropertyNameSuffix(value);
    }
  }
  return result;
}

/**
 * Simplify instance componentProperties from the verbose Figma format to a flat
 * Record of property name → value. Extracts BOOLEAN, TEXT, and VARIANT
 * properties — VARIANT values are the instance's currently-selected variant
 * state ("which variant is on"), which consumers need to pick the right
 * native control state.
 */
export function simplifyComponentProperties(
  properties: Record<string, { type: string; value: boolean | string }>,
): Record<string, boolean | string> {
  const result: Record<string, boolean | string> = {};
  for (const [name, prop] of Object.entries(properties)) {
    if (prop.type === "BOOLEAN" || prop.type === "TEXT" || prop.type === "VARIANT") {
      result[stripPropertyNameSuffix(name)] = prop.value;
    }
  }
  return result;
}

/**
 * Parse Figma's variant-encoding component names ("Expanded=No, Auth=Yes")
 * into a structured record. Returns undefined for names that don't follow the
 * variant convention (plain components not in a set).
 */
export function parseVariantName(name: string): Record<string, string> | undefined {
  const parts = name.split(",").map((p) => p.trim());
  const props: Record<string, string> = {};
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) return undefined;
    props[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return Object.keys(props).length > 0 ? props : undefined;
}

/**
 * Remove unnecessary component properties and convert to simplified format.
 */
export function simplifyComponents(
  aggregatedComponents: Record<string, Component>,
  propertyDefinitions?: Record<string, Record<string, SimplifiedPropertyDefinition>>,
): Record<string, SimplifiedComponentDefinition> {
  return Object.fromEntries(
    Object.entries(aggregatedComponents).map(([id, comp]) => [
      id,
      {
        key: comp.key,
        name: comp.name,
        componentSetId: comp.componentSetId,
        ...(comp.remote && { remote: true }),
        ...(propertyDefinitions?.[id] && {
          propertyDefinitions: propertyDefinitions[id],
        }),
      },
    ]),
  );
}

/**
 * Remove unnecessary component set properties and convert to simplified format.
 */
export function simplifyComponentSets(
  aggregatedComponentSets: Record<string, ComponentSet>,
  propertyDefinitions?: Record<string, Record<string, SimplifiedPropertyDefinition>>,
): Record<string, SimplifiedComponentSetDefinition> {
  return Object.fromEntries(
    Object.entries(aggregatedComponentSets).map(([id, set]) => [
      id,
      {
        key: set.key,
        name: set.name,
        description: set.description,
        ...(set.remote && { remote: true }),
        ...(propertyDefinitions?.[id] && {
          propertyDefinitions: propertyDefinitions[id],
        }),
      },
    ]),
  );
}
