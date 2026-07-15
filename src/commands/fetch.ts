import { resolve as resolvePath } from "path";
import { type Command, command } from "cleye";
import {
  envStr,
  loadEnvFile,
  parseOutputFormat,
  resolveAuth,
  requireGlobalCredentials,
  UsageError,
} from "~/config.js";
import { FigmaService } from "~/services/figma.js";
import { parseFigmaUrl } from "~/utils/figma-url.js";
import { authMode, initTelemetry, captureGetFigmaDataCall, shutdown } from "~/telemetry/index.js";
import { getFigmaData } from "~/services/get-figma-data.js";
import type { OutputFormat } from "~/utils/serialize.js";

export const fetchCommand: Command = command(
  {
    name: "fetch",
    description: "Fetch simplified Figma data and print to stdout",
    parameters: ["[url]"],
    flags: {
      fileKey: {
        type: String,
        description: "Figma file key (overrides URL)",
      },
      nodeId: {
        type: String,
        description: "Node ID, format 1234:5678 (overrides URL)",
      },
      depth: {
        type: Number,
        description: "Tree traversal depth",
      },
      json: {
        type: Boolean,
        description:
          "Output native-json instead of native-yaml. Back-compat alias for --format=native-json.",
      },
      format: {
        type: String,
        description:
          "Output format: native-yaml (default, fully inlined — no globalVars indirection), native-json, yaml (legacy, globalVars-ref based), json, or tree (experimental).",
      },
      figmaApiKey: {
        type: String,
        description: "Figma API key",
      },
      figmaOauthToken: {
        type: String,
        description: "Figma OAuth token",
      },
      env: {
        type: String,
        description: "Path to .env file",
      },
      colorTokensDir: {
        type: String,
        description:
          "Directory containing DTCG color token JSON exports (e.g. Light.tokens.json, Dark.tokens.json) used to resolve Figma Variable-bound fills to friendly names before falling back to the live Variables API.",
      },
      downloadIcons: {
        type: Boolean,
        description:
          "Auto-download every icon (IMAGE-SVG node) in the fetched tree as a vector PDF into --image-dir, and stamp iconFile on each icon node in the output.",
      },
      imageDir: {
        type: String,
        description:
          "Base directory for icon PDFs when --download-icons is set. Defaults to the current working directory.",
      },
      noTelemetry: {
        type: Boolean,
        description: "Disable usage telemetry",
      },
    },
  },
  (argv) => {
    run(argv.flags, argv._)
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      })
      .finally(() => shutdown());
  },
);

async function run(
  flags: {
    fileKey?: string;
    nodeId?: string;
    depth?: number;
    json?: boolean;
    format?: string;
    figmaApiKey?: string;
    figmaOauthToken?: string;
    env?: string;
    colorTokensDir?: string;
    downloadIcons?: boolean;
    imageDir?: string;
    noTelemetry?: boolean;
  },
  positionals: string[],
) {
  const url = positionals[0];
  let fileKey = flags.fileKey;
  let nodeId = flags.nodeId;

  if (url) {
    try {
      const parsed = parseFigmaUrl(url);
      fileKey ??= parsed.fileKey;
      nodeId ??= parsed.nodeId;
    } catch (error) {
      if (!fileKey) throw error;
      // fileKey provided via flag — malformed URL is non-fatal
    }
  }

  if (!fileKey) {
    throw new UsageError("Either a Figma URL or --file-key is required");
  }

  loadEnvFile(flags.env);
  const auth = resolveAuth(flags);
  // The fetch CLI has no per-request credential channel (unlike HTTP mode).
  // Fail fast so the user gets an actionable error instead of an HTTP-shaped
  // one from `getAuthHeaders`.
  requireGlobalCredentials(auth);

  // Initialize telemetry only after input validation succeeds, so every
  // captured event corresponds to an actual fetch attempt (not a usage error).
  initTelemetry({
    optOut: flags.noTelemetry,
    immediateFlush: true,
    redactFromErrors: [auth.figmaApiKey, auth.figmaOAuthToken],
  });

  const mode = authMode(auth);
  const outputFormat: OutputFormat =
    parseOutputFormat(flags.format, "--format") ?? (flags.json ? "native-json" : "native-yaml");
  const colorTokensDirRaw = flags.colorTokensDir ?? envStr("FIGMA_COLOR_TOKENS_DIR");
  const colorTokensDir = colorTokensDirRaw ? resolvePath(colorTokensDirRaw) : undefined;
  const imageDir = resolvePath(flags.imageDir ?? envStr("IMAGE_DIR") ?? process.cwd());

  const result = await getFigmaData(
    new FigmaService(auth),
    { fileKey, nodeId, depth: flags.depth, downloadIcons: flags.downloadIcons },
    outputFormat,
    {
      onComplete: (outcome) =>
        captureGetFigmaDataCall(outcome, { transport: "cli", authMode: mode }),
      colorTokensDir,
      imageDir,
    },
  );
  console.log(result.formatted);
}
