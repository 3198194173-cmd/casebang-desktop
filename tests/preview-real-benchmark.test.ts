import { it, expect } from 'vitest'
import { resolve } from 'node:path'
import { WorkbookPreviewService } from '../src/main/modules/spreadsheet/workbook-preview-service'
it.skipIf(!process.env.CASEBANG_PREVIEW_BENCH)('benchmarks the real K3 workbook read-only', async () => {
  const service = new WorkbookPreviewService()
  const file = resolve('..', '表格文件', 'CASEBANG-K3名称对应产品图片-260904.xlsx')
  let start = performance.now()
  const meta = await service.read(file, { kind: 'productImageMapping', imageEndRow: 0 })
  console.log('metadata ms', Math.round(performance.now() - start), meta.activeSheetName)
  for (const [first, last] of [[1, 38], [78, 100], [78, 100], [101, 140], [141, 180], [181, 227]]) {
    start = performance.now()
    const preview = await service.read(file, { kind: 'productImageMapping', imageStartRow: first, imageEndRow: last, imagesOnly: true })
    const cells = preview.rows.flatMap((r) => r.cells)
    console.log('range', first, last, 'ms', Math.round(performance.now() - start), 'images', cells.filter(c => c.generatedImageDataUrl).length, 'unresolved', cells.filter(c => /DISPIMG/i.test(c.formula ?? '') && !c.generatedImageDataUrl).map(c => c.address))
    if (first === 78) expect(cells.find(c => c.address === 'A87')?.generatedImageDataUrl).toMatch(/^data:image/)
    expect(cells.filter(c => /DISPIMG/i.test(c.formula ?? '') && !c.generatedImageDataUrl)).toEqual([])
  }
}, 120000)
