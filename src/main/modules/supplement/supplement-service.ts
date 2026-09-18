import { dialog } from 'electron'
import { createWriteStream } from 'node:fs'
import { resolve, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import yazl from 'yazl'
import { z } from 'zod'
import type { SupplementResult } from '../../../shared/supplement-contracts'
import { priceGroup } from '../../../shared/supplement-rules'
import { supplementLayout, supplementWidths } from '../../../shared/supplement-layout'
export function applySupplementOverrides(result: SupplementResult, input: unknown): SupplementResult {
  const price = z.string().trim().max(30).refine(v => v === '' || /^\d+(?:\.\d{1,2})?$/.test(v), '统一价格请输入非负数字，最多两位小数').optional()
  const fields = { domesticPrice: price, overseasPrice: price }
  const overrides = z.object({ ...fields, variants: z.array(z.object({ variant: z.string().max(200), ...fields })).max(200).optional() }).parse(input ?? {})
  const variantKey = priceGroup
  const variants = new Map((overrides.variants ?? []).map(v => [variantKey(v.variant), v]))
  if (variants.size !== (overrides.variants?.length ?? 0)) throw new Error('款式设置重复，请重新识别')
  return { ...result, rows: result.rows.map(row => {
    if (row.status !== 'matched') return row
    const values = [...row.values]
    const selected = variants.get(variantKey(row.variant)) ?? overrides
    if (selected.domesticPrice) values[4] = selected.domesticPrice
    if (selected.overseasPrice) values[5] = `US$${selected.overseasPrice}`
    return { ...row, values }
  }) }
}
const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
export async function writeSupplement(path: string, result: SupplementResult): Promise<void> {
  const groups = supplementLayout(result)
  const zip = new yazl.ZipFile()
  const add = (name: string, xml: string): void => zip.addBuffer(Buffer.from(xml), name)
  const names = [...groups.keys()].map((s, i) => `${i + 1}-${s.replace(/[\\/*?:\[\]]/g, '')}`.slice(0, 31))
  add('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`)
  add('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
  add('xl/workbook.xml', `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((name, i) => `<sheet name="${escape(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`)
  add('xl/_rels/workbook.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`)
  add('xl/styles.xml', '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="SimSun"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF4D6"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="0" fillId="2" borderId="0" applyFill="1"/></cellXfs></styleSheet>')
  let i = 0
  for (const rows of groups.values()) {
    add(`xl/worksheets/sheet${++i}.xml`, `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${supplementWidths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${rows.map((row, r) => `<row r="${r + 1}" ht="21" customHeight="1">${row.map((value, c) => `<c s="${row[9] === '未匹配' || row[9] === '待确认' ? 1 : 0}" r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${escape(value)}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`)
  }
  await new Promise<void>((ok, fail) => {
    const stream = createWriteStream(path, { flags: 'wx' })
    stream.on('finish', ok); stream.on('error', fail); zip.outputStream.on('error', fail)
    zip.outputStream.pipe(stream); zip.end()
  })
}
export class SupplementService {
  private result: SupplementResult | null = null
  private sources: string[] = []
  private busy = false
  async select(): Promise<string | null> { const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }] }); return r.canceled ? null : r.filePaths[0] ?? null }
  async analyze(input: unknown): Promise<SupplementResult> {
    if (this.busy) throw new Error('正在处理，请稍候')
    const request = z.object({ masterPath: z.string().endsWith('.xlsx'), inputPath: z.string().endsWith('.xlsx'), targetModel: z.string().trim().min(1).max(100) }).parse(input)
    this.busy = true; this.result = null
    try {
      this.sources = [request.masterPath, request.inputPath].map(p => resolve(p).toLowerCase())
      this.result = await new Promise<SupplementResult>((ok, fail) => {
        const worker = new Worker(join(__dirname, 'supplement-worker.js'), { workerData: request, resourceLimits: { maxOldGenerationSizeMb: 384 } })
        const timeout = setTimeout(() => { void worker.terminate(); fail(new Error('读取超过两分钟，请检查文件大小或格式')) }, 120000)
        worker.once('message', message => { clearTimeout(timeout); void worker.terminate(); if (message.error) fail(new Error(message.error)); else ok(message.result) })
        worker.once('error', error => { clearTimeout(timeout); fail(error) })
        worker.once('exit', code => { clearTimeout(timeout); if (code !== 0) fail(new Error('后台解析线程已退出，请重试或检查文件')) })
      })
      return this.result
    }
    finally { this.busy = false }
  }
  async export(input?: unknown): Promise<string | null> {
    const output = this.prepareOutput(input)
    this.busy = true
    try {
      const r = await dialog.showSaveDialog({ defaultPath: `原有产品补充新机型-${Date.now()}.xlsx`, filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }] })
      if (r.canceled || !r.filePath) return null
      await this.writeOutput(r.filePath, output)
      return r.filePath
    } finally { this.busy = false }
  }
  async exportTo(path: string, input?: unknown): Promise<string> {
    const output = this.prepareOutput(input)
    this.busy = true
    try {
      await this.writeOutput(path, output)
      return path
    } finally { this.busy = false }
  }
  private prepareOutput(input?: unknown): SupplementResult {
    const restored = z.object({ draft: z.object({ sourcePaths: z.array(z.string().min(1)).length(2), result: z.object({ matched: z.number(), missing: z.number(), conflict: z.number(), rows: z.array(z.object({ source: z.string(), batch: z.string(), series: z.string(), original: z.string(), model: z.string(), variant: z.string(), status: z.enum(['matched', 'missing', 'conflict']), reason: z.string(), reference: z.string(), values: z.array(z.string()).max(12) })).max(20000) }) }).optional() }).parse(input ?? {}).draft
    if (!this.busy && restored) {
      const rows = restored.result.rows
      this.result = { rows, matched: rows.filter(r => r.status === 'matched').length, missing: rows.filter(r => r.status === 'missing').length, conflict: rows.filter(r => r.status === 'conflict').length }
      this.sources = restored.sourcePaths.map(p => resolve(p).toLowerCase())
    }
    if (this.busy || !this.result?.matched) throw new Error('请先完成分析，至少需要一条已匹配物料')
    return applySupplementOverrides(this.result, input)
  }
  private async writeOutput(path: string, output: SupplementResult): Promise<void> {
    try {
      if (this.sources.includes(resolve(path).toLowerCase())) throw new Error('不能覆盖输入文件，请另存新文件')
      await writeSupplement(path, output)
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('文件已存在，请换一个新文件名；本流程不覆盖已有文件'); throw e }
  }
}
