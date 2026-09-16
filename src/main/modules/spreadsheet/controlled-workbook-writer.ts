import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { resolve } from 'node:path'
import type {
  ControlledCellValue,
  ControlledWriteReport,
  ControlledWriteRequest,
  TemplateFieldBinding
} from '@shared/excel-contracts'
import {
  comparePackages,
  findPackageText,
  readOoxmlPackage,
  replacePackageText,
  writeOoxmlPackage
} from './ooxml-package'

export class ControlledWorkbookWriter {
  async write(request: ControlledWriteRequest): Promise<ControlledWriteReport> {
    if (resolve(request.sourcePath) === resolve(request.destinationPath)) {
      throw new Error('输出文件不能覆盖源工作簿')
    }
    const template = request.config.templates.find((item) => item.sheetName === request.sheetName)
    if (!template) throw new Error(`模板配置中不存在工作表：${request.sheetName}`)
    const currentHash = await hashFile(request.sourcePath)
    if (currentHash !== request.config.sourceSha256) {
      throw new Error('源工作簿与模板配置不一致，请重新生成模板配置')
    }
    if (request.rows.length === 0) throw new Error('没有需要写入的数据')

    const sourceEntries = await readOoxmlPackage(request.sourcePath)
    const targetXml = findPackageText(sourceEntries, template.sheetPartPath)
    if (targetXml === null) throw new Error(`未找到模板工作表部件：${template.sheetPartPath}`)
    const writes = buildCellWrites(request, template.fields, template.headerRow)
    const beforeStructure = captureWorksheetStructure(targetXml)
    const patchedXml = patchWorksheet(targetXml, writes)
    const afterStructure = captureWorksheetStructure(patchedXml)
    replacePackageText(sourceEntries, template.sheetPartPath, patchedXml)
    await writeOoxmlPackage(request.destinationPath, sourceEntries)

    const [sourceForDiff, destinationEntries] = await Promise.all([
      readOoxmlPackage(request.sourcePath),
      readOoxmlPackage(request.destinationPath)
    ])
    const changedEntries = comparePackages(sourceForDiff, destinationEntries)
    const destinationXml = findPackageText(destinationEntries, template.sheetPartPath)
    if (destinationXml === null) throw new Error('输出文件中缺少目标工作表')
    const finalStructure = captureWorksheetStructure(destinationXml)
    const onlyApprovedEntriesChanged =
      changedEntries.length === 1 &&
      changedEntries[0]?.kind === 'changed' &&
      changedEntries[0].path === template.sheetPartPath
    const checks = {
      sourceMatchesConfig: true,
      onlyApprovedEntriesChanged,
      formulasPreserved: beforeStructure.formulas === afterStructure.formulas && afterStructure.formulas === finalStructure.formulas,
      cellStylesPreserved: beforeStructure.styles === afterStructure.styles && afterStructure.styles === finalStructure.styles,
      rowColumnDimensionsPreserved: beforeStructure.dimensions === afterStructure.dimensions && afterStructure.dimensions === finalStructure.dimensions,
      imageReferencesPreserved: beforeStructure.images === afterStructure.images && afterStructure.images === finalStructure.images,
      stylesPartPreserved: partUnchanged(sourceForDiff, destinationEntries, 'xl/styles.xml'),
      drawingsPreserved: groupUnchanged(sourceForDiff, destinationEntries, (path) => /^xl\/(?:drawings|richData)\//i.test(path) || path === 'xl/cellimages.xml'),
      mediaPreserved: groupUnchanged(sourceForDiff, destinationEntries, (path) => /^xl\/media\//i.test(path)),
      relationshipsPreserved: groupUnchanged(sourceForDiff, destinationEntries, (path) => /_rels\/.*\.rels$/i.test(path))
    }
    const passed = Object.values(checks).every(Boolean)
    const report: ControlledWriteReport = {
      generatedAt: new Date().toISOString(),
      sourcePath: request.sourcePath,
      destinationPath: request.destinationPath,
      sheetName: request.sheetName,
      sheetPartPath: template.sheetPartPath,
      changedCells: writes.map((write) => write.address),
      changedEntries,
      checks,
      warnings: ['公式缓存值未主动改写；Excel/WPS 打开文件时会按原公式重新计算。'],
      passed
    }
    if (!passed) throw new Error(`受控写入完整性验证失败：${JSON.stringify(report.checks)}`)
    return report
  }
}

interface CellWrite {
  address: string
  value: ControlledCellValue
}

function buildCellWrites(
  request: ControlledWriteRequest,
  fields: TemplateFieldBinding[],
  headerRow: number
): CellWrite[] {
  const bindings = new Map(fields.map((field) => [field.field, field]))
  const writes: CellWrite[] = []
  const seen = new Set<string>()
  for (const rowWrite of request.rows) {
    if (!Number.isInteger(rowWrite.row) || rowWrite.row <= headerRow || rowWrite.row > 1_048_576) {
      throw new Error(`非法写入行：${rowWrite.row}，必须位于表头行之后`)
    }
    for (const [field, value] of Object.entries(rowWrite.values)) {
      if (value === undefined) continue
      const binding = bindings.get(field as TemplateFieldBinding['field'])
      if (!binding) throw new Error(`模板未识别字段：${field}`)
      if (binding.writeMode !== 'value') {
        throw new Error(`字段“${binding.label}”为 ${binding.writeMode}，禁止直接写入`)
      }
      const address = `${binding.column}${rowWrite.row}`
      if (seen.has(address)) throw new Error(`单元格重复写入：${address}`)
      seen.add(address)
      writes.push({ address, value: value as ControlledCellValue })
    }
  }
  if (writes.length === 0) throw new Error('没有合法的可写字段')
  return writes
}

function patchWorksheet(xml: string, writes: CellWrite[]): string {
  let result = xml
  for (const write of writes) {
    const pattern = new RegExp(`<c\\b([^>]*\\br="${escapeRegExp(write.address)}"[^>]*)>([\\s\\S]*?)<\\/c>|<c\\b([^>]*\\br="${escapeRegExp(write.address)}"[^>]*)\\/>`)
    const match = pattern.exec(result)
    if (!match) throw new Error(`目标单元格 ${write.address} 不存在；当前版本只允许写入模板已有单元格`)
    const attributes = match[1] ?? match[3] ?? ''
    const body = match[2] ?? ''
    if (/<f\b/i.test(body)) throw new Error(`目标单元格 ${write.address} 含公式，禁止覆盖`)
    const preservedAttributes = attributes.replace(/\s+t="[^"]*"/g, '')
    const replacement = renderCell(preservedAttributes, write.value)
    result = `${result.slice(0, match.index)}${replacement}${result.slice(match.index + match[0].length)}`
  }
  return result
}

function renderCell(attributes: string, value: ControlledCellValue): string {
  if (value === null) return `<c${attributes}/>`
  if (typeof value === 'string') {
    const preserve = /^\s|\s$/.test(value) ? ' xml:space="preserve"' : ''
    return `<c${attributes} t="inlineStr"><is><t${preserve}>${escapeXml(value)}</t></is></c>`
  }
  if (typeof value === 'boolean') return `<c${attributes} t="b"><v>${value ? 1 : 0}</v></c>`
  if (!Number.isFinite(value)) throw new Error('不允许写入非有限数值')
  return `<c${attributes}><v>${value}</v></c>`
}

function captureWorksheetStructure(xml: string): { formulas: string; styles: string; dimensions: string; images: string } {
  const formulas = [...xml.matchAll(/<c\b[^>]*\br="([A-Z]+\d+)"[^>]*>[\s\S]*?<f\b[^>]*>([\s\S]*?)<\/f>[\s\S]*?<\/c>/g)]
    .map((item) => `${item[1]}=${item[2]}`).join('\n')
  const styles = [...xml.matchAll(/<c\b([^>]*\br="([A-Z]+\d+)"[^>]*)/g)]
    .map((item) => `${item[2]}:${/\bs="([^"]+)"/.exec(item[1] ?? '')?.[1] ?? ''}`).join('\n')
  const dimensions = [
    /<dimension\b[^>]*\/?\s*>/.exec(xml)?.[0] ?? '',
    /<cols\b[^>]*>[\s\S]*?<\/cols>/.exec(xml)?.[0] ?? '',
    [...xml.matchAll(/<row\b[^>]*>/g)].map((item) => item[0]).join('\n')
  ].join('\n')
  const images = [...xml.matchAll(/<(?:drawing|legacyDrawing|legacyDrawingHF)\b[^>]*\/?\s*>/g)].map((item) => item[0]).join('\n')
  return { formulas, styles, dimensions, images }
}

function partUnchanged(
  before: Awaited<ReturnType<typeof readOoxmlPackage>>,
  after: Awaited<ReturnType<typeof readOoxmlPackage>>,
  path: string
): boolean {
  return groupUnchanged(before, after, (candidate) => candidate === path)
}

function groupUnchanged(
  before: Awaited<ReturnType<typeof readOoxmlPackage>>,
  after: Awaited<ReturnType<typeof readOoxmlPackage>>,
  predicate: (path: string) => boolean
): boolean {
  const signatures = (entries: typeof before): string => entries
    .filter((entry) => predicate(entry.path))
    .map((entry) => `${entry.path}:${entry.crc32}:${entry.uncompressedSize}`)
    .sort().join('\n')
  return signatures(before) === signatures(after)
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  return new Promise((resolveHash, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}
