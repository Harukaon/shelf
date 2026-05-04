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

const packageManager = existsSync(path.join(repoRoot, "pnpm-lock.yaml"))
  ? "pnpm"
  : existsSync(path.join(repoRoot, "package-lock.json"))
    ? "npm"
    : commandExists("pnpm")
      ? "pnpm"
      : "npm";
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const dependencies = {
  ...packageJson.dependencies,
  ...packageJson.devDependencies,
};

const packagesToInstall = Object.entries(dependencies).filter(([name, versionRange]) => {
  const packagePath = path.join(repoRoot, "node_modules", ...name.split("/"), "package.json");
  if (!existsSync(packagePath)) {
    return true;
  }

  if (!/^\d+\.\d+\.\d+$/.test(versionRange)) {
    return false;
  }

  const installedPackage = JSON.parse(readFileSync(packagePath, "utf8"));
  return installedPackage.version !== versionRange;
});

if (packagesToInstall.length > 0) {
  console.log(`Installing dependencies with ${packageManager}: ${packagesToInstall.map(([name]) => name).join(", ")}`);
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
