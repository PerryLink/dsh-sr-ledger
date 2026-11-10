/**
 * `sr_import` — import RIS/BibTeX/CSL-JSON/CSV records through `sr_init`.
 * @module dsh-sr-ledger/tools/sr-import
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ImportError, parseImport, type ImportFormat } from '../import.ts'
import { SrError, type SrRuntime } from '../runtime.ts'
import { ERROR_SCHEMA } from './shared.ts'

/** The canonical success value. */
export interface SrImportValue {
  readonly ok: true
  readonly format: ImportFormat
  readonly parsed: number
  readonly skipped: number
  readonly imported: { readonly added: number; readonly skipped: number }
  readonly recordCount: number
  readonly warnings: readonly string[]
  readonly review: { readonly reviewId: string; readonly revision: number }
}

/** The canonical failure value. */
export interface SrImportFailure {
  readonly ok: false
  readonly error: { readonly code: string; readonly message: string }
}

/** The minimal filesystem seam used to read a path. */
interface FsSeam {
  resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<unknown>
  readText(target: unknown, signal?: AbortSignal): Promise<string>
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    format: { type: 'string' },
    parsed: { type: 'integer' },
    skipped: { type: 'integer' },
    imported: {
      type: 'object',
      additionalProperties: false,
      properties: {
        added: { type: 'integer', required: true },
        skipped: { type: 'integer', required: true },
      },
    },
    recordCount: { type: 'integer' },
    warnings: { type: 'array', items: { type: 'string' } },
    review: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reviewId: { type: 'string', required: true },
        revision: { type: 'integer', required: true },
      },
    },
    error: ERROR_SCHEMA,
  },
} as const

function failure(code: string, message: string) {
  return { ok: false as const, error: { code, message } }
}

/**
 * Build the `sr_import` tool.
 * @param runtime - the review runtime.
 * @param ctx - the plugin context (for the optional filesystem seam).
 * @returns the tool definition.
 */
export function makeSrImportTool(runtime: SrRuntime, ctx: Context) {
  return defineTool({
    name: 'sr_import',
    description: [
      'Import RIS / BibTeX / CSL-JSON / CSV records into the systematic-review ledger (dsh-sr-ledger).',
      '',
      'Parses a reference-manager export into structured records and appends them through the same `sr_init` path as hand-entered records (deduplicated by DOI/PMID/arXiv/title; the protocol revision is bumped and audited). It does not search, fetch PDFs or invent identifiers; entries without a title are skipped and counted. Pass `content`, or `path` when `ctx.fs` is mounted.',
    ].join('\n'),
    parameters: {
      content: { type: 'string', description: 'The export file contents (inline).' },
      path: { type: 'string', description: 'Path to the export file; requires ctx.fs (workspace-relative or absolute).' },
      format: { type: 'string', description: 'ris | bibtex | csl-json | csv (default: detect from the contents).' },
      title: { type: 'string', description: 'Review title; required only when the review does not exist yet.' },
      identification: { type: 'json', description: 'Optional per-source PRISMA identification counts to set with the import.' },
      manual: { type: 'json', description: 'Optional manual PRISMA boxes to set with the import.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const result = value as SrImportValue | SrImportFailure
        if (!result.ok) return [{ type: 'text', text: `sr_import failed (${result.error.code}): ${result.error.message}` }]
        const lines = [
          `sr_import (${result.format}): parsed ${result.parsed}, added ${result.imported.added}, duplicate ${result.imported.skipped}, skipped ${result.skipped}; ${result.recordCount} record(s) in the ledger`,
        ]
        for (const warning of result.warnings) lines.push(`  warning: ${warning}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(input: unknown, exec: ToolRunContext) {
      const args = (input ?? {}) as {
        content?: string
        path?: string
        format?: string
        title?: string
        identification?: unknown
        manual?: unknown
      }
      if (typeof args.content !== 'string' && typeof args.path !== 'string') {
        return failure('INVALID_INPUT', 'provide content or path')
      }
      let content = args.content
      if (content === undefined && typeof args.path === 'string') {
        const fs = ctx.get('fs') as FsSeam | undefined
        if (fs === undefined) return failure('FS_UNMOUNTED', 'ctx.fs is not mounted; pass content instead of path')
        const sessionHeader = (exec.agent?.session as unknown as { header?: { cwd?: unknown } } | undefined)?.header
        const cwd = typeof sessionHeader?.cwd === 'string' ? sessionHeader.cwd : undefined
        try {
          const target = await fs.resolve(args.path, { ...(cwd === undefined ? {} : { cwd }), signal: exec.signal })
          content = await fs.readText(target, exec.signal)
        } catch (error) {
          return failure('IO', error instanceof Error ? error.message : String(error))
        }
      }
      if (content === undefined) return failure('INVALID_INPUT', 'could not read the import contents')
      const format = args.format === undefined ? undefined : args.format as ImportFormat
      if (format !== undefined && !['ris', 'bibtex', 'csl-json', 'csv'].includes(format)) {
        return failure('INVALID_FORMAT', `unknown format "${format}"; use ris|bibtex|csl-json|csv`)
      }
      try {
        const parsed = parseImport(content, format)
        if (parsed.records.length === 0) {
          return failure('EMPTY_IMPORT', `no records with a usable title were found (${parsed.skipped} skipped)`)
        }
        const result = await runtime.init({
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(args.identification === undefined ? {} : { identification: args.identification as never }),
          ...(args.manual === undefined ? {} : { manual: args.manual as never }),
          records: parsed.records.map(record => ({
            title: record.title,
            ...(record.authors === undefined ? {} : { authors: [...record.authors] }),
            ...(record.year === undefined ? {} : { year: record.year }),
            ...(record.doi === undefined ? {} : { doi: record.doi }),
            ...(record.pmid === undefined ? {} : { pmid: record.pmid }),
            ...(record.arxiv === undefined ? {} : { arxiv: record.arxiv }),
          })),
        })
        return {
          ok: true as const,
          format: parsed.format,
          parsed: parsed.records.length,
          skipped: parsed.skipped,
          imported: { added: result.imported.added, skipped: result.imported.skipped },
          recordCount: result.recordCount,
          warnings: [...parsed.warnings],
          review: { reviewId: result.review.reviewId, revision: result.review.revision },
        }
      } catch (error) {
        if (error instanceof ImportError) return failure(error.code, error.message)
        if (error instanceof SrError) return failure(error.code, error.message)
        return failure('PARSE_FAILED', error instanceof Error ? error.message : String(error))
      }
    },
  })
}
