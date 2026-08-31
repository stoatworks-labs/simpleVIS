# Changelog

## Unreleased

### Added
- **Video on LED walls.** Any fixture whose GDTF expands into more than one
  addressable emitter is treated as a video surface, and takes its colour per
  pixel from a feed: a local video file, or a captured screen or window. Both
  sources are browser-native, so this works in the hosted build as well as the
  desktop one.

  The wall's own `GeometryReference` instances *are* the raster — the Generic
  LED Wall 10x10's hundred instances resolve to a full 10x10 grid of texture
  coordinates, derived from their positions rather than their document order,
  which a GDTF gives no guarantees about.

  Frames are decimated to a thumbnail before they are sampled, never after.
  That is what keeps 1,618 pixels costing nothing, and it is the design a
  native NDI or Syphon source would plug into: decimate where the frame already
  lives and hand over a few KB.

  Video replaces a pixel's colour but never its intensity, so the fixture's own
  dimmer still gates it and a blackout blacks the walls out with the rest of
  the rig.

  **NDI, Syphon and Spout are not implemented** — see `AGENTS.md` for what each
  would need, including NDI's proprietary SDK and the fact that Syphon cannot
  be zero-copy into a WebGL-in-WKWebView renderer.
- **A Quality panel: "Wireframe only" and a Detail slider.** Wireframe draws the
  rig as edges with no beams and no haze, in one render pass instead of three —
  for finding a fixture in a crowded rig, and for a machine that cannot carry
  the volumetrics. Detail is one slider over the four things that actually
  decide the cost of a frame (raymarch steps, beam-buffer resolution, the cone
  cap, pixel ratio); the panel spells out what the current position resolves
  to, because "medium" tells nobody why their frame rate moved.

  Its midpoint is exactly the tuning the renderer shipped with, so the default
  is unchanged, and a test fails if that drifts. The top stop deliberately
  stops short of full-resolution beams: at 1.0 beam scale and a 2x pixel ratio
  the beam pass is sixteen times the default's fragments, which on MA's
  Demostage wedged the page rather than merely slowing it.

### Fixed
- **Importing a second MVR drew both plots on top of each other.** `setPatch`
  replaced the fixtures, but the set geometry — truss, deck, soft goods — was
  added to the scene and never removed, so every import stacked another copy.
  Found while measuring the wall-video change: the draw count climbed by
  exactly the set-mesh count on each import, with nothing visibly wrong until
  two rigs' trusses overlapped. Three imports of the Demostage now hold at 514
  draws where they went 514, 583, 652.

### Changed
- The haze slider is now labelled **Haze density**, and both Look sliders say
  what they do. They grey out while wireframe is on, since there is nothing
  volumetric for them to act on.


## v0.4.0 — 2026-08-21

### Fixed
- **The desktop app received no Art-Net or sACN once it was double-clicked.**
  Since macOS 15 an app must declare why it uses the local network, and on 26
  the enforcement is thorough: without `NSLocalNetworkUsageDescription` a
  GUI-launched app is denied LAN traffic silently — so the rig sat dark with
  nothing to explain it. The key was already in `Info.ios.plist`, which does not
  feed the macOS bundle; there is now a macOS `Info.plist` beside it. Nothing
  caught it in development because a process started from a terminal inherits
  the terminal's own permission.

### Added
- iOS and Android builds.

*(v0.3.0 shipped without a changelog entry; this file skips from v0.2.0 to
here.)*


## v0.2.0 — 2026-08-02

### CITP
- **PINF** peer discovery: announces simpleVIS on 224.0.0.180:4809 and dials
  peers that advertise a TCP port. Both directions, because a console may
  expect to connect to the visualiser or to be connected to.
- **SDMX** levels. Channel blocks are partial and are accumulated into whole
  universes per peer, then fed to the same merge engine Art-Net and sACN use —
  so a console sending both merges normally instead of one overwriting the
  other. Blind data is dropped, and `SXSr` (Set External Source) is honoured.
- **FPTC** fixture patch: `Ptch`, `UPtc` and an `SPtc` request on connect.

### Verified
- Against **Capture 2026** over the wire: `PLoc` parsed off the multicast group,
  TCP connect to its advertised port, and consecutive messages framed cleanly.
  Capture's `SDMX/Capa` is parsed; its `CAEX` content type turns out to be a
  *number*, not a four-character code, which the unknown-layer path handles
  without dropping the connection.
- Against a scripted console over real sockets: discovery, TCP framing,
  partial-block assembly, blind rejection, and two messages in one segment.

### Not verified
- **No real console has driven it.** Capture is a `Visualizer` — a DMX consumer
  like simpleVIS — so it sends neither levels nor patch, and there is no console
  software on the development machine. SDMX levels and FPTC patch are tested
  only against a console this project wrote.

## v0.1.0 — 2026-08-02

First release.

### Import
- MVR (`.mvr`) with embedded GDTF fixture definitions: geometry tree, DMX
  modes, beam data, colour mixing.
- `GeometryReference` expansion, so pixel-mapped fixtures resolve to their real
  footprint — a wall declaring 4 template channels across 100 references is
  correctly addressed as 300 channels, one slot per pixel.
- Set geometry (`.glb`) from the archive.

### Render
- Volumetric haze beams, raymarched, one instanced draw call for the rig.
- Fixture articulation driven by GDTF's own `Geometry` attributes, so pan turns
  whatever the file says pans.
- Subtractive CMY, additive RGB(W) and CTO colour.
- Orbit camera, haze and exposure controls.

### Input (desktop build)
- sACN (E1.31) with priority arbitration, CID source identity and per-universe
  multicast joins.
- Art-Net 4 ArtDmx, plus ArtPoll replies so consoles list simpleVIS as a node.
- USB DMX via an Enttec DMX USB Pro.
- Two-source HTP/LTP merge with a 4-second timeout; a third source is refused
  and reported.

### Hosted build
- MVR import, 3D scene and camera in a browser tab, driven by a built-in demo
  look. No live input — Art-Net and sACN are UDP and a browser cannot receive
  it.

### Not in this release
- **CITP** (FPTC patch sync, CaSt viewport streaming) — planned for v0.2.0.
- GDTF `.3ds` fixture meshes; bodies are proxy boxes at real published
  dimensions.
- GDTF `ModeMaster` relations are parsed but not evaluated.
- Gobos, prisms, framing shutters and colour wheels are parsed but do not
  affect the output.
