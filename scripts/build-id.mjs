import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function addFiles(hash, directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      addFiles(hash, path);
    } else if (entry.isFile()) {
      hash.update(relative(root, path));
      hash.update("\0");
      hash.update(readFileSync(path));
      hash.update("\0");
    }
  }
}

// Both Vite invocations build one extension. Hash stable source inputs so the
// popup, service worker, and content script agree on the same build identity.
export function computeBuildId() {
  const hash = createHash("sha256");
  addFiles(hash, join(root, "src"));
  for (const name of ["scripts/build-id.mjs", "vite.config.ts", "vite.content.config.ts", "vite.bridge.config.ts", "manifest.chrome.json", "manifest.firefox.json"]) {
    hash.update(name);
    hash.update("\0");
    hash.update(readFileSync(join(root, name)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}
