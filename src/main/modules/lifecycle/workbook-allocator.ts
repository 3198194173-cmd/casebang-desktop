import { basename, posix } from 'node:path'
import { XMLParser } from 'fast-xml-parser'
import { findPackageText, readOoxmlPackage, replacePackageText, writeOoxmlPackage, type PackageEntryRecord } from '../spreadsheet/ooxml-package'
import type { LifecycleRow } from '../../../shared/lifecycle-contracts'
import { parseMaterialIdentity } from '../../../shared/material-coding'

type Xml = Record<string, any>
type CellWrite = { address: string; value: string }
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false, processEntities: true })
const array = (value: any): Xml[] => value == null ? [] : Array.isArray(value) ? value : [value]
const normalizedHeader = (value: string): string => value.normalize('NFKC').replace(/\s/g, '').toLowerCase()

function text(node: any): string {
  if (node == null) return ''
  if (typeof node !== 'object') return String(node)
  if (node.t != null) return text(node.t)
  if (node['#text'] != null) return String(node['#text'])
  return array(node.r).map(text).join('')
}

function xml(source: string): Xml {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('工作簿包含不支持的 XML 实体声明')
  return parser.parse(source) as Xml
}

function required(entries: PackageEntryRecord[], name: string): string {
  const value = findPackageText(entries, name)
  if (value == null) throw new Error(`工作簿缺少 ${name}`)
  return value
}

function sheetParts(entries: PackageEntryRecord[]): Array<{ name: string; path: string }> {
  const workbook = xml(required(entries, 'xl/workbook.xml'))
  const relationships = array(xml(required(entries, 'xl/_rels/workbook.xml.rels')).Relationships?.Relationship)
  return array(workbook.workbook?.sheets?.sheet).map(sheet => {
    const relationship = relationships.find(value => value['@Id'] === sheet['@id'])
    if (!relationship || relationship['@TargetMode'] === 'External') throw new Error(`无法读取工作表 ${String(sheet['@name'] ?? '')}`)
    const target = String(relationship['@Target']).replace(/\\/g, '/')
    const path = target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join('xl', target))
    if (!path.startsWith('xl/worksheets/')) throw new Error('工作表路径超出允许范围')
    return { name: String(sheet['@name'] ?? ''), path }
  })
}

function sharedStrings(entries: PackageEntryRecord[]): string[] {
  return array(xml(findPackageText(entries, 'xl/sharedStrings.xml') ?? '<sst/>').sst?.si).map(text)
}

function decodedCell(cell: Xml, shared: string[]): string {
  if (cell['@t'] === 's') return shared[Number(cell.v)] ?? ''
  if (cell['@t'] === 'inlineStr') return text(cell.is)
  return text(cell.v)
}

/** Finds the greatest used sequence for one YYYYMM namespace across every recognized 69-code column. */
export async function inspectBarcodeSequence(path: string, monthPrefix: string): Promise<{ previousCode: string | null; maximumSequence: number; masterFileName: string }> {
  if (!/^\d{4}(0[1-9]|1[0-2])$/.test(monthPrefix)) throw new Error('69 码前缀必须是 6 位有效年月，例如 202609。')
  const entries = await readOoxmlPackage(path, { skipMedia: true })
  const shared = sharedStrings(entries)
  let maximumSequence = 0
  for (const sheet of sheetParts(entries)) {
    if (sheet.name.startsWith('WpsReserved_')) continue
    const rows = array(xml(required(entries, sheet.path)).worksheet?.sheetData?.row)
    let barcodeColumn = ''
    for (const row of rows) {
      const cells = array(row.c)
      for (const cell of cells) {
        const value = decodedCell(cell, shared).trim()
        if (['69码', '69条码'].includes(normalizedHeader(value))) {
          barcodeColumn = String(cell['@r'] ?? '').replace(/\d/g, '')
        }
      }
      if (!barcodeColumn) continue
      const barcodeCell = cells.find(cell => String(cell['@r'] ?? '').replace(/\d/g, '') === barcodeColumn)
      const candidate = barcodeCell ? decodedCell(barcodeCell, shared).trim() : ''
      const match = new RegExp(`^${monthPrefix}(\\d{7})$`).exec(candidate)
      if (match) maximumSequence = Math.max(maximumSequence, Number(match[1]))
    }
  }
  return { previousCode: maximumSequence ? `${monthPrefix}${String(maximumSequence).padStart(7, '0')}` : null, maximumSequence, masterFileName: basename(path) }
}

/** Reads only the three master columns needed for pattern lookup; the material master is not subject to task row limits. */
export async function inspectMaterialMappingRows(path: string): Promise<LifecycleRow[]> {
  const entries = await readOoxmlPackage(path, { skipMedia: true })
  const shared = sharedStrings(entries)
  const result: LifecycleRow[] = []
  for (const sheet of sheetParts(entries)) {
    if (sheet.name.startsWith('WpsReserved_')) continue
    const rows = array(xml(required(entries, sheet.path)).worksheet?.sheetData?.row)
    let columns: { item: string; code: string; name: string } | null = null
    for (const row of rows) {
      const cells = array(row.c)
      const values = new Map(cells.map(cell => [String(cell['@r'] ?? '').replace(/\d/g, ''), decodedCell(cell, shared)]))
      if (!columns) {
        const find = (labels: string[]): string => [...values].find(([, value]) => labels.includes(normalizedHeader(value)))?.[0] ?? ''
        const candidate = {
          item: find(['类目', '物料类别']),
          code: find(['物料编码(工厂)', '物料编码', '物料代码']),
          name: find(['物料名称'])
        }
        if (candidate.code && candidate.name) columns = candidate
        continue
      }
      const materialCode = values.get(columns.code)?.trim() ?? ''
      const materialName = values.get(columns.name)?.trim() ?? ''
      if (!materialCode || !materialName) continue
      const itemClass = values.get(columns.item)?.trim() ?? ''
      const rowNumber = Number(row['@r'])
      if (!Number.isInteger(rowNumber) || rowNumber < 1) continue
      result.push({
        id: `${sheet.name}:${rowNumber}`, sheet: sheet.name, row: rowNumber,
        nameAddress: `${columns.name}${rowNumber}`, barcodeAddress: '', materialCodeAddress: `${columns.code}${rowNumber}`,
        itemClass, materialName, barcode: '', materialCode, material: '', domesticPrice: '', overseasPrice: '', remark: '',
        identity: parseMaterialIdentity(materialName, itemClass), issues: []
      })
    }
  }
  return result
}

export async function writeLifecycleCells(
  sourcePath: string,
  destinationPath: string,
  writesBySheet: Map<string, CellWrite[]>
): Promise<void> {
  const entries = await readOoxmlPackage(sourcePath)
  const sheets = new Map(sheetParts(entries).map(sheet => [sheet.name, sheet.path]))
  for (const [sheetName, writes] of writesBySheet) {
    const part = sheets.get(sheetName)
    if (!part) throw new Error(`共享工作簿缺少工作表“${sheetName}”`)
    let worksheet = required(entries, part)
    for (const write of writes) worksheet = setInlineStringCell(worksheet, write.address, write.value)
    for (const write of writes) {
      const cell = new RegExp(`<c\\b[^>]*\\br="${write.address}"[^>]*(?:/>|>[\\s\\S]*?</c>)`, 'i').exec(worksheet)?.[0] ?? ''
      if (!cell.includes(escapeXml(write.value))) throw new Error(`写入 ${sheetName}!${write.address} 后校验失败`)
    }
    replacePackageText(entries, part, worksheet)
  }
  await writeOoxmlPackage(destinationPath, entries)
}

function setInlineStringCell(worksheet: string, address: string, value: string): string {
  if (!/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(address)) throw new Error(`无效单元格地址：${address}`)
  const escaped = escapeXml(value)
  const cellPattern = new RegExp(`<c\\b([^>]*\\br="${address}"[^>]*)(?:/>|>[\\s\\S]*?</c>)`, 'i')
  if (cellPattern.test(worksheet)) {
    return worksheet.replace(cellPattern, (_whole, attributes: string) => {
      const clean = attributes.replace(/\s+t="[^"]*"/gi, '')
      return `<c${clean} t="inlineStr"><is><t xml:space="preserve">${escaped}</t></is></c>`
    })
  }
  const rowNumber = Number(address.replace(/\D/g, ''))
  const rowPattern = new RegExp(`(<row\\b[^>]*\\br="${rowNumber}"[^>]*>)([\\s\\S]*?)(</row>)`, 'i')
  if (!rowPattern.test(worksheet)) throw new Error(`工作簿缺少 ${address} 所在行，已停止写入`)
  const inserted = `<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${escaped}</t></is></c>`
  return worksheet.replace(rowPattern, (_whole, start: string, cells: string, end: string) => {
    const targetColumn = columnNumber(address.replace(/\d/g, ''))
    const later = [...cells.matchAll(/<c\b[^>]*\br="([A-Z]{1,3})\d+"[^>]*(?:\/>|>[\s\S]*?<\/c>)/gi)]
      .find(match => columnNumber(match[1]!.toUpperCase()) > targetColumn)
    const body = later?.index == null ? cells + inserted : cells.slice(0, later.index) + inserted + cells.slice(later.index)
    return start + body + end
  })
}

function columnNumber(column: string): number {
  return [...column].reduce((total, character) => total * 26 + character.charCodeAt(0) - 64, 0)
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}
