import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { computeBuildId } from "./build-id.mjs";

const outputDir = path.resolve(process.argv[2] ?? "dist");
const manifestPath = path.join(outputDir, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const scripts = new Set(
  (manifest.content_scripts ?? []).flatMap((entry) => entry.js ?? []),
);
const expectedBuildId = computeBuildId();

if (scripts.size === 0) {
  throw new Error(`No classic content scripts are declared in ${manifestPath}`);
}

for (const script of scripts) {
  const scriptPath = path.join(outputDir, script);
  const source = await readFile(scriptPath, "utf8");
  try {
    // vm.Script parses classic-script grammar and rejects static import/export,
    // which would make Chrome reject this manifest entry at injection time.
    new vm.Script(source, { filename: scriptPath });
  } catch (error) {
    throw new Error(`Manifest content script is not a valid classic script: ${script}`, {
      cause: error,
    });
  }
  if (!source.includes(expectedBuildId)) {
    throw new Error(
      `Manifest content script does not contain this build's protocol ID: ${script}`,
    );
  }
}

console.log(
  `Verified ${scripts.size} classic content script(s) and build ID ${expectedBuildId} in ${outputDir}`,
);
