/**
 * `sr_screen` — screening decisions, adjudication and RoB/GRADE assessment.
 * @module dsh-sr-ledger/tools/sr-screen
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { SrError, type SrRuntime } from '../runtime.ts'
import { ERROR_SCHEMA } from './shared.ts'

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    state: { type: 'json' },
    openConflicts: { type: 'integer' },
    assessment: { type: 'json' },
    error: ERROR_SCHEMA,
  },
} as const

/**
 * Build the `sr_screen` tool.
 * @param runtime - the runtime.
 * @returns the tool definition.
 */
export function makeSrScreenTool(runtime: SrRuntime) {
  return defineTool({
    name: 'sr_screen',
    description: [
      'Record a screening decision, resolve a conflict, or attach a RoB/GRADE assessment (dsh-sr-ledger).',
      '',
      'Dual screening is built in: two reviewers with opposite decisions at the same stage are a conflict until an adjudicator records the final decision (`role: "adjudicator"` is rejected when there is no conflict to resolve). An exclusion requires a reason.',
      '',
      'Assessments accept tool RoB2 / ROBINS-I / GRADE with a domain and a judgement (low / some-concerns / high / unclear), and are written to the same append-only ledger.',
    ].join('\n'),
    parameters: {
      recordId: { type: 'string', required: true, description: 'Record id returned by sr_init.' },
      reviewer: { type: 'string', required: true, description: 'Reviewer id or name.' },
      stage: { type: 'string', required: true, enum: ['title-abstract', 'full-text'], description: 'PRISMA screening stage.' },
      decision: { type: 'string', required: true, enum: ['include', 'exclude'], description: 'Decision.' },
      reason: { type: 'string', description: 'Exclusion reason (required for exclude).' },
      role: { type: 'string', enum: ['reviewer', 'adjudicator'], description: 'Adjudicator decisions are final and require an open conflict.' },
      assessment: { type: 'json', description: 'Optional {tool, domain, judgement, note?}.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const result = value as { ok: true; state: { final?: string; conflict: boolean }; openConflicts: number } | { ok: false; error: { code: string; message: string } }
        if (!result.ok) return [{ type: 'text', text: `sr_screen failed (${result.error.code}): ${result.error.message}` }]
        return [
          {
            type: 'text',
            text: `sr_screen: final=${result.state.final ?? 'unresolved'}${result.state.conflict ? ' (CONFLICT)' : ''}; ${result.openConflicts} open conflict(s) in the review`,
          },
        ]
      },
    },
    async execute(args: unknown) {
      try {
        const result = await runtime.screen(args as Parameters<SrRuntime['screen']>[0])
        return {
          ok: true as const,
          state: result.state as never,
          openConflicts: result.openConflicts,
          ...(result.assessment === undefined ? {} : { assessment: result.assessment as never }),
        }
      } catch (error) {
        if (error instanceof SrError) return { ok: false as const, error: { code: error.code, message: error.message } }
        throw error
      }
    },
  })
}
