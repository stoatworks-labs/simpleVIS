# simpleVIS user guide

simpleVIS is **a lightweight real-time lighting visualiser**. Import an MVR, take live levels over
Art-Net, sACN, USB DMX or CITP, fly a camera around the rig, and see your programming in
volumetric haze.

It is for seeing what a rig will do before you are in the room with it — checking looks and
coverage against a real patch, without a visualiser licence and without modelling the venue by
hand.

> **Before you rely on this:** the import chain, DMX evaluation and protocol parsers are tested
> against real files and real packet layouts. The full 119-fixture MA Demostage renders at 60–70
> fps, and the receive path is verified over real sockets.
>
> **No real console and no DMX interface has driven it yet** — every packet so far has come from
> a test that wrote it, or from the built-in demo source. CITP has had first contact with a real
> peer (Capture 2026), but Capture is a DMX *consumer* like simpleVIS, so **levels and patch from
> a real console remain unverified**.
>
> This project was built with AI assistance.

---

## Two builds, and why

**Art-Net and sACN are UDP, and a browser cannot receive UDP** — there is no flag, polyfill or
workaround. So simpleVIS ships two targets from one codebase:

| Build | What it is | Live input |
|---|---|---|
| **Desktop** (Tauri v2) | the real tool | Art-Net, sACN, USB DMX, CITP |
| **Hosted** | offline previz and plot viewer in a tab | none — built-in demo look |

The shared code is identical; only the transport differs. **The hosted build hides what it cannot
do** rather than offering controls that fail.

![simpleVIS: an imported rig in volumetric haze, with the camera flown round it.](screenshot.png)

---

## Importing a rig

**MVR (`.mvr`)**, including the GDTF fixture definitions embedded inside it — geometry tree, DMX
modes, beam angles, colour mixing.

> **Import only. simpleVIS never writes MVR.** Nothing you do here can damage the file the desk
> gave you.

**Pixel-mapped fixtures work properly.** An MVR whose LED wall declares four template channels
across a hundred `GeometryReference`s is resolved to its real **300-channel footprint, one DMX
slot per pixel** — rather than being taken at face value as four channels.

---

## Live input

| Protocol | What's covered |
|---|---|
| **sACN (E1.31)** | Priority arbitration, CID source identity, multicast group joins per patched universe |
| **Art-Net 4** | ArtDmx, and ArtPoll replies so consoles list simpleVIS as a node |
| **USB DMX** | **Enttec DMX USB Pro only.** An *Open* DMX USB has no receive path and cannot be an input at all |
| **CITP** | Peer discovery (PINF), levels (SDMX), and fixture patch from the console (FPTC) |

> **Two sources per universe are merged HTP or LTP with a 4-second timeout. A third is refused and
> reported** rather than silently dropped — so a mystery universe is a message, not a guess.

### What CITP does and doesn't cover

Three layers are implemented:

- **PINF** — peer discovery.
- **SDMX** — levels. It *does* carry them, as channel blocks; a common misconception says
  otherwise.
- **FPTC** — fixture patch, **so the patch can follow the desk without re-importing an MVR**.

`SXSr` is honoured, so a console that says "take my levels from Art-Net" is not *also* counted as
a CITP source and double-merged.

**MSEX and CAEX — thumbnails and viewport streaming — are not implemented.** simpleVIS will not
stream its viewport back to the desk.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| **No live input options in the browser** | Correct — a browser cannot receive UDP. Use the desktop build. |
| **USB DMX interface not receiving** | An *Open* DMX USB has no receive path at all. Only the Enttec DMX USB Pro can be an input. |
| **A universe won't take a third source** | By design — two sources merge, a third is refused and reported. |
| **Levels stopped after a source disappeared** | The merge has a 4-second timeout before it drops a stale source. |
| **LED wall renders as four channels, not per pixel** | Shouldn't happen — `GeometryReference` expansion is tested. Worth reporting with the MVR. |
| **Console doesn't list simpleVIS as a node** | Art-Net discovery is ArtPoll/ArtPollReply; check the desk is polling the right subnet. |
| **CITP peer found but no levels** | The peer may be a consumer rather than a console — a visualiser sends neither levels nor patch. |
| **Desk can't see simpleVIS's viewport** | Not implemented. MSEX/CAEX viewport streaming is out of scope for now. |
| **Fixture renders but doesn't move** | Check the DMX mode the MVR declared matches what the desk is patched to — a mode is a template, not a footprint. |

---

## See also

- [AGENTS.md](../AGENTS.md) — design notes, load-bearing invariants, and **the several ways an
  MVR will quietly render wrong**
- [README](../README.md) — the two builds, protocol coverage and downloads
