import { z } from "zod";
import type { FigmaService } from "~/services/figma.js";

const parametersSchema = z.object({
  fileKey: z
    .string()
    .regex(/^[a-zA-Z0-9]+$/, "File key must be alphanumeric")
    .describe(
      "The key of the Figma file to fetch comments for, found in the URL like figma.com/(file|design)/<fileKey>/...",
    ),
});

export type GetFigmaCommentsParams = z.infer<typeof parametersSchema>;

async function handler(params: GetFigmaCommentsParams, figmaService: FigmaService) {
  const { fileKey } = parametersSchema.parse(params);
  const response = await figmaService.getComments(fileKey);

  const simplified = response.comments.map((c) => ({
    id: c.id,
    message: c.message,
    author: c.user?.handle ?? c.user?.id ?? "unknown",
    created_at: c.created_at,
    resolved_at: c.resolved_at ?? null,
    parent_id: c.parent_id ?? null,
    order_id: c.order_id ?? null,
    reactions:
      c.reactions?.map((r) => ({ emoji: r.emoji, user: r.user?.handle ?? r.user?.id })) ?? [],
    position: c.client_meta,
  }));

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ fileKey, comments: simplified }, null, 2),
      },
    ],
  };
}

export const getFigmaCommentsTool = {
  name: "get_figma_comments",
  description:
    "Fetch all comments and annotations left on a Figma file. Returns each comment's text, author, creation time, resolved status, reply threading (parent_id), and canvas position.",
  parametersSchema: parametersSchema.shape,
  handler,
};
