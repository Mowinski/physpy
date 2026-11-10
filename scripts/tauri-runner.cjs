const { spawnSync } = require("child_process");
const path = require("path");
const { installToApplications } = require("./install-mac.cjs");

const args = process.argv.slice(2);
const cliPath = path.resolve(__dirname, "../node_modules/@tauri-apps/cli/tauri.js");

const res = spawnSync(process.execPath, [cliPath, ...args], {
  stdio: "inherit",
  env: process.env,
});

if (res.status === 0 && args.includes("build") && process.platform === "darwin") {
  console.log("\n📦 Build finished. Running auto-installer...");
  installToApplications();
}

process.exit(res.status ?? (res.error ? 1 : 0));
