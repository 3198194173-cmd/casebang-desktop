import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type {
  GeneratedTemplateConfig,
  TemplateConfigBundle,
  TemplateFieldBinding,
  TemplateFieldKey,
  TemplateFieldWriteMode
} from '@shared/excel-contracts'
import type { DomesticPatternNameRecord, SeriesTranslation } from '@shared/contracts'
import { OoxmlWorkbookInspector } from './ooxml-workbook-inspector'
import { findPackageText, readOoxmlPackage } from './ooxml-package'

interface CellRecord {
  address: string
  column: string
  row: number
  value: string
  formula: string | null
}

interface WorkbookSheet {
  name: string
  path: string
}

interface FieldDefinition {
  field: TemplateFieldKey
  label: string
  aliases: string[]
  defaultMode: TemplateFieldWriteMode
}

const FIELD_DEFINITIONS: FieldDefinition[] = [
  { field: 'barcodeName', label: '条码名', aliases: ['条码名', '条码名称', '完整条码名'], defaultMode: 'readonly' },
  { field: 'image', label: '图片', aliases: ['图片', '产品图片', '产品图'], defaultMode: 'readonly' },
  { field: 'color', label: '颜色', aliases: ['颜色', '材质颜色', '产品颜色'], defaultMode: 'value' },
  { field: 'seriesName', label: '系列名称', aliases: ['系列名称', '系列名', '系列英文名'], defaultMode: 'value' },
  { field: 'seriesNameUppercase', label: '系列名称（大写）', aliases: ['系列名称大写', '系列名大写', '系列英文名大写'], defaultMode: 'value' },
  { field: 'seriesCode', label: '系列编码', aliases: ['系列编码', '系列代码', '系列名代码'], defaultMode: 'value' },
  { field: 'productCode', label: '产品编码', aliases: ['产品编码', '产品代码'], defaultMode: 'value' },
  { field: 'patternName', label: '图片对应名称', aliases: ['图片对应名称', '图案名称', '图片名称', '图案英文名'], defaultMode: 'value' },
  { field: 'patternNameUppercase', label: '图片对应名称（大写）', aliases: ['图片对应名称大写', '图案名称大写', '图片名称大写'], defaultMode: 'value' },
  { field: 'finalName', label: '图档名', aliases: ['图档名', '最终名称', '文件名'], defaultMode: 'readonly' }
]

const DEFINITIONS_BY_ALIAS = new Map(
  FIELD_DEFINITIONS.flatMap((definition) =>
    definition.aliases.map((alias) => [normalizeHeader(alias), definition] as const)
  )
)

export class TemplateConfigGenerator {
  constructor(private readonly inspector = new OoxmlWorkbookInspector()) {}

  async generate(sourcePath: string): Promise<TemplateConfigBundle> {
    const inspection = await this.inspector.inspect(sourcePath, 'naming-formula')
    const entries = await readOoxmlPackage(sourcePath)
    const sharedStrings = parseSharedStrings(findPackageText(entries, 'xl/sharedStrings.xml'))
    const sheets = parseWorkbookSheets(
      requirePart(entries, 'xl/workbook.xml'),
      requirePart(entries, 'xl/_rels/workbook.xml.rels')
    )
    const templateCandidates = inspection.templates.filter((item) => item.classification === 'template')
    const warnings: string[] = []
    const templates = templateCandidates.map((candidate): GeneratedTemplateConfig => {
      const sheet = sheets.find((item) => item.name === candidate.sheetName)
      if (!sheet) throw new Error(`无法解析模板工作表：${candidate.sheetName}`)
      const xml = requirePart(entries, sheet.path)
      const cells = parseCells(xml, sharedStrings)
      const header = detectHeaderRow(cells)
      if (!header) {
        warnings.push(`${sheet.name}：未找到可识别的字段表头`)
        return {
          id: candidate.id,
          sheetName: sheet.name,
          sheetPartPath: sheet.path,
          headerRow: 1,
          usedRange: inspection.worksheets.find((item) => item.name === sheet.name)?.usedRange ?? null,
          sourcePartCrc32: inspection.worksheets.find((item) => item.name === sheet.name)?.partCrc32 ?? '',
          fields: [],
          allowedWriteFields: [],
          warnings: ['未找到可识别的字段表头，模板暂不可自动写入']
        }
      }

      const fields = header.cells.flatMap((cell): TemplateFieldBinding[] => {
        const definition = resolveFieldDefinition(cell.value)
        if (!definition) return []
        const sampleFormula = cells.find(
          (candidateCell) =>
            candidateCell.column === cell.column &&
            candidateCell.row > header.row &&
            candidateCell.row <= header.row + 30 &&
            candidateCell.formula
        )?.formula ?? null
        const writeMode: TemplateFieldWriteMode = sampleFormula ? 'formula' : definition.defaultMode
        return [{
          field: definition.field,
          label: definition.label,
          column: cell.column,
          columnIndex: columnToNumber(cell.column),
          header: cell.value,
          headerCell: cell.address,
          writeMode,
          confidence: isEmbeddedImageFormula(cell.value)
            ? 0.98
            : normalizeHeader(cell.value) === normalizeHeader(definition.aliases[0] ?? '') ? 1 : 0.92,
          sampleFormula
        }]
      })
      const templateWarnings = buildTemplateWarnings(fields)
      warnings.push(...templateWarnings.map((warning) => `${sheet.name}：${warning}`))
      return {
        id: candidate.id,
        sheetName: sheet.name,
        sheetPartPath: sheet.path,
        headerRow: header.row,
        usedRange: inspection.worksheets.find((item) => item.name === sheet.name)?.usedRange ?? null,
        sourcePartCrc32: inspection.worksheets.find((item) => item.name === sheet.name)?.partCrc32 ?? '',
        fields,
        allowedWriteFields: fields.filter((field) => field.writeMode === 'value').map((field) => field.field),
        warnings: templateWarnings
      }
    })

    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sourcePath,
      sourceSha256: inspection.sha256,
      templates,
      warnings
    }
  }
}

function parseWorkbookSheets(workbookXml: string, relationshipsXml: string): WorkbookSheet[] {
  const relationshipMap = new Map<string, string>()
  for (const match of relationshipsXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)) {
    const attributes = parseAttributes(match[1] ?? '')
    if (attributes.Id && attributes.Target) relationshipMap.set(attributes.Id, attributes.Target)
  }
  const sheets: WorkbookSheet[] = []
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/?\s*>/g)) {
    const attributes = parseAttributes(match[1] ?? '')
    const relationshipId = attributes['r:id']
    const target = relationshipId ? relationshipMap.get(relationshipId) : null
    if (!attributes.name || !target) continue
    sheets.push({
      name: decodeXml(attributes.name),
      path: target.startsWith('/')
        ? target.slice(1)
        : posix.normalize(posix.join('xl', target))
    })
  }
  return sheets
}

function parseSharedStrings(xml: string | null): string[] {
  if (!xml) return []
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) =>
    [...(match[1] ?? '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
      .map((text) => decodeXml(text[1] ?? ''))
      .join('')
  )
}

function parseCells(xml: string, sharedStrings: string[]): CellRecord[] {
  const records: CellRecord[] = []
  const cellPattern = /<c\b([^>]*\br="([A-Z]+)(\d+)"[^>]*)\/>|<c\b([^>]*\br="([A-Z]+)(\d+)"[^>]*?)(?<!\/)>([\s\S]*?)<\/c>/g
  for (const match of xml.matchAll(cellPattern)) {
    const attributes = parseAttributes(match[1] ?? match[4] ?? '')
    const column = match[2] ?? match[5] ?? ''
    const row = Number(match[3] ?? match[6] ?? '0')
    const body = match[7] ?? ''
    const formula = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(body)?.[1]
    records.push({
      address: `${column}${row}`,
      column,
      row,
      value: readCellValue(attributes.t, body, sharedStrings),
      formula: formula === undefined ? null : decodeXml(formula)
    })
  }
  return records
}

function readCellValue(type: string | undefined, body: string, sharedStrings: string[]): string {
  if (type === 'inlineStr') {
    return [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((item) => decodeXml(item[1] ?? '')).join('')
  }
  const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? ''
  if (type === 's') return sharedStrings[Number(raw)] ?? ''
  return decodeXml(raw)
}

function detectHeaderRow(cells: CellRecord[]): { row: number; cells: CellRecord[] } | null {
  let best: { row: number; cells: CellRecord[]; score: number } | null = null
  const rows = new Map<number, CellRecord[]>()
  cells.filter((cell) => cell.row <= 20).forEach((cell) => {
    const row = rows.get(cell.row) ?? []
    row.push(cell)
    rows.set(cell.row, row)
  })
  for (const [row, rowCells] of rows) {
    const recognized = rowCells.filter((cell) => resolveFieldDefinition(cell.value))
    const score = recognized.length * 10 + (recognized.some((cell) => normalizeHeader(cell.value) === '条码名') ? 3 : 0)
    if (recognized.length >= 2 && (!best || score > best.score)) best = { row, cells: rowCells, score }
  }
  return best ? { row: best.row, cells: best.cells } : null
}

function buildTemplateWarnings(fields: TemplateFieldBinding[]): string[] {
  const warnings: string[] = []
  const required: TemplateFieldKey[] = ['barcodeName', 'seriesName', 'seriesCode', 'productCode', 'patternName']
  for (const field of required) {
    if (!fields.some((binding) => binding.field === field)) warnings.push(`缺少字段：${field}`)
  }
  const duplicates = fields.filter((field, index) => fields.findIndex((item) => item.field === field.field) !== index)
  if (duplicates.length > 0) warnings.push(`字段重复：${[...new Set(duplicates.map((item) => item.field))].join(', ')}`)
  return warnings
}

function normalizeHeader(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN').replace(/[\s()（）【】\[\]：:·_-]+/g, '')
}

function resolveFieldDefinition(value: string): FieldDefinition | undefined {
  if (isEmbeddedImageFormula(value)) return FIELD_DEFINITIONS.find((item) => item.field === 'image')
  return DEFINITIONS_BY_ALIAS.get(normalizeHeader(value))
}

function isEmbeddedImageFormula(value: string): boolean {
  return /^=?(?:DISPIMG|_xlfn\.DISPIMG)\s*\(/i.test(value.trim())
}

function parseAttributes(source: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const match of source.matchAll(/([\w:-]+)="([^"]*)"/g)) result[match[1] ?? ''] = match[2] ?? ''
  return result
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
}

function columnToNumber(column: string): number {
  return [...column].reduce((value, character) => value * 26 + character.charCodeAt(0) - 64, 0)
}

function requirePart(entries: Awaited<ReturnType<typeof readOoxmlPackage>>, path: string): string {
  const text = findPackageText(entries, path)
  if (text === null) throw new Error(`工作簿缺少必要部件：${path}`)
  return text
}

export function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export async function extractProductTypesFromWorkbook(sourcePath: string): Promise<string[]> {
  const entries = await readOoxmlPackage(sourcePath)
  const sharedStrings = parseSharedStrings(findPackageText(entries, 'xl/sharedStrings.xml'))
  const productTypes = new Set<string>()
  for (const entry of entries) {
    if (!/^xl\/worksheets\/[^/]+\.xml$/i.test(entry.path) || !entry.buffer) continue
    for (const cell of parseCells(entry.buffer.toString('utf8'), sharedStrings)) {
      const match = /^CASEBANG\s+(.+?)-/.exec(cell.value.trim())
      if (match?.[1]) productTypes.add(match[1].trim())
    }
  }
  return [...productTypes].sort((left, right) => left.localeCompare(right, 'zh-CN'))
}

export async function extractSeriesTranslationsFromWorkbook(sourcePath: string): Promise<SeriesTranslation[]> {
  const entries = await readOoxmlPackage(sourcePath)
  const sharedStrings = parseSharedStrings(findPackageText(entries, 'xl/sharedStrings.xml'))
  const sheets = parseWorkbookSheets(
    requirePart(entries, 'xl/workbook.xml'),
    requirePart(entries, 'xl/_rels/workbook.xml.rels')
  ).filter((sheet) => /系列名.*代码|系列.*对应/i.test(sheet.name))
  const translations = new Map<string, SeriesTranslation>()

  for (const sheet of sheets) {
    const cells = parseCells(requirePart(entries, sheet.path), sharedStrings)
    const rows = new Map<number, Map<string, string>>()
    for (const cell of cells) {
      const row = rows.get(cell.row) ?? new Map<string, string>()
      row.set(cell.column, cell.value.trim())
      rows.set(cell.row, row)
    }
    for (const row of rows.values()) {
      const englishName = cleanEnglishSeriesName(row.get('B') ?? '')
      const chineseName = (row.get('C') ?? '').trim()
      if (!/[a-z]/i.test(englishName) || !/[\u3400-\u9fff]/u.test(chineseName)) continue
      translations.set(normalizeSeriesLookup(chineseName), { chineseName, englishName })
    }
  }
  return [...translations.values()]
}

export async function extractDomesticPatternNamesFromWorkbook(sourcePath: string): Promise<DomesticPatternNameRecord[]> {
  const entries = await readOoxmlPackage(sourcePath)
  const sharedStrings = parseSharedStrings(findPackageText(entries, 'xl/sharedStrings.xml'))
  const sheets = parseWorkbookSheets(
    requirePart(entries, 'xl/workbook.xml'),
    requirePart(entries, 'xl/_rels/workbook.xml.rels')
  )
  const records = new Map<string, DomesticPatternNameRecord>()

  for (const sheet of sheets) {
    const cells = parseCells(requirePart(entries, sheet.path), sharedStrings)
    for (const cell of cells) {
      const englishName = cell.value.normalize('NFKC').replace(/\s+/g, ' ').trim()
      if (!isLikelyDomesticPatternName(englishName)) continue
      const key = englishName.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, ' ').trim()
      if (!records.has(key)) records.set(key, { englishName, sheetName: sheet.name, cellAddress: cell.address })
    }
  }

  return [...records.values()]
}

const DOMESTIC_NAME_EXCLUSIONS = new Set([
  'casebang', 'product name', 'product code', 'series name', 'image name', 'pattern name',
  'english name', 'chinese name', 'color', 'barcode', 'barcode name', 'series', 'name',
  'image', 'product', 'code', 'template', 'macbook', 'ipad'
])

function isLikelyDomesticPatternName(value: string): boolean {
  if (value.length < 3 || value.length > 100 || !/^[a-z]/i.test(value)) return false
  if (!/^[a-z0-9&'’.,!?+\- ]+$/i.test(value)) return false
  const words = value.match(/[a-z0-9]+/gi) ?? []
  if (words.length === 0 || (words.length === 1 && value.length < 4)) return false
  return !DOMESTIC_NAME_EXCLUSIONS.has(value.toLocaleLowerCase('en-US'))
}

function cleanEnglishSeriesName(value: string): string {
  return value.replace(/#[a-z]\d+.*$/i, '').replace(/[\s\-–—]+$/g, '').trim()
}

function normalizeSeriesLookup(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/系列$/u, '').replace(/[\s·._\-–—()（）]+/g, '')
}
