import { describe, expect, it } from 'vitest'
import {
  FRAME_REFERENCE_SOURCE, FRAME_REFERENCE_STATISTICS, referenceFrameFallbackPrice,
  referenceFrameModel, referenceFrameModels, referenceFramePrice
} from '../src/shared/frame-product-reference'

describe('A条码参考-260928 frame reference catalogue', () => {
  it('records the six source sheets and their 799 conflict-free material rows', () => {
    expect(FRAME_REFERENCE_SOURCE.fileName).toBe('A条码参考-260928.xlsx')
    expect(FRAME_REFERENCE_SOURCE.sheets).toEqual(['出镜壳', '出镜壳3个', '出镜壳 2个', '出镜壳 1个', '出片壳', '出片壳 3个'])
    expect(Object.values(FRAME_REFERENCE_SOURCE.rowsBySheet).reduce((sum, sheet) => sum + sheet.normal + sheet.silver, 0)).toBe(799)
    expect(FRAME_REFERENCE_SOURCE.analysedRowCount).toBe(799)
    expect(FRAME_REFERENCE_SOURCE.conflictingPriceCount).toBe(0)
    expect(FRAME_REFERENCE_SOURCE.modelColumn).toBe('D')
    expect([FRAME_REFERENCE_SOURCE.domesticPriceColumn, FRAME_REFERENCE_SOURCE.overseasPriceColumn]).toEqual(['E', 'F'])
  })

  it('keeps exactly 51 mirror black models, 17 print black models and their 10 silver models', () => {
    const mirror = referenceFrameModels('出镜壳')!
    const print = referenceFrameModels('出片壳')!
    expect(mirror).toHaveLength(51)
    expect(print).toHaveLength(17)
    expect(mirror.filter((entry) => entry.silver)).toHaveLength(10)
    expect(print.filter((entry) => entry.silver).map((entry) => entry.name)).toEqual([
      'iP14 Pro', 'iP14 Pro Max', 'iP15 Pro', 'iP15 Pro Max', 'iP16 Pro', 'iP16 Pro Max',
      'iP17', 'iP17 Air', 'iP18 Pro/17 Pro', 'iP18 Pro Max/17 Pro Max'
    ])
    expect(mirror.filter((entry) => entry.silver).map((entry) => entry.name)).toEqual(print.filter((entry) => entry.silver).map((entry) => entry.name))
    expect(print.every((entry) => entry.brand === 'apple')).toBe(true)
    expect(mirror.reduce<Record<string, number>>((counts, entry) => ({ ...counts, [entry.brand]: (counts[entry.brand] ?? 0) + 1 }), {}))
      .toEqual({ apple: 17, other: 23, huawei: 7, samsung: 4 })
    expect(mirror.some((entry) => entry.name === 'iP15 Plus')).toBe(false)
    expect(mirror.some((entry) => entry.name === 'VV x200 U')).toBe(false)
  })

  it('matches the actual price groups including three higher-priced Huawei models', () => {
    const mirror = referenceFrameModels('出镜壳')!
    expect(mirror.filter((entry) => entry.normal.domestic === 149 && entry.normal.overseas === 31.99)).toHaveLength(20)
    expect(mirror.filter((entry) => entry.normal.domestic === 129 && entry.normal.overseas === 28.99)).toHaveLength(31)
    expect(mirror.filter((entry) => entry.silver).every((entry) => entry.silver!.domestic === 169 && entry.silver!.overseas === 36.99)).toBe(true)
    expect(referenceFrameModels('出片壳')!.every((entry) => entry.normal.domestic === 149 && entry.normal.overseas === 31.99)).toBe(true)
    for (const name of ['HW PX View', 'HW Mate 90/90 Pro', 'HW Mate 90 Pro Max']) {
      expect(referenceFramePrice('出镜壳', name, 'normal')).toEqual({ domestic: 149, overseas: 31.99 })
    }
    for (const name of ['HW Mate 70', 'HW Mate 70 Pro', 'HW Mate 70 RS', 'HW Mate X6']) {
      expect(referenceFramePrice('出镜壳', name, 'normal')).toEqual({ domestic: 129, overseas: 28.99 })
    }
    expect(FRAME_REFERENCE_STATISTICS['出镜壳'].normalPriceGroups.map((group) => group.modelCount)).toEqual([20, 31])
    expect(FRAME_REFERENCE_STATISTICS['出片壳'].normalPriceGroups[0]?.modelCount).toBe(17)
  })

  it('includes the actual rows omitted by the side lists without inventing separate U variants', () => {
    const mirror = referenceFrameModels('出镜壳')!.map((entry) => entry.name)
    expect(mirror).toEqual(expect.arrayContaining(['iP Fold（Duo）', 'HW PX View', 'HW Mate 90/90 Pro', 'HW Mate 90 Pro Max', 'VV x200 Ultra']))
    expect(referenceFrameModels('出片壳')!.map((entry) => entry.name)).toContain('iP Fold（Duo）')
    expect(referenceFrameModel('出镜壳', 'VV x200 U')?.name).toBe('VV x200 Ultra')
    expect(referenceFrameModel('出镜壳', 'Vivo x200 Ultra')?.name).toBe('VV x200 Ultra')
  })

  it('matches category aliases, normalized spacing and explicitly equivalent names safely', () => {
    expect(referenceFrameModels('出片材')).toBe(referenceFrameModels('出片壳'))
    expect(referenceFrameModels('出镜壳3个')).toBe(referenceFrameModels('出镜壳'))
    expect(referenceFramePrice('出片材', ' ｉＰ１４　Ｐｒｏ ', 'silver')).toEqual({ domestic: 169, overseas: 36.99 })
    expect(referenceFrameModel('出片壳', 'iP Fold (Duo)')?.name).toBe('iP Fold（Duo）')
    expect(referenceFrameModel('出镜壳', 'Mate70Pro')?.name).toBe('HW Mate 70 Pro')
    expect(referenceFrameModel('出镜壳', 'Huawei Mate 70 Pro')?.brand).toBe('huawei')
    expect(referenceFrameModel('出镜壳', 'iP17 Pro')?.name).toBe('iP18 Pro/17 Pro')
    expect(referenceFrameModel('出镜壳', 'Mate 70 Pro/Pro+')).toBeUndefined()
    expect(referenceFramePrice('出镜壳', 'Unknown model', 'normal')).toBeUndefined()
    expect(referenceFramePrice('出镜壳', 'HW Mate 70', 'silver')).toBeUndefined()
    expect(referenceFramePrice('出片壳', 'SAM S25', 'normal')).toBeUndefined()
    expect(referenceFrameModels('磁吸背盖')).toBeNull()
  })

  it('keeps source records immutable and returns independent editable fallback price copies', () => {
    const source = referenceFrameModels('出镜壳')!
    expect(Object.isFrozen(source)).toBe(true)
    expect(Object.isFrozen(source[0])).toBe(true)
    expect(Object.isFrozen(source[0]?.normal)).toBe(true)
    expect(Object.isFrozen(referenceFrameModel('出镜壳', 'HW Mate 70')?.aliases)).toBe(true)
    const price = referenceFramePrice('出镜壳', 'HW Mate 70', 'normal')!
    price.domestic = 1
    expect(referenceFramePrice('出镜壳', 'HW Mate 70', 'normal')).toEqual({ domestic: 129, overseas: 28.99 })
    const fallback = referenceFrameFallbackPrice('出镜壳', 'normal')
    fallback.overseas = 1
    expect(referenceFrameFallbackPrice('出片壳', 'normal')).toEqual({ domestic: 149, overseas: 31.99 })
    expect(referenceFrameFallbackPrice('出片壳', 'silver')).toEqual({ domestic: 169, overseas: 36.99 })
  })
})
