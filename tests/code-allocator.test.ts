import { describe, expect, it } from 'vitest'
import { allocateCodes } from '../src/main/modules/coding/code-allocator'
import { buildEncodingPreviewFromWorkbook } from '../src/main/modules/coding/encoding-preview-builder'
import { resolve } from 'node:path'

describe('code allocator', () => {
  it('fills unused numeric positions instead of assuming a continuous history', () => {
    const result = allocateCodes({
      prefix: 'ZJBG',
      count: 3,
      usedCodes: ['ZJBG00001', 'ZJBG00003'],
      minimumNumber: 1
    })
    expect(result.codes).toEqual(['ZJBG00002', 'ZJBG00004', 'ZJBG00005'])
  })

  it('shares one numeric pool between ZJBG and ZJQN', () => {
    const result = allocateCodes({
      prefix: 'ZJQN',
      sharedPrefixes: ['ZJBG'],
      count: 2,
      usedCodes: ['ZJBG00329', 'ZJQN00330'],
      minimumNumber: 329
    })
    expect(result.codes).toEqual(['ZJQN00331', 'ZJQN00332'])
  })

  it('maps both stand product types to their own workbook columns', async () => {
    const workbook = resolve(__dirname, '..', '..', '表格文件', 'A条码参考-260116(1).xlsx')
    const preview = await buildEncodingPreviewFromWorkbook(workbook, {
      seriesNameZh: '导出回归测试',
      seriesNameEn: 'Export Regression Test Series',
      crops: [
        { cropId: 'back-stand', productCategory: '磁吸支架背盖', patternGroupId: 'stand-pair', patternNameEn: 'Test Pattern' },
        { cropId: 'airbag-stand', productCategory: '磁吸气囊支架', patternGroupId: 'stand-pair', patternNameEn: 'Test Pattern' }
      ]
    })
    const backStand = preview.rows.find((row) => row.cropId === 'back-stand')
    const airbagStand = preview.rows.find((row) => row.cropId === 'airbag-stand')
    expect(backStand).toMatchObject({ poolColumn: 'D', prefix: 'ZJBG', status: 'ready' })
    expect(airbagStand).toMatchObject({ poolColumn: 'E', prefix: 'ZJQN', status: 'ready' })
    expect(backStand?.productCode.slice(-5)).toBe(airbagStand?.productCode.slice(-5))
  })

  it('reads every populated cell after empty cells and continues past all existing lens-film codes', async () => {
    const workbook = resolve(__dirname, '..', '..', '表格文件', 'A条码参考-260116(1).xlsx')
    const preview = await buildEncodingPreviewFromWorkbook(workbook, {
      seriesNameZh: '镜头膜回归测试',
      seriesNameEn: 'Lens Film Regression Series',
      crops: [
        { cropId: 'lens-film-1', productCategory: '镜头膜', patternGroupId: null, patternNameEn: 'Pattern One' },
        { cropId: 'lens-film-2', productCategory: '镜头膜', patternGroupId: null, patternNameEn: 'Pattern Two' }
      ]
    })
    const lensPool = preview.pools.find((pool) => pool.column === 'P')
    expect(lensPool?.usedCodes).toEqual(expect.arrayContaining(['PCM00001', 'PCM00002']))
    expect(lensPool?.latestCode).toBe('PCM00002')
    expect(preview.rows.map((row) => row.productCode)).toEqual(['PCM00003', 'PCM00004'])
    expect(preview.rows.every((row) => row.status === 'ready')).toBe(true)
  })
})
