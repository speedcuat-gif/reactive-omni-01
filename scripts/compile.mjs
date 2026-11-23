// Compile all contracts with solc-js.
// Usage: node scripts/compile.mjs
// Writes artifacts/<Contract>.json { abi, bytecode } for every contract.
import fs from "node:fs";
import path from "node:path";
import solc from "solc";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACTS_DIR = path.join(ROOT, "contracts");
const LIB_DIR = path.join(ROOT, "lib", "src");
const OUT_DIR = path.join(ROOT, "artifacts");

function walk(dir, base) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.name.endsWith(".sol")) out.push(path.relative(base, full));
  }
  return out;
}

const sources = {};
// Project contracts, keyed by repo-relative path: contracts/Foo.sol
for (const rel of walk(CONTRACTS_DIR, ROOT)) {
  sources[rel.split(path.sep).join("/")] = {
    content: fs.readFileSync(path.join(ROOT, rel), "utf8"),
  };
}
// Reactive lib, keyed as @reactive/src/... so `import "@reactive/..."` resolves.
for (const rel of walk(LIB_DIR, LIB_DIR)) {
  const key = "@reactive/src/" + rel.split(path.sep).join("/");
  sources[key] = { content: fs.readFileSync(path.join(LIB_DIR, rel), "utf8") };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "shanghai",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
if (output.errors) {
  const fatal = output.errors.filter((e) => e.severity === "error");
  for (const e of output.errors) console.log(e.formattedMessage);
  if (fatal.length > 0) process.exit(1);
}

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
let count = 0;
for (const [file, contracts] of Object.entries(output.contracts)) {
  for (const [name, c] of Object.entries(contracts)) {
    if (!c.evm || !c.evm.bytecode || !c.evm.bytecode.object) continue;
    fs.writeFileSync(
      path.join(OUT_DIR, `${name}.json`),
      JSON.stringify(
        { contractName: name, source: file, abi: c.abi, bytecode: "0x" + c.evm.bytecode.object },
        null,
        2
      )
    );
    console.log(`compiled ${name} (${file}) — ${(c.evm.bytecode.object.length / 2 - 1).toLocaleString()} bytes`);
    count++;
  }
}
console.log(`wrote ${count} artifacts to artifacts/`);
