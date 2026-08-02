# simpleVIS — onboarding for an LLM or a new contributor

A lightweight real-time lighting visualiser. Import an MVR, take live levels
over Art-Net / sACN / USB-DMX, fly a camera round the rig and watch the
programming in volumetric haze.

`CLAUDE.md` holds the commands. This file holds the *why*, and — most
importantly — an honest account of **what is verified and what is not**.

---

## The one architectural fact everything follows from

**A static web page cannot receive Art-Net or sACN.** They are UDP (6454, and
5568 multicast). Browsers have no UDP API; WebRTC and WebTransport are
negotiated peer/server transports that cannot bind a port or join a multicast
group. CITP has the same problem. There is no flag, polyfill or workaround.

So simpleVIS ships **two targets from one codebase**:

| Target | What it is | Live input |
|---|---|---|
| **Desktop** (Tauri v2) | the real tool | Art-Net, sACN, USB DMX |
| **Hosted static** (Cloudflare Worker) | offline previz / plot viewer | none |

Everything above the transport is shared TypeScript. The Rust side owns sockets
and the serial port and pushes universes into the webview.

Follow the fleet's hosted-build pattern (see `reference_pages_demo_hosting`): a
`capabilities` object on the API that components branch on, so the hosted build
**hides** what it cannot do rather than showing buttons that fail.

**Never sniff for Tauri.** The backend is chosen at *build* time by
`VITE_SIMPLEVIS_BACKEND=tauri` in `main.tsx`, so the hosted bundle contains no
Tauri client code at all and nothing at runtime asks which environment it is
in.

### What CITP actually is

⚠️ **An earlier version of this document said CITP carries no DMX and named a
layer "CaSt". Both were wrong.** Corrected against the specification and the
`citp` crate's layer list:

| Layer | What it does |
|---|---|
| **PINF** | Peer discovery (`PLoc`, `PNam`), multicast |
| **SDMX** | **Send DMX — this does carry levels.** `ChBk` (channel block), `ChLs` (channel list), `UNam`, `EnId`, `SXSr` |
| **FPTC** | Fixture patch exchange: `Ptch`, `UPtc`, `SPtc` |
| **FSEL** / **FINF** | Fixture selection and information |
| **MSEX** | Media server extensions — thumbnails, and video **stream frames** |
| **CAEX** | Capture extensions (CITP 2.0) |

There is **no `CaSt` layer**. Streaming a viewport back to a console is MSEX
(and CAEX for Capture's own extensions), not a layer of its own.

What is true is the weaker claim: most consoles *in practice* send levels over
Art-Net or sACN and use CITP for patch and selection — SDMX's `SXSr` (Set
External Source) exists precisely to say "take my levels from Art-Net instead".
But CITP is not incapable of carrying them.

**PINF, SDMX and FPTC are implemented** (`src-tauri/src/protocol/citp.rs` for
the wire format, `src-tauri/src/citp.rs` for the peer). MSEX and CAEX are not.

Two things about the transport that are easy to get wrong, because both fail as
"the visualiser just sits there":

- **`PLoc` is multicast UDP; everything else is TCP** on the port `PLoc`
  advertises. A `PLoc` sent over an established TCP connection carries port 0
  — sending the real port there invites a second connection to nothing.
- **`ChBk` blocks are partial.** A console sends only what changed. Treating a
  block as a whole universe blanks everything outside it, so blocks are
  accumulated per peer before being merged.

Content types are matched as **ASCII bytes**, never as `u32` constants:
reference headers in the wild have at least two byte-reversed (`COOKIE_PINF_PNAM`
and `COOKIE_SDMX_ENID` spell theirs big-endian while the rest are little-endian),
and matching on `*b"PLoc"` cannot inherit that.

---

## Layout

```
packages/core/     pure TS — no DOM, no WebGL, no Node. Runs in a tab,
                   in Tauri's webview, and under vitest.
  src/xml.ts       tolerant order-preserving XML
  src/matrix.ts    the two incompatible matrix conventions
  src/mvr/         archive + GeneralSceneDescription
  src/gdtf/        description.xml + DMX mode resolution
  src/dmx/         addressing, universe store, evaluation, demo source
  src/patch.ts     joins scene placement to channel meaning

packages/render/   three.js. Browser-only.
  src/viewer.ts    the three render passes
  src/beams.ts     instanced volumetric cones
  src/glow.ts      instanced billboards for low-flux emitters
  src/fixtures.ts  GDTF geometry tree -> articulated three.js hierarchy

packages/app/      React UI. One codebase, two backends.
  src/api.ts       the capabilities contract
  src/backend-tauri.ts   desktop backend, selected at BUILD time

src-tauri/         Rust. Sockets, serial, nothing lighting-specific.
  src/protocol/    Art-Net + sACN parsers
  src/merge.rs     HTP/LTP, priority, source timeout
  src/net.rs       sockets and the publish loop
  src/serial.rs    Enttec DMX USB Pro
  crates/diag/     vendored fleet diagnostics module
  tests/receive.rs real datagrams on real sockets
```

---

## Load-bearing invariants

**Fix the model, never the test.** The expectations in `packages/core/test` were
read off real manufacturer files. If a change moves them, the change is wrong
until proven otherwise.

**Real files, never synthetic ones.** The reference is MA Lighting's
`Demostage_MVR.mvr` — MVR 1.5, 119 fixtures, 28 universes, 7 real GDTFs from
Martin, Robe, Ayrton, Prolights and Generic. Synthetic fixtures built to spec
only test your *reading* of the spec, which is exactly the thing most likely to
be wrong. It is not committed (it is MA's content, this repo is public); tests
locate it in an installed grandMA3 and skip with an explanatory message when it
is absent.

**Everything above the parsers is metres, Z-up.** GDTF's own convention.

---

## Traps, all found by reading real files

These cost real time. None of them fails loudly.

**Real files are not well-formed XML.** Every `GeneralSceneDescription.xml` and
every `description.xml` examined from MA's library ends with a **trailing NUL
byte** after the closing tag — a C string terminator that leaked into the
output. A strict parser rejects the whole document over that one byte.
`loadXml` strips it.

**MVR and GDTF disagree about matrices, inside the same archive.**

| | layout | units |
|---|---|---|
| MVR `<Matrix>` | 4 groups of **3** = `{u}{v}{w}{origin}`, basis vectors + origin | **millimetres** |
| GDTF `Position` | 4 groups of **4** = four **rows** of a 4x4 | **metres** |

The GDTF one is rows, not columns — both readings parse, only rows produce
meaningful numbers. Getting either wrong gives a rig at the wrong scale or
fixtures rotated onto their sides, which reads as a renderer bug.

**MVR `<Color>` is CIE xyY, not RGB.** `0.312712,0.329008,100.0` is D65 white;
as RGB it would be a near-black blue.

**MVR `<Address>` is an absolute address**, `(universe - 1) * 512 + channel`,
both 1-based. 3313 is universe 7 channel 241 — not universe 6, not channel 3313.

**A GDTF DMX mode is a template, not a footprint.** When a channel's geometry is
instantiated through `GeometryReference`, that channel exists **once per
instance** at an offset from the instance's `<Break>`:

```
absoluteOffset = break.dmxOffset + (templateOffset - 1)
```

The Generic LED Wall 10x10 declares **4** channels, has **100** references, and
occupies **300** DMX channels. Read literally it is a 3-channel fixture and only
the first pixel ever lights.

**An empty `Offset` is a virtual channel** that consumes no DMX and holds its
default. Treating it as offset 0 shifts every following channel.

**A virtual `Dimmer` must read as fully open, not as its default.** The LED
Wall's dimmer is virtual with a default of 0. Honouring that leaves every wall
in the show permanently black, because nothing can ever raise it.

**Physical ranges frequently run backwards.** Pan is `270 -> -270`, Tilt
`134 -> -134`, Zoom `50.2 -> 6.6`, CTO `5800 -> 2850`. Always interpolate
`from + v * (to - from)`. Normalising or sorting the range mirrors every
fixture's movement.

**`DMXFrom` is at the channel's own resolution.** `16384/2` on a `180 -> -180`
range is 90 degrees — a quarter of 65535, not of 255.

**`PhysicalFrom` / `PhysicalTo` are sometimes the literal string `"None"`**,
which `parseFloat` turns into NaN that then poisons every downstream angle.

**Channels are not in offset order in the file.** The MAC Ultra writes blades
33,34,35,36 before 29,30,31,32. Never infer position from document order.

**A channel's `Geometry` says what it moves.** Pan is written against `Yoke` and
Tilt against `Head`. This is the only thing that says which node rotates, and
it means the renderer never has to hard-code a moving-head skeleton.

**GDTF ships `.3ds`, not glTF.** All four Martin/Robe/Ayrton fixtures here carry
`models/3ds/` only. A loader that assumes `.glb` finds nothing and silently
draws no fixture body.

**Colour mixing is not always additive.** The MAC Ultra is subtractive CMY
(`ColorSub_C/M/Y`) with a CTO in kelvin. The LED Wall is additive RGB. Both must
work.

**A fixture can have sub-emitters.** The Prolights Sunrise2IP splits into a root
group plus `Pixel_left` and `Pixel_right`, each with its own addressable dimmer
behind the fixture's master. Sub-emitters inherit the root's pose and multiply
through its intensity, or the eye candy burns through a blackout.

**Shutter closed at DMX 0 is real.** A fixture with every slot at zero must
render dark. The Sunrise2IP's `Shutter1` function at DMX 0 is literally
`Closed`.

---

## Rendering notes

**Three passes, and it has to be three.** Opaque scene into an offscreen target
(which fills a depth texture) -> beams into a *half-resolution* target, sampling
that depth -> composite. The beams cannot share pass 1's depth buffer because a
shader may not sample the attachment it is rendering against, and they must not
plain depth-test or a camera sitting inside a beam loses it entirely.

**Performance is about draw calls and fill rate, in that order.** The Demostage
evaluates to **1,721 emitters**. Two mistakes each took it to under 1 fps:

- **A cloned material per emitter.** 1,721 unique materials is 1,721 draw calls
  and shader binds a frame. One shared material and one shared unit cube scaled
  per node fixed it.
- **A volumetric cone per emitter.** 1,600 of those emitters are LED wall
  pixels rated at **100 lumens**. They now go through an instanced billboard
  (`glow.ts`) — one draw call for the lot — and only emitters above `minFlux`
  get a raymarched cone. 112 cones, 1,600 glows, ~514 draw calls, 60-70 fps.

**Beams are gain-corrected, not physical.** The integral of 1/d² through a few
metres of haze is ~0.01, which is black. `BEAM_GAIN` puts it in range so
exposure 1.0 is the default look, and the composite applies a Reinhard knee so
a dozen overlapping beams roll off instead of clipping to flat white.

**A page that is not composited does not run `requestAnimationFrame`.** A hidden
or backgrounded tab reports 0 fps, 0 beams and 0 draw calls however well the
renderer works — indistinguishable from a dead render loop. That is what
`scripts/verify-render.mjs` exists for: it drives a real Chrome over CDP with
the anti-throttling flags, feeds a real MVR through the app's own file input via
`DOM.setFileInputFiles`, and reports the live counters plus a screenshot.

## Verified vs assumed

**Verified against real files** (52 TS + 22 Rust unit + 3 Rust integration tests,
typecheck clean):

- All 119 Demostage fixtures parse, across the expected 28 universes, with zero
  warnings and no mode fallbacks.
- Fixture placement in metres, matching the file's millimetres.
- `Symbol -> Symdef -> Geometry3D` indirection resolves, and every model it names
  is present in the archive.
- The LED Wall expands to 100 instances / 300 channels with correct per-instance
  rebasing, 100 distinct pixel positions, and one DMX slot lighting exactly one
  pixel.
- Pan/Tilt/Zoom physical extremes, 16-bit centring, CMY subtraction, master-dimmer
  gating of sub-pixels.

- **The full show renders.** 119 fixtures, 28 universes, 112 volumetric beams
  and 1,600 glows at 60-70 fps, driven by the built-in demo source, verified in
  a real Chrome with a screenshot.
- **The receive path works on real sockets** (`cargo test --test receive --
  --ignored`): sACN arrives on 5568 and is zero-filled to 512; an Art-Net
  Port-Address of 6 correctly surfaces as universe 7; a priority-200 source
  overrides a priority-100 one end to end.
- **The desktop bundle launches** and stays up — `.app` and `.dmg`, arm64,
  adhoc linker-signed.

**Not verified — do not describe as working:**

- **No real console has ever driven it.** Every DMX packet so far has come from
  a test that wrote it. grandMA3 2.2.5 and Capture 2026 are both installed on
  the development Mac and are the intended test rig.
- **No DMX interface has ever been connected.** The Enttec DMX USB Pro path is
  written from the protocol document and has never seen a widget — its framing
  is unit-tested, its behaviour is not.
- **CITP is not built at all.** Capability reports `false` so the UI hides it.
- **Fixture bodies are proxy boxes**, sized from real GDTF `Model` dimensions.
  The `.3ds` meshes inside a GDTF are not loaded.
- **Windows and Linux have never been built**, only macOS arm64.
- **Only one MVR has ever been parsed.** Exports from Vectorworks, Capture,
  WYSIWYG and Depence are untested; the `universe.channel` address form is
  implemented from the spec and has never seen a real file that uses it.
- **GDTF `ModeMaster` relations are parsed but not evaluated.** Where several
  functions on one channel share a `DMXFrom` — the MAC Ultra has four
  `Gobo1Pos` functions all starting at 0, selected by the gobo wheel — the first
  is used. Correct for indexing, wrong for the shake and spin variants.
- Gobos, prisms, framing shutters, animation wheels and colour wheels are parsed
  but contribute nothing to the output.
- `kelvinToRgb` is Tanner Helland's approximation, good to a few percent. Never
  checked against a colorimeter, and neither has anything else here.

---

## Sibling projects worth reading before writing new code

- **`nanODE`** (`firmware/components/artnet/`) — a working Art-Net 4 + sACN
  receiver in C99 with HTP/LTP merge, priority handling, 4 s source timeout and
  a 3rd-source refusal flag. Clock is injected so it is host-testable. This is
  the thing to port to Rust, not a fresh implementation.
- **`stagewash`** — three.js stage scene and beam cones, plus IES/LDT photometry
  calibrated against ETC datasheets. Same language, directly reusable.
- **`UnMapper`** — the fleet's wgpu precedent, and the source of the
  wgpu/egui version-skew and GPU-fixture traps if the renderer ever goes native.
- **`av-launcher`** — the Tauri v2 shell, already building green on mac/win/linux.
