const esbuild = require("esbuild");
const path = require("path");

const frontendFiles = [
  path.join("guidepost", "src", "guidepost.js"),
  path.join("guidepost", "src", "campsite", "campsite.ts"),
  path.join("guidepost", "src", "trailmark.js"),
];

const backendFile = path.join("guidepost", "src", "campsite", "server.ts");

// 1️⃣ Bundle frontend files (ESM, browser)
esbuild.build({
  entryPoints: frontendFiles,
  bundle: true,
  format: "esm",
  outdir: path.join("guidepost", "static"),
  platform: "browser",
  sourcemap: true,
}).catch(() => process.exit(1));

// 2️⃣ Bundle backend Node file
esbuild.build({
  entryPoints: [backendFile],
  bundle: true,          // optional
  format: "cjs",         // use CommonJS for Node
  platform: "node",
  target: ["node18"],
  outfile: "guidepost/static/server.js",
  sourcemap: true,
  external: [
    "express",
    "@langchain/langgraph",
    "openai",
    "fs",
    "path",
    "events",
    "http",
    "https",
    "stream",
    "zlib",
    "url",
    "util"
  ]
}).catch(() => process.exit(1));