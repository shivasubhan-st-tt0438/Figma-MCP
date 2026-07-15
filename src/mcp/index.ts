import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FigmaService, type FigmaAuthOptions } from "../services/figma.js";
import { Logger } from "../utils/logger.js";
import { authMode, type AuthMode, type ClientInfo, type Transport } from "~/telemetry/index.js";
import type { OutputFormat } from "~/utils/serialize.js";
import { CONSUMPTION_GUIDE, PROJECT_DIRECTIVE } from "../services/enrich-design.js";
import { installValidationRejectCapture } from "./validation-capture.js";
import type { ToolExtra } from "./progress.js";
import {
  downloadFigmaImagesTool,
  getFigmaDataTool,
  writeImagesetTool,
  writeColorsetTool,
  getFigmaCommentsTool,
  getFigmaVersionsTool,
  getRenderUrlsTool,
  getFigmaVariablesTool,
  type DownloadImagesParams,
  type GetFigmaDataParams,
  type WriteImagesetToolParams,
  type WriteColorsetToolParams,
  type GetFigmaCommentsParams,
  type GetFigmaVersionsParams,
  type GetRenderUrlsParams,
  type GetFigmaVariablesParams,
} from "./tools/index.js";

const serverInfo = {
  name: "Figma MCP Server",
  version: process.env.NPM_PACKAGE_VERSION ?? "unknown",
  description:
    "Gives AI coding agents access to Figma design data, providing layout, styling, and content information for implementing designs.",
};

/**
 * Sent once during MCP session initialization (InitializeResult.instructions)
 * — the protocol's own channel for server-level guidance to the model,
 * distinct from a tool's per-call response. Client support for surfacing this
 * to the model varies, so it complements rather than replaces the same rules
 * embedded in every response's `guide` field (see addConsumptionGuide) —
 * that copy is what actually reaches the model on every client regardless of
 * whether the connecting client surfaces `instructions` at all.
 *
 * Baked in directly (CONSUMPTION_GUIDE + PROJECT_DIRECTIVE, both from
 * enrich-design.ts) rather than loaded from any external file: this fork is
 * handed out as a self-contained unit, so whoever receives it gets the full
 * directive with zero extra setup.
 */
const serverInstructions = [...CONSUMPTION_GUIDE, ...PROJECT_DIRECTIVE].join("\n\n");

type ServerTransport = Extract<Transport, "stdio" | "http">;

export type CreateServerOptions = {
  transport: ServerTransport;
  outputFormat?: OutputFormat;
  skipImageDownloads?: boolean;
  imageDir?: string;
  colorTokensDir?: string;
};

function createServer(
  authOptions: FigmaAuthOptions,
  {
    transport,
    outputFormat = "native-yaml",
    skipImageDownloads = false,
    imageDir,
    colorTokensDir,
  }: CreateServerOptions,
) {
  const server = new McpServer(serverInfo, { instructions: serverInstructions });
  const figmaService = new FigmaService(authOptions);
  const mode = authMode(authOptions);

  const getClientInfo = (): ClientInfo | undefined => {
    const info = server.server.getClientVersion();
    if (!info) return undefined;
    return { name: info.name, version: info.version };
  };

  registerTools(server, figmaService, {
    transport,
    authMode: mode,
    outputFormat,
    skipImageDownloads,
    imageDir,
    colorTokensDir,
    getClientInfo,
  });

  installValidationRejectCapture(server, {
    transport,
    authMode: mode,
    outputFormat,
    getClientInfo,
  });

  Logger.isHTTP = transport !== "stdio";

  return server;
}

type RegisterToolsOptions = {
  transport: ServerTransport;
  authMode: AuthMode;
  outputFormat: OutputFormat;
  skipImageDownloads: boolean;
  imageDir?: string;
  colorTokensDir?: string;
  getClientInfo: () => ClientInfo | undefined;
};

function registerTools(
  server: McpServer,
  figmaService: FigmaService,
  options: RegisterToolsOptions,
): void {
  server.registerTool(
    getFigmaDataTool.name,
    {
      title: "Get Figma Data",
      description: getFigmaDataTool.description,
      inputSchema: getFigmaDataTool.parametersSchema,
      annotations: { readOnlyHint: true },
    },
    (params: GetFigmaDataParams, extra: ToolExtra) =>
      getFigmaDataTool.handler(
        params,
        figmaService,
        options.outputFormat,
        options.transport,
        options.authMode,
        options.getClientInfo(),
        extra,
        options.colorTokensDir,
        options.imageDir,
      ),
  );

  server.registerTool(
    getFigmaCommentsTool.name,
    {
      title: "Get Figma Comments",
      description: getFigmaCommentsTool.description,
      inputSchema: getFigmaCommentsTool.parametersSchema,
      annotations: { readOnlyHint: true },
    },
    (params: GetFigmaCommentsParams) => getFigmaCommentsTool.handler(params, figmaService),
  );

  server.registerTool(
    getFigmaVersionsTool.name,
    {
      title: "Get Figma Version History",
      description: getFigmaVersionsTool.description,
      inputSchema: getFigmaVersionsTool.parametersSchema,
      annotations: { readOnlyHint: true },
    },
    (params: GetFigmaVersionsParams) => getFigmaVersionsTool.handler(params, figmaService),
  );

  server.registerTool(
    getRenderUrlsTool.name,
    {
      title: "Get Render URLs",
      description: getRenderUrlsTool.description,
      inputSchema: getRenderUrlsTool.parametersSchema,
      annotations: { readOnlyHint: true },
    },
    (params: GetRenderUrlsParams) => getRenderUrlsTool.handler(params, figmaService),
  );

  server.registerTool(
    getFigmaVariablesTool.name,
    {
      title: "Get Figma Variables",
      description: getFigmaVariablesTool.description,
      inputSchema: getFigmaVariablesTool.parametersSchema,
      annotations: { readOnlyHint: true },
    },
    (params: GetFigmaVariablesParams) => getFigmaVariablesTool.handler(params, figmaService),
  );

  if (!options.skipImageDownloads) {
    server.registerTool(
      downloadFigmaImagesTool.name,
      {
        title: "Download Figma Images",
        description: downloadFigmaImagesTool.getDescription(options.imageDir),
        inputSchema: downloadFigmaImagesTool.parametersSchema,
        annotations: { openWorldHint: true },
      },
      (params: DownloadImagesParams, extra: ToolExtra) =>
        downloadFigmaImagesTool.handler(
          params,
          figmaService,
          options.imageDir,
          options.transport,
          options.authMode,
          options.getClientInfo(),
          extra,
        ),
    );

    server.registerTool(
      writeImagesetTool.name,
      {
        title: "Write Imageset",
        description: writeImagesetTool.description,
        inputSchema: writeImagesetTool.parametersSchema,
        annotations: { openWorldHint: true },
      },
      (params: WriteImagesetToolParams, extra: ToolExtra) =>
        writeImagesetTool.handler(params, figmaService, extra),
    );

    server.registerTool(
      writeColorsetTool.name,
      {
        title: "Write Colorset",
        description: writeColorsetTool.description,
        inputSchema: writeColorsetTool.parametersSchema,
        annotations: { openWorldHint: true },
      },
      (params: WriteColorsetToolParams, extra: ToolExtra) =>
        writeColorsetTool.handler(params, extra),
    );
  }
}

export { createServer };
