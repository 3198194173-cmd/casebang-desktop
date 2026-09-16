import { describe, expect, it } from 'vitest'
import { normalizePatternName, validateUniquePatternNames } from '../src/main/modules/naming/name-validator'

describe('pattern name validation', () => {
  it('normalizes case, spaces and punctuation', () => {
    expect(normalizePatternName(' Mint-Dot ')).toBe('mintdot')
    expect(normalizePatternName('MINT DOT')).toBe('mintdot')
  })

  it('blocks duplicate names in one series', () => {
    const result = validateUniquePatternNames([
      { patternId: 'P01', englishName: 'Mint Dot' },
      { patternId: 'P02', englishName: 'MINT-DOT' }
    ])
    expect(result.valid).toBe(false)
    expect(result.issues[0]?.severity).toBe('error')
  })

  it('warns about singular and plural near-duplicates', () => {
    const result = validateUniquePatternNames([
      { patternId: 'P01', englishName: 'Ocean Star' },
      { patternId: 'P02', englishName: 'Ocean Stars' }
    ])
    expect(result.valid).toBe(true)
    expect(result.issues[0]?.severity).toBe('warning')
  })
})
