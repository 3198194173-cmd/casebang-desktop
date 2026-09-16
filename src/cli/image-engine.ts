import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { CropBox } from '../shared/image-contracts'
import { createUniqueExportDirectory, SharpImageSegmentationService } from '../main/modules/image/sharp-image-segmentation-service'

type Arguments = Record<string, string | boolean>

async function main(): Promise<void> {
  const [command = 'help', ...rawArguments] = process.argv.slice(2)
  const args = parseArguments(rawArguments)
  if (command === 'analyze') return analyze(args)
  if (command === 'refine') return refine(args)
  if (command === 'export') return exportCrops(args)
  printHelp()
}

async function refine(args: Arguments): Promise<void> {
  const sourcePath = requireString(args, 'source')
  const planPath = requireString(args, 'plan')
  const cropId = requireStringValue(args, 'crop')
  const reportPath = requireString(args, 'report')
  const plan = JSON.parse(await readFile(planPath, 'utf8')) as { crops: CropBox[] }
  const crop = plan.crops?.find((candidate) => candidate.id === cropId)
  if (!crop) throw new Error(`裁图计划中找不到区域：${cropId}`)
  const result = await new SharpImageSegmentationService().refineCrop(sourcePath, crop)
  await saveJson(reportPath, result)
  console.log(result.message)
  console.log(`细分报告：${reportPath}`)
}

async function analyze(args: Arguments): Promise<void> {
  const sourcePath = requireString(args, 'source')
  const reportPath = requireString(args, 'report')
  const previewPath = optionalString(args, 'preview')
  console.error('正在读取总图并识别白底上的独立对象…')
  const result = await new SharpImageSegmentationService().detect(sourcePath)
  const { previewDataUrl, ...report } = result
  await saveJson(reportPath, report)
  if (previewPath) {
    await mkdir(dirname(previewPath), { recursive: true })
    await writeFile(previewPath, Buffer.from(previewDataUrl.split(',')[1] ?? '', 'base64'))
  }
  console.log(`图片尺寸：${result.sourceWidth} × ${result.sourceHeight}`)
  console.log(`识别结果：1 张全系列主图 + ${Math.max(0, result.crops.length - 1)} 个候选区域`)
  console.log(`检测背景：${result.backgroundColor}，阈值：${result.detectionThreshold}`)
  console.log(`分析报告：${reportPath}`)
  if (previewPath) console.log(`预览图片：${previewPath}`)
}

async function exportCrops(args: Arguments): Promise<void> {
  const sourcePath = requireString(args, 'source')
  const planPath = requireString(args, 'plan')
  const parentOutput = requireString(args, 'output')
  const plan = JSON.parse(await readFile(planPath, 'utf8')) as { crops: CropBox[]; seriesName?: string }
  if (!Array.isArray(plan.crops) || plan.crops.length === 0) throw new Error('裁图计划没有 crops 数据')
  const outputDirectory = await createUniqueExportDirectory(parentOutput, plan.seriesName ?? '命令行验证')
  const files = await new SharpImageSegmentationService().exportConfirmedCrops(sourcePath, plan.crops, outputDirectory)
  console.log(`已导出 ${files.length} 张图片：${outputDirectory}`)
}

function parseArguments(values: string[]): Arguments {
  const result: Arguments = {}
  for (let index = 0; index < values.length; index += 1) {
    const current = values[index]
    if (!current?.startsWith('--')) throw new Error(`无法识别参数：${current ?? ''}`)
    const key = current.slice(2)
    const next = values[index + 1]
    if (!next || next.startsWith('--')) result[key] = true
    else { result[key] = next; index += 1 }
  }
  return result
}

function requireString(args: Arguments, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少参数 --${key}`)
  return resolve(value)
}

function requireStringValue(args: Arguments, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少参数 --${key}`)
  return value
}

function optionalString(args: Arguments, key: string): string | null {
  const value = args[key]
  return typeof value === 'string' && value.trim() ? resolve(value) : null
}

async function saveJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function printHelp(): void {
  console.log(`
CASEBANG 图片裁剪引擎

识别总图：
  image-engine analyze --source <总图> --report <报告.json> [--preview <预览.webp>]

细分一个已识别区域：
  image-engine refine --source <总图> --plan <报告.json> --crop <区域ID> --report <细分报告.json>

按确认后的报告导出：
  image-engine export --source <总图> --plan <报告.json> --output <父目录>
`)
}

void main().catch((reason: unknown) => {
  console.error(`图片裁剪引擎失败：${reason instanceof Error ? reason.message : String(reason)}`)
  process.exitCode = 1
})
