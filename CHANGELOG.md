# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-08

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
