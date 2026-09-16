import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, posix } from 'node:path'
import { XMLParser } from 'fast-xml-parser'
import yauzl, { type Entry, type ZipFile } from 'yauzl'
import type {
  OoxmlComponentFingerprints,
  TemplateCandidate,
  WorkbookInspection,
  WorkbookRole,
  WorksheetMetrics
} from './ooxml-types'

interface EntrySignature {
  name: string
  crc32: string
  compressedBytes: number
  uncompressedBytes: number
}

interface WorkbookSheetRecord {
  name: string
  sheetId: string
  relationshipId: string
  state: WorksheetMetrics['state']
  partPath: string
}

interface WorksheetAccumulator {
  usedRange: string | null
  formulaCount: number
  styledCellCount: number
  rowCount: number
  customRowHeightCount: number
  columnDefinitionCount: number
  drawingReferenceCount: number
}

interface ScanResult {
  workbookXml: string
  workbookRelsXml: string
  worksheetMetricsByPath: Map<string, Omit<WorksheetMetrics, 'name' | 'sheetId' | 'state'>>
  imageFileCount: number
  imageAnchorCount: number
  styleDefinitionCount: number
  signatures: Record<keyof OoxmlComponentFingerprints, EntrySignature[]>
  warnings: string[]
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: false
})

const REFERENCE_SHEET_PATTERN = /说明|规则|目录|配置|字典|参考|代码|已使用|映射|测试/i

export class OoxmlWorkbookInspector {
  async inspect(sourcePath: string, role: WorkbookRole = 'unknown'): Promise<WorkbookInspection> {
    const sourceStat = await stat(sourcePath)
    if (!sourceStat.isFile()) throw new Error(`不是有效文件：${sourcePath}`)
    if (!/\.xls[xm]$/i.test(sourcePath)) throw new Error('仅支持 .xlsx 或 .xlsm 工作簿')

    const [sha256, scan] = await Promise.all([
      hashFile(sourcePath),
      scanWorkbookPackage(sourcePath)
    ])

    const sheets = parseWorkbookSheets(scan.workbookXml, scan.workbookRelsXml)
    const worksheets = sheets.map((sheet): WorksheetMetrics => {
      const metrics = scan.worksheetMetricsByPath.get(sheet.partPath)
      if (!metrics) {
        scan.warnings.push(`未找到工作表部件：${sheet.name} -> ${sheet.partPath}`)
        return {
          name: sheet.name,
          sheetId: sheet.sheetId,
          state: sheet.state,
          partPath: sheet.partPath,
          usedRange: null,
          formulaCount: 0,
          styledCellCount: 0,
          rowCount: 0,
          customRowHeightCount: 0,
          columnDefinitionCount: 0,
          drawingReferenceCount: 0,
          partCrc32: 'missing',
          uncompressedBytes: 0
        }
      }
      return { ...metrics, name: sheet.name, sheetId: sheet.sheetId, state: sheet.state }
    })

    const templates = classifyTemplates(worksheets, role)

    return {
      role,
      sourcePath,
      fileName: basename(sourcePath),
      fileSize: sourceStat.size,
      modifiedAt: sourceStat.mtime.toISOString(),
      sha256,
      worksheetCount: worksheets.length,
      formulaCount: worksheets.reduce((sum, sheet) => sum + sheet.formulaCount, 0),
      imageFileCount: scan.imageFileCount,
      imageAnchorCount: scan.imageAnchorCount,
      styleDefinitionCount: scan.styleDefinitionCount,
      worksheets,
      templates,
      componentFingerprints: buildComponentFingerprints(scan.signatures),
      warnings: [...new Set(scan.warnings)]
    }
  }
}

export function classifyTemplates(
  worksheets: WorksheetMetrics[],
  role: WorkbookRole
): TemplateCandidate[] {
  if (role !== 'naming-formula') return []

  return worksheets.map((sheet) => {
    if (sheet.state !== 'visible') {
      return {
        id: slugify(sheet.name),
        sheetName: sheet.name,
        classification: 'helper' as const,
        reason: `工作表状态为 ${sheet.state}`,
        sourcePartPath: sheet.partPath,
        state: sheet.state
      }
    }
    if (REFERENCE_SHEET_PATTERN.test(sheet.name)) {
      return {
        id: slugify(sheet.name),
        sheetName: sheet.name,
        classification: 'reference' as const,
        reason: '名称符合规则/说明/参考工作表特征',
        sourcePartPath: sheet.partPath,
        state: sheet.state
      }
    }
    return {
      id: slugify(sheet.name),
      sheetName: sheet.name,
      classification: 'template' as const,
      reason: '可见业务工作表，纳入通用模板清单',
      sourcePartPath: sheet.partPath,
      state: sheet.state
    }
  })
}

function slugify(value: string): string {
  const normalized = value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN')
  const ascii = normalized.replace(/[^a-z0-9\u3400-\u9fff]+/g, '-').replace(/^-|-$/g, '')
  return ascii || createHash('sha1').update(value).digest('hex').slice(0, 12)
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest('hex')
}

async function scanWorkbookPackage(filePath: string): Promise<ScanResult> {
  const result: ScanResult = {
    workbookXml: '',
    workbookRelsXml: '',
    worksheetMetricsByPath: new Map(),
    imageFileCount: 0,
    imageAnchorCount: 0,
    styleDefinitionCount: 0,
    signatures: {
      workbook: [],
      worksheets: [],
      styles: [],
      drawings: [],
      media: [],
      relationships: []
    },
    warnings: []
  }

  const zip = await openZip(filePath)
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      zip.close()
      reject(error)
    }

    zip.on('error', fail)
    zip.on('end', () => {
      if (settled) return
      settled = true
      resolve()
    })
    zip.on('entry', (entry: Entry) => {
      void processEntry(zip, entry, result)
        .then(() => zip.readEntry())
        .catch(fail)
    })
    zip.readEntry()
  })

  if (!result.workbookXml || !result.workbookRelsXml) {
    throw new Error('工作簿缺少 xl/workbook.xml 或关系文件，无法识别工作表')
  }
  return result
}

async function processEntry(zip: ZipFile, entry: Entry, result: ScanResult): Promise<void> {
  const name = normalizeZipPath(entry.fileName)
  if (name.endsWith('/')) return

  const signature = toSignature(entry, name)
  classifySignature(signature, result.signatures)

  if (name === 'xl/workbook.xml') {
    result.workbookXml = await readEntryText(zip, entry, 20 * 1024 * 1024)
    return
  }
  if (name === 'xl/_rels/workbook.xml.rels') {
    result.workbookRelsXml = await readEntryText(zip, entry, 20 * 1024 * 1024)
    return
  }
  if (/^xl\/worksheets\/[^/]+\.xml$/i.test(name)) {
    const metrics = await scanWorksheetXml(zip, entry)
    result.worksheetMetricsByPath.set(name, {
      partPath: name,
      partCrc32: signature.crc32,
      uncompressedBytes: entry.uncompressedSize,
      ...metrics
    })
    return
  }
  if (name === 'xl/styles.xml') {
    const text = await readEntryText(zip, entry, 100 * 1024 * 1024)
    result.styleDefinitionCount = countMatches(text, /<(?:\w+:)?(?:xf|dxf|cellStyle|numFmt)\b/g)
    return
  }
  if (/^xl\/drawings\/drawing[^/]*\.xml$/i.test(name) || name === 'xl/cellimages.xml') {
    const text = await readEntryText(zip, entry, 100 * 1024 * 1024)
    result.imageAnchorCount += countMatches(
      text,
      /<(?:xdr:)?pic\b/g
    )
    return
  }
  if (/^xl\/media\//i.test(name)) result.imageFileCount += 1
}

async function scanWorksheetXml(zip: ZipFile, entry: Entry): Promise<WorksheetAccumulator> {
  const metrics: WorksheetAccumulator = {
    usedRange: null,
    formulaCount: 0,
    styledCellCount: 0,
    rowCount: 0,
    customRowHeightCount: 0,
    columnDefinitionCount: 0,
    drawingReferenceCount: 0
  }

  const stream = await openEntryStream(zip, entry)
  let carry = ''
  await new Promise<void>((resolve, reject) => {
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      const combined = carry + chunk
      const safeLength = Math.max(0, combined.length - 512)
      const safe = combined.slice(0, safeLength)
      carry = combined.slice(safeLength)
      consumeWorksheetXml(safe, metrics)
    })
    stream.on('error', reject)
    stream.on('end', () => {
      consumeWorksheetXml(carry, metrics)
      resolve()
    })
  })
  return metrics
}

function consumeWorksheetXml(xml: string, metrics: WorksheetAccumulator): void {
  if (!metrics.usedRange) {
    metrics.usedRange = /<(?:\w+:)?dimension\b[^>]*\bref="([^"]+)"/i.exec(xml)?.[1] ?? null
  }
  metrics.formulaCount += countMatches(xml, /<(?:\w+:)?f(?:\s|>)/g)
  metrics.styledCellCount += countMatches(xml, /<(?:\w+:)?c\b[^>]*\bs="[^"]+"/g)
  metrics.rowCount += countMatches(xml, /<(?:\w+:)?row(?:\s|>)/g)
  metrics.customRowHeightCount += countMatches(xml, /<(?:\w+:)?row\b[^>]*\bcustomHeight="1"/g)
  metrics.columnDefinitionCount += countMatches(xml, /<(?:\w+:)?col(?:\s|>)/g)
  metrics.drawingReferenceCount += countMatches(xml, /<(?:\w+:)?drawing\b/g)
}

function parseWorkbookSheets(workbookXml: string, relsXml: string): WorkbookSheetRecord[] {
  const workbook = xmlParser.parse(workbookXml) as Record<string, unknown>
  const relationships = xmlParser.parse(relsXml) as Record<string, unknown>
  const workbookNode = getObject(workbook.workbook)
  const sheetsNode = getObject(workbookNode.sheets)
  const sheetNodes = toArray<Record<string, unknown>>(sheetsNode.sheet)
  const relationshipRoot = getObject(relationships.Relationships)
  const relationshipNodes = toArray<Record<string, unknown>>(relationshipRoot.Relationship)
  const relationshipMap = new Map(
    relationshipNodes.map((relationship) => [String(relationship.Id), String(relationship.Target)])
  )

  return sheetNodes.map((sheet) => {
    const relationshipId = String(sheet['r:id'] ?? '')
    const target = relationshipMap.get(relationshipId)
    if (!target) throw new Error(`工作表关系 ${relationshipId} 不存在`)
    return {
      name: String(sheet.name),
      sheetId: String(sheet.sheetId),
      relationshipId,
      state: normalizeSheetState(sheet.state),
      partPath: resolveWorkbookTarget(target)
    }
  })
}

function normalizeSheetState(value: unknown): WorksheetMetrics['state'] {
  if (value === 'hidden' || value === 'veryHidden') return value
  return 'visible'
}

function resolveWorkbookTarget(target: string): string {
  const normalizedTarget = target.replace(/\\/g, '/')
  if (normalizedTarget.startsWith('/')) return normalizeZipPath(normalizedTarget.slice(1))
  return normalizeZipPath(posix.normalize(posix.join('xl', normalizedTarget)))
}

function classifySignature(
  signature: EntrySignature,
  groups: Record<keyof OoxmlComponentFingerprints, EntrySignature[]>
): void {
  const name = signature.name
  if (name === 'xl/workbook.xml' || name === '[Content_Types].xml') groups.workbook.push(signature)
  if (/^xl\/worksheets\/.*\.xml$/i.test(name)) groups.worksheets.push(signature)
  if (name === 'xl/styles.xml' || /^xl\/theme\//i.test(name)) groups.styles.push(signature)
  if (
    /^xl\/drawings\//i.test(name) ||
    name === 'xl/cellimages.xml' ||
    /^xl\/richData\//i.test(name)
  ) {
    groups.drawings.push(signature)
  }
  if (/^xl\/media\//i.test(name)) groups.media.push(signature)
  if (/_rels\/.*\.rels$/i.test(name)) groups.relationships.push(signature)
}

function buildComponentFingerprints(
  groups: Record<keyof OoxmlComponentFingerprints, EntrySignature[]>
): OoxmlComponentFingerprints {
  return {
    workbook: hashSignatures(groups.workbook),
    worksheets: hashSignatures(groups.worksheets),
    styles: hashSignatures(groups.styles),
    drawings: hashSignatures(groups.drawings),
    media: hashSignatures(groups.media),
    relationships: hashSignatures(groups.relationships)
  }
}

function hashSignatures(signatures: EntrySignature[]): string {
  const hash = createHash('sha256')
  signatures
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .forEach((signature) => hash.update(JSON.stringify(signature)))
  return hash.digest('hex')
}

function toSignature(entry: Entry, name: string): EntrySignature {
  return {
    name,
    crc32: (entry.crc32 >>> 0).toString(16).padStart(8, '0'),
    compressedBytes: entry.compressedSize,
    uncompressedBytes: entry.uncompressedSize
  }
}

function normalizeZipPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '')
}

function countMatches(value: string, pattern: RegExp): number {
  let count = 0
  pattern.lastIndex = 0
  while (pattern.exec(value)) count += 1
  return count
}

function getObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function toArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  return value ? [value as T] : []
}

function openZip(filePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error) reject(error)
      else if (!zip) reject(new Error('无法打开 XLSX 压缩包'))
      else resolve(zip)
    })
  })
}

function openEntryStream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) reject(error)
      else if (!stream) reject(new Error(`无法读取 ${entry.fileName}`))
      else resolve(stream)
    })
  })
}

async function readEntryText(zip: ZipFile, entry: Entry, maxBytes: number): Promise<string> {
  if (entry.uncompressedSize > maxBytes) {
    throw new Error(`XML 部件过大：${entry.fileName} (${entry.uncompressedSize} bytes)`)
  }
  const stream = await openEntryStream(zip, entry)
  const chunks: Buffer[] = []
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return Buffer.concat(chunks).toString('utf8')
}
