/*
 * Manual update check against GitHub Releases.
 *
 * No background polling and no silent install — the user asks, we report the
 * newest tagged release, and optionally download the .dmg into Downloads and
 * open it. Auto-update would need notarization and a signed delta channel;
 * until then this is the honest path.
 */

const { net, app, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const { createWriteStream } = require("node:fs");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");

const REPO = "fedurca/het68_spectral";
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

function parseSemver(v) {
  const core = String(v)
    .trim()
    .replace(/^v/i, "")
    .split(/[-+]/)[0];
  const parts = (core || "0").split(".").map((p) => {
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** @returns {number} negative if a < b, 0 if equal, positive if a > b */
function compareSemver(a, b) {
  const A = parseSemver(a);
  const B = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (A[i] !== B[i]) return A[i] - B[i];
  }
  return 0;
}

function pickDmgAsset(assets) {
  if (!Array.isArray(assets)) return null;
  const dmgs = assets.filter(
    (a) => typeof a?.name === "string" && a.name.toLowerCase().endsWith(".dmg"),
  );
  if (dmgs.length === 0) return null;
  // Prefer arm64 when named; otherwise the first dmg (CI currently ships one).
  return (
    dmgs.find((a) => /arm64|aarch64/i.test(a.name)) ??
    dmgs.find((a) => !/x64|amd64|intel/i.test(a.name)) ??
    dmgs[0]
  );
}

async function fetchJson(url) {
  const res = await net.fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "het68-spectral",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub ${res.status}: ${body.slice(0, 200) || res.statusText}`);
  }
  return res.json();
}

/**
 * @param {string} currentVersion version shown in the UI / build-info
 * @returns {Promise<object>}
 */
async function checkForUpdate(currentVersion) {
  const current = String(currentVersion || app.getVersion() || "0.0.0");
  const release = await fetchJson(API);
  const latest = String(release.tag_name || release.name || "").replace(/^v/i, "");
  if (!latest) {
    return {
      status: "error",
      current,
      message: "Latest release has no tag name.",
      releaseUrl: RELEASES_PAGE,
    };
  }

  const asset = pickDmgAsset(release.assets);
  const cmp = compareSemver(current, latest);
  const status = cmp < 0 ? "available" : cmp === 0 ? "up-to-date" : "newer-local";

  return {
    status,
    current,
    latest,
    tag: release.tag_name,
    name: release.name || release.tag_name,
    publishedAt: release.published_at ?? null,
    notes: typeof release.body === "string" ? release.body.slice(0, 4000) : "",
    releaseUrl: release.html_url || RELEASES_PAGE,
    downloadUrl: asset?.browser_download_url ?? null,
    downloadName: asset?.name ?? null,
    message:
      status === "available"
        ? `Update ${latest} is available (you have ${current}).`
        : status === "up-to-date"
          ? `You are on the latest release (${current}).`
          : `Local build ${current} is newer than GitHub latest ${latest}.`,
  };
}

/**
 * Download a release asset into the user's Downloads folder.
 * @param {{ url: string, name?: string }} opts
 */
async function downloadUpdate({ url, name }) {
  if (!url || typeof url !== "string") throw new Error("Missing download URL.");
  const filename =
    (typeof name === "string" && name.length > 0 && path.basename(name)) ||
    path.basename(new URL(url).pathname) ||
    "het68-spectral.dmg";

  const dest = path.join(app.getPath("downloads"), filename);
  const res = await net.fetch(url, {
    headers: { "User-Agent": "het68-spectral", Accept: "application/octet-stream" },
    redirect: "follow",
  });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (${res.status} ${res.statusText})`);
  }

  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  return { path: dest, name: filename };
}

async function openPath(filePath) {
  const err = await shell.openPath(filePath);
  if (err) throw new Error(err);
}

async function openExternal(url) {
  await shell.openExternal(url);
}

module.exports = {
  REPO,
  RELEASES_PAGE,
  compareSemver,
  checkForUpdate,
  downloadUpdate,
  openPath,
  openExternal,
};
