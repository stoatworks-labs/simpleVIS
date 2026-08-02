/**
 * Locating real fixture files for the tests.
 *
 * simpleVIS is pinned against **real** manufacturer files, not synthetic ones
 * built to spec — synthetic fixtures test your reading of the standard, which
 * is exactly the thing most likely to be wrong. The reference file is MA
 * Lighting's `Demostage_MVR.mvr`, which ships inside grandMA3: MVR 1.5, 119
 * fixtures, 28 universes, 7 real GDTFs (Martin, Robe, Ayrton, Prolights,
 * Generic).
 *
 * It is **not committed** — it is MA's content and this repo is public — so
 * these tests locate it in an installed grandMA3 and skip with an explanatory
 * message when it is absent. A skipped suite is honest; a suite that quietly
 * substitutes a hand-written file is not.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Search for `Demostage_MVR.mvr` under any installed grandMA3 version. */
function findDemostage(): string | undefined {
  const explicit = process.env.SIMPLEVIS_TEST_MVR;
  if (explicit && existsSync(explicit)) return explicit;

  const roots = [
    join(homedir(), 'MALightingTechnology'),
    '/Applications/MALightingTechnology',
  ];

  for (const root of roots) {
    if (!existsSync(root)) continue;
    let versions: string[];
    try {
      versions = readdirSync(root);
    } catch {
      continue;
    }
    for (const version of versions) {
      const candidate = join(root, version, 'shared/resource/lib_mvr/Demostage_MVR.mvr');
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const demostagePath = findDemostage();

/** True when the real reference MVR is available on this machine. */
export const hasDemostage = demostagePath !== undefined;

export const demostageSkipReason =
  'Demostage_MVR.mvr not found. It ships with grandMA3 ' +
  '(<install>/shared/resource/lib_mvr/) and is not committed here because it is ' +
  'MA Lighting content. Set SIMPLEVIS_TEST_MVR to a copy to run these tests.';

let cached: Uint8Array | undefined;

/** Raw bytes of the reference MVR. Throws when unavailable. */
export function demostageBytes(): Uint8Array {
  if (!demostagePath) throw new Error(demostageSkipReason);
  if (!cached) cached = new Uint8Array(readFileSync(demostagePath));
  return cached;
}
