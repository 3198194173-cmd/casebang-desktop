import { posix } from 'node:path'
import sharp from 'sharp'
import type { ExportGenerationWorkbookInput, PreviewCell, PreviewSheet, PreviewWorkbook } from '@shared/generation-contracts'
import { findPackageText, readOoxmlPackage, replacePackageText, writeOoxmlPackage, type PackageEntryRecord } from '../spreadsheet/ooxml-package'

interface WorksheetGridSpec {
  columnWidths: Map<number, number>
  rowHeights: Map<number, number>
  merges: Array<{ startColumn: number; startRow: number; endColumn: number; endRow: number }>
}

interface WorksheetImageTarget {
  startColumn: number
  startRow: number
  containerWidthPx: number
  containerHeightPx: number
  imageWidthPx: number
  imageHeightPx: number
  xOffsetPx: number
  yOffsetPx: number
}

interface WorksheetDrawing {
  path: string
  relationshipsPath: string
  worksheetRelationshipId: string | null
  relationships: string[]
  anchors: string[]
  nextShapeId: number
  nextDrawingIndex: number
}

const EMBEDDED_IMAGE_SCALE = 2
const MIN_EMBEDDED_IMAGE_DIMENSION = 320
const MAX_EMBEDDED_IMAGE_DIMENSION = 1600

export async function exportFormatPreservingWorkbook(sourcePath: string, destinationPath: string, workbook: PreviewWorkbook, input: ExportGenerationWorkbookInput): Promise<void> {
  const entries = await readOoxmlPackage(sourcePath)
  let workbookXml = requireText(entries, 'xl/workbook.xml')
  let relationshipsXml = requireText(entries, 'xl/_rels/workbook.xml.rels')
  const sheetPaths = parseSheetPaths(workbookXml, relationshipsXml)
  if (workbook.id === 'generated-product') {
    const prepared = prepareGeneratedProductSheets(entries, workbook, workbookXml, relationshipsXml, sheetPaths)
    workbookXml = prepared.workbookXml
    relationshipsXml = prepared.relationshipsXml
  }
  const cropById = new Map(input.imageSource.crops.map((crop) => [crop.id, crop]))
  const optimizedMedia = new Map<string, string>()
  let mediaIndex = nextPartIndex(entries, /^xl\/media\/image(\d+)\./i)
  let drawingIndex = nextPartIndex(entries, /^xl\/drawings\/drawing(\d+)\.xml$/i)
  const mappingStyles = workbook.id === 'product-image-mapping' ? addMappingStyles(entries) : null

  for (const previewSheet of workbook.sheets) {
    const sourceSheetName = previewSheet.name
    let sourceSheet = sheetPaths.find((sheet) => sheet.name === sourceSheetName)
    if (sourceSheet && previewSheet.createIfMissing) throw new Error(`分表“${sourceSheetName}”已经存在，请刷新资料后重新生成。`)
    if (!sourceSheet && workbook.id === 'product-image-mapping' && previewSheet.createIfMissing) {
      if (sourceSheetName.length > 31 || /[\\/\[\]:*?]/.test(sourceSheetName)) throw new Error('K3 分表名称无效')
      const sheetIndex = nextPartIndex(entries, /^xl\/worksheets\/sheet(\d+)\.xml$/i)
      const path = `xl/worksheets/sheet${sheetIndex}.xml`
      const relationshipId = `rId${Math.max(0, ...[...relationshipsXml.matchAll(/\bId="rId(\d+)"/g)].map((m) => Number(m[1]))) + 1}`
      const sheetId = Math.max(0, ...[...workbookXml.matchAll(/\bsheetId="(\d+)"/g)].map((m) => Number(m[1]))) + 1
      workbookXml = workbookXml.replace('</sheets>', `<sheet name="${escapeXml(sourceSheetName)}" sheetId="${sheetId}" r:id="${relationshipId}"/></sheets>`)
      relationshipsXml = relationshipsXml.replace('</Relationships>', `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${sheetIndex}.xml"/></Relationships>`)
      const cols = previewSheet.columnWidths?.map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${(width - 5) / 7}" customWidth="1"/>`).join('') ?? ''
      setPackageText(entries, path, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:A1"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${cols}</cols><sheetData></sheetData></worksheet>`)
      const contentTypes = requireText(entries, '[Content_Types].xml')
      setPackageText(entries, '[Content_Types].xml', contentTypes.replace('</Types>', `<Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`))
      sourceSheet = { name: sourceSheetName, path }
      sheetPaths.push(sourceSheet)
    }
    if (!sourceSheet) throw new Error(`源工作簿中找不到工作表：${sourceSheetName}`)
    let worksheetXml = requireText(entries, sourceSheet.path)
    const originalWorksheetXml = worksheetXml
    if (workbook.id === 'generated-product') {
      worksheetXml = truncateWorksheetAfterColumn(worksheetXml, previewSheet.columns.length)
    }
    if (workbook.id === 'generated-product' && previewSheet.columnWidths?.length) {
      worksheetXml = applyPreviewColumnWidths(worksheetXml, previewSheet.columnWidths)
    }
    const writes = collectWrites(previewSheet)
    if (workbook.id === 'generated-product') {
      const finalDataRow = (previewSheet.startRow ?? 1) + 1 + previewSheet.rows.length - 1
      const existingEndRow = Math.max(1, ...[...worksheetXml.matchAll(/<row\b[^>]*\br="(\d+)"/gi)].map((match) => Number(match[1])))
      for (let row = finalDataRow + 1; row <= existingEndRow; row += 1) {
        // Remove all stale sample data after the final product row. Styles,
        // dimensions and worksheet formatting remain intact.
        for (let columnIndex = 0; columnIndex < previewSheet.columns.length; columnIndex += 1) {
          writes.push({ row, columnIndex, cell: { value: '', changed: true } })
        }
      }
    }
    worksheetXml = applyCellWrites(worksheetXml, writes)
    if (mappingStyles) worksheetXml = applyMappingLayout(worksheetXml, previewSheet, writes, mappingStyles, originalWorksheetXml)
    const imageWrites = writes.filter((write) => write.cell.cropId && cropById.has(write.cell.cropId))
    worksheetXml = ensureImageRowHeights(worksheetXml, imageWrites)
    assertCellWritesRemainInTheirRows(worksheetXml, writes, previewSheet.name)
    assertCellWriteValues(worksheetXml, writes, previewSheet.name)
    if (imageWrites.length > 0) {
      // Cell writes can create rows by copying a nearby template row. Parse the
      // grid only after those rows and their image heights exist; otherwise a
      // new row is measured with Excel's 20px default and exported images are
      // incorrectly reduced to thumbnail size.
      const sheetSpec = parseWorksheetGridSpec(worksheetXml)
      const drawing = resolveWorksheetDrawing(entries, sourceSheet.path, drawingIndex)
      drawingIndex = Math.max(drawingIndex, drawing.nextDrawingIndex)
      const drawingRelationships = drawing.relationships
      const replacementPositions = new Set(imageWrites.map((write) => `${write.columnIndex}:${write.row - 1}`))
      const anchors: string[] = workbook.id === 'generated-product'
        ? []
        : drawing.anchors.filter((anchor) => {
          if (workbook.id === 'product-image-mapping') return true
          const position = anchorPosition(anchor)
          return !position || !replacementPositions.has(`${position.column}:${position.row}`)
        })
      let shapeId = drawing.nextShapeId
      for (const [index, write] of imageWrites.entries()) {
        const crop = cropById.get(write.cell.cropId!)!
        const target = resolveImagePlacement(write, sheetSpec)
        const maximumWidth = embeddedImageDimension(target.imageWidthPx)
        const maximumHeight = embeddedImageDimension(target.imageHeightPx)
        const mediaKey = `${crop.id}:${crop.x}:${crop.y}:${crop.width}:${crop.height}:${maximumWidth}:${maximumHeight}`
        let imagePath = optimizedMedia.get(mediaKey)
        if (!imagePath) {
          imagePath = `xl/media/image${mediaIndex++}.png`
          const image = await sharp(input.imageSource.path)
            .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
            .resize({ width: maximumWidth, height: maximumHeight, fit: 'inside', withoutEnlargement: true })
            .png({ compressionLevel: 9, adaptiveFiltering: true })
            .toBuffer()
          addEntry(entries, imagePath, image)
          optimizedMedia.set(mediaKey, imagePath)
        }
        const relationshipId = `rId${nextRelationshipNumber(drawingRelationships)}`
        drawingRelationships.push(`<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${posix.basename(imagePath)}"/>`)
        anchors.push(imageAnchor(
          shapeId++,
          target.startColumn,
          target.startRow,
          relationshipId,
          target.imageWidthPx,
          target.imageHeightPx,
          target.xOffsetPx,
          target.yOffsetPx
        ))
      }
      const originalDrawing = findPackageText(entries, drawing.path)
      // Keep the original root namespaces, extension records and historical
      // anchors intact. WPS drawings may depend on namespaces on that root.
      const nextDrawing = workbook.id === 'product-image-mapping' && originalDrawing
        ? originalDrawing.replace(/<\/(?:\w+:)?wsDr>\s*$/, (closing) => `${anchors.slice(drawing.anchors.length).join('')}${closing}`)
        : drawingXml(anchors)
      setPackageText(entries, drawing.path, nextDrawing)
      setPackageText(entries, drawing.relationshipsPath, relationshipsDocument(drawingRelationships))
      if (!drawing.worksheetRelationshipId) {
        const relationshipId = appendWorksheetDrawingRelationship(entries, sourceSheet.path, drawing.path)
        if (!/<worksheet\b[^>]*xmlns:r=/i.test(worksheetXml)) worksheetXml = worksheetXml.replace(/<worksheet\b/i, '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"')
        worksheetXml = worksheetXml.replace(/<\/worksheet>\s*$/i, `<drawing r:id="${relationshipId}"/></worksheet>`)
      }
      ensureDrawingContentTypes(entries, drawing.path)
    }
    replacePackageText(entries, sourceSheet.path, worksheetXml)
  }
  const selectedWorkbookXml = workbook.id === 'generated-product'
    ? retainOnlyWorksheets(workbookXml, workbook.sheets.map((sheet) => sheet.name))
    : workbookXml
  const recalculatingWorkbookXml = /<calcPr\b/i.test(selectedWorkbookXml)
    ? selectedWorkbookXml.replace(/<calcPr\b([^>]*)\/?\s*>/i, (_full, attributes: string) => `<calcPr${sanitizeTagAttributes(attributes).replace(/\s+(?:calcMode|fullCalcOnLoad|forceFullCalc)="[^"]*"/g, '')} calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>`)
    : selectedWorkbookXml.replace(/<\/workbook>/i, '<calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>')
  replacePackageText(entries, 'xl/workbook.xml', recalculatingWorkbookXml)
  replacePackageText(entries, 'xl/_rels/workbook.xml.rels', relationshipsXml)
  await writeOoxmlPackage(destinationPath, entries)
}

/** Reuse each bundled template layout once, then clone it for additional product-type tabs. */
function prepareGeneratedProductSheets(
  entries: PackageEntryRecord[],
  workbook: PreviewWorkbook,
  initialWorkbookXml: string,
  initialRelationshipsXml: string,
  sheetPaths: Array<{ name: string; path: string }>
): { workbookXml: string; relationshipsXml: string } {
  const sourceImage = sheetPaths.find((sheet) => sheet.name === '图片')
  const sourceBarcode = sheetPaths.find((sheet) => sheet.name === '条码')
  if (!sourceImage || !sourceBarcode) throw new Error('新建产品表模板缺少图片或条码工作表')
  const templateXml = {
    image: requireText(entries, sourceImage.path),
    barcode: requireText(entries, sourceBarcode.path)
  }
  const used = new Set<'image' | 'barcode'>()
  let workbookXml = initialWorkbookXml
  let relationshipsXml = initialRelationshipsXml
  for (const sheet of workbook.sheets) {
    const kind = sheet.id.startsWith('generated-products') || sheet.name.endsWith('图片') || sheet.name === '图片' ? 'image' : 'barcode'
    const source = kind === 'image' ? sourceImage : sourceBarcode
    if (sheet.name.length > 31 || /[\\/\[\]:*?]/.test(sheet.name)) throw new Error(`新建产品分表名称无效：${sheet.name}`)
    if (!used.has(kind)) {
      used.add(kind)
      if (source.name !== sheet.name) {
        const originalName = source.name
        workbookXml = workbookXml.replace(/<sheet\b[^>]*\/\s*>/gi, (tag) =>
          parseAttributes(tag).name === originalName ? tag.replace(/\bname="[^"]*"/, `name="${escapeXml(sheet.name)}"`) : tag)
        source.name = sheet.name
      }
      continue
    }
    const sheetIndex = nextPartIndex(entries, /^xl\/worksheets\/sheet(\d+)\.xml$/i)
    const path = `xl/worksheets/sheet${sheetIndex}.xml`
    const relationshipId = `rId${Math.max(0, ...[...relationshipsXml.matchAll(/\bId="rId(\d+)"/g)].map((match) => Number(match[1]))) + 1}`
    const sheetId = Math.max(0, ...[...workbookXml.matchAll(/\bsheetId="(\d+)"/g)].map((match) => Number(match[1]))) + 1
    workbookXml = workbookXml.replace('</sheets>', `<sheet name="${escapeXml(sheet.name)}" sheetId="${sheetId}" r:id="${relationshipId}"/></sheets>`)
    relationshipsXml = relationshipsXml.replace('</Relationships>', `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${sheetIndex}.xml"/></Relationships>`)
    // A cloned sheet must not share the template sheet's drawing relationship.
    // New images get their own drawing/media relationships in the normal write path.
    const cleanXml = templateXml[kind].replace(/<drawing\b[^>]*\/>/gi, '').replace(/\s+tabSelected="1"/gi, '')
    setPackageText(entries, path, cleanXml)
    const contentTypes = requireText(entries, '[Content_Types].xml')
    setPackageText(entries, '[Content_Types].xml', contentTypes.replace('</Types>', `<Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`))
    sheetPaths.push({ name: sheet.name, path })
  }
  return { workbookXml, relationshipsXml }
}

function embeddedImageDimension(displayPixels: number): number {
  return Math.min(MAX_EMBEDDED_IMAGE_DIMENSION, Math.max(MIN_EMBEDDED_IMAGE_DIMENSION, Math.ceil(displayPixels * EMBEDDED_IMAGE_SCALE)))
}

function collectWrites(sheet: PreviewSheet): Array<{ row: number; columnIndex: number; cell: PreviewCell }> {
  const writes: Array<{ row: number; columnIndex: number; cell: PreviewCell }> = []
  const addPlannedWrite = (cell: PreviewCell): void => {
    if (!cell.changed && !cell.writeOnly) return
    if (!cell.targetAddress) throw new Error(`导出计划缺少锁定坐标：${sheet.name}`)
    const target = parseCellAddress(cell.targetAddress)
    writes.push({ row: target.row, columnIndex: target.columnIndex, cell })
  }
  sheet.headerCells?.forEach(addPlannedWrite)
  sheet.rows.forEach((row) => row.forEach(addPlannedWrite))
  return writes
}

function ensureImageRowHeights(
  worksheetXml: string,
  imageWrites: Array<{ row: number; columnIndex: number; cell: PreviewCell }>
): string {
  const minimumHeightByRow = new Map<number, number>()
  for (const write of imageWrites) {
    const containerHeightPx = write.cell.imageLayout?.containerHeightPx
    if (!containerHeightPx || containerHeightPx <= 0) continue
    minimumHeightByRow.set(write.row, Math.max(minimumHeightByRow.get(write.row) ?? 0, containerHeightPx))
  }

  let result = worksheetXml
  for (const [row, minimumHeightPx] of minimumHeightByRow) {
    const rowPattern = new RegExp(`<row\\b([^>]*\\br="${row}"[^>]*)>`, 'i')
    result = result.replace(rowPattern, (rowXml, attributesSource: string) => {
      const attributes = parseAttributes(attributesSource)
      const currentHeight = Number(attributes.h ?? attributes.ht)
      if (Number.isFinite(currentHeight) && convertRowHeight(currentHeight) >= minimumHeightPx) return rowXml
      const minimumHeightPoints = minimumHeightPx * 72 / 96
      const sanitizedAttributes = attributesSource
        .replace(/\s+(?:h|ht)="[^"]*"/gi, '')
        .replace(/\s+customHeight="[^"]*"/gi, '')
      return `<row${sanitizedAttributes} ht="${Number(minimumHeightPoints.toFixed(3))}" customHeight="1">`
    })
  }
  return result
}

function addMappingStyles(entries: PackageEntryRecord[]) {
  let xml = requireText(entries, 'xl/styles.xml')
  const originalXfs = [...(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? '').matchAll(/<xf\b[^>]*?(?:\/>|(?<!\/)>[\s\S]*?<\/xf>)/g)].map((m) => m[0])
  const fills = [...(/<fills\b[^>]*>([\s\S]*?)<\/fills>/.exec(xml)?.[1] ?? '').matchAll(/<fill\b[^>]*>[\s\S]*?<\/fill>/g)].map((m) => m[0])
  const inherited = new Map<string, number>()
  const append = (tag: string, child: string, content: string): number => {
    let index = 0
    xml = xml.replace(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`), (_full, attributes: string, body: string) => {
      index = [...body.matchAll(new RegExp(`<${child}\\b`, 'g'))].length
      return `<${tag}${attributes.replace(/\s+count="[^"]*"/, '')} count="${index + 1}">${body}${content}</${tag}>`
    })
    return index
  }
  const font = append('fonts', 'font', '<font><sz val="12"/><color rgb="FFFF0000"/><name val="微软雅黑"/></font>')
  const fill = append('fills', 'fill', '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill>')
  const border = append('borders', 'border', '<border><left style="thin"><color rgb="FF000000"/></left><right style="thin"><color rgb="FF000000"/></right><top style="thin"><color rgb="FF000000"/></top><bottom style="thin"><color rgb="FF000000"/></bottom><diagonal/></border>')
  const style = (fillId: number) => `<xf numFmtId="0" fontId="${font}" fillId="${fillId}" borderId="${border}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>`
  const plain = append('cellXfs', 'xf', style(0))
  const yellow = append('cellXfs', 'xf', style(fill))
  setPackageText(entries, 'xl/styles.xml', xml)
  return { plain, yellow, originalXfs, fills, inherit(styleId: number, yellowFill: boolean): number {
    const source = originalXfs[styleId]
    if (!source) return yellowFill ? yellow : plain
    const fontId = /\bfontId="(\d+)"/.exec(source)?.[1] ?? '0'
    const key = `${fontId}:${yellowFill}`
    const cached = inherited.get(key)
    if (cached !== undefined) return cached
    const id = append('cellXfs', 'xf', style(yellowFill ? fill : 0).replace(/fontId="\d+"/, `fontId="${fontId}"`))
    inherited.set(key, id)
    setPackageText(entries, 'xl/styles.xml', xml)
    return id
  } }
}

function applyMappingLayout(xml: string, sheet: PreviewSheet, writes: Array<{ row: number; columnIndex: number; cell: PreviewCell }>, styles: ReturnType<typeof addMappingStyles>, originalXml: string): string {
  let result = xml
  // Use historical text cells, not newly written values or image placeholder cells.
  const candidates = [...originalXml.matchAll(/<c\b([^>]*?)(?<!\/)>([\s\S]*?)<\/c>/g)].flatMap((match) => {
    const address = /\br="([A-Z]+\d+)"/.exec(match[1] ?? '')?.[1]
    const styleId = Number(/\bs="(\d+)"/.exec(match[1] ?? '')?.[1] ?? 0)
    if (!address || !/<(?:v|t)\b[^>]*>[^<]+<\//.test(match[2] ?? '') || /<f\b/.test(match[2] ?? '')) return []
    const fillId = Number(/\bfillId="(\d+)"/.exec(styles.originalXfs[styleId] ?? '')?.[1] ?? 0)
    return [{ ...parseCellAddress(address), styleId,
      fontId: /\bfontId="(\d+)"/.exec(styles.originalXfs[styleId] ?? '')?.[1] ?? '0',
      yellow: /<fgColor\b[^>]*(?:rgb="(?:FFFFFF00|FFFF00)"|indexed="6")/i.test(styles.fills[fillId] ?? '') }]
  })
  // A nearby previous export may already have the wrong font. Pick one dominant
  // historical font per text role for the entire batch, not one font per column.
  // Count by font, because many style IDs can share the same font record.
  const referenceStyles = new Map<boolean, number>()
  for (const yellow of [false, true]) {
    const frequencies = new Map<string, { count: number; styleId: number; firstRow: number }>()
    for (const candidate of candidates) {
      if (candidate.yellow !== yellow) continue
      const entry = frequencies.get(candidate.fontId)
      if (entry) entry.count += 1
      else frequencies.set(candidate.fontId, { count: 1, styleId: candidate.styleId, firstRow: candidate.row })
    }
    const reference = [...frequencies.values()].sort((a, b) => b.count - a.count || a.firstRow - b.firstRow)[0]
    if (reference) referenceStyles.set(yellow, reference.styleId)
  }
  for (const [index, height] of (sheet.rowHeights ?? []).entries()) {
    const row = (sheet.startRow ?? 1) + index
    result = result.replace(new RegExp(`<row\\b([^>]*\\br="${row}"[^>]*)>`), (_tag, attrs: string) =>
      `<row${attrs.replace(/\s+(?:h|ht|customHeight)="[^"]*"/g, '')} ht="${height * 0.75}" customHeight="1">`)
  }
  for (const write of writes) {
    const address = write.cell.targetAddress!
    const yellow = write.cell.fill === 'yellow'
    const referenceStyle = referenceStyles.get(yellow)
    const styleId = referenceStyle !== undefined ? styles.inherit(referenceStyle, yellow) : yellow ? styles.yellow : styles.plain
    result = result.replace(new RegExp(`<c\\b([^>]*\\br="${address}"[^>]*)>`), (_tag, attrs: string) =>
      `<c${attrs.replace(/\s+s="[^"]*"/g, '')} s="${styleId}">`)
  }
  return result
}

function parseCellAddress(address: string): { row: number; columnIndex: number } {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(address)
  if (!match?.[1] || !match[2]) throw new Error(`导出计划包含无效坐标：${address}`)
  return { columnIndex: columnNumber(match[1]) - 1, row: Number(match[2]) }
}

function applyCellWrites(xml: string, writes: Array<{ row: number; columnIndex: number; cell: PreviewCell }>): string {
  let result = xml
  for (const write of writes) {
    const address = `${columnName(write.columnIndex + 1)}${write.row}`
    const value = write.cell.cropId ? '' : (write.cell.numericValue ?? write.cell.value)
    // A self-closing cell (`<c .../>`) must never enter the normal-cell branch.
    // Otherwise that branch can continue until a later `</c>` and swallow rows.
    const cellPattern = new RegExp(`<c\\b([^>]*\\br="${address}"[^>]*)\\/>|<c\\b([^>]*\\br="${address}"[^>]*?)(?<!/)>([\\s\\S]*?)<\\/c>`, 'i')
    const match = cellPattern.exec(result)
    if (match) {
      const attributes = sanitizeTagAttributes(match[1] ?? match[2] ?? '').replace(/\s+t="[^"]*"/g, '')
      result = result.replace(cellPattern, inlineCell(attributes, value))
      continue
    }
    result = ensureRowAndCell(result, write.row, write.columnIndex, value)
  }
  const maximumRow = Math.max(1, ...writes.map((write) => write.row))
  const maximumColumn = Math.max(1, ...writes.map((write) => write.columnIndex + 1))
  return result.replace(/<dimension\b([^>]*\bref="[A-Z]+\d+:)([A-Z]+)(\d+)("[^>]*)\/>/i, (full, prefix: string, endColumn: string, endRow: string, suffix: string) => {
    const column = columnNumber(endColumn) >= maximumColumn ? endColumn : columnName(maximumColumn)
    const row = Math.max(Number(endRow), maximumRow)
    return `<dimension${prefix}${column}${row}${suffix}/>`
  })
}

function assertCellWritesRemainInTheirRows(
  xml: string,
  writes: Array<{ row: number; columnIndex: number; cell: PreviewCell }>,
  sheetName: string
): void {
  for (const write of writes) {
    const address = `${columnName(write.columnIndex + 1)}${write.row}`
    const row = new RegExp(`<row\\b[^>]*\\br="${write.row}"[^>]*>([\\s\\S]*?)<\\/row>`, 'i').exec(xml)?.[1]
    if (!row || !new RegExp(`<c\\b[^>]*\\br="${address}"(?:\\s|/|>)`, 'i').test(row)) {
      throw new Error(`导出质检失败：“${sheetName}”的 ${address} 未保留在正确行，已停止生成文件。`)
    }
  }
}

function assertCellWriteValues(
  xml: string,
  writes: Array<{ row: number; columnIndex: number; cell: PreviewCell }>,
  sheetName: string
): void {
  for (const write of writes) {
    // Image content is validated through its drawing anchor later; its cell is
    // intentionally cleared before the image is placed.
    if (write.cell.cropId) continue
    const address = `${columnName(write.columnIndex + 1)}${write.row}`
    const cellXml = new RegExp(`<c\\b[^>]*\\br="${address}"[^>]*>([\\s\\S]*?)<\\/c>`, 'i').exec(xml)?.[1]
    if (cellXml === undefined) throw new Error(`导出质检失败：“${sheetName}”的 ${address} 没有写入单元格内容。`)
    if (write.cell.numericValue !== undefined) {
      const actual = Number(/<v>([^<]*)<\/v>/i.exec(cellXml)?.[1] ?? Number.NaN)
      if (actual !== write.cell.numericValue) {
        throw new Error(`导出质检失败：“${sheetName}”的 ${address} 数值写入不一致，已停止生成文件。`)
      }
      continue
    }
    const actual = [...cellXml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)]
      .map((match) => decodeXml(match[1] ?? ''))
      .join('')
    if (actual !== write.cell.value) {
      throw new Error(`导出质检失败：“${sheetName}”的 ${address} 写入值不一致，已停止覆盖基础表。`)
    }
  }
}

function ensureRowAndCell(xml: string, row: number, columnIndex: number, value: string | number): string {
  const address = `${columnName(columnIndex + 1)}${row}`
  // Expand only the target empty row before matching its body. Otherwise a
  // self-closing row can consume the following populated row.
  xml = xml.replace(new RegExp(`<row\\b([^>]*\\br="${row}"[^>]*?)\\s*/>`, 'i'), '<row$1></row>')
  const rowPattern = new RegExp(`<row\\b([^>]*\\br="${row}"[^>]*)>([\\s\\S]*?)<\\/row>`, 'i')
  const rowMatch = rowPattern.exec(xml)
  if (rowMatch) {
    const style = nearestCellStyle(xml, columnIndex, row)
    const cell = cellXml(address, style, value)
    const orderedBody = insertCellInColumnOrder(rowMatch[2] ?? '', cell, columnIndex)
    return xml.replace(rowPattern, `<row${rowMatch[1]}>${orderedBody}</row>`)
  }
  const sourceRow = nearestRowTag(xml, row)
  const attributes = sourceRow ? sanitizeTagAttributes(sourceRow).replace(/\br="\d+"/, `r="${row}"`) : ` r="${row}"`
  const style = nearestCellStyle(xml, columnIndex, row)
  const newRow = `<row${attributes}>${cellXml(address, style, value)}</row>`
  const following = [...xml.matchAll(/<row\b[^>]*\br="(\d+)"/g)].find((match) => Number(match[1]) > row)
  if (following?.index !== undefined) return xml.slice(0, following.index) + newRow + xml.slice(following.index)
  return xml.replace(/<\/sheetData>/i, `${newRow}</sheetData>`)
}

function insertCellInColumnOrder(rowBody: string, cellXml: string, columnIndex: number): string {
  for (const match of rowBody.matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"/gi)) {
    if (columnNumber(match[1] ?? '') - 1 <= columnIndex) continue
    const offset = match.index ?? rowBody.length
    return `${rowBody.slice(0, offset)}${cellXml}${rowBody.slice(offset)}`
  }
  return `${rowBody}${cellXml}`
}

function inlineCell(attributes: string, value: string | number): string {
  return typeof value === 'number'
    ? `<c${attributes}><v>${value}</v></c>`
    : `<c${attributes} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`
}
function cellXml(address: string, style: string | null, value: string | number): string {
  const attributes = ` r="${address}"${style ? ` s="${style}"` : ''}`
  return inlineCell(attributes, value)
}
function nearestCellStyle(xml: string, columnIndex: number, targetRow: number): string | null {
  const column = columnName(columnIndex + 1)
  const matches = [...xml.matchAll(new RegExp(`<c\\b([^>]*\\br="${column}(\\d+)"[^>]*)`, 'gi'))]
    .map((match) => ({ row: Number(match[2]), style: /\bs="(\d+)"/.exec(match[1] ?? '')?.[1] ?? null }))
    .filter((item) => item.style)
    .toSorted((left, right) => Math.abs(left.row - targetRow) - Math.abs(right.row - targetRow))
  const sameColumn = matches.find((item) => item.row === targetRow - 2)?.style ?? matches[0]?.style
  if (sameColumn) return sameColumn
  const sameRow = [...xml.matchAll(new RegExp(`<c\\b([^>]*\\br="([A-Z]+)${targetRow}"[^>]*)`, 'gi'))]
    .map((match) => ({ column: columnNumber(match[2] ?? ''), style: /\bs="(\d+)"/.exec(match[1] ?? '')?.[1] ?? null }))
    .filter((item) => item.style)
    .toSorted((left, right) => Math.abs(left.column - (columnIndex + 1)) - Math.abs(right.column - (columnIndex + 1)))
  return sameRow[0]?.style ?? null
}
function nearestRowTag(xml: string, targetRow: number): string | null {
  const rows = [...xml.matchAll(/<row\b([^>]*)>/gi)].map((match) => ({ row: Number(/\br="(\d+)"/.exec(match[1] ?? '')?.[1] ?? 0), attributes: match[1] ?? '' })).filter((item) => item.row)
  return rows.find((item) => item.row === targetRow - 2)?.attributes ?? rows.toSorted((left, right) => Math.abs(left.row - targetRow) - Math.abs(right.row - targetRow))[0]?.attributes ?? null
}

function appendWorksheetDrawingRelationship(entries: PackageEntryRecord[], worksheetPath: string, drawingPath: string): string {
  const relsPath = `${posix.dirname(worksheetPath)}/_rels/${posix.basename(worksheetPath)}.rels`
  const existing = findPackageText(entries, relsPath)
  const ids = [...(existing ?? '').matchAll(/Id="rId(\d+)"/g)].map((match) => Number(match[1]))
  const id = `rId${Math.max(0, ...ids) + 1}`
  const target = posix.relative(posix.dirname(worksheetPath), drawingPath)
  const relationship = `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="${target}"/>`
  if (existing) replacePackageText(entries, relsPath, existing.replace(/<\/Relationships>/, `${relationship}</Relationships>`))
  else addEntry(entries, relsPath, Buffer.from(relationshipsDocument([relationship]), 'utf8'))
  return id
}

function resolveWorksheetDrawing(entries: PackageEntryRecord[], worksheetPath: string, nextDrawingIndex: number): WorksheetDrawing {
  const worksheetRelsPath = `${posix.dirname(worksheetPath)}/_rels/${posix.basename(worksheetPath)}.rels`
  const worksheetRels = findPackageText(entries, worksheetRelsPath) ?? ''
  const worksheetXml = requireText(entries, worksheetPath)
  const drawingId = /<drawing\b[^>]*\br:id="([^"]+)"[^>]*\/>/i.exec(worksheetXml)?.[1] ?? null
  const relationship = drawingId
    ? [...worksheetRels.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)].find((match) => parseAttributes(match[1] ?? '').Id === drawingId)
    : undefined
  const target = relationship ? parseAttributes(relationship[1] ?? '').Target : null
  const drawingPath = target ? posix.normalize(posix.join(posix.dirname(worksheetPath), target)) : `xl/drawings/drawing${nextDrawingIndex}.xml`
  const relationshipsPath = `xl/drawings/_rels/${posix.basename(drawingPath)}.rels`
  const drawingXmlText = findPackageText(entries, drawingPath)
  const drawingRelsText = findPackageText(entries, relationshipsPath)
  const anchors = drawingXmlText ? extractAnchors(drawingXmlText) : []
  const relationships = drawingRelsText
    ? [...drawingRelsText.matchAll(/<Relationship\b[^>]*\/?\s*>/gi)].map((match) => match[0])
    : []
  const shapeIds = drawingXmlText
    ? [...drawingXmlText.matchAll(/<xdr:cNvPr\b[^>]*\bid="(\d+)"/gi)].map((match) => Number(match[1]))
    : []
  return {
    path: drawingPath,
    relationshipsPath,
    worksheetRelationshipId: drawingId,
    relationships,
    anchors,
    nextShapeId: Math.max(0, ...shapeIds) + 1,
    nextDrawingIndex: target ? nextDrawingIndex : nextDrawingIndex + 1
  }
}

function extractAnchors(xml: string): string[] {
  return [...xml.matchAll(/<xdr:(?:twoCellAnchor|oneCellAnchor|absoluteAnchor)\b[\s\S]*?<\/xdr:(?:twoCellAnchor|oneCellAnchor|absoluteAnchor)>/gi)].map((match) => match[0])
}

function anchorPosition(xml: string): { column: number; row: number } | null {
  const column = Number(/<xdr:from>[\s\S]*?<xdr:col>(\d+)<\/xdr:col>/i.exec(xml)?.[1])
  const row = Number(/<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/i.exec(xml)?.[1])
  return Number.isInteger(column) && Number.isInteger(row) ? { column, row } : null
}

function nextRelationshipNumber(relationships: string[]): number {
  const numbers = relationships.flatMap((relationship) => [...relationship.matchAll(/\bId="rId(\d+)"/gi)].map((match) => Number(match[1])))
  return Math.max(0, ...numbers) + 1
}

function setPackageText(entries: PackageEntryRecord[], path: string, text: string): void {
  if (findPackageText(entries, path) === null) addEntry(entries, path, Buffer.from(text, 'utf8'))
  else replacePackageText(entries, path, text)
}

function retainOnlyWorksheets(workbookXml: string, sheetNames: string[]): string {
  const sheetsMatch = /<sheets\b[^>]*>([\s\S]*?)<\/sheets>/i.exec(workbookXml)
  if (!sheetsMatch) throw new Error('源工作簿缺少工作表清单')
  const requested = new Set(sheetNames)
  const sourceSheets = [...(sheetsMatch[1] ?? '').matchAll(/<sheet\b([^>]*)\/?\s*>/gi)]
    .map((match) => ({ name: decodeXml(parseAttributes(match[1] ?? '').name ?? ''), xml: match[0] }))
  const retained = sheetNames.flatMap((name) => sourceSheets.find((sheet) => sheet.name === name)?.xml ?? [])
  if (retained.length !== requested.size) throw new Error(`新建产品表模板缺少工作表：${sheetNames.join('、')}`)
  return workbookXml.replace(sheetsMatch[0], `<sheets>${retained.join('')}</sheets>`)
}

function ensureDrawingContentTypes(entries: PackageEntryRecord[], drawingPath: string): void {
  let xml = requireText(entries, '[Content_Types].xml')
  if (!/<Default\b[^>]*Extension="png"/i.test(xml)) xml = xml.replace(/<\/Types>/, '<Default Extension="png" ContentType="image/png"/></Types>')
  const override = `<Override PartName="/${drawingPath}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`
  if (!xml.includes(`PartName="/${drawingPath}"`)) xml = xml.replace(/<\/Types>/, `${override}</Types>`)
  replacePackageText(entries, '[Content_Types].xml', xml)
}

function imageAnchor(
  id: number,
  column: number,
  row: number,
  relationshipId: string,
  width: number,
  height: number,
  xOffsetPx: number,
  yOffsetPx: number
): string {
  const toEmu = (value: number): number => Math.max(0, Math.round(value * 9525))
  return `<xdr:oneCellAnchor><xdr:from><xdr:col>${column}</xdr:col><xdr:colOff>${toEmu(xOffsetPx)}</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>${toEmu(yOffsetPx)}</xdr:rowOff></xdr:from><xdr:ext cx="${toEmu(width)}" cy="${toEmu(height)}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${id}" name="CASEBANG 图片 ${id}"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`
}
function drawingXml(anchors: string[]): string { return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors.join('')}</xdr:wsDr>` }
function relationshipsDocument(items: string[]): string { return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join('')}</Relationships>` }
function addEntry(entries: PackageEntryRecord[], path: string, buffer: Buffer): void { entries.push({ path, buffer, crc32: '00000000', compressedSize: 0, uncompressedSize: buffer.length, isDirectory: false, mtime: new Date() }) }
function nextPartIndex(entries: PackageEntryRecord[], pattern: RegExp): number { return Math.max(0, ...entries.map((entry) => Number(pattern.exec(entry.path)?.[1] ?? 0))) + 1 }
function sanitizeTagAttributes(attributes: string): string {
  return attributes.replace(/\/\s*$/, '')
}

/** Remove template-only columns after the last business column. */
function truncateWorksheetAfterColumn(worksheetXml: string, maximumColumn: number): string {
  const retainCell = (cellXml: string): string => {
    const columnNameValue = /\br="([A-Z]{1,3})\d+"/i.exec(cellXml)?.[1]
    return columnNameValue && columnNumber(columnNameValue) > maximumColumn ? '' : cellXml
  }
  // Handle self-closing and normal cells separately. Keeping these patterns
  // separate prevents a self-closing J cell from consuming the following K
  // cell while the template is being truncated.
  let result = worksheetXml.replace(/<c\b[^>]*\/>/gi, retainCell)
  result = result.replace(/<c\b[^>]*>[\s\S]*?<\/c>/gi, retainCell)
  if (maximumColumn === 9) {
    // The current barcode contract ends at I. This explicit final sweep also
    // removes populated legacy K cells from older templates.
    result = result.replace(/<c\b(?=[^>]*\br="(?:[J-Z]|[A-Z]{2,3})\d+")[^>]*(?:\/>|>[\s\S]*?<\/c>)/gi, '')
  }
  result = result.replace(/\bspans="(\d+):\d+"/gi, (_full, start: string) => `spans="${start}:${maximumColumn}"`)
  result = result.replace(/<col\b([^>]*)\/>/gi, (columnXml, attributesSource: string) => {
    const attributes = parseAttributes(attributesSource)
    const minimum = Number(attributes.min)
    const maximum = Number(attributes.max)
    if (!Number.isInteger(minimum) || !Number.isInteger(maximum)) return columnXml
    if (minimum > maximumColumn) return ''
    if (maximum <= maximumColumn) return columnXml
    return columnXml.replace(/\bmax="\d+"/i, `max="${maximumColumn}"`)
  })
  result = result.replace(/<dimension\b([^>]*)\bref="([A-Z]{1,3})(\d+):([A-Z]{1,3})(\d+)"([^>]*)\/>/i,
    (_full, before: string, startColumn: string, startRow: string, _endColumn: string, endRow: string, after: string) =>
      `<dimension${before}ref="${startColumn}${startRow}:${columnName(maximumColumn)}${endRow}"${after}/>`
  )
  return result
}

/** Keep packaged templates compatible when the generated workbook gains columns. */
function applyPreviewColumnWidths(worksheetXml: string, widths: number[]): string {
  const columns = widths.map((width, index) => {
    const excelWidth = Math.max(1, (width - 5) / 7)
    return `<col min="${index + 1}" max="${index + 1}" width="${excelWidth.toFixed(3)}" customWidth="1"/>`
  }).join('')
  if (/<cols\b[^>]*>[\s\S]*?<\/cols>/i.test(worksheetXml)) {
    return worksheetXml.replace(/<cols\b[^>]*>[\s\S]*?<\/cols>/i, `<cols>${columns}</cols>`)
  }
  return worksheetXml.replace(/<sheetData\b/i, `<cols>${columns}</cols><sheetData`)
}

function parseSheetPaths(workbookXml: string, relationshipsXml: string): Array<{ name: string; path: string }> {
  const rels = new Map<string, string>()
  for (const match of relationshipsXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)) { const attributes = parseAttributes(match[1] ?? ''); if (attributes.Id && attributes.Target) rels.set(attributes.Id, attributes.Target) }
  return [...workbookXml.matchAll(/<sheet\b([^>]*)\/?\s*>/g)].flatMap((match) => { const attributes = parseAttributes(match[1] ?? ''); const target = rels.get(attributes['r:id'] ?? ''); return attributes.name && target ? [{ name: decodeXml(attributes.name), path: target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join('xl', target)) }] : [] })
}
function parseAttributes(source: string): Record<string, string> { const result: Record<string, string> = {}; for (const match of source.matchAll(/([\w:-]+)="([^"]*)"/g)) result[match[1] ?? ''] = match[2] ?? ''; return result }
function requireText(entries: PackageEntryRecord[], path: string): string { const value = findPackageText(entries, path); if (value === null) throw new Error(`工作簿缺少必要部件：${path}`); return value }
function columnName(index: number): string { let value = index; let name = ''; while (value > 0) { name = String.fromCharCode(65 + ((value - 1) % 26)) + name; value = Math.floor((value - 1) / 26) } return name }
function columnNumber(name: string): number { return [...name.toUpperCase()].reduce((value, character) => value * 26 + character.charCodeAt(0) - 64, 0) }
function escapeXml(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;') }
function decodeXml(value: string): string { return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&') }

function parseWorksheetGridSpec(worksheetXml: string): WorksheetGridSpec {
  const columnWidths = new Map<number, number>()
  const rowHeights = new Map<number, number>()
  const merges: Array<{ startColumn: number; startRow: number; endColumn: number; endRow: number }> = []

  for (const match of worksheetXml.matchAll(/<col\b([^>]*)\/?>/gi)) {
    const attributes = parseAttributes(match[1] ?? '')
    const startColumn = Number(attributes.min)
    const endColumn = Number(attributes.max)
    const widthValue = Number(attributes.width)
    const width = Number.isFinite(widthValue) && widthValue > 0 ? widthValue : defaultColumnWidth()
    if (Number.isInteger(startColumn) && Number.isInteger(endColumn) && startColumn >= 1 && endColumn >= startColumn) {
      for (let index = startColumn - 1; index < endColumn; index += 1) {
        columnWidths.set(index, convertColumnWidth(width))
      }
    }
  }

  for (const match of worksheetXml.matchAll(/<row\b([^>]*)>/gi)) {
    const attributes = parseAttributes(match[1] ?? '')
    const row = Number(attributes.r)
    const heightValue = Number(attributes.h ?? attributes.ht)
    if (Number.isInteger(row) && row > 0 && Number.isFinite(heightValue) && heightValue > 0) {
      rowHeights.set(row, Math.round(convertRowHeight(heightValue)))
    }
  }

  for (const match of worksheetXml.matchAll(/<mergeCell\b[^>]*\bref="([A-Z]+\d+:[A-Z]+\d+)"/gi)) {
    const range = match[1] ?? ''
    const parts = range.split(':')
    const startAddress = parseAddress(parts?.[0] ?? '')
    const endAddress = parseAddress(parts?.[1] ?? '')
    if (startAddress && endAddress) {
      merges.push({
        startColumn: startAddress.column,
        startRow: startAddress.row,
        endColumn: endAddress.column,
        endRow: endAddress.row
      })
    }
  }

  return { columnWidths, rowHeights, merges }
}

function resolveImagePlacement(write: { row: number; columnIndex: number; cell: PreviewCell }, spec: WorksheetGridSpec): WorksheetImageTarget {
  const startColumn = write.columnIndex
  const startRow = write.row
  const merged = spec.merges.find((item) => item.startColumn === startColumn && item.startRow === startRow)
  const endColumn = merged ? merged.endColumn : startColumn
  const endRow = merged ? merged.endRow : startRow
  const containerWidthPx = Math.max(1, sumColumns(spec.columnWidths, startColumn, endColumn))
  const containerHeightPx = Math.max(1, sumRows(spec.rowHeights, startRow, endRow))

  const target = write.cell.imageLayout
  const preferredWidth = target?.imageWidthPx
  const preferredHeight = target?.imageHeightPx
  const fitted = target?.fitMode === 'stretch'
    ? { width: containerWidthPx, height: containerHeightPx }
    : (preferredWidth && preferredHeight && preferredWidth > 0 && preferredHeight > 0)
      ? fitImage(containerWidthPx, containerHeightPx, preferredWidth, preferredHeight)
      : fitImage(containerWidthPx, containerHeightPx, 100, 100)

  const imageWidthPx = Math.max(1, Math.min(fitted.width, containerWidthPx))
  const imageHeightPx = Math.max(1, Math.min(fitted.height, containerHeightPx))
  return {
    startColumn,
    startRow: startRow - 1,
    containerWidthPx,
    containerHeightPx,
    imageWidthPx,
    imageHeightPx,
    xOffsetPx: Math.max(0, Math.round((containerWidthPx - imageWidthPx) / 2)),
    yOffsetPx: Math.max(0, Math.round((containerHeightPx - imageHeightPx) / 2))
  }
}

function sumColumns(widths: Map<number, number>, startColumn: number, endColumn: number): number {
  let total = 0
  for (let index = startColumn; index <= endColumn; index += 1) {
    total += widths.get(index) ?? defaultColumnWidth()
  }
  return total
}

function sumRows(heights: Map<number, number>, startRow: number, endRow: number): number {
  let total = 0
  for (let row = startRow; row <= endRow; row += 1) total += heights.get(row) ?? defaultRowHeight()
  return total
}

function parseAddress(address: string): { column: number; row: number } | null {
  const match = /^([A-Z]+)(\d+)$/i.exec(address)
  if (!match?.[1] || !match?.[2]) return null
  return { column: columnNameToIndex(match[1]), row: Number(match[2]) }
}

function columnNameToIndex(name: string): number {
  let value = 0
  for (const code of name.toUpperCase()) value = value * 26 + (code.charCodeAt(0) - 64)
  return Math.max(0, value - 1)
}

function fitImage(containerWidth: number, containerHeight: number, width: number, height: number): { width: number; height: number } {
  if (containerWidth <= 0 || containerHeight <= 0 || width <= 0 || height <= 0) {
    return { width: Math.max(1, containerWidth), height: Math.max(1, containerHeight) }
  }
  const scale = Math.min(containerWidth / width, containerHeight / height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}

function defaultColumnWidth(): number { return 64 }
function defaultRowHeight(): number { return 20 }
function convertColumnWidth(width: number): number { return Math.max(1, Math.round(width * 7 + 5)) }
function convertRowHeight(height: number): number { return Math.max(1, Math.round((height * 96) / 72)) }
