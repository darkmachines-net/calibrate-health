# Shared release migration

The replacement toolkit removes legacy recovery and custom provider packaging. Calibrate retains release.config.json, application input/metadata hooks, its paired Android builder and binary assertions. The toolkit owns selection, reservations, candidates, provider operations, receipts, recovery, deployment transport and reusable workers.

Follow [release cutover](release-cutover.md) before the first new release. Both consumers use the same full toolkit SHA for their dependency and workflows. Run npm run release -- setup after installation; npm run test:release checks the current contract.

The PR description records current validation and measured footprint. Earlier prototype validation does not establish correctness of this replacement. Application IDs, signing identities, destinations, environment approvals, native handoff/completion ordering and deployment behavior are preserved.
