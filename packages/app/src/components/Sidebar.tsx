import { useEffect, useMemo, useRef, useState } from 'react';
import { buildPixelMap, type Patch } from '@simplevis/core';
import { detailSettings } from '@simplevis/render';
import type { CitpPeer, NetworkInterface, SimpleVisApi, SourceStatus } from '../api.js';

interface Props {
  api: SimpleVisApi;
  load: { patch: Patch; name: string; setObjects: number } | null;
  sources: readonly SourceStatus[];
  useDemo: boolean;
  onUseDemoChange: (value: boolean) => void;
  haze: number;
  onHazeChange: (value: number) => void;
  exposure: number;
  onExposureChange: (value: number) => void;
  detail: number;
  onDetailChange: (value: number) => void;
  wireframe: boolean;
  onWireframeChange: (value: boolean) => void;
  /** Label of the feed currently on the walls, or null when nothing plays. */
  videoLabel: string | null;
  onVideoFile: (file: File) => void;
  onCaptureScreen: () => void;
  onVideoStop: () => void;
  onFrameRig: () => void;
  onImport: (file: File) => void;
  onLoadExample: () => void;
}

export function Sidebar(props: Props) {
  const { api, load, sources } = props;
  const [interfaces, setInterfaces] = useState<readonly NetworkInterface[]>([]);
  const [selectedInterface, setSelectedInterface] = useState('');
  const [listening, setListening] = useState(false);
  const [ports, setPorts] = useState<readonly string[]>([]);
  const [selectedPort, setSelectedPort] = useState('');
  const [serialOpen, setSerialOpen] = useState(false);
  const [citpOn, setCitpOn] = useState(false);
  const [citpPeers, setCitpPeers] = useState<readonly CitpPeer[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const videoFileRef = useRef<HTMLInputElement>(null);

  /**
   * How much of the rig can actually take a video feed.
   *
   * Worth counting and showing. "Play a file" on a rig with no pixel-mapped
   * fixture would appear to do nothing at all, and the honest reason — this
   * MVR has no wall in it — is not something a user can see from the viewport.
   */
  const pixelSurfaces = useMemo(() => {
    let fixtures = 0;
    let pixels = 0;
    for (const f of load?.patch.fixtures ?? []) {
      const map = buildPixelMap(f);
      if (!map) continue;
      fixtures++;
      pixels += map.size;
    }
    return { fixtures, pixels };
  }, [load]);

  // Screen and window capture is a DOM capability, not a backend one, so it is
  // feature-detected rather than read off `api.capabilities`. WKWebView, which
  // is what the desktop build renders in, does not implement it.
  const canCaptureScreen =
    typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;

  useEffect(() => {
    if (!api.capabilities.network) return;
    api.listInterfaces().then(setInterfaces).catch(() => setInterfaces([]));
  }, [api]);

  const toggleNetwork = async () => {
    if (listening) {
      await api.stopNetwork();
      setListening(false);
    } else {
      await api.startNetwork({
        protocols: ['artnet', 'sacn'],
        interfaceAddress: selectedInterface,
      });
      setListening(true);
    }
  };

  const toggleSerial = async () => {
    if (serialOpen) {
      await api.closeSerial();
      setSerialOpen(false);
    } else {
      await api.openSerial(selectedPort);
      setSerialOpen(true);
    }
  };

  useEffect(() => {
    if (!api.capabilities.usb) return;
    api.listSerialPorts().then(setPorts).catch(() => setPorts([]));
  }, [api]);

  const toggleCitp = async () => {
    if (citpOn) {
      await api.stopCitp();
      setCitpOn(false);
      setCitpPeers([]);
    } else {
      await api.startCitp(selectedInterface);
      setCitpOn(true);
    }
  };

  // Peers appear as their announcements arrive, so poll while listening rather
  // than reading once at start-up and showing an empty list forever.
  useEffect(() => {
    if (!citpOn) return;
    const tick = () => api.listCitpPeers().then(setCitpPeers).catch(() => {});
    tick();
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, [api, citpOn]);

  const byType = new Map<string, number>();
  for (const f of load?.patch.fixtures ?? []) {
    const key = f.fixtureType.name;
    byType.set(key, (byType.get(key) ?? 0) + 1);
  }

  return (
    <aside className="sidebar">
      <header className="brand">
        <span className="brand__mark">s</span>
        <div>
          <h1>simpleVIS</h1>
          <p>lighting visualiser</p>
        </div>
        {/* Opens the shared About dialog — see public/about.js, which delegates
            this attribute from the document, so nothing needs importing here.
            One dialog for both builds: the Tauri window is a webview too. */}
        <button className="brand__about" type="button" data-stoatworks-about>
          About
        </button>
      </header>

      <section className="panel">
        <h2>Scene</h2>
        <button className="button button--primary" onClick={() => fileRef.current?.click()}>
          Import MVR…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".mvr"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) props.onImport(file);
            e.target.value = '';
          }}
        />
        {!load && (
          <button className="button" onClick={props.onLoadExample}>Load example rig</button>
        )}
        {load && (
          <>
            <dl className="stats">
              <div><dt>File</dt><dd title={load.name}>{load.name}</dd></div>
              <div><dt>Fixtures</dt><dd>{load.patch.fixtures.length}</dd></div>
              <div><dt>Universes</dt><dd>{load.patch.universes.length}</dd></div>
              <div><dt>Set meshes</dt><dd>{load.setObjects}</dd></div>
            </dl>
            <button className="button" onClick={props.onFrameRig}>Frame rig</button>
            <ul className="typelist">
              {[...byType.entries()].map(([name, count]) => (
                <li key={name}><span>{name}</span><em>{count}</em></li>
              ))}
            </ul>
            {load.patch.warnings.length > 0 && (
              <details className="warnings">
                <summary>{load.patch.warnings.length} warnings</summary>
                <ul>
                  {load.patch.warnings.slice(0, 20).map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </details>
            )}
          </>
        )}
      </section>

      <section className="panel">
        <h2>Input</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={props.useDemo}
            onChange={(e) => props.onUseDemoChange(e.target.checked)}
          />
          <span>Demo look</span>
        </label>
        <p className="hint">
          A built-in moving look, so the rig can be seen with nothing plugged in.
        </p>

        {/* Capability-gated: hidden in the hosted build rather than shown
            as a control that cannot work. A browser has no UDP. */}
        {api.capabilities.network ? (
          <>
            <label className="field">
              <span>Interface</span>
              <select
                value={selectedInterface}
                onChange={(e) => setSelectedInterface(e.target.value)}
              >
                <option value="">All interfaces</option>
                {interfaces.map((i) => (
                  <option key={i.address} value={i.address}>
                    {i.name} — {i.address}
                  </option>
                ))}
              </select>
            </label>
            <button className="button" onClick={toggleNetwork}>
              {listening ? 'Stop Art-Net / sACN' : 'Listen for Art-Net / sACN'}
            </button>
          </>
        ) : (
          <p className="hint hint--muted">
            Art-Net and sACN are UDP, which a browser cannot receive. The desktop
            build takes live input.
          </p>
        )}

        {/* USB DMX. Hidden in the hosted build for the same reason as the
            network controls — a browser cannot open a serial port. */}
        {api.capabilities.usb && (
          <>
            <label className="field">
              <span>USB DMX interface</span>
              <select
                value={selectedPort}
                onChange={(e) => setSelectedPort(e.target.value)}
                onFocus={() => api.listSerialPorts().then(setPorts).catch(() => setPorts([]))}
              >
                <option value="">Select a port…</option>
                {ports.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </label>
            <button className="button" disabled={!selectedPort} onClick={toggleSerial}>
              {serialOpen ? 'Close interface' : 'Open interface'}
            </button>
            <p className="hint">
              Enttec DMX USB Pro. An Open DMX USB has no receive path, so it
              cannot be used as an input.
            </p>
          </>
        )}

        {/* CITP. Discovery is multicast and the rest is TCP, so like the
            others it cannot exist in the hosted build. */}
        {api.capabilities.citp && (
          <>
            <button className="button" onClick={toggleCitp}>
              {citpOn ? 'Stop CITP' : 'Listen for CITP'}
            </button>
            <p className="hint">
              Discovers consoles and visualisers, takes their patch, and accepts
              levels over SDMX.
            </p>
            {citpOn && (
              <ul className="sources">
                {citpPeers.length === 0 && <li className="hint">Looking for peers…</li>}
                {citpPeers.map((p) => (
                  <li key={p.address}>
                    <span className="pill pill--citp">{p.kind || 'peer'}</span>
                    <span className="sources__label">{p.name || p.address}</span>
                    <em>{p.connected ? 'connected' : p.state || 'seen'}</em>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {sources.length > 0 && (
          <ul className="sources">
            {sources.map((s) => (
              <li key={`${s.protocol}-${s.label}`}>
                <span className={`pill pill--${s.protocol}`}>{s.protocol}</span>
                <span className="sources__label">{s.label}</span>
                <em>{s.fps} fps</em>
                {s.tooManySources && <strong className="warn">3rd source refused</strong>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Video on the pixel-mapped fixtures. Hidden until a rig is loaded,
          because until then there is nothing for a feed to play on. */}
      {load && (
        <section className="panel">
          <h2>Wall video</h2>
          {pixelSurfaces.fixtures === 0 ? (
            <p className="hint hint--muted">
              Nothing in this rig is pixel-mapped. Video plays on fixtures whose
              GDTF expands into one addressable emitter per pixel — an LED wall,
              a pixel bar — and this MVR has none.
            </p>
          ) : (
            <>
              <p className="hint">
                {pixelSurfaces.fixtures} pixel-mapped{' '}
                {pixelSurfaces.fixtures === 1 ? 'fixture' : 'fixtures'},{' '}
                {pixelSurfaces.pixels} pixels. Each one plays the whole frame.
              </p>
              <button className="button" onClick={() => videoFileRef.current?.click()}>
                Play a video file…
              </button>
              <input
                ref={videoFileRef}
                type="file"
                accept="video/*"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) props.onVideoFile(file);
                  e.target.value = '';
                }}
              />
              {canCaptureScreen ? (
                <button className="button" onClick={props.onCaptureScreen}>
                  Capture a screen or window…
                </button>
              ) : (
                <p className="hint hint--muted">
                  Screen capture needs `getDisplayMedia`, which this webview does
                  not implement. A video file works either way.
                </p>
              )}
              {props.videoLabel && (
                <>
                  <p className="hint" title={props.videoLabel}>
                    Playing <strong>{props.videoLabel}</strong>
                  </p>
                  <button className="button" onClick={props.onVideoStop}>Stop video</button>
                </>
              )}
              <p className="hint hint--muted">
                Video replaces the pixel's colour; the fixture's own dimmer still
                applies, so a blackout blacks the walls out with everything else.
              </p>
            </>
          )}
        </section>
      )}

      <section className="panel">
        <h2>Look</h2>
        <label className="field">
          <span>Haze density <em>{props.haze.toFixed(2)}</em></span>
          <input
            type="range" min={0} max={1} step={0.01}
            value={props.haze}
            disabled={props.wireframe}
            onChange={(e) => props.onHazeChange(Number(e.target.value))}
          />
        </label>
        <p className="hint">
          How much the air scatters. At 0 the air is clean and a beam is
          invisible until it lands on something.
        </p>
        <label className="field">
          <span>Exposure <em>{props.exposure.toFixed(2)}</em></span>
          <input
            type="range" min={0.1} max={4} step={0.05}
            value={props.exposure}
            disabled={props.wireframe}
            onChange={(e) => props.onExposureChange(Number(e.target.value))}
          />
        </label>
      </section>

      <section className="panel">
        <h2>Quality</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={props.wireframe}
            onChange={(e) => props.onWireframeChange(e.target.checked)}
          />
          <span>Wireframe only</span>
        </label>
        <p className="hint">
          Edges, no beams and no haze — one render pass instead of three. For
          finding a fixture in a big rig, or for a machine that cannot carry the
          volumetrics.
        </p>

        <label className="field">
          <span>Detail <em>{detailName(props.detail)}</em></span>
          <input
            type="range" min={0} max={1} step={0.05}
            value={props.detail}
            disabled={props.wireframe}
            onChange={(e) => props.onDetailChange(Number(e.target.value))}
          />
        </label>
        {/* Spelling out what the slider resolves to, because "medium" tells
            nobody why their frame rate moved. These are the four numbers that
            actually decide the cost of a frame. */}
        <p className="hint">{describeDetail(props.detail)}</p>
      </section>
    </aside>
  );
}

/** The band a detail value falls in. 0.5 — "Medium" — is the shipped tuning. */
function detailName(detail: number): string {
  if (detail < 0.15) return 'Minimum';
  if (detail < 0.375) return 'Low';
  if (detail < 0.625) return 'Medium';
  if (detail < 0.85) return 'High';
  return 'Maximum';
}

function describeDetail(detail: number): string {
  const d = detailSettings(detail);
  const beams = `${Math.round(d.beamScale * 100)}% beam buffer`;
  const pixels = Math.round(d.pixelRatio * 100) / 100;
  return `${d.steps} raymarch steps · ${beams} · up to ${d.maxBeams} cones · ${pixels}x pixels`;
}
