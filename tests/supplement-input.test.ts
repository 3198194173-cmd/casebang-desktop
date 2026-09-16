import { describe, expect, it } from 'vitest'
import { collectSupplementInputs, chineseLookupKey } from '../src/main/modules/supplement/supplement-input'
describe('supplement image and Chinese name coverage', () => {
  const isSku = (value: string) => value.includes('iP17 Pro')
  const resolve = (value: string) => value.includes('甜梦') ? { value: 'CASEBANG 出镜壳-甜梦 CZ00123 iP17 Pro' } : { issue: '待补充资料' }
  it('resolves Chinese-only captions and retains each nameless image', () => {
    const result = collectSupplementInputs([{ ref: 'B24', value: '出镜壳-甜梦乐园系列-小熊' }, { ref: 'F24', value: '名字重新命过' }], ['B23', 'F23', 'G23'], isSku, resolve)
    expect(result).toHaveLength(3)
    expect(result.find(c => c.ref === 'B24')).toMatchObject({ value: 'CASEBANG 出镜壳-甜梦 CZ00123 iP17 Pro', original: '出镜壳-甜梦乐园系列-小熊' })
    expect(result.filter(c => c.issue)).toHaveLength(2)
  })
  it('does not double-count Chinese captions below full SKU rows', () => {
    expect(collectSupplementInputs([{ ref: 'B19', value: 'CASEBANG X iP17 Pro' }, { ref: 'B21', value: '出镜壳-甜梦乐园系列' }], ['B18'], isSku, resolve)).toHaveLength(1)
  })
  it('normalizes brand, spaces and dash typography without fuzzy substring matching', () => {
    expect(chineseLookupKey('CASEBANG 出镜壳—甜梦 系列')).toBe(chineseLookupKey('出镜壳-甜梦系列'))
    expect(chineseLookupKey('出镜壳-甜梦系列-熊')).not.toBe(chineseLookupKey('出镜壳-甜梦系列-兔'))
  })
})
