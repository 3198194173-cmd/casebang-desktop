import type { CropBox } from './image-contracts'

export interface ComparePatternsInput {
  sourceImagePath: string
  crop: CropBox
  references: Array<{ id: string; name: string; imageDataUrl: string }>
}
export interface ComparePatternsResult {
  referenceId: string | null
  name: string | null
  confidence: number
  reason: string
  status: 'matched' | 'uncertain' | 'unmatched'
  model: string
}
