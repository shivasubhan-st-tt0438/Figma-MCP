/**
 * The write_* tools used to write Xcode assets straight to disk. That only works
 * when the server shares a filesystem with the caller — i.e. stdio on the same
 * machine. Over HTTP (this server can be hosted for remote clients) the write
 * lands on the *host*, never the caller's Xcode project, and the catalog-exists
 * checks even fail outright for a path that doesn't exist server-side.
 *
 * So the tools no longer write. They return the exact files for the CLIENT to
 * write into its own catalog. That's the only design that's correct regardless
 * of where the server runs.
 */

/**
 * One file for the client to materialize, its `path` relative to the client's
 * `.xcassets` catalog directory. `utf8` files are written verbatim; `base64`
 * files (e.g. a binary vector PDF) must be decoded to bytes first — writing the
 * base64 text as-is produces a corrupt file.
 */
export type ReturnedAssetFile = {
  path: string;
  encoding: "utf8" | "base64";
  content: string;
};

/**
 * The `native/apply-figma-asset.sh` helper consumes exactly this shape: it reads
 * the JSON, joins each `path` onto a caller-supplied catalog dir, and writes
 * (decoding base64). The `note` is written for the LLM reading the tool result.
 */
export function buildReturnedAssetPayload(
  destination: string,
  files: ReturnedAssetFile[],
  note: string,
): string {
  return JSON.stringify({ action: "write-files", destination, files, note }, null, 2);
}

const DECODE_HINT =
  "save this JSON and run `native/apply-figma-asset.sh <your .xcassets dir> <payload.json>` " +
  "(it writes every file and decodes base64), OR write each file yourself: utf8 verbatim, " +
  "base64 decoded to binary first (never save the base64 text itself)";

/** Shared closing line for both tools' notes, so the apply path is stated once. */
export function applyNote(prefix: string): string {
  return (
    `${prefix} This server does not write to disk (it may be running remotely), so create these ` +
    `file(s) inside your app's .xcassets catalog at the given relative paths — ${DECODE_HINT}.`
  );
}
