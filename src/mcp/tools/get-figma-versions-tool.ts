import { z } from "zod";
import type { FigmaService } from "~/services/figma.js";

const parametersSchema = z.object({
  fileKey: z
    .string()
    .regex(/^[a-zA-Z0-9]+$/, "File key must be alphanumeric")
    .describe(
      "The key of the Figma file to fetch version history for, found in the URL like figma.com/(file|design)/<fileKey>/...",
    ),
});

export type GetFigmaVersionsParams = z.infer<typeof parametersSchema>;

async function handler(params: GetFigmaVersionsParams, figmaService: FigmaService) {
  const { fileKey } = parametersSchema.parse(params);
  const response = await figmaService.getVersionHistory(fileKey);

  const simplified = response.versions.map((v) => ({
    id: v.id,
    label: v.label ?? null,
    description: v.description ?? null,
    created_at: v.created_at,
    created_by: v.user?.handle ?? v.user?.id ?? "unknown",
    thumbnail_url: v.thumbnail_url ?? null,
  }));

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ fileKey, versions: simplified }, null, 2),
      },
    ],
  };
}

export const getFigmaVersionsTool = {
  name: "get_figma_versions",
  description:
    "Fetch the named version history of a Figma file. Returns each saved version's id, label, description, creation timestamp, creator, and thumbnail URL.",
  parametersSchema: parametersSchema.shape,
  handler,
};
