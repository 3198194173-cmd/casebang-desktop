import type { BarcodeModelSetting, BarcodePricePair, DomesticPatternNameRecord, ProductImageMappingIndex, TaskDraftInput } from '@shared/contracts'
import type { EncodingPreviewResult, EncodingPreviewRow } from '@shared/coding-contracts'
import type { GenerationQualityCheck, GenerationWorkspaceData, PreviewCell, PreviewSheet, PreviewWorkbook } from '@shared/generation-contracts'
import type { CropBox, ImageAnalysisResult } from '@shared/image-contracts'
import { buildSeriesCodeReservePlan, resolveNextSeriesRecord } from '@shared/series-code'
import { BARCODE_MODEL_BRAND_ORDER, isPairedWireless, wirelessPrices, phoneModelBrand, productBusinessSpecification, REFERENCE_PHONE_MODELS, type PhoneModelBrand } from '@shared/product-business-rules'
import { buildProductImageMapping } from './product-image-mapping-builder'

const USED_CODE_HEADERS = ['磁吸背盖', '出镜壳/出片壳', '出彩壳', '磁吸支架背盖', '磁吸气囊支架', 'CP002/MP16磁吸充电宝', 'CP006自带线移动电源', 'iPad保护壳', 'Macbook保护壳', '卡包', '奇趣礼盒', '奇趣壳', '奇趣气囊支架', '奇趣挂绳', '镜头框', '镜头膜']

interface GeneratedProductRow {
  crop: CropBox
  code: string
  barcode: string
  patternUpper: string
  fileName: string
}

export function buildGenerationWorkspace(form: TaskDraftInput, analysis: ImageAnalysisResult, encoding: EncodingPreviewResult, domesticNames: DomesticPatternNameRecord[], mappingIndex?: ProductImageMappingIndex): GenerationWorkspaceData {
  const overview = analysis.crops.find((crop) => crop.role === 'series-overview')
  const products = orderProductsForTemplate(analysis.crops.filter((crop) => crop.role !== 'series-overview'))
  const encodingByCrop = new Map(encoding.rows.map((row) => [row.cropId, row]))
  const seriesCode = encoding.seriesCode || encoding.recommendedSeriesCode
  const seriesDisplay = `${form.seriesNameEn}#${seriesCode}系列`
  const seriesUpper = compactUppercase(form.seriesNameEn)
  const expandedProducts = orderProductsForTemplate(products.flatMap((crop) => {
    if (!isPairedWireless(crop.productCategory)) return [crop]
    const prices = wirelessPrices(crop)
    return [
      { ...crop, productCategory: 'CP002磁吸充电宝', suggestedRetailPrice: prices.cp002.retail, overseasRetailPrice: prices.cp002.overseas },
      { ...crop, productCategory: 'MP16磁吸充电宝', suggestedRetailPrice: prices.mp16.retail, overseasRetailPrice: prices.mp16.overseas }
    ]
  }))
  const productRows = expandedProducts.map((crop) => {
    const code = encodingByCrop.get(crop.id)?.productCode ?? ''
    const suffix = productBusinessSpecification(crop.productCategory).materialNameSuffix ?? ''
    return {
      crop,
      code,
      barcode: `CASEBANG ${crop.productCategory}-${seriesDisplay}-${crop.patternNameEn}${code ? ` ${code}` : ''}${suffix}`.trim(),
      patternUpper: compactUppercase(crop.patternNameEn),
      fileName: `${seriesUpper}#${seriesCode}系列#${code}#${compactUppercase(crop.patternNameEn)}`
    }
  })
  const readyRows = encoding.rows
    .filter((row) => row.status === 'ready' && Boolean(row.poolColumn) && Boolean(row.productCode))
    .map((row) => ({ ...row }))
    .sort((left, right) => left.order - right.order)

  const barcodeSheets = buildBarcodeReferenceSheets(form, encoding, readyRows, overview, seriesDisplay)
  const reservePlan = buildSeriesCodeReservePlan(encoding.referencePreview?.seriesRows ?? [], seriesCode)
  const usedCodeSheet = barcodeSheets.find((sheet) => sheet.id === 'used-codes')
  const expectedUsedCodeColumns = new Set(readyRows.flatMap((row) => row.poolColumn ? [columnIndex(row.poolColumn)] : []))
  const plannedUsedCodeColumns = new Set(usedCodeSheet?.rows.flatMap((row) => row.flatMap((item, column) => item.changed && item.value ? [column] : [])) ?? [])
  const workbooks: PreviewWorkbook[] = ([
    { id: 'barcode-reference', name: 'A条码参考', role: '按源工作簿的两个真实工作表并显示实际新增行。', sheets: barcodeSheets },
    { id: 'domestic-naming', name: '国内命名表', role: '对应“可拆卸+其他”：上图下名，首列保留全系列主图；图案组只取首图。', sheets: [buildDomesticNamingSheet(overview, domesticDisplayCrops(products), seriesDisplay, domesticNames)] },
    { id: 'generated-product', name: '新建产品表', role: '先生成图片表，再由图片表条码名组合机型生成条码表。', sheets: [buildProductSheet(form, overview, productRows, seriesCode, seriesUpper), buildBarcodeSheet(form, productRows)] }
  ] satisfies PreviewWorkbook[]).map((workbook) => ({ ...workbook, sheets: workbook.sheets.map(sealSheetWritePlan) }))
  if (mappingIndex) {
    const mapping = buildProductImageMapping(form, seriesCode, productRows, mappingIndex)
    if (mapping.sheets.length) workbooks.push({ ...mapping, sheets: mapping.sheets.map(sealSheetWritePlan) })
  }
  const codes = productRows.map((row) => row.code).filter(Boolean)
  const enabledModels = orderedBarcodeModels(form)
  const barcodeRows = buildBarcodeRows(form, productRows)
  const priceIssues = barcodePriceIssues(form, productRows)
  const imageVariants = expandProductImageRows(productRows)
  const normalImageCount = imageVariants.filter((item) => item.frame === 'normal').length
  const silverImageCount = imageVariants.filter((item) => item.frame === 'silver').length
  const populatedBarcodeRows = barcodeRows.filter((row) => row[3]?.value)
  const normalBarcodeCount = populatedBarcodeRows.filter((row) => !row[3]?.value.includes('（银框）')).length
  const silverBarcodeCount = populatedBarcodeRows.filter((row) => row[3]?.value.includes('（银框）')).length
  const checks: GenerationQualityCheck[] = [
    check('base-safety', '基础表安全更新已启用', true, '05 导出可按选择生成副本，或在自动备份后覆盖 A 条码参考和国内命名表。'),
    check('overview', '全系列主图唯一', analysis.crops.filter((crop) => crop.role === 'series-overview').length === 1, overview ? '已确认 1 张全系列主图。' : '需要且只能保留 1 张全系列主图。'),
    check('source-layout', '真实表格结构已匹配', Boolean(encoding.referencePreview), '已读取 A条码参考的真实行号、表头和历史数据。'),
    check('series-code-reserve', '系列码预留已自动补足', reservePlan.availableReserveCodes.length + reservePlan.supplementWrites.length === reservePlan.requiredReserveCount, `覆盖后保留 ${reservePlan.requiredReserveCount} 个可用系列码；本次自动补充 ${reservePlan.supplementWrites.length} 个。`),
    check('product-count', '产品数量对齐', products.length > 0 && products.length === encoding.rows.length, `图案 ${products.length} 项，产品 ${productRows.length} 项；无线充每图共用 PB 编码并生成 CP002 / MP16 两项。`),
    check('required-fields', '必填字段完整', productRows.every((row) => row.crop.productCategory !== '待确认' && row.crop.patternNameEn.trim() && row.code), '检查产品类别、英文图案名和产品编码。'),
    check('barcode-prices', '条码价格完整', priceIssues.length === 0, priceIssues.length ? `缺少有效价格：${priceIssues.slice(0, 6).join('；')}${priceIssues.length > 6 ? `；另有 ${priceIssues.length - 6} 项` : ''}` : '建议零售价和海外零售价已按产品类别、框型、品牌与机型逐级检查。'),
    check('barcode-models', '条码机型已确认', productRows.every((row) => !productBusinessSpecification(row.crop.productCategory).expandsByModel || enabledModels.length > 0), `本次选用 ${enabledModels.length} 个机型。`),
    check('frame-variant-counts', '普通款与银框款数量已核对', true, `图片表：普通款 ${normalImageCount} 行、银框款 ${silverImageCount} 行；条码表：普通款 ${normalBarcodeCount} 行、银框款 ${silverBarcodeCount} 行。`),
    check('code-rule', '产品编码规则完整', codes.length === productRows.length, `已检查 ${codes.length} 条产品编码；编码格式为 5 位数字序列。`),
    check('used-code-columns', '已使用编码按类别列完整写入', [...expectedUsedCodeColumns].every((column) => plannedUsedCodeColumns.has(column)), `本次涉及 ${expectedUsedCodeColumns.size} 个编码类别列，生成计划已逐列核对。`),
    check('sealed-write-plan', '预览与覆盖共用坐标计划', workbooks.every((workbook) => workbook.sheets.every(hasSealedWritePlan)), '04 中每个绿色单元格均已锁定 Excel 坐标；05 只能执行这些坐标。'),
    check('generated-product-sheets', '新建产品表结构完整', workbooks.find((item) => item.id === 'generated-product')?.sheets.map((sheet) => sheet.name).join('/') === '图片/条码', `先生成图片表 ${productRows.length} 行，再生成条码表 ${buildBarcodeRows(form, productRows).length} 行。`),
    check('three-outputs', '输出工作簿已建立', workbooks.length >= 3 && barcodeSheets.length === 2, `已建立 ${workbooks.length} 个工作簿预览；K3 仅接收本次产品图片和名称。`)
  ]
  return { title: `${form.seriesNameEn}#${seriesCode}系列-表格更新`, generatedAt: new Date().toISOString(), workbooks, checks }
}

function buildBarcodeReferenceSheets(
  form: TaskDraftInput,
  encoding: EncodingPreviewResult,
  readyRows: Array<EncodingPreviewRow>,
  overview: CropBox | undefined,
  seriesDisplay: string
): PreviewSheet[] {
  const preview = encoding.referencePreview
  const seriesHeaders = normalizeColumnHeaders(preview?.seriesRows[0]?.values ?? [], ['系列名代码', '系列名（英）', '系列名', '图片'], 4)

  const seriesRowsSource = preview?.seriesRows ?? []
  const seriesTargetRow = resolveSeriesCodeRow(seriesRowsSource, encoding.seriesCode, form.seriesNameEn, form.seriesNameZh)
  const reservePlan = buildSeriesCodeReservePlan(seriesRowsSource, encoding.seriesCode)
  const supplementsByRow = new Map(reservePlan.supplementWrites.map((write) => [write.row, write.code]))
  const rawSeriesRows = seriesRowsSource.map((item) => item)
  const seriesEndRow = Math.max(seriesTargetRow, rawSeriesRows.at(-1)?.row ?? 1, ...reservePlan.supplementWrites.map((write) => write.row))
  const sourceSeriesByRow = new Map(rawSeriesRows.map((item) => [item.row, item.values.slice(0, 4)]))
  const seriesRows = Array.from({ length: Math.max(0, seriesEndRow - 1) }, (_, offset) => {
    const rowNumber = offset + 2
    const source = sourceSeriesByRow.get(rowNumber) ?? ['', '', '', '']
    if (rowNumber !== seriesTargetRow) {
      const supplement = supplementsByRow.get(rowNumber)
      return source.map((value, column) => column === 0 && supplement ? cell(supplement, true) : cell(displaySourceValue(value)))
    }
    return [
      cell(encoding.seriesCode, true),
      cell(form.seriesNameEn, true),
      cell(form.seriesNameZh, true),
      overview ? imageCell(overview, true, stretchImageLayout(260, 80)) : cell('', true)
    ]
  })

  const usedHeaderRow = preview?.usedCodeHeaderRow ?? 1
  const existingRows = preview?.usedCodeRows?.filter((item) => item.row > usedHeaderRow) ?? []
  const existingByRow = new Map(existingRows.map((item) => [item.row, item.values.slice(0, USED_CODE_HEADERS.length)]))
  const lastExistingRow = existingRows.at(-1)?.row ?? usedHeaderRow
  const existingUsedRowsByColumn = byColumnRows(usedHeaderRow, existingRows, USED_CODE_HEADERS.length, (value) => parseLastCodeRow(value))

  const assignmentsByColumn = new Map<number, string[]>()
  for (const row of readyRows) {
    if (!row.poolColumn || !row.productCode) continue
    const column = columnIndex(row.poolColumn)
    const list = assignmentsByColumn.get(column) ?? []
    list.push(row.productCode)
    assignmentsByColumn.set(column, list)
  }

  const insertedByColumn = new Map<number, Map<number, string>>()
  for (const [column, list] of assignmentsByColumn.entries()) {
    // The reference sheet records the final allocated number per product type,
    // rather than one line for every pattern in the same type.
    const productCode = list.at(-1)
    if (!productCode) continue
    // Always write immediately below the last valid code in this exact column.
    // Do not search for an earlier blank cell: historical sheets contain gaps
    // and those gaps must not become the insertion point.
    const next = (existingUsedRowsByColumn.get(column) ?? usedHeaderRow) + 1
    const value = `${productCode}/${seriesDisplay}`
    const existsInColumn = new Set(Array.from(existingByRow.values()).map((values) => values[column] ?? ''))
    if (existsInColumn.has(value)) continue
    insertedByColumn.set(column, new Map([[next, value]]))
  }

  const usedEndRow = Math.max(
    usedHeaderRow,
    lastExistingRow,
    ...Array.from(insertedByColumn.values(), (rowMap) => [...rowMap.keys()].length ? Math.max(...rowMap.keys()) : usedHeaderRow)
  )
  const usedRows = Array.from({ length: Math.max(0, usedEndRow - usedHeaderRow) }, (_, offset) => {
    const rowNumber = usedHeaderRow + offset + 1
    const sourceValues = existingByRow.get(rowNumber) ?? Array.from({ length: USED_CODE_HEADERS.length }, () => '')
    return Array.from({ length: USED_CODE_HEADERS.length }, (_, column) => {
      const inserted = insertedByColumn.get(column)?.get(rowNumber)
      if (inserted === undefined) return usedCodeCell(sourceValues[column] ?? '')
      return cell(inserted, true)
    })
  })

  return [
    { id: 'series-code', name: preview?.seriesSheetName ?? '系列名对应代码', columns: seriesHeaders, rows: seriesRows, startRow: 1, showBusinessHeader: true, columnWidths: [110, 230, 190, 190] },
    { id: 'used-codes', name: preview?.usedCodeSheetName ?? '已使用编码', columns: normalizeColumnHeaders(preview?.usedCodeRows?.find((item) => item.row === usedHeaderRow)?.values ?? USED_CODE_HEADERS, USED_CODE_HEADERS, 16), rows: usedRows, startRow: usedHeaderRow, showBusinessHeader: true, columnWidths: Array.from({ length: 16 }, () => 245) }
  ]
}

function buildDomesticNamingSheet(overview: CropBox | undefined, products: CropBox[], seriesDisplay: string, domesticNames: DomesticPatternNameRecord[]): PreviewSheet {
  const images = [...(overview ? [overview] : []), ...products]
  const names = [seriesDisplay, ...products.map((crop) => crop.patternNameEn)]
  const lastHistoricalRow = Math.max(
    1,
    ...domesticNames
      .filter((record) => normalize(record.sheetName) === normalize('可拆卸+其他'))
      .map((record) => Number((/\d+/.exec(record.cellAddress) ?? [])[0] ?? 1))
  )
  return {
    id: 'domestic-naming-updates',
    name: '可拆卸+其他',
    columns: images.map((_, index) => columnName(index + 1)),
    rows: [
      images.map((crop) => imageCell(crop, true, containerImageLayout({
        containerWidthPx: 205,
        containerHeightPx: 170,
        imageWidth: crop.width,
        imageHeight: crop.height
      }))),
      names.map((name) => cell(name, true))
    ],
    startRow: lastHistoricalRow + 1,
    showBusinessHeader: false,
    columnWidths: images.map(() => 205),
    rowHeights: [170, 46]
  }
}

function buildProductSheet(
  form: TaskDraftInput,
  overview: CropBox | undefined,
  rows: GeneratedProductRow[],
  seriesCode: string,
  seriesUpper: string
): PreviewSheet {
  const headerCells: PreviewCell[] = [
    cell('条码名', true),
    overview ? imageCell(overview, true, containerImageLayout({
      containerWidthPx: 120,
      containerHeightPx: 92,
      imageWidth: overview.width,
      imageHeight: overview.height
    })) : cell('', true),
    cell('', true),
    cell('颜色', true),
    cell('系列名称', true),
    cell('系列名称（大写）', true),
    cell('系列编码', true),
    cell('产品编码', true),
    cell('图片对应名称', true),
    cell('图片对应名称（大写）', true),
    cell('图档名', true)
  ]
  const imageRows = expandProductImageRows(rows)
  return {
    id: 'generated-products',
    name: '图片',
    columns: ['条码名', '图片', '', '颜色', '系列名称', '系列名称（大写）', '系列编码', '产品编码', '图片对应名称', '图片对应名称（大写）', '图档名'],
    headerCells,
    rows: imageRows.map(({ row: { crop, code, barcode, patternUpper, fileName }, frame }) => [
      cell(barcode, true),
      imageCell(crop, true, containerImageLayout({
        containerWidthPx: 120,
        containerHeightPx: 92,
        imageWidth: crop.width,
        imageHeight: crop.height
      })),
      cell(frame === 'silver' ? '银框' : '', true),
      cell(crop.material || defaultColor(crop.productCategory), true),
      cell(form.seriesNameEn, true),
      cell(seriesUpper, true),
      cell(`${seriesCode}系列`, true),
      cell(code, true),
      cell(crop.patternNameEn, true),
      cell(patternUpper, true),
      cell(fileName, true)
    ]),
    startRow: 1,
    showBusinessHeader: true,
    columnWidths: [460, 120, 86, 90, 210, 220, 105, 125, 210, 230, 330],
    rowHeights: imageRows.map(() => 92)
  }
}

function expandProductImageRows(rows: GeneratedProductRow[]): Array<{ row: GeneratedProductRow; frame: 'normal' | 'silver' }> {
  const result: Array<{ row: GeneratedProductRow; frame: 'normal' | 'silver' }> = []
  const categories = [...new Set(rows.map((row) => row.crop.productCategory))]
  for (const category of categories) {
    const categoryRows = rows.filter((row) => row.crop.productCategory === category)
    result.push(...categoryRows.map((row) => ({ row, frame: 'normal' as const })))
    if (usesSilverFrame(category)) result.push(...categoryRows.map((row) => ({ row, frame: 'silver' as const })))
  }
  return result
}

function buildBarcodeSheet(form: TaskDraftInput, rows: GeneratedProductRow[]): PreviewSheet {
  const barcodeRows = buildBarcodeRows(form, rows)
  return {
    id: 'generated-barcodes',
    name: '条码',
    columns: ['类目', '69码', '物料编码（工厂）', '物料名称', '建议零售价', '海外零售价', '材质', '备注（IP）', '名称对应'],
    rows: barcodeRows,
    startRow: 1,
    showBusinessHeader: true,
    columnWidths: [90, 160, 180, 560, 105, 105, 90, 160, 180],
    rowHeights: barcodeRows.map(() => 24)
  }
}

function buildBarcodeRows(form: TaskDraftInput, rows: GeneratedProductRow[]): PreviewCell[][] {
  const result: PreviewCell[][] = []
  const groups = new Map<string, GeneratedProductRow[]>()
  for (const row of rows) {
    const itemClass = productBusinessSpecification(row.crop.productCategory).itemClass
    groups.set(itemClass, [...(groups.get(itemClass) ?? []), row])
  }

  // Barcode rows are category-major. A category must be completely emitted
  // before the next category starts; model-major ordering only applies inside
  // one category. This prevents single sheets and integrated cases from being
  // interleaved for every selected phone model.
  const preferredItemClassOrder = ['单个片材', '一体壳', '无线充', '自带线', '支架']
  const orderedItemClasses = [
    ...preferredItemClassOrder.filter((itemClass) => groups.has(itemClass)),
    ...[...groups.keys()].filter((itemClass) => !preferredItemClassOrder.includes(itemClass))
  ]
  const models = orderedBarcodeModels(form)
  for (const itemClass of orderedItemClasses) {
    const groupRows = groups.get(itemClass) ?? []
    const modelRows = groupRows.filter((row) => productBusinessSpecification(row.crop.productCategory).expandsByModel)
    const standardRows = groupRows.filter((row) => !productBusinessSpecification(row.crop.productCategory).expandsByModel)
    for (const model of models) {
      for (const row of modelRows) result.push(buildBarcodeRow(form, row, model, 'normal'))
    }
    for (const row of standardRows) result.push(buildBarcodeRow(form, row, null, 'normal'))
    const silverRows = modelRows.filter((row) => usesSilverFrame(row.crop.productCategory))
    const silverModels = models.filter((model) => model.silverEnabled)
    if (silverRows.length > 0 && silverModels.length > 0) {
      if (result.length > 0) result.push(Array.from({ length: 9 }, () => cell('', true)))
      for (const model of silverModels) {
        for (const row of silverRows) result.push(buildBarcodeRow(form, row, model, 'silver'))
      }
    }
  }
  return result
}

function orderedBarcodeModels(form: TaskDraftInput): BarcodeModelSetting[] {
  const brandRank = new Map<PhoneModelBrand, number>(BARCODE_MODEL_BRAND_ORDER.map((brand, index) => [brand, index]))
  const referenceRank = new Map<string, number>(REFERENCE_PHONE_MODELS.map((model, index) => [model, index]))
  const settings: BarcodeModelSetting[] = form.modelSettings?.length
    ? form.modelSettings.filter((model) => model.enabled && model.name.trim())
    : [...new Set(form.selectedModels)].map((name, index) => ({
        id: 'legacy-' + index + '-' + name,
        name,
        brand: form.modelBrandAssignments[name] ?? phoneModelBrand(name),
        enabled: true,
        silverEnabled: true
      }))
  return settings.map((setting, selectedIndex) => ({
    ...setting,
    selectedIndex,
    referenceIndex: referenceRank.get(setting.name)
  })).sort((left, right) => {
    const byBrand = (brandRank.get(left.brand) ?? 999) - (brandRank.get(right.brand) ?? 999)
    if (byBrand !== 0) return byBrand
    const leftIndex = left.referenceIndex ?? REFERENCE_PHONE_MODELS.length + left.selectedIndex
    const rightIndex = right.referenceIndex ?? REFERENCE_PHONE_MODELS.length + right.selectedIndex
    return leftIndex - rightIndex
  }).map(({ selectedIndex: _selectedIndex, referenceIndex: _referenceIndex, ...item }) => item)
}

function buildBarcodeRow(form: TaskDraftInput, row: GeneratedProductRow, model: BarcodeModelSetting | null, frame: 'normal' | 'silver'): PreviewCell[] {
  const specification = productBusinessSpecification(row.crop.productCategory)
  const materialName = row.barcode + (model ? ' ' + model.name : '') + (frame === 'silver' ? '（银框）' : '')
  const price = resolveBarcodePrice(form, row, model, frame)
  return [
    cell(specification.itemClass, true),
    cell('', true),
    cell('', true),
    cell(materialName, true),
    priceCell(price.domestic, '￥'),
    priceCell(price.overseas, 'US$'),
    cell(row.crop.material, true),
    cell(form.ipRemark, true),
    cell('', true)
  ]
}

function resolveBarcodePrice(form: TaskDraftInput, row: GeneratedProductRow, model: BarcodeModelSetting | null, frame: 'normal' | 'silver'): BarcodePricePair {
  const category = row.crop.productCategory
  const categoryRule = form.framePriceRules?.[category]
  const modelRule = model?.pricesByCategory?.[category]?.[frame]
  const brandRule = model ? categoryRule?.brands?.[model.brand]?.[frame] : undefined
  const categoryFrameRule = categoryRule?.[frame]
  const fallback = usesSilverFrame(category)
    ? frame === 'silver'
      ? { domestic: 169, overseas: 36.99 }
      : { domestic: 149, overseas: 31.99 }
    : { domestic: row.crop.suggestedRetailPrice, overseas: row.crop.overseasRetailPrice }
  return {
    domestic: firstPrice(modelRule?.domestic, brandRule?.domestic, categoryFrameRule?.domestic, fallback.domestic),
    overseas: firstPrice(modelRule?.overseas, brandRule?.overseas, categoryFrameRule?.overseas, fallback.overseas)
  }
}

function barcodePriceIssues(form: TaskDraftInput, rows: GeneratedProductRow[]): string[] {
  const issues: string[] = []
  const models = orderedBarcodeModels(form)
  for (const row of rows) {
    const specification = productBusinessSpecification(row.crop.productCategory)
    const targets: Array<{ model: BarcodeModelSetting | null; frame: 'normal' | 'silver' }> = specification.expandsByModel
      ? models.flatMap((model) => [
          { model, frame: 'normal' as const },
          ...(usesSilverFrame(row.crop.productCategory) && model.silverEnabled ? [{ model, frame: 'silver' as const }] : [])
        ])
      : [{ model: null, frame: 'normal' }]
    for (const target of targets) {
      const price = resolveBarcodePrice(form, row, target.model, target.frame)
      if (validPrice(price.domestic) && validPrice(price.overseas)) continue
      issues.push(`${row.crop.productCategory} / ${target.model?.name ?? '通用'} / ${target.frame === 'silver' ? '银框款' : '普通款'}`)
    }
  }
  return [...new Set(issues)]
}

function firstPrice(...values: Array<number | null | undefined>): number | null {
  return values.find((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0) ?? null
}

function usesSilverFrame(category: string): boolean {
  const normalized = normalize(category)
  return normalized.includes(normalize('出镜壳')) || normalized.includes(normalize('出片壳'))
}

function containerImageLayout(layout: { containerWidthPx: number; containerHeightPx: number; imageWidth: number; imageHeight: number }): NonNullable<PreviewCell['imageLayout']> {
  const fitted = fitImage(layout.containerWidthPx, layout.containerHeightPx, layout.imageWidth, layout.imageHeight)
  return {
    containerWidthPx: layout.containerWidthPx,
    containerHeightPx: layout.containerHeightPx,
    imageWidthPx: fitted.width,
    imageHeightPx: fitted.height
  }
}

function stretchImageLayout(containerWidthPx: number, containerHeightPx: number): NonNullable<PreviewCell['imageLayout']> {
  return {
    containerWidthPx,
    containerHeightPx,
    imageWidthPx: containerWidthPx,
    imageHeightPx: containerHeightPx,
    fitMode: 'stretch'
  }
}

function fitImage(containerWidth: number, containerHeight: number, imageWidth: number, imageHeight: number): { width: number; height: number } {
  if (imageWidth <= 0 || imageHeight <= 0 || containerWidth <= 0 || containerHeight <= 0) {
    return { width: Math.max(containerWidth, 1), height: Math.max(containerHeight, 1) }
  }
  const scale = Math.min(containerWidth / imageWidth, containerHeight / imageHeight)
  return {
    width: Math.max(1, Math.round(imageWidth * scale)),
    height: Math.max(1, Math.round(imageHeight * scale))
  }
}

function byColumnRows(
  headerRow: number,
  rows: Array<{ row: number; values: string[] }>,
  columnCount: number,
  selector: (value: string) => number
): Map<number, number> {
  const result = new Map<number, number>()
  for (let column = 0; column < columnCount; column += 1) {
    const candidates = rows
      .filter((item) => selector(item.values[column] ?? '') > 0)
      .map((item) => item.row)
    if (candidates.length > 0) result.set(column, Math.max(...candidates))
    else result.set(column, headerRow)
  }
  return result
}

function resolveSeriesCodeRow(
  rows: Array<{ row: number; values: string[] }>,
  _seriesCode: string,
  _seriesNameEn: string,
  _seriesNameZh: string
): number {
  return resolveNextSeriesRecord(rows).row
}

function parseLastCodeRow(value: string): number {
  const match = /([A-Z]{2,8})(\d{5})/i.exec(value)
  if (!match?.[1] || !match?.[2]) return 0
  return Number(match[2]!)
}

function cell(value: string, changed = false): PreviewCell { return { value, changed } }
function numberCell(numericValue: number, value: string): PreviewCell { return { value, numericValue, changed: true } }
function priceCell(value: number | null, currency: '￥' | 'US$'): PreviewCell {
  return value === null ? cell('', true) : numberCell(value, `${currency}${value.toFixed(2)}`)
}
function validPrice(value: number | null): boolean { return typeof value === 'number' && Number.isFinite(value) && value > 0 }

function sealSheetWritePlan(sheet: PreviewSheet): PreviewSheet {
  const startRow = sheet.startRow ?? 1
  const dataStartRow = startRow + (sheet.showBusinessHeader !== false ? 1 : 0)
  return {
    ...sheet,
    headerCells: sheet.headerCells?.map((cell, column) => cell.changed || cell.writeOnly
      ? { ...cell, targetAddress: `${columnName(column + 1)}${startRow}` }
      : cell),
    rows: sheet.rows.map((row, rowIndex) => row.map((cell, column) => cell.changed || cell.writeOnly
      ? { ...cell, targetAddress: `${columnName(column + 1)}${dataStartRow + rowIndex}` }
      : cell))
  }
}

function hasSealedWritePlan(sheet: PreviewSheet): boolean {
  return [...(sheet.headerCells ?? []), ...sheet.rows.flat()].every((cell) => !(cell.changed || cell.writeOnly) || Boolean(cell.targetAddress))
}
function usedCodeCell(value: string): PreviewCell {
  // Historical bare numbers are not valid product codes and must be removed
  // from the output copy so they do not appear as false allocations.
  return /^\d+$/.test(value.trim()) ? { value: '', writeOnly: true } : cell(displaySourceValue(value))
}
function imageCell(crop: CropBox, changed = false, layout?: NonNullable<PreviewCell['imageLayout']>): PreviewCell {
  return { value: crop.label || crop.id, cropId: crop.id, changed, imageLayout: layout }
}
function check(id: string, label: string, passed: boolean, detail: string): GenerationQualityCheck { return { id, label, passed, detail } }
function normalizeColumnHeaders(values: string[], fallback: string[], expectedLength = 16): string[] {
  return Array.from({ length: expectedLength }, (_, index) => {
    const normalized = (values[index] ?? '').trim()
    return normalized.length > 0 ? normalized : (fallback[index]?.trim() || `列${index + 1}`)
  })
}
function compactUppercase(value: string): string { return value.toLocaleUpperCase('en-US').replace(/\s+/g, '') }
function defaultColor(category: string): string { return category === '磁吸气囊支架' ? '透明' : '' }
function normalize(value: string): string { return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s/\\#（）()_-]+/g, '') }
function columnIndex(column: string): number { return Math.max(0, column.toUpperCase().charCodeAt(0) - 65) }
function displaySourceValue(value: string): string { return /^=DISPIMG/i.test(value) ? '原表图片' : value }

const PRODUCT_CATEGORY_ORDER = [
  '磁吸背盖', '出镜壳', '出片壳', '出彩壳', 'CP002磁吸充电宝', 'MP16磁吸充电宝', 'CP006自带线移动电源',
  '磁吸支架背盖', '流沙磁吸支架背盖', '磁吸气囊支架', '推卡卡包', '卡包', 'iPad保护壳', 'Macbook保护壳',
  '奇趣礼盒', '奇趣壳', '奇趣气囊支架', '奇趣挂绳', '镜头框', '镜头膜', '流沙镜头膜'
]

function orderProductsForTemplate(products: CropBox[]): CropBox[] {
  const order = new Map(PRODUCT_CATEGORY_ORDER.map((category, index) => [normalize(category), index]))
  return products.slice().sort((left, right) => {
    const leftOrder = order.get(normalize(left.productCategory)) ?? PRODUCT_CATEGORY_ORDER.length
    const rightOrder = order.get(normalize(right.productCategory)) ?? PRODUCT_CATEGORY_ORDER.length
    // Stable category sort: region order is the user's displayed crop order.
    // Resizing a crop (or a few pixels of detection jitter) must not reorder it.
    return leftOrder - rightOrder
  })
}

function domesticDisplayCrops(products: CropBox[]): CropBox[] {
  const seenGroups = new Set<string>()
  return products.filter((crop) => {
    if (!crop.patternGroupId) return true
    if (seenGroups.has(crop.patternGroupId)) return false
    seenGroups.add(crop.patternGroupId)
    return true
  })
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
