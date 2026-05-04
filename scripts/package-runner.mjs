#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const script = process.argv[2];
if (!script) {
  console.error("Usage: node scripts/package-runner.mjs <script>");
  process.exit(1);
}

const commandExists = (command) => {
  const probe = process.platform === "win32" ? "where" : "command";
  const args = process.platform === "win32" ? [command] : ["-v", command];
  return spawnSync(probe, args, { stdio: "ignore", shell: process.platform !== "win32" }).status === 0;
};

const packageManager = commandExists("pnpm") ? "pnpm" : "npm";
const result = spawnSync(packageManager, ["run", script], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
