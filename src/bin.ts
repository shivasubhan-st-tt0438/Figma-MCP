#!/usr/bin/env node

import { cli } from "cleye";
import { getServerConfig, UsageError } from "./config.js";
import { startServer } from "./server.js";
import { fetchCommand } from "./commands/fetch.js";

const argv = cli({
  name: "figma-developer-mcp",
  version: process.env.NPM_PACKAGE_VERSION ?? "unknown",
  flags: {
    figmaApiKey: {
      type: String,
      description: "Figma API key (Personal Access Token)",
    },
    figmaOauthToken: {
      type: String,
      description: "Figma OAuth Bearer token",
    },
    env: {
      type: String,
      description: "Path to custom .env file to load environment variables from",
    },
    port: {
      type: Number,
      description: "Port to run the server on",
    },
    host: {
      type: String,
      description: "Host to run the server on",
    },
    json: {
      type: Boolean,
      description:
        "Output native-json instead of native-yaml. Back-compat alias for --format=native-json.",
    },
    format: {
      type: String,
      description:
        "Output format for design data: native-yaml (default, fully inlined styles + role tags, no globalVars indirection), native-json, yaml (legacy, globalVars-ref based), json, or tree (experimental compact format).",
    },
    skipImageDownloads: {
      type: Boolean,
      description: "Do not register the download_figma_images tool (skip image downloads)",
    },
    imageDir: {
      type: String,
      description:
        "Base directory for image downloads. The download tool will only write files within this directory. Defaults to the current working directory.",
    },
    proxy: {
      type: String,
      description:
        "HTTP proxy URL for networks that require a proxy (e.g. http://proxy:8080). Pass 'none' to ignore HTTP_PROXY/HTTPS_PROXY from the environment and connect directly.",
    },
    colorTokensDir: {
      type: String,
      description:
        "Directory containing DTCG color token JSON exports (e.g. Light.tokens.json, Dark.tokens.json) used to resolve Figma Variable-bound fills to friendly names before falling back to the live Variables API.",
    },
    stdio: {
      type: Boolean,
      description: "Run in stdio transport mode for MCP clients",
    },
    noTelemetry: {
      type: Boolean,
      description: "Disable usage telemetry (telemetry is on by default)",
    },
  },
  commands: [fetchCommand],
});

// Subcommand callbacks execute during cli() — only start the server when no subcommand ran.
if (!argv.command) {
  main().catch((error) => {
    if (error instanceof UsageError) {
      console.error(error.message);
    } else {
      console.error("Failed to start server:", error);
    }
    process.exit(1);
  });
}

async function main(): Promise<void> {
  // NODE_ENV=cli is a legacy backdoor for stdio mode
  const isStdio = argv.flags.stdio === true || process.env.NODE_ENV === "cli";
  const config = getServerConfig({ ...argv.flags, stdio: isStdio });
  await startServer(config);
}
