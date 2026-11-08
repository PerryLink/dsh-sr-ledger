/**
 * PRISMA 2020 counts, integrity checks and exports.
 *
 * Counts are derived from the append-only decisions wherever possible; the few
 * boxes that cannot be derived (records identified per source, duplicates
 * removed, reports not retrieved) come from the protocol and are labelled as
 * manual. Conflicts are surfaced, never silently resolved.
 *
 * @module dsh-sr-ledger/prisma
 */

import type { AssessmentLine, DecisionLine, ImportedRecord, ReviewSpec, ScreeningState } from './ledger.ts'
import { SrLedger } from './ledger.ts'

/** The PRISMA 2020 counts. */
export interface PrismaCounts {
  readonly identified: number
  readonly identifiedManual: boolean
  readonly duplicatesRemoved: number
  readonly screened: number
  readonly excludedTitleAbstract: number
  readonly soughtForRetrieval: number
  readonly reportsNotRetrieved: number
  readonly assessedForEligibility: number
  readonly excludedFullText: number
  readonly excludedFullTextReasons: ReadonlyArray<{ readonly reason: string; readonly count: number }>
  readonly included: number
  readonly reportsOfIncludedStudies: number
  readonly conflicts: number
  readonly recordsWithoutDecision: number
}

/** One integrity problem. */
export interface LedgerIssue {
  readonly code: string
  readonly severity: 'error' | 'warning'
  readonly detail: string
}

/** The full PRISMA computation. */
export interface PrismaResult {
  readonly counts: PrismaCounts
  readonly states: readonly ScreeningState[]
  readonly issues: readonly LedgerIssue[]
  readonly robSummary: ReadonlyArray<{ readonly tool: string; readonly domain: string; readonly judgement: string; readonly count: number }>
  readonly assessedRecords: readonly string[]
}

/** Count final decisions at one stage. */
function finalDecisions(states: readonly ScreeningState[], stage: ScreeningState['stage']): ScreeningState[] {
  return states.filter(state => state.stage === stage && state.final !== undefined)
}

/**
 * Compute the PRISMA boxes and integrity issues.
 * @param review - the protocol.
 * @param records - imported records.
 * @param decisions - decision lines.
 * @param assessments - RoB/GRADE lines.
 * @returns counts, states, issues and assessment summary.
 */
export function computePrisma(
  review: ReviewSpec,
  records: readonly ImportedRecord[],
  decisions: readonly DecisionLine[],
  assessments: readonly AssessmentLine[],
): PrismaResult {
  const states = SrLedger.foldStates(decisions)
  const ta = finalDecisions(states, 'title-abstract')
  const ft = finalDecisions(states, 'full-text')
  const identifiedSum = review.identification.reduce((sum, entry) => sum + entry.count, 0)
  const identifiedManual = identifiedSum > 0
  const identified = identifiedManual ? identifiedSum : records.length
  const duplicatesRemoved = review.manual?.duplicatesRemoved ?? 0
  const excludedTitleAbstract = ta.filter(state => state.final === 'exclude').length
  const soughtForRetrieval = ta.filter(state => state.final === 'include').length
  const reportsNotRetrieved = review.manual?.recordsNotRetrieved ?? 0
  const excludedFull = ft.filter(state => state.final === 'exclude')
  const included = ft.filter(state => state.final === 'include').length
  const reasonCounts = new Map<string, number>()
  for (const state of excludedFull) {
    const reason = state.adjudication?.reason ?? Object.values(state.byReviewer)[0]?.reason ?? '(no reason)'
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1)
  }

  const issues: LedgerIssue[] = []
  const recordIds = new Set(records.map(record => record.recordId))
  const seen = new Set<string>()
  for (const decision of decisions) {
    if (!recordIds.has(decision.recordId)) {
      issues.push({ code: 'unknown_record', severity: 'error', detail: `a decision references an unknown record: ${decision.recordId}` })
    }
    if (decision.decision === 'exclude' && (decision.reason === undefined || decision.reason.trim() === '')) {
      issues.push({ code: 'exclude_without_reason', severity: 'error', detail: `an exclusion by ${decision.reviewer} on ${decision.recordId} (${decision.stage}) has no reason` })
    }
    const key = `${decision.recordId}:${decision.stage}:${decision.reviewer}:${decision.role}`
    if (seen.has(key)) {
      issues.push({ code: 'duplicate_decision', severity: 'warning', detail: `${decision.reviewer} decided ${decision.recordId} (${decision.stage}) more than once; the latest line wins` })
    }
    seen.add(key)
  }
  const taByRecord = new Map(ta.map(state => [state.recordId, state]))
  for (const state of ft) {
    const earlier = taByRecord.get(state.recordId)
    if (state.final === 'include' && (earlier === undefined || earlier.final !== 'include')) {
      issues.push({ code: 'full_text_without_ta_include', severity: 'warning', detail: `${state.recordId} was included at full text but not at title/abstract` })
    }
  }
  for (const state of states) {
    if (state.adjudication !== undefined) {
      const reviewers = Object.values(state.byReviewer)
      const disagreed = reviewers.length > 1 && new Set(reviewers.map(line => line.decision)).size > 1
      if (!disagreed) {
        issues.push({ code: 'adjudication_without_conflict', severity: 'error', detail: `an adjudication was recorded for ${state.recordId} (${state.stage}) but the reviewers did not disagree` })
      }
    }
  }
  const unresolved = states.filter(state => state.conflict).length
  if (unresolved > 0) issues.push({ code: 'open_conflicts', severity: 'warning', detail: `${unresolved} screening conflict(s) are unresolved` })
  if (!identifiedManual) issues.push({ code: 'identification_counts_missing', severity: 'warning', detail: 'no per-source identification counts; PRISMA identification falls back to the imported record count' })
  if (records.length === 0) issues.push({ code: 'no_records', severity: 'warning', detail: 'no records have been imported' })

  const screenedIds = new Set(ta.map(state => state.recordId))
  const includedIds = new Set(ft.filter(state => state.final === 'include').map(state => state.recordId))
  const assessedIds = new Set(assessments.map(line => line.recordId))
  for (const recordId of includedIds) {
    if (!assessedIds.has(recordId)) issues.push({ code: 'included_without_assessment', severity: 'warning', detail: `${recordId} is included but has no RoB/GRADE assessment` })
  }
  for (const recordId of assessedIds) {
    if (!includedIds.has(recordId)) issues.push({ code: 'assessment_of_excluded', severity: 'warning', detail: `${recordId} has an assessment but is not included` })
  }

  const robCounts = new Map<string, number>()
  for (const line of assessments) {
    const key = `${line.tool}\u0000${line.domain}\u0000${line.judgement}`
    robCounts.set(key, (robCounts.get(key) ?? 0) + 1)
  }

  return {
    counts: {
      identified,
      identifiedManual,
      duplicatesRemoved,
      screened: Math.max(0, identified - duplicatesRemoved),
      excludedTitleAbstract,
      soughtForRetrieval,
      reportsNotRetrieved,
      assessedForEligibility: Math.max(0, soughtForRetrieval - reportsNotRetrieved),
      excludedFullText: excludedFull.length,
      excludedFullTextReasons: [...reasonCounts.entries()].map(([reason, count]) => ({ reason, count })),
      included,
      reportsOfIncludedStudies: review.manual?.reportsOfIncludedStudies ?? included,
      conflicts: unresolved,
      recordsWithoutDecision: records.filter(record => !screenedIds.has(record.recordId)).length,
    },
    states,
    issues,
    robSummary: [...robCounts.entries()].map(([key, count]) => {
      const [tool, domain, judgement] = key.split('\u0000') as [string, string, string]
      return { tool, domain, judgement, count }
    }),
    assessedRecords: [...assessedIds],
  }
}

/**
 * Render the PRISMA flow as Markdown.
 * @param review - the protocol.
 * @param result - the computation.
 * @returns the Markdown report.
 */
export function renderPrismaMarkdown(review: ReviewSpec, result: PrismaResult): string {
  const counts = result.counts
  const lines = [`# PRISMA 2020 flow — ${review.title}`, '']
  lines.push(`**Review id:** \`${review.reviewId}\` · **revision:** ${review.revision} · **updated:** ${review.updatedAt}`)
  lines.push('')
  lines.push('| Stage | Count |')
  lines.push('|---|---:|')
  lines.push(`| Records identified${counts.identifiedManual ? '' : ' (fallback: imported records)'} | ${counts.identified} |`)
  lines.push(`| Duplicates removed | ${counts.duplicatesRemoved} |`)
  lines.push(`| Records screened | ${counts.screened} |`)
  lines.push(`| Records excluded at title/abstract | ${counts.excludedTitleAbstract} |`)
  lines.push(`| Reports sought for retrieval | ${counts.soughtForRetrieval} |`)
  lines.push(`| Reports not retrieved | ${counts.reportsNotRetrieved} |`)
  lines.push(`| Reports assessed for eligibility | ${counts.assessedForEligibility} |`)
  lines.push(`| Reports excluded at full text | ${counts.excludedFullText} |`)
  lines.push(`| Studies included in review | ${counts.included} |`)
  lines.push(`| Reports of included studies | ${counts.reportsOfIncludedStudies} |`)
  lines.push(`| Open screening conflicts | ${counts.conflicts} |`)
  lines.push(`| Records without a title/abstract decision | ${counts.recordsWithoutDecision} |`)
  lines.push('')
  if (counts.excludedFullTextReasons.length > 0) {
    lines.push('## Full-text exclusions by reason')
    lines.push('')
    lines.push('| Reason | Count |')
    lines.push('|---|---:|')
    for (const entry of counts.excludedFullTextReasons) lines.push(`| ${entry.reason.replace(/\|/gu, '\\|')} | ${entry.count} |`)
    lines.push('')
  }
  lines.push('## Risk of bias / certainty')
  lines.push('')
  if (result.robSummary.length === 0) {
    lines.push('No RoB/GRADE assessment has been recorded.')
  } else {
    lines.push('| Tool | Domain | Judgement | Studies |')
    lines.push('|---|---|---|---:|')
    for (const entry of result.robSummary) lines.push(`| ${entry.tool} | ${entry.domain} | ${entry.judgement} | ${entry.count} |`)
  }
  lines.push('')
  if (result.issues.length > 0) {
    lines.push('## Ledger issues')
    lines.push('')
    for (const issue of result.issues) lines.push(`- **${issue.severity}** ${issue.code}: ${issue.detail}`)
    lines.push('')
  }
  lines.push('> Counts are derived from the append-only decision ledger; manual boxes are labelled. A conflict is reported, never silently resolved.')
  return `${lines.join('\n')}\n`
}

/**
 * Render the evidence table (one row per included study).
 * @param review - the protocol.
 * @param result - the computation.
 * @param records - imported records.
 * @param assessments - assessment lines.
 * @returns the Markdown table.
 */
export function renderEvidenceTable(
  review: ReviewSpec,
  result: PrismaResult,
  records: readonly ImportedRecord[],
  assessments: readonly AssessmentLine[],
): string {
  const included = new Set(result.states.filter(state => state.stage === 'full-text' && state.final === 'include').map(state => state.recordId))
  const lines = [`# Evidence table — ${review.title}`, '']
  lines.push('| Record | Study | Year | Identifiers | RoB/GRADE |')
  lines.push('|---|---|---:|---|---|')
  for (const record of records.filter(item => included.has(item.recordId))) {
    const rows = assessments.filter(line => line.recordId === record.recordId)
    const judgement = rows.length === 0 ? 'not assessed' : rows.map(row => `${row.tool}/${row.domain}: ${row.judgement}`).join('; ')
    const identifiers = [record.doi === undefined ? '' : `doi:${record.doi}`, record.pmid === undefined ? '' : `pmid:${record.pmid}`, record.arxiv === undefined ? '' : `arXiv:${record.arxiv}`].filter(Boolean).join(' ')
    lines.push(`| ${record.recordId} | ${record.title.replace(/\|/gu, '\\|')} | ${record.year ?? ''} | ${identifiers} | ${judgement} |`)
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}
