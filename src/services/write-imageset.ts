import type { FigmaService } from "~/services/figma.js";
import {
  applyNote,
  buildReturnedAssetPayload,
  type ReturnedAssetFile,
} from "~/utils/returned-asset.js";

export type WriteImagesetParams = {
  fileKey: string;
  nodeId: string;
  assetName: string;
  /** Optional subfolder inside the catalog, becomes a path prefix. */
  group?: string;
};

export type WriteImagesetResult =
  | { status: "error"; message: string }
  | { status: "content"; payload: string; message: string };

/** Xcode single-scale, vector-PDF imageset (matches the dominant catalog format). */
function buildContentsJson(pdfFileName: string): string {
  return (
    JSON.stringify(
      {
        images: [{ filename: pdfFileName, idiom: "universal" }],
        info: { author: "xcode", version: 1 },
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * Export a Figma node as a vector **PDF** (native Figma export — no SVG→PDF
 * conversion, no Jimp) and return it, base64-encoded, as an Xcode `.imageset`
 * for the client to write. The bytes ride back over the already-open MCP
 * connection rather than the client fetching Figma's short-lived signed URL
 * itself — robust behind corporate proxies that would block a direct S3 pull,
 * and self-contained (no URL expiry). See returned-asset.ts for why the write
 * moved client-side.
 */
export async function writeImageset(
  figmaService: FigmaService,
  params: WriteImagesetParams,
): Promise<WriteImagesetResult> {
  const { fileKey, nodeId, assetName, group } = params;

  const urls = await figmaService.getNodeRenderUrls(fileKey, [nodeId], "pdf");
  const pdfUrl = urls[nodeId];
  if (!pdfUrl) {
    return { status: "error", message: `Figma returned no PDF render URL for node ${nodeId}` };
  }

  const res = await fetch(pdfUrl);
  if (!res.ok) {
    return {
      status: "error",
      message: `Failed to fetch PDF render (${res.status} ${res.statusText})`,
    };
  }
  const pdfBase64 = Buffer.from(await res.arrayBuffer()).toString("base64");

  const folder = `${assetName}.imageset`;
  const rel = group ? `${group}/${folder}` : folder;
  const pdfFileName = `${assetName}.pdf`;
  const files: ReturnedAssetFile[] = [
    { path: `${rel}/Contents.json`, encoding: "utf8", content: buildContentsJson(pdfFileName) },
    { path: `${rel}/${pdfFileName}`, encoding: "base64", content: pdfBase64 },
  ];

  const note = applyNote(
    `The ${pdfFileName} entry is Figma's native vector PDF (base64) — decode it to binary, never re-encode or rasterize it.`,
  );

  return {
    status: "content",
    payload: buildReturnedAssetPayload(rel, files, note),
    message: `Prepared ${folder} (vector PDF) — write it into your .xcassets catalog (see payload).`,
  };
}
