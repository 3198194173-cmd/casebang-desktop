import { describe, expect, it } from 'vitest'
import { analyzeSupplement, readSheets, validateTargetModel } from '../src/main/modules/supplement/supplement-engine'

describe('supplement destination model is independent from master lookup', () => {
  it.each(['HW PX VIEW', 'iP Fold（Duo）', 'Brand Future Model 2030', '华为新机型', 'iP18 Pro'])('accepts a new destination %s', value => expect(validateTargetModel(value)).toBe(value))
  it('trims surrounding spaces, rejects blank/control input and separate variants', () => {
    expect(validateTargetModel(' HW PX VIEW ')).toBe('HW PX VIEW')
    for (const value of ['', '   ', 'HW\nPX', 'HW PX VIEW（银框）', 'HW PX VIEW（Y）']) expect(() => validateTargetModel(value)).toThrow()
  })
  it.runIf(process.env.CASEBANG_PXV_REAL === '1')('matches the supplied PXV workbook without requiring the destination in master', async () => {
    const root = 'C:/Users/Administrator/Desktop/CASEBANG 表格编码自动化/表格文件/'
    const request = { masterPath: root + 'CASEBANG 物料名称汇总-260908（含建议零售价）.xlsx', inputPath: root + '补PXV系列.xlsx', targetModel: 'HW PX VIEW' }
    const sheets = await readSheets(request.inputPath)
    console.log('PXV_INPUT', sheets.map(s => ({ sheet: s.name, samples: s.cells.filter(c => /^CASEBANG/i.test(c.value)).slice(0, 3) })))
    const actual = await analyzeSupplement(request)
    console.log('PXV_ADDITIONAL', actual.rows.filter(r => Number(r.source.match(/!(?:[A-Z]+)(\d+)/)?.[1]) >= 22).map(r => ({ source: r.source, original: r.original, status: r.status, reason: r.reason })))
    const other = await analyzeSupplement({ ...request, targetModel: 'Future Brand Model 2099' })
    expect(actual.matched).toBeGreaterThan(0)
    expect(actual.rows.map(r => [r.source, r.status, r.reference])).toEqual(other.rows.map(r => [r.source, r.status, r.reference]))
    for (const row of actual.rows.filter(r => r.status === 'matched')) {
      expect(row.values[3]).toContain(' HW PX VIEW' + row.variant)
      expect(row.values[1]).toBe(''); expect(row.values[2]).toBe('')
    }
    console.log('PXV_RESULT', { total: actual.rows.length, matched: actual.matched, missing: actual.missing, conflict: actual.conflict, examples: actual.rows.filter(r => r.status === 'matched').slice(0, 2).map(r => ({ source: r.source, original: r.original, generated: r.values[3] })), unmatched: actual.rows.filter(r => r.status !== 'matched').slice(0, 5).map(r => ({ source: r.source, reason: r.reason })) })
  }, 60000)
})
