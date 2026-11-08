/**
 * Config schema and resolution for `dsh-sr-ledger`.
 * @module dsh-sr-ledger/config
 */

import path from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Raw plugin config. */
export interface Config {
  enabled?: boolean
  /** Ledger root (one directory per review, or the review root itself). */
  root?: string
}

/** Fully resolved config. */
export interface ResolvedConfig {
  readonly enabled: boolean
  readonly root: string
}

/** Schemastery schema. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  root: z.string().default('.sr-ledger'),
})

/**
 * Validate raw values and fill explicit defaults.
 * @param config - raw plugin config.
 * @returns the fully resolved config.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const root = config.root ?? '.sr-ledger'
  if (typeof root !== 'string' || root.trim() === '') throw new TypeError('root must be a non-empty path')
  return { enabled: config.enabled ?? true, root: path.resolve(root) }
}
