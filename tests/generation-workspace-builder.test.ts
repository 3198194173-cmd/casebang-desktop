import { describe, expect, it } from 'vitest'
import type { EncodingPreviewResult } from '../src/shared/coding-contracts'
import type { TaskDraftInput } from '../src/shared/contracts'
import type { ImageAnalysisResult } from '../src/shared/image-contracts'
import {
  BARCODE_ITEM_CLASSES,
  BARCODE_PRICE_PRESETS,
  MATERIAL_COLOR_OPTIONS,
  phoneModelBrand,
  productBusinessSpecification,
  REFERENCE_PHONE_MODELS,
  sortBarcodeModelsByReference
} from '../src/shared/product-business-rules'
import { buildGenerationWorkspace } from '../src/renderer/src/features/tasks/generation-workspace-builder'
import { appendExistingSeries } from '../src/renderer/src/features/tasks/existing-series'
import { exportGenerationWorkbookInputSchema } from '../src/shared/schemas'
import { exportFormatPreservingWorkbook } from '../src/main/modules/tasks/format-preserving-generation-exporter'
import { findPackageText, readOoxmlPackage } from '../src/main/modules/spreadsheet/ooxml-package'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, posix } from 'node:path'
import sharp from 'sharp'

describe('generated product workbook business flow', () => {
  it('derives barcode rows from image barcode names and confirmed models', () => {
    const form: TaskDraftInput = {
      templateName: '可拆卸+其他',
      seriesNameZh: '杭州限定',
      seriesNameEn: 'Hangzhou Limited Series',
      ipRemark: '杭州限定',
      selectedModels: ['P70', 'iP13 Pro Max', 'SAM S24', 'iP13 Pro', 'New Galaxy X'],
      modelBrandAssignments: { 'New Galaxy X': 'samsung' },
      masterImagePath: 'C:\\images\\master.png'
    }
    const workspace = buildGenerationWorkspace(form, analysisFixture(), encodingFixture(), [])
    expect(workspace.workbooks.map((book) => book.id)).toEqual(['barcode-reference', 'domestic-naming', 'generated-product'])
    const generated = workspace.workbooks.find((item) => item.id === 'generated-product')

    expect(generated?.sheets.map((sheet) => sheet.name)).toEqual(['可拆卸+其他图片', '可拆卸+其他条码'])
    const imageRows = generated?.sheets[0]?.rows ?? []
    expect(imageRows.map((row) => row[6]?.value)).toEqual(['BG00725', 'BG00726'])
    const imageBarcodeNames = [imageRows[0]?.[0]?.value, imageRows[1]?.[0]?.value]
    const barcodeRows = generated?.sheets[1]?.rows ?? []
    expect(barcodeRows).toHaveLength(10)
    expect(barcodeRows.map((row) => row[3]?.value)).toEqual([
      `${imageBarcodeNames[0]} iP13 Pro`, `${imageBarcodeNames[1]} iP13 Pro`,
      `${imageBarcodeNames[0]} iP13 Pro Max`, `${imageBarcodeNames[1]} iP13 Pro Max`,
      `${imageBarcodeNames[0]} SAM S24`, `${imageBarcodeNames[1]} SAM S24`,
      `${imageBarcodeNames[0]} New Galaxy X`, `${imageBarcodeNames[1]} New Galaxy X`,
      `${imageBarcodeNames[0]} P70`, `${imageBarcodeNames[1]} P70`
    ])
    expect(generated?.sheets[1]?.columns).toHaveLength(9)
    expect(barcodeRows.every((row) => row.length === 9)).toBe(true)
    expect(barcodeRows.every((row) => row[1]?.value === '' && row[2]?.value === '')).toBe(true)
    expect(barcodeRows.every((row) => row[4]?.numericValue === 89 && row[5]?.numericValue === 19.99)).toBe(true)
    expect(barcodeRows.every((row) => row[6]?.value === '银色' && row[7]?.value === '杭州限定')).toBe(true)
  })

  it('orders every used-code family ascending in new-series image and barcode sheets', () => {
    const products = [
      { category: '磁吸背盖', code: 'BG00010' },
      { category: '磁吸背盖', code: 'BG00009' },
      { category: '出镜壳', code: 'CJ00010' },
      { category: '出镜壳', code: 'CJ00009' },
      { category: '出彩壳', code: 'CCK00010' },
      { category: '出彩壳', code: 'CCK00009' },
      { category: '磁吸支架背盖', code: 'ZJBG00010' },
      { category: '磁吸支架背盖', code: 'ZJBG00009' }
    ]
    const analysis = analysisFixture()
    const product = analysis.crops[1]!
    analysis.crops = [analysis.crops[0]!, ...products.map((item, index) => ({
      ...product, id: `product-${index}`, productCategory: item.category, patternNameEn: `Pattern ${index}`
    }))]
    const encoding = encodingFixture()
    encoding.rows = products.map((item, index) => ({
      ...encoding.rows[0]!, cropId: `product-${index}`, order: index + 1,
      productCategory: item.category, patternNameEn: `Pattern ${index}`,
      prefix: item.code.replace(/\d+$/, ''), productCode: item.code
    }))
    const form: TaskDraftInput = {
      templateName: '自动按产品类型', seriesNameZh: '测试', seriesNameEn: 'Test Series', ipRemark: '',
      selectedModels: ['iP13 Pro'], modelBrandAssignments: {}, masterImagePath: analysis.sourceImagePath
    }
    const sheets = buildGenerationWorkspace(form, analysis, encoding, [])
      .workbooks.find((book) => book.id === 'generated-product')!.sheets
    const imageCodes = (id: string, column: number): string[] => sheets.find((sheet) => sheet.id === id)!.rows.map((row) => row[column]!.value)
    const barcodeCodes = (id: string): string[] => sheets.find((sheet) => sheet.id === id)!.rows
      .filter((row) => row[3]?.value)
      .map((row) => /\b(?:BG|CJ|CCK|ZJBG)\d+\b/.exec(row[3]!.value)?.[0] ?? '')

    expect(imageCodes('generated-products-other', 6)).toEqual(['BG00009', 'BG00010', 'ZJBG00009', 'ZJBG00010'])
    expect(barcodeCodes('generated-barcodes-other')).toEqual(['BG00009', 'BG00010', 'ZJBG00009', 'ZJBG00010'])
    expect(imageCodes('generated-products-mirror', 7)).toEqual(['CJ00009', 'CJ00010', 'CJ00009', 'CJ00010'])
    expect(barcodeCodes('generated-barcodes-mirror')).toEqual(['CJ00009', 'CJ00010', 'CJ00009', 'CJ00010'])
    expect(imageCodes('generated-products-color', 6)).toEqual(['CCK00009', 'CCK00010'])
    expect(barcodeCodes('generated-barcodes-color')).toEqual(['CCK00009', 'CCK00010'])
  })

  it('exports the real A-K image layout and configurable normal/silver frame rows', () => {
    const analysis = analysisFixture()
    analysis.crops = [analysis.crops[0]!, {
      ...analysis.crops[1]!,
      id: 'mirror-case',
      productCategory: '出镜壳',
      material: '银色片材',
      patternNameEn: 'Lazy Rilakkuma',
      patternNameZh: '慵懒轻松熊'
    }]
    const encoding = encodingFixture()
    encoding.rows = [{
      ...encoding.rows[0]!, cropId: 'mirror-case', productCategory: '出镜壳', patternNameEn: 'Lazy Rilakkuma',
      poolHeader: '出镜壳/出片壳', poolColumn: 'B', prefix: 'CJ', productCode: 'CJ00001'
    }]
    const form: TaskDraftInput = {
      templateName: '可拆卸+其他', seriesNameZh: '轻松熊系列', seriesNameEn: 'Rilakkuma Series', ipRemark: '轻松熊',
      selectedModels: ['iP18 Pro', 'SAM S26U'], modelBrandAssignments: {}, masterImagePath: analysis.sourceImagePath,
      modelSettings: [
        {
          id: 'apple-1', name: 'iP Fold (Duo)', brand: 'apple', enabled: true, silverEnabled: true,
          pricesByCategory: { 出镜壳: { silver: { domestic: 179, overseas: 39.99 } } }
        },
        { id: 'samsung-1', name: 'SAM Fold 8', brand: 'samsung', enabled: true, silverEnabled: false }
      ],
      framePriceRules: {
        出镜壳: {
          normal: { domestic: 149, overseas: 31.99 },
          silver: { domestic: 169, overseas: 36.99 },
          brands: { samsung: { normal: { domestic: 159, overseas: 33.99 } } }
        }
      }
    }

    const workspace = buildGenerationWorkspace(form, analysis, encoding, [])
    expect(workspace.checks.filter((check) => !check.passed)).toEqual([])
    const validated = exportGenerationWorkbookInputSchema.parse({
      suggestedName: 'mirror-case', templateName: form.templateName, workspace,
      sourcePaths: { namingFormula: 'formula.xlsx', barcodeReference: 'barcode.xlsx', domesticNaming: 'domestic.xlsx' },
      imageSource: { path: analysis.sourceImagePath, crops: analysis.crops }, selectedWorkbookIds: ['generated-product']
    })
    const generated = validated.workspace.workbooks.find((item) => item.id === 'generated-product')!
    const images = generated.sheets.find((sheet) => sheet.id === 'generated-products-mirror')!
    const barcodes = generated.sheets.find((sheet) => sheet.id === 'generated-barcodes-mirror')!

    expect(images.columns).toHaveLength(11)
    expect(images.columns[2]).toBe('')
    expect(images.columns[3]).toBe('颜色')
    expect(images.headerCells).toHaveLength(11)
    expect(images.rows).toHaveLength(2)
    expect(images.rows.map((row) => row[2]?.value)).toEqual(['', '银框'])
    expect(images.rows.map((row) => row[3]?.value)).toEqual(['银色片材', '银色片材'])
    expect(images.rows[0]?.[1]?.cropId).toBe('mirror-case')
    expect(images.rows[1]?.[1]?.cropId).toBe('mirror-case')
    expect(images.rows[0]?.[7]?.value).toBe(images.rows[1]?.[7]?.value)

    expect(barcodes.rows).toHaveLength(4)
    expect(barcodes.rows[0]?.[3]?.value).toContain('iP Fold (Duo)')
    expect(barcodes.rows[0]?.[3]?.value).not.toContain('（黑框）')
    expect(barcodes.rows[0]?.[4]?.numericValue).toBe(149)
    expect(barcodes.rows[1]?.[3]?.value).toContain('SAM Fold 8')
    expect(barcodes.rows[1]?.[4]?.numericValue).toBe(159)
    expect(barcodes.rows[2]?.every((cell) => cell.value === '')).toBe(true)
    expect(barcodes.rows[3]?.[3]?.value).toContain('iP Fold (Duo)（银框）')
    expect(barcodes.rows[3]?.[4]?.numericValue).toBe(179)
    expect(barcodes.rows[3]?.[5]?.numericValue).toBe(39.99)
    expect(barcodes.rows.some((row) => row[3]?.value.includes('SAM Fold 8（银框）'))).toBe(false)
  })

  it('puts all normal 出片壳 images before the silver images in a new-series workbook', () => {
    const analysis = analysisFixture()
    analysis.crops = [analysis.crops[0]!, ...analysis.crops.slice(1).map((crop) => ({ ...crop, productCategory: '出片壳' }))]
    const encoding = encodingFixture()
    encoding.rows = encoding.rows.map((row, index) => ({ ...row, productCategory: '出片壳', productCode: `CJ0000${index + 1}` }))
    const form: TaskDraftInput = {
      templateName: '出片壳', seriesNameZh: '测试', seriesNameEn: 'Test Series', ipRemark: '',
      selectedModels: ['iP13 Pro'], modelBrandAssignments: {}, masterImagePath: analysis.sourceImagePath
    }
    const generated = buildGenerationWorkspace(form, analysis, encoding, [])
      .workbooks.find((book) => book.id === 'generated-product')!
    const imageSheet = generated.sheets.find((sheet) => sheet.id === 'generated-products-print')!
    expect(imageSheet.columns).toHaveLength(10)
    expect(imageSheet.columns[3]).toBe('系列名称')
    const images = imageSheet.rows
    expect(images.map((row) => [row[6]?.value, row[2]?.value])).toEqual([
      ['CJ00001', ''], ['CJ00002', ''], ['CJ00001', '银框'], ['CJ00002', '银框']
    ])
    expect(images[2]?.[0]?.value).toContain('（银框）')
    const barcodes = generated.sheets.find((sheet) => sheet.id === 'generated-barcodes-print')!.rows
    expect(barcodes.map((row) => row[3]?.value.includes('（银框）'))).toEqual([false, false, false, true, true])
  })

  it('selects and exports four product templates by category instead of the step-one template', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'casebang-mixed-sheets-'))
    try {
      const categories = ['磁吸背盖', '出镜壳', '出片壳', '出彩壳']
      const codes = ['BG00001', 'CJ00001', 'CJ00002', 'CCK00001']
      const analysis = analysisFixture()
      analysis.sourceImagePath = join(directory, 'source.png')
      await sharp({ create: { width: 1000, height: 1000, channels: 3, background: '#ffffff' } }).png().toFile(analysis.sourceImagePath)
      const crop = analysis.crops[1]!
      analysis.crops = [analysis.crops[0]!, ...categories.map((category, index) => ({
        ...crop, id: `mixed-${index}`, productCategory: category, patternNameEn: `Pattern ${index + 1}`
      }))]
      const encoding = encodingFixture()
      encoding.rows = categories.map((category, index) => ({
        ...encoding.rows[0]!, cropId: `mixed-${index}`, order: index + 1,
        productCategory: category, productCode: codes[index]!
      }))
      const form: TaskDraftInput = {
        templateName: '可拆卸+其他', seriesNameZh: '测试', seriesNameEn: 'Test Series', ipRemark: '',
        selectedModels: ['iP13 Pro'], modelBrandAssignments: {}, masterImagePath: analysis.sourceImagePath
      }
      const workspace = buildGenerationWorkspace(form, analysis, encoding, [])
      const generated = workspace.workbooks.find((book) => book.id === 'generated-product')!
      expect(generated.sheets.map((sheet) => sheet.name)).toEqual([
        '可拆卸+其他图片', '可拆卸+其他条码', '出镜图片', '出镜条码',
        '出片图片', '出片条码', '出彩图片', '出彩条码'
      ])
      expect(generated.sheets.filter((sheet) => sheet.id.startsWith('generated-products-')).map((sheet) => sheet.columns.length)).toEqual([10, 11, 10, 10])
      for (const [index, category] of categories.entries()) {
        const imageSheet = generated.sheets[index * 2]!
        const barcodeSheet = generated.sheets[index * 2 + 1]!
        expect(imageSheet.rows.every((row) => row[0]?.value.includes(category))).toBe(true)
        expect(barcodeSheet.rows.filter((row) => row[3]?.value).every((row) => row[3]?.value.includes(category))).toBe(true)
      }
      expect(generated.sheets[0]?.rows[0]?.[6]?.value).toBe('BG00001')
      expect(generated.sheets[2]?.rows[0]?.[7]?.value).toBe('CJ00001')
      expect(generated.sheets[4]?.rows[0]?.[6]?.value).toBe('CJ00002')
      expect(generated.sheets[6]?.rows[0]?.[6]?.value).toBe('CCK00001')
      expect(workspace.checks.find((check) => check.id === 'generated-product-sheets')?.passed).toBe(true)
      const destination = join(directory, 'generated.xlsx')
      const request = exportGenerationWorkbookInputSchema.parse({
        suggestedName: 'mixed', templateName: form.templateName, workspace,
        sourcePaths: { namingFormula: 'formula.xlsx', barcodeReference: 'barcode.xlsx', domesticNaming: 'domestic.xlsx' },
        imageSource: { path: analysis.sourceImagePath, crops: analysis.crops }, selectedWorkbookIds: ['generated-product']
      })
      await exportFormatPreservingWorkbook(resolve(__dirname, '../resources/generated-product-template.xlsx'), destination, generated, request)
      const entries = await readOoxmlPackage(destination)
      const workbookXml = findPackageText(entries, 'xl/workbook.xml') ?? ''
      expect([...workbookXml.matchAll(/<sheet\b[^>]*name="([^"]+)"/g)].map((match) => match[1])).toEqual(generated.sheets.map((sheet) => sheet.name))
      const relationships = findPackageText(entries, 'xl/_rels/workbook.xml.rels') ?? ''
      const worksheetTargets = [...workbookXml.matchAll(/<sheet\b[^>]*r:id="([^"]+)"/g)].map((match) => {
        const target = new RegExp(`<Relationship\\b[^>]*Id="${match[1]}"[^>]*Target="([^"]+)"`).exec(relationships)?.[1]
        return target ? `xl/${target}` : ''
      })
      expect(new Set(worksheetTargets).size).toBe(8)
      expect(worksheetTargets.every((target) => findPackageText(entries, target) !== null)).toBe(true)
      expect(entries.filter((entry) => /^xl\/drawings\/drawing\d+\.xml$/.test(entry.path) && entry.buffer?.toString().includes('CASEBANG 图片'))).toHaveLength(4)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  it('exports category blocks with ascending product codes in the existing-series flow', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'casebang-region-order-'))
    try {
      const analysis = analysisFixture()
      analysis.sourceImagePath = join(directory, 'source.png')
      analysis.sourceWidth = 100
      analysis.sourceHeight = 100
      const product = analysis.crops[1]!
      // Region order deliberately differs from pixel coordinates and code order.
      analysis.crops = [
        { ...analysis.crops[0]!, x: 0, y: 0, width: 100, height: 100 },
        { ...product, id: 'case-first', productCategory: '出镜壳', patternNameEn: 'Zebra', x: 50, y: 51, width: 40, height: 40 },
        { ...product, id: 'back-first', patternNameEn: 'Moon', x: 0, y: 1, width: 40, height: 40 },
        { ...product, id: 'case-second', productCategory: '出镜壳', patternNameEn: 'Apple', x: 0, y: 50, width: 40, height: 40 },
        { ...product, id: 'back-second', patternNameEn: 'Cloud', x: 50, y: 0, width: 40, height: 40 }
      ]
      const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00']
      await sharp({ create: { width: 100, height: 100, channels: 3, background: '#ffffff' } }).composite(
        await Promise.all(analysis.crops.slice(1).map(async (crop, index) => ({
          input: await sharp({ create: { width: crop.width, height: crop.height, channels: 3, background: colors[index]! } }).png().toBuffer(),
          left: crop.x, top: crop.y
        })))
      ).png().toFile(analysis.sourceImagePath)
      const encoding = encodingFixture()
      encoding.rows = analysis.crops.slice(1).map((crop, index) => ({
        ...encoding.rows[0]!, cropId: crop.id, order: index + 1, patternNameEn: crop.patternNameEn,
        productCategory: crop.productCategory, productCode: `${crop.productCategory === '出镜壳' ? 'CJ' : 'BG'}0000${index + 1}`
      }))
      const form: TaskDraftInput = {
        templateName: '出镜壳', seriesNameZh: '测试', seriesNameEn: 'Test Series', ipRemark: '',
        selectedModels: ['iP13 Pro'], modelBrandAssignments: {}, masterImagePath: analysis.sourceImagePath
      }
      const workspace = appendExistingSeries(buildGenerationWorkspace(form, analysis, encoding, []),
        { sheet: '可拆卸+其他', nameRow: 100, appendColumn: 39, names: [] },
        { code: 'K1', englishName: 'Test Series', chineseName: '测试', referenceRow: 10, referenceSheet: '系列名对应代码', referenceAppendColumn: 4 },
        new Map(analysis.crops.map((crop) => [crop.id, crop.productCategory])), analysis)
      expect(workspace.workbooks.map((book) => book.id)).toEqual(['barcode-reference', 'domestic-naming', 'generated-product'])
      expect(workspace.checks.filter((check) => !check.passed)).toEqual([])
      const request = exportGenerationWorkbookInputSchema.parse({
        suggestedName: 'order', templateName: form.templateName, workspace,
        sourcePaths: { namingFormula: 'formula.xlsx', barcodeReference: 'barcode.xlsx', domesticNaming: 'domestic.xlsx' },
        // Input lookup order must not affect exported order either.
        imageSource: { path: analysis.sourceImagePath, crops: analysis.crops.slice().reverse() }, selectedWorkbookIds: ['generated-product']
      })
      const generated = request.workspace.workbooks.find((book) => book.id === 'generated-product')!
      expect(generated.sheets.map((sheet) => sheet.name)).toEqual(['可拆卸+其他图片', '可拆卸+其他条码', '出镜图片', '出镜条码'])
      const otherImages = generated.sheets.find((sheet) => sheet.id === 'generated-products-other')!
      const mirrorImages = generated.sheets.find((sheet) => sheet.id === 'generated-products-mirror')!
      expect(otherImages.rows.map((row) => row[1]?.cropId)).toEqual(['back-first', 'back-second'])
      expect(otherImages.rows.map((row) => row[6]?.value)).toEqual(['BG00002', 'BG00004'])
      expect(mirrorImages.rows.map((row) => row[1]?.cropId)).toEqual(['case-first', 'case-second', 'case-first', 'case-second'])
      expect(mirrorImages.rows.map((row) => row[7]?.value)).toEqual(['CJ00001', 'CJ00003', 'CJ00001', 'CJ00003'])
      expect(mirrorImages.rows.map((row) => row[2]?.value)).toEqual(['', '', '银框', '银框'])
      const otherBarcodeRows = generated.sheets.find((sheet) => sheet.id === 'generated-barcodes-other')!.rows.filter((row) => row[3]?.value)
      const mirrorBarcodeRows = generated.sheets.find((sheet) => sheet.id === 'generated-barcodes-mirror')!.rows.filter((row) => row[3]?.value)
      expect(otherBarcodeRows.map((row) => row[0]?.value)).toEqual(['单个片材', '单个片材'])
      expect(mirrorBarcodeRows.map((row) => row[0]?.value)).toEqual(['一体壳', '一体壳', '一体壳', '一体壳'])
      expect([...otherBarcodeRows, ...mirrorBarcodeRows].map((row) => row[3]?.value.match(/-(Moon|Cloud|Zebra|Apple) /)?.[1])).toEqual(['Moon', 'Cloud', 'Zebra', 'Apple', 'Zebra', 'Apple'])
      const destination = join(directory, 'export.xlsx')
      await exportFormatPreservingWorkbook(resolve(__dirname, '../resources/generated-product-template.xlsx'), destination, generated, request)
      const entries = await readOoxmlPackage(destination)
      const workbookXml = findPackageText(entries, 'xl/workbook.xml') ?? ''
      expect([...workbookXml.matchAll(/<sheet\b[^>]*name="([^"]+)"/g)].map((match) => match[1])).toEqual([
        '可拆卸+其他图片', '可拆卸+其他条码', '出镜图片', '出镜条码'
      ])
      const worksheetXmls = entries.filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.path)).map((entry) => entry.buffer?.toString() ?? '')
      const otherXml = worksheetXmls.find((xml) => xml.includes('<drawing') && xml.includes('BG00004')) ?? ''
      const mirrorXml = worksheetXmls.find((xml) => xml.includes('<drawing') && xml.includes('CJ00003')) ?? ''
      expect(otherXml).toContain('r="J2"')
      expect(otherXml).not.toMatch(/<c\b[^>]*r="K\d+"/)
      expect(mirrorXml).toContain('r="K2"')
      expect(mirrorXml).not.toContain('BG00004')
      expect(entries.filter((entry) => /^xl\/drawings\/drawing\d+\.xml$/.test(entry.path) && entry.buffer?.toString().includes('CASEBANG 图片'))).toHaveLength(2)
      const drawingEntry = entries.find((entry) => /^xl\/drawings\/drawing\d+\.xml$/.test(entry.path) && entry.buffer?.toString().includes('CASEBANG 图片'))!
      expect(drawingEntry).toBeDefined()
      const drawing = drawingEntry.buffer!.toString()
      const rels = findPackageText(entries, `${posix.dirname(drawingEntry.path)}/_rels/${posix.basename(drawingEntry.path)}.rels`)!
      const anchors = [...drawing.matchAll(/<xdr:oneCellAnchor>[\s\S]*?<\/xdr:oneCellAnchor>/g)].map((match) => match[0])
      const expected = ['back-first', 'back-second']
      expect(anchors).toHaveLength(expected.length + 1)
      // Check actual PNG pixels and anchor coordinates, not just cell labels.
      for (const [index, cropId] of expected.entries()) {
        const anchor = anchors[index + 1]!
        expect(anchor).toContain(`<xdr:row>${index + 1}</xdr:row>`)
        expect(anchor).toContain('<xdr:col>1</xdr:col>')
        const relId = /r:embed="([^"]+)"/.exec(anchor)![1]!
        const target = new RegExp(`<Relationship[^>]*Id="${relId}"[^>]*Target="([^"]+)"`).exec(rels)![1]!
        const media = entries.find((entry) => entry.path === posix.join(posix.dirname(drawingEntry.path), target))!
        const crop = analysis.crops.find((item) => item.id === cropId)!
        const expectedPixels = await sharp(analysis.sourceImagePath).extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height }).removeAlpha().raw().toBuffer()
        expect(await sharp(media.buffer!).removeAlpha().raw().toBuffer()).toEqual(expectedPixels)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  it('keeps the reference model list and stable price defaults', () => {
    expect(REFERENCE_PHONE_MODELS).toHaveLength(38)
    expect(new Set(REFERENCE_PHONE_MODELS).size).toBe(REFERENCE_PHONE_MODELS.length)
    expect(REFERENCE_PHONE_MODELS).toContain('iP18 Pro/17 Pro')
    expect(REFERENCE_PHONE_MODELS).toContain('iP18 Pro Max/17 Pro Max')
    expect(REFERENCE_PHONE_MODELS).not.toContain('iP17 Pro')
    expect(REFERENCE_PHONE_MODELS).not.toContain('iP17 Pro Max')
    expect(productBusinessSpecification('磁吸背盖')).toMatchObject({
      itemClass: '单个片材', suggestedRetailPrice: 89, overseasRetailPrice: 19.99, expandsByModel: true
    })
    expect(productBusinessSpecification('磁吸气囊支架')).toMatchObject({
      itemClass: '支架', suggestedRetailPrice: 59, overseasRetailPrice: 12.99, expandsByModel: false
    })
    expect(productBusinessSpecification('流沙磁吸支架背盖').itemClass).toBe('支架')
    expect(productBusinessSpecification('新款磁吸背盖').itemClass).toBe('单个片材')
    expect(productBusinessSpecification('新款磁吸充电宝').itemClass).toBe('无线充')
    expect(productBusinessSpecification('新款自带线充电宝').itemClass).toBe('自带线')
    expect(productBusinessSpecification('出镜壳')).toMatchObject({ itemClass: '一体壳', suggestedRetailPrice: 129, overseasRetailPrice: 28.99 })
    expect(productBusinessSpecification('出片壳').itemClass).toBe('一体壳')
    expect(productBusinessSpecification('出彩壳').itemClass).toBe('一体壳')
    expect(productBusinessSpecification('奇趣壳').itemClass).toBe('一体壳')
    expect(productBusinessSpecification('Macbook保护壳').itemClass).toBe('一体壳')
    expect(productBusinessSpecification('奇趣礼盒').itemClass).toBe('礼盒套装')
    expect(productBusinessSpecification('奇趣挂绳').itemClass).toBe('挂绳')
    expect(productBusinessSpecification('推卡卡包').itemClass).toBe('卡包')
    expect(productBusinessSpecification('流沙镜头膜')).toMatchObject({ itemClass: '配件', suggestedRetailPrice: 89, overseasRetailPrice: 19.99 })
    expect(BARCODE_PRICE_PRESETS.some((item) => item.suggestedRetailPrice === 89 && item.overseasRetailPrice === 19.99)).toBe(true)
    expect(MATERIAL_COLOR_OPTIONS).toContain('银色片材')
    expect(MATERIAL_COLOR_OPTIONS).toContain('透明片材')
    expect(new Set(BARCODE_ITEM_CLASSES).size).toBe(BARCODE_ITEM_CLASSES.length)
    expect(phoneModelBrand('iP18 Pro/17 Pro')).toBe('apple')
    expect(phoneModelBrand('Mate 80 Pro')).toBe('huawei')
    expect(phoneModelBrand('SAM S26U')).toBe('samsung')
    expect(phoneModelBrand('New Phone X')).toBe('other')
  })

  it('places added models after the reference models within Apple, Samsung, and Huawei', () => {
    const ordered = sortBarcodeModelsByReference([
      { name: 'Mate New', brand: 'huawei' as const },
      { name: 'SAM New', brand: 'samsung' as const },
      { name: 'iP New', brand: 'apple' as const },
      { name: 'P70', brand: 'huawei' as const },
      { name: 'SAM S24', brand: 'samsung' as const },
      { name: 'iP13 Pro Max', brand: 'apple' as const },
      { name: 'iP13 Pro', brand: 'apple' as const }
    ])
    expect(ordered.map((model) => model.name)).toEqual([
      'iP13 Pro', 'iP13 Pro Max', 'iP New',
      'SAM S24', 'SAM New',
      'P70', 'Mate New'
    ])
    const form: TaskDraftInput = {
      templateName: '可拆卸+其他', seriesNameZh: '测试', seriesNameEn: 'Test Series', ipRemark: '',
      selectedModels: ordered.map((model) => model.name).reverse(),
      modelBrandAssignments: Object.fromEntries(ordered.map((model) => [model.name, model.brand])),
      masterImagePath: 'C:\\images\\master.png'
    }
    const barcodeRows = buildGenerationWorkspace(form, analysisFixture(), encodingFixture(), [])
      .workbooks.find((item) => item.id === 'generated-product')!.sheets.find((sheet) => sheet.id === 'generated-barcodes-other')!.rows
    expect(barcodeRows.filter((row) => row[3]?.value.includes('Mint Dot')).map((row) => row[3]?.value.split(' BG00725 ')[1])).toEqual(ordered.map((model) => model.name))
  })

  it('keeps every barcode item class together before starting the next class', () => {
    const categories = [
      { category: '磁吸背盖', itemClass: '单个片材', price: 89, overseas: 19.99, code: 'BG00001' },
      { category: '出彩壳', itemClass: '一体壳', price: 199, overseas: 42.99, code: 'CCK00038' },
      { category: 'CP002磁吸充电宝', itemClass: '无线充', price: 239, overseas: 51.99, code: 'CP00001' },
      { category: 'CP006自带线充电宝', itemClass: '自带线', price: 169, overseas: 36.99, code: 'CP00002' },
      { category: '磁吸气囊支架', itemClass: '支架', price: 59, overseas: 12.99, code: 'ZJ00001' }
    ]
    const analysis = analysisFixture()
    const cropTemplate = analysis.crops[1]!
    analysis.crops = [analysis.crops[0]!, ...categories.map((item, index) => ({
      ...cropTemplate,
      id: `category-${index}`,
      productCategory: item.category,
      suggestedRetailPrice: item.price,
      overseasRetailPrice: item.overseas,
      patternNameEn: `Pattern ${index + 1}`,
      patternNameZh: `图案 ${index + 1}`
    }))]
    const encoding = encodingFixture()
    encoding.rows = categories.map((item, index) => ({
      cropId: `category-${index}`,
      order: index + 1,
      productCategory: item.category,
      patternGroupId: null,
      patternNameEn: `Pattern ${index + 1}`,
      poolHeader: item.category,
      poolColumn: 'A',
      prefix: item.code.replace(/\d+$/, ''),
      previousLatestCode: '',
      productCode: item.code,
      status: 'ready' as const,
      message: '可使用'
    }))
    const form: TaskDraftInput = {
      templateName: '可拆卸+其他', seriesNameZh: '测试系列', seriesNameEn: 'Fluffy Lili Series', ipRemark: '',
      selectedModels: ['iP18 Pro Max/17 Pro Max', 'iP18 Pro/17 Pro'], modelBrandAssignments: {}, masterImagePath: analysis.sourceImagePath
    }

    const generated = buildGenerationWorkspace(form, analysis, encoding, [])
      .workbooks.find((item) => item.id === 'generated-product')!
    expect(generated.sheets.map((sheet) => sheet.name)).toEqual(['可拆卸+其他图片', '可拆卸+其他条码', '出彩图片', '出彩条码'])
    const barcodeRows = generated.sheets.filter((sheet) => sheet.id.startsWith('generated-barcodes-')).flatMap((sheet) => sheet.rows)

    expect(barcodeRows.map((row) => row[0]?.value)).toEqual([
      '单个片材', '单个片材', '无线充', '无线充', '自带线', '支架', '一体壳', '一体壳'
    ])
    expect(barcodeRows[7]?.[3]?.value).toBe(
      'CASEBANG 出彩壳-Fluffy Lili Series#K1系列-Pattern 2 CCK00038 iP18 Pro Max/17 Pro Max'
    )
    expect(barcodeRows[2]?.[3]?.value).toContain('CP002磁吸充电宝')
    expect(barcodeRows[3]?.[3]?.value).toContain('MP16磁吸充电宝')
    expect(barcodeRows[3]?.[3]?.value).toContain('CP00001（10000mAh）')
    expect(barcodeRows[2]?.[4]?.numericValue).toBe(239)
    expect(barcodeRows[3]?.[4]?.numericValue).toBe(299)
  })
})

function analysisFixture(): ImageAnalysisResult {
  return {
    sourceImagePath: 'C:\\images\\master.png',
    fileName: 'master.png',
    sourceWidth: 1_000,
    sourceHeight: 1_000,
    format: 'png',
    previewDataUrl: 'data:image/png;base64,AA==',
    backgroundColor: '#ffffff',
    detectionThreshold: 0.5,
    warnings: [],
    crops: [
      {
        id: 'overview', x: 0, y: 0, width: 300, height: 300,
        role: 'series-overview', label: '全系列主图', productCategory: '待确认',
        suggestedRetailPrice: null, overseasRetailPrice: null, material: '',
        patternGroupId: null, confidence: 1, categoryConfidence: null, categoryReasons: [],
        patternNameEn: '', patternNameZh: '', nameCandidates: []
      },
      {
        id: 'product-1', x: 310, y: 0, width: 200, height: 300,
        role: 'product-pattern', label: '产品 1', productCategory: '磁吸背盖',
        suggestedRetailPrice: 89, overseasRetailPrice: 19.99, material: '银色',
        patternGroupId: null, confidence: 1, categoryConfidence: 1, categoryReasons: [],
        patternNameEn: 'Mint Dot', patternNameZh: '薄荷圆点', nameCandidates: []
      },
      {
        id: 'product-2', x: 520, y: 0, width: 200, height: 300,
        role: 'product-pattern', label: '产品 2', productCategory: '磁吸背盖',
        suggestedRetailPrice: 89, overseasRetailPrice: 19.99, material: '银色',
        patternGroupId: null, confidence: 1, categoryConfidence: 1, categoryReasons: [],
        patternNameEn: 'Lotus Charm', patternNameZh: '莲花魅力', nameCandidates: []
      }
    ]
  }
}

function encodingFixture(): EncodingPreviewResult {
  return {
    generatedAt: new Date().toISOString(),
    seriesCode: 'K1',
    recommendedSeriesCode: 'K1',
    seriesCodeWithSuffix: 'K1系列',
    seriesCodeStatus: 'new',
    seriesCodeMessage: '使用下一条可用系列码',
    usedSeriesCodes: ['K0'],
    seriesCodeReservePlan: { anchorCode: 'K1', requiredReserveCount: 10, availableReserveCodes: [], supplementWrites: [] },
    rows: [{
      cropId: 'product-1', order: 1, productCategory: '磁吸背盖', patternGroupId: null,
      patternNameEn: 'Mint Dot', poolHeader: '磁吸背盖', poolColumn: 'A', prefix: 'BG',
      previousLatestCode: 'BG00724', productCode: 'BG00725', status: 'ready', message: '可使用'
    }, {
      cropId: 'product-2', order: 2, productCategory: '磁吸背盖', patternGroupId: null,
      patternNameEn: 'Lotus Charm', poolHeader: '磁吸背盖', poolColumn: 'A', prefix: 'BG',
      previousLatestCode: 'BG00725', productCode: 'BG00726', status: 'ready', message: '可使用'
    }],
    pools: [{ header: '磁吸背盖', column: 'A', prefixes: ['BG'], usedCount: 1, latestCode: 'BG00724', usedCodes: ['BG00724'] }],
    warnings: [],
    referencePreview: {
      seriesSheetName: '系列名对应代码',
      seriesRows: [
        { row: 1, values: ['系列名代码', '系列名（英）', '系列名', '图片'] },
        { row: 2, values: ['K0', 'Signature Series', '签名系列', ''] },
        { row: 3, values: ['K1', '', '', ''] }
      ],
      usedCodeSheetName: '已使用编码',
      usedCodeHeaderRow: 15,
      usedCodeRows: [
        { row: 15, values: ['磁吸背盖'] },
        { row: 16, values: ['BG00724/Signature Series#K0系列'] }
      ]
    }
  }
}
