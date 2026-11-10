/**
 * Tool surface: names, schemas, execution, renderers, package contract.
 * @module test/tools.spec
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { SrRuntime } from '../src/runtime.ts'
import { makeSrImportTool } from '../src/tools/sr-import.ts'
import { makeSrInitTool } from '../src/tools/sr-init.ts'
import { makeSrPrismaTool } from '../src/tools/sr-prisma.ts'
import { makeSrScreenTool } from '../src/tools/sr-screen.ts'
import { VERSION } from '../src/version.ts'

const AT = new Date('2026-09-01T09:00:00.000Z')
let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sr-tools-'))
})

afterEach(async () => {
  if (root.startsWith(tmpdir())) await rm(root, { recursive: true, force: true })
})

/** Build a runtime over the temp root. */
function runtime(): SrRuntime {
  return new SrRuntime({ config: resolveConfig({ root }), now: () => AT })
}

const EXEC = {} as never

describe('tools', () => {
  it('declares names and schemas', () => {
    for (const [tool, name] of [
      [makeSrInitTool(runtime()), 'sr_init'],
      [makeSrImportTool(runtime(), { get: () => undefined } as never), 'sr_import'],
      [makeSrScreenTool(runtime()), 'sr_screen'],
      [makeSrPrismaTool(runtime()), 'sr_prisma'],
    ] as const) {
      expect(tool.name).toBe(name)
      expect(tool.output.schema).toBeDefined()
      expect(typeof tool.output.render).toBe('function')
    }
  })

  it('runs init → screen → prisma end to end', async () => {
    const init = makeSrInitTool(runtime())
    const initial = (await init.execute(
      { title: 'Tool review', identification: [{ source: 'PubMed', count: 2 }], records: [{ title: 'A', doi: '10.5555/a' }, { title: 'B', doi: '10.5555/b' }] },
      EXEC,
    )) as { ok: true; recordCount: number; review: { revision: number } }
    expect(initial.ok).toBe(true)
    expect(initial.recordCount).toBe(2)

    const records = await runtime().ledger().records()
    const screen = makeSrScreenTool(runtime())
    const decision = (await screen.execute({ recordId: records[0]!.recordId, reviewer: 'r1', stage: 'title-abstract', decision: 'include' }, EXEC)) as {
      ok: true
      state: { final: string }
    }
    expect(decision.state.final).toBe('include')

    const prisma = makeSrPrismaTool(runtime())
    const value = (await prisma.execute({}, EXEC)) as {
      ok: true
      counts: { soughtForRetrieval: number; included: number }
      integrity: { ok: boolean }
      exports: { prismaMarkdown: string }
    }
    expect(value.integrity.ok).toBe(true)
    expect(value.counts.soughtForRetrieval).toBe(1)
    const markdown = await readFile(path.join(root, value.exports.prismaMarkdown), 'utf8')
    expect(markdown).toContain('PRISMA 2020 flow')
  })


  it('imports RIS through sr_init, dedupes on re-import and reports skipped entries', async () => {
    const tool = makeSrImportTool(runtime(), { get: () => undefined } as never)
    const content = [
      'TY  - JOUR',
      'AU  - Doe, Jane',
      'TI  - A study of things',
      'PY  - 2020',
      'DO  - 10.1000/xyz',
      'ER  -',
      '',
      'TY  - JOUR',
      'AU  - Nobody',
      'ER  -',
      '',
    ].join('\n')
    const first = (await tool.execute({ content, title: 'Import review', identification: [{ source: 'Zotero', count: 2 }] }, EXEC)) as {
      ok: true
      format: string
      parsed: number
      skipped: number
      imported: { added: number; skipped: number }
      recordCount: number
      review: { revision: number }
    }
    expect(first.ok).toBe(true)
    expect(first.format).toBe('ris')
    expect(first.parsed).toBe(1)
    expect(first.skipped).toBe(1)
    expect(first.imported.added).toBe(1)
    expect(first.recordCount).toBe(1)
    expect(first.review.revision).toBe(1)

    const second = (await tool.execute({ content }, EXEC)) as {
      ok: true
      imported: { added: number; skipped: number }
      recordCount: number
    }
    expect(second.ok).toBe(true)
    expect(second.imported.added).toBe(0)
    expect(second.imported.skipped).toBe(1)
    expect(second.recordCount).toBe(1)

    const text = (tool.output.render({}, first as never) as Array<{ text: string }>)[0]?.text ?? ''
    expect(text).toContain('sr_import (ris)')
    expect(text).toContain('skipped 1')
  })

  it('imports BibTeX explicitly and fails loud on an empty file', async () => {
    const tool = makeSrImportTool(runtime(), { get: () => undefined } as never)
    const bibtex = '@article{k, title = {Bib title}, doi = {10.1000/bib}}'
    const imported = (await tool.execute({ content: bibtex, format: 'bibtex', title: 'Bib review' }, EXEC)) as {
      ok: true
      format: string
      imported: { added: number }
    }
    expect(imported.ok).toBe(true)
    expect(imported.format).toBe('bibtex')
    expect(imported.imported.added).toBe(1)

    const empty = (await tool.execute({ content: 'TY  - JOUR\nER  -\n', format: 'ris' }, EXEC)) as { ok: false; error: { code: string } }
    expect(empty.ok).toBe(false)
    expect(empty.error.code).toBe('EMPTY_IMPORT')
  })

  it('failure branch carries a stable code', async () => {
    const value = (await makeSrInitTool(runtime()).execute({}, EXEC)) as { ok: false; error: { code: string } }
    expect(value.ok).toBe(false)
    expect(value.error.code).toBe('INVALID_INPUT')
  })

  it('maps an unreadable ledger to IO instead of throwing through the tool', async () => {
    const rt = runtime()
    await rt.init({ title: 'Corrupt ledger' })
    await writeFile(path.join(root, 'decisions.jsonl'), '{not json\n', 'utf8')
    const value = (await makeSrPrismaTool(rt).execute({}, EXEC)) as { ok: false; error: { code: string } }
    expect(value.ok).toBe(false)
    expect(value.error.code).toBe('IO')
  })
})

describe('package', () => {
  it('VERSION matches package.json and the manifest declares a bundle patch', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as Record<string, unknown>
    expect(pkg['version']).toBe(VERSION)
    expect(pkg['dsh']).toEqual({ manifestVersion: 1, bundle: { patch: './cordis.patch.yml' } })
    expect(pkg['dependencies']).toEqual({})
  })
})
