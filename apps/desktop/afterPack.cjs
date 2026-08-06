/*
 * Ad-hoc codesign after electron-builder packs the .app.
 *
 * CI builds without an Apple Developer identity. A completely unsigned download
 * with the quarantine bit set makes Gatekeeper on recent macOS report
 * "app is damaged and can't be opened". Ad-hoc signing (`codesign -s -`) plus
 * clearing quarantine on first open (`xattr -cr …`) is the interim fix until
 * Developer ID + notarization exist.
 */
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  // Deep ad-hoc sign, no hardened-runtime flag: that flag requires a real
  // Developer ID certificate and is what produced the "damaged" dialog before.
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });

  execFileSync("codesign", ["--verify", "--deep", "--verbose=2", appPath], {
    stdio: "inherit",
  });
};
