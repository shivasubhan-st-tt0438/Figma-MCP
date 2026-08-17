import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import { FigmaService } from "~/services/figma.js";
import { getFigmaData } from "~/services/get-figma-data.js";
import { loadEnvFile, resolveAuth } from "~/config.js";

const ENV = "/Users/shiva-25006/Documents/figma/native/Figma-MCP/.env";
const OUT = process.argv[2];
const FILE = process.argv[3];
const NODE = process.argv[4];
const FIND = process.argv[5];

async function main() {
  if (!OUT || !FILE || !NODE) {
    console.error("usage: fetch-and-save.ts <out-dir> <fileKey> <nodeId> [find-name]");
    process.exit(1);
  }
  loadEnvFile(ENV);
  const service = new FigmaService(resolveAuth({}));
  mkdirSync(join(OUT, "icons"), { recursive: true });

  console.log(`Fetching ${FILE}/${NODE}${FIND ? `, find "${FIND}"` : ""}, downloadIcons...`);
  const result = await getFigmaData(
    service,
    { fileKey: FILE, nodeId: NODE, find: FIND, downloadIcons: true },
    "native-yaml",
    {},
  );

  writeFileSync(join(OUT, "primary.yaml"), result.formatted);
  console.log(`primary.yaml: ${result.formatted.length} bytes`);

  if (result.formatted.startsWith("# ") && result.formatted.includes("matched")) {
    console.log("!! candidate listing (find was ambiguous or missed) — not a full fetch:");
    console.log(result.formatted);
    return;
  }

  if (result.variantsFormatted) {
    writeFileSync(join(OUT, "variants.yaml"), result.variantsFormatted);
    console.log(`variants.yaml: ${result.variantsFormatted.length} bytes`);
  }

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
