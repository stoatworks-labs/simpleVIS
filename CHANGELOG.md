# Changelog

## Unreleased

### CITP
- **PINF** peer discovery: announces simpleVIS on 224.0.0.180:4809 and dials
  peers that advertise a TCP port. Both directions, because a console may
  expect to connect to the visualiser or to be connected to.
- **SDMX** levels. Channel blocks are partial and are accumulated into whole
  universes per peer, then fed to the same merge engine Art-Net and sACN use —
  so a console sending both merges normally instead of one overwriting the
  other. Blind data is dropped, and `SXSr` (Set External Source) is honoured.
- **FPTC** fixture patch: `Ptch`, `UPtc` and an `SPtc` request on connect.

Verified over real sockets against a scripted console — discovery, TCP framing,
partial-block assembly, blind rejection, and several messages arriving in one
segment. **Not yet tested against a real console or Capture.**

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
