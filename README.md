# simpleVIS

> This project was built with AI assistance using [Claude Code](https://claude.com/claude-code).

A lightweight real-time lighting visualiser. Import an MVR, take live levels
over Art-Net, sACN or USB DMX, fly a camera around the rig, and see your
programming in volumetric haze.

![simpleVIS](docs/screenshot.png)

## What it is for

Seeing what a rig will do before you are in the room with it — checking looks
and coverage against a real patch, without a visualiser licence and without
modelling the venue by hand.

## Two builds, and why

Art-Net and sACN are UDP, and **a browser cannot receive UDP** — there is no
flag, polyfill or workaround. So simpleVIS ships two targets from one codebase:

| Build | What it is | Live input |
|---|---|---|
| **Desktop** (Tauri v2) | the real tool | Art-Net, sACN, USB DMX |
| **Hosted** | offline previz and plot viewer in a tab | none — built-in demo look |

The shared code is identical; only the transport differs. The hosted build
*hides* what it cannot do rather than offering controls that fail.

## Import

**MVR** (`.mvr`), including the GDTF fixture definitions embedded inside it —
geometry tree, DMX modes, beam angles, colour mixing. Import only; simpleVIS
never writes MVR.

Pixel-mapped fixtures work: an MVR whose LED wall declares four template
channels across a hundred `GeometryReference`s is correctly resolved to its real
300-channel footprint, one DMX slot per pixel.

## Input

| Protocol | Notes |
|---|---|
| **sACN** (E1.31) | Priority arbitration, CID source identity, multicast group joins per patched universe |
| **Art-Net 4** | ArtDmx, ArtPoll replies so consoles list simpleVIS as a node |
| **USB DMX** | Enttec DMX USB Pro. An *Open* DMX USB has no receive path and cannot be an input |

Two sources per universe are merged HTP or LTP with a 4-second timeout; a third
is refused and reported rather than silently dropped.

**CITP is not implemented yet** (v0.2.0). Worth stating plainly because it is
often assumed to carry levels and does not: CITP is discovery, *patch* exchange
and streaming the viewport back to the console. Levels always arrive over
Art-Net or sACN.

<!-- downloads:start -->
<!-- downloads:end -->

## Development

```bash
npm install
npm test --workspaces
npm run dev --workspace=@simplevis/app
```

See [CLAUDE.md](CLAUDE.md) for commands and [AGENTS.md](AGENTS.md) for the
design notes, load-bearing invariants, and the file-format traps found building
this — including the several ways an MVR will quietly render wrong.

## Verified vs assumed

The short version: the import chain, DMX evaluation and protocol parsers are
tested against real files and real packet layouts; **nothing has been driven by
a real console or a real DMX interface yet**. [AGENTS.md](AGENTS.md) has the
precise account, and it is kept honest.

## Licence

MIT. See [LICENSE](LICENSE).
