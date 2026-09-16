import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { XMLValidator } from 'fast-xml-parser'
import type { CropBox } from '../src/shared/image-contracts'
import { buildProductImageMapping } from '../src/renderer/src/features/tasks/product-image-mapping-builder'
import { WorkbookPreviewService } from '../src/main/modules/spreadsheet/workbook-preview-service'
import { exportFormatPreservingWorkbook } from '../src/main/modules/tasks/format-preserving-generation-exporter'
import { readOoxmlPackage, findPackageText } from '../src/main/modules/spreadsheet/ooxml-package'

const root = resolve(__dirname, '..', '..')
const source = join(root, '表格文件', 'CASEBANG-K3名称对应产品图片-260904.xlsx')
const form = { templateName: '可拆卸+其他', seriesNameEn: 'Test Series', seriesNameZh: '测试系列', ipRemark: '测试IP', selectedModels: [], modelBrandAssignments: {}, masterImagePath: '' }
function product(category: string, id: string, code: string) {
  const crop: CropBox = { id, x: 0, y: 0, width: 100, height: 100, role: 'product-pattern', label: id,
    productCategory: category, suggestedRetailPrice: 239, overseasRetailPrice: 51.99, material: '', patternGroupId: null,
    confidence: 1, categoryConfidence: 1, categoryReasons: [], patternNameEn: 'Test Pattern', patternNameZh: '测试图案', nameCandidates: [] }
  return { crop, code, barcode: `CASEBANG ${category}-Test Series#K9系列-Test Pattern ${code}${category.startsWith('MP16') ? '（10000mAh）' : ''}` }
}
const products = [product('磁吸背盖', 'back', 'BG00999'), product('出镜壳', 'case', 'CCK00999'),
  product('磁吸气囊支架', 'air', 'ZJQN00999'), product('磁吸支架背盖', 'stand', 'ZJBG00999'),
  product('CP002磁吸充电宝', 'wireless', 'PB00999'), product('MP16磁吸充电宝', 'wireless', 'PB00999'),
  product('CP006自带线移动电源', 'wired', 'PBDX00999')]

describe('K3 output-only image mapping', () => {
  it('fills the right-hand slots before opening the next block', () => {
    const mapping = buildProductImageMapping(form, 'K9', products, { version: 'v1', sheets: [
      { name: '充电宝名字图案对应', lastOccupiedRow: 69, appendRow: 68, appendColumn: 8, columnWidths: Array(12).fill(140) },
      { name: 'CP006自带线充电宝名字图案对应', lastOccupiedRow: 43, appendRow: 41, appendColumn: 10, columnWidths: Array(12).fill(140) },
      { name: '圆片材＆气囊支架名字图案对应', lastOccupiedRow: 221, appendRow: 219, appendColumn: 3, columnWidths: [...Array(9).fill(195), 60, 60, 60] }
    ] })
    const wireless = mapping.sheets.find((sheet) => sheet.name === '充电宝名字图案对应')!
    expect(wireless.startRow).toBe(68)
    expect(wireless.rows[0]![8]!.cropId).toBe('wireless')
    expect(wireless.rows[1]![9]!.value).toContain('MP16')
    expect(wireless.rows[0]!.slice(0, 8).every((cell) => !cell.changed)).toBe(true)
    const wired = mapping.sheets.find((sheet) => sheet.name.startsWith('CP006'))!
    expect(wired.startRow).toBe(41)
    expect(wired.rows[0]![10]!.cropId).toBe('wired')
    const stand = mapping.sheets.find((sheet) => sheet.name.startsWith('圆片材'))!
    expect(stand.startRow).toBe(219)
    expect(stand.rows[0]![3]!.cropId).toBe('stand')
    expect(stand.rows[0]![4]!.cropId).toBe('air')
  })
  it('routes paired wireless columns, ordered stands and unique series tabs', () => {
    const mapping = buildProductImageMapping(form, 'K9', products, { version: 'v1', sheets: [
      { name: '圆片材＆气囊支架名字图案对应', lastOccupiedRow: 221 },
      { name: '充电宝名字图案对应', lastOccupiedRow: 69 },
      { name: '测试系列#K9可拆卸图片+名称', lastOccupiedRow: 2 }
    ] })
    expect(mapping.sheets[0]?.name).toBe('测试系列#K9可拆卸图片+名称 (2)')
    expect(mapping.sheets.some((sheet) => sheet.name.includes('测试IP#K9'))).toBe(false)
    expect(mapping.sheets[0]?.createIfMissing).toBe(true)
    const stand = mapping.sheets.find((sheet) => sheet.name.startsWith('圆片材'))!
    expect(stand.startRow).toBe(222)
    expect(stand.rows[0]?.map((cell) => cell.cropId)).toEqual(['stand', 'air'])
    expect(stand.rows[2]?.every((cell) => cell.value === '' && cell.fill === 'yellow')).toBe(true)
    const wireless = mapping.sheets.find((sheet) => sheet.name === '充电宝名字图案对应')!
    expect(wireless.startRow).toBe(70)
    expect(wireless.rows[0]?.[0]?.cropId).toBe('wireless')
    expect(wireless.rows[0]?.[1]?.fill).toBe('yellow')
    expect(wireless.rows[0]?.[1]?.value).toBe('')
    expect(wireless.rows[1]?.[0]?.value).toContain('CP002')
    expect(wireless.rows[1]?.[1]?.value).toContain('MP16')
    const wired = mapping.sheets.find((sheet) => sheet.name.startsWith('CP006'))!
    expect(wired.rows[2]?.[0]).toMatchObject({ value: '', changed: true, fill: 'yellow' })
    expect(JSON.stringify(mapping)).not.toContain('测试图案')
  })

  it('preserves historical parts and exports readable added tabs and paired columns', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'casebang-k3-'))
    try {
      const preview = new WorkbookPreviewService()
      const index = await preview.mappingIndex(source)
      expect(index.sheets.length).toBeGreaterThan(280)
      const mapping = buildProductImageMapping(form, 'K9', products, index)
      mapping.sheets.forEach((sheet) => sheet.rows.forEach((row, offset) => row.forEach((cell, column) => {
        cell.targetAddress = `${String.fromCharCode(65 + column)}${(sheet.startRow ?? 1) + offset}`
      })))
      const output = join(directory, 'mapping.xlsx')
      await exportFormatPreservingWorkbook(source, output, mapping, {
        suggestedName: 'test', templateName: form.templateName,
        workspace: { title: 'test', generatedAt: 'test', checks: [], workbooks: [mapping] },
        sourcePaths: { namingFormula: source, barcodeReference: source, domesticNaming: source, productImageMapping: source },
        imageSource: { path: join(root, '图片文件', 'Tom and Jerry Series#J1系列-猫和老鼠1.0-韦-260805.png'),
          crops: products.map(({ crop }) => ({ id: crop.id, x: 0, y: 0, width: 100, height: 100 })) }
      })
      const original = await readOoxmlPackage(source, { skipMedia: true })
      const updated = await readOoxmlPackage(output, { skipMedia: true })
      const byPath = new Map(updated.map((entry) => [entry.path, entry]))
      for (const entry of original) {
        // All original media and untouched historical worksheets stay byte-identical.
        if (entry.path.startsWith('xl/media/') || /^xl\/worksheets\/sheet(?:[5-9]|\d{2,})\.xml$/.test(entry.path)) {
          expect(byPath.get(entry.path)?.crc32, entry.path).toBe(entry.crc32)
        }
      }
      for (const entry of updated.filter((item) => item.path.endsWith('.xml') || item.path.endsWith('.rels'))) {
        expect(XMLValidator.validate(entry.buffer!.toString('utf8')), entry.path).toBe(true)
      }
      const workbookXml = findPackageText(updated, 'xl/workbook.xml')!
      expect(workbookXml).toContain('测试系列#K9可拆卸图片+名称')
      expect(workbookXml).toContain('测试系列#K9出镜壳图片+名称')
      expect(workbookXml).not.toContain('测试IP#K9')
      const result = await preview.read(output, { kind: 'productImageMapping', sheetName: '测试系列#K9可拆卸图片+名称' })
      expect(result.rows[0]?.cells[0]?.generatedImageDataUrl).toMatch(/^data:image\/png;base64,/)
      expect(result.rows[1]?.cells[0]?.value).toContain('BG00999')
      const wireless = mapping.sheets.find((sheet) => sheet.name === '充电宝名字图案对应')!
      const wirelessPreview = await preview.read(output, { kind: 'productImageMapping', sheetName: wireless.name })
      const plannedName = wireless.rows[1]!.find((cell) => cell.changed)!
      expect(wirelessPreview.rows.flatMap((row) => row.cells).find((cell) => cell.address === plannedName.targetAddress)?.value).toBe(plannedName.value)
      const caption = wireless.rows[0]!.find((cell) => cell.changed && cell.fill === 'yellow')!
      expect(wirelessPreview.rows.flatMap((row) => row.cells).find((cell) => cell.address === caption.targetAddress)?.value).toBe('')
      // The first public sheet contains self-closing image rows. Every old
      // cell and row height must survive adding the new stand products.
      const beforeSheet = findPackageText(original, 'xl/worksheets/sheet1.xml')!
      const afterSheet = findPackageText(updated, 'xl/worksheets/sheet1.xml')!
      expect(/<cols>[\s\S]*?<\/cols>/.exec(afterSheet)?.[0]).toBe(/<cols>[\s\S]*?<\/cols>/.exec(beforeSheet)?.[0])
      for (const cell of beforeSheet.matchAll(/<c\b[^>]*?(?<!\/)>(?:[\s\S]*?)<\/c>/g)) {
        if (!cell[0].includes('<v>')) continue
        expect(afterSheet).toContain(cell[0])
      }
      for (const row of beforeSheet.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*\bht="([^"]+)"/g)) {
        expect(new RegExp(`<row\\b[^>]*\\br="${row[1]}"[^>]*\\bht="${row[2]}"`).test(afterSheet)).toBe(true)
      }
      for (const entry of original.filter((entry) => /^xl\/drawings\/drawing\d+\.xml$/.test(entry.path))) {
        const before = entry.buffer!.toString('utf8')
        const after = findPackageText(updated, entry.path)!
        for (const anchor of before.matchAll(/<xdr:(?:oneCellAnchor|twoCellAnchor|absoluteAnchor)\b[\s\S]*?<\/xdr:(?:oneCellAnchor|twoCellAnchor|absoluteAnchor)>/g)) {
          expect(after.includes(anchor[0]), `Historical anchor: ${entry.path}`).toBe(true)
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)
})
