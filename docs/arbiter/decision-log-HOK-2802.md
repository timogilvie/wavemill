# Decision Log Entry - HOK-2802

Date: 2026-09-09 America/New_York

Entry:

**2026-09-09 · HOK-2802 · wavemill → data pipeline / website / SDK** — Phase 1 takes the decision-layer branch. The incumbent-judge replay flipped 35/155 hydrated pairs, 22.6% (95% Wilson CI 16.7%-29.8%), and the flip curve rose by collapsed difficulty: 2/16 easy, 12.5% (3.5%-36.0%); 7/50 medium, 14.0% (7.0%-26.2%); 13/52 hard, 25.0% (15.2%-38.2%); 11/32 very hard, 34.4% (20.4%-51.7%). Probe B kept-side 30-day survival agreement was 3/98, 3.1% (1.0%-8.6%), with 34 no-label and 24 missing-horizon exclusions under the strict R5 survival mapping. Probe C comparison/eval disagreement was 33/143 non-tie analyzed pairs, 23.1% (16.9%-30.6%), with recovered challenge-type disagreement at coder-only 20/80, 25.0% (16.8%-35.5%); multi-variable 7/27, 25.9% (13.2%-44.7%); and reviewer-only 6/20, 30.0% (14.5%-51.9%). The surface is not flat and above 90% agreement everywhere, so `arbitrate()` remains a model rather than collapsing to a de-noising feature; Showdown v0 remains in scope; Arbiter Phases 2-4 proceed as planned. The scanner proceeds in either branch: Phase 1 gates the pairwise model story, not scan, report, or Check. Closing HOK-2802 lifts the generator-measurement freeze for developing and landing `challenge.fork()`, but it does not authorize live stage-attributed reviewer comparisons until P2.4's validity contract, direct review evidence, executed-model identity, lifecycle safety, reviewer-stage adjudication, and integration-test gates pass. Evidence: wavemill `docs/arbiter/p1-3-phase-1-write-up.md`; swap run `p1-3-incumbent-2026-09-09-usable`; git `c09e74b55765306b864b169eb4a91094769d599f`; corpus SHA-256 `d4f592613dc96c812213680c4001add5b9aee0486f50dd77a9a7aefdc21b7e2c`; eval SHA-256 `aa8a069c0182ca420a837b18a333783417bcd081c99c409b094acf47c1f56d8b`. Affects: HOK-2810-HOK-2815, HOK-2968-HOK-2970, HOK-2817-HOK-2835.

Immediate effects:

- `arbitrate()` remains on the decision-layer/model path.
- Showdown v0 remains part of the public pairwise proof point.
- Arbiter P2, P3, and P4 remain in scope as planned; no P3/P4 de-noising re-scope is required.
- The scanner, report, and Check proceed regardless of the model gate outcome.
- `challenge.fork()` development/landing is unblocked from the Phase 1 generator freeze.
- Reviewer-stage rollout remains blocked until P2.4 gates pass.
