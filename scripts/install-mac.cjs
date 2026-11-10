const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function installToApplications() {
  if (process.platform !== "darwin") {
    console.log("ℹ Skipping macOS /Applications installation (platform is not darwin).");
    return;
  }

  const src = path.resolve(__dirname, "../src-tauri/target/release/bundle/macos/PhysPy.app");
  const destDir = "/Applications";
  const destApp = path.join(destDir, "PhysPy.app");

  if (!fs.existsSync(src)) {
    console.warn(`⚠ PhysPy.app not found at: ${src}`);
    return;
  }

  try {
    console.log(`🚀 Installing PhysPy.app to ${destApp}...`);
    execSync(`rm -rf "${destApp}" && cp -R "${src}" "${destDir}/"`);
    try {
      execSync(`xattr -r -d com.apple.quarantine "${destApp}" 2>/dev/null || true`);
    } catch (_) {}
    console.log(`✅ PhysPy.app successfully installed to ${destApp}!`);
  } catch (err) {
    console.error(`❌ Failed to install PhysPy.app to ${destApp}:`, err.message);
  }
}

if (require.main === module) {
  installToApplications();
}

module.exports = { installToApplications };
