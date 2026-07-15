import fs from "fs";
import path from "path";
import type { FigmaService } from "~/services/figma.js";
import { downloadFigmaImage } from "~/utils/common.js";
import { Logger } from "~/utils/logger.js";

export type WriteImagesetParams = {
  fileKey: string;
  nodeId: string;
  assetName: string;
  assetCatalogPath: string;
  group?: string;
  overwrite?: boolean;
};

export type WriteImagesetResult = {
  status: "written" | "skipped-exists" | "error";
  imagesetDir?: string;
  pdfPath?: string;
  message: string;
};

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
 * Download a Figma node as a vector **PDF** (native Figma export — no SVG→PDF
 * conversion, no Jimp) and write it as an Xcode `.imageset` into an existing
 * asset catalog, with a `Contents.json` in the repo's standard single-scale form.
 */
export async function writeImageset(
  figmaService: FigmaService,
  params: WriteImagesetParams,
): Promise<WriteImagesetResult> {
  const { fileKey, nodeId, assetName, assetCatalogPath, group, overwrite = false } = params;

  const catalogDir = path.resolve(assetCatalogPath);
  if (!catalogDir.endsWith(".xcassets")) {
    return {
      status: "error",
      message: `assetCatalogPath must point to a .xcassets directory: ${catalogDir}`,
    };
  }
  if (!fs.existsSync(catalogDir) || !fs.statSync(catalogDir).isDirectory()) {
    return { status: "error", message: `Asset catalog does not exist: ${catalogDir}` };
  }

  const groupDir = group ? path.join(catalogDir, group) : catalogDir;
  // Guard against path traversal in group/assetName.
  const imagesetDir = path.join(groupDir, `${assetName}.imageset`);
  if (!path.resolve(imagesetDir).startsWith(catalogDir + path.sep)) {
    return {
      status: "error",
      message: `Resolved imageset path escapes the catalog: ${imagesetDir}`,
    };
  }

  if (fs.existsSync(imagesetDir) && !overwrite) {
    return {
      status: "skipped-exists",
      imagesetDir,
      message: `Imageset already exists (pass overwrite to replace): ${imagesetDir}`,
    };
  }

  const urls = await figmaService.getNodeRenderUrls(fileKey, [nodeId], "pdf");
  const pdfUrl = urls[nodeId];
  if (!pdfUrl) {
    return { status: "error", message: `Figma returned no PDF render URL for node ${nodeId}` };
  }

  fs.mkdirSync(imagesetDir, { recursive: true });
  const pdfFileName = `${assetName}.pdf`;
  const pdfPath = await downloadFigmaImage(pdfFileName, imagesetDir, pdfUrl);
  fs.writeFileSync(path.join(imagesetDir, "Contents.json"), buildContentsJson(pdfFileName), "utf8");

  Logger.log(`Wrote imageset ${assetName} → ${imagesetDir}`);
  return {
    status: "written",
    imagesetDir,
    pdfPath,
    message: `Wrote ${assetName}.imageset (vector PDF) to ${imagesetDir}`,
  };
}
