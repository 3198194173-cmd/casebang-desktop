import { describe, expect, it } from 'vitest'
import { appendExistingSeries, findSeriesTargets, nextOccupiedColumn, excelColumn, type ExistingSeriesSelection } from '../src/renderer/src/features/tasks/existing-series'
import type { WorkbookPreviewResult } from '../src/shared/contracts'
import type { GenerationWorkspaceData } from '../src/shared/generation-contracts'
const series: ExistingSeriesSelection = { code: 'J1', englishName: 'Tom and Jerry Series', chineseName: '猫和老鼠', referenceRow: 93, referenceSheet: '系列名对应代码', referenceAppendColumn: 6 }
describe('existing series additions', () => {
  it('counts image-only cells but ignores trailing formatting and unrelated rows', () => {
    const preview = { rows: [
      { rowNumber: 96, cells: [{ address: 'D96', value: '', formula: null, generatedImageDataUrl: null, hasImage: true }, { address: 'K96', value: '', formula: null, generatedImageDataUrl: null }] },
      { rowNumber: 97, cells: [{ address: 'Z97', value: 'other series', formula: null, generatedImageDataUrl: null }] }
    ] } as WorkbookPreviewResult
    expect(nextOccupiedColumn(preview, [96])).toBe(4)
    expect(excelColumn(nextOccupiedColumn(preview, [96]))).toBe('E')
  })
  it('matches both series name and code, never a same-name different code', () => {
    const preview: WorkbookPreviewResult = { kind: 'domesticNaming', fileName: 'test.xlsx', sheetNames: ['可拆卸+其他'], activeSheetName: '可拆卸+其他', totalRows: 10, dataRowCount: 2, columnCount: 12, rows: [1, 2].map((n) => ({ rowNumber: n * 2, cells: [{ address: `A${n * 2}`, value: `Tom and Jerry Series#J${n}系列`, formula: null, generatedImageDataUrl: null }, { address: `B${n * 2}`, value: 'Happy Tom', formula: null, generatedImageDataUrl: null }] })) }
    expect(findSeriesTargets(preview, series)).toEqual([{ sheet: '可拆卸+其他', nameRow: 2, appendColumn: 2, names: ['Happy Tom'] }])
  })
  it('appends image/name without category text, and never writes historical series columns', () => {
    const workspace: GenerationWorkspaceData = { title: 'test', generatedAt: 'now', checks: [], workbooks: [
      { id: 'domestic-naming', name: 'domestic', role: '', sheets: [{ id: 'd', name: 'old', columns: ['A', 'B'], rows: [[{ value: '', cropId: 'overview', changed: true }, { value: '', cropId: 'p', changed: true }], [{ value: 'series', changed: true }, { value: 'Happy Tom', changed: true }]] }] },
      { id: 'barcode-reference', name: 'A', role: '', sheets: [{ id: 'series-code', name: 'series', columns: ['A'], rows: [[{ value: 'J1', changed: true }]] }, { id: 'used-codes', name: 'used', columns: ['A'], rows: [[{ value: 'BG01234', changed: true, targetAddress: 'A9' }]] }] }
    ] }
    const next = appendExistingSeries(workspace, { sheet: 'real', nameRow: 100, appendColumn: 12, names: [] }, series, new Map([['p', '磁吸背盖']]))
    const domestic = next.workbooks[0]!.sheets[0]!
    expect(domestic.rows[0]![12]).toMatchObject({ cropId: 'p', targetAddress: 'M99' })
    expect(domestic.rows[0]!.filter(c => c.changed)).toHaveLength(1)
    expect(domestic.rows[1]![12]).toMatchObject({ value: 'Happy Tom', targetAddress: 'M100' })
    const reference = next.workbooks[1]!.sheets[0]!
    expect(reference.rows[0]!.filter(c => c.changed).map(c => c.targetAddress)).toEqual(['G93', 'H93'])
    expect(reference.rows[0]![6]).toMatchObject({ value: '磁吸背盖', changed: true })
    expect(reference.rows[0]![7]).toMatchObject({ cropId: 'overview', changed: true })
    expect(next.workbooks[1]!.sheets[1]).toEqual(workspace.workbooks[1]!.sheets[1])
    expect(workspace.workbooks[0]!.sheets[0]!.name).toBe('old')
  })
  it('supports columns beyond Z', () => { expect(excelColumn(26)).toBe('AA'); expect(excelColumn(16383)).toBe('XFD') })
})
