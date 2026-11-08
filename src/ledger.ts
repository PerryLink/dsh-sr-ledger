/**
 * The systematic-review ledger: an append-only, hash-chained record of the
 * protocol, the imported records, every screening decision (with reviewer and
 * stage), adjudications, and RoB/GRADE assessments.
 *
 * Nothing is ever edited in place: a revised protocol or a corrected decision is
 * a new line, so the review can be audited end to end. The audit chain uses the
 * REP core's hash-chain helpers.
 *
 * @module dsh-sr-ledger/ledger
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createAuditEvent, stableId, verifyAuditChain, type AuditEvent } from '@perrylink/dsh-research-core'

/** Screening stages in PRISMA order. */
export type ScreenStage = 'title-abstract' | 'full-text'

/** A screening decision. */
export type ScreenDecision = 'include' | 'exclude'

/** A decision line. */
export interface DecisionLine {
  readonly recordId: string
  readonly reviewer: string
  readonly stage: ScreenStage
  readonly decision: ScreenDecision
  readonly reason?: string
  /** `adjudicator` lines resolve a conflict and are final. */
  readonly role: 'reviewer' | 'adjudicator'
  readonly at: string
}

/** A RoB/GRADE assessment line. */
export interface AssessmentLine {
  readonly recordId: string
  readonly tool: 'RoB2' | 'ROBINS-I' | 'GRADE'
  readonly domain: string
  readonly judgement: 'low' | 'some-concerns' | 'high' | 'unclear'
  readonly note?: string
  readonly reviewer: string
  readonly at: string
}

/** The review protocol. */
export interface ReviewSpec {
  readonly reviewId: string
  readonly title: string
  readonly pico?: { readonly population?: string; readonly intervention?: string; readonly comparison?: string; readonly outcome?: string }
  readonly criteria: { readonly include: readonly string[]; readonly exclude: readonly string[] }
  /** Records identified per source (PRISMA identification box). */
  readonly identification: ReadonlyArray<{ readonly source: string; readonly count: number }>
  /** Manual PRISMA counts that cannot be derived from decisions. */
  readonly manual?: {
    readonly duplicatesRemoved?: number
    readonly recordsNotRetrieved?: number
    readonly reportsOfIncludedStudies?: number
    readonly previousStudiesIncluded?: number
  }
  readonly createdAt: string
  readonly updatedAt: string
  /** Monotonic protocol revision (each sr_init call bumps it). */
  readonly revision: number
}

/** An imported record. */
export interface ImportedRecord {
  readonly recordId: string
  readonly title: string
  readonly authors?: readonly string[]
  readonly year?: number
  readonly doi?: string
  readonly pmid?: string
  readonly arxiv?: string
  readonly importedAt: string
}

/** Options for {@link SrLedger}. */
export interface SrLedgerOptions {
  /** Absolute review root. */
  readonly root: string
  readonly now?: () => Date
}

/** Read a JSON file, or undefined when absent. */
async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`cannot read ${file}: ${(error as Error).message}`)
  }
}

/** Read one JSONL journal. */
async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    const text = await readFile(file, 'utf8')
    return text
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as T)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error(`cannot read ${file}: ${(error as Error).message}`)
  }
}

/** A per-record, per-stage screening state. */
export interface ScreeningState {
  readonly recordId: string
  readonly stage: ScreenStage
  /** Decisions by reviewer (latest line wins). */
  readonly byReviewer: Readonly<Record<string, DecisionLine>>
  /** The adjudicated decision, when one exists. */
  readonly adjudication?: DecisionLine
  /** Final decision: adjudication, single-reviewer decision, or agreed pair. */
  readonly final?: ScreenDecision
  /** True when reviewers disagree and no adjudication resolved it. */
  readonly conflict: boolean
}

/** The ledger. */
export class SrLedger {
  readonly root: string

  readonly #now: () => Date

  constructor(options: SrLedgerOptions) {
    this.root = path.resolve(options.root)
    this.#now = options.now ?? (() => new Date())
  }

  /** Current ISO timestamp. */
  iso(): string {
    return this.#now().toISOString()
  }

  /** File paths. */
  get paths(): Record<'review' | 'reviewHistory' | 'records' | 'decisions' | 'assessments' | 'audit' | 'exports', string> {
    return {
      review: path.join(this.root, 'review.json'),
      reviewHistory: path.join(this.root, 'review-history.jsonl'),
      records: path.join(this.root, 'records.jsonl'),
      decisions: path.join(this.root, 'decisions.jsonl'),
      assessments: path.join(this.root, 'assessments.jsonl'),
      audit: path.join(this.root, 'audit.jsonl'),
      exports: path.join(this.root, 'exports'),
    }
  }

  /** Ensure the directory skeleton exists. */
  async ensure(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    await mkdir(this.paths.exports, { recursive: true })
  }

  /** Read the protocol. */
  async review(): Promise<ReviewSpec | undefined> {
    return readJson<ReviewSpec>(this.paths.review)
  }

  /** Read every protocol revision, oldest first. */
  async reviewHistory(): Promise<ReviewSpec[]> {
    return readJsonl<ReviewSpec>(this.paths.reviewHistory)
  }

  /** Read imported records. */
  async records(): Promise<ImportedRecord[]> {
    return readJsonl<ImportedRecord>(this.paths.records)
  }

  /** Read decisions. */
  async decisions(): Promise<DecisionLine[]> {
    return readJsonl<DecisionLine>(this.paths.decisions)
  }

  /** Read assessments. */
  async assessments(): Promise<AssessmentLine[]> {
    return readJsonl<AssessmentLine>(this.paths.assessments)
  }

  /** Read the audit chain. */
  async audit(): Promise<AuditEvent[]> {
    return readJsonl<AuditEvent>(this.paths.audit)
  }

  /** Append one hash-chained audit event. */
  async #audit(type: string, payload: Record<string, unknown>): Promise<void> {
    await this.ensure()
    const events = await this.audit()
    const previous = events.at(-1)
    const event = createAuditEvent(
      {
        eventId: `evt-${String(events.length + 1).padStart(6, '0')}`,
        at: this.iso(),
        actor: 'human',
        type,
        payload,
        ...(previous === undefined ? {} : { prevHash: previous.hash }),
      },
      () => this.#now(),
    )
    await appendFile(this.paths.audit, `${JSON.stringify(event)}\n`, 'utf8')
  }

  /** Append one decision line. */
  async appendDecision(line: DecisionLine): Promise<void> {
    await this.ensure()
    await appendFile(this.paths.decisions, `${JSON.stringify(line)}\n`, 'utf8')
    await this.#audit('sr.decision', {
      recordId: line.recordId,
      reviewer: line.reviewer,
      stage: line.stage,
      decision: line.decision,
      role: line.role,
      ...(line.reason === undefined ? {} : { reason: line.reason }),
    })
  }

  /** Append one assessment line. */
  async appendAssessment(line: AssessmentLine): Promise<void> {
    await this.ensure()
    await appendFile(this.paths.assessments, `${JSON.stringify(line)}\n`, 'utf8')
    await this.#audit('sr.assessment', {
      recordId: line.recordId,
      tool: line.tool,
      domain: line.domain,
      judgement: line.judgement,
      reviewer: line.reviewer,
    })
  }

  /**
   * Write the protocol (new revision).
   * @param spec - the full protocol.
   */
  async writeReview(spec: ReviewSpec): Promise<void> {
    await this.ensure()
    // Preserve the full protocol revision before making it current: the audit
    // event only carries identity, so review-history.jsonl is what lets a
    // reviewer reconstruct the criteria a decision was made under.
    await appendFile(this.paths.reviewHistory, `${JSON.stringify(spec)}\n`, 'utf8')
    await writeFile(this.paths.review, `${JSON.stringify(spec, null, 2)}\n`, 'utf8')
    await this.#audit('sr.protocol', { reviewId: spec.reviewId, revision: spec.revision, title: spec.title })
  }

  /** Append imported records (deduplicated by recordId). */
  async appendRecords(records: readonly ImportedRecord[]): Promise<{ added: number; skipped: number }> {
    await this.ensure()
    const existing = new Set((await this.records()).map(record => record.recordId))
    let added = 0
    let skipped = 0
    for (const record of records) {
      if (existing.has(record.recordId)) {
        skipped += 1
        continue
      }
      await appendFile(this.paths.records, `${JSON.stringify(record)}\n`, 'utf8')
      existing.add(record.recordId)
      added += 1
    }
    if (added > 0) await this.#audit('sr.records', { added, skipped })
    return { added, skipped }
  }

  /** Fold decisions into per-record/per-stage screening states. */
  static foldStates(decisions: readonly DecisionLine[]): ScreeningState[] {
    const byKey = new Map<string, DecisionLine[]>()
    for (const decision of decisions) {
      const key = `${decision.recordId}\u0000${decision.stage}`
      const list = byKey.get(key) ?? []
      list.push(decision)
      byKey.set(key, list)
    }
    const states: ScreeningState[] = []
    for (const [key, lines] of byKey) {
      const [recordId, stage] = key.split('\u0000') as [string, ScreenStage]
      const byReviewer: Record<string, DecisionLine> = {}
      let adjudication: DecisionLine | undefined
      for (const line of lines) {
        if (line.role === 'adjudicator') adjudication = line
        else byReviewer[line.reviewer] = line
      }
      const reviewers = Object.values(byReviewer)
      const decisions = new Set(reviewers.map(line => line.decision))
      const conflict = adjudication === undefined && reviewers.length > 1 && decisions.size > 1
      const final: ScreenDecision | undefined = adjudication?.decision ?? (conflict ? undefined : reviewers[0]?.decision)
      states.push({ recordId, stage, byReviewer, ...(adjudication === undefined ? {} : { adjudication }), ...(final === undefined ? {} : { final }), conflict })
    }
    return states
  }

  /**
   * Verify the audit chain and return the events.
   * @returns the issues (empty when intact) and the event count.
   */
  async integrity(): Promise<{ ok: boolean; issues: string[]; events: number }> {
    const events = await this.audit()
    const issues = verifyAuditChain(events).map(issue => `${issue.code} at ${issue.index}: ${issue.message}`)
    return { ok: issues.length === 0, issues, events: events.length }
  }

  /** Build a stable record id from identifiers/title. */
  static recordIdOf(input: { doi?: string; pmid?: string; arxiv?: string; title: string }): string {
    if (input.doi !== undefined) return stableId('sr', ['doi', input.doi.toLowerCase()])
    if (input.pmid !== undefined) return stableId('sr', ['pmid', input.pmid])
    if (input.arxiv !== undefined) return stableId('sr', ['arxiv', input.arxiv.toLowerCase()])
    return stableId('sr', ['title', input.title.trim().toLowerCase()])
  }
}
