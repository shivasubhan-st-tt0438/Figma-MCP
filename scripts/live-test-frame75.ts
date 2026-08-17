import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import { FigmaService } from "~/services/figma.js";
import { getFigmaData } from "~/services/get-figma-data.js";
import { loadEnvFile, resolveAuth } from "~/config.js";

const ENV = "/Users/shiva-25006/Documents/figma/native/Figma-MCP/.env";
const OUT = "/Users/shiva-25006/Documents/figma/native/figma-assets/frame75-live";
const FILE = "mSMqUPli1vRG6hVzU8xR9m";
const NODE = "3096:98803";

async function main() {
  loadEnvFile(ENV);
  const service = new FigmaService(resolveAuth({}));

  mkdirSync(join(OUT, "icons"), { recursive: true });

  // "Frame 75" matches two nodes; focus the one under Sidepanel / Timeline
  // (references the IPU1YYFNFIV0CQpjLA5MYY / UI Content - macOS library).
  const FRAME75 = "I3096:98803;1907:3788;2149:31675";
  console.log(`Fetching ${FILE}/${NODE}, focus ${FRAME75}, downloadIcons...`);
  const result = await getFigmaData(
    service,
    { fileKey: FILE, nodeId: NODE, focusNodeId: FRAME75, downloadIcons: true },
    "native-yaml",
    {},
  );

  writeFileSync(join(OUT, "primary.yaml"), result.formatted);
  console.log(`primary.yaml: ${result.formatted.length} bytes`);

  if (result.variantsFormatted) {
    writeFileSync(join(OUT, "variants.yaml"), result.variantsFormatted);
    console.log(`variants.yaml: ${result.variantsFormatted.length} bytes`);
  } else {
    console.log("!! no variants document (find returned a listing?) — primary head:");
    console.log(result.formatted.slice(0, 600));
  }

  // Collect icon links (downloadIcons stamps iconUrl -> compacted to `icon`).
  const doc = yaml.load(result.formatted) as { nodes?: unknown[] };
  const links: { name: string; url: string }[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    const node = n as { name?: string; icon?: string; children?: unknown[] };
    if (typeof node.icon === "string" && node.icon.startsWith("http")) {
      links.push({ name: node.name ?? "icon", url: node.icon });
    }
    for (const c of node.children ?? []) walk(c);
  };
  for (const n of doc?.nodes ?? []) walk(n);
  writeFileSync(join(OUT, "icon-links.json"), JSON.stringify(links, null, 2));
  console.log(`icon links: ${links.length}`);

  // Download each icon PDF.
  let saved = 0;
  const seen = new Map<string, number>();
  for (const { name, url } of links) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.log(`  icon fetch failed ${name}: ${res.status}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const base = (name || "icon").replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 40);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      writeFileSync(join(OUT, "icons", `${base}${n ? `_${n}` : ""}.pdf`), buf);
      saved++;
    } catch (e) {
      console.log(`  icon error ${name}: ${String(e)}`);
    }
  }
  console.log(`downloaded icons: ${saved} -> ${join(OUT, "icons")}`);
  console.log(`\nDONE. Output in ${OUT}`);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
