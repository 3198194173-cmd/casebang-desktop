import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { exportFormatPreservingWorkbook } from '../src/main/modules/tasks/format-preserving-generation-exporter'
import { findPackageText, readOoxmlPackage } from '../src/main/modules/spreadsheet/ooxml-package'
import type { PreviewWorkbook } from '../src/shared/generation-contracts'

const projectRoot = resolve(__dirname, '..')
const sourceDirectory = resolve(projectRoot, '..', '表格文件')
const masterImagePath = resolve(projectRoot, '..', '图片文件', 'Tom and Jerry Series#J1系列-猫和老鼠1.0-韦-260805.png')

describe('format preserving generation exporter', () => {
  it('keeps only the selected template sheet and writes a single drawing relationship', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'casebang-export-'))
    const destination = join(directory, 'generated.xlsx')
    try {
      await exportFormatPreservingWorkbook(
        join(projectRoot, 'resources', 'generated-product-template.xlsx'),
        destination,
        sealWorkbook({
          id: 'generated-product', name: '新建产品表', role: 'test', sheets: [{
            id: 'generated-products', name: '图片',
            columns: ['条码名', '图片', '', '颜色', '系列名称', '系列名称（大写）', '系列编码', '产品编码', '图片对应名称', '图片对应名称（大写）', '图档名'],
            columnWidths: [460, 120, 86, 90, 210, 220, 105, 125, 210, 230, 330],
            startRow: 1, showBusinessHeader: true,
            headerCells: [
              { value: '' },
              { value: 'overview', cropId: 'overview', changed: true, imageLayout: { containerWidthPx: 120, containerHeightPx: 92, imageWidthPx: 120, imageHeightPx: 80 } }
            ],
            rows: [[
              { value: 'CASEBANG 磁吸背盖-Test Series#J1系列-Test BG00001', changed: true },
              { value: 'product', cropId: 'overview', changed: true, imageLayout: { containerWidthPx: 120, containerHeightPx: 92, imageWidthPx: 120, imageHeightPx: 80 } },
              { value: '', changed: true }, { value: '银色片材', changed: true }, { value: '', changed: true }, { value: '', changed: true }, { value: '', changed: true }, { value: 'BG00001', changed: true }, { value: '', changed: true }, { value: '', changed: true }, { value: 'TEST#J1#BG00001', changed: true }
            ]]
          }, {
            id: 'generated-barcodes', name: '条码',
            columns: ['类目', '69码', '物料编码（工厂）', '物料名称', '建议零售价', '海外零售价', '材质', '备注（IP）', '名称对应'],
            startRow: 1, showBusinessHeader: true,
            rows: [[
              { value: '单个片材', changed: true }, { value: '', changed: true }, { value: '', changed: true },
              { value: 'CASEBANG 磁吸背盖-Test Series#J1系列-Test BG00001 iP17', changed: true },
              { value: '￥89.00', numericValue: 89, changed: true }, { value: 'US$19.99', numericValue: 19.99, changed: true },
              { value: '银色', changed: true }, { value: '测试系列', changed: true }, { value: '', changed: true }
            ]]
          }]
        }),
        {
          suggestedName: 'test', templateName: '可拆卸+其他',
          sourcePaths: {
            namingFormula: join(sourceDirectory, '命名-公式(1).xlsx'),
            barcodeReference: join(sourceDirectory, 'A条码参考-260116(1).xlsx'),
            domesticNaming: join(sourceDirectory, '国内命名-260407(1).xlsx')
          },
          imageSource: { path: masterImagePath, crops: [{ id: 'overview', x: 0, y: 0, width: 100, height: 100 }] },
          workspace: { title: 'test', generatedAt: new Date().toISOString(), workbooks: [], checks: [] }
        }
      )
      const entries = await readOoxmlPackage(destination)
      const workbookXml = findPackageText(entries, 'xl/workbook.xml') ?? ''
      const worksheetXml = entries
        .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.path))
        .map((entry) => findPackageText(entries, entry.path) ?? '')
        .find((xml) => xml.includes('<drawing') && xml.includes('CASEBANG 磁吸背盖-Test Series#J1系列-Test BG00001')) ?? ''
      const barcodeXml = entries
        .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.path))
        .map((entry) => findPackageText(entries, entry.path) ?? '')
        .find((xml) => xml.includes('CASEBANG 磁吸背盖-Test Series#J1系列-Test BG00001 iP17')) ?? ''
      expect([...workbookXml.matchAll(/<sheet\b/gi)]).toHaveLength(2)
      expect(workbookXml).toContain('条码')
      expect(workbookXml).toContain('图片')
      const sheetsXml = /<sheets\b[^>]*>([\s\S]*?)<\/sheets>/i.exec(workbookXml)?.[1] ?? ''
      expect(sheetsXml.indexOf('图片')).toBeLessThan(sheetsXml.indexOf('条码'))
      expect([...worksheetXml.matchAll(/<drawing\b/gi)]).toHaveLength(1)
      expect(worksheetXml).toContain('<c r="B1"')
      expect(worksheetXml).toContain('<c r="K2"')
      expect(worksheetXml).toContain('TEST#J1#BG00001')
      expect(worksheetXml).toMatch(/<col\b[^>]*min="11"[^>]*max="11"/i)
      expect(worksheetXml).toContain('CASEBANG 磁吸背盖-Test Series#J1系列-Test BG00001')
      expect(barcodeXml).toMatch(/<c\b[^>]*r="E2"[^>]*>\s*<v>89<\/v>\s*<\/c>/i)
      expect(barcodeXml).toMatch(/<c\b[^>]*r="F2"[^>]*>\s*<v>19\.99<\/v>\s*<\/c>/i)
      expect(barcodeXml).not.toMatch(/<c\b[^>]*r="[JK]\d+"/i)
      expect(findPackageText(entries, 'xl/drawings/drawing4.xml') ?? findPackageText(entries, 'xl/drawings/drawing1.xml') ?? '').toContain('CASEBANG 图片')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  it('appends domestic naming images to its existing drawing instead of adding a second drawing tag', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'casebang-domestic-'))
    const destination = join(directory, 'domestic.xlsx')
    try {
      await exportFormatPreservingWorkbook(
        join(sourceDirectory, '国内命名-260407(1).xlsx'),
        destination,
        sealWorkbook({
          id: 'domestic-naming', name: '国内命名表', role: 'test', sheets: [{
            id: 'domestic-naming-updates', name: '可拆卸+其他', columns: ['A'], startRow: 194, showBusinessHeader: false,
            rows: [[{ value: 'overview', cropId: 'overview', changed: true, imageLayout: { containerWidthPx: 205, containerHeightPx: 170, imageWidthPx: 180, imageHeightPx: 120 } }], [{ value: 'Test Series#J1系列', changed: true }]]
          }]
        }),
        {
          suggestedName: 'test', templateName: '可拆卸+其他',
          sourcePaths: {
            namingFormula: join(sourceDirectory, '命名-公式(1).xlsx'),
            barcodeReference: join(sourceDirectory, 'A条码参考-260116(1).xlsx'),
            domesticNaming: join(sourceDirectory, '国内命名-260407(1).xlsx')
          },
          imageSource: { path: masterImagePath, crops: [{ id: 'overview', x: 0, y: 0, width: 100, height: 100 }] },
          workspace: { title: 'test', generatedAt: new Date().toISOString(), workbooks: [], checks: [] }
        }
      )
      const entries = await readOoxmlPackage(destination)
      const worksheetXml = findPackageText(entries, 'xl/worksheets/sheet1.xml') ?? ''
      const drawingXml = findPackageText(entries, 'xl/drawings/drawing1.xml') ?? ''
      expect([...worksheetXml.matchAll(/<drawing\b/gi)]).toHaveLength(1)
      expect(drawingXml).toContain('CASEBANG 图片')
      expect([...drawingXml.matchAll(/<xdr:(?:twoCellAnchor|oneCellAnchor)\b/gi)].length).toBeGreaterThan(1)
      const imageRow = /<row\b([^>]*\br="194"[^>]*)>/i.exec(worksheetXml)?.[1] ?? ''
      const imageRowHeight = Number(/\b(?:h|ht)="([^"]+)"/i.exec(imageRow)?.[1] ?? 0)
      expect(imageRowHeight).toBeGreaterThanOrEqual(120)
      const exportedImageHeights = [...drawingXml.matchAll(/<xdr:ext\b[^>]*\bcy="(\d+)"/gi)].map((match) => Number(match[1]))
      expect(Math.max(...exportedImageHeights)).toBeGreaterThanOrEqual(150 * 9_525)
      const row195 = /<row\b[^>]*\br="195"[^>]*>([\s\S]*?)<\/row>/i.exec(worksheetXml)?.[1] ?? ''
      expect(row195).toContain('Test Series#J1系列')
      expect(row195.indexOf('r="A195"')).toBeLessThan(row195.indexOf('r="B195"'))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  it('writes adjacent empty code-pool cells without swallowing rows and stretches the series artwork', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'casebang-barcode-'))
    const destination = join(directory, 'barcode.xlsx')
    try {
      await exportFormatPreservingWorkbook(
        join(sourceDirectory, 'A条码参考-260116(1).xlsx'),
        destination,
        sealWorkbook({
          id: 'barcode-reference', name: 'A条码参考', role: 'test', sheets: [
            {
              id: 'series-code', name: '系列名对应代码', columns: ['系列名代码', '系列名（英）', '系列名', '图片'], startRow: 102, showBusinessHeader: true,
              rows: [[
                { value: 'K1', changed: true }, { value: 'Test Series', changed: true }, { value: '测试系列', changed: true },
                { value: 'overview', cropId: 'overview', changed: true, imageLayout: { containerWidthPx: 260, containerHeightPx: 80, imageWidthPx: 260, imageHeightPx: 80, fitMode: 'stretch' } }
              ]]
            },
            {
              id: 'used-codes', name: '已使用编码', columns: Array.from({ length: 16 }, (_, index) => String(index + 1)), startRow: 130, showBusinessHeader: true,
              rows: [[
                { value: '' }, { value: '' }, { value: '' },
                { value: 'ZJBG00346/Test Series#K1系列', changed: true },
                { value: 'ZJQN00346/Test Series#K1系列', changed: true }
              ]]
            }
          ]
        }),
        {
          suggestedName: 'test', templateName: '可拆卸+其他',
          sourcePaths: {
            namingFormula: join(sourceDirectory, '命名-公式(1).xlsx'),
            barcodeReference: join(sourceDirectory, 'A条码参考-260116(1).xlsx'),
            domesticNaming: join(sourceDirectory, '国内命名-260407(1).xlsx')
          },
          imageSource: { path: masterImagePath, crops: [{ id: 'overview', x: 0, y: 0, width: 100, height: 100 }] },
          workspace: { title: 'test', generatedAt: new Date().toISOString(), workbooks: [], checks: [] }
        }
      )
      const entries = await readOoxmlPackage(destination)
      const seriesXml = findPackageText(entries, 'xl/worksheets/sheet1.xml') ?? ''
      const imageRow = /<row\b([^>]*\br="103"[^>]*)>/i.exec(seriesXml)?.[1] ?? ''
      const imageRowHeight = Number(/\b(?:h|ht)="([^"]+)"/i.exec(imageRow)?.[1] ?? 0)
      expect(imageRowHeight).toBeGreaterThanOrEqual(60)
      const usedCodesXml = findPackageText(entries, 'xl/worksheets/sheet2.xml') ?? ''
      const row131 = /<row\b[^>]*\br="131"[^>]*>([\s\S]*?)<\/row>/i.exec(usedCodesXml)?.[1] ?? ''
      const row132 = /<row\b[^>]*\br="132"[^>]*>([\s\S]*?)<\/row>/i.exec(usedCodesXml)?.[1] ?? ''
      expect(row131).toContain('r="D131"')
      expect(row131).toContain('r="E131"')
      expect(row131).toContain('ZJBG00346/Test Series#K1系列')
      expect(row131).toContain('ZJQN00346/Test Series#K1系列')
      expect(row131).not.toContain('r="D132"')
      expect(row132).toContain('r="D132"')

      const drawing = entries
        .filter((entry) => /^xl\/drawings\/drawing\d+\.xml$/i.test(entry.path))
        .map((entry) => findPackageText(entries, entry.path))
        .find((xml) => xml?.includes('CASEBANG 图片')) ?? ''
      const anchor = /<xdr:oneCellAnchor>[\s\S]*?CASEBANG 图片[\s\S]*?<xdr:ext cx="(\d+)" cy="(\d+)"/.exec(drawing)
        ?? /<xdr:oneCellAnchor>[\s\S]*?<xdr:ext cx="(\d+)" cy="(\d+)"[\s\S]*?CASEBANG 图片/.exec(drawing)
      expect(anchor).not.toBeNull()
      expect(Number(anchor?.[1]) / Number(anchor?.[2])).toBeGreaterThan(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
})

function sealWorkbook(workbook: PreviewWorkbook): PreviewWorkbook {
  return {
    ...workbook,
    sheets: workbook.sheets.map((sheet) => {
      const startRow = sheet.startRow ?? 1
      const dataStartRow = startRow + (sheet.showBusinessHeader === false ? 0 : 1)
      return {
        ...sheet,
        headerCells: sheet.headerCells?.map((cell, column) => cell.changed || cell.writeOnly
          ? { ...cell, targetAddress: `${columnName(column + 1)}${startRow}` }
          : cell),
        rows: sheet.rows.map((row, rowIndex) => row.map((cell, column) => cell.changed || cell.writeOnly
          ? { ...cell, targetAddress: `${columnName(column + 1)}${dataStartRow + rowIndex}` }
          : cell))
      }
    })
  }
}

function columnName(index: number): string {
  let value = index
  let name = ''
  while (value > 0) {
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name
    value = Math.floor((value - 1) / 26)
  }
  return name
}
