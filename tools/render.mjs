#!/usr/bin/env node
// Minimal, dependency-free template renderer for the DSH one-click installer.
//
//   node tools/render.mjs <template> <output>
//
// Substitutions come from the environment (every DSHX_* variable, minus the
// prefix). Two constructs are supported, both line-oriented so a broken
// template is obvious in a diff:
//
//   {{NAME}}                 -> the value of DSHX_NAME ("" when unset)
//   #if NAME ... #endif      -> keep the block only when DSHX_NAME is non-empty
//   #ifnot NAME ... #endif   -> keep the block only when DSHX_NAME is empty
//
// Conditional lines are consumed entirely, so the rendered file has no leftover
// directives. Unknown {{NAME}} placeholders are an error: a silently empty path
// is how you get a profile that loads a plugin from "/qwen-coder.mjs".
import fs from "node:fs";

const [templatePath, outPath] = process.argv.slice(2);
if (!templatePath || !outPath) {
  console.error("usage: render.mjs <template> <output>");
  process.exit(2);
}

const vars = new Map();
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith("DSHX_")) vars.set(key.slice(5), value ?? "");
}

const truthy = (name) => {
  const v = vars.get(name);
  return typeof v === "string" && v.trim() !== "" && v.trim() !== "0" && v.trim() !== "false";
};

const src = fs.readFileSync(templatePath, "utf8");
const out = [];
const stack = []; // { keep: boolean }
const missing = new Set();

for (const rawLine of src.split("\n")) {
  const directive = rawLine.trim();

  const ifMatch = /^#if\s+([A-Z0-9_]+)\s*$/.exec(directive);
  if (ifMatch) {
    const parentKeeps = stack.every((f) => f.keep);
    stack.push({ keep: parentKeeps && truthy(ifMatch[1]) });
    continue;
  }
  const ifnotMatch = /^#ifnot\s+([A-Z0-9_]+)\s*$/.exec(directive);
  if (ifnotMatch) {
    const parentKeeps = stack.every((f) => f.keep);
    stack.push({ keep: parentKeeps && !truthy(ifnotMatch[1]) });
    continue;
  }
  if (/^#endif\s*$/.test(directive)) {
    if (!stack.length) {
      console.error(`render: stray #endif in ${templatePath}`);
      process.exit(1);
    }
    stack.pop();
    continue;
  }

  if (stack.length && !stack.every((f) => f.keep)) continue;

  out.push(
    rawLine.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_all, name) => {
      if (!vars.has(name)) {
        missing.add(name);
        return "";
      }
      return vars.get(name);
    }),
  );
}

if (stack.length) {
  console.error(`render: ${stack.length} unclosed #if block(s) in ${templatePath}`);
  process.exit(1);
}
if (missing.size) {
  console.error(`render: no value for ${[...missing].join(", ")} (set DSHX_<NAME>)`);
  process.exit(1);
}

fs.writeFileSync(outPath, out.join("\n"), "utf8");
console.log(`rendered ${outPath}`);
