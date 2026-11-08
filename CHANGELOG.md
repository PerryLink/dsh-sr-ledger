# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-11-08

### Fixed

- hash-chained protocol history.

## [0.1.1] - 2026-11-08

### Changed

- Release-engineering refresh: CHANGELOG accuracy, package metadata and authors; no runtime changes.

## [0.1.0] - 2026-11-08

### Added

- `review-history.jsonl`: every full protocol revision is appended before
  `review.json` is updated, so the criteria behind a past decision remain
  reconstructable.

### Fixed

- Validate `sr_init` records/identification/manual counts and `sr_screen`
  reviewer/stage/decision/role/assessment before any write.
- Build and validate the assessment before appending the decision: an invalid
  assessment no longer leaves a half-recorded screening line behind.
- Map unexpected ledger read failures to the documented `IO` error code instead
  of letting the tool throw.
- Count `recordsWithoutDecision` from the imported record ids rather than
  subtracting state rows (which included unknown-record decisions).

### Changed

- Test count is now 16; README/CHANGELOG list the new failure branches.

First release: the systematic-review ledger.

### Added

- `sr_init`: protocol revisions (PICO, criteria, identification counts, manual
  PRISMA boxes) and record import with DOI/PMID/arXiv/title deduplication.
- `sr_screen`: dual screening at title/abstract and full text, conflict
  detection, adjudicator-only resolution, exclusion reasons enforced, and
  RoB 2 / ROBINS-I / GRADE assessment lines in the same ledger.
- `sr_prisma`: derived PRISMA 2020 counts, exclusion-reason table, RoB summary,
  integrity issues, audit-chain verification, and an export bundle
  (`prisma.json`, `prisma.md`, `evidence-table.md`, `ledger.json`).
- Append-only journals with hash-chained audit events (REP core helpers).
- 12 tests covering the invariants and the end-to-end flow.

### Notes

- The ledger records; it does not search, retrieve or analyse. Screening and
  RoB judgements are human decisions.
