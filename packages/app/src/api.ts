/**
 * The backend bridge, and the capability flags the UI branches on.
 *
 * There are two backends: the Tauri desktop app, which owns real sockets and a
 * serial port, and the hosted static build, which owns nothing. Following the
 * fleet's hosted-build convention:
 *
 *  - **Every backend implements the whole interface.** Nothing is omitted, so a
 *    React effect can subscribe unconditionally without null checks.
 *  - **`capabilities` decides visibility, not behaviour.** What the hosted
 *    build cannot do is *hidden*, never left as a button that fails.
 *  - **Never sniff for Tauri.** The backend declares what it can do; the UI
 *    reads the declaration.
 */

/** A frame of DMX for one universe. */
export interface UniverseFrame {
  readonly universe: number;
  readonly slots: Uint8Array;
}

/** A live input, as the status panel shows it. */
export interface SourceStatus {
  readonly protocol: 'artnet' | 'sacn' | 'usb' | 'demo';
  readonly label: string;
  readonly universes: readonly number[];
  /** Frames per second, measured. */
  readonly fps: number;
  /** True when more sources than the merge engine allows are transmitting. */
  readonly tooManySources: boolean;
}

export interface Capabilities {
  /** Can receive Art-Net / sACN over the network. */
  readonly network: boolean;
  /** Can open a USB DMX interface. */
  readonly usb: boolean;
  /** Can speak CITP to a console. */
  readonly citp: boolean;
  /** Can read and write files from disk (vs. drag-and-drop only). */
  readonly filesystem: boolean;
  /** Human-readable backend name for the About panel. */
  readonly backend: string;
}

export interface NetworkInterface {
  readonly name: string;
  readonly address: string;
}

export interface SimpleVisApi {
  readonly capabilities: Capabilities;
  /** Subscribe to DMX frames. Returns an unsubscribe function. */
  onUniverse(handler: (frame: UniverseFrame) => void): () => void;
  /** Subscribe to input status changes. */
  onSources(handler: (sources: readonly SourceStatus[]) => void): () => void;
  listInterfaces(): Promise<readonly NetworkInterface[]>;
  /** Start listening. `interfaceAddress` empty means all interfaces. */
  startNetwork(options: { protocols: readonly ('artnet' | 'sacn')[]; interfaceAddress: string }): Promise<void>;
  stopNetwork(): Promise<void>;
  listSerialPorts(): Promise<readonly string[]>;
  openSerial(port: string): Promise<void>;
  closeSerial(): Promise<void>;
  /**
   * Declare which universes the patch uses.
   *
   * sACN is multicast and a receiver hears nothing on a group it has not
   * joined, so without this only consoles that happen to unicast appear to
   * work — which looks like "sACN is broken" rather than "no group joined".
   */
  setUniverses(universes: readonly number[]): Promise<void>;
}

/**
 * The hosted backend: everything stubbed, nothing missing.
 *
 * The stubs are deliberately silent rather than throwing. A component that
 * subscribes on mount should not have to know which backend it got, and a
 * capability-gated control should never reach these anyway.
 */
const browserApi: SimpleVisApi = {
  capabilities: {
    network: false,
    usb: false,
    citp: false,
    filesystem: false,
    backend: 'Browser',
  },
  onUniverse: () => () => {},
  onSources: () => () => {},
  listInterfaces: async () => [],
  startNetwork: async () => {},
  stopNetwork: async () => {},
  listSerialPorts: async () => [],
  openSerial: async () => {},
  closeSerial: async () => {},
  setUniverses: async () => {},
};

let installed: SimpleVisApi | undefined;

/**
 * Install a backend. Called once by the entry point, never by a component.
 *
 * Which backend is chosen is a **build-time** decision — see `main.tsx`. The
 * hosted bundle therefore never contains Tauri's client code, and no component
 * anywhere has to ask which environment it is running in.
 */
export function installApi(api: SimpleVisApi): void {
  installed = api;
}

/** The active backend. Falls back to the browser one. */
export function getApi(): SimpleVisApi {
  return installed ?? browserApi;
}
