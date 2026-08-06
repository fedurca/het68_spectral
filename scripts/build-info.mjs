#!/usr/bin/env node
/*
 * Stamps apps/web/public/build-info.json before the bundle is built.
 *
 * For an analysis tool this is not decoration. A signature stored in the library, or a
 * CSV exported from a puzzling recording, has to be traceable to the exact code that
 * produced it — otherwise a template saved today cannot be reproduced once the DSP has
 * moved on, and a disagreement between two exports has no explanation.
 *
 * The dirty flag is deliberate: a result produced from an uncommitted tree cannot be
 * reproduced from the commit alone, and pretending otherwise is worse than saying so.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function git(args, fallback = "") {
  try {
    return execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return fallback;
  }
}

async function main() {
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));

  // In Actions the checkout is detached, so the branch has to come from the
  // environment rather than from HEAD.
  const commit = process.env.GITHUB_SHA || git(["rev-parse", "HEAD"], "unknown");
  const branch =
    process.env.GITHUB_REF_NAME || git(["rev-parse", "--abbrev-ref", "HEAD"], "unknown");

  const info = {
    version: pkg.version,
    commit,
    commitShort: commit === "unknown" ? "unknown" : commit.slice(0, 7),
    branch,
    builtAt: new Date().toISOString(),
    dirty: git(["status", "--porcelain"]) !== "",
  };

  const dir = join(ROOT, "apps", "web", "public");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "build-info.json"), JSON.stringify(info, null, 2) + "\n");

  console.log(
    `build-info: v${info.version} ${info.commitShort}${info.dirty ? "+dirty" : ""} on ${info.branch} at ${info.builtAt}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
