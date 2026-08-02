import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildPatch,
  DemoSource,
  evaluatePatch,
  openMvr,
  UniverseStore,
  type Patch,
} from '@simplevis/core';
import { loadSceneObjects, Viewer } from '@simplevis/render';
import { getApi, type SourceStatus } from './api.js';
import { Sidebar } from './components/Sidebar.js';
import { DropZone } from './components/DropZone.js';
import { StatusBar } from './components/StatusBar.js';

interface LoadState {
  readonly patch: Patch;
  readonly name: string;
  readonly setObjects: number;
}

export function App() {
  const api = useMemo(() => getApi(), []);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const storeRef = useRef(new UniverseStore());
  const demoRef = useRef<DemoSource | null>(null);

  const [load, setLoad] = useState<LoadState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<readonly SourceStatus[]>([]);
  const [useDemo, setUseDemo] = useState(!api.capabilities.network);
  const [haze, setHaze] = useState(0.28);
  const [exposure, setExposure] = useState(1);
  const [fps, setFps] = useState(0);
  const [beamCount, setBeamCount] = useState(0);
  const [glowCount, setGlowCount] = useState(0);
  const [drawCalls, setDrawCalls] = useState(0);

  /* ---------------------------------------------------------- the viewer */

  useEffect(() => {
    if (!canvasRef.current) return;
    const viewer = new Viewer(canvasRef.current, { haze, exposure });
    viewerRef.current = viewer;

    const resize = () => viewer.resize();
    globalThis.addEventListener('resize', resize);

    let raf = 0;
    let last = performance.now();
    let frames = 0;
    let acc = 0;
    const start = performance.now();

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;

      if (demoRef.current) {
        demoRef.current.tick(storeRef.current, (now - start) / 1000);
      }

      const patch = patchRef.current;
      if (patch) {
        viewer.update(evaluatePatch(patch.fixtures, storeRef.current));
      }
      viewer.render();

      frames++;
      acc += dt;
      if (acc >= 0.5) {
        setFps(Math.round(frames / acc));
        setBeamCount(viewer.activeBeamCount);
        setGlowCount(viewer.activeGlowCount);
        setDrawCalls(viewer.drawCalls);
        frames = 0;
        acc = 0;
      }
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      globalThis.removeEventListener('resize', resize);
      viewer.dispose();
      viewerRef.current = null;
    };
    // The viewer owns its own loop for the lifetime of the canvas; haze and
    // exposure are pushed imperatively below rather than recreating it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the render loop's view of the patch current without restarting it.
  const patchRef = useRef<Patch | null>(null);
  useEffect(() => {
    patchRef.current = load?.patch ?? null;
  }, [load]);

  useEffect(() => {
    if (viewerRef.current) viewerRef.current.haze = haze;
  }, [haze]);
  useEffect(() => {
    if (viewerRef.current) viewerRef.current.exposure = exposure;
  }, [exposure]);

  /* ------------------------------------------------------------- backend */

  useEffect(() => api.onUniverse((frame) => storeRef.current.set(frame.universe, frame.slots)), [api]);
  useEffect(() => api.onSources(setSources), [api]);

  /* ---------------------------------------------------------------- demo */

  useEffect(() => {
    if (!load) {
      demoRef.current = null;
      return;
    }
    demoRef.current = useDemo ? new DemoSource(load.patch.fixtures) : null;
    if (!useDemo) storeRef.current.clear();
  }, [useDemo, load]);

  /* --------------------------------------------------------------- import */

  /**
   * Load the example rig that ships with the app.
   *
   * Authored by this project (`scripts/make-example-rig.py`) rather than taken
   * from a vendor library, so it is safe to publish, to film, and to run in CI.
   * It goes through exactly the same import path as a dropped file.
   */
  const loadExample = useCallback(async () => {
    const response = await fetch('example-rig.mvr');
    const bytes = await response.arrayBuffer();
    await importMvrBytes(new Uint8Array(bytes), 'example-rig.mvr');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const importMvrBytes = useCallback(async (bytes: Uint8Array, name: string) => {
    setError(null);
    setBusy(`Reading ${name}…`);
    try {
      const archive = openMvr(bytes);
      const patch = buildPatch(archive);

      setBusy('Building the rig…');
      viewerRef.current?.setPatch(patch);

      setBusy('Loading set geometry…');
      const set = await loadSceneObjects(archive);
      viewerRef.current?.addSceneObject(set.root);
      viewerRef.current?.frameRig();

      // The backend can only join sACN multicast groups it knows about.
      void api.setUniverses(patch.universes);

      setLoad({ patch, name, setObjects: set.loaded });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [api]);

  const importMvr = useCallback(
    async (file: File) => importMvrBytes(new Uint8Array(await file.arrayBuffer()), file.name),
    [importMvrBytes],
  );

  return (
    <div className="app">
      <Sidebar
        api={api}
        load={load}
        sources={sources}
        useDemo={useDemo}
        onUseDemoChange={setUseDemo}
        haze={haze}
        onHazeChange={setHaze}
        exposure={exposure}
        onExposureChange={setExposure}
        onFrameRig={() => viewerRef.current?.frameRig()}
        onImport={importMvr}
        onLoadExample={loadExample}
      />
      <main className="viewport">
        <canvas ref={canvasRef} />
        {!load && <DropZone onFile={importMvr} onLoadExample={loadExample} busy={busy} />}
        {busy && load && <div className="toast">{busy}</div>}
        {error && (
          <div className="toast toast--error" onClick={() => setError(null)}>
            {error}
          </div>
        )}
        <StatusBar
          fps={fps}
          beams={beamCount}
          glows={glowCount}
          draws={drawCalls}
          fixtures={load?.patch.fixtures.length ?? 0}
          universes={load?.patch.universes.length ?? 0}
          backend={api.capabilities.backend}
        />
      </main>
    </div>
  );
}
