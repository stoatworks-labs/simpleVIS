/**
 * The Tauri backend.
 *
 * Selected at **build time** by `VITE_SIMPLEVIS_BACKEND=tauri`, not by sniffing
 * for `window.__TAURI__` at runtime. That keeps the rule in `api.ts` honest —
 * components branch on declared capabilities and nothing anywhere asks "am I in
 * Tauri?" — and it means the hosted bundle never ships Tauri's client code at
 * all.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  Capabilities,
  CitpPatchEntry,
  CitpPeer,
  NetworkInterface,
  SimpleVisApi,
  SourceStatus,
  UniverseFrame,
} from './api.js';

// `usb` is false on iOS and Android: neither exposes a USB serial port a
// Enttec-class DMX interface could be opened on, and the Rust side does not
// even compile the serialport crate for those targets, so the commands behind
// this flag are genuinely absent rather than merely unlikely to work.
//
// Everything else stays true, and on mobile that is a narrower promise than it
// looks. Art-Net and unicast sACN work — this codebase binds 0.0.0.0 and never
// joins a group for Art-Net, so a console pointed at the device's own address
// reaches it. Multicast sACN and CITP discovery need a MulticastLock on Android
// and an Apple-approved entitlement on iOS, and have neither yet.
const capabilities: Capabilities = {
  network: true,
  usb: !__SIMPLEVIS_MOBILE__,
  citp: true,
  filesystem: true,
  backend: __SIMPLEVIS_MOBILE__ ? 'Mobile' : 'Desktop',
};

/** Slots arrive over IPC as a plain number array; the store wants bytes. */
interface RawFrame {
  universe: number;
  slots: number[];
}

export const tauriApi: SimpleVisApi = {
  capabilities,

  onUniverse(handler: (frame: UniverseFrame) => void) {
    // `listen` resolves to the unlisten function asynchronously, so unsubscribe
    // has to survive being called before the subscription completes —
    // otherwise a component that mounts and unmounts quickly leaks a listener
    // that keeps firing into a dead handler.
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    listen<RawFrame>('simplevis://universe', (event) => {
      handler({
        universe: event.payload.universe,
        slots: Uint8Array.from(event.payload.slots),
      });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  },

  onSources(handler: (sources: readonly SourceStatus[]) => void) {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    listen<SourceStatus[]>('simplevis://sources', (event) => handler(event.payload)).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  },

  listInterfaces: () => invoke<NetworkInterface[]>('list_interfaces'),

  startNetwork: ({ protocols, interfaceAddress }) =>
    invoke('start_network', { protocols, interfaceAddress }),

  stopNetwork: () => invoke('stop_network'),

  listSerialPorts: () => invoke<string[]>('list_serial_ports'),

  openSerial: (port: string) => invoke('open_serial', { port }),

  closeSerial: () => invoke('close_serial'),

  setUniverses: (universes) => invoke('set_universes', { universes: [...universes] }),

  startCitp: (interfaceAddress: string) => invoke('start_citp', { interfaceAddress }),

  stopCitp: () => invoke('stop_citp'),

  listCitpPeers: () => invoke<CitpPeer[]>('citp_peers'),

  onCitpPatch(handler: (patch: readonly CitpPatchEntry[]) => void) {
    // Same unsubscribe-before-subscribe race as the universe listener: `listen`
    // resolves asynchronously, so a component that unmounts quickly must not
    // leak a listener firing into a dead handler.
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<CitpPatchEntry[]>('simplevis://citp-patch', (event) => handler(event.payload)).then(
      (fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      },
    );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  },
};

export function collectDiagnostics(): Promise<string> {
  return invoke<string>('collect_diagnostics');
}
