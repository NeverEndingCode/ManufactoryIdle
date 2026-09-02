# @manufactory/rational

BigInt-backed exact rational arithmetic.

## Attribution

This package is vendored from
[EvanTrow/Satisfactory-Colab-Modeler](https://github.com/EvanTrow/Satisfactory-Colab-Modeler),
`packages/rational`, which is licensed GPL-3.0.

**Modified on 2026-09-01** by the Manufactory Idle project. Changes: package renamed
from `@scm/rational` to `@manufactory/rational`; build script changed to typecheck-only
because this workspace consumes packages from source; tsconfig re-parented to this
repository's `tsconfig.base.json`. No changes to the arithmetic itself.

**Modified on 2026-09-02.** `powerAtClock` and `toApproximateNumber` (in
`power.ts`) removed from the package's barrel export (`src/index.ts`). Manufactory
Idle's spec has no overclock-power mechanic, and leaving them reachable from
`@manufactory/rational` would let engine code bypass the project's ban on
transcendental functions in state-affecting paths (`packages/engine` may import
this package unconditionally, and `powerAtClock` calls `Math.pow`). `power.ts`
and its tests are unchanged and still on disk, just no longer exported.

Manufactory Idle is a derivative work and is likewise licensed GPL-3.0. See the
repository root `LICENSE`.
