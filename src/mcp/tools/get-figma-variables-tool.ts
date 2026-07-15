import { z } from "zod";
import type { FigmaService } from "~/services/figma.js";
import type {
  LocalVariable,
  LocalVariableCollection,
  RGBA,
  VariableAlias,
} from "@figma/rest-api-spec";

const parametersSchema = z.object({
  fileKey: z
    .string()
    .regex(/^[a-zA-Z0-9]+$/, "File key must be alphanumeric")
    .describe(
      "The key of the Figma file to fetch variables from, found in the URL like figma.com/(file|design)/<fileKey>/...",
    ),
  collectionName: z
    .string()
    .optional()
    .describe(
      "OPTIONAL. Filter to variables belonging to a single collection by name (e.g. 'Text Colors'). Omit to return all collections.",
    ),
});

export type GetFigmaVariablesParams = z.infer<typeof parametersSchema>;

/** Round an RGBA 0..1 channel to a 0..255 int. */
function to255(n: number): number {
  return Math.round(Math.max(0, Math.min(1, n)) * 255);
}

/** Convert a Figma RGBA variable value into both rgba() and #hex strings. */
function formatColor(color: RGBA): { rgba: string; hex: string; alphaPercent: string } {
  const r = to255(color.r);
  const g = to255(color.g);
  const b = to255(color.b);
  const a = Math.round(color.a * 100) / 100;
  const alphaPercent = `${Math.round(color.a * 100)}%`;
  return {
    rgba: `rgba(${r}, ${g}, ${b}, ${a})`,
    hex: `#${[r, g, b]
      .map((c) => c.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()}`,
    alphaPercent,
  };
}

function isRGBA(value: unknown): value is RGBA {
  return (
    typeof value === "object" &&
    value !== null &&
    "r" in value &&
    "g" in value &&
    "b" in value &&
    "a" in value
  );
}

function isVariableAlias(value: unknown): value is VariableAlias {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as VariableAlias).type === "VARIABLE_ALIAS"
  );
}

/**
 * Suggest a code-friendly identifier for a variable when the designer hasn't
 * configured one via Figma's codeSyntax.iOS field. Converts "Text/Secondary"
 * or "Text Colors/Secondary Label" into "textSecondaryLabel" (camelCase),
 * matching ZSAppearance.Color.* naming conventions in this codebase.
 */
function suggestCodeName(figmaName: string): string {
  const parts = figmaName
    .split(/[/\s_-]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts
    .map((p, i) => {
      const clean = p.replace(/[^a-zA-Z0-9]/g, "");
      if (!clean) return "";
      return i === 0
        ? clean.charAt(0).toLowerCase() + clean.slice(1)
        : clean.charAt(0).toUpperCase() + clean.slice(1);
    })
    .join("");
}

async function handler(params: GetFigmaVariablesParams, figmaService: FigmaService) {
  const { fileKey, collectionName } = parametersSchema.parse(params);
  const response = await figmaService.getVariables(fileKey);

  const collections = response.meta.variableCollections;
  const variables = response.meta.variables;

  const nameById = (id: string) => variables[id]?.name ?? id;

  const result: Record<string, unknown> = {};

  for (const [collectionId, collection] of Object.entries(collections) as [
    string,
    LocalVariableCollection,
  ][]) {
    if (collectionName && collection.name !== collectionName) continue;

    const modeNameById: Record<string, string> = {};
    for (const mode of collection.modes) {
      modeNameById[mode.modeId] = mode.name;
    }

    const collectionVariables = Object.values(variables).filter(
      (v): v is LocalVariable => v.variableCollectionId === collectionId,
    );

    const simplifiedVars = collectionVariables.map((v) => {
      const valuesByModeName: Record<string, unknown> = {};

      for (const [modeId, rawValue] of Object.entries(v.valuesByMode)) {
        const modeName = modeNameById[modeId] ?? modeId;

        if (isRGBA(rawValue)) {
          valuesByModeName[modeName] = formatColor(rawValue);
        } else if (isVariableAlias(rawValue)) {
          valuesByModeName[modeName] = { aliasOf: nameById(rawValue.id) };
        } else {
          valuesByModeName[modeName] = rawValue;
        }
      }

      return {
        name: v.name,
        // Prefer the designer-configured iOS code name (Figma's codeSyntax.iOS field);
        // fall back to an auto-generated camelCase suggestion otherwise.
        codeName: v.codeSyntax?.iOS || suggestCodeName(v.name),
        resolvedType: v.resolvedType,
        valuesByMode: valuesByModeName,
      };
    });

    result[collection.name] = {
      modes: collection.modes.map((m) => m.name),
      defaultMode: modeNameById[collection.defaultModeId],
      variables: simplifiedVars,
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ fileKey, collections: result }, null, 2),
      },
    ],
  };
}

export const getFigmaVariablesTool = {
  name: "get_figma_variables",
  description:
    "Fetch named Figma Variables (design tokens) and their resolved values per mode (e.g. Light/Dark) for a file. " +
    "Unlike get_figma_data (which only resolves named Styles), this reads Figma's Variables API directly, giving you " +
    "the true variable name, per-mode color/number/string values, and a suggested code-friendly identifier " +
    "(codeName) for each — using the designer's configured iOS code syntax when available. " +
    "Requires a Figma token with the file_variables:read scope and a plan that supports Variables.",
  parametersSchema: parametersSchema.shape,
  handler,
};
