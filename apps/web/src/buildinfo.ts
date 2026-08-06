/*
 * Build identity.
 *
 * For a debugging tool this is not decoration. A screenshot of a puzzling
 * spectrogram, or a signature saved into the library, has to be traceable to the
 * commit that produced it; otherwise a stored template cannot be reproduced once the
 * analysis code has moved on.
 */

export interface BuildInfo {
  version: string;
  commit: string;
  commitShort: string;
  branch: string;
  builtAt: string;
  dirty: boolean;
}

const FALLBACK: BuildInfo = {
  version: "dev",
  commit: "unknown",
  commitShort: "unknown",
  branch: "unknown",
  builtAt: new Date().toISOString(),
  dirty: true,
};

let cached: BuildInfo | null = null;

export async function loadBuildInfo(): Promise<BuildInfo> {
  if (cached) return cached;
  try {
    const res = await fetch("./build-info.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(String(res.status));
    cached = (await res.json()) as BuildInfo;
  } catch {
    // A dev server run has no stamp; saying so is better than showing a stale one.
    cached = FALLBACK;
  }
  return cached;
}
