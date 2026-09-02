#!/usr/bin/env node
// Stamp an enrollment identity into a copy of the Windows installer — the same byte
// patch get.xovi.pro performs as it serves the file.
//
//   node win/stamp.mjs <in.exe> <out.exe> <base-url> <token>
//
// It exists so CI can test the binary a user actually downloads. Passing --base and
// --token on the command line instead would leave the stamped path — the one every
// real install takes, and the one a scheduled task depends on — untested.
//
// The slots are fixed width: the value is written over the '0' padding and
// terminated with a NUL, so the file length never changes. A Go string's length
// lives elsewhere in the image, so moving bytes would corrupt it.
import fs from "node:fs";

const [input, output, base, token] = process.argv.slice(2);
if (!input || !output || !base || !token) {
  console.error("usage: stamp.mjs <in.exe> <out.exe> <base-url> <token>");
  process.exit(2);
}

const SLOT_MIN_PADDING = 32;

/**
 * The slot is found by its padding run, not by the first match of the prefix: the Go
 * compiler also emits the bare prefix (the reader passes it as a literal) and may
 * share those bytes with the slot itself.
 */
function findSlot(buf, prefix) {
  for (let at = buf.indexOf(prefix); at >= 0; at = buf.indexOf(prefix, at + 1)) {
    const start = at + prefix.length;
    let end = start;
    while (end < buf.length && buf[end] === 0x30) end += 1;
    if (end - start >= SLOT_MIN_PADDING) return { start, end };
  }
  return null;
}

function stamp(buf, prefix, value) {
  const slot = findSlot(buf, prefix);
  if (!slot) throw new Error(`no unstamped ${prefix} slot (already stamped, or built without one)`);
  const bytes = Buffer.from(String(value), "utf8");
  if (bytes.length + 1 > slot.end - slot.start) {
    throw new Error(`${prefix} value needs ${bytes.length + 1} bytes, slot holds ${slot.end - slot.start}`);
  }
  bytes.copy(buf, slot.start);
  buf[slot.start + bytes.length] = 0x00;
  buf.fill(0x30, slot.start + bytes.length + 1, slot.end);
}

const buf = fs.readFileSync(input);
const before = buf.length;
stamp(buf, "DSHBASE=", base);
stamp(buf, "DSHTOKEN=", token);
if (buf.length !== before) throw new Error("the stamp changed the file length");
fs.writeFileSync(output, buf);
console.log(`stamped ${output}: base=${base} token=${token.slice(0, 4)}… (${buf.length} bytes, unchanged)`);
