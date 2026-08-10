import { z } from "zod";
import { FigmaService } from "~/services/figma.js";
import { Logger } from "~/utils/logger.js";
import { sendProgress, startProgressHeartbeat, type ToolExtra } from "~/mcp/progress.js";
import {
  captureGetFigmaDataCall,
  type AuthMode,
  type ClientInfo,
  type Transport,
} from "~/telemetry/index.js";
import {
  getFigmaData as runGetFigmaData,
  getFigmaDataBatch as runGetFigmaDataBatch,
} from "~/services/get-figma-data.js";
import type { OutputFormat } from "~/utils/serialize.js";

const nodeIdSchema = z
  .string()
  .regex(
    /^I?\d+[:|-]\d+(?:;\d+[:|-]\d+)*$/,
    "Node ID must be like '1234:5678' or 'I5666:180910;1:10515;1:10336'",
  );

const fileKeySchema = z.string().regex(/^[a-zA-Z0-9]+$/, "File key must be alphanumeric");

// Deliberately permissive (not nodeIdSchema): focusNodeId accepts either a
// node id OR a plain layer/frame name (e.g. "Frame 1") as a fallback — see
// findFocusMatches in enrich-design.ts. A strict id-shaped regex here would
// reject the name form before it ever reached that fallback.
const focusNodeIdSchema = z.string().min(1);

const targetSchema = z.object({
  fileKey: fileKeySchema.describe(
    "The key of the Figma file to fetch, often found in a provided URL like figma.com/(file|design)/<fileKey>/...",
  ),
  nodeId: nodeIdSchema
    .optional()
    .describe(
      "The ID of the node to fetch. Use format '1234:5678', or 'I5666:180910;1:10515;1:10336' for a deeply nested instance node.",
    ),
  depth: z
    .number()
    .optional()
    .describe("OPTIONAL. Do NOT use unless explicitly requested by the user."),
  downloadIcons: z
    .boolean()
    .optional()
    .describe("Same as the top-level downloadIcons, scoped to this target."),
  focusNodeId: focusNodeIdSchema
    .optional()
    .describe("Same as the top-level focusNodeId, scoped to this target."),
});

const parameters = {
  fileKey: fileKeySchema
    .optional()
    .describe(
      "The key of the Figma file to fetch, often found in a provided URL like figma.com/(file|design)/<fileKey>/... Omit when passing `targets` instead.",
    ),
  nodeId: nodeIdSchema
    .optional()
    .describe(
      "The ID of the node to fetch, often found as URL parameter node-id=<nodeId>, always use if provided. Use format '1234:5678' for a standard node, or 'I5666:180910;1:10515;1:10336' for a deeply nested instance node (the semicolon-joined path represents the instance override chain — it's still a single node ID, not multiple nodes).",
    ),
  depth: z
    .number()
    .optional()
    .describe(
      "OPTIONAL. Do NOT use unless explicitly requested by the user. Controls how many levels deep to traverse the node tree.",
    ),
  downloadIcons: z
    .boolean()
    .optional()
    .describe(
      "Auto-download every icon (IMAGE-SVG node) in the fetched tree as a vector PDF into the server's image directory, and stamp iconFile (the saved filename) on each icon node in the response — no separate download_figma_images call needed per icon. Recommended whenever this fetch is for implementing or comparing UI, not for a quick structural read.",
    ),
  focusNodeId: focusNodeIdSchema
    .optional()
    .describe(
      "OPTIONAL. Scope the result to ONLY the subtree(s) matching this node id OR layer/frame name, dropping every sibling branch — use when you ALREADY KNOW the exact node id or name and the full tree is too big / blows the token budget. The Figma API can't fetch an instance-internal node on its own, so this prunes the built tree instead. Accepts the full instance-internal id ('I3096:91050;1907:3787', as it appears in a prior fetch's output), the bare local id ('1907:3787'), or the exact layer name ('Frame 1', case-insensitive — 'frame 1' matches too) — id is tried first, name is an exact-match fallback. Names aren't guaranteed unique: if several nodes share that name, ALL are kept as separate subtrees. If nothing matches, you get a candidate listing (like `find`) instead of the full tree. When you only have a rough/partial name, prefer `find`.",
    ),
  find: focusNodeIdSchema
    .optional()
    .describe(
      "OPTIONAL. DISCOVERY: locate a node by its exact NAME when you don't know its id — the right first step when a large node was given but you only want one part of it (e.g. fetch 'Table Style' out of a whole screen). Matches the WHOLE name, case-insensitively, not a substring or partial word — 'Frame 1' only matches a node literally named 'Frame 1', never 'Frame 15' or 'Frame 3465341'. If EXACTLY ONE node matches, the result is that node's full focused detail (as if you'd passed its id to focusNodeId) — one call, done. If ZERO or MANY match, the result is a compact candidate listing (id + name + type + path per hit), NOT the full tree, and NO further Figma API calls are spent — read it, then re-fetch with focusNodeId set to the id you want. Takes precedence over focusNodeId. downloadIcons applies only when a single match auto-focuses.",
    ),
  targets: z
    .array(targetSchema)
    .min(2)
    .optional()
    .describe(
      "Fetch MULTIPLE Figma links/nodes in ONE call instead of calling this tool once per link — use this whenever 2 or more Figma links/nodes need fetching together (e.g. several screens given in the same request). Each target still gets its own independent, complete result; the directive/guide text and any component-variant-reference data shared across targets are attached once (to the first target that needs them) instead of being repeated per target. Do not also pass the top-level fileKey/nodeId when using targets — use one or the other.",
    ),
};

// A plain z.object (not .refine()'d) — the MCP SDK derives the tool's
// published JSON Schema from this shape, and a ZodEffects wrapper (what
// .refine returns) doesn't round-trip through that conversion the same way.
// The fileKey/targets "exactly one of" rule is enforced in the handler
// instead, after parsing, where a validation failure is just a normal error.
const parametersSchema = z.object(parameters);
export type GetFigmaDataParams = z.infer<typeof parametersSchema>;

async function getFigmaData(
  params: GetFigmaDataParams,
  figmaService: FigmaService,
  outputFormat: OutputFormat,
  transport: Transport,
  authMode: AuthMode,
  clientInfo: ClientInfo | undefined,
  extra: ToolExtra,
  colorTokensDir?: string,
  pruneRejectedIcons?: boolean,
) {
  try {
    const parsed = parametersSchema.parse(params);
    const { nodeId: rawNodeId, depth, downloadIcons, focusNodeId, find, targets } = parsed;

    if (targets && targets.length > 0) {
      if (parsed.fileKey) {
        throw new Error("Provide either fileKey or targets, not both.");
      }
      Logger.log(`Fetching ${targets.length} Figma targets in one batched call`);

      const batchResult = await runGetFigmaDataBatch(
        figmaService,
        targets.map((t) => ({
          fileKey: t.fileKey,
          nodeId: t.nodeId?.replace(/-/g, ":"),
          depth: t.depth,
          downloadIcons: t.downloadIcons,
          focusNodeId: t.focusNodeId,
        })),
        outputFormat,
        {
          colorTokensDir,
          pruneRejectedIcons,
          onFetchStart: async () => {
            await sendProgress(extra, 0, 2, `Fetching ${targets.length} Figma targets`);
          },
          onSerializeStart: async () => {
            await sendProgress(extra, 1, 2, "Serializing batch results");
          },
        },
      );

      Logger.log(
        `Batch complete: ${batchResult.entries.filter((e) => !e.error).length}/${targets.length} targets succeeded`,
      );

      return {
        // flatMap: each target emits its design text, then (if any) its own icon
        // base64 payload as a separate content item — one target's icons stay
        // adjacent to that target's design.
        content: batchResult.entries.flatMap((entry) => {
          const header = `# Target: ${entry.fileKey}${entry.nodeId ? `/${entry.nodeId}` : ""}`;
          const text = entry.error
            ? `${header}\nError fetching this target: ${entry.error}`
            : `${header}\n${entry.formatted}`;
          const items = [{ type: "text" as const, text }];
          if (entry.iconsPayload) {
            items.push({
              type: "text" as const,
              text: `# Icons for ${entry.fileKey}${entry.nodeId ? `/${entry.nodeId}` : ""}\n${entry.iconsPayload}`,
            });
          }
          return items;
        }),
      };
    }

    if (!parsed.fileKey) {
      throw new Error("Provide either fileKey or targets.");
    }
    const fileKey = parsed.fileKey;

    // Replace - with : in nodeId for our query — Figma API expects :.
    // MCP-specific input quirk, so it lives here rather than in the shared core.
    const nodeId = rawNodeId?.replace(/-/g, ":");

    Logger.log(
      `Fetching ${depth ? `${depth} layers deep` : "all layers"} of ${
        nodeId ? `node ${nodeId} from file` : `full file`
      } ${fileKey}`,
    );

    let stopFetchHeartbeat: (() => Promise<void>) | undefined;
    let stopSimplifyHeartbeat: (() => Promise<void>) | undefined;

    const result = await runGetFigmaData(
      figmaService,
      { fileKey, nodeId, depth, downloadIcons, focusNodeId, find },
      outputFormat,
      {
        colorTokensDir,
        pruneRejectedIcons,
        onFetchStart: async () => {
          await sendProgress(extra, 0, 3, "Fetching design data from Figma API");
          stopFetchHeartbeat = startProgressHeartbeat(extra, "Waiting for Figma API response");
        },
        onFetchComplete: async () => {
          await stopFetchHeartbeat?.();
        },
        onSimplifyStart: async (progress) => {
          await sendProgress(extra, 1, 3, "Fetched design data, simplifying");
          stopSimplifyHeartbeat = startProgressHeartbeat(
            extra,
            () => `Simplifying design data (${progress.getNodeCount()} nodes processed)`,
          );
        },
        onSimplifyComplete: async () => {
          await stopSimplifyHeartbeat?.();
        },
        onSerializeStart: async () => {
          await sendProgress(extra, 2, 3, "Simplified design, serializing response");
        },
        onComplete: (outcome) =>
          captureGetFigmaDataCall(outcome, { transport, authMode, clientInfo }),
      },
    );

    Logger.log(`Successfully extracted data: ${result.metrics.simplifiedNodeCount} nodes`);
    Logger.log("Sending result to client");

    // Second content item carries the icon base64 payload (downloadIcons) —
    // kept separate from the design text so the tree the model reads stays lean.
    const content = [{ type: "text" as const, text: result.formatted }];
    if (result.iconsPayload) {
      content.push({ type: "text" as const, text: result.iconsPayload });
    }
    return { content };
  } catch (error) {
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    Logger.error(`Error fetching file ${params.fileKey}:`, message);
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Error fetching file: ${message}` }],
    };
  }
}

// Export tool configuration
export const getFigmaDataTool = {
  name: "get_figma_data",
  description:
    "Get comprehensive Figma file data including layout, content, visuals, and component information. " +
    "If 2 or more Figma links/nodes need fetching together (e.g. several screens given in the same " +
    "request), pass them all via the `targets` array in ONE call instead of calling this tool once per " +
    "link — see the `targets` parameter for why.",
  parametersSchema,
  handler: getFigmaData,
} as const;
