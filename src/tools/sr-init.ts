/**
 * `sr_init` — create or revise the review protocol and import records.
 * @module dsh-sr-ledger/tools/sr-init
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { SrError, type SrRuntime } from '../runtime.ts'
import { ERROR_SCHEMA } from './shared.ts'

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    review: { type: 'json' },
    imported: { type: 'json' },
    recordCount: { type: 'integer' },
    error: ERROR_SCHEMA,
  },
} as const

/**
 * Build the `sr_init` tool.
 * @param runtime - the runtime.
 * @returns the tool definition.
 */
export function makeSrInitTool(runtime: SrRuntime) {
  return defineTool({
    name: 'sr_init',
    description: [
      'Create or revise a systematic-review protocol and import records (dsh-sr-ledger).',
      '',
      'Each call bumps the protocol revision and appends a hash-chained audit event — the protocol is never overwritten silently. `identification` takes the per-source PRISMA counts; `manual` takes the boxes decisions cannot derive (duplicates removed, reports not retrieved, reports of included studies). `records` are deduplicated by DOI/PMID/arXiv/title.',
      '',
      'This tool records; it does not search. Import records from paper-search/Zotero/PubMed exports.',
    ].join('\n'),
    parameters: {
      title: { type: 'string', description: 'Review title (required on the first call).' },
      pico: { type: 'json', description: '{population, intervention, comparison, outcome}.' },
      criteria: { type: 'json', description: '{include: string[], exclude: string[]}.' },
      identification: { type: 'json', description: 'Array of {source, count} for the PRISMA identification box.' },
      manual: { type: 'json', description: 'Manual PRISMA counts: duplicatesRemoved, recordsNotRetrieved, reportsOfIncludedStudies, previousStudiesIncluded.' },
      records: { type: 'json', description: 'Array of {title, authors?, year?, doi?, pmid?, arxiv?}.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const result = value as { ok: true; review: { title: string; revision: number }; imported: { added: number; skipped: number }; recordCount: number } | { ok: false; error: { code: string; message: string } }
        if (!result.ok) return [{ type: 'text', text: `sr_init failed (${result.error.code}): ${result.error.message}` }]
        return [
          {
            type: 'text',
            text: `sr_init: "${result.review.title}" revision ${result.review.revision}; imported ${result.imported.added} record(s) (${result.imported.skipped} duplicate(s)); ${result.recordCount} record(s) in the ledger`,
          },
        ]
      },
    },
    async execute(args: unknown) {
      try {
        const result = await runtime.init((args ?? {}) as Parameters<SrRuntime['init']>[0])
        return { ok: true as const, review: result.review as never, imported: result.imported as never, recordCount: result.recordCount }
      } catch (error) {
        if (error instanceof SrError) return { ok: false as const, error: { code: error.code, message: error.message } }
        return { ok: false as const, error: { code: 'IO', message: error instanceof Error ? error.message : String(error) } }
      }
    },
  })
}
