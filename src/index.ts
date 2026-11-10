/**
 * `dsh-sr-ledger` — the systematic-review ledger: protocol revisions, imported
 * records, dual screening with adjudication, RoB/GRADE assessments, PRISMA 2020
 * counts and an audit-verifiable export bundle.
 *
 * Four tools: sr_init, sr_import, sr_screen, sr_prisma. Append-only; nothing is silently
 * resolved or overwritten.
 *
 * Function plugin — no default export.
 * @module dsh-sr-ledger
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig, type Config as ConfigShape } from './config.ts'
import { SrRuntime } from './runtime.ts'
import { makeSrImportTool } from './tools/sr-import.ts'
import { makeSrInitTool } from './tools/sr-init.ts'
import { makeSrPrismaTool } from './tools/sr-prisma.ts'
import { makeSrScreenTool } from './tools/sr-screen.ts'

/** Cordis plugin name. */
export const name = 'sr-ledger'

/** The tool registry is a hard requirement. */
export const inject = ['tools']

export { Config, resolveConfig }
export type { ConfigShape }
export type { ResolvedConfig } from './config.ts'
export { VERSION } from './version.ts'
export { SrLedger } from './ledger.ts'
export type { AssessmentLine, DecisionLine, ImportedRecord, ReviewSpec, ScreenDecision, ScreenStage, ScreeningState } from './ledger.ts'
export { computePrisma, renderEvidenceTable, renderPrismaMarkdown } from './prisma.ts'
export type { LedgerIssue, PrismaCounts, PrismaResult } from './prisma.ts'
export { SrError, SrRuntime } from './runtime.ts'
export type { InitRequest, InitResult, PrismaExport, ScreenRequest, ScreenResult, SrErrorCode, SrRuntimeOptions } from './runtime.ts'
export { makeSrImportTool } from './tools/sr-import.ts'
export type { SrImportFailure, SrImportValue } from './tools/sr-import.ts'
export { detectFormat, ImportError, parseBibtex, parseCslJson, parseCsv, parseImport, parseRis } from './import.ts'
export type { ImportFormat, ImportParseResult, ImportRecord } from './import.ts'
export { makeSrInitTool } from './tools/sr-init.ts'
export { makeSrScreenTool } from './tools/sr-screen.ts'
export { makeSrPrismaTool } from './tools/sr-prisma.ts'

/**
 * Mount the four tools.
 * @param ctx - the plugin context (host).
 * @param config - raw plugin config.
 */
export function apply(ctx: Context, config: ConfigShape): void {
  const resolved = resolveConfig(config)
  const logger = ctx.logger('sr-ledger')
  if (!resolved.enabled) {
    logger.info('disabled: enabled is false — no tools are mounted')
    return
  }
  const runtime = new SrRuntime({ config: resolved })
  ctx.effect(() => ctx.tools.register(makeSrInitTool(runtime)), 'sr-ledger: sr_init tool')
  ctx.effect(() => ctx.tools.register(makeSrImportTool(runtime, ctx)), 'sr-ledger: sr_import tool')
  ctx.effect(() => ctx.tools.register(makeSrScreenTool(runtime)), 'sr-ledger: sr_screen tool')
  ctx.effect(() => ctx.tools.register(makeSrPrismaTool(runtime)), 'sr-ledger: sr_prisma tool')
}
