import { z } from 'zod'
import { isValidEnglishPatternName } from './pattern-name'

export const baseFileKindSchema = z.enum([
  'namingFormula',
  'barcodeReference',
  'domesticNaming',
  'productImageMapping'
])

export const workbookPreviewRequestSchema = z.object({
  kind: baseFileKindSchema,
  sheetName: z.string().trim().min(1).max(100).optional(),
  imageStartRow: z.number().int().min(0).max(1_048_576).optional(),
  imageEndRow: z.number().int().min(0).max(1_048_576).optional(),
  imagesOnly: z.boolean().optional()
})

export const baseFileRollbackSchema = z.string().uuid()

export const taskDraftInputSchema = z.object({
  templateName: z.string().trim().min(1).max(100),
  seriesNameZh: z.string().trim().max(100),
  seriesNameEn: z.string().trim().min(1, '英文系列名尚未填写').max(150),
  ipRemark: z.string().trim().max(150),
  selectedModels: z.array(z.string().trim().min(1).max(100)).max(100),
  modelBrandAssignments: z.record(
    z.string().trim().min(1).max(100),
    z.enum(['apple', 'huawei', 'samsung', 'other'])
  ),
  modelSettings: z.array(z.object({
    id: z.string().trim().min(1).max(150),
    name: z.string().trim().min(1).max(100),
    brand: z.enum(['apple', 'huawei', 'samsung', 'other']),
    enabled: z.boolean(),
    silverEnabled: z.boolean(),
    pricesByCategory: z.record(z.string().trim().min(1).max(100), z.object({
      normal: z.object({ domestic: z.number().positive().max(1_000_000).nullable(), overseas: z.number().positive().max(1_000_000).nullable() }).optional(),
      silver: z.object({ domestic: z.number().positive().max(1_000_000).nullable(), overseas: z.number().positive().max(1_000_000).nullable() }).optional()
    })).optional()
  })).max(100).optional(),
  framePriceRules: z.record(z.string().trim().min(1).max(100), z.object({
    normal: z.object({ domestic: z.number().positive().max(1_000_000).nullable(), overseas: z.number().positive().max(1_000_000).nullable() }).optional(),
    silver: z.object({ domestic: z.number().positive().max(1_000_000).nullable(), overseas: z.number().positive().max(1_000_000).nullable() }).optional(),
    brands: z.record(z.enum(['apple', 'huawei', 'samsung', 'other']), z.object({
      normal: z.object({ domestic: z.number().positive().max(1_000_000).nullable(), overseas: z.number().positive().max(1_000_000).nullable() }).optional(),
      silver: z.object({ domestic: z.number().positive().max(1_000_000).nullable(), overseas: z.number().positive().max(1_000_000).nullable() }).optional()
    })).optional()
  })).optional(),
  masterImagePath: z.string().trim().min(1).max(1_024)
})

export const analyzeMasterImageInputSchema = z.object({
  sourceImagePath: z.string().trim().min(1).max(1_024)
})

const cropBoxSchema = z.object({
  id: z.string().trim().min(1).max(100),
  x: z.number().int().nonnegative().max(100_000),
  y: z.number().int().nonnegative().max(100_000),
  width: z.number().int().positive().max(100_000),
  height: z.number().int().positive().max(100_000),
  role: z.enum(['series-overview', 'product-pattern', 'unknown']),
  label: z.string().trim().max(150),
  productCategory: z.string().trim().min(1).max(100),
  suggestedRetailPrice: z.number().positive().max(1_000_000).nullable(),
  overseasRetailPrice: z.number().positive().max(1_000_000).nullable(),
  material: z.string().trim().max(100),
  materialSource: z.enum(['auto', 'manual']).optional(),
  wirelessVariantPrices: z.object({
    cp002: z.object({ retail: z.number().nonnegative(), overseas: z.number().nonnegative() }),
    mp16: z.object({ retail: z.number().nonnegative(), overseas: z.number().nonnegative() })
  }).optional(),
  patternGroupId: z.string().trim().max(100).nullable(),
  confidence: z.number().min(0).max(1),
  categoryConfidence: z.number().min(0).max(1).nullable(),
  categoryReasons: z.array(z.string().trim().min(1).max(200)).max(5),
  patternNameEn: z.string().trim().max(150).refine((value) => !value || isValidEnglishPatternName(value), '英文图案名只能包含英文字母和空格'),
  patternNameZh: z.string().trim().max(150),
  nameCandidates: z.array(z.object({
    englishName: z.string().trim().min(1).max(150),
    chineseName: z.string().trim().min(1).max(150),
    reason: z.string().trim().min(1).max(300),
    confidence: z.number().min(0).max(1)
  })).max(5)
})

export const refineCropInputSchema = z.object({
  sourceImagePath: z.string().trim().min(1).max(1_024),
  crop: cropBoxSchema
})

export const exportConfirmedCropsInputSchema = z.object({
  sourceImagePath: z.string().trim().min(1).max(1_024),
  seriesName: z.string().trim().max(150),
  crops: z.array(cropBoxSchema).min(1).max(100)
}).superRefine((value, context) => {
  const overviewCount = value.crops.filter((crop) => crop.role === 'series-overview').length
  if (overviewCount !== 1) {
    context.addIssue({
      code: 'custom',
      path: ['crops'],
      message: '导出内容必须包含且只能包含一张全系列主图'
    })
  }
})

export const saveAiSettingsInputSchema = z.object({
  provider: z.literal('aliyun'),
  model: z.string().trim().min(1).max(100),
  baseUrl: z.string().trim().url().max(500),
  apiKey: z.string().trim().max(500)
})

export const applicationSettingsSchema = z.object({
  autoSaveDrafts: z.boolean(),
  requireQualityCheck: z.boolean(),
  allowNetworkFeatures: z.boolean()
})

export const suggestImageNamesInputSchema = z.object({
  sourceImagePath: z.string().trim().min(1).max(1_024),
  crop: cropBoxSchema,
  seriesNameZh: z.string().trim().max(150),
  seriesNameEn: z.string().trim().min(1, '英文系列名尚未填写').max(150),
  existingEnglishNames: z.array(z.string().trim().min(1).max(150)).max(200),
  forbiddenEnglishNames: z.array(z.string().trim().min(1).max(150)).max(5_000).optional().default([])
})

export const materialInputSchema = z.object({ sourceImagePath: z.string().trim().min(1).max(1024), crop: cropBoxSchema }).refine(v => v.crop.role !== 'series-overview', '请选择产品切片')

export const comparePatternsInputSchema = z.object({
  sourceImagePath: z.string().trim().min(1).max(1024),
  crop: cropBoxSchema,
  references: z.array(z.object({ id: z.string().regex(/^[A-Z]+\d+$/), name: z.string().trim().min(1).max(200), imageDataUrl: z.string().max(1_500_000).regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/) })).min(1).max(120)
}).superRefine((value, context) => {
  if (value.crop.role === 'series-overview') context.addIssue({ code: 'custom', message: '请选择产品切片，不比对全系列主图' })
  if (new Set(value.references.map(r => r.id)).size !== value.references.length) context.addIssue({ code: 'custom', message: '历史图片编号重复' })
  if (value.references.reduce((size, r) => size + r.imageDataUrl.length, 0) > 12_000_000) context.addIssue({ code: 'custom', message: '历史图片超过单次比对大小限制，请减少图片数量' })
})

export const suggestImageNamesBatchInputSchema = z.object({
  sourceImagePath: z.string().trim().min(1).max(1_024),
  crops: z.array(cropBoxSchema).min(1).max(40),
  seriesNameZh: z.string().trim().max(150),
  seriesNameEn: z.string().trim().min(1, '英文系列名尚未填写').max(150),
  existingEnglishNames: z.array(z.string().trim().min(1).max(150)).max(300),
  forbiddenEnglishNames: z.array(z.string().trim().min(1).max(150)).max(5_000).optional().default([])
}).superRefine((value, context) => {
  if (value.crops.some((crop) => crop.role === 'series-overview')) {
    context.addIssue({ code: 'custom', path: ['crops'], message: '批量 AI 命名不能包含全系列主图' })
  }
})

export const translateSeriesNameInputSchema = z.object({
  chineseName: z.string().trim().min(1).max(150)
})

export const connectorTestInputSchema = z.object({
  connectorId: z.string().trim().min(1).max(100)
})

export const cloneTemplateWorkbookInputSchema = z.object({
  sourcePath: z.string().trim().min(1).max(1_024),
  destinationPath: z.string().trim().min(1).max(1_024)
})

export const generateTemplateConfigInputSchema = z.object({
  sourcePath: z.string().trim().min(1).max(1_024)
})

const templateFieldKeySchema = z.enum([
  'barcodeName',
  'image',
  'color',
  'seriesName',
  'seriesNameUppercase',
  'seriesCode',
  'productCode',
  'patternName',
  'patternNameUppercase',
  'finalName'
])

export const controlledWriteIpcInputSchema = z.object({
  sourcePath: z.string().trim().min(1).max(1_024),
  destinationPath: z.string().trim().min(1).max(1_024),
  config: z.unknown(),
  plan: z.object({
    sheetName: z.string().trim().min(1).max(100),
    rows: z.array(z.object({
      row: z.number().int().positive().max(1_048_576),
      values: z.partialRecord(templateFieldKeySchema, z.union([z.string(), z.number(), z.boolean(), z.null()]))
    })).min(1)
  })
})

export const buildEncodingPreviewInputSchema = z.object({
  seriesNameZh: z.string().trim().max(150),
  seriesNameEn: z.string().trim().min(1).max(150),
  crops: z.array(z.object({
    cropId: z.string().trim().min(1).max(100),
    productCategory: z.string().trim().min(1).max(100),
    patternGroupId: z.string().trim().max(100).nullable(),
    patternNameEn: z.string().trim().min(1).max(150).refine(isValidEnglishPatternName, '英文图案名只能包含英文字母和空格')
  })).min(1).max(100)
})

const previewCellSchema = z.object({
  value: z.string().max(20_000),
  numericValue: z.number().finite().optional(),
  targetAddress: z.string().trim().regex(/^[A-Z]{1,3}[1-9]\d{0,6}$/).optional(),
  formula: z.string().max(20_000).optional(),
  cropId: z.string().trim().max(100).optional(),
  changed: z.boolean().optional(),
  writeOnly: z.boolean().optional(),
  fill: z.literal('yellow').optional(),
  imageLayout: z.object({
    containerWidthPx: z.number().positive().max(10_000),
    containerHeightPx: z.number().positive().max(10_000),
    imageWidthPx: z.number().positive().max(10_000),
    imageHeightPx: z.number().positive().max(10_000),
    fitMode: z.enum(['contain', 'stretch']).optional()
  }).optional()
})

const previewSheetSchema = z.object({
  createIfMissing: z.boolean().optional(),
  id: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(100),
  // Blank labels are intentional (e.g. the frame-variant C column).
  // Validate the sheet shape without requiring every header to have text.
  columns: z.array(z.string().max(100)).min(1).max(16_384),
  headerCells: z.array(previewCellSchema).max(16_384).optional(),
  // A single image record can expand to every confirmed phone model in the
  // barcode sheet, including normal/silver variants and section rows.
  // Existing-series append plans may extend beyond 40 historical columns.
  rows: z.array(z.array(previewCellSchema).max(16_384)).max(22_000),
  startRow: z.number().int().positive().max(1_048_576).optional(),
  showBusinessHeader: z.boolean().optional(),
  columnWidths: z.array(z.number().positive().max(1_000)).max(16_384).optional(),
  rowHeights: z.array(z.number().positive().max(1_000)).max(22_000).optional()
}).superRefine((sheet, context) => {
  const cellCount = sheet.rows.reduce((count, row) => count + row.length, sheet.headerCells?.length ?? 0)
  if (cellCount > 500_000) context.addIssue({ code: 'custom', path: ['rows'], message: '单张工作表预览数据超过 50 万个单元格，请拆分任务。' })
})

export const exportGenerationWorkbookInputSchema = z.object({
  suggestedName: z.string().trim().min(1).max(180),
  workspace: z.object({
    title: z.string().trim().min(1).max(200),
    generatedAt: z.string().trim().min(1).max(100),
    workbooks: z.array(z.object({
      id: z.enum(['barcode-reference', 'domestic-naming', 'generated-product', 'product-image-mapping']),
      sourceVersion: z.string().max(100).optional(),
      name: z.string().trim().min(1).max(100),
      role: z.string().trim().min(1).max(300),
      sheets: z.array(previewSheetSchema).min(1).max(20)
    })).min(1).max(4),
    checks: z.array(z.object({
      id: z.string().trim().min(1).max(100),
      label: z.string().trim().min(1).max(200),
      passed: z.boolean(),
      detail: z.string().trim().min(1).max(500)
    })).min(1).max(50)
  }),
  sourcePaths: z.object({
    namingFormula: z.string().trim().min(1).max(1_024),
    barcodeReference: z.string().trim().min(1).max(1_024),
    domesticNaming: z.string().trim().min(1).max(1_024),
    productImageMapping: z.string().trim().min(1).max(1_024).optional()
  }),
  templateName: z.string().trim().min(1).max(100),
  imageSource: z.object({
    path: z.string().trim().min(1).max(1_024),
    crops: z.array(z.object({ id: z.string().trim().min(1).max(100), x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive() })).min(1).max(100)
  }),
  selectedWorkbookIds: z.array(z.enum(['barcode-reference', 'domestic-naming', 'generated-product', 'product-image-mapping'])).min(1).max(4).default(['generated-product']),
  overwriteBaseFiles: z.boolean().default(false)
}).superRefine((input, context) => {
  const ids = input.workspace.workbooks.map((book) => book.id)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['workspace', 'workbooks'], message: '工作簿数据重复，请重新生成后重试。' })
  }
  if (input.selectedWorkbookIds.some((id) => !ids.includes(id))) {
    context.addIssue({ code: 'custom', path: ['selectedWorkbookIds'], message: '缺少选中工作簿的生成数据，请重新生成后重试。' })
  }
})

export const publishGenerationWorkbookInputSchema = z.object({
  generation: exportGenerationWorkbookInputSchema,
  sourceWorkflow: z.enum(['new-series', 'new-products'])
}).strict()
