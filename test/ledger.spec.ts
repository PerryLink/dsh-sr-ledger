/**
 * Ledger integration: protocol revisions, dual screening, adjudication,
 * assessments, PRISMA counts, integrity and exports.
 * @module test/ledger.spec
 */

import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { SrRuntime } from '../src/runtime.ts'

const AT = new Date('2026-09-01T09:00:00.000Z')
let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sr-ledger-'))
})

afterEach(async () => {
  if (root.startsWith(tmpdir())) await rm(root, { recursive: true, force: true })
})

/** Build a runtime over the temp root. */
function runtime(): SrRuntime {
  return new SrRuntime({ config: resolveConfig({ root }), now: () => AT })
}

/** Create a review with four records. */
async function seed(rt: SrRuntime): Promise<string[]> {
  const result = await rt.init({
    title: 'Fixture review',
    criteria: { include: ['RCT'], exclude: ['animal'] },
    identification: [{ source: 'PubMed', count: 10 }, { source: 'Embase', count: 4 }],
    manual: { duplicatesRemoved: 4 },
    records: [
      { title: 'Study one', doi: '10.5555/one' },
      { title: 'Study two', doi: '10.5555/two' },
      { title: 'Study three', doi: '10.5555/three' },
      { title: 'Study four', doi: '10.5555/four' },
    ],
  })
  const records = await rt.ledger().records()
  expect(result.recordCount).toBe(4)
  return records.map(record => record.recordId)
}

describe('init', () => {
  it('creates a protocol, imports records and deduplicates', async () => {
    const rt = runtime()
    const ids = await seed(rt)
    expect(new Set(ids).size).toBe(4)
    const again = await rt.init({ records: [{ title: 'Study one', doi: '10.5555/one' }] })
    expect(again.review.revision).toBe(2)
    expect(again.imported).toEqual({ added: 0, skipped: 1 })
  })

  it('requires a title on the first call', async () => {
    await expect(runtime().init({})).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('rejects malformed imported records instead of crashing', async () => {
    await expect(runtime().init({ title: 'Bad records', records: [{ title: 42 as never }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(runtime().init({ title: 'Bad counts', identification: [{ source: 'PubMed', count: -1 }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('keeps every full protocol revision in an append-only history', async () => {
    const rt = runtime()
    await rt.init({ title: 'First protocol', criteria: { include: ['RCT'], exclude: ['animal'] } })
    await rt.init({ title: 'Second protocol' })
    const history = await rt.ledger().reviewHistory()
    expect(history).toHaveLength(2)
    expect(history[0]?.title).toBe('First protocol')
    expect(history[0]?.criteria).toEqual({ include: ['RCT'], exclude: ['animal'] })
    expect(history[1]?.revision).toBe(2)
  })
})

describe('screening', () => {
  it('detects a dual-screening conflict and resolves it only by adjudication', async () => {
    const rt = runtime()
    const [first] = await seed(rt)
    await rt.screen({ recordId: first!, reviewer: 'r1', stage: 'title-abstract', decision: 'exclude', reason: 'animal study' })
    const conflict = await rt.screen({ recordId: first!, reviewer: 'r2', stage: 'title-abstract', decision: 'include' })
    expect(conflict.state.conflict).toBe(true)
    expect(conflict.openConflicts).toBe(1)

    const resolved = await rt.screen({ recordId: first!, reviewer: 'arbiter', stage: 'title-abstract', decision: 'exclude', reason: 'animal study', role: 'adjudicator' })
    expect(resolved.state.conflict).toBe(false)
    expect(resolved.state.final).toBe('exclude')
    expect(resolved.openConflicts).toBe(0)
  })

  it('rejects an adjudication without a conflict and an exclusion without a reason', async () => {
    const rt = runtime()
    const [first] = await seed(rt)
    await expect(rt.screen({ recordId: first!, reviewer: 'r1', stage: 'title-abstract', decision: 'include', role: 'adjudicator' })).rejects.toMatchObject({ code: 'NO_CONFLICT' })
    await expect(rt.screen({ recordId: first!, reviewer: 'r1', stage: 'title-abstract', decision: 'exclude' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('does not append a decision when the assessment or role is invalid', async () => {
    const rt = runtime()
    const [first] = await seed(rt)
    const before = (await rt.ledger().decisions()).length
    await expect(rt.screen({
      recordId: first!,
      reviewer: 'r1',
      stage: 'title-abstract',
      decision: 'include',
      assessment: { tool: 'NOPE' as never, domain: 'x', judgement: 'low' },
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(rt.screen({ recordId: first!, reviewer: 'r1', stage: 'title-abstract', decision: 'include', role: 'chair' as never })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect((await rt.ledger().decisions()).length).toBe(before)
  })

  it('records RoB/GRADE assessments', async () => {
    const rt = runtime()
    const ids = await seed(rt)
    const result = await rt.screen({
      recordId: ids[1]!,
      reviewer: 'r1',
      stage: 'full-text',
      decision: 'include',
      assessment: { tool: 'RoB2', domain: 'randomization', judgement: 'some-concerns' },
    })
    expect(result.assessment?.tool).toBe('RoB2')
    expect(await rt.ledger().assessments()).toHaveLength(1)
  })

  it('rejects unknown records and screening before init', async () => {
    await expect(runtime().screen({ recordId: 'sr-nope', reviewer: 'r1', stage: 'title-abstract', decision: 'include' })).rejects.toMatchObject({ code: 'NOT_INITIALIZED' })
    const rt = runtime()
    await seed(rt)
    await expect(rt.screen({ recordId: 'sr-nope', reviewer: 'r1', stage: 'title-abstract', decision: 'include' })).rejects.toMatchObject({ code: 'RECORD_UNKNOWN' })
  })
})

describe('prisma', () => {
  it('derives counts, writes the export bundle and reports issues', async () => {
    const rt = runtime()
    const ids = await seed(rt)
    // Rec 1: conflict resolved as exclude at TA.
    await rt.screen({ recordId: ids[0]!, reviewer: 'r1', stage: 'title-abstract', decision: 'include' })
    await rt.screen({ recordId: ids[0]!, reviewer: 'r2', stage: 'title-abstract', decision: 'exclude', reason: 'not an RCT' })
    await rt.screen({ recordId: ids[0]!, reviewer: 'arbiter', stage: 'title-abstract', decision: 'exclude', reason: 'not an RCT', role: 'adjudicator' })
    // Rec 2: included at both stages with an assessment.
    await rt.screen({ recordId: ids[1]!, reviewer: 'r1', stage: 'title-abstract', decision: 'include' })
    await rt.screen({ recordId: ids[1]!, reviewer: 'r2', stage: 'title-abstract', decision: 'include' })
    await rt.screen({ recordId: ids[1]!, reviewer: 'r1', stage: 'full-text', decision: 'include', assessment: { tool: 'GRADE', domain: 'certainty', judgement: 'low' } })
    // Rec 3: excluded at full text with a reason.
    await rt.screen({ recordId: ids[2]!, reviewer: 'r1', stage: 'title-abstract', decision: 'include' })
    await rt.screen({ recordId: ids[2]!, reviewer: 'r1', stage: 'full-text', decision: 'exclude', reason: 'wrong outcome' })

    const result = await rt.prisma()
    expect(result.counts.identified).toBe(14)
    expect(result.counts.duplicatesRemoved).toBe(4)
    expect(result.counts.screened).toBe(10)
    expect(result.counts.excludedTitleAbstract).toBe(1)
    expect(result.counts.soughtForRetrieval).toBe(2)
    expect(result.counts.excludedFullText).toBe(1)
    expect(result.counts.excludedFullTextReasons).toEqual([{ reason: 'wrong outcome', count: 1 }])
    expect(result.counts.included).toBe(1)
    expect(result.counts.conflicts).toBe(0)
    expect(result.integrity.ok).toBe(true)
    expect(result.robSummary.some(entry => entry.tool === 'GRADE' && entry.judgement === 'low')).toBe(true)

    const markdown = await readFile(path.join(root, 'exports', 'prisma.md'), 'utf8')
    expect(markdown).toContain('Studies included in review | 1')
    const table = await readFile(path.join(root, 'exports', 'evidence-table.md'), 'utf8')
    expect(table).toContain('Study two')
    expect(table).toContain('GRADE')
  })

  it('reports a broken audit chain instead of hiding it', async () => {
    const rt = runtime()
    const ids = await seed(rt)
    await rt.screen({ recordId: ids[0]!, reviewer: 'r1', stage: 'title-abstract', decision: 'include' })
    await appendFile(path.join(root, 'audit.jsonl'), `${JSON.stringify({ eventId: 'evt-999999', at: AT.toISOString(), actor: 'human', type: 'sr.forged', payload: {}, hash: 'f'.repeat(64) })}\n`, 'utf8')
    const result = await rt.prisma()
    expect(result.integrity.ok).toBe(false)
    expect(result.integrity.issues.join(' ')).toContain('event')
  })
})
