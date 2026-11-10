/**
 * Reference-file parsers: RIS, BibTeX, CSL-JSON, CSV and detection.
 * @module test/import.spec
 */

import { describe, expect, it } from 'vitest'
import {
  detectFormat,
  ImportError,
  parseBibtex,
  parseCslJson,
  parseCsv,
  parseImport,
  parseRis,
} from '../src/import.ts'

const RIS = `TY  - JOUR
AU  - Doe, Jane
AU  - Roe, Richard
TI  - A study of things
PY  - 2020
DO  - 10.1000/xyz
UR  - https://arxiv.org/abs/2401.00001
ER  -

TY  - JOUR
AU  - Nobody
PY  - 2021
ER  -
`

const BIBTEX = `@article{doe2020,
  title = {A study of {Nested} things},
  author = {Doe, Jane and Roe, Richard},
  year = {2020},
  doi = {10.1000/xyz},
  eprint = {2401.00001},
}

@misc{notitle,
  author = {Nobody},
}
`

const CSL = JSON.stringify([
  {
    title: 'A study of things',
    author: [{ family: 'Doe', given: 'Jane' }, { literal: 'Consortium' }],
    issued: { 'date-parts': [[2020, 3]] },
    DOI: '10.1000/xyz',
    PMID: '12345',
  },
  { type: 'article-journal' },
])

const CSV = `title,authors,year,doi,pmid
"A study, with commas","Doe, Jane; Roe, Richard",2020,10.1000/xyz,12345
,No Author,2021,,
`

describe('RIS', () => {
  it('parses records and counts the titleless entry as skipped', () => {
    const parsed = parseRis(RIS)
    expect(parsed.records).toHaveLength(1)
    expect(parsed.records[0]).toMatchObject({
      title: 'A study of things',
      authors: ['Doe, Jane', 'Roe, Richard'],
      year: 2020,
      doi: '10.1000/xyz',
      arxiv: '2401.00001',
    })
    expect(parsed.skipped).toBe(1)
  })
})

describe('BibTeX', () => {
  it('parses nested braces and counts the titleless entry', () => {
    const parsed = parseBibtex(BIBTEX)
    expect(parsed.records).toHaveLength(1)
    expect(parsed.records[0]?.title).toBe('A study of Nested things')
    expect(parsed.records[0]?.authors).toEqual(['Doe, Jane', 'Roe, Richard'])
    expect(parsed.records[0]?.doi).toBe('10.1000/xyz')
    expect(parsed.records[0]?.arxiv).toBe('2401.00001')
    expect(parsed.skipped).toBe(1)
  })
})

describe('CSL-JSON', () => {
  it('parses array items and literal authors', () => {
    const parsed = parseCslJson(CSL)
    expect(parsed.records).toHaveLength(1)
    expect(parsed.records[0]?.authors).toEqual(['Doe, Jane', 'Consortium'])
    expect(parsed.records[0]?.pmid).toBe('12345')
    expect(parsed.skipped).toBe(1)
  })

  it('accepts the {items: [...]} envelope and rejects non-JSON', () => {
    expect(parseCslJson(JSON.stringify({ items: [{ title: 'X' }] })).records).toHaveLength(1)
    expect(() => parseCslJson('not json')).toThrow(ImportError)
  })
})

describe('CSV', () => {
  it('handles quoted commas and skips blank titles', () => {
    const parsed = parseCsv(CSV)
    expect(parsed.records).toHaveLength(1)
    expect(parsed.records[0]?.title).toBe('A study, with commas')
    expect(parsed.records[0]?.authors).toEqual(['Doe, Jane', 'Roe, Richard'])
    expect(parsed.skipped).toBe(1)
  })
})

describe('detection', () => {
  it('detects all four formats', () => {
    expect(detectFormat(RIS)).toBe('ris')
    expect(detectFormat(BIBTEX)).toBe('bibtex')
    expect(detectFormat(CSL)).toBe('csl-json')
    expect(detectFormat(CSV)).toBe('csv')
    expect(detectFormat('hello world')).toBeUndefined()
  })

  it('honours an explicit format and fails loud on an unknown one', () => {
    expect(parseImport(RIS, 'ris').format).toBe('ris')
    expect(() => parseImport('hello', undefined)).toThrow(/could not detect/u)
  })
})
