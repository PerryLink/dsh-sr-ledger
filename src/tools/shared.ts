/**
 * Shared tool schema fragments.
 * @module dsh-sr-ledger/tools/shared
 */

/** The failure branch. */
export const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', required: true },
    message: { type: 'string', required: true },
  },
} as const
