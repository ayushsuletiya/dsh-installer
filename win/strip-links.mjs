#!/usr/bin/env node
// Remove every symlink / junction from a tree that is about to be zipped, and prove
// none is left.
//
//   node win/strip-links.mjs <dir> [--check]
//
// Why this exists, learned from a CI failure rather than a guess: dsh keeps a flat
// fallback directory at $DSH_HOME/profiles/node_modules holding ~200 symlinks that
// point at the ABSOLUTE path of the dsh install on that machine, and it rebuilds
// them at startup — but it refuses to start if it finds a real directory where one
// of its links should be:
//
//   Error: dsh: …\profiles\node_modules\@deepseek-ai\dsh exists and is not a
//   symlink; remove it so dsh can manage the link
//
// A zip cannot carry a Windows symlink faithfully, and Node's recursive copy turns
// one into a real directory, so a baked tree that includes those links produces
// exactly that error. The links are machine-specific anyway: shipping them is
// meaningless. Strip them, and let dsh heal the directory on first run.
//
// --check exits 1 if any link remains, so the build can refuse to package a tree
// that would fail on someone else's machine.
import fs from "node:fs";
import path from "node:path";

const [target, ...flags] = process.argv.slice(2);
if (!target) {
  console.error("usage: strip-links.mjs <dir> [--check]");
  process.exit(2);
}
const checkOnly = flags.includes("--check");

let removed = 0;
const found = [];

/** Walk without ever following a link: entries are classified before descending. */
function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      found.push(full);
      if (!checkOnly) {
        // rmSync on a link removes the link itself, never the target.
        try {
          fs.rmSync(full, { recursive: false, force: true });
          removed += 1;
        } catch {
          try {
            fs.unlinkSync(full);
            removed += 1;
          } catch {
            /* reported below by the check pass */
          }
        }
      }
      continue;
    }
    if (entry.isDirectory()) walk(full);
  }
}

walk(path.resolve(target));

if (checkOnly) {
  if (found.length) {
    console.error(`strip-links: ${found.length} link(s) still present:`);
    for (const f of found.slice(0, 10)) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log("strip-links: no symlinks or junctions in the tree");
  process.exit(0);
}

console.log(`strip-links: removed ${removed} link(s)`);
