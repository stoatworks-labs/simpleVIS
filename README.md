# simpleVIS

A lightweight real-time lighting visualiser. Import an MVR, take live levels
over Art-Net, sACN or USB DMX, position a camera in 3D and watch your
programming in volumetric haze.

> **Status: early.** The import and DMX-evaluation core is built and tested
> against real manufacturer files. The renderer and the network input are not
> written yet. See [AGENTS.md](AGENTS.md) for a precise account of what is
> verified and what is not.

## What it is for

Seeing what a rig will do before you are in the room with it — checking coverage
and looks against a real patch, without a visualiser licence and without
modelling the venue by hand.

## Two builds

Art-Net and sACN are UDP, and a browser cannot receive UDP — there is no
workaround. So simpleVIS ships two targets from one codebase:

- **Desktop** (Tauri v2) — the real tool. Art-Net, sACN, USB DMX, CITP.
- **Hosted** — an offline previz and plot viewer in a tab. MVR import, 3D scene
  and camera; no live input.

## Supported input

| Protocol | Role |
|---|---|
| **sACN** (E1.31) | levels, with priority and source merging |
| **Art-Net 4** | levels |
| **USB DMX** | levels, via an Enttec DMX USB Pro |
| **CITP/FPTC** | fixture patch *from* the console |
| **CITP/CaSt** | viewport streamed *back* to the console |

CITP carries patch and streaming, not levels — levels always come over Art-Net
or sACN.

## Import

MVR (`.mvr`), including the GDTF fixture definitions embedded in it. Import
only — simpleVIS does not edit or write MVR.

## Development

See [CLAUDE.md](CLAUDE.md) for commands and [AGENTS.md](AGENTS.md) for the
design notes, invariants and the file-format traps found along the way.

## Licence

MIT. See [LICENSE](LICENSE).

---

*Built with AI assistance.*
