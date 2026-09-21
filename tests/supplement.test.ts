import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('electron', () => ({ dialog: {} }))
import { writeSupplement, applySupplementOverrides, SupplementService } from '../src/main/modules/supplement/supplement-service'
import { SettingsRepository } from '../src/main/infrastructure/settings-repository'
import { analyzeSupplement, splitModel, readSheets, expandShellVariants } from '../src/main/modules/supplement/supplement-engine'
describe('supplement model boundaries', () => {
  it('adds silver only to eligible shells, preserves Y and avoids duplicates', () => {
    const cells = [
      { ref: 'B3', value: 'CASEBANG 出镜壳-X CZ00050 iP17 Pro（Y）' },
      { ref: 'C3', value: 'CASEBANG 出片壳-X CZ00051 iP17 Pro' },
      { ref: 'C4', value: 'CASEBANG 出片壳-X CZ00051 iP17 Pro（银框）' },
      { ref: 'D3', value: 'CASEBANG 磁吸背盖-X BG00050 iP17 Pro' },
      { ref: 'E3', value: 'CASEBANG 奇趣壳-X QQ00050 iP17 Pro' }
    ]
    const expanded = expandShellVariants(cells)
    expect(expanded.length).toBe(6)
    expect(expanded.filter(c => c.generated).map(c => c.value)).toEqual(['CASEBANG 出镜壳-X CZ00050 iP17 Pro（银框）（Y）'])
  })
  it('persists material master independently of existing base files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'casebang-master-settings-'))
    try {
      const file = join(dir, 'settings.json')
      const settings = new SettingsRepository(file)
      expect(await settings.getMaterialMasterPath()).toBeNull()
      await settings.setMaterialMasterPath('C:/example/master.xlsx')
      await settings.setLastMasterImageDirectory('C:/example/images')
      expect(await new SettingsRepository(file).getMaterialMasterPath()).toBe('C:/example/master.xlsx')
      expect(await settings.getBaseFilePaths()).toEqual({})
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it.each(['iP13 Pro', 'iP18 Pro/17 Pro', 'iP18 Pro Max/17 Pro Max', 'iP16e/17e', 'iP Fold（Duo）'])('recognizes %s', model => {
    expect(splitModel(`CASEBANG 出镜壳-X CZ00050 ${model}（银框）（Y）`)).toEqual({ base: 'CASEBANG 出镜壳-X CZ00050', model, variant: '（银框）（Y）' })
  })
  it('does not guess unknown suffixes', () => { expect(splitModel('CASEBANG 出镜壳-X CZ00050 iP18 Unknown')).toBeNull() })
  it('writes a shared-workbook staging file without opening a save dialog', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'casebang-supplement-shared-'))
    const result = {
      rows: [{ source: 'Sheet1!A2', batch: '测试批次', series: '测试系列', original: '原物料', model: 'iP18 Pro', variant: '', status: 'matched' as const, reason: '', reference: 'ref', values: ['图片', '', '', 'CASEBANG 测试物料 iP18 Pro', '99', 'US$19.99', '材质', '备注', '来源', '已匹配'] }],
      matched: 1, missing: 0, conflict: 0
    }
    try {
      const out = join(dir, 'shared.xlsx')
      await new SupplementService().exportTo(out, { draft: { sourcePaths: ['master.xlsx', 'input.xlsx'], result }, variants: [] })
      expect((await readSheets(out)).length).toBe(1)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it.runIf(process.env.CASEBANG_SUPPLEMENT_REAL === '1')('reads real files without writing sources', async () => {
    const root = 'C:/Users/Administrator/Desktop/CASEBANG 表格编码自动化/表格文件/'
    const result = await analyzeSupplement({ masterPath: root + 'CASEBANG 物料名称汇总-260908（含建议零售价）.xlsx', inputPath: root + '补Iphone18折叠屏系列-260826(1).xlsx', targetModel: 'iP Fold（Duo）' })
    console.log('SUPPLEMENT', result.rows.length, result.matched, result.missing, result.conflict)
    const inputSheets = await readSheets(root + '补Iphone18折叠屏系列-260826(1).xlsx')
    const originals = inputSheets.flatMap(s => s.cells).filter(c => /^CASEBANG/i.test(c.value.trim()) && splitModel(c.value))
    expect(result.rows.filter(r => !r.source.includes('·自动')).length).toBe(originals.length)
    expect(result.matched).toBeGreaterThan(89)
    expect(result.conflict).toBe(0)
    expect(result.matched).toBeGreaterThan(0)
    expect(result.rows.filter(r => r.status === 'matched').every(r => r.values[1] === '' && /^C\.K\.(?:BG|CA)\.(?:AP|SA|HW)\.[A-Z0-9]{1,8}\.[A-Z0-9]{2}$/.test(r.values[2]!) && r.values[3]!.includes('iP Fold（Duo）'))).toBe(true)
    const normal = result.rows.find(r => r.source === '出镜壳!B3')!
    const silver = result.rows.find(r => r.source === '出镜壳!B4' || r.source === '出镜壳!B3·自动银框')!
    expect(normal.values.slice(4, 7)).toEqual(['149', 'US$31.99', '银色片材'])
    expect(silver.values.slice(4, 7)).toEqual(['169', 'US$36.99', '银色片材'])
    expect(silver.values[3]).toContain('iP Fold（Duo）（银框）')
    const changed = applySupplementOverrides(result, { domesticPrice: '159', overseasPrice: '35.99', material: '测试材质' })
    expect(changed.rows.filter(r => r.status === 'matched').every(r => r.values[4] === '159' && r.values[5] === 'US$35.99')).toBe(true)
    expect(changed.rows.map(r => r.values[6])).toEqual(result.rows.map(r => r.values[6]))
    expect(normal.values[4]).toBe('149')
    const perVariant = applySupplementOverrides(result, { variants: [{ variant: '', domesticPrice: '150', material: '普通材质' }, { variant: '(银框)', domesticPrice: '180', overseasPrice: '40' }] })
    expect(perVariant.rows.find(r => r.source === '出镜壳!B3')!.values.slice(4, 7)).toEqual(['150', 'US$31.99', '银色片材'])
    expect(perVariant.rows.find(r => r.source === silver.source)!.values.slice(4, 7)).toEqual(['180', 'US$40', '银色片材'])
    expect(perVariant.rows.filter(r => r.variant.includes('银框') && r.variant.includes('Y') && r.status === 'matched').every(r => r.values[4] === '180' && r.values[5] === 'US$40')).toBe(true)
    expect(() => applySupplementOverrides(result, { variants: [{ variant: '(银框)' }, { variant: '（银框）' }] })).toThrow()
    expect(applySupplementOverrides(result, { material: '', domesticPrice: '', overseasPrice: '' })).toEqual(result)
    expect(() => applySupplementOverrides(result, { domesticPrice: '-1' })).toThrow()
    const dir = await mkdtemp(join(tmpdir(), 'casebang-supplement-test-'))
    try {
      const out = join(dir, 'output.xlsx')
      await writeSupplement(out, result)
      const sheets = await readSheets(out)
      expect(sheets.length).toBe(new Set(result.rows.map(r => r.batch)).size)
      expect(sheets.flatMap(s => s.cells).filter(c => c.value.includes('iP Fold（Duo）')).length).toBe(result.matched)
      await expect(writeSupplement(out, result)).rejects.toThrow()
    } finally { await rm(dir, { recursive: true, force: true }) }
  }, 60000)
})
