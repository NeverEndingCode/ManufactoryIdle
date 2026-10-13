# calibration-fixture — frozen; never tune this bundle

A copy of the vertical slice's **authored** files, frozen on 2026-10-12 (from `main` at
`af8b35a`). It exists for one consumer: the calibrator's mechanics tests in
`apps/sim/src/calibrate.test.ts`.

Those tests assert things like "this bundle measurably cannot reach that target" or "this
ceiling falls short". Run against the live slice, every content edit moved those premises
underneath them: four times a test went on passing after the thing it asserted had
stopped being true, and one spent 23 minutes doing the expensive fit it exists to prove is
skipped (see `docs/superpowers/plans/2026-09-16-phase-2-handoff.md`, "Test-fixture
coupling").

Rules:

- **Never calibrate it.** It has no `derived.yaml`, and should never get one.
- **Never edit it to follow the slice.** It is meant to drift from the slice. Content
  changes go to `bundles/vertical-slice/`.
- **Edit it only together with the tests that measure it.** When you do, re-measure the
  premise each affected test states in its comment, not just its assertion.

The live slice keeps two canaries in `calibrate.test.ts` so the calibrator is still
exercised on real content: the authored-numbers guard and "moves an observed tier time
onto its target".
