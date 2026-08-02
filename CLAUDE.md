# simpleVIS — command reference

Mental models, invariants and traps live in [AGENTS.md](AGENTS.md). This file is
just the commands.

## Test

```bash
npm test --workspaces
```

The core tests run against **MA Lighting's `Demostage_MVR.mvr`**, which is not
committed. It is found automatically in grandMA3's **resource library**
(`~/MALightingTechnology/<version>/shared/resource/lib_mvr/`) — the library
alone is enough; the console application does not have to be installed, and on
this machine it is not. Without it those
suites **skip** rather than fail — check the skip message before believing a
green run means everything passed.

Point them at a copy elsewhere with:

```bash
SIMPLEVIS_TEST_MVR=/path/to/Demostage_MVR.mvr npm test --workspaces
```

## Typecheck

```bash
npm run typecheck --workspaces
```

## Inspect a real MVR or GDTF by hand

Both are zips. The scene description is at the root of the `.mvr`; each fixture
type is a nested `.gdtf`, itself a zip holding `description.xml`.

```bash
unzip -l Demostage_MVR.mvr
```
