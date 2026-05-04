#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = process.argv[2];
if (!script) {
  console.error("Usage: node scripts/package-runner.mjs <script>");
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const commandExists = (command) => {
  const probe = process.platform === "win32" ? "where" : "command";
  const args = process.platform === "win32" ? [command] : ["-v", command];
  return spawnSync(probe, args, {
    cwd: repoRoot,
    stdio: "ignore",
    shell: process.platform !== "win32",
  }).status === 0;
};

const packageManager = commandExists("pnpm") ? "pnpm" : "npm";
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const dependencies = {
  ...packageJson.dependencies,
  ...packageJson.devDependencies,
};

const missingDependencies = Object.keys(dependencies).filter((name) => {
  const packagePath = path.join(repoRoot, "node_modules", ...name.split("/"), "package.json");
  return !existsSync(packagePath);
});

if (missingDependencies.length > 0) {
  console.log(`Installing missing dependencies with ${packageManager}: ${missingDependencies.join(", ")}`);
  const install = spawnSync(packageManager, ["install"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (install.error) {
    console.error(install.error.message);
    process.exit(1);
  }

  if (install.status !== 0) {
    process.exit(install.status ?? 1);
  }
}

const result = spawnSync(packageManager, ["run", script], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
