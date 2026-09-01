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
// The answer is DECLINE, explicitly. These four bindings are optional extras and
// three of them need a C toolchain that a factory-fresh Mac or Windows box does not
// have — approving them makes `ssh2` run node-gyp, fail ("Failed to build optional
// crypto binding"), and take the whole ten-bundle install down with ELIFECYCLE.
// Declining is not the same as leaving the key out: an explicit `false` is the
// acknowledgement pnpm 11 wants, so it stops erroring and the install exits clean.
// A machine WITH a toolchain can flip these to true for the native fast paths.
// Idempotent — running it twice changes nothing.
import fs from "node:fs";

// Optional native bindings. false = do not run their build scripts; every one of
// them has a working pure-JS or download-on-demand fallback.
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
# Optional native bindings, explicitly DECLINED.
# pnpm 11 reads allowBuilds and treats a missing decision as an error
# (ERR_PNPM_IGNORED_BUILDS) even when every package installed. Three of these need a
# C toolchain a fresh Mac or Windows box does not have, and ssh2 in particular fails
# its optional crypto binding and takes the whole install down with it. Every one of
# them has a working fallback, so declining costs nothing.
# On a machine with a compiler, flip any of these to true for the native fast path.
allowBuilds:
${PACKAGES.map((p) => `  ${p}: false`).join("\n")}

# pnpm 10 read this key instead. Left empty for the same reason.
onlyBuiltDependencies: []
`;

if (text !== before) {
  fs.writeFileSync(file, text);
  console.log(`approved ${PACKAGES.length} native builds in ${file}`);
} else {
  console.log("build approvals already correct");
}
