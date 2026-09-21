import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import yazl from 'yazl'
import type { LifecycleDraft, LifecycleRow } from '../src/shared/lifecycle-contracts'
import { MATERIAL_MODELS, findMaterialModel } from '../src/shared/material-model-dictionary'
import { internalBarcodeCandidate, hasValidGtin13Checksum, parseMaterialIdentity, parsePhoneMaterialCode, parsePhoneMaterialCodePrefix, patternVariantKey, planMaterialPatterns, previewMaterialCodes } from '../src/shared/material-coding'
import { transitionWorkItem, type WorkItemState } from '../src/shared/lifecycle-workflow'
import { LifecycleRepository } from '../src/main/modules/lifecycle/lifecycle-repository'
import { readLifecycleWorkbook } from '../src/main/modules/lifecycle/workbook-reader'
import { inspectBarcodeSequence, inspectMaterialMappingRows, writeLifecycleCells } from '../src/main/modules/lifecycle/workbook-allocator'
import { findPackageText, readOoxmlPackage } from '../src/main/modules/spreadsheet/ooxml-package'

const temporary: string[] = []
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }) })
async function directory(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 'casebang-lifecycle-test-')); temporary.push(path); return path }
function row(model = 'iP14 Pro', frame = '', code = '', pattern = 'Bear BG00736'): LifecycleRow {
  const materialName = `CASEBANG 出镜壳-Tsumtsum Series#J7系列-${pattern} ${model}${frame}`
  return { id: randomUUID(), sheet: '条码', row: 2, nameAddress: 'D2', barcodeAddress: 'B2', materialCodeAddress: 'C2', itemClass: '一体壳', materialName,
    barcode: '', materialCode: code, material: '', domesticPrice: '', overseasPrice: '', remark: '', identity: parseMaterialIdentity(materialName, '一体壳'), issues: [] }
}
function draft(rows: LifecycleRow[]): LifecycleDraft { return { id: randomUUID(), title: '测试.xlsx', source: 'manual', sourcePath: 'local.xlsx', sourceHash: 'a'.repeat(64), createdAt: new Date().toISOString(), version: 1, rows, warnings: [], barcodeSource: null, patternVariants: {} } }

describe('material coding preparation', () => {
  it('retains all 45 confirmed two-digit model mappings and exact aliases', () => {
    expect(MATERIAL_MODELS).toHaveLength(45)
    expect(new Set(MATERIAL_MODELS.map(model => model.code)).size).toBe(45)
    for (const model of MATERIAL_MODELS) expect(findMaterialModel(model.name)).toEqual(model)
    expect(findMaterialModel('iP18 Pro Max/17 Pro Max')?.code).toBe('75')
    expect(findMaterialModel('HW Mate 90 RS')?.code).toBe('16')
    expect(findMaterialModel('HW PX VIEW')?.code).toBe('15')
    expect(findMaterialModel('未知机型')).toBeNull()
    expect(findMaterialModel('PX Max')).toBeNull()
  })
  it('matches complete model suffixes and keeps frame and Y distinctions', () => {
    expect(row('iP17 Pro Max').identity).toMatchObject({ modelCode: '75', patternName: 'Bear', productCode: 'BG00736', brand: 'AP' })
    expect(row('HW PX View', '（银框）（Y）').identity).toMatchObject({ modelCode: '15', frame: 'silver', variant: 'Y', brand: 'HW' })
    expect(row('iP14 Pro', '', '', 'Little Bear').identity.patternName).toBe('Little Bear')
    expect(parseMaterialIdentity('CASEBANG 磁吸气囊支架-Tsumtsum Series#J7系列-Bear', '支架').domain).toBeNull()
  })
  it('uses a managed model mapping when parsing downstream material names', () => {
    const identity = parseMaterialIdentity(
      'CASEBANG 出镜壳-Tsumtsum Series#J7系列-Bear BG00736 iP Future Pro',
      '一体壳',
      [{ brand: 'AP', code: '98', name: 'iP Future Pro', aliases: ['Future Pro'] }]
    )
    expect(identity).toMatchObject({ brand: 'AP', modelName: 'iP Future Pro', modelCode: '98' })
  })
  it('parses entire two-character variant, never consumes model code as variant', () => {
    expect(parsePhoneMaterialCode('C.K.CA.AP.J7.AC57')).toMatchObject({ patternVariant: 'AC', modelCode: '57' })
    expect(parsePhoneMaterialCode('C.K.CA.AP.J7.A057')).toMatchObject({ patternVariant: 'A0', modelCode: '57' })
    expect(parsePhoneMaterialCode('C.K.CT.AP.J7.A057')).toBeNull()
  })
  it('reuses confirmed same-file mapping across models but not across frame variants', () => {
    const normal = row('iP14 Pro', '', 'C.K.CA.AP.J7.A057')
    const other = row('iP17 Pro')
    const silver = row('iP17 Pro', '（银框）')
    const result = previewMaterialCodes(draft([normal, other, silver]))
    expect(result[0]?.status).toBe('existing')
    expect(result[1]).toMatchObject({ candidate: 'C.K.CA.AP.J7.A074', status: 'candidate' })
    expect(result[2]).toMatchObject({ candidate: null, status: 'blocked' })
  })
  it('blocks inconsistent historical mappings, manual overrides, and duplicate candidate codes', () => {
    const first = row('iP14 Pro', '', 'C.K.CA.AP.J7.A057')
    const second = row('iP17 Pro', '', 'C.K.CA.AP.J7.B074')
    expect(previewMaterialCodes(draft([first, second])).every(result => result.status === 'blocked')).toBe(true)
    const value = draft([first]); value.patternVariants[patternVariantKey(first.identity)] = 'ZZ'
    expect(previewMaterialCodes(value)[0]?.issues.join()).toContain('冲突')
    const duplicate = draft([row(), row()]); duplicate.patternVariants[patternVariantKey(duplicate.rows[0]!.identity)] = 'A0'
    expect(previewMaterialCodes(duplicate).every(result => result.status === 'blocked' && result.issues.join().includes('重复'))).toBe(true)
  })
  it('preserves unsupported existing codes and blocks unknown models instead of guessing', () => {
    expect(previewMaterialCodes(draft([row('iP14 Pro', '', 'C.K.CT.AP.J7.A057')]))[0]).toMatchObject({ candidate: 'C.K.CT.AP.J7.A057', status: 'blocked' })
    expect(previewMaterialCodes(draft([row('Unknown Phone')]))[0]?.status).toBe('blocked')
  })
  it('reuses master mappings and proposes unused A0/B0 pattern starts with an iP13 Pro preview', () => {
    const existing = row('iP14 Pro', '', 'C.K.CA.AP.J7.A057', 'Bear BG00736')
    const samePattern = row('iP15 Pro', '', '', 'Bear BG00736')
    const newPattern = row('iP13 Pro', '', '', 'Rabbit BG00737')
    const plan = planMaterialPatterns([samePattern, newPattern], [existing], {})
    expect(plan.patternVariants[patternVariantKey(samePattern.identity)]).toBe('A0')
    expect(plan.patternVariants[patternVariantKey(newPattern.identity)]).toBe('B0')
    expect(plan.plans[0]).toMatchObject({ source: 'master', referenceCode: 'C.K.CA.AP.J7.A053' })
    expect(plan.plans[1]).toMatchObject({ source: 'proposed', referenceCode: 'C.K.CA.AP.J7.B053' })
  })
  it('keeps a new silver-frame pattern blocked until its two-character marker is confirmed', () => {
    const silver = row('iP13 Pro', '（银框）', '', 'Rabbit BG00737')
    const blocked = planMaterialPatterns([silver], [], {})
    expect(blocked.patternVariants).toEqual({})
    expect(blocked.plans[0]).toMatchObject({ source: 'blocked', referenceCode: 'C.K.CA.AP.J7.__53' })
    const manual = planMaterialPatterns([silver], [], { [patternVariantKey(silver.identity)]: 'AC' })
    expect(manual.patternVariants[patternVariantKey(silver.identity)]).toBe('AC')
    expect(manual.plans[0]).toMatchObject({ source: 'manual', referenceCode: 'C.K.CA.AP.J7.AC53' })
  })
  it('pairs 出镜壳 and 出彩壳 silver markers from the same normal pattern', () => {
    const normal = row('iP13 Pro', '', '', 'Rabbit BG00737')
    const silver = row('iP13 Pro', '（银框）', '', 'Rabbit BG00737')
    const plan = planMaterialPatterns([silver, normal], [], {}, 'new-series')
    expect(plan.patternVariants[patternVariantKey(normal.identity)]).toBe('A0')
    expect(plan.patternVariants[patternVariantKey(silver.identity)]).toBe('AC')
    expect(plan.plans.find(item => item.key === patternVariantKey(silver.identity))).toMatchObject({ detectedVariant: 'AC', referenceCode: 'C.K.CA.AP.J7.AC53' })
    const colorNormal = row('iP13 Pro', '', '', 'Color BG00738')
    colorNormal.materialName = colorNormal.materialName.replace('出镜壳', '出彩壳')
    colorNormal.identity = parseMaterialIdentity(colorNormal.materialName, colorNormal.itemClass)
    const colorSilver = { ...colorNormal, id: randomUUID(), materialName: `${colorNormal.materialName}（银框）` }
    colorSilver.identity = parseMaterialIdentity(colorSilver.materialName, colorSilver.itemClass)
    const colorPlan = planMaterialPatterns([colorNormal, colorSilver], [], {}, 'new-series')
    expect(colorPlan.patternVariants[patternVariantKey(colorSilver.identity)]).toBe('AC')
  })
  it.each([['A0', 'AC'], ['B0', 'BC'], ['C0', 'CC'], ['D0', 'DC']])('pairs confirmed normal marker %s with silver marker %s', (normalMarker, silverMarker) => {
    const master = row('iP13 Pro', '', `C.K.CA.AP.J7.${normalMarker}53`, `Pattern-${normalMarker} BG00736`)
    const silver = row('iP13 Pro', '（银框）', '', `Pattern-${normalMarker} BG00736`)
    const plan = planMaterialPatterns([silver], [master], {}, 'new-products')
    expect(plan.patternVariants[patternVariantKey(silver.identity)]).toBe(silverMarker)
  })
  it('applies post-recognition overrides by pattern group and rejects occupied markers', () => {
    const existing = row('iP14 Pro', '', 'C.K.CA.AP.J7.A057', 'Bear BG00736')
    const rabbit = row('iP13 Pro', '', '', 'Rabbit BG00737')
    const key = patternVariantKey(rabbit.identity)
    const automatic = planMaterialPatterns([rabbit], [existing], {}, 'new-products')
    expect(automatic.plans[0]).toMatchObject({ detectedVariant: 'B0', variant: 'B0', customized: false })
    const customized = planMaterialPatterns([rabbit], [existing], { [key]: 'H0' }, 'new-products')
    expect(customized.patternVariants[key]).toBe('H0')
    expect(customized.plans[0]).toMatchObject({ detectedVariant: 'B0', variant: 'H0', source: 'manual', customized: true })
    const conflict = planMaterialPatterns([rabbit], [existing], { [key]: 'A0' }, 'new-products')
    expect(conflict.patternVariants[key]).toBeUndefined()
    expect(conflict.plans[0]?.issues.join()).toContain('占用')
  })
  it('keeps the historical prefix for new-model work and only appends the mapped model code', () => {
    const target = row('iP18 Pro Max/17 Pro Max', ''); target.materialCode = 'C.K.CA.AP.J7.BQ'
    expect(parsePhoneMaterialCodePrefix(target.materialCode)).toMatchObject({ patternVariant: 'BQ' })
    const plan = planMaterialPatterns([target], [], {}, 'new-models')
    expect(plan.plans[0]).toMatchObject({ detectedVariant: 'BQ', variant: 'BQ', customized: false })
    expect(previewMaterialCodes({ rows: [target], patternVariants: plan.patternVariants, sourceWorkflow: 'new-models' })[0]).toMatchObject({
      candidate: 'C.K.CA.AP.J7.BQ75', status: 'candidate'
    })
    const forbidden = planMaterialPatterns([target], [], { [patternVariantKey(target.identity)]: 'ZZ' }, 'new-models')
    expect(forbidden.plans[0]?.issues.join()).toContain('不允许修改')
  })
  it('separates internal monthly numbers from GTIN validation and checks sequence bounds', () => {
    expect(internalBarcodeCandidate('202609', 1)).toBe('2026090000001')
    expect(() => internalBarcodeCandidate('202613', 1)).toThrow()
    expect(() => internalBarcodeCandidate('202609', 10_000_000)).toThrow()
    expect(() => internalBarcodeCandidate('202609', 0)).toThrow()
    expect(hasValidGtin13Checksum('4006381333931')).toBe(true)
    expect(hasValidGtin13Checksum('4006381333932')).toBe(false)
    // Internal numbers may coincidentally pass the checksum; never infer platform source.
    expect(hasValidGtin13Checksum('2026090000001')).toBe(true)
    expect(hasValidGtin13Checksum('2026090000002')).toBe(false)
  })
})

describe('local preparation database', () => {
  it('persists drafts, deduplicates exact files, and rejects stale saves without overwriting', async () => {
    const path = join(await directory(), 'preparation.sqlite')
    const repo = new LifecycleRepository(path)
    const original = draft([row()])
    try {
      expect(repo.insert(original).id).toBe(original.id)
      expect(repo.insert({ ...original, id: randomUUID() }).id).toBe(original.id)
      expect(repo.list()).toHaveLength(1)
      expect(repo.save(original.id, 1, 'internal_monthly', {}).version).toBe(2)
      expect(() => repo.save(original.id, 1, 'platform', {})).toThrow('草稿已更新')
      expect(repo.get(original.id).barcodeSource).toBe('internal_monthly')
    } finally { repo.close() }
    const reopened = new LifecycleRepository(path)
    try { expect(reopened.get(original.id).version).toBe(2) } finally { reopened.close() }
  })
})

describe('server transition guards', () => {
  const item: WorkItemState = { tenantId: 'org', originId: 'author', assigneeId: 'processor', state: 'DRAFT', version: 1, revision: 1 }
  const command = { tenantId: 'org', actorId: 'author', expectedVersion: 1, revision: 1, action: 'submit' as const }
  it('requires verified file, same organization, current revision and the responsible actor', () => {
    expect(() => transitionWorkItem(item, command, {})).toThrow('工作簿')
    expect(() => transitionWorkItem(item, { ...command, tenantId: 'other' }, { fileVerified: true })).toThrow('企业')
    expect(() => transitionWorkItem(item, { ...command, actorId: 'other' }, { fileVerified: true })).toThrow('责任人')
    expect(() => transitionWorkItem(item, { ...command, revision: 2 }, { fileVerified: true })).toThrow('版本')
    expect(transitionWorkItem(item, command, { fileVerified: true })).toMatchObject({ state: 'PENDING_PROCESSING', version: 2 })
  })
  it('allows one account to test both workflow sides after switching business tools', () => {
    const singleAccount = { ...item, originId: 'tester', assigneeId: 'tester' }
    const submitted = transitionWorkItem(singleAccount, { ...command, actorId: 'tester' }, { fileVerified: true })
    expect(submitted.state).toBe('PENDING_PROCESSING')
    const claimed = transitionWorkItem(submitted, {
      ...command, actorId: 'tester', action: 'claim', expectedVersion: submitted.version
    }, {})
    expect(claimed.state).toBe('PROCESSING')
  })
  it('prevents passing unfinished artwork and requires a reason for returns', () => {
    const processing = { ...item, state: 'PROCESSING' as const }
    expect(() => transitionWorkItem(processing, { ...command, actorId: 'processor', action: 'return-origin' }, { codesVerified: true })).toThrow('图档')
    expect(() => transitionWorkItem(processing, { ...command, actorId: 'processor', action: 'return-source' }, {})).toThrow('原因')
  })
  it('can complete only with a server-verified online readback', () => {
    const syncing = { ...item, state: 'SYNCING' as const }
    expect(() => transitionWorkItem(syncing, { ...command, action: 'sync-verified' }, { serviceActor: true })).toThrow('回读')
    expect(() => transitionWorkItem(syncing, { ...command, action: 'sync-verified' }, { remoteReadbackVerified: true })).toThrow('责任人')
    expect(transitionWorkItem(syncing, { ...command, action: 'sync-verified' }, { serviceActor: true, remoteReadbackVerified: true }).state).toBe('COMPLETED')
  })
})

function cell(address: string, value: string): string { return `<c r="${address}" t="inlineStr"><is><t>${value.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</t></is></c>` }
async function workbook(sheetXml: string): Promise<string> {
  const path = join(await directory(), 'fixture.xlsx')
  const zip = new yazl.ZipFile()
  zip.addBuffer(Buffer.from('<workbook xmlns:r="urn:relationships"><sheets><sheet name="条码306" sheetId="1" r:id="rId1"/></sheets></workbook>'), 'xl/workbook.xml')
  zip.addBuffer(Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'), 'xl/_rels/workbook.xml.rels')
  zip.addBuffer(Buffer.from(sheetXml), 'xl/worksheets/sheet1.xml')
  const finished = pipeline(zip.outputStream, createWriteStream(path)); zip.end(); await finished
  return path
}
describe('workbook import coverage', () => {
  it('uses headers rather than sheet names or dimensions, keeps missing data, and ignores helper-only rows', async () => {
    const headers = ['类目', '69码', '物料编码（工厂）', '物料名称', '建议零售价', '海外零售价', '材质', '备注（IP）']
    const sheet = `<worksheet><dimension ref="A1"/><sheetData><row r="1">${headers.map((value, index) => cell(`${String.fromCharCode(65 + index)}1`, value)).join('')}</row>
      <row r="2">${cell('A2', '一体壳')}${cell('B2', '0123456789012')}${cell('D2', row().materialName)}</row>
      <row r="3">${cell('B3', '2026090000001')}</row>
      <row r="4">${cell('K4', 'iP17 Pro 辅助信息')}</row>
      <row r="5">${cell('A5', '一体壳')}${cell('D5', row('iP17 Pro').materialName)}<c r="B5"><f>1+1</f><v>2</v></c></row>
      </sheetData></worksheet>`
    const parsed = await readLifecycleWorkbook(await workbook(sheet))
    expect(parsed.rows.map(value => value.row)).toEqual([2, 3, 5])
    expect(parsed.rows[0]).toMatchObject({ sheet: '条码306', barcode: '0123456789012', materialCodeAddress: 'C2' })
    expect(parsed.rows[1]?.issues.join()).toContain('名称缺失')
    expect(parsed.rows[2]?.issues.join()).toContain('含公式')
  })
  it('rejects missing business headers and declared XML entities', async () => {
    await expect(readLifecycleWorkbook(await workbook('<worksheet><sheetData/></worksheet>'))).rejects.toThrow('业务表头')
    await expect(readLifecycleWorkbook(await workbook('<!DOCTYPE worksheet><worksheet/>'))).rejects.toThrow('实体声明')
  })
  it('reads material-code mappings from a master without importing it as a task', async () => {
    const sheet = `<worksheet><sheetData><row r="1">${cell('A1', '类目')}${cell('C1', '物料编码（工厂）')}${cell('D1', '物料名称')}</row>
      <row r="2">${cell('A2', '一体壳')}${cell('C2', 'C.K.CA.AP.J7.A057')}${cell('D2', row('iP14 Pro').materialName)}</row></sheetData></worksheet>`
    const mappings = await inspectMaterialMappingRows(await workbook(sheet))
    expect(mappings).toHaveLength(1)
    expect(mappings[0]).toMatchObject({ materialCode: 'C.K.CA.AP.J7.A057', itemClass: '一体壳' })
  })
})

describe('shared workbook allocation writes', () => {
  it('continues the selected month by its greatest used sequence and ignores other formats', async () => {
    const headers = ['类目', '69码', '物料编码（工厂）', '物料名称']
    const sheet = `<worksheet><sheetData><row r="1">${headers.map((value, index) => cell(`${String.fromCharCode(65 + index)}1`, value)).join('')}</row>
      <row r="2">${cell('B2', '2026090000616')}</row>
      <row r="3">${cell('B3', '8800000000001')}</row>
      <row r="4">${cell('B4', '2026090000602')}</row>
      <row r="5">${cell('B5', '2026100000009')}</row></sheetData></worksheet>`
    const result = await inspectBarcodeSequence(await workbook(sheet), '202609')
    expect(result).toMatchObject({ previousCode: '2026090000616', maximumSequence: 616 })
  })

  it('writes only requested cells while preserving the surrounding worksheet', async () => {
    const source = await workbook(`<worksheet><sheetData><row r="1">${cell('B1', '69码')}${cell('C1', '物料编码')}</row><row r="2">${cell('D2', '保留内容')}</row></sheetData></worksheet>`)
    const destination = join(await directory(), 'allocated.xlsx')
    await writeLifecycleCells(source, destination, new Map([['条码306', [
      { address: 'B2', value: '2026090000617' }, { address: 'C2', value: 'C.K.CA.AP.J4.BQ75' }
    ]]]))
    const xml = findPackageText(await readOoxmlPackage(destination), 'xl/worksheets/sheet1.xml') ?? ''
    expect(xml).toContain('2026090000617')
    expect(xml).toContain('C.K.CA.AP.J4.BQ75')
    expect(xml).toContain('保留内容')
    expect(xml.indexOf('r="B2"')).toBeLessThan(xml.indexOf('r="C2"'))
    expect(xml.indexOf('r="C2"')).toBeLessThan(xml.indexOf('r="D2"'))
  })
})
