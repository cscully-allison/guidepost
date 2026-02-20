const esbuild = require("esbuild");
const path = require("path");

const frontendFiles = [
  path.join("guidepost", "src", "guidepost.js"),
  path.join("guidepost", "src", "trailmark.js"),
];
// 1️⃣ Bundle frontend files (ESM, browser)
esbuild.build({
  entryPoints: frontendFiles,
  bundle: true,
  format: "esm",
  outdir: path.join("guidepost", "static"),
  platform: "browser",
  sourcemap: true,
}).catch(() => process.exit(1));
