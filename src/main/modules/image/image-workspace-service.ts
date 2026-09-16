import { dialog } from 'electron'
import { rm } from 'node:fs/promises'
import type { CropBox, ExportConfirmedCropsInput, ExportConfirmedCropsResult, ImageAnalysisResult, RefineCropResult } from '@shared/image-contracts'
import { createUniqueExportDirectory, SharpImageSegmentationService } from './sharp-image-segmentation-service'

export class ImageWorkspaceService {
  constructor(private readonly segmentation = new SharpImageSegmentationService()) {}

  analyze(sourceImagePath: string): Promise<ImageAnalysisResult> {
    return this.segmentation.detect(sourceImagePath)
  }

  refineCrop(sourceImagePath: string, crop: CropBox): Promise<RefineCropResult> {
    return this.segmentation.refineCrop(sourceImagePath, crop)
  }

  async exportCrops(input: ExportConfirmedCropsInput): Promise<ExportConfirmedCropsResult> {
    const selection = await dialog.showOpenDialog({ title: '选择裁图保存位置', properties: ['openDirectory', 'createDirectory'] })
    const parentDirectory = selection.filePaths[0]
    if (selection.canceled || !parentDirectory) return { canceled: true, outputDirectory: null, files: [] }
    const outputDirectory = await createUniqueExportDirectory(parentDirectory, input.seriesName)
    try {
      const files = await this.segmentation.exportConfirmedCrops(input.sourceImagePath, input.crops, outputDirectory)
      return { canceled: false, outputDirectory, files }
    } catch (reason) {
      await rm(outputDirectory, { recursive: true, force: true })
      throw reason
    }
  }
}
