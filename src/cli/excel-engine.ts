import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { OoxmlWorkbookInspector } from '../main/modules/spreadsheet/ooxml-workbook-inspector'
import { VerifiedWorkbookCloner } from '../main/modules/spreadsheet/verified-workbook-cloner'
import { extractProductTypesFromWorkbook, TemplateConfigGenerator } from '../main/modules/spreadsheet/template-config-generator'
import { ControlledWorkbookWriter } from '../main/modules/spreadsheet/controlled-workbook-writer'
import type {
  BaseWorkbookInspectionReport,
  WorkbookInspection
} from '../main/modules/spreadsheet/ooxml-types'
import type { ControlledWritePlan, TemplateConfigBundle } from '../shared/excel-contracts'

type Arguments = Record<string, string | boolean>

async function main(): Promise<void> {
  const [command = 'help', ...rawArguments] = process.argv.slice(2)
  const args = parseArguments(rawArguments)

  if (command === 'inspect-base') {
    await inspectBaseFiles(args)
    return
  }
  if (command === 'clone-verify') {
    await cloneAndVerify(args)
    return
  }
  if (command === 'verify-existing') {
    await verifyExisting(args)
    return
  }
  if (command === 'generate-config') {
    await generateConfig(args)
    return
  }
  if (command === 'controlled-write') {
    await controlledWrite(args)
    return
  }
  if (command === 'list-product-types') {
    await listProductTypes(args)
    return
  }
  printHelp()
}

async function listProductTypes(args: Arguments): Promise<void> {
  const sourcePath = requireString(args, 'source')
  const outputPath = requireString(args, 'output')
  const productTypes = await extractProductTypesFromWorkbook(sourcePath)
  await saveJson(outputPath, { sourcePath, count: productTypes.length, productTypes })
  console.log(`产品类型：${productTypes.length} 个`)
  productTypes.forEach((productType, index) => console.log(`  ${String(index + 1).padStart(2, '0')}. ${productType}`))
  console.log(`产品类型报告：${resolve(outputPath)}`)
}

async function generateConfig(args: Arguments): Promise<void> {
  const sourcePath = requireString(args, 'source')
  const outputPath = requireString(args, 'output')
  console.error('正在识别模板表头、公式列和可写字段…')
  const bundle = await new TemplateConfigGenerator().generate(sourcePath)
  await saveJson(outputPath, bundle)
  console.log(`模板配置：${resolve(outputPath)}`)
  console.log(`识别模板：${bundle.templates.length} 个`)
  bundle.templates.forEach((template, index) => {
    console.log(
      `  ${String(index + 1).padStart(2, '0')}. ${template.sheetName}：` +
      `${template.fields.length} 个字段，${template.allowedWriteFields.length} 个可写字段`
    )
  })
  if (bundle.warnings.length > 0) console.log(`提示：${bundle.warnings.length} 条，详见配置文件`)
}

async function controlledWrite(args: Arguments): Promise<void> {
  const sourcePath = requireString(args, 'source')
  const destinationPath = requireString(args, 'destination')
  const configPath = requireString(args, 'config')
  const changesPath = requireString(args, 'changes')
  const reportPath = requireString(args, 'report')
  const config = await readJson<TemplateConfigBundle>(configPath)
  const plan = await readJson<ControlledWritePlan>(changesPath)
  console.error(`正在受控写入“${plan.sheetName}”，并执行包级完整性验证…`)
  const report = await new ControlledWorkbookWriter().write({
    ...plan,
    sourcePath,
    destinationPath,
    config
  })
  await saveJson(reportPath, report)
  console.log(`受控写入：${report.passed ? '通过' : '失败'}`)
  console.log(`写入单元格：${report.changedCells.join(', ')}`)
  console.log(`工作簿内部变更：${report.changedEntries.map((item) => item.path).join(', ')}`)
  console.log(`输出文件：${resolve(destinationPath)}`)
  console.log(`验证报告：${resolve(reportPath)}`)
  if (!report.passed) process.exitCode = 2
}

async function inspectBaseFiles(args: Arguments): Promise<void> {
  const namingFormulaPath = requireString(args, 'naming-formula')
  const barcodeReferencePath = requireString(args, 'barcode-reference')
  const domesticNamingPath = requireString(args, 'domestic-naming')
  const reportPath = requireString(args, 'report')
  const inspector = new OoxmlWorkbookInspector()

  console.error('[1/3] 正在读取命名-公式…')
  const namingFormula = await inspector.inspect(namingFormulaPath, 'naming-formula')
  console.error('[2/3] 正在读取 A条码参考…')
  const barcodeReference = await inspector.inspect(barcodeReferencePath, 'barcode-reference')
  console.error('[3/3] 正在读取国内命名表…')
  const domesticNaming = await inspector.inspect(domesticNamingPath, 'domestic-naming')
  const templates = namingFormula.templates.filter((item) => item.classification === 'template')

  const report: BaseWorkbookInspectionReport = {
    generatedAt: new Date().toISOString(),
    namingFormula,
    barcodeReference,
    domesticNaming,
    templateCount: templates.length,
    templates
  }
  await saveJson(reportPath, report)
  printInspectionSummary(report, reportPath)
}

async function cloneAndVerify(args: Arguments): Promise<void> {
  const sourcePath = requireString(args, 'source')
  const destinationPath = requireString(args, 'destination')
  const reportPath = requireString(args, 'report')
  const cloner = new VerifiedWorkbookCloner()

  console.error('正在建立只读源文件的精确任务副本并验证…')
  const report = await cloner.cloneAndVerify(sourcePath, destinationPath, 'naming-formula')
  await saveJson(reportPath, report)
  printVerificationSummary(report, reportPath)
}

async function verifyExisting(args: Arguments): Promise<void> {
  const sourcePath = requireString(args, 'source')
  const copyPath = requireString(args, 'copy')
  const reportPath = requireString(args, 'report')
  const cloner = new VerifiedWorkbookCloner()

  console.error('正在重新验证现有副本…')
  const report = await cloner.verifyExisting(sourcePath, copyPath, 'naming-formula')
  await saveJson(reportPath, report)
  printVerificationSummary(report, reportPath)
}

function printVerificationSummary(
  report: Awaited<ReturnType<VerifiedWorkbookCloner['verifyExisting']>>,
  reportPath: string
): void {
  console.log(`复制验证：${report.passed ? '通过' : '失败'}`)
  console.log(`二进制完全一致：${report.exactBinaryMatch ? '是' : '否'}`)
  console.log(`公式：${toText(report.checks.formulas)}`)
  console.log(`样式：${toText(report.checks.styles)}`)
  console.log(`行高/列宽：${toText(report.checks.rowColumnDimensions)}`)
  console.log(`图片锚点：${toText(report.checks.imageAnchors)}`)
  console.log(`媒体文件：${toText(report.checks.media)}`)
  console.log(`关系文件：${toText(report.checks.relationships)}`)
  console.log(`验证报告：${resolve(reportPath)}`)
  if (!report.passed) process.exitCode = 2
}

function printInspectionSummary(report: BaseWorkbookInspectionReport, reportPath: string): void {
  const workbooks: Array<[string, WorkbookInspection]> = [
    ['命名-公式', report.namingFormula],
    ['A条码参考', report.barcodeReference],
    ['国内命名表', report.domesticNaming]
  ]
  for (const [label, workbook] of workbooks) {
    console.log(
      `${label}：${workbook.worksheetCount} 个工作表，${workbook.formulaCount} 个公式，` +
      `${workbook.imageFileCount} 个媒体文件，${workbook.imageAnchorCount} 个图片锚点`
    )
  }
  console.log(`识别模板：${report.templateCount} 个`)
  report.templates.forEach((template, index) => {
    console.log(`  ${String(index + 1).padStart(2, '0')}. ${template.sheetName}`)
  })
  console.log(`检查报告：${resolve(reportPath)}`)
}

function parseArguments(values: string[]): Arguments {
  const result: Arguments = {}
  for (let index = 0; index < values.length; index += 1) {
    const current = values[index]
    if (!current?.startsWith('--')) throw new Error(`无法识别参数：${current ?? ''}`)
    const key = current.slice(2)
    const next = values[index + 1]
    if (!next || next.startsWith('--')) {
      result[key] = true
    } else {
      result[key] = next
      index += 1
    }
  }
  return result
}

function requireString(args: Arguments, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少参数 --${key}`)
  return resolve(value)
}

async function saveJson(filePath: string, value: unknown): Promise<void> {
  const absolutePath = resolve(filePath)
  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function readJson<T>(filePath: string): Promise<T> {
  const { readFile } = await import('node:fs/promises')
  return JSON.parse(await readFile(resolve(filePath), 'utf8')) as T
}

function toText(value: boolean): string {
  return value ? '通过' : '失败'
}

function printHelp(): void {
  console.log(`
CASEBANG Excel 模板引擎

读取三个基础表并识别全部模板：
  excel-engine inspect-base \\
    --naming-formula <命名-公式.xlsx> \\
    --barcode-reference <A条码参考.xlsx> \\
    --domestic-naming <国内命名表.xlsx> \\
    --report <检查报告.json>

建立精确副本并验证：
  excel-engine clone-verify \\
    --source <源工作簿.xlsx> \\
    --destination <新副本.xlsx> \\
    --report <验证报告.json>

重新验证已经存在的副本：
  excel-engine verify-existing \\
    --source <源工作簿.xlsx> \\
    --copy <已有副本.xlsx> \\
    --report <复验报告.json>

识别模板字段并生成配置：
  excel-engine generate-config \
    --source <命名-公式.xlsx> \
    --output <模板配置.json>

按白名单受控写入并验证：
  excel-engine controlled-write \
    --source <命名-公式.xlsx> \
    --destination <新工作簿.xlsx> \
    --config <模板配置.json> \
    --changes <写入计划.json> \
    --report <验证报告.json>

从“命名-公式”收集完整产品类型：
  excel-engine list-product-types \
    --source <命名-公式.xlsx> \
    --output <产品类型报告.json>

注意：clone-verify 和 controlled-write 都不会覆盖已存在的目标文件。
`)
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Excel 模板引擎失败：${message}`)
  process.exitCode = 1
})
