#!/usr/bin/env node
// Approve the native build scripts the DSH web profile needs, in whichever key the
// installed pnpm actually reads.
//
//   node tools/pnpm-allow-builds.mjs <pnpm-workspace.yaml>
//
// This has moved twice. pnpm 9 read `pnpm.onlyBuiltDependencies` from package.json;
// pnpm 10 moved it to `onlyBuiltDependencies` in pnpm-workspace.yaml; pnpm 11 reads
// `allowBuilds` there as a map and, when it is missing, appends its own stub with
// "set this to true or false" placeholders and exits non-zero
// (ERR_PNPM_IGNORED_BUILDS) even though every package installed fine.
//
// So: write both keys, and repair the placeholder stub if pnpm already left one.
// Idempotent — running it twice changes nothing.
import fs from "node:fs";

const PACKAGES = ["cloudflared", "cpu-features", "node-pty", "ssh2"];
const file = process.argv[2];
if (!file) {
  console.error("usage: pnpm-allow-builds.mjs <pnpm-workspace.yaml>");
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error(`no such file: ${file}`);
  process.exit(0);
}

let text = fs.readFileSync(file, "utf8");
const before = text;

/** Drop a whole top-level block (`key:` plus its indented body). */
function stripBlock(source, key) {
  const lines = source.split("\n");
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    if (inBlock) {
      // The block ends at the next line that is neither indented nor blank.
      if (/^\s+\S/.test(line) || line.trim() === "") continue;
      inBlock = false;
    }
    if (new RegExp(`^${key}\\s*:`).test(line)) {
      inBlock = true;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

for (const key of ["allowBuilds", "onlyBuiltDependencies"]) text = stripBlock(text, key);
text = `${text.replace(/\n{3,}$/, "\n").replace(/\s+$/, "")}\n`;

text += `
# Native packages allowed to run their build scripts.
# pnpm 11 reads allowBuilds; pnpm 10 reads onlyBuiltDependencies; the same list in
# package.json's \`pnpm\` field is ignored by both. Without this pnpm exits non-zero
# with ERR_PNPM_IGNORED_BUILDS even when every package installed.
allowBuilds:
${PACKAGES.map((p) => `  ${p}: true`).join("\n")}

onlyBuiltDependencies:
${PACKAGES.map((p) => `  - ${p}`).join("\n")}
`;

if (text !== before) {
  fs.writeFileSync(file, text);
  console.log(`approved ${PACKAGES.length} native builds in ${file}`);
} else {
  console.log("build approvals already correct");
}
