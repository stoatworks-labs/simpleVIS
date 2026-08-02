import { useEffect, useRef, useState } from 'react';
import type { Patch } from '@simplevis/core';
import type { NetworkInterface, SimpleVisApi, SourceStatus } from '../api.js';

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
  const fileRef = useRef<HTMLInputElement>(null);

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

      <section className="panel">
        <h2>Look</h2>
        <label className="field">
          <span>Haze <em>{props.haze.toFixed(2)}</em></span>
          <input
            type="range" min={0} max={1} step={0.01}
            value={props.haze}
            onChange={(e) => props.onHazeChange(Number(e.target.value))}
          />
        </label>
        <label className="field">
          <span>Exposure <em>{props.exposure.toFixed(2)}</em></span>
          <input
            type="range" min={0.1} max={4} step={0.05}
            value={props.exposure}
            onChange={(e) => props.onExposureChange(Number(e.target.value))}
          />
        </label>
      </section>
    </aside>
  );
}
