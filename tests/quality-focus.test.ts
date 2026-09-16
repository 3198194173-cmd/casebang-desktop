import { describe, it, expect } from 'vitest'
import { qualityFocus } from '../src/renderer/src/features/tasks/quality-focus'
import type { PreviewSheet } from '../src/shared/generation-contracts'
const make = (id: string, rows: PreviewSheet['rows']): PreviewSheet => ({ id, name: id, columns: ['A', 'B'], rows })
describe('quality preview focus', () => {
  it('selects the first changed cell including its horizontal position', () => {
    expect(qualityFocus(make('domestic', [[{ value: 'history' }], [{ value: '' }, { value: 'new', changed: true }], [{ value: 'new', changed: true }]]))).toEqual({ row: 1, column: 1 })
  })
  it('selects the most recent changed used-code row', () => {
    expect(qualityFocus(make('used-codes', [[{ value: 'a', changed: true }], [{ value: 'b', changed: true }], [{ value: '' }]]))).toEqual({ row: 1, column: 0 })
  })
  it('falls back to last nonempty code and ignores trailing blanks', () => {
    expect(qualityFocus(make('used-codes', [[{ value: 'old' }], [{ value: '' }, { value: 'last' }], [{ value: '' }]]))).toEqual({ row: 1, column: 1 })
  })
  it('handles empty sheets and write-only cells', () => {
    expect(qualityFocus(make('empty', []))).toEqual({ row: 0, column: 0 })
    expect(qualityFocus(make('mapping', [[], [{ value: '', writeOnly: true }]]))).toEqual({ row: 1, column: 0 })
  })
})
