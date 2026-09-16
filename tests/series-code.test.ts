import { describe, expect, it } from 'vitest'
import { buildSeriesCodeReservePlan, nextSeriesCode, resolveNextSeriesRecord } from '../src/shared/series-code'

describe('series code reserve plan', () => {
  it('keeps the legacy sequence through K9 and L0', () => {
    expect(nextSeriesCode('I9')).toBe('J0')
    expect(nextSeriesCode('K9')).toBe('L0')
  })

  it('extends the namespace after Z9', () => {
    expect(nextSeriesCode('Z9')).toBe('A10')
    expect(nextSeriesCode('A99')).toBe('B10')
    expect(nextSeriesCode('Z99')).toBe('A100')
  })

  it('supplements ten free codes after K1 and exposes exact worksheet addresses', () => {
    const rows = [
      { row: 102, values: ['K0', 'Signature Series', '签名系列', ''] },
      { row: 103, values: ['K1', 'Cat Series', '猫猫', ''] },
      ...Array.from({ length: 8 }, (_, index) => ({ row: 104 + index, values: [`K${index + 2}`, '', '', ''] }))
    ]
    const plan = buildSeriesCodeReservePlan(rows, 'K1')
    expect(plan.availableReserveCodes).toEqual(['K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'K8', 'K9'])
    expect(plan.supplementWrites).toEqual([
      { row: 112, address: 'A112', code: 'L0' },
      { row: 113, address: 'A113', code: 'L1' }
    ])
  })

  it('always appends after the last filled record even when the English name already exists', () => {
    const rows = [
      { row: 102, values: ['K0', 'Cat Series', '旧中文名', ''] },
      { row: 103, values: ['K1', 'Another Series', '另一个系列', ''] },
      { row: 104, values: ['K2', '', '', ''] },
      { row: 105, values: ['K3', '', '', ''] }
    ]
    expect(resolveNextSeriesRecord(rows)).toEqual({ code: 'K2', row: 104, usedCodes: ['K0', 'K1'] })
  })
})
