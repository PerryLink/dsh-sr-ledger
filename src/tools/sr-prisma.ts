/**
 * `sr_prisma` — PRISMA counts, integrity and the export bundle.
 * @module dsh-sr-ledger/tools/sr-prisma
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { SrError, type SrRuntime } from '../runtime.ts'
import { ERROR_SCHEMA } from './shared.ts'

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    counts: { type: 'json' },
    issues: { type: 'json' },
    robSummary: { type: 'json' },
    integrity: { type: 'json' },
    exports: { type: 'json' },
    error: ERROR_SCHEMA,
  },
} as const

/**
 * Build the `sr_prisma` tool.
 * @param runtime - the runtime.
 * @returns the tool definition.
 */
export function makeSrPrismaTool(runtime: SrRuntime) {
  return defineTool({
    name: 'sr_prisma',
    description: [
      'Compute the PRISMA 2020 flow, verify the ledger, and write the export bundle (dsh-sr-ledger).',
      '',
      'Counts are derived from the append-only decision ledger; manual boxes stay labelled. Open conflicts, exclusions without reasons, unknown records and chain corruption are reported as issues instead of being smoothed over. Writes prisma.json, prisma.md, evidence-table.md and ledger.json under `<root>/exports`.',
    ].join('\n'),
    parameters: {},
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const result = value as
          | { ok: true; counts: { included: number; excludedTitleAbstract: number; excludedFullText: number; conflicts: number }; issues: Array<{ severity: string }>; integrity: { ok: boolean; events: number }; exports: { prismaMarkdown: string } }
          | { ok: false; error: { code: string; message: string } }
        if (!result.ok) return [{ type: 'text', text: `sr_prisma failed (${result.error.code}): ${result.error.message}` }]
        const errors = result.issues.filter(issue => issue.severity === 'error').length
        return [
          {
            type: 'text',
            text: `sr_prisma: ${result.counts.included} included, ${result.counts.excludedTitleAbstract} excluded at title/abstract, ${result.counts.excludedFullText} excluded at full text, ${result.counts.conflicts} open conflict(s); ${errors} error issue(s); ledger chain ${result.integrity.ok ? 'intact' : 'BROKEN'} (${result.integrity.events} events); exported ${result.exports.prismaMarkdown}`,
          },
        ]
      },
    },
    async execute() {
      try {
        const result = await runtime.prisma()
        return {
          ok: true as const,
          counts: result.counts as never,
          issues: result.issues as never,
          robSummary: result.robSummary as never,
          integrity: result.integrity as never,
          exports: result.exports as never,
        }
      } catch (error) {
        if (error instanceof SrError) return { ok: false as const, error: { code: error.code, message: error.message } }
        throw error
      }
    },
  })
}
