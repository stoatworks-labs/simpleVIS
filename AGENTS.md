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
| **Desktop** (Tauri v2) | the real tool | Art-Net, sACN, USB DMX, CITP |
| **Hosted static** (Cloudflare Worker) | offline previz / plot viewer | none |

Everything above the transport is shared TypeScript. The Rust side owns sockets
and the serial port and pushes universes into the webview.

Follow the fleet's hosted-build pattern (see `reference_pages_demo_hosting`): a
`capabilities` object on `window.api` that components branch on, so the hosted
build **hides** what it cannot do rather than showing buttons that fail. Never
sniff for Tauri.

### CITP is not a level source

Worth stating because the brief for this project assumed otherwise. CITP is four
sub-protocols and none of them carries DMX: **PINF** (peer discovery), **FPTC**
(fixture *patch* exchange — the console tells the visualiser what is patched
where), **MSEX** (media-server thumbnails), **CaSt** (the visualiser streams its
camera view *back* to the console, which is how a live visualiser feed appears in
Eos or grandMA3). Levels always arrive over Art-Net or sACN.

simpleVIS targets FPTC and CaSt.

---

## Layout

```
packages/core/     pure TS — no DOM, no WebGL, no Node. Runs in a tab,
                   in Tauri's webview, and under vitest.
  src/xml.ts       tolerant order-preserving XML
  src/matrix.ts    the two incompatible matrix conventions
  src/mvr/         archive + GeneralSceneDescription
  src/gdtf/        description.xml + DMX mode resolution
  src/dmx/         addressing, universe store, evaluation
  src/patch.ts     joins scene placement to channel meaning
```

`packages/render`, `packages/app` and `src-tauri` are not built yet.

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

## Verified vs assumed

**Verified against real files** (46 tests, typecheck clean):

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

**Not verified — do not describe as working:**

- **Nothing has ever been rendered.** There is no renderer yet.
- **No live DMX of any kind has ever been received.** No Art-Net, no sACN, no
  USB interface, no CITP. None of that code exists yet.
- **No console has ever been connected**, though grandMA3 2.2.5 and Capture 2026
  are both installed on the development Mac and are the intended test rig.
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
