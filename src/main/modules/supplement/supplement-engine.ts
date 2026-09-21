import { XMLParser } from 'fast-xml-parser'
import { posix } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { readOoxmlParts } from '../spreadsheet/ooxml-package'
import type { SupplementRequest, SupplementResult, SupplementRow } from '../../../shared/supplement-contracts'
import { needsSilver, silverVariant, withoutSilver } from '../../../shared/supplement-rules'
import { WorkbookPreviewService } from '../spreadsheet/workbook-preview-service'
import { chineseLookupKey, collectSupplementInputs, type SupplementInputCell } from './supplement-input'
import { parsePhoneMaterialCode } from '../../../shared/material-coding'

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, parseTagValue: false })
const list = <T>(v: T | T[] | undefined): T[] => v === undefined ? [] : Array.isArray(v) ? v : [v]
// Names are text data, never evaluate formulas or follow external workbook links.
function txt(v: any): string { return typeof v === 'object' && v !== null ? String(v['#text'] ?? '') : String(v ?? '') }
export async function readSheets(path: string): Promise<{ name: string; cells: { ref: string; value: string }[] }[]> {
  const meta = await readOoxmlParts(path, ['xl/workbook.xml', 'xl/_rels/workbook.xml.rels'])
  try { const shared = await readOoxmlParts(path, ['xl/sharedStrings.xml']); meta.set('xl/sharedStrings.xml', shared.get('xl/sharedStrings.xml')!) }
  catch (e) { if (!(e instanceof Error) || e.message !== '工作簿缺少必要部件：xl/sharedStrings.xml') throw e }
  const strings = list<any>(parser.parse(meta.get('xl/sharedStrings.xml')?.toString() ?? '<sst/>').sst?.si).map(si => si.t !== undefined ? txt(si.t) : list<any>(si.r).map(r => txt(r.t)).join(''))
  const relationships = new Map(list<any>(parser.parse(meta.get('xl/_rels/workbook.xml.rels')!.toString()).Relationships.Relationship).filter(r => r['@TargetMode'] !== 'External').map(r => [r['@Id'], r['@Target']]))
  const sheets = list<any>(parser.parse(meta.get('xl/workbook.xml')!.toString()).workbook.sheets.sheet)
  const result: { name: string; cells: { ref: string; value: string }[] }[] = []
  for (const sheet of sheets) {
    const target = String(relationships.get(sheet['@id']) ?? '')
    const part = target.startsWith('/') ? target.slice(1) : posix.normalize('xl/' + target)
    const data = await readOoxmlParts(path, [part])
    if (!data.has(part)) continue
    const xml = parser.parse(data.get(part)!.toString())
    const cells: { ref: string; value: string }[] = []
    for (const row of list<any>(xml.worksheet?.sheetData?.row)) {
      for (const c of list<any>(row.c)) {
        if (c.f) continue
        const value = c['@t'] === 's' ? strings[Number(c.v)] : c['@t'] === 'inlineStr' ? (c.is?.t !== undefined ? txt(c.is.t) : list<any>(c.is?.r).map(r => txt(r.t)).join('')) : txt(c.v)
        if (value) cells.push({ ref: c['@r'], value })
      }
    }
    result.push({ name: sheet['@name'], cells })
    await setImmediate()
  }
  return result
}
const norm = (v: string): string => v.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
// Model must terminate the name, followed only by parenthesized SKU attributes.
// Long alternatives precede short ones to preserve compound models such as iP18 Pro/17 Pro.
const modelPattern = /\s+((?:iP(?:hone)?\s*(?:\d+(?:e)?(?:\s*(?:Pro\s*Max|Pro|Plus|Air|Mini|Max))?(?:\s*\/\s*(?:iP)?\d+(?:e)?(?:\s*(?:Pro\s*Max|Pro|Plus|Air|Mini|Max))?)?|Fold\s*[（(]Duo[）)]))|(?:Mate|Pura|Galaxy|Pixel)\s*[\w +/.-]+?)\s*((?:[（(][^()（）]+[）)]\s*)*)$/i
export function splitModel(value: string): { base: string; model: string; variant: string } | null {
  const match = value.trim().match(modelPattern)
  return match ? { base: value.trim().slice(0, match.index).trim(), model: match[1]!.trim(), variant: (match[2] ?? '').trim() } : null
}

// The destination is user supplied and need not exist in any master catalog.
// Source model parsing is deliberately separate, to avoid guessing where a
// historical material name ends and its model/variant begins.
export function validateTargetModel(value: string): string {
  const model = value.trim()
  if (!model || model.length > 100 || /[\r\n\t\x00-\x1f\x7f]/.test(model) || !/[\p{L}\p{N}]/u.test(model)) throw new Error('请填写有效的目标机型（1–100 个字符，单行），例如 HW PX VIEW；目标机型无需存在于总表。')
  if (/[（(]\s*(?:银框|Y)\s*[）)]/i.test(model)) throw new Error('目标机型中不要填写（银框）或（Y）款式后缀，款式会从补齐表保留。')
  return model
}
function identity(base: string): string {
  const code = base.match(/\b[A-Z]{2,5}\d{5,8}\b/i)?.[0]
  // Product family prevents matching a back cover or another shell with the same design ID.
  if (code) return norm(base.split('-')[0]!.replace(/^CASEBANG\s*/i, '')) + ':' + code.toUpperCase()
  return norm(base.replace(/^CASEBANG\s*/i, '').replace(/^(?:联名)?(?:防摔保护壳|手机壳|保护壳)?潮流款(?=-)/, '出镜壳'))
}
export function expandShellVariants(cells: SupplementInputCell[]): (SupplementInputCell & { generated?: boolean })[] {
  let batch = ''
  const seen = new Set<string>()
  const id = (value: string): string => { const p = splitModel(value); return p ? batch + ':' + identity(p.base) + ':' + norm(p.variant) : value }
  for (const c of cells) {
    if (/^A\d+$/.test(c.ref) && /第.+批/.test(c.value)) batch = c.value
    if (splitModel(c.value)) seen.add(id(c.value))
  }
  batch = ''
  const expanded: (SupplementInputCell & { generated?: boolean })[] = []
  for (const c of cells) {
    if (/^A\d+$/.test(c.ref) && /第.+批/.test(c.value)) batch = c.value
    expanded.push(c)
    const p = splitModel(c.value)
    if (!p || !needsSilver(p.base)) continue
    const variant = silverVariant(p.variant) ? withoutSilver(p.variant) : '（银框）' + p.variant
    const value = `${p.base} ${p.model}${variant}`
    if (!seen.has(id(value))) { expanded.push({ ...c, ref: c.ref + (silverVariant(variant) ? '·自动银框' : '·自动普通'), value, generated: true }); seen.add(id(value)) }
  }
  return expanded
}
export async function analyzeSupplement(request: SupplementRequest): Promise<SupplementResult> {
  const targetModel = validateTargetModel(request.targetModel)
  const index = new Map<string, { values: string[]; reference: string }[]>()
  const chineseIndex = new Map<string, { values: string[]; reference: string }[]>()
  for (const sheet of await readSheets(request.masterPath)) {
    const rows = new Map<number, Map<string, string>>()
    for (const c of sheet.cells) {
      const row = Number(c.ref.match(/\d+$/)![0]); const col = c.ref.replace(/\d+$/, '')
      if (!rows.has(row)) rows.set(row, new Map())
      rows.get(row)!.set(col, c.value)
    }
    const header = [...rows.entries()].find(([, r]) => [...r.values()].includes('物料名称'))
    if (!header) continue
    const headers = ['品类', '69码', '物料编码', '物料名称', '建议零售价', '海外零售价', '备注', '联名IP', '中文名称']
    const columns = headers.map(h => [...header[1]].find(([, v]) => v === h || h === '中文名称' && v === '中文名称对应')?.[0])
    for (const [row, cells] of rows) {
      if (row <= header[0]) continue
      const values = columns.map(c => c ? cells.get(c) ?? '' : '')
      const parsed = splitModel(values[3] ?? ''); if (!parsed) continue
      const key = identity(parsed.base) + ':' + norm(parsed.variant)
      if (!index.has(key)) index.set(key, [])
      index.get(key)!.push({ values, reference: `${sheet.name}!${columns[3]}${row}` })
      for (const name of new Set([values[8], parsed.base].filter((name): name is string => Boolean(name)))) {
        const chineseKey = chineseLookupKey(name)
        const entries = chineseIndex.get(chineseKey) ?? []
        entries.push({ values, reference: `${sheet.name}!${columns[3]}${row}` }); chineseIndex.set(chineseKey, entries)
      }
    }
  }
  if (!index.size) throw new Error('总物料表未找到可识别的物料名称及机型，请检查表头与文件。')
  const result: SupplementRow[] = []
  const previews = new WorkbookPreviewService()
  for (const sheet of await readSheets(request.inputPath)) {
    let batch = sheet.name
    const metadata = await previews.read(request.inputPath, { kind: 'domesticNaming', sheetName: sheet.name, imageEndRow: 0 })
    const images = metadata.rows.flatMap(row => row.cells.filter(c => c.hasImage).map(c => c.address))
    const isSku = (value: string) => /^CASEBANG/i.test(value.trim()) && Boolean(splitModel(value) || /\biP\d|\bCZ\d{5}/i.test(value))
    const inputs = collectSupplementInputs(sheet.cells, images, isSku, value => {
      const candidates = chineseIndex.get(chineseLookupKey(value)) ?? []
      if (!candidates.length) return { issue: '待补充资料：中文名称未在总表中精确匹配，请核对名称或补充图案编码。' }
      const identities = new Set(candidates.map(c => identity(splitModel(c.values[3]!)!.base)))
      if (identities.size !== 1) return { issue: '中文名称对应多个不同产品或图案，需补充完整物料名称确认。', conflict: true }
      const selected = candidates.find(c => !splitModel(c.values[3]!)!.variant) ?? candidates[0]!
      return { value: selected.values[3]! }
    })
    for (const c of expandShellVariants(inputs)) {
      if (/^A\d+$/.test(c.ref) && /第[一二三四五六七八九十\d]+批/.test(c.value)) batch = c.value.match(/第[一二三四五六七八九十\d]+批/)![0]
      if (c.issue) { result.push({ source: `${sheet.name}!${c.ref}`, batch, series: '待补充资料', original: c.original ?? c.value, model: '', variant: '', status: c.conflict ? 'conflict' : 'missing', reason: c.issue, reference: '', values: [] }); continue }
      if (!/^CASEBANG/i.test(c.value.trim())) continue
      const parsed = splitModel(c.value)
      if (!parsed && !/\biP\d|\bCZ\d{5}/i.test(c.value)) continue // Chinese captions are not SKU rows.
      const series = parsed?.base.match(/^(.*?系列)/)?.[1] ?? parsed?.base ?? c.value
      const output: SupplementRow = { source: `${sheet.name}!${c.ref}`, batch, series, original: c.original ?? c.value, model: parsed?.model ?? '', variant: parsed?.variant ?? '', status: 'missing', reason: '', reference: '', values: [] }
      if (!parsed) { output.reason = '机型边界无法准确识别，未自动替换'; result.push(output); continue }
      let candidates = index.get(identity(parsed.base) + ':' + norm(parsed.variant)) ?? []
      let copiedOtherVariant = false
      if (!candidates.length && c.generated) {
        const alternate = silverVariant(parsed.variant) ? withoutSilver(parsed.variant) : '（银框）' + parsed.variant
        candidates = index.get(identity(parsed.base) + ':' + norm(alternate)) ?? []
        copiedOtherVariant = candidates.length > 0
      }
      if (!candidates.length) output.reason = '总表中未找到同图案、同产品类型和同款式记录'
      else {
        const signatures = new Set(candidates.map(c => JSON.stringify([c.values[0], c.values[7], c.values[8]])))
        if (signatures.size > 1) { output.status = 'conflict'; output.reason = `找到 ${candidates.length} 条参考记录，但品类/联名IP/中文名称不一致，需确认` }
        else {
          const sameModel = candidates.find(c => norm(splitModel(c.values[3]!)!.model) === norm(parsed.model))
          const selected = sameModel ?? candidates[0]!
          output.status = 'matched'; output.reference = selected.reference
          output.reason = sameModel ? '采用输入同机型参考行；价格/材质差异不阻止生成' : '未找到完全相同机型，采用同图案同款式首条参考行；请核对价格/材质'
          if (c.generated) output.reason = '自动补齐款式；' + (copiedOtherVariant ? '总表无该款式，复制另一款式参考数据，请调整对应价格' : output.reason)
          output.values = [...selected.values]; output.values[1] = ''
          const historicalCode = parsePhoneMaterialCode(output.values[2] ?? '')
          if (!historicalCode) {
            output.status = 'conflict'
            output.reason = '参考行缺少可验证的完整物料编码，不能安全保留图案前缀'
            output.values = []
            result.push(output)
            continue
          }
          output.values[2] = (selected.values[2] ?? '').slice(0, -2)
          const referenceName = splitModel(output.values[3]!)!
          output.values[3] = `${referenceName.base} ${targetModel}${parsed.variant}`
        }
      }
      result.push(output)
      if (c.original && output.status === 'matched') output.reason = '中文名称精确匹配总表；' + output.reason
    }
  }
  return { rows: result, matched: result.filter(r => r.status === 'matched').length, missing: result.filter(r => r.status === 'missing').length, conflict: result.filter(r => r.status === 'conflict').length }
}
