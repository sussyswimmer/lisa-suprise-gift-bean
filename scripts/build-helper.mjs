import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(
  /^host: (.+)$/m,
)?.[1];
const target = process.argv[2] ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? host;
const swiftTargets = {
  "aarch64-apple-darwin": "arm64-apple-macosx14.0",
  "x86_64-apple-darwin": "x86_64-apple-macosx14.0",
};
if (!swiftTargets[target])
  throw new Error(`Bean requires a macOS target; received ${target}`);
const output = join(root, `src-tauri/helpers/bean-claude-observer-${target}`);
execFileSync(
  "swiftc",
  [
    "-warnings-as-errors",
    "-O",
    "-target",
    swiftTargets[target],
    "-framework",
    "ApplicationServices",
    "-framework",
    "Foundation",
    "-framework",
    "AppKit",
    join(root, "src-tauri/helpers/bean-claude-observer/Sources/main.swift"),
    "-o",
    output,
  ],
  { stdio: "inherit" },
);
console.log(`Built ${output}`);
