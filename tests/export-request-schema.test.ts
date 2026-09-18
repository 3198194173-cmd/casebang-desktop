import { expect, it } from 'vitest'
import { exportGenerationWorkbookInputSchema, publishGenerationWorkbookInputSchema } from '../src/shared/schemas'
import { workbookFileError } from '../src/main/modules/spreadsheet/safe-workbook-file'

const ids = ['generated-product', 'barcode-reference', 'domestic-naming', 'product-image-mapping'] as const
function request(selected = [...ids] as string[]) {
  return {
    suggestedName: 'test', templateName: 'test',
    workspace: { title: 'test', generatedAt: new Date().toISOString(),
      checks: [{ id: 'ok', label: 'ok', passed: true, detail: 'ok' }],
      workbooks: selected.map((id) => ({ id, name: id, role: 'test', sheets: [{ id: 'sheet', name: 'sheet', columns: ['A'], rows: [[{ value: 'test', changed: true, targetAddress: 'A1' }]] }] })) },
    sourcePaths: { namingFormula: 'formula.xlsx', barcodeReference: 'barcode.xlsx', domesticNaming: 'naming.xlsx' },
    imageSource: { path: 'image.png', crops: [{ id: 'crop', x: 0, y: 0, width: 1, height: 1 }] },
    selectedWorkbookIds: selected
  }
}
it.each(ids)('accepts a single selected workbook: %s', (id) => {
  expect(exportGenerationWorkbookInputSchema.safeParse(request([id])).success).toBe(true)
})
it('accepts two and four selected workbooks', () => {
  expect(exportGenerationWorkbookInputSchema.safeParse(request(ids.slice(0, 2))).success).toBe(true)
  expect(exportGenerationWorkbookInputSchema.safeParse(request()).success).toBe(true)
})
it('accepts direct central publishing only for an upstream generation workflow', () => {
  expect(publishGenerationWorkbookInputSchema.safeParse({ generation: request(['generated-product']), sourceWorkflow: 'new-series' }).success).toBe(true)
  expect(publishGenerationWorkbookInputSchema.safeParse({ generation: request(['generated-product']), sourceWorkflow: 'new-products' }).success).toBe(true)
  expect(publishGenerationWorkbookInputSchema.safeParse({ generation: request(['generated-product']), sourceWorkflow: 'new-models' }).success).toBe(false)
})
it('preserves the deliberately blank frame header and accepts wide existing-series append plans', () => {
  const input = request(['generated-product'])
  const sheet = input.workspace.workbooks[0]!.sheets[0]!
  sheet.columns = ['条码名', '图片', '', '颜色']
  const result = exportGenerationWorkbookInputSchema.parse(input)
  expect(result.workspace.workbooks[0]!.sheets[0]!.columns).toEqual(sheet.columns)
  sheet.columns = Array.from({ length: 70 }, (_, index) => String(index))
  sheet.rows = [sheet.columns.map(() => ({ value: '', changed: false, targetAddress: 'A1' }))]
  expect(exportGenerationWorkbookInputSchema.safeParse(input).success).toBe(true)
})
it('still rejects an empty column array, oversized labels, invalid coordinates and excessive sheet dimensions', () => {
  const input = request(['generated-product'])
  const sheet = input.workspace.workbooks[0]!.sheets[0]!
  sheet.columns = []
  expect(exportGenerationWorkbookInputSchema.safeParse(input).success).toBe(false)
  sheet.columns = ['x'.repeat(101)]
  expect(exportGenerationWorkbookInputSchema.safeParse(input).success).toBe(false)
  sheet.columns = ['A']
  sheet.rows[0]![0]!.targetAddress = 'A0'
  expect(exportGenerationWorkbookInputSchema.safeParse(input).success).toBe(false)
  sheet.rows = []
  sheet.columns = Array.from({ length: 16_385 }, () => '')
  expect(exportGenerationWorkbookInputSchema.safeParse(input).success).toBe(false)
})
it('allows expanded normal/silver barcode rows while keeping the cell-count guard', () => {
  const input = request(['generated-product'])
  const sheet = input.workspace.workbooks[0]!.sheets[0]!
  const cell = { value: '', changed: false, targetAddress: 'A1' }
  sheet.rows = Array.from({ length: 20_100 }, () => Array.from({ length: 9 }, () => cell))
  expect(exportGenerationWorkbookInputSchema.safeParse(input).success).toBe(true)
  sheet.rows = Array.from({ length: 5_001 }, () => Array.from({ length: 100 }, () => cell))
  const result = exportGenerationWorkbookInputSchema.safeParse(input)
  expect(result.success).toBe(false)
  if (!result.success) expect(result.error.issues.some((issue) => issue.message.includes('50 万'))).toBe(true)
})
it('rejects empty, duplicate, and missing selected workbook data', () => {
  expect(exportGenerationWorkbookInputSchema.safeParse(request([])).success).toBe(false)
  expect(exportGenerationWorkbookInputSchema.safeParse(request(['generated-product', 'generated-product'])).success).toBe(false)
  const input = request(['generated-product'])
  input.selectedWorkbookIds = ['product-image-mapping']
  expect(exportGenerationWorkbookInputSchema.safeParse(input).success).toBe(false)
})
it('distinguishes busy files from permission errors', () => {
  expect(workbookFileError({ code: 'EBUSY' }, 'test.xlsx', 'K3', '覆盖').message).toContain('当前文件已打开，请关闭文件后重试')
  expect(workbookFileError({ code: 'EACCES' }, 'test.xlsx', 'K3', '覆盖').message).toContain('权限')
  const original = new Error('校验失败')
  expect(workbookFileError(original, 'test.xlsx', 'K3', '覆盖')).toBe(original)
})
