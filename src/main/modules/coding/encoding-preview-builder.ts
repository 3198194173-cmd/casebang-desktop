import { posix } from 'node:path'
import type {
  BuildEncodingPreviewInput,
  EncodingPoolSummary,
  EncodingPreviewResult,
  EncodingPreviewRow
} from '@shared/coding-contracts'
import { readOoxmlParts } from '../spreadsheet/ooxml-package'
import { buildSeriesCodeReservePlan, resolveNextSeriesRecord } from '@shared/series-code'

interface CellValue {
  address: string
  column: string
  row: number
  value: string
}

interface ProductPool {
  header: string
  column: string
  prefixes: string[]
  codesByPrefix: Map<string, string[]>
}

const PRODUCT_HEADER_ALIASES: Record<string, string[]> = {
  '磁吸背盖': ['磁吸背盖'],
  '一体壳/手机壳': ['磁吸背盖'],
  '出镜壳': ['出镜壳出片壳'],
  '出片壳': ['出镜壳出片壳'],
  '出彩壳': ['出彩壳'],
  '磁吸支架背盖': ['磁吸支架背盖'],
  '流沙磁吸支架背盖': ['磁吸支架背盖'],
  '磁吸气囊支架': ['磁吸气囊支架'],
  'CP002磁吸充电宝': ['cp002mp16磁吸充电宝'],
  'MP16磁吸充电宝': ['cp002mp16磁吸充电宝'],
  'CP006自带线移动电源': ['cp006自带线移动电源'],
  'Pad保护壳': ['ipad保护壳'],
  'iPad保护壳': ['ipad保护壳'],
  'Macbook保护壳': ['macbook保护壳'],
  '推卡卡包': ['卡包'],
  '卡包': ['卡包'],
  '奇趣礼盒': ['奇趣礼盒'],
  '奇趣壳': ['奇趣壳'],
  '奇趣气囊支架': ['奇趣气囊支架'],
  '奇趣挂绳': ['奇趣挂绳'],
  '镜头框': ['镜头框'],
  '镜头膜': ['镜头膜'],
  '流沙镜头膜': ['镜头膜']
}

const PREFIX_FALLBACK_BY_HEADER: Record<string, string> = {
  '磁吸背盖': 'BG',
  '出镜壳出片壳': 'CZ',
  '出彩壳': 'CCK',
  '磁吸支架背盖': 'ZJBG',
  '磁吸气囊支架': 'ZJQN',
  'cp002mp16磁吸充电宝': 'PB',
  'cp006自带线移动电源': 'PBDX',
  'ipad保护壳': 'PC',
  'macbook保护壳': 'MC',
  '卡包': 'KB',
  '奇趣礼盒': 'QQLH',
  '奇趣壳': 'QQK',
  '奇趣气囊支架': 'QQZJ',
  '奇趣挂绳': 'QQGS',
  '镜头框': 'PCK',
  '镜头膜': 'PCM'
}

const PRODUCT_POOL_COLUMNS = [
  { column: 'A', header: '磁吸背盖' },
  { column: 'B', header: '出镜壳/出片壳' },
  { column: 'C', header: '出彩壳' },
  { column: 'D', header: '磁吸支架背盖' },
  { column: 'E', header: '磁吸气囊支架' },
  { column: 'F', header: 'CP002/MP16磁吸充电宝' },
  { column: 'G', header: 'CP006自带线移动电源' },
  { column: 'H', header: 'iPad保护壳' },
  { column: 'I', header: 'Macbook保护壳' },
  { column: 'J', header: '卡包' },
  { column: 'K', header: '奇趣礼盒' },
  { column: 'L', header: '奇趣壳' },
  { column: 'M', header: '奇趣气囊支架' },
  { column: 'N', header: '奇趣挂绳' },
  { column: 'O', header: '镜头框' },
  { column: 'P', header: '镜头膜' }
] as const

const PRODUCT_COLUMN_BY_CATEGORY: Record<string, string> = {
  '磁吸背盖': 'A',
  '一体壳手机壳': 'A',
  '出镜壳': 'B',
  '出片壳': 'B',
  '出彩壳': 'C',
  '磁吸支架背盖': 'D',
  '流沙磁吸支架背盖': 'D',
  '磁吸气囊支架': 'E',
  'cp002磁吸充电宝': 'F',
  'mp16磁吸充电宝': 'F',
  'cp006自带线移动电源': 'G',
  'pad保护壳': 'H',
  'ipad保护壳': 'H',
  'macbook保护壳': 'I',
  '推卡卡包': 'J',
  '卡包': 'J',
  '奇趣礼盒': 'K',
  '奇趣壳': 'L',
  '奇趣气囊支架': 'M',
  '奇趣挂绳': 'N',
  '镜头框': 'O',
  '镜头膜': 'P',
  '流沙镜头膜': 'P'
}

export async function buildEncodingPreviewFromWorkbook(
  sourcePath: string,
  input: BuildEncodingPreviewInput
): Promise<EncodingPreviewResult> {
  const bootstrap = await readOoxmlParts(sourcePath, ['xl/workbook.xml', 'xl/_rels/workbook.xml.rels'])
  const sheetPaths = parseSheetPaths(
    requireBuffer(bootstrap, 'xl/workbook.xml').toString('utf8'),
    requireBuffer(bootstrap, 'xl/_rels/workbook.xml.rels').toString('utf8')
  )
  const seriesSheet = findSheet(sheetPaths, /系列名.*对应.*代码|系列.*代码/i)
  const usedCodeSheet = findSheet(sheetPaths, /已使用编码/i)
  const parts = await readOoxmlParts(sourcePath, ['xl/sharedStrings.xml', seriesSheet.path, usedCodeSheet.path])
  const sharedStrings = parseSharedStrings(requireBuffer(parts, 'xl/sharedStrings.xml').toString('utf8'))
  const seriesCells = parseCells(requireBuffer(parts, seriesSheet.path).toString('utf8'), sharedStrings)
  const usedCodeCells = parseCells(requireBuffer(parts, usedCodeSheet.path).toString('utf8'), sharedStrings)
  const series = resolveSeriesCode(seriesCells, input.seriesNameZh, input.seriesNameEn)
  const seriesRows = buildGridRows(seriesCells, 1, maximumCellRow(seriesCells), 4)
  const pools = parseProductPools(usedCodeCells)
  const rows = allocateProductRows(input, pools)
  const warnings = rows.filter((row) => row.status !== 'ready').map((row) => row.message)
  const usedCodeHeaderRow = detectProductPoolHeaderRow(usedCodeCells) ?? 1

  return {
    generatedAt: new Date().toISOString(),
    seriesCode: series.code,
    recommendedSeriesCode: series.code,
    seriesCodeWithSuffix: `${series.code}系列`,
    seriesCodeStatus: series.status,
    seriesCodeMessage: series.message,
    usedSeriesCodes: series.usedCodes,
    seriesCodeReservePlan: buildSeriesCodeReservePlan(seriesRows, series.code),
    rows,
    pools: pools.map(toPoolSummary),
    warnings: [...new Set(warnings)],
    referencePreview: {
      seriesSheetName: seriesSheet.name,
      seriesRows,
      usedCodeSheetName: usedCodeSheet.name,
      usedCodeHeaderRow,
      usedCodeRows: buildGridRows(usedCodeCells, usedCodeHeaderRow, maximumCellRow(usedCodeCells), 16)
    }
  }
}

function buildGridRows(cells: CellValue[], startRow: number, endRow: number, columnCount: number): Array<{ row: number; values: string[] }> {
  const byAddress = new Map(cells.map((cell) => [`${cell.column}${cell.row}`, cell.value]))
  return Array.from({ length: Math.max(0, endRow - startRow + 1) }, (_, offset) => {
    const row = startRow + offset
    return {
      row,
      values: Array.from({ length: columnCount }, (_, column) => byAddress.get(`${columnName(column + 1)}${row}`) ?? '')
    }
  })
}

function maximumCellRow(cells: CellValue[]): number {
  return Math.max(1, ...cells.map((cell) => cell.row))
}

function columnName(index: number): string {
  let value = index
  let name = ''
  while (value > 0) {
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name
    value = Math.floor((value - 1) / 26)
  }
  return name
}

function resolveSeriesCode(cells: CellValue[], _chineseName: string, _englishName: string): {
  code: string
  status: 'existing' | 'new'
  message: string
  usedCodes: string[]
} {
  const rows = new Map<number, Map<string, string>>()
  for (const cell of cells) {
    const row = rows.get(cell.row) ?? new Map<string, string>()
    row.set(cell.column, cell.value.trim())
    rows.set(cell.row, row)
  }
  const next = resolveNextSeriesRecord([...rows.entries()].map(([row, values]) => ({
    row,
    values: [values.get('A') ?? '', values.get('B') ?? '', values.get('C') ?? '']
  })))
  return {
    code: next.code,
    status: 'new',
    message: `新建表流程只新增记录，已按最后一条已填系列记录顺延为 ${next.code}；不会按中英文名称复用旧系列码。`,
    usedCodes: next.usedCodes
  }
}

function parseProductPools(cells: CellValue[]): ProductPool[] {
  const headerRow = detectProductPoolHeaderRow(cells)
  return PRODUCT_POOL_COLUMNS.map((definition) => {
    const header = cells.find((cell) => cell.row === headerRow && cell.column === definition.column)
    const codesByPrefix = new Map<string, string[]>()
    for (const cell of cells) {
      if (cell.column !== definition.column || cell.row === headerRow) continue
      for (const match of cell.value.toUpperCase().matchAll(/\b([A-Z]{2,6})(\d{5})\b/g)) {
        const code = `${match[1]}${match[2]}`
        const codes = codesByPrefix.get(match[1] ?? '') ?? []
        if (!codes.includes(code)) codes.push(code)
        codesByPrefix.set(match[1] ?? '', codes)
      }
    }
    return {
      header: header?.value.trim() || definition.header,
      column: definition.column,
      prefixes: [...codesByPrefix.keys()],
      codesByPrefix
    }
  })
}

function detectProductPoolHeaderRow(cells: CellValue[]): number | null {
  const scoreByRow = new Map<number, number>()
  for (const cell of cells) {
    if (!isProductPoolHeader(cell.value)) continue
    scoreByRow.set(cell.row, (scoreByRow.get(cell.row) ?? 0) + 1)
  }
  const best = [...scoreByRow.entries()].toSorted((left, right) => right[1] - left[1])[0]
  return best && best[1] >= 3 ? best[0] : null
}

function isProductPoolHeader(value: string): boolean {
  return Object.hasOwn(PREFIX_FALLBACK_BY_HEADER, normalizeHeader(value))
}

function allocateProductRows(input: BuildEncodingPreviewInput, pools: ProductPool[]): EncodingPreviewRow[] {
  const assignments = new Map<string, EncodingPreviewRow>()
  const resolved = input.crops.map((crop, order) => ({ crop, order, pool: resolvePool(crop.productCategory, pools) }))
  const globallyUsedCodes = new Set(pools.flatMap((pool) => [...pool.codesByPrefix.values()].flat()))

  for (const item of resolved.filter((candidate) => !candidate.pool)) {
    assignments.set(item.crop.cropId, {
      ...item.crop,
      order: item.order + 1,
      poolHeader: null,
      poolColumn: null,
      prefix: null,
      previousLatestCode: null,
      productCode: '',
      status: 'unmapped',
      message: `产品类别“${item.crop.productCategory}”未匹配到“已使用编码”表头，请人工选择编码池。`
    })
  }

  const pairedItems = resolved.filter((item) => item.pool && ['磁吸支架背盖', '磁吸气囊支架'].includes(normalizeHeader(item.pool.header)))
  if (pairedItems.length > 0) allocatePairedStandRows(pairedItems, pools, assignments, globallyUsedCodes)

  const byPool = new Map<string, typeof resolved>()
  for (const item of resolved) {
    if (!item.pool || pairedItems.includes(item)) continue
    const list = byPool.get(item.pool.column) ?? []
    list.push(item)
    byPool.set(item.pool.column, list)
  }
  for (const items of byPool.values()) {
    const pool = items[0]?.pool
    if (!pool) continue
    const prefix = choosePrefix(pool)
    const usedCodes = pool.codesByPrefix.get(prefix) ?? []
    let nextNumber = maximumCodeNumber(usedCodes) + 1
    for (const item of items) {
      while (globallyUsedCodes.has(formatProductCode(prefix, nextNumber))) nextNumber += 1
      assignments.set(item.crop.cropId, readyRow(item, pool, prefix, nextNumber))
      globallyUsedCodes.add(formatProductCode(prefix, nextNumber))
      nextNumber += 1
    }
  }

  return input.crops.map((crop) => assignments.get(crop.cropId)!).filter(Boolean)
}

function allocatePairedStandRows(
  items: Array<{ crop: BuildEncodingPreviewInput['crops'][number]; order: number; pool: ProductPool | null }>,
  pools: ProductPool[],
  assignments: Map<string, EncodingPreviewRow>,
  globallyUsedCodes: Set<string>
): void {
  const standPools = pools.filter((pool) => ['磁吸支架背盖', '磁吸气囊支架'].includes(normalizeHeader(pool.header)))
  const baseline = Math.max(0, ...standPools.flatMap((pool) => [...pool.codesByPrefix.values()].flatMap((codes) => codes.map(codeNumber))))
  const numberByPattern = new Map<string, number>()
  let nextNumber = baseline + 1
  for (const item of items) {
    const pool = item.pool
    if (!pool) continue
    const unitKey = item.crop.patternGroupId ?? item.crop.cropId
    let number = numberByPattern.get(unitKey)
    if (number === undefined) {
      const requiredPrefixes = items
        .filter((candidate) => (candidate.crop.patternGroupId ?? candidate.crop.cropId) === unitKey && candidate.pool)
        .map((candidate) => choosePrefix(candidate.pool!))
      while (requiredPrefixes.some((prefix) => globallyUsedCodes.has(formatProductCode(prefix, nextNumber)))) nextNumber += 1
      number = nextNumber
      nextNumber += 1
      numberByPattern.set(unitKey, number)
    }
    const prefix = choosePrefix(pool)
    assignments.set(item.crop.cropId, readyRow(item, pool, prefix, number))
    globallyUsedCodes.add(formatProductCode(prefix, number))
  }
}

function readyRow(
  item: { crop: BuildEncodingPreviewInput['crops'][number]; order: number },
  pool: ProductPool,
  prefix: string,
  number: number
): EncodingPreviewRow {
  const usedCodes = pool.codesByPrefix.get(prefix) ?? []
  return {
    ...item.crop,
    order: item.order + 1,
    poolHeader: pool.header,
    poolColumn: pool.column,
    prefix,
    previousLatestCode: latestCode(usedCodes),
    productCode: formatProductCode(prefix, number),
    status: 'ready',
    message: `依据“已使用编码”${pool.column}列“${pool.header}”顺序分配。`
  }
}

function resolvePool(category: string, pools: ProductPool[]): ProductPool | null {
  const normalizedCategory = normalizeHeader(category)
  const aliases = PRODUCT_HEADER_ALIASES[category] ?? [normalizedCategory]
  return pools.find((pool) => aliases.includes(normalizeHeader(pool.header)))
    ?? pools.find((pool) => aliases.some((alias) => normalizeHeader(pool.header).includes(alias) || alias.includes(normalizeHeader(pool.header))))
    ?? pools.find((pool) => pool.column === PRODUCT_COLUMN_BY_CATEGORY[normalizedCategory])
    ?? null
}

function choosePrefix(pool: ProductPool): string {
  if (pool.prefixes.length === 1 && pool.prefixes[0]) return pool.prefixes[0]
  const fallback = PREFIX_FALLBACK_BY_HEADER[normalizeHeader(pool.header)]
  if (fallback && (pool.prefixes.length === 0 || pool.prefixes.includes(fallback))) return fallback
  return pool.prefixes.toSorted((left, right) => (pool.codesByPrefix.get(right)?.length ?? 0) - (pool.codesByPrefix.get(left)?.length ?? 0))[0] ?? fallback ?? 'CODE'
}

function toPoolSummary(pool: ProductPool): EncodingPoolSummary {
  const prefix = choosePrefix(pool)
  const usedCodes = pool.codesByPrefix.get(prefix) ?? []
  return {
    header: pool.header,
    column: pool.column,
    prefixes: pool.prefixes,
    usedCount: [...pool.codesByPrefix.values()].reduce((sum, codes) => sum + codes.length, 0),
    latestCode: latestCode(usedCodes),
    usedCodes: [...pool.codesByPrefix.values()].flat()
  }
}

function latestCode(codes: string[]): string | null {
  return codes.toSorted((left, right) => codeNumber(right) - codeNumber(left))[0] ?? null
}

function maximumCodeNumber(codes: string[]): number {
  return Math.max(0, ...codes.map(codeNumber))
}

function codeNumber(code: string): number {
  return Number(/(\d+)$/.exec(code)?.[1] ?? 0)
}

function formatProductCode(prefix: string, number: number): string {
  return `${prefix}${number.toString().padStart(5, '0')}`
}

function normalizeHeader(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\s\u200b-\u200d\ufeff/\\+()（）_-]+/g, '')
}

function normalizeSeriesName(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/系列$/u, '').replace(/[\s·._\-–—()（）]+/g, '')
}

function normalizeEnglishName(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/#[a-z]\d+.*$/i, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

function parseSheetPaths(workbookXml: string, relationshipsXml: string): Array<{ name: string; path: string }> {
  const relationshipMap = new Map<string, string>()
  for (const match of relationshipsXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)) {
    const attributes = parseAttributes(match[1] ?? '')
    if (attributes.Id && attributes.Target) relationshipMap.set(attributes.Id, attributes.Target)
  }
  const result: Array<{ name: string; path: string }> = []
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/?\s*>/g)) {
    const attributes = parseAttributes(match[1] ?? '')
    const target = relationshipMap.get(attributes['r:id'] ?? '')
    if (!attributes.name || !target) continue
    result.push({
      name: decodeXml(attributes.name),
      path: target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join('xl', target))
    })
  }
  return result
}

function findSheet(sheets: Array<{ name: string; path: string }>, pattern: RegExp): { name: string; path: string } {
  const sheet = sheets.find((candidate) => pattern.test(candidate.name))
  if (!sheet) throw new Error(`A条码参考中缺少工作表：${pattern.source}`)
  return sheet
}

function parseSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) =>
    [...(match[1] ?? '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((text) => decodeXml(text[1] ?? '')).join('')
  )
}

function parseCells(xml: string, sharedStrings: string[]): CellValue[] {
  const result: CellValue[] = []
  // Match self-closing cells first. Treating `<c .../>` as an opening cell can
  // consume the following populated cell and make the reference data incomplete.
  const pattern = /<c\b([^>]*\br="([A-Z]+)(\d+)"[^>]*)\/>|<c\b([^>]*\br="([A-Z]+)(\d+)"[^>]*?)(?<!\/)>([\s\S]*?)<\/c>/g
  for (const match of xml.matchAll(pattern)) {
    const attributes = parseAttributes(match[1] ?? match[4] ?? '')
    const column = match[2] ?? match[5] ?? ''
    const row = Number(match[3] ?? match[6] ?? 0)
    const body = match[7] ?? ''
    const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? ''
    const formula = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(body)?.[1]
    const value = formula
      ? `=${decodeXml(formula)}`
      : attributes.t === 's'
      ? sharedStrings[Number(raw)] ?? ''
      : attributes.t === 'inlineStr'
        ? [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((item) => decodeXml(item[1] ?? '')).join('')
        : decodeXml(raw)
    result.push({ address: `${column}${row}`, column, row, value })
  }
  return result
}

function parseAttributes(source: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const match of source.matchAll(/([\w:-]+)="([^"]*)"/g)) result[match[1] ?? ''] = match[2] ?? ''
  return result
}

function decodeXml(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

function requireBuffer(parts: Map<string, Buffer>, path: string): Buffer {
  const buffer = parts.get(path)
  if (!buffer) throw new Error(`工作簿缺少必要部件：${path}`)
  return buffer
}
