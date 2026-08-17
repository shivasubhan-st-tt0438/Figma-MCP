import { FigmaService } from "~/services/figma.js";
import { getFigmaData } from "~/services/get-figma-data.js";
import { loadEnvFile, resolveAuth } from "~/config.js";

async function count(label: string, input: Parameters<typeof getFigmaData>[1]) {
  const service = new FigmaService(resolveAuth({}));
  const r = await getFigmaData(service, input, "native-yaml", {});
  const matchLine = r.formatted.match(/^# (\d+) node\(s\) matched/m);
  console.log(
    label,
    "->",
    matchLine ? matchLine[1] + " matches" : "no listing (single match / full tree)",
  );
}

async function main() {
  loadEnvFile("/Users/shiva-25006/Documents/figma/native/Figma-MCP/.env");
  await count('find="Frame 75" WITH nodeId=3096:98803 (scoped, what I did)', {
    fileKey: "mSMqUPli1vRG6hVzU8xR9m",
    nodeId: "3096:98803",
    find: "Frame 75",
  });
  await count('find="Frame 75" with NO nodeId (whole FILE)', {
    fileKey: "mSMqUPli1vRG6hVzU8xR9m",
    find: "Frame 75",
  });
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
