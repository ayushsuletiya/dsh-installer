#!/usr/bin/env node
// Re-apply the local model-picker patches to a freshly installed DSH.
//
//   node tools/patch-model-selector.mjs [--dsh-root <dir>] [--force]
//
// Two customizations live in the shipped client bundle of
// @deepseek-ai/dsh-client-ui-model-selection, so they are lost on every `npm i -g
// @deepseek-ai/dsh` upgrade and must be re-applied:
//
//   * model list search   — space-separated terms ANDed across provider name,
//                           model name, id and description
//   * collapsible groups  — each provider heading is a toggle, folded ids persist
//                           in localStorage, a non-empty search force-expands, and
//                           groups named "Others…" start folded
//
// Strategy, in order:
//   1. already patched (both markers present)      -> nothing to do
//   2. untouched file whose sha256 matches the      -> copy the pinned patched
//      pristine hash recorded for this version         bundle over it
//   3. anything else                                -> refuse and explain
//
// Refusing is deliberate. A half-applied patch to a built bundle produces a model
// picker that renders nothing, which is far worse than a picker without folding.
// Exit codes: 0 patched or already patched, 4 skipped (DSH itself still works).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const args = process.argv.slice(2);
const force = args.includes("--force");
const rootFlag = args.indexOf("--dsh-root");
const explicitRoot = rootFlag >= 0 ? args[rootFlag + 1] : null;

const MARKERS = ["local patch: model list search", "local patch: collapsible provider groups"];
const PKG = "@deepseek-ai/dsh-client-ui-model-selection";

const log = (...a) => console.log("[model-selector]", ...a);
const skip = (...a) => {
  console.warn("[model-selector]", ...a);
  process.exit(4);
};

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Locate the globally installed dsh package directory. */
function findDshRoot() {
  if (explicitRoot) return explicitRoot;
  if (process.env.DSH_INSTALL_ROOT) return process.env.DSH_INSTALL_ROOT;

  const candidates = [];
  const npmRoot = process.env.NPM_GLOBAL_ROOT;
  if (npmRoot) candidates.push(path.join(npmRoot, "@deepseek-ai", "dsh"));

  // node's own prefix is where a global install lands for nvm/fnm/volta alike.
  const execDir = path.dirname(process.execPath);
  candidates.push(
    path.resolve(execDir, "..", "lib", "node_modules", "@deepseek-ai", "dsh"),
    path.resolve(execDir, "node_modules", "@deepseek-ai", "dsh"),
    path.resolve(execDir, "..", "node_modules", "@deepseek-ai", "dsh"),
  );
  return candidates.find((p) => fs.existsSync(path.join(p, "package.json"))) || null;
}

const dshRoot = findDshRoot();
if (!dshRoot) skip("could not locate the installed @deepseek-ai/dsh package");

const target = path.join(dshRoot, "node_modules", PKG, "lib", "client.js");
if (!fs.existsSync(target)) skip(`no client bundle at ${target}`);

const pkgJson = path.join(dshRoot, "node_modules", PKG, "package.json");
const version = JSON.parse(fs.readFileSync(pkgJson, "utf8")).version;
log("found", PKG, version);

const current = fs.readFileSync(target);
const currentText = current.toString("utf8");
const applied = MARKERS.filter((m) => currentText.includes(m));

if (applied.length === MARKERS.length && !force) {
  log("already patched — nothing to do");
  process.exit(0);
}
if (applied.length && applied.length !== MARKERS.length) {
  skip(
    `bundle carries only ${applied.length}/${MARKERS.length} patch markers; refusing to touch a half-patched file`,
  );
}

const patchDir = path.join(repoRoot, "payload", "patches", "model-selection", version);
if (!fs.existsSync(patchDir)) {
  skip(
    `no pinned patch for ${PKG}@${version} (this installer ships ` +
      `${fs.readdirSync(path.join(repoRoot, "payload", "patches", "model-selection")).join(", ")}). ` +
      "The model picker will work without search/folding.",
  );
}

const expectPristine = fs.readFileSync(path.join(patchDir, "client.pristine.sha256"), "utf8").trim();
const actual = sha256(current);
if (actual !== expectPristine && !force) {
  skip(
    `bundle sha256 ${actual.slice(0, 12)}… does not match the pristine ${expectPristine.slice(0, 12)}… ` +
      "recorded for this version — it was modified elsewhere, so it is left alone.",
  );
}

const patched = fs.readFileSync(path.join(patchDir, "client.patched.js"));
fs.copyFileSync(target, `${target}.orig`);
fs.writeFileSync(target, patched);

const after = fs.readFileSync(target, "utf8");
const ok = MARKERS.every((m) => after.includes(m));
if (!ok) {
  fs.copyFileSync(`${target}.orig`, target);
  skip("verification failed after copy; original restored");
}

log(`patched (backup at ${path.basename(target)}.orig)`);
log("model picker now has search + collapsible provider groups");
