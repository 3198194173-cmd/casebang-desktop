import type { CropBox, ExportedCropFile, ImageAnalysisResult, RefineCropResult } from '@shared/image-contracts'

export interface ImageSegmentationPort {
  detect(sourceImagePath: string): Promise<ImageAnalysisResult>
  refineCrop(sourceImagePath: string, crop: CropBox): Promise<RefineCropResult>
  exportConfirmedCrops(
    sourceImagePath: string,
    crops: CropBox[],
    outputDirectory: string
  ): Promise<ExportedCropFile[]>
}
