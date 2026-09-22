import { describe, expect, it } from 'vitest'
import { normalizeArtworkKey, parseArtworkFilename } from '../src/shared/artwork-comparison'

describe('artwork filename comparison structure', () => {
  it('uses 图片对应名称（大写） as the normalized pattern key', () => {
    const result = parseArtworkFilename('可拆卸手机背盖-苹果17PROMAX-透明片材-TSUMTSUMSERIES#J7系列#BG00733#CHARACTERCIRCLE.pdf')
    expect(result.productCode).toBe('BG00733')
    expect(result.normalizedPatternKey).toBe('CHARACTERCIRCLE')
    expect(result.category).toBe('可拆卸')
    expect(result.model).toBe('苹果17PROMAX')
    expect(result.material).toBe('透明片材')
    expect(result.series).toBe('TSUMTSUMSERIES#J7系列')
  })

  it('normalizes the workbook display name without treating punctuation as significant', () => {
    expect(normalizeArtworkKey('Character Circle')).toBe('CHARACTERCIRCLE')
    expect(normalizeArtworkKey('Bear & Pals')).toBe('BEARPALS')
  })
})

