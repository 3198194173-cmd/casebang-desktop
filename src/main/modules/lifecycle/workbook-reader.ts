import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { XMLParser } from 'fast-xml-parser'
import { findPackageText, readOoxmlPackage } from '../spreadsheet/ooxml-package'
import type { LifecycleRow } from '../../../shared/lifecycle-contracts'
import { parseMaterialIdentity, rowIdentityIssues } from '../../../shared/material-coding'
import type { MaterialModel } from '../../../shared/material-model-dictionary'

type Xml = Record<string, any>
const array = (value: any): Xml[] => value == null ? [] : Array.isArray(value) ? value : [value]
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false, processEntities: true })
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
const key = (value: string): string => value.normalize('NFKC').replace(/\s/g, '').toLowerCase()
const aliases: Record<string, string[]> = {
  name: ['物料名称'], barcode: ['69码', '69条码'], code: ['物料编码(工厂)', '物料编码', '物料代码'],
  item: ['类目', '物料类别'], material: ['材质', '颜色', '备注/材质'], domestic: ['建议零售价', '建议零售价(元)'],
  overseas: ['海外零售价', '海外零售价(美元)'], remark: ['备注(IP)', 'IP备注']
}
export async function readLifecycleWorkbook(path: string, modelDictionary?: readonly MaterialModel[]): Promise<{ rows: LifecycleRow[]; warnings: string[] }> {
  const entries = await readOoxmlPackage(path, { skipMedia: true })
  const required = (name: string): string => { const value = findPackageText(entries, name); if (!value) throw new Error(`不是完整的 xlsx 工作簿：缺少 ${name}`); return value }
  const workbook = xml(required('xl/workbook.xml'))
  const relationships = array(xml(required('xl/_rels/workbook.xml.rels')).Relationships?.Relationship)
  const shared = array(xml(findPackageText(entries, 'xl/sharedStrings.xml') ?? '<sst/>').sst?.si).map(text)
  const rows: LifecycleRow[] = []
  const warnings: string[] = []
  for (const sheet of array(workbook.workbook?.sheets?.sheet)) {
    const sheetName = String(sheet['@name'] ?? '')
    if (sheetName.startsWith('WpsReserved_')) continue
    const relation = relationships.find(rel => rel['@Id'] === sheet['@id'])
    if (!relation || relation['@TargetMode'] === 'External') throw new Error(`无法读取工作表 ${sheetName}`)
    const target = String(relation['@Target']).replace(/\\/g, '/')
    const part = target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join('xl', target))
    if (!part.startsWith('xl/worksheets/')) throw new Error('工作表路径超出允许范围')
    const sheetRows = array(xml(required(part)).worksheet?.sheetData?.row)
    let columns: Record<string, string> | null = null
    let detected = false
    for (const row of sheetRows) {
      const values = new Map<string, string>()
      const formulas = new Set<string>()
      for (const cell of array(row.c)) {
        const column = String(cell['@r'] ?? '').replace(/\d/g, '')
        const value = cell['@t'] === 's' ? shared[Number(cell.v)] ?? '' : cell['@t'] === 'inlineStr' ? text(cell.is) : text(cell.v)
        values.set(column, value)
        // Do not execute formulas or treat missing cached results as empty data.
        if (cell.f != null) formulas.add(column)
      }
      const possible: Record<string, string> = {}
      for (const [field, labels] of Object.entries(aliases)) {
        const matches = [...values].filter(([, value]) => labels.some(label => key(label) === key(value)))
        if (matches.length === 1) possible[field] = matches[0]![0]
      }
      if (possible.name && possible.barcode && possible.code) { columns = possible; detected = true; continue }
      if (!columns) continue
      const value = (field: string): string => values.get(columns![field] ?? '') ?? ''
      if (!['name', 'barcode', 'code', 'item', 'material', 'domestic', 'overseas', 'remark'].some(field => value(field).trim() || formulas.has(columns![field] ?? ''))) continue
      const rowNumber = Number(row['@r'])
      if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > 1_048_576) throw new Error('工作表包含无效行坐标')
      const item: LifecycleRow = {
        id: createHash('sha256').update(`${sheetName}\0${rowNumber}`).digest('hex').slice(0, 32), sheet: sheetName, row: rowNumber,
        nameAddress: `${columns.name}${rowNumber}`, barcodeAddress: `${columns.barcode}${rowNumber}`, materialCodeAddress: `${columns.code}${rowNumber}`,
        materialName: value('name'), barcode: value('barcode'), materialCode: value('code'), itemClass: value('item'), material: value('material'),
        domesticPrice: value('domestic'), overseasPrice: value('overseas'), remark: value('remark'),
        identity: parseMaterialIdentity(value('name'), value('item'), modelDictionary), issues: []
      }
      item.issues = rowIdentityIssues(item)
      if (Object.values(columns).some(column => formulas.has(column))) item.issues.push('业务字段含公式：仅显示缓存值，须人工确认，未执行公式')
      rows.push(item)
      if (rows.length > 20_000) throw new Error('本批超过 2 万条物料，请按任务拆分后导入；不要把总表作为新建任务导入')
    }
    if (!detected) warnings.push(`“${sheetName}”未识别为条码业务表，原文件已完整保留；若包含待建档物料，请核对表头。`)
  }
  if (!rows.length) throw new Error('未找到同时含“物料名称、69码、物料编码”的业务表头。支持表名带数量后缀，不要求固定工作表名称。')
  for (const field of ['barcode', 'materialCode'] as const) {
    const counts = new Map<string, number>()
    for (const row of rows) if (row[field]) counts.set(row[field], (counts.get(row[field]) ?? 0) + 1)
    for (const row of rows) if ((counts.get(row[field]) ?? 0) > 1) row.issues.push(`本文件${field === 'barcode' ? '69码' : '物料编码'}重复：${row[field]}`)
  }
  return { rows, warnings }
}
