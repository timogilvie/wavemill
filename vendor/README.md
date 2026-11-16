# Pinned SDK contract build

`hokusai-core-0.8.0-hok3495-54bb506.tgz` is an immutable build of `@hokusai/core` from the owning SDK commit `54bb50668f236febbf2b58fa4bceed8798ed5466` on `feature/hok3495-provider-evidence` in Hokusai-protocol/hokusai-sdk. It includes the HOK-3495 canonical provider contract. Wavemill does not fork the contract or require an unpublished npm version. The existing package version remains 0.8.0; the file dependency, commit and lockfile integrity identify the additive build.

SHA-256: `c13d9ad19b5e71875a48c58083de07b15365267b363e2851fe656af0b2e8b699`

To reproduce from that SDK commit: install its pinned pnpm dependencies, run `pnpm --filter @hokusai/core build`, then `npm pack ./packages/core --ignore-scripts --pack-destination <directory>`. The archive contains the built package and owning schemas; no secrets or local node_modules are included. npm archives may differ in packaging metadata, so validate the unpacked content as well as this stored archive's integrity.

A clean Wavemill `npm ci` installs this exact artifact from the committed file. Replace it with the SDK's published minor release once released; remove this archive and update both dependency files together. Canonical ingestion must be compatible before the producer is rolled out.
