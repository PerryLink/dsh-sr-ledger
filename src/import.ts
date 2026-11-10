/**
 * Reference-file importers: RIS, BibTeX, CSL-JSON and CSV.
 *
 * The ledger stores structured records; this module is the only place that
 * turns a reference manager's export into `{title, authors, year, doi, pmid,
 * arxiv}`. It never searches, never fetches and never invents an identifier:
 * a field the file does not carry stays absent.
 *
 * @module dsh-sr-ledger/import
 */

/** One importable record. */
export interface ImportRecord {
  readonly title: string
  readonly authors?: readonly string[]
  readonly year?: number
  readonly doi?: string
  readonly pmid?: string
  readonly arxiv?: string
}

/** Supported file formats. */
export type ImportFormat = 'ris' | 'bibtex' | 'csl-json' | 'csv'

/** Parse result. */
export interface ImportParseResult {
  readonly format: ImportFormat
  readonly records: readonly ImportRecord[]
  /** Entries that had no usable title (or were malformed) and were skipped. */
  readonly skipped: number
  readonly warnings: readonly string[]
}

/** A typed import failure. */
export class ImportError extends Error {
  /** Stable code. */
  readonly code: 'INVALID_FORMAT' | 'PARSE_FAILED'

  constructor(code: 'INVALID_FORMAT' | 'PARSE_FAILED', message: string) {
    super(message)
    this.name = 'ImportError'
    this.code = code
  }
}

function clean(value: string | undefined): string {
  return (value ?? '').replace(/\s+/gu, ' ').trim()
}

function normalizeDoi(value: string | undefined): string | undefined {
  const text = clean(value).replace(/^https?:\/\/doi\.org\//iu, '').replace(/[.,;]+$/u, '')
  return text === '' ? undefined : text.toLowerCase()
}

function normalizePmid(value: string | undefined): string | undefined {
  const text = clean(value)
  return /^\d+$/u.test(text) ? text : undefined
}

function normalizeArxiv(value: string | undefined): string | undefined {
  const text = clean(value)
  const match = /(?:arxiv\.org\/(?:abs|pdf)\/|^)(\d{4}\.\d{4,5})(?:v\d+)?/iu.exec(text)
  return match?.[1]
}

function yearOf(value: string | undefined): number | undefined {
  const match = /(1[5-9]\d{2}|20\d{2}|21\d{2})/u.exec(clean(value))
  return match === null ? undefined : Number.parseInt(match[1]!, 10)
}

function fieldsToRecord(fields: ReadonlyMap<string, readonly string[]>): ImportRecord | undefined {
  const first = (keys: readonly string[]): string | undefined => {
    for (const key of keys) {
      const values = fields.get(key)
      if (values !== undefined && values.length > 0) {
        const value = clean(values[0])
        if (value !== '') return value
      }
    }
    return undefined
  }
  const title = first(['TI', 'T1', 'title'])
  if (title === undefined) return undefined
  const authors = (fields.get('AU') ?? fields.get('A1') ?? fields.get('author') ?? [])
    .map(author => clean(author))
    .filter(author => author !== '')
  const year = yearOf(first(['PY', 'Y1', 'year']))
  const doi = normalizeDoi(first(['DO', 'doi', 'DOI']))
  const pmid = normalizePmid(first(['AN', 'PMID', 'pmid']))
  const arxiv = normalizeArxiv(first(['UR', 'url', 'eprint', 'arXiv']))
  return {
    title,
    ...(authors.length === 0 ? {} : { authors }),
    ...(year === undefined ? {} : { year }),
    ...(doi === undefined ? {} : { doi }),
    ...(pmid === undefined ? {} : { pmid }),
    ...(arxiv === undefined ? {} : { arxiv }),
  }
}

/**
 * Parse an RIS export.
 * @param text - the file contents.
 * @returns records plus skipped-entry count.
 */
export function parseRis(text: string): { records: ImportRecord[]; skipped: number } {
  const records: ImportRecord[] = []
  let skipped = 0
  let fields = new Map<string, string[]>()
  const flush = (): void => {
    if (fields.size === 0) return
    const record = fieldsToRecord(fields)
    if (record === undefined) skipped += 1
    else records.push(record)
    fields = new Map()
  }
  for (const line of text.split(/\r?\n/u)) {
    if (/^ER\s{0,3}-/u.test(line)) {
      flush()
      continue
    }
    const match = /^([A-Z][A-Z0-9])\s{2,}-\s?(.*)$/u.exec(line)
    if (match === null) continue
    const tag = match[1]!
    const value = match[2] ?? ''
    const list = fields.get(tag) ?? []
    list.push(value)
    fields.set(tag, list)
  }
  flush()
  return { records, skipped }
}

function splitBibtexEntries(text: string): string[] {
  const entries: string[] = []
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '@') continue
    const open = text.indexOf('{', index)
    if (open === -1) break
    let depth = 0
    let end = -1
    for (let cursor = open; cursor < text.length; cursor += 1) {
      if (text[cursor] === '{') depth += 1
      else if (text[cursor] === '}') {
        depth -= 1
        if (depth === 0) {
          end = cursor
          break
        }
      }
    }
    if (end === -1) break
    entries.push(text.slice(index, end + 1))
    index = end
  }
  return entries
}

function bibtexFields(body: string): Map<string, string[]> {
  const fields = new Map<string, string[]>()
  let index = 0
  while (index < body.length) {
    while (index < body.length && /[\s,]/u.test(body[index]!)) index += 1
    const nameStart = index
    while (index < body.length && /[A-Za-z0-9_-]/u.test(body[index]!)) index += 1
    const name = body.slice(nameStart, index).toLowerCase()
    while (index < body.length && /\s/u.test(body[index]!)) index += 1
    if (name === '' || body[index] !== '=') {
      while (index < body.length && body[index] !== ',') index += 1
      continue
    }
    index += 1
    while (index < body.length && /\s/u.test(body[index]!)) index += 1
    let value = ''
    if (body[index] === '{') {
      let depth = 0
      const start = index
      for (; index < body.length; index += 1) {
        if (body[index] === '{') depth += 1
        else if (body[index] === '}') {
          depth -= 1
          if (depth === 0) {
            index += 1
            break
          }
        }
      }
      value = body.slice(start + 1, index - 1)
    } else if (body[index] === '"') {
      const start = index + 1
      index += 1
      while (index < body.length && body[index] !== '"') index += 1
      value = body.slice(start, index)
      index += 1
    } else {
      const start = index
      while (index < body.length && body[index] !== ',') index += 1
      value = body.slice(start, index)
    }
    const list = fields.get(name) ?? []
    list.push(value.replace(/[{}]/gu, '').trim())
    fields.set(name, list)
  }
  return fields
}

/**
 * Parse a BibTeX export.
 * @param text - the file contents.
 * @returns records plus skipped-entry count.
 */
export function parseBibtex(text: string): { records: ImportRecord[]; skipped: number } {
  const records: ImportRecord[] = []
  let skipped = 0
  for (const entry of splitBibtexEntries(text)) {
    const open = entry.indexOf('{')
    const body = entry.slice(open + 1, -1)
    const comma = body.indexOf(',')
    const fields = bibtexFields(comma === -1 ? '' : body.slice(comma + 1))
    const title = fields.get('title')?.[0]
    if (title === undefined || clean(title) === '') {
      skipped += 1
      continue
    }
    const authors = (fields.get('author')?.[0] ?? '')
      .split(/\s+and\s+/iu)
      .map(author => clean(author))
      .filter(author => author !== '')
    const year = yearOf(fields.get('year')?.[0])
    const doi = normalizeDoi(fields.get('doi')?.[0])
    const pmid = normalizePmid(fields.get('pmid')?.[0])
    const arxiv = normalizeArxiv(fields.get('eprint')?.[0] ?? fields.get('arxiv')?.[0])
    records.push({
      title: clean(title),
      ...(authors.length === 0 ? {} : { authors }),
      ...(year === undefined ? {} : { year }),
      ...(doi === undefined ? {} : { doi }),
      ...(pmid === undefined ? {} : { pmid }),
      ...(arxiv === undefined ? {} : { arxiv }),
    })
  }
  return { records, skipped }
}

function cslAuthors(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const names: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      const name = clean(entry)
      if (name !== '') names.push(name)
      continue
    }
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as { family?: unknown; given?: unknown; literal?: unknown }
    if (typeof record.literal === 'string') {
      const name = clean(record.literal)
      if (name !== '') names.push(name)
      continue
    }
    const family = typeof record.family === 'string' ? clean(record.family) : ''
    const given = typeof record.given === 'string' ? clean(record.given) : ''
    const name = clean(`${family}${family !== '' && given !== '' ? ', ' : ''}${given}`)
    if (name !== '') names.push(name)
  }
  return names
}

/**
 * Parse a CSL-JSON export (array or `{items: [...]}`).
 * @param text - the file contents.
 * @returns records plus skipped-entry count.
 */
export function parseCslJson(text: string): { records: ImportRecord[]; skipped: number } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new ImportError('PARSE_FAILED', `CSL-JSON is not valid JSON: ${(error as Error).message}`)
  }
  const items = Array.isArray(parsed) ? parsed : (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { items?: unknown }).items))
    ? (parsed as { items: unknown[] }).items
    : undefined
  if (items === undefined) throw new ImportError('PARSE_FAILED', 'CSL-JSON must be an array or {items: [...]}')
  const records: ImportRecord[] = []
  let skipped = 0
  for (const item of items) {
    if (typeof item !== 'object' || item === null) {
      skipped += 1
      continue
    }
    const raw = item as Record<string, unknown>
    const title = typeof raw.title === 'string' ? clean(raw.title) : ''
    if (title === '') {
      skipped += 1
      continue
    }
    const authors = cslAuthors(raw.author)
    const issued = typeof raw.issued === 'object' && raw.issued !== null ? raw.issued as { 'date-parts'?: unknown } : undefined
    const parts = Array.isArray(issued?.['date-parts']) ? issued['date-parts'] : []
    const first = Array.isArray(parts[0]) ? parts[0] : []
    const year = typeof first[0] === 'number' ? first[0] : undefined
    const doi = normalizeDoi(typeof raw.DOI === 'string' ? raw.DOI : undefined)
    const pmid = normalizePmid(typeof raw.PMID === 'string' ? raw.PMID : undefined)
    const arxiv = normalizeArxiv(typeof raw.arXiv === 'string' ? raw.arXiv : typeof raw.arxiv === 'string' ? raw.arxiv : undefined)
    records.push({
      title,
      ...(authors.length === 0 ? {} : { authors }),
      ...(year === undefined ? {} : { year }),
      ...(doi === undefined ? {} : { doi }),
      ...(pmid === undefined ? {} : { pmid }),
      ...(arxiv === undefined ? {} : { arxiv }),
    })
  }
  return { records, skipped }
}

function parseCsvLine(line: string): string[] {
  const values: string[] = []
  let value = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (char === ',' && !quoted) {
      values.push(value)
      value = ''
    } else {
      value += char
    }
  }
  values.push(value)
  return values
}

/**
 * Parse a CSV export whose header names title/authors/year/doi/pmid/arxiv.
 * @param text - the file contents.
 * @returns records plus skipped-row count.
 */
export function parseCsv(text: string): { records: ImportRecord[]; skipped: number } {
  const lines = text.split(/\r?\n/u).filter(line => line.trim() !== '')
  if (lines.length < 2) return { records: [], skipped: 0 }
  const header = parseCsvLine(lines[0]!).map(cell => cell.trim().toLowerCase())
  const indexOf = (...names: string[]): number => {
    for (const name of names) {
      const index = header.indexOf(name)
      if (index !== -1) return index
    }
    return -1
  }
  const titleIndex = indexOf('title', 'ti', 't1')
  if (titleIndex === -1) throw new ImportError('PARSE_FAILED', 'CSV header has no title column')
  const authorsIndex = indexOf('authors', 'author', 'au')
  const yearIndex = indexOf('year', 'py')
  const doiIndex = indexOf('doi', 'do')
  const pmidIndex = indexOf('pmid', 'an')
  const arxivIndex = indexOf('arxiv', 'eprint')
  const records: ImportRecord[] = []
  let skipped = 0
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line)
    const title = clean(cells[titleIndex])
    if (title === '') {
      skipped += 1
      continue
    }
    const authors = authorsIndex === -1
      ? []
      : clean(cells[authorsIndex]).split(/\s*[;|]\s*|\s+and\s+/iu).map(author => clean(author)).filter(author => author !== '')
    const year = yearOf(yearIndex === -1 ? undefined : cells[yearIndex])
    const doi = normalizeDoi(doiIndex === -1 ? undefined : cells[doiIndex])
    const pmid = normalizePmid(pmidIndex === -1 ? undefined : cells[pmidIndex])
    const arxiv = normalizeArxiv(arxivIndex === -1 ? undefined : cells[arxivIndex])
    records.push({
      title,
      ...(authors.length === 0 ? {} : { authors }),
      ...(year === undefined ? {} : { year }),
      ...(doi === undefined ? {} : { doi }),
      ...(pmid === undefined ? {} : { pmid }),
      ...(arxiv === undefined ? {} : { arxiv }),
    })
  }
  return { records, skipped }
}

/**
 * Detect a format from the contents.
 * @param text - the file contents.
 * @returns the detected format, or undefined when nothing matches.
 */
export function detectFormat(text: string): ImportFormat | undefined {
  const trimmed = text.trimStart()
  if (trimmed.startsWith('@')) return 'bibtex'
  if (/^TY\s{0,3}-/mu.test(trimmed)) return 'ris'
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (Array.isArray(parsed) || (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { items?: unknown }).items))) {
        return 'csl-json'
      }
    } catch {
      // fall through to CSV
    }
  }
  const firstLine = trimmed.split(/\r?\n/u, 1)[0] ?? ''
  if (firstLine.includes(',') && /title|ti\b/iu.test(firstLine)) return 'csv'
  return undefined
}

/**
 * Parse an import file.
 * @param text - the file contents.
 * @param format - explicit format, or undefined to detect.
 * @returns the parsed records, format, skipped count and warnings.
 */
export function parseImport(text: string, format?: ImportFormat): ImportParseResult {
  const resolved = format ?? detectFormat(text)
  if (resolved === undefined) {
    throw new ImportError('INVALID_FORMAT', 'could not detect RIS/BibTeX/CSL-JSON/CSV; pass format explicitly')
  }
  const parsed = resolved === 'ris'
    ? parseRis(text)
    : resolved === 'bibtex'
      ? parseBibtex(text)
      : resolved === 'csl-json'
        ? parseCslJson(text)
        : parseCsv(text)
  const warnings: string[] = []
  if (parsed.skipped > 0) warnings.push(`${parsed.skipped} entr${parsed.skipped === 1 ? 'y' : 'ies'} skipped (no usable title or malformed)`)
  return { format: resolved, records: parsed.records, skipped: parsed.skipped, warnings }
}
