import fs from "fs";
import path from "path";

/* eslint-disable @typescript-eslint/no-explicit-any -- logging accepts arbitrary values */
export const Logger = {
  isHTTP: false,
  log: (...args: any[]) => {
    if (Logger.isHTTP) {
      console.log("[INFO]", ...args);
    } else {
      console.error("[INFO]", ...args);
    }
  },
  error: (...args: any[]) => {
    console.error("[ERROR]", ...args);
  },
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Resolve where debug dumps (raw Figma API responses + the final serialized
 * output sent to the agent) are written, or `undefined` to write nothing.
 *
 * Opt-in and CWD-independent: set FIGMA_MCP_DEBUG_DIR to an ABSOLUTE path (the
 * server's CWD is the MCP client's workspace root, not this package, so a
 * relative path lands somewhere unexpected — that's why nothing appeared
 * before). NODE_ENV=development still works as a legacy trigger, targeting the
 * sibling `../docs` folder. Published/normal runs leave both unset and stay
 * silent. Read per-call (not once at import) so it's correct after dotenv loads
 * the --env file during server startup.
 */
function resolveDebugDir(): string | undefined {
  const explicit = process.env.FIGMA_MCP_DEBUG_DIR;
  if (explicit) return explicit;
  if (process.env.NODE_ENV === "development") return "../docs";
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- writes arbitrary debug data
export function writeLogs(name: string, value: any): void {
  const logsDir = resolveDebugDir();
  if (!logsDir) return;

  try {
    // Create the target if it doesn't exist — the previous accessSync-only
    // check silently no-op'd whenever the folder was missing.
    fs.mkdirSync(logsDir, { recursive: true });
    const logPath = path.join(logsDir, name);

    // A string is already-formatted output (e.g. the final YAML) — write it
    // verbatim. JSON.stringify-ing it would quote/escape the whole thing into
    // an unreadable one-liner instead of the readable file this is for.
    fs.writeFileSync(logPath, typeof value === "string" ? value : JSON.stringify(value, null, 2));
    Logger.log(`Debug log written to: ${logPath}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    Logger.log(`Failed to write logs to ${name}: ${errorMessage}`);
  }
}

/**
 * Turn a fileKey / nodeId into a filesystem-safe filename fragment so distinct
 * fetches produce distinct dump files instead of clobbering one shared name.
 * Compound instance ids (`I3096:91050;1907:3788`) and colons collapse to `_`.
 */
export function debugSlug(...parts: Array<string | undefined>): string {
  const joined = parts.filter(Boolean).join("-");
  const slug = joined.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "");
  return slug || "file";
}
