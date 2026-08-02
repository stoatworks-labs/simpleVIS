/**
 * Joining the two halves of an MVR: where a fixture *is* (the scene) and what
 * its channels *mean* (the GDTF).
 *
 * The result is a flat patch — every attribute of every fixture resolved to a
 * concrete universe and channel — which is what the DMX evaluator consumes
 * each frame and what a patch view displays.
 *
 * One correctness detail worth stating: a fixture's footprint is placed by
 * **absolute** address arithmetic, so a fixture whose channels run past slot
 * 512 spills into the next universe rather than wrapping back to the start of
 * its own. The Generic LED Wall's 300-channel footprint makes that reachable
 * with a single patch mistake, and wrapping would light the wrong fixtures
 * instead of showing the operator an obvious overflow.
 */

import type { MvrArchive } from './mvr/archive.js';
import type { MvrFixture } from './mvr/types.js';
import type { GdtfChannelFunction, GdtfFixtureType } from './gdtf/types.js';
import { resolveMode, type GeometryInstance, type ResolvedMode } from './gdtf/modes.js';
import { fromAbsolute, toAbsolute, type DmxAddress } from './dmx/address.js';

/** One attribute of one fixture, at a concrete address. */
export interface PatchedChannel {
  readonly attribute: string;
  readonly geometry: string;
  readonly instance: string;
  /**
   * Absolute addresses of this channel's bytes, coarse first. Empty for a
   * virtual channel. Each entry carries its own universe, so a footprint that
   * crosses a universe boundary stays correct.
   */
  readonly addresses: readonly DmxAddress[];
  readonly initialValue: number;
  readonly functions: readonly GdtfChannelFunction[];
}

export interface PatchedFixture {
  readonly fixture: MvrFixture;
  readonly fixtureType: GdtfFixtureType;
  readonly mode: ResolvedMode;
  readonly channels: readonly PatchedChannel[];
  readonly instances: readonly GeometryInstance[];
  /** DMX footprint in channels. */
  readonly footprint: number;
}

export interface Patch {
  readonly fixtures: readonly PatchedFixture[];
  /** Every universe the patch touches, ascending. */
  readonly universes: readonly number[];
  readonly warnings: readonly string[];
}

/** Resolve an opened MVR archive into a flat patch. */
export function buildPatch(archive: MvrArchive): Patch {
  const fixtures: PatchedFixture[] = [];
  const warnings: string[] = [...archive.warnings];
  const universes = new Set<number>();

  for (const fixture of archive.scene.fixtures) {
    const spec = fixture.gdtfSpec.trim().toLowerCase();
    const fixtureType = archive.fixtureTypes.get(spec);
    if (!fixtureType) {
      // Already warned about by openMvr; don't repeat per fixture.
      continue;
    }

    const mode = resolveMode(fixtureType, fixture.gdtfMode);
    if (!mode) {
      warnings.push(
        `fixture "${fixture.name}" references mode "${fixture.gdtfMode}" which ` +
          `"${fixtureType.name}" does not define`,
      );
      continue;
    }
    if (mode.name.trim().toLowerCase() !== fixture.gdtfMode.trim().toLowerCase()) {
      warnings.push(
        `fixture "${fixture.name}" wants mode "${fixture.gdtfMode}"; ` +
          `"${fixtureType.name}" has no such mode, falling back to "${mode.name}"`,
      );
    }

    const channels: PatchedChannel[] = [];
    for (const channel of mode.channels) {
      const start = fixture.addresses.find((a) => a.break === channel.dmxBreak - 1) ??
        fixture.addresses[0];
      if (!start) {
        warnings.push(`fixture "${fixture.name}" has no DMX address`);
        continue;
      }
      const base = toAbsolute(start);
      const addresses = channel.offsets.map((offset) => fromAbsolute(base + offset - 1));
      for (const a of addresses) universes.add(a.universe);

      channels.push({
        attribute: channel.attribute,
        geometry: channel.geometry,
        instance: channel.instance,
        addresses,
        initialValue: channel.initialValue,
        functions: channel.functions,
      });
    }

    fixtures.push({
      fixture,
      fixtureType,
      mode,
      channels,
      instances: mode.instances,
      footprint: mode.footprint,
    });
  }

  return {
    fixtures,
    universes: [...universes].sort((a, b) => a - b),
    warnings,
  };
}
