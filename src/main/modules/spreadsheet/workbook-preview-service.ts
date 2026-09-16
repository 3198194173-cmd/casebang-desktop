import { stat } from 'node:fs/promises'
import { basename, posix } from 'node:path'
import sharp from 'sharp'
import type { ProductImageMappingIndex, WorkbookPreviewCell, WorkbookPreviewRequest, WorkbookPreviewResult } from '@shared/contracts'
import { findPackageText, readOoxmlPackage, visitOoxmlParts, type PackageEntryRecord } from './ooxml-package'

interface SheetPart { name: string; path: string }
const thumbnailCache = new Map<string, string>()
let thumbnailCacheBytes = 0
const THUMBNAIL_CACHE_LIMIT = 12 * 1024 * 1024
function cacheThumbnail(key: string, url: string): void {
  const previous = thumbnailCache.get(key)
  if (previous) thumbnailCacheBytes -= previous.length * 2
  thumbnailCache.delete(key)
  thumbnailCache.set(key, url)
  thumbnailCacheBytes += url.length * 2
  while (thumbnailCacheBytes > THUMBNAIL_CACHE_LIMIT && thumbnailCache.size) {
    const first = thumbnailCache.keys().next().value!
    thumbnailCacheBytes -= thumbnailCache.get(first)!.length * 2
    thumbnailCache.delete(first)
  }
}
interface CachedWorkbook {
  version: string
  entries: PackageEntryRecord[]
  sheets: SheetPart[]
  sharedStrings: string[]
  sheetResults: Map<string, Omit<WorkbookPreviewResult, 'kind' | 'fileName' | 'sheetNames'>>
  mappingIndex?: ProductImageMappingIndex
}

export class WorkbookPreviewService {
  private readonly cache = new Map<string, CachedWorkbook>()

  async mappingIndex(filePath: string): Promise<ProductImageMappingIndex> {
    const workbook = await this.loadWorkbook(filePath)
    if (workbook.mappingIndex) return workbook.mappingIndex
    workbook.mappingIndex = {
      version: workbook.version,
      sheets: workbook.sheets.filter((sheet) => !sheet.name.startsWith('WpsReserved_')).map((sheet) => {
        const xml = requiredText(workbook.entries, sheet.path)
        const rows = parseRows(xml, workbook.sharedStrings, new Map())
        let lastOccupiedRow = rows.reduce((last, row) => row.cells.some((cell) => cell.value.trim() || cell.formula)
          ? Math.max(last, row.rowNumber) : last, 0)
        const relationshipId = /<drawing\b[^>]*\br:id="([^"]+)"/i.exec(xml)?.[1]
        const rels = findPackageText(workbook.entries, `${posix.dirname(sheet.path)}/_rels/${posix.basename(sheet.path)}.rels`) ?? ''
        const target = relationshipId ? relationshipTarget(rels, relationshipId) : null
        if (target) {
          const drawing = findPackageText(workbook.entries, posix.normalize(posix.join(posix.dirname(sheet.path), target))) ?? ''
          for (const match of drawing.matchAll(/<(?:\w+:)?row>(\d+)<\/(?:\w+:)?row>/g)) {
            lastOccupiedRow = Math.max(lastOccupiedRow, Number(match[1]) + 1)
          }
        }
        const columnWidths = Array.from({ length: 12 }, () => 60)
        for (const match of xml.matchAll(/<col\b([^>]*)\/?\s*>/g)) {
          const attributes = attributesOf(match[1] ?? '')
          for (let column = Math.max(1, Number(attributes.min)); column <= Math.min(12, Number(attributes.max)); column++) {
            columnWidths[column - 1] = Math.max(1, Math.round(Number(attributes.width) * 7 + 5))
          }
        }
        const rowHeights: Record<number, number> = {}
        for (const match of xml.matchAll(/<row\b([^>]*?)(?:\/>|>)/g)) {
          const attrs = attributesOf(match[1] ?? '')
          rowHeights[Number(attrs.r)] = Number(attrs.ht ?? 15) / 0.75
        }
        // Continue the final occupied image/name block horizontally. Older
        // gaps stay untouched; a wireless product reserves a pair of columns.
        const materialRows = rows.filter((row) => row.cells.some((cell) => /CASEBANG/i.test(cell.value)))
        const lastMaterial = materialRows.at(-1)
        const widthLimit = columnWidths.findIndex((width) => width < 100)
        const columns = widthLimit > 0 ? widthLimit : 12
        const wireless = sheet.name === '充电宝名字图案对应'
        const blockHeight = wireless ? 2 : 3
        let appendRow = lastOccupiedRow + 1
        let appendColumn = 0
        if (lastMaterial) {
          const imageRow = lastMaterial.rowNumber - 1
          const occupied = rows.filter((row) => row.rowNumber >= imageRow && row.rowNumber < imageRow + blockHeight)
            .flatMap((row) => row.cells.filter((cell) => cell.value.trim() || cell.formula).map((cell) => columnIndex(cell.address) + 1))
          const next = Math.max(0, ...occupied)
          appendColumn = wireless ? Math.ceil(next / 2) * 2 : next
          appendRow = imageRow
          if (appendColumn >= columns) { appendRow = Math.max(lastOccupiedRow + 1, imageRow + blockHeight); appendColumn = 0 }
        }
        return { name: sheet.name, lastOccupiedRow, columnWidths, appendRow, appendColumn, rowHeights }
      })
    }
    return workbook.mappingIndex
  }

  async read(filePath: string, input: WorkbookPreviewRequest): Promise<WorkbookPreviewResult> {
    const workbook = await this.loadWorkbook(filePath)
    if (workbook.sheets.length === 0) throw new Error('工作簿没有可预览的工作表')
    const active = workbook.sheets.find((sheet) => sheet.name === input.sheetName) ?? workbook.sheets[0]!
    let sheetResult = workbook.sheetResults.get(active.name)
    if (!sheetResult) {
      const worksheetXml = requiredText(workbook.entries, active.path)
      const generatedImages = await generatedImageMap(filePath, workbook.entries, active.path, worksheetXml, 1, Number.MAX_SAFE_INTEGER, true)
      const bounds = worksheetBounds(worksheetXml)
      const nativeRowHeights: Record<number, number> = {}
      for (const match of worksheetXml.matchAll(/<row\b([^>]*?)(?:\/>|>)/g)) {
        const attrs = attributesOf(match[1] ?? '')
        if (Number(attrs.r) > 0 && Number(attrs.ht) > 0) nativeRowHeights[Number(attrs.r)] = Math.round(Number(attrs.ht) * 96 / 72)
      }
      const nativeColumnWidths = Array.from({ length: Math.min(16384, Math.max(bounds.columns, maxImageColumn(generatedImages), 1)) }, () => 64)
      for (const match of worksheetXml.matchAll(/<col\b([^>]*)\/?\s*>/g)) {
        const attrs = attributesOf(match[1] ?? '')
        if (!(Number(attrs.width) > 0)) continue
        for (let c = Math.max(1, Number(attrs.min)); c <= Math.min(nativeColumnWidths.length, Number(attrs.max)); c++) nativeColumnWidths[c - 1] = Math.round(Number(attrs.width) * 7 + 5)
      }
      const rows = parseRows(worksheetXml, workbook.sharedStrings, generatedImages)
      for (const row of rows) for (const cell of row.cells) cell.hasImage = generatedImages.has(cell.address)
      const mappingSheet = input.kind === 'productImageMapping' ? (await this.mappingIndex(filePath)).sheets.find((sheet) => sheet.name === active.name) : undefined
      sheetResult = {
        rowHeights: mappingSheet?.rowHeights ?? nativeRowHeights,
        columnWidths: mappingSheet?.columnWidths ?? nativeColumnWidths,
        activeSheetName: active.name,
        totalRows: Math.max(bounds.rows, ...rows.map((row) => row.rowNumber)),
        dataRowCount: rows.length,
        columnCount: Math.max(bounds.columns, maxImageColumn(generatedImages), 1),
        rows
      }
      workbook.sheetResults.set(active.name, sheetResult)
      while (workbook.sheetResults.size > 3) workbook.sheetResults.delete(workbook.sheetResults.keys().next().value!)
    }
    const images = input.imageEndRow === 0 ? new Map<string, string>() : await generatedImageMap(filePath, workbook.entries, active.path,
      requiredText(workbook.entries, active.path), input.imageStartRow ?? 1, input.imageEndRow ?? Number.MAX_SAFE_INTEGER)
    const rows = sheetResult.rows.filter((row) => !input.imagesOnly || (row.rowNumber >= (input.imageStartRow ?? 1) && row.rowNumber <= (input.imageEndRow ?? Number.MAX_SAFE_INTEGER)))
      .map((row) => ({ ...row, cells: row.cells.map((cell) => ({ ...cell, generatedImageDataUrl: images.get(cell.address) ?? null })) }))
    for (const [address, dataUrl] of images) {
      let row = rows.find((item) => item.rowNumber === rowNumberOf(address))
      if (!row) { row = { rowNumber: rowNumberOf(address), cells: [] }; rows.push(row) }
      if (!row.cells.some((cell) => cell.address === address)) row.cells.push({ address, value: '', formula: null, generatedImageDataUrl: dataUrl })
    }
    return { kind: input.kind, fileName: basename(filePath), sheetNames: workbook.sheets.map((sheet) => sheet.name), ...sheetResult, rows: rows.sort((a,b) => a.rowNumber-b.rowNumber) }
  }

  private async loadWorkbook(filePath: string): Promise<CachedWorkbook> {
    const file = await stat(filePath)
    const version = `${file.size}:${file.mtimeMs}`
    const cached = this.cache.get(filePath)
    if (cached?.version === version) { this.cache.delete(filePath); this.cache.set(filePath, cached); return cached }
    const entries = await readOoxmlPackage(filePath, { skipMedia: true })
    const next: CachedWorkbook = {
      version,
      entries,
      sheets: parseSheets(requiredText(entries, 'xl/workbook.xml'), requiredText(entries, 'xl/_rels/workbook.xml.rels')),
      sharedStrings: parseSharedStrings(findPackageText(entries, 'xl/sharedStrings.xml') ?? ''),
      sheetResults: new Map()
    }
    this.cache.set(filePath, next)
    while (this.cache.size > 2) this.cache.delete(this.cache.keys().next().value!)
    return next
  }
}

function parseSheets(workbookXml: string, relationshipsXml: string): SheetPart[] {
  const rels = new Map<string, string>()
  for (const match of relationshipsXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
    const attributes = attributesOf(match[1] ?? '')
    if (attributes.Id && attributes.Target) rels.set(attributes.Id, attributes.Target)
  }
  return [...workbookXml.matchAll(/<sheet\b([^>]*)\/?\s*>/gi)].flatMap((match) => {
    const attributes = attributesOf(match[1] ?? '')
    const target = rels.get(attributes['r:id'] ?? '')
    if (!attributes.name || !target) return []
    return [{ name: decodeXml(attributes.name), path: target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join('xl', target)) }]
  })
}

function parseSharedStrings(xml: string): string[] {
  return xml ? [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map((match) => richText(match[1] ?? '')) : []
}

function parseRows(worksheetXml: string, sharedStrings: string[], generatedImages: Map<string, string>): Array<{ rowNumber: number; cells: WorkbookPreviewCell[] }> {
  const rowMap = new Map<number, WorkbookPreviewCell[]>()
  for (const match of worksheetXml.matchAll(/<row\b([^>]*?)(?<!\/)>([\s\S]*?)<\/row>/gi)) {
    const rowNumber = Number(attributesOf(match[1] ?? '').r)
    if (!Number.isInteger(rowNumber)) continue
    const cells: WorkbookPreviewCell[] = []
    for (const cellMatch of (match[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gi)) {
      const attributes = attributesOf(cellMatch[1] ?? '')
      const address = attributes.r ?? ''
      if (!address) continue
      const body = cellMatch[2] ?? ''
      const formula = firstTag(body, 'f')
      const raw = firstTag(body, 'v')
      let value = ''
      if (attributes.t === 's') value = sharedStrings[Number(raw)] ?? ''
      else if (attributes.t === 'inlineStr') value = richText(firstTagBody(body, 'is') ?? body)
      else if (attributes.t === 'b') value = raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw
      else value = decodeXml(raw)
      cells.push({ address, value, formula: formula || null, generatedImageDataUrl: generatedImages.get(address) ?? null })
    }
    if (cells.length > 0) rowMap.set(rowNumber, cells)
  }
  for (const [address, dataUrl] of generatedImages) {
    const rowNumber = rowNumberOf(address)
    const cells = rowMap.get(rowNumber) ?? []
    const existing = cells.find((cell) => cell.address === address)
    if (existing) existing.generatedImageDataUrl = dataUrl
    else cells.push({ address, value: '', formula: null, generatedImageDataUrl: dataUrl })
    rowMap.set(rowNumber, cells)
  }
  return [...rowMap.entries()].toSorted(([left], [right]) => left - right).map(([rowNumber, cells]) => ({
    rowNumber,
    cells: cells.toSorted((left, right) => columnIndex(left.address) - columnIndex(right.address))
  }))
}

async function generatedImageMap(filePath: string, entries: PackageEntryRecord[], worksheetPath: string, worksheetXml: string, startRow = 1, endRow = Number.MAX_SAFE_INTEGER, metadataOnly = false): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const targets: Array<{ address: string; imagePath: string }> = []
  const resolvePart = (base: string, target: string) => target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(posix.dirname(base), target))
  const cellImagesXml = findPackageText(entries, 'xl/cellimages.xml') ?? ''
  const cellImageRels = relationshipMap(findPackageText(entries, 'xl/_rels/cellimages.xml.rels') ?? '')
  const cellImagePaths = new Map<string, string>()
  for (const picture of cellImagesXml.matchAll(/<(?:\w+:)?pic\b[^>]*>[\s\S]*?<\/(?:\w+:)?pic>/gi)) {
    const name = /<(?:\w+:)?cNvPr\b[^>]*\bname="([^"]+)"/i.exec(picture[0])?.[1]
    const embed = /<(?:\w+:)?blip\b[^>]*\br:embed="([^"]+)"/i.exec(picture[0])?.[1]
    const target = embed ? cellImageRels.get(embed) : null
    if (name && target) cellImagePaths.set(decodeXml(name), resolvePart('xl/cellimages.xml', target))
  }
  for (const cell of worksheetXml.matchAll(/<c\b([^>]*?)(?<!\/)>([\s\S]*?)<\/c>/gi)) {
    const address = attributesOf(cell[1] ?? '').r
    if (!address || rowNumberOf(address) < startRow || rowNumberOf(address) > endRow) continue
    const id = /(?:_xlfn\.)?DISPIMG\s*\(\s*"([^"]+)"/i.exec(firstTag(cell[2] ?? '', 'f'))?.[1]
    const imagePath = id ? cellImagePaths.get(id) : null
    if (imagePath) targets.push({ address, imagePath })
  }
  const drawingRelationshipId = /<drawing\b[^>]*\br:id="([^"]+)"/i.exec(worksheetXml)?.[1]
  const worksheetRelsPath = `${posix.dirname(worksheetPath)}/_rels/${posix.basename(worksheetPath)}.rels`
  const drawingTarget = drawingRelationshipId ? relationshipTarget(findPackageText(entries, worksheetRelsPath) ?? '', drawingRelationshipId) : null
  const drawingPath = drawingTarget ? resolvePart(worksheetPath, drawingTarget) : ''
  const drawingXml = findPackageText(entries, drawingPath) ?? ''
  const drawingRelsPath = `${posix.dirname(drawingPath)}/_rels/${posix.basename(drawingPath)}.rels`
  const drawingRels = relationshipMap(findPackageText(entries, drawingRelsPath) ?? '')
  for (const anchor of drawingXml.matchAll(/<(?:\w+:)?(?:oneCellAnchor|twoCellAnchor)\b[\s\S]*?<\/(?:\w+:)?(?:oneCellAnchor|twoCellAnchor)>/gi)) {
    const xml = anchor[0]
    const column = Number(/<(?:\w+:)?from>[\s\S]*?<(?:\w+:)?col>(\d+)<\/(?:\w+:)?col>/i.exec(xml)?.[1])
    const row = Number(/<(?:\w+:)?from>[\s\S]*?<(?:\w+:)?row>(\d+)<\/(?:\w+:)?row>/i.exec(xml)?.[1])
    const imageRelationshipId = /<(?:\w+:)?blip\b[^>]*\br:embed="([^"]+)"/i.exec(xml)?.[1]
    if (!Number.isInteger(column) || !Number.isInteger(row) || !imageRelationshipId) continue
    if (row + 1 < startRow || row + 1 > endRow) continue
    const imageTarget = drawingRels.get(imageRelationshipId)
    if (!imageTarget) continue
    targets.push({ address: `${columnName(column + 1)}${row + 1}`, imagePath: resolvePart(drawingPath, imageTarget) })
  }
  if (targets.length === 0) return result
  if (metadataOnly) return new Map(targets.map((target) => [target.address, '']))
  // Read one media part at a time: large originals never accumulate in a batch.
  const pending = new Map<string, { cacheKey: string; addresses: string[] }>()
  const parts = new Map(entries.map((entry) => [entry.path, entry]))
  for (const target of targets) {
    const part = parts.get(target.imagePath)
    if (!part || part.isDirectory || part.uncompressedSize > 64 * 1024 * 1024) continue
    const cacheKey = `${filePath}:${target.imagePath}:${part?.crc32}:${part?.uncompressedSize}`
    const cached = thumbnailCache.get(cacheKey)
    if (cached) { cacheThumbnail(cacheKey, cached); result.set(target.address, cached); continue }
    const job = pending.get(target.imagePath)
    if (job) job.addresses.push(target.address)
    else pending.set(target.imagePath, { cacheKey, addresses: [target.address] })
  }
  await visitOoxmlParts(filePath, [...pending.keys()], async (imagePath, image) => {
    const job = pending.get(imagePath)!
    try {
      const thumbnail = await sharp(image).resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true }).png().toBuffer()
      const url = `data:image/png;base64,${thumbnail.toString('base64')}`
      cacheThumbnail(job.cacheKey, url)
      for (const address of job.addresses) result.set(address, url)
    } catch { /* Keep the formula visible for missing/unsupported images. */ }
  })
  return result
}

function relationshipTarget(xml: string, relationshipId: string): string | null {
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
    const attributes = attributesOf(match[1] ?? '')
    if (attributes.Id === relationshipId) return attributes.Target ?? null
  }
  return null
}
function relationshipMap(xml: string): Map<string, string> {
  return new Map([...xml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)].flatMap((match) => {
    const attributes = attributesOf(match[1] ?? '')
    return attributes.Id && attributes.Target ? [[attributes.Id, attributes.Target] as const] : []
  }))
}
function worksheetBounds(xml: string): { rows: number; columns: number } {
  const addresses = [...xml.matchAll(/<c\b[^>]*\br="([A-Z]+)(\d+)"/gi)]
  return { rows: Math.max(1, ...addresses.map((item) => Number(item[2]))), columns: Math.max(1, ...addresses.map((item) => columnNumber(item[1] ?? 'A'))) }
}
function maxImageColumn(images: Map<string, string>): number { return Math.max(1, ...[...images.keys()].map((address) => columnIndex(address) + 1)) }
function firstTag(xml: string, tag: string): string { return decodeXml(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml)?.[1] ?? '') }
function firstTagBody(xml: string, tag: string): string | null { return new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml)?.[1] ?? null }
function richText(xml: string): string { return [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((match) => decodeXml(match[1] ?? '')).join('') }
function rowNumberOf(address: string): number { return Number(/\d+$/.exec(address)?.[0] ?? 0) }
function columnIndex(address: string): number { return columnNumber(/^[A-Z]+/i.exec(address)?.[0] ?? 'A') - 1 }
function attributesOf(source: string): Record<string, string> { const output: Record<string, string> = {}; for (const match of source.matchAll(/([\w:-]+)="([^"]*)"/g)) output[match[1] ?? ''] = match[2] ?? ''; return output }
function requiredText(entries: PackageEntryRecord[], path: string): string { const text = findPackageText(entries, path); if (text === null) throw new Error(`工作簿缺少必要部件：${path}`); return text }
function decodeXml(value: string): string { return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&') }
function columnNumber(name: string): number { return [...name.toUpperCase()].reduce((value, character) => value * 26 + character.charCodeAt(0) - 64, 0) }
function columnName(index: number): string { let name = ''; let value = index; while (value > 0) { name = String.fromCharCode(65 + ((value - 1) % 26)) + name; value = Math.floor((value - 1) / 26) } return name }
