import type { CropBox, ImageAnalysisResult } from './image-contracts'
import { MATERIAL_COLOR_OPTIONS } from './product-business-rules'

export interface MaterialInput { sourceImagePath: string; crop: CropBox }
export interface MaterialResult { material: string; reason: string; confidence: number }
export function fixedMaterial(category: string): string | null {
  if (/气囊支架/.test(category)) return '透明'
  if (/磁吸支架背盖|磁吸背盖支架/.test(category)) return '银色'
  return null
}
export function normalizeMaterial(value: string, tendency: 'transparent' | 'silver', confidence: number): string {
  return confidence >= 0.6 && (MATERIAL_COLOR_OPTIONS as readonly string[]).includes(value)
    ? value : tendency === 'silver' ? '银色' : '透明'
}
/** Never overwrite an edit made while the request was in flight or a replaced crop. */
export function applyMaterial(current: ImageAnalysisResult, input: MaterialInput, result: MaterialResult): ImageAnalysisResult {
  if (current.sourceImagePath !== input.sourceImagePath) return current
  return { ...current, crops: current.crops.map(c => c.id === input.crop.id &&
    c.materialSource !== 'manual' &&
    c.material === input.crop.material && c.productCategory === input.crop.productCategory &&
    c.x === input.crop.x && c.y === input.crop.y && c.width === input.crop.width && c.height === input.crop.height
    ? { ...c, material: result.material, materialSource: 'auto' } : c) }
}
