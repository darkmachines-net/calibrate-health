# Removed release machinery

Legacy release readers, importers, recovery runners, signer-import tooling and prototype parity snapshots are removed in the shared toolkit. Calibrate no longer supplies baseline bootstrap logic or legacy settings mappings. The standard Android signing inputs replace toolkit-specific secret aliases.

The installed toolkit replaces copied engine snapshots and consumer lifecycle code. Application builders and assertions remain here. See [cutover](release-cutover.md) for the new-history and credential setup requirements and the PR description for footprint measurements.
