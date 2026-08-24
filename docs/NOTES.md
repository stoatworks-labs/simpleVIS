# Notes

Working notes for this repo: status, decisions, and the traps that have actually bitten.
Migrated out of Claude Code's memory on 2026-08-24, so they are written in the first
person and dated by when each thing was learned — that date is usually the useful part.

Cross-cutting notes that are not specific to this repo live in
[fleet-notes](https://github.com/stoatworks-labs/fleet-notes).

*simpleVIS — lightweight lighting visualiser (MVR import, Art-Net/sACN/DMX in, volumetric haze); import+DMX core built and tested, no renderer or live input yet*

**simpleVIS** (`~/Projects/simpleVIS`, MIT, started 2026-08-02) — a lightweight
real-time lighting visualiser: import an MVR, take live levels, fly a camera,
watch the programming in volumetric haze. **PUBLIC** at
github.com/stoatworks-labs/simpleVIS, **v0.2.0 released on 4 platforms**
(macOS arm64+x64, Windows, Linux deb/rpm), hosted build **LIVE** at
https://simplevis.stoatworks-labs.com, video at
https://www.youtube.com/watch?v=HgVhKPJmTzE.

**The fact the whole architecture follows from: a static web app cannot receive
Art-Net or sACN.** They are UDP (6454, 5568 multicast) and browsers have no UDP
API — WebRTC/WebTransport are negotiated transports that cannot bind a port or
join a multicast group. Same for CITP. No flag, no polyfill. So it ships **two
targets from one codebase**: a **Tauri v2 desktop** app (the real tool, all
protocols) and a **hosted static** offline previz/plot viewer with no live
input. Use the fleet's `capabilities`-on-`window.api` pattern
([pages demo hosting](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_pages_demo_hosting.md)) — hide what the hosted build can't do, never
sniff for Tauri.

Decisions taken with the user 2026-08-02: both targets, **volumetric haze**
(not cones+pools), and CITP for **FPTC patch sync + CaSt stream to console**.

**Stack chosen deliberately over Rust/wgpu:** TypeScript + three.js with a Rust
Tauri backend owning sockets and serial. That buys the hosted target nearly free
and lets `stagewash`'s three.js scene and photometry be reused *as TypeScript*
rather than reimplemented. [unmapper](https://github.com/stoatworks-labs/UnMapper/blob/main/docs/NOTES.md) (`UnMapper`) remains the wgpu precedent if it
ever needs to go native.

**Built and verified (46 tests, typecheck clean):** `packages/core` — pure TS,
no DOM/WebGL/Node. MVR archive + scene parse, GDTF parse, DMX mode resolution
incl. `GeometryReference` expansion, patch join, universe store, DMX→emitter
evaluation. All 119 fixtures of MA's Demostage resolve across 28 universes with
**zero warnings and no mode fallbacks**.

**Renderer works**: three passes (opaque->depth texture, beams raymarched at
HALF resolution sampling it, composite). Two mistakes each took the Demostage
under 1 fps — a **cloned material per emitter** (1,721 of them) and a
**volumetric cone per emitter** when 1,600 are 100-lumen wall pixels. Low-flux
emitters now go through one instanced billboard draw. 112 cones + 1,600 glows,
~514 draws, 60-70 fps.

**Verify with `scripts/verify-render.mjs`**, not the editor's browser pane: a
page that is not composited does not run `requestAnimationFrame`, so a hidden
tab reports 0 fps / 0 beams / 0 draws however well it works.

**`scripts/make-example-rig.py` authors an MVR + GDTF from scratch** — 24 heads,
inverted pan/tilt/zoom, closed shutter at DMX 0. Needed because MA's Demostage
cannot be committed, hosted or filmed. Ships as the app's "load example rig",
and is what the video shows.

**CITP shipped in v0.2.0**: PINF discovery, **SDMX levels** and FPTC patch. `protocol/citp.rs` = wire format, `citp.rs` = the peer. Verified over
real sockets against a scripted console, and **talked to Capture 2026 over the
wire** (`cargo run --example citp-probe`) — PLoc, TCP connect and stream framing
all correct. Two findings there: a CITP **content type is not always ASCII**
(Capture's CAEX kind is the number `0x00030100`), and `SDMX/Capa` is a u16 count
then that many u16 codes. **Capture is a `Visualizer`** — a DMX consumer like
simpleVIS — so it sends neither levels nor patch. MSEX/CAEX (thumbnails, viewport streaming) not implemented.
Transport traps, both of which present as "the visualiser just sits there":
**PLoc is multicast UDP, everything else is TCP** on the port it advertises (and
a PLoc sent over TCP carries port 0); **ChBk blocks are PARTIAL**, so accumulate
per peer before merging or you blank everything outside the block.

**NOT built — do not describe as working:** No real
console and no DMX interface has ever driven it — every packet so far came from
a test that wrote it. GDTF `.3ds` meshes are not loaded (bodies are proxy boxes
at real published dimensions). GDTF `ModeMaster` is parsed but **not
evaluated**. Only MA's Demostage and my own example rig have ever been parsed;
Vectorworks / Capture / WYSIWYG / Depence exports untested.

**OPEN LOOP — verify against a real console. Blocked on GUI config, twice.**
Both consoles are installed and both were launched successfully; neither can be
configured without clicking their custom-drawn UIs, and **macOS refuses
osascript coordinate clicks** while their grids expose no AX elements (MagicQ's
51 AX buttons all return `missing value`).

- **MagicQ PC 1.9.6.5** (`/Applications/MagicQ/MagicQ.app`). Its manual confirms
  CITP carries **both levels and show patch**. Needs `Setup > DMX IO`, universe
  1: **Status** `Disabled`->enabled, **Visualiser** `MagicVis`->`Capture`.
- **grandMA3 onPC 2.4.2** (`/Applications/grandMA3.app`). Launches fine — but
  `open -a` fails silently, run
  `/Applications/grandMA3.app/Contents/MacOS/grandMA3` directly instead, and
  **check for duplicate instances**. Its web remote (TCP **8080**) is up but
  hangs on "Connecting to console" — it must be enabled in MA3's settings first.
  Ports 30021/30022/30027 are binary MA-Net, **no text protocol**, so there is
  no headless route.

Verified 2026-08-03 that both emit **nothing** until configured: 0 Art-Net,
0 sACN, 0 CITP.

**When either is configured, one command proves it:**
`cd ~/Projects/simpleVIS/src-tauri && cargo run --example dmx-listen -- 60`
— listens on all three protocols at once with the shipping code and names which
were heard. (`citp-listen` and `citp-probe` are the CITP-only variants.)

Watch for: Capture also announces `kind="Visualizer"` like simpleVIS, and
MagicQ's option is literally named "Capture" — it may target Capture
specifically, so quit Capture to isolate.

**Test fixture is not committed** — it is MA's content. Tests find
`Demostage_MVR.mvr` inside an installed grandMA3 and **skip** when absent, so
check the skip message before trusting a green run. `SIMPLEVIS_TEST_MVR`
overrides.

**On-machine test rig — CHECKED 2026-08-02, and NOT what I first claimed:**
`~/MALightingTechnology/gma3_2.2.5/` is grandMA3's **data/resource tree only**
— the source of the reference MVR — with **no application installed**. Do not
describe grandMA3 as available. The only real peer here is **Capture
2026** (a real commercial visualiser that speaks CITP — the reference for
verifying FPTC/CaSt).

Reuse targets: **`nanODE/firmware/components/artnet/`** is a working C99
Art-Net 4 + sACN receiver with HTP/LTP merge, priority, 4 s source timeout and
3rd-source refusal, clock injected and host-tested — **port that to Rust rather
than writing fresh**. `stagewash` for the three.js scene and IES photometry.
`av-launcher` for the Tauri shell.

Format traps live in [mvr gdtf traps](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_mvr_gdtf_traps.md). See also
[agents md convention](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_agents_md_convention.md), **disclaimer scope** (working-practice note, kept in Claude memory).
