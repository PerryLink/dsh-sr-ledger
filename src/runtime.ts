/**
 * Runtime: protocol revisions, screening, adjudication, assessments and the
 * export bundle. All writes go to the ledger root; nothing is edited in place.
 * @module dsh-sr-ledger/runtime
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { stableId } from '@perrylink/dsh-research-core'
import type { ResolvedConfig } from './config.ts'
import {
  SrLedger,
  type AssessmentLine,
  type DecisionLine,
  type ImportedRecord,
  type ReviewSpec,
  type ScreenDecision,
  type ScreenStage,
  type ScreeningState,
} from './ledger.ts'
import { computePrisma, renderEvidenceTable, renderPrismaMarkdown, type PrismaCounts, type PrismaResult } from './prisma.ts'

/** Stable error codes. */
export type SrErrorCode = 'INVALID_INPUT' | 'NOT_INITIALIZED' | 'RECORD_UNKNOWN' | 'NO_CONFLICT' | 'IO'

/** A typed failure. */
export class SrError extends Error {
  /** Stable code. */
  readonly code: SrErrorCode

  constructor(code: SrErrorCode, message: string) {
    super(message)
    this.name = 'SrError'
    this.code = code
  }
}

/** Input for {@link SrRuntime.init}. */
export interface InitRequest {
  readonly title?: string
  readonly pico?: ReviewSpec['pico']
  readonly criteria?: ReviewSpec['criteria']
  readonly identification?: ReviewSpec['identification']
  readonly manual?: ReviewSpec['manual']
  readonly records?: Array<{ title: string; authors?: string[]; year?: number; doi?: string; pmid?: string; arxiv?: string }>
}

/** Result of {@link SrRuntime.init}. */
export interface InitResult {
  readonly ok: true
  readonly review: ReviewSpec
  readonly imported: { readonly added: number; readonly skipped: number }
  readonly recordCount: number
}

/** Input for {@link SrRuntime.screen}. */
export interface ScreenRequest {
  readonly recordId: string
  readonly reviewer: string
  readonly stage: ScreenStage
  readonly decision: ScreenDecision
  readonly reason?: string
  readonly role?: 'reviewer' | 'adjudicator'
  readonly assessment?: {
    readonly tool: AssessmentLine['tool']
    readonly domain: string
    readonly judgement: AssessmentLine['judgement']
    readonly note?: string
  }
}

/** Result of {@link SrRuntime.screen}. */
export interface ScreenResult {
  readonly ok: true
  readonly state: ScreeningState
  readonly openConflicts: number
  readonly assessment?: AssessmentLine
}

/** Result of {@link SrRuntime.prisma}. */
export interface PrismaExport {
  readonly counts: PrismaCounts
  readonly issues: PrismaResult['issues']
  readonly robSummary: PrismaResult['robSummary']
  readonly integrity: { readonly ok: boolean; readonly issues: readonly string[]; readonly events: number }
  readonly exports: {
    readonly prismaJson: string
    readonly prismaMarkdown: string
    readonly evidenceTable: string
    readonly ledgerJson: string
  }
}

/** Throw a stable INVALID_INPUT failure. */
function invalid(message: string): never {
  throw new SrError('INVALID_INPUT', message)
}

/** True when `value` is a non-null object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Require a non-empty string and return it trimmed. */
function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') invalid(`${field} must be a non-empty string`)
  return value.trim()
}

/** Require a non-negative safe integer. */
function requireCount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(`${field} must be a non-negative safe integer`)
  return value as number
}

/** Validate optional text without changing it. */
function optionalText(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== 'string') invalid(`${field} must be a string`)
}

const ASSESSMENT_TOOLS = ['RoB2', 'ROBINS-I', 'GRADE'] as const
const ASSESSMENT_JUDGEMENTS = ['low', 'some-concerns', 'high', 'unclear'] as const

/** Validate everything `sr_init` accepts before touching the ledger. */
function validateInit(request: InitRequest): void {
  if (!isRecord(request)) invalid('request must be an object')
  if (request.title !== undefined) requireText(request.title, 'title')
  if (request.criteria !== undefined) {
    if (!isRecord(request.criteria)) invalid('criteria must be an object')
    for (const key of ['include', 'exclude'] as const) {
      const list = request.criteria[key]
      if (!Array.isArray(list) || list.some(item => typeof item !== 'string')) invalid(`criteria.${key} must be an array of strings`)
    }
  }
  if (request.identification !== undefined) {
    if (!Array.isArray(request.identification)) invalid('identification must be an array')
    for (const entry of request.identification) {
      if (!isRecord(entry)) invalid('identification entries must be objects')
      requireText(entry['source'], 'identification[].source')
      requireCount(entry['count'], 'identification[].count')
    }
  }
  if (request.manual !== undefined) {
    if (!isRecord(request.manual)) invalid('manual must be an object')
    const manual = request.manual as unknown as Record<string, unknown>
    for (const key of ['duplicatesRemoved', 'recordsNotRetrieved', 'reportsOfIncludedStudies', 'previousStudiesIncluded']) {
      if (manual[key] !== undefined) requireCount(manual[key], `manual.${key}`)
    }
  }
  if (request.pico !== undefined) {
    if (!isRecord(request.pico)) invalid('pico must be an object')
    const pico = request.pico as unknown as Record<string, unknown>
    for (const key of ['population', 'intervention', 'comparison', 'outcome']) optionalText(pico[key], `pico.${key}`)
  }
  if (request.records !== undefined) {
    if (!Array.isArray(request.records)) invalid('records must be an array')
    for (const item of request.records) {
      if (!isRecord(item)) invalid('records entries must be objects')
      requireText(item['title'], 'records[].title')
      if (item['authors'] !== undefined && (!Array.isArray(item['authors']) || item['authors'].some(author => typeof author !== 'string'))) {
        invalid('records[].authors must be an array of strings')
      }
      if (item['year'] !== undefined) requireCount(item['year'], 'records[].year')
      for (const key of ['doi', 'pmid', 'arxiv'] as const) {
        if (item[key] !== undefined) requireText(item[key], `records[].${key}`)
      }
    }
  }
}

/** Validate everything `sr_screen` accepts before touching the ledger. */
function validateScreen(request: ScreenRequest): void {
  if (!isRecord(request)) invalid('request must be an object')
  requireText(request.recordId, 'recordId')
  requireText(request.reviewer, 'reviewer')
  if (request.stage !== 'title-abstract' && request.stage !== 'full-text') invalid('stage must be title-abstract or full-text')
  if (request.decision !== 'include' && request.decision !== 'exclude') invalid('decision must be include or exclude')
  if (request.decision === 'exclude' && (typeof request.reason !== 'string' || request.reason.trim() === '')) {
    invalid('an exclusion requires a reason (PRISMA requires the exclusion reason)')
  }
  optionalText(request.reason, 'reason')
  if (request.role !== undefined && request.role !== 'reviewer' && request.role !== 'adjudicator') {
    invalid('role must be reviewer or adjudicator')
  }
  if (request.assessment !== undefined) {
    const assessment = request.assessment
    if (!isRecord(assessment)) invalid('assessment must be an object')
    if (!ASSESSMENT_TOOLS.includes(assessment['tool'] as (typeof ASSESSMENT_TOOLS)[number])) {
      invalid(`assessment.tool must be one of ${ASSESSMENT_TOOLS.join(', ')}`)
    }
    requireText(assessment['domain'], 'assessment.domain')
    if (!ASSESSMENT_JUDGEMENTS.includes(assessment['judgement'] as (typeof ASSESSMENT_JUDGEMENTS)[number])) {
      invalid(`assessment.judgement must be one of ${ASSESSMENT_JUDGEMENTS.join(', ')}`)
    }
    optionalText(assessment['note'], 'assessment.note')
  }
}

/** Options for {@link SrRuntime}. */
export interface SrRuntimeOptions {
  readonly config: ResolvedConfig
  readonly now?: () => Date
}

/** The runtime. */
export class SrRuntime {
  readonly config: ResolvedConfig
  readonly #now: () => Date

  constructor(options: SrRuntimeOptions) {
    this.config = options.config
    this.#now = options.now ?? (() => new Date())
  }

  /** Current ISO timestamp. */
  iso(): string {
    return this.#now().toISOString()
  }

  /** The ledger handle. */
  ledger(): SrLedger {
    return new SrLedger({ root: this.config.root, now: this.#now })
  }

  /**
   * Create or revise the protocol and import records.
   * @param request - protocol fields and records.
   * @returns the protocol and import counts.
   */
  async init(request: InitRequest): Promise<InitResult> {
    validateInit(request)
    const ledger = this.ledger()
    const existing = await ledger.review()
    const at = this.iso()
    const title = request.title ?? existing?.title
    if (title === undefined || title.trim() === '') throw new SrError('INVALID_INPUT', 'title is required when the review does not exist yet')
    const pico = request.pico ?? existing?.pico
    const manual = request.manual ?? existing?.manual
    const review: ReviewSpec = {
      reviewId: existing?.reviewId ?? stableId('rev', [title, at]),
      title,
      ...(pico === undefined ? {} : { pico }),
      criteria: request.criteria ?? existing?.criteria ?? { include: [], exclude: [] },
      identification: request.identification ?? existing?.identification ?? [],
      ...(manual === undefined ? {} : { manual }),
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
      revision: (existing?.revision ?? 0) + 1,
    }
    await ledger.writeReview(review)
    let added = 0
    let skipped = 0
    if (request.records !== undefined && request.records.length > 0) {
      const records: ImportedRecord[] = request.records.map(item => ({
        recordId: SrLedger.recordIdOf({ title: item.title, ...(item.doi === undefined ? {} : { doi: item.doi }), ...(item.pmid === undefined ? {} : { pmid: item.pmid }), ...(item.arxiv === undefined ? {} : { arxiv: item.arxiv }) }),
        title: item.title,
        ...(item.authors === undefined ? {} : { authors: item.authors }),
        ...(item.year === undefined ? {} : { year: item.year }),
        ...(item.doi === undefined ? {} : { doi: item.doi }),
        ...(item.pmid === undefined ? {} : { pmid: item.pmid }),
        ...(item.arxiv === undefined ? {} : { arxiv: item.arxiv }),
        importedAt: at,
      }))
      const result = await ledger.appendRecords(records)
      added = result.added
      skipped = result.skipped
    }
    return { ok: true, review, imported: { added, skipped }, recordCount: (await ledger.records()).length }
  }

  /**
   * Record a screening decision, an adjudication, and/or an assessment.
   * @param request - the decision.
   * @returns the resulting state and open conflict count.
   */
  async screen(request: ScreenRequest): Promise<ScreenResult> {
    validateScreen(request)
    const ledger = this.ledger()
    const review = await ledger.review()
    if (review === undefined) throw new SrError('NOT_INITIALIZED', 'call sr_init before screening')
    const records = await ledger.records()
    if (!records.some(record => record.recordId === request.recordId)) {
      throw new SrError('RECORD_UNKNOWN', `unknown record ${request.recordId}; import it with sr_init first`)
    }
    const role = request.role ?? 'reviewer'
    if (role === 'adjudicator') {
      const states = SrLedger.foldStates(await ledger.decisions())
      const state = states.find(item => item.recordId === request.recordId && item.stage === request.stage)
      if (state === undefined || !state.conflict) {
        throw new SrError('NO_CONFLICT', 'there is no unresolved conflict at this record/stage to adjudicate')
      }
    }
    const at = this.iso()
    // Validate and build the assessment before the decision is appended: an
    // invalid assessment must not leave a half-recorded screening line behind.
    let assessment: AssessmentLine | undefined
    if (request.assessment !== undefined) {
      const { tool, domain, judgement, note } = request.assessment
      assessment = {
        recordId: request.recordId,
        tool,
        domain: domain.trim(),
        judgement,
        ...(note === undefined ? {} : { note }),
        reviewer: request.reviewer.trim(),
        at,
      }
    }
    const line: DecisionLine = {
      recordId: request.recordId,
      reviewer: request.reviewer.trim(),
      stage: request.stage,
      decision: request.decision,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      role,
      at,
    }
    await ledger.appendDecision(line)
    if (assessment !== undefined) await ledger.appendAssessment(assessment)
    const states = SrLedger.foldStates(await ledger.decisions())
    const state = states.find(item => item.recordId === request.recordId && item.stage === request.stage)!
    const openConflicts = states.filter(item => item.conflict).length
    return { ok: true, state, openConflicts, ...(assessment === undefined ? {} : { assessment }) }
  }

  /**
   * Compute PRISMA counts, verify the audit chain and write the export bundle.
   * @returns counts, issues, RoB summary, integrity and export paths.
   */
  async prisma(): Promise<PrismaExport> {
    const ledger = this.ledger()
    const review = await ledger.review()
    if (review === undefined) throw new SrError('NOT_INITIALIZED', 'call sr_init before sr_prisma')
    const [records, decisions, assessments] = await Promise.all([ledger.records(), ledger.decisions(), ledger.assessments()])
    const result = computePrisma(review, records, decisions, assessments)
    const integrity = await ledger.integrity()
    const base = this.config.root
    await mkdir(ledger.paths.exports, { recursive: true })
    const prismaJson = path.join(ledger.paths.exports, 'prisma.json')
    const prismaMarkdown = path.join(ledger.paths.exports, 'prisma.md')
    const evidenceTable = path.join(ledger.paths.exports, 'evidence-table.md')
    const ledgerJson = path.join(ledger.paths.exports, 'ledger.json')
    await writeFile(prismaJson, `${JSON.stringify({ review, counts: result.counts, issues: result.issues, robSummary: result.robSummary }, null, 2)}\n`, 'utf8')
    await writeFile(prismaMarkdown, renderPrismaMarkdown(review, result), 'utf8')
    await writeFile(evidenceTable, renderEvidenceTable(review, result, records, assessments), 'utf8')
    await writeFile(ledgerJson, `${JSON.stringify({ review, records, decisions, assessments, states: result.states }, null, 2)}\n`, 'utf8')
    return {
      counts: result.counts,
      issues: result.issues,
      robSummary: result.robSummary,
      integrity,
      exports: {
        prismaJson: path.relative(base, prismaJson),
        prismaMarkdown: path.relative(base, prismaMarkdown),
        evidenceTable: path.relative(base, evidenceTable),
        ledgerJson: path.relative(base, ledgerJson),
      },
    }
  }
}
