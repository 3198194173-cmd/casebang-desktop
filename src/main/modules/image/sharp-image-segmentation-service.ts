import { randomUUID } from 'node:crypto'
import { access, mkdir, realpath, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import sharp from 'sharp'
import type { CropBox, ExportedCropFile, ImageAnalysisResult, ProductCategory, RefineCropResult } from '@shared/image-contracts'
import { productBusinessSpecification } from '@shared/product-business-rules'
import type { ImageSegmentationPort } from './image-segmentation-port'

const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff'])
const MAX_SOURCE_BYTES = 250 * 1024 * 1024
const MAX_SOURCE_PIXELS = 200_000_000
const ANALYSIS_MAX_EDGE = 1_400
const MAX_AUTOMATIC_CROPS = 60

export interface PixelBox {
  x: number
  y: number
  width: number
  height: number
  pixels: number
}

interface DetectionResult {
  boxes: PixelBox[]
  background: [number, number, number]
  threshold: number
}

interface ProductClassification {
  category: ProductCategory
  confidence: number
  reasons: string[]
}

interface DetectionOptions {
  dilationRadius?: number
  minimumAreaRatio?: number
  maximumAreaRatio?: number
}

export class SharpImageSegmentationService implements ImageSegmentationPort {
  async detect(sourceImagePath: string): Promise<ImageAnalysisResult> {
    const safePath = await validateImagePath(sourceImagePath)
    const metadata = await sharp(safePath, { limitInputPixels: MAX_SOURCE_PIXELS }).metadata()
    if (!metadata.width || !metadata.height || !metadata.format) throw new Error('无法读取图片尺寸或格式')
    const rotated = isRotatedOrientation(metadata.orientation)
    const sourceWidth = rotated ? metadata.height : metadata.width
    const sourceHeight = rotated ? metadata.width : metadata.height
    const raw = await sharp(safePath, { limitInputPixels: MAX_SOURCE_PIXELS })
      .rotate()
      .resize({ width: ANALYSIS_MAX_EDGE, height: ANALYSIS_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const detection = detectForegroundBoxes(raw.data, raw.info.width, raw.info.height, raw.info.channels)
    const scaleX = sourceWidth / raw.info.width
    const scaleY = sourceHeight / raw.info.height
    const detectedCrops = detection.boxes.slice(0, MAX_AUTOMATIC_CROPS).map((box, index): CropBox => {
      const classification = classifyProductBox(raw.data, raw.info.width, raw.info.height, raw.info.channels, box, detection.background)
      const x = clampInteger(Math.floor(box.x * scaleX), 0, sourceWidth - 1)
      const y = clampInteger(Math.floor(box.y * scaleY), 0, sourceHeight - 1)
      const right = clampInteger(Math.ceil((box.x + box.width) * scaleX), x + 1, sourceWidth)
      const bottom = clampInteger(Math.ceil((box.y + box.height) * scaleY), y + 1, sourceHeight)
      const fillRatio = box.pixels / Math.max(1, box.width * box.height)
      const business = productBusinessSpecification(classification.category)
      return {
        id: randomUUID(), x, y, width: right - x, height: bottom - y,
        role: 'product-pattern',
        label: `识别区域 ${String(index + 1).padStart(2, '0')}`,
        productCategory: classification.category, patternGroupId: null,
        suggestedRetailPrice: business.suggestedRetailPrice,
        overseasRetailPrice: business.overseasRetailPrice,
        material: '',
        confidence: round(clamp(0.58 + fillRatio * 0.45, 0.58, 0.96), 2),
        categoryConfidence: classification.confidence,
        categoryReasons: classification.reasons,
        patternNameEn: '', patternNameZh: '', nameCandidates: []
      }
    })
    const overview: CropBox = {
      id: randomUUID(), x: 0, y: 0, width: sourceWidth, height: sourceHeight,
      role: 'series-overview', label: '全系列主图', productCategory: '待确认',
      suggestedRetailPrice: null, overseasRetailPrice: null, material: '',
      patternGroupId: null, confidence: 1, categoryConfidence: null, categoryReasons: [],
      patternNameEn: '', patternNameZh: '', nameCandidates: []
    }
    const preview = await sharp(safePath, { limitInputPixels: MAX_SOURCE_PIXELS })
      .rotate()
      .resize({ width: 1_600, height: 1_100, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, effort: 3 })
      .toBuffer()
    const warnings: string[] = []
    if (detectedCrops.length === 0) warnings.push('未找到独立对象，只保留了全系列主图，请手工添加裁剪框。')
    if (detection.boxes.length > MAX_AUTOMATIC_CROPS) warnings.push(`检测到 ${detection.boxes.length} 个区域，仅保留前 ${MAX_AUTOMATIC_CROPS} 个。`)
    return {
      sourceImagePath: safePath, fileName: basename(safePath), sourceWidth, sourceHeight,
      format: metadata.format, previewDataUrl: `data:image/webp;base64,${preview.toString('base64')}`,
      backgroundColor: rgbToHex(detection.background), detectionThreshold: round(detection.threshold, 1),
      crops: [overview, ...detectedCrops], warnings
    }
  }

  async refineCrop(sourceImagePath: string, crop: CropBox): Promise<RefineCropResult> {
    const safePath = await validateImagePath(sourceImagePath)
    const metadata = await sharp(safePath, { limitInputPixels: MAX_SOURCE_PIXELS }).metadata()
    if (!metadata.width || !metadata.height) throw new Error('无法读取源图片尺寸')
    const rotated = isRotatedOrientation(metadata.orientation)
    const sourceWidth = rotated ? metadata.height : metadata.width
    const sourceHeight = rotated ? metadata.width : metadata.height
    const safeCrop = validateCrop(crop, sourceWidth, sourceHeight)
    if (safeCrop.role === 'series-overview') throw new Error('全系列主图不能执行细分识别')
    const raw = await sharp(safePath, { limitInputPixels: MAX_SOURCE_PIXELS })
      .rotate()
      .extract({ left: safeCrop.x, top: safeCrop.y, width: safeCrop.width, height: safeCrop.height })
      .resize({ width: 1_600, height: 1_600, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const detection = detectForegroundBoxes(raw.data, raw.info.width, raw.info.height, raw.info.channels, {
      dilationRadius: 0,
      minimumAreaRatio: 0.0007,
      maximumAreaRatio: 0.98
    })
    const mask = createForegroundMask(raw.data, raw.info.width, raw.info.height, raw.info.channels, detection.background, detection.threshold)
    const projectionBoxes = splitByVerticalGaps(mask, raw.info.width, raw.info.height)
    // Equal-width splitting is intentionally reserved for very wide selections.
    // A lens protector or notebook shell is itself a wide product and used to be
    // cut in half simply because its width happened to be close to two heights.
    const selectionAspect = raw.info.width / Math.max(1, raw.info.height)
    const equalGroupBoxes = selectionAspect >= 2.15
      ? splitWideSelection(mask, raw.info.width, raw.info.height)
      : []
    const localBoxes = equalGroupBoxes.length > projectionBoxes.length
      ? equalGroupBoxes
      : projectionBoxes.length > 1
        ? projectionBoxes
        : equalGroupBoxes.length > 1
          ? equalGroupBoxes
          : removeContainedBoxes(detection.boxes)
    if (localBoxes.length <= 1) {
      const classificationBox = detection.boxes[0]
      if (!classificationBox || isManuallyConfirmedCategory(safeCrop)) {
        return { crops: [safeCrop], message: '该区域未找到可靠分隔线，已保留原区域。' }
      }
      const classification = classifyProductBox(
        raw.data,
        raw.info.width,
        raw.info.height,
        raw.info.channels,
        classificationBox,
        detection.background
      )
      const business = productBusinessSpecification(classification.category)
      const categoryChanged = classification.category !== safeCrop.productCategory
      return {
        crops: [{
          ...safeCrop,
          productCategory: classification.category,
          suggestedRetailPrice: categoryChanged ? business.suggestedRetailPrice : safeCrop.suggestedRetailPrice,
          overseasRetailPrice: categoryChanged ? business.overseasRetailPrice : safeCrop.overseasRetailPrice,
          categoryConfidence: classification.confidence,
          categoryReasons: classification.reasons
        }],
        message: `该区域未找到可靠分隔线，已保留原区域并重新判断产品类型为“${classification.category}”。`
      }
    }
    const scaleX = safeCrop.width / raw.info.width
    const scaleY = safeCrop.height / raw.info.height
    const refined = localBoxes.slice(0, 12).map((box, index): CropBox => {
      const classification = classifyProductBox(raw.data, raw.info.width, raw.info.height, raw.info.channels, box, detection.background)
      const x = clampInteger(safeCrop.x + Math.floor(box.x * scaleX), safeCrop.x, safeCrop.x + safeCrop.width - 1)
      const y = clampInteger(safeCrop.y + Math.floor(box.y * scaleY), safeCrop.y, safeCrop.y + safeCrop.height - 1)
      const right = clampInteger(safeCrop.x + Math.ceil((box.x + box.width) * scaleX), x + 1, safeCrop.x + safeCrop.width)
      const bottom = clampInteger(safeCrop.y + Math.ceil((box.y + box.height) * scaleY), y + 1, safeCrop.y + safeCrop.height)
      const business = productBusinessSpecification(classification.category)
      return {
        id: randomUUID(), x, y, width: right - x, height: bottom - y,
        role: 'product-pattern', label: `${safeCrop.label}-${index + 1}`,
        productCategory: classification.category, patternGroupId: safeCrop.patternGroupId,
        suggestedRetailPrice: business.suggestedRetailPrice,
        overseasRetailPrice: business.overseasRetailPrice,
        material: '',
        confidence: round(clamp(0.62 + box.pixels / Math.max(1, box.width * box.height) * 0.35, 0.62, 0.95), 2),
        categoryConfidence: classification.confidence,
        categoryReasons: classification.reasons,
        patternNameEn: '', patternNameZh: '', nameCandidates: []
      }
    })
    return { crops: refined, message: `细分完成：1 个区域已拆成 ${refined.length} 个独立区域。` }
  }

  async exportConfirmedCrops(sourceImagePath: string, crops: CropBox[], outputDirectory: string): Promise<ExportedCropFile[]> {
    const safePath = await validateImagePath(sourceImagePath)
    const outputRoot = await realpath(outputDirectory)
    const metadata = await sharp(safePath, { limitInputPixels: MAX_SOURCE_PIXELS }).metadata()
    if (!metadata.width || !metadata.height) throw new Error('无法读取源图片尺寸')
    const rotated = isRotatedOrientation(metadata.orientation)
    const sourceWidth = rotated ? metadata.height : metadata.width
    const sourceHeight = rotated ? metadata.width : metadata.height
    const validated = crops.map((crop) => validateCrop(crop, sourceWidth, sourceHeight))
    const files: ExportedCropFile[] = []
    for (let index = 0; index < validated.length; index += 1) {
      const crop = validated[index]!
      const order = String(index).padStart(2, '0')
      const roleLabel = crop.role === 'series-overview' ? '全系列主图' : crop.productCategory
      const label = sanitizeFileSegment(crop.label || roleLabel)
      const fileName = `${order}-${sanitizeFileSegment(roleLabel)}-${label}.png`
      const destinationPath = join(outputRoot, fileName)
      const info = await sharp(safePath, { limitInputPixels: MAX_SOURCE_PIXELS })
        .rotate()
        .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toFile(destinationPath)
      files.push({ cropId: crop.id, fileName, path: destinationPath, width: info.width, height: info.height })
    }
    return files
  }
}

export function detectForegroundBoxes(data: Buffer | Uint8Array, width: number, height: number, channels: number, options: DetectionOptions = {}): DetectionResult {
  if (channels < 3) throw new Error('自动裁图需要 RGB 图片数据')
  const background = estimateBackground(data, width, height, channels)
  const adaptive = percentile(sampleBorderDistances(data, width, height, channels, background), 0.92) + 14
  const threshold = clamp(adaptive, 22, 72)
  const mask = createForegroundMask(data, width, height, channels, background, threshold)
  const radius = options.dilationRadius ?? clampInteger(Math.round(Math.min(width, height) * 0.0025), 1, 4)
  const components = connectedComponents(radius > 0 ? dilate(mask, width, height, radius) : mask, width, height)
  const total = width * height
  const minimumSide = Math.max(12, Math.round(Math.min(width, height) * 0.022))
  const padding = Math.max(3, Math.round(Math.min(width, height) * 0.008))
  const boxes = components
    .filter((box) => {
      const area = box.width * box.height
      return box.width >= minimumSide && box.height >= minimumSide && area >= total * (options.minimumAreaRatio ?? 0.0012) && box.pixels >= total * 0.00025 && area <= total * (options.maximumAreaRatio ?? 0.82)
    })
    .map((box) => padBox(box, padding, width, height))
    .sort(readingOrder)
  const distinct = removeContainedBoxes(removeNearDuplicates(boxes))
  const merged = mergeIntersectingFragments(distinct)
  return { boxes: removeContainedBoxes(removeNearDuplicates(merged)).sort(readingOrder), background, threshold }
}

function createForegroundMask(
  data: Buffer | Uint8Array,
  width: number,
  height: number,
  channels: number,
  background: [number, number, number],
  threshold: number
): Uint8Array {
  const mask = new Uint8Array(width * height)
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * channels
    if (colorDistance(data[offset] ?? 255, data[offset + 1] ?? 255, data[offset + 2] ?? 255, background) > threshold) mask[pixel] = 1
  }
  return mask
}

export function splitByVerticalGaps(mask: Uint8Array, width: number, height: number): PixelBox[] {
  const occupied = new Int32Array(width)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) occupied[x] = (occupied[x] ?? 0) + (mask[y * width + x] ?? 0)
  }
  const minimumInk = Math.max(2, Math.round(height * 0.007))
  const minimumGap = Math.max(4, Math.round(width * 0.012))
  const minimumSegmentWidth = Math.max(14, Math.round(width * 0.11))
  const segments: Array<[number, number]> = []
  let start = -1
  let lastInk = -1
  for (let x = 0; x < width; x += 1) {
    if ((occupied[x] ?? 0) >= minimumInk) {
      if (start < 0) start = x
      lastInk = x
    } else if (start >= 0 && x - lastInk >= minimumGap) {
      if (lastInk - start + 1 >= minimumSegmentWidth) segments.push([start, lastInk])
      start = -1
      lastInk = -1
    }
  }
  if (start >= 0 && lastInk - start + 1 >= minimumSegmentWidth) segments.push([start, lastInk])
  if (segments.length < 2 || segments.length > 12) return []
  const padding = Math.max(2, Math.round(Math.min(width, height) * 0.008))
  return segments.map(([left, right]) => {
    let top = height, bottom = -1, pixels = 0
    for (let y = 0; y < height; y += 1) {
      for (let x = left; x <= right; x += 1) {
        if (!mask[y * width + x]) continue
        top = Math.min(top, y); bottom = Math.max(bottom, y); pixels += 1
      }
    }
    const box: PixelBox = { x: left, y: Math.max(0, top), width: right - left + 1, height: Math.max(1, bottom - top + 1), pixels }
    return padBox(box, padding, width, height)
  }).filter((box) => box.height >= Math.max(12, height * 0.25))
}

export function splitWideSelection(mask: Uint8Array, width: number, height: number): PixelBox[] {
  const expectedCount = Math.round(width / Math.max(1, height))
  if (expectedCount < 2 || expectedCount > 10) return []
  const expectedWidth = width / expectedCount
  if (expectedWidth < height * 0.55 || expectedWidth > height * 1.35) return []
  const padding = Math.max(2, Math.round(Math.min(width, height) * 0.008))
  const boxes: PixelBox[] = []
  for (let index = 0; index < expectedCount; index += 1) {
    const segmentLeft = Math.round(index * width / expectedCount)
    const segmentRight = Math.round((index + 1) * width / expectedCount) - 1
    let left = width, right = -1, top = height, bottom = -1, pixels = 0
    for (let y = 0; y < height; y += 1) for (let x = segmentLeft; x <= segmentRight; x += 1) {
      if (!mask[y * width + x]) continue
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); pixels += 1
    }
    if (right < left || bottom < top) continue
    const box = padBox({ x: left, y: top, width: right - left + 1, height: bottom - top + 1, pixels }, padding, width, height)
    if (box.width >= expectedWidth * 0.42 && box.height >= height * 0.35) boxes.push(box)
  }
  return boxes.length === expectedCount ? boxes : []
}

function removeContainedBoxes(boxes: PixelBox[]): PixelBox[] {
  return boxes.filter((box, index) => !boxes.some((candidate, candidateIndex) => {
    if (index === candidateIndex || candidate.width * candidate.height <= box.width * box.height) return false
    const intersection = intersectionArea(box, candidate)
    return intersection / Math.max(1, box.width * box.height) >= 0.88
  }))
}

function intersectionArea(left: PixelBox, right: PixelBox): number {
  const x1 = Math.max(left.x, right.x), y1 = Math.max(left.y, right.y)
  const x2 = Math.min(left.x + left.width, right.x + right.width), y2 = Math.min(left.y + left.height, right.y + right.height)
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
}

export function mergeIntersectingFragments(boxes: PixelBox[]): PixelBox[] {
  const merged = boxes.map((box) => ({ ...box }))
  let changed = true
  while (changed) {
    changed = false
    outer: for (let leftIndex = 0; leftIndex < merged.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < merged.length; rightIndex += 1) {
        const left = merged[leftIndex]
        const right = merged[rightIndex]
        if (!left || !right || !shouldMergeFragments(left, right)) continue
        const x = Math.min(left.x, right.x)
        const y = Math.min(left.y, right.y)
        const farX = Math.max(left.x + left.width, right.x + right.width)
        const farY = Math.max(left.y + left.height, right.y + right.height)
        merged.splice(rightIndex, 1)
        merged[leftIndex] = {
          x, y, width: farX - x, height: farY - y,
          pixels: Math.min((farX - x) * (farY - y), left.pixels + right.pixels)
        }
        changed = true
        break outer
      }
    }
  }
  return merged
}

function shouldMergeFragments(left: PixelBox, right: PixelBox): boolean {
  const overlapWidth = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x))
  const overlapHeight = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y))
  if (overlapWidth <= 0 || overlapHeight <= 0) return false
  const horizontalOverlap = overlapWidth / Math.max(1, Math.min(left.width, right.width))
  const verticalOverlap = overlapHeight / Math.max(1, Math.min(left.height, right.height))
  const unionWidth = Math.max(left.x + left.width, right.x + right.width) - Math.min(left.x, right.x)
  const unionHeight = Math.max(left.y + left.height, right.y + right.height) - Math.min(left.y, right.y)
  const unionAspect = unionWidth / Math.max(1, unionHeight)
  return horizontalOverlap >= 0.16 && verticalOverlap >= 0.68 && unionAspect >= 0.72 && unionAspect <= 2.2
}

export function classifyProductBox(
  data: Buffer | Uint8Array,
  imageWidth: number,
  imageHeight: number,
  channels: number,
  box: PixelBox,
  background: [number, number, number]
): ProductClassification {
  const aspect = box.width / Math.max(1, box.height)
  const cornerForegroundRatio = measureCornerForegroundRatio(data, imageWidth, imageHeight, channels, box, background)

  // Aspect ratio alone is not enough to identify a round stand. It previously
  // turned near-square fragments from a MacBook artwork into stand products.
  if (aspect >= 0.82 && aspect <= 1.18 && cornerForegroundRatio <= 0.22) {
    const darkEdgeRatio = measureDarkEdgeRatio(data, imageWidth, imageHeight, channels, box)
    if (darkEdgeRatio >= 0.12) {
      return { category: '磁吸支架背盖', confidence: round(clamp(0.68 + darkEdgeRatio, 0.68, 0.86), 2), reasons: ['轮廓接近圆形且四角留白', `外圈深色占比约 ${Math.round(darkEdgeRatio * 100)}%，接近磁吸支架背盖`] }
    }
    return { category: '磁吸气囊支架', confidence: 0.76, reasons: ['轮廓接近圆形且四角留白', `外圈深色占比约 ${Math.round(darkEdgeRatio * 100)}%，整体偏浅或半透明`] }
  }

  if (aspect >= 1.2) {
    if (aspect >= 2.15) {
      return { category: '待确认', confidence: 0.35, reasons: ['区域宽度超过单个常见产品，可能包含多个并排图片，建议点击“细分识别”'] }
    }
    const roundHoleCount = countEnclosedRoundHoles(data, imageWidth, imageHeight, channels, box, background)
    if (roundHoleCount >= 4) {
      return {
        category: '镜头膜', confidence: round(clamp(0.72 + roundHoleCount * 0.025, 0.72, 0.9), 2),
        reasons: ['检测到横向圆角板状轮廓', `内部检测到 ${roundHoleCount} 个闭合圆形镜头孔，符合流沙镜头膜结构`]
      }
    }
    return {
      category: 'Macbook保护壳', confidence: 0.78,
      reasons: ['检测到单个横向长方形产品', '未检测到镜头膜的多圆孔结构，整体接近 MacBook 保护壳']
    }
  }

  if (aspect <= 0.86) {
    const cameraScore = measureCameraDarkRatio(data, imageWidth, imageHeight, channels, box)
    const cameraLensCount = countCameraLensCircles(data, imageWidth, imageHeight, channels, box)
    const cameraLowerEdgeScore = measureCameraLowerEdgeStraightness(data, imageWidth, imageHeight, channels, box)
    const phoneLike = aspect <= 0.7 && (cameraLensCount >= 2 || (aspect <= 0.62 && cameraScore >= 0.18))
    if (phoneLike) {
      if (cameraScore < 0.285 || (cameraLowerEdgeScore >= 0.47 && cameraScore < 0.34)) {
        return {
          category: '出镜壳', confidence: round(clamp(0.72 + cameraLowerEdgeScore * 0.16, 0.72, 0.82), 2),
          reasons: [`左上角检测到 ${cameraLensCount} 个镜头结构`, `镜头框下沿直线特征约 ${Math.round(cameraLowerEdgeScore * 100)}%，完整镜头深色区较少，接近出镜壳`]
        }
      }
      return {
        category: '磁吸背盖', confidence: round(clamp(0.72 + cameraScore * 0.3, 0.72, 0.86), 2),
        reasons: [`检测到竖向手机外形和 ${cameraLensCount} 个镜头结构`, `左上完整镜头深色区占比约 ${Math.round(cameraScore * 100)}%，下沿未呈现出镜壳的低密度直边特征`]
      }
    }

    const rim = measureOuterRimContinuity(data, imageWidth, imageHeight, channels, box)
    if (!rim.continuous) {
      return {
        category: '推卡卡包', confidence: 0.8,
        reasons: ['竖向卡片外形', `四边连续深色框得分仅 ${Math.round(rim.score * 100)}%，未检测到充电宝常见的黑边`]
      }
    }

    const indicatorCount = countBottomLeftIndicators(data, imageWidth, imageHeight, channels, box, background)
    if (indicatorCount === 5) {
      return {
        category: 'CP002磁吸充电宝', confidence: 0.78,
        reasons: ['检测到充电宝的四边连续黑框', '左下区域检测到 5 个对齐、近似等距的电量指示点；CP002 与 MP16 型号仍需人工确认']
      }
    }
    return {
      category: 'CP006自带线移动电源', confidence: 0.76,
      reasons: ['检测到充电宝的四边连续黑框', '左下未检测到规则的五点电量指示列，接近自带线移动电源']
    }
  }
  return { category: '其他', confidence: 0.35, reasons: ['外形未匹配当前已配置的主要产品规则，请人工选择'] }
}

interface RimContinuity {
  score: number
  continuous: boolean
}

function measureOuterRimContinuity(data: Buffer | Uint8Array, imageWidth: number, imageHeight: number, channels: number, box: PixelBox): RimContinuity {
  const left = measureVerticalDarkBand(data, imageWidth, imageHeight, channels, box, 0.015, 0.12)
  const right = measureVerticalDarkBand(data, imageWidth, imageHeight, channels, box, 0.88, 0.985)
  const top = measureHorizontalDarkBand(data, imageWidth, imageHeight, channels, box, 0.015, 0.09)
  const bottom = measureHorizontalDarkBand(data, imageWidth, imageHeight, channels, box, 0.91, 0.985)
  const vertical = Math.min(left, right)
  const horizontal = Math.min(top, bottom)
  return {
    score: clamp(vertical * 0.65 + horizontal * 0.35, 0, 1),
    continuous: left >= 0.55 && right >= 0.55 && top >= 0.45 && bottom >= 0.45
  }
}

function measureVerticalDarkBand(
  data: Buffer | Uint8Array,
  imageWidth: number,
  imageHeight: number,
  channels: number,
  box: PixelBox,
  startRatio: number,
  endRatio: number
): number {
  let matched = 0, sampled = 0
  const startX = Math.max(box.x, box.x + Math.round(box.width * startRatio))
  const endX = Math.min(imageWidth - 1, box.x + Math.round(box.width * endRatio))
  const startY = Math.max(box.y, box.y + Math.round(box.height * 0.08))
  const endY = Math.min(imageHeight - 1, box.y + Math.round(box.height * 0.92))
  for (let y = startY; y <= endY; y += 1) {
    let found = false
    for (let x = startX; x <= endX; x += 1) {
      if (pixelLuminance(data, imageWidth, channels, x, y) < 110) { found = true; break }
    }
    if (found) matched += 1
    sampled += 1
  }
  return sampled ? matched / sampled : 0
}

function measureHorizontalDarkBand(
  data: Buffer | Uint8Array,
  imageWidth: number,
  imageHeight: number,
  channels: number,
  box: PixelBox,
  startRatio: number,
  endRatio: number
): number {
  let matched = 0, sampled = 0
  const startY = Math.max(box.y, box.y + Math.round(box.height * startRatio))
  const endY = Math.min(imageHeight - 1, box.y + Math.round(box.height * endRatio))
  const startX = Math.max(box.x, box.x + Math.round(box.width * 0.08))
  const endX = Math.min(imageWidth - 1, box.x + Math.round(box.width * 0.92))
  for (let x = startX; x <= endX; x += 1) {
    let found = false
    for (let y = startY; y <= endY; y += 1) {
      if (pixelLuminance(data, imageWidth, channels, x, y) < 110) { found = true; break }
    }
    if (found) matched += 1
    sampled += 1
  }
  return sampled ? matched / sampled : 0
}

function measureDarkEdgeRatio(data: Buffer | Uint8Array, imageWidth: number, imageHeight: number, channels: number, box: PixelBox): number {
  let dark = 0, sampled = 0
  const insetX = Math.max(2, Math.round(box.width * 0.18))
  const insetY = Math.max(2, Math.round(box.height * 0.18))
  for (let y = box.y; y < Math.min(imageHeight, box.y + box.height); y += 2) {
    for (let x = box.x; x < Math.min(imageWidth, box.x + box.width); x += 2) {
      const localX = x - box.x, localY = y - box.y
      if (localX > insetX && localX < box.width - insetX && localY > insetY && localY < box.height - insetY) continue
      const offset = (y * imageWidth + x) * channels
      const luminance = ((data[offset] ?? 255) + (data[offset + 1] ?? 255) + (data[offset + 2] ?? 255)) / 3
      if (luminance < 185) dark += 1
      sampled += 1
    }
  }
  return sampled ? dark / sampled : 0
}

function measureCameraDarkRatio(data: Buffer | Uint8Array, imageWidth: number, imageHeight: number, channels: number, box: PixelBox): number {
  const right = Math.min(imageWidth, box.x + Math.round(box.width * 0.58))
  const bottom = Math.min(imageHeight, box.y + Math.round(box.height * 0.38))
  let dark = 0, sampled = 0
  for (let y = box.y; y < bottom; y += 2) for (let x = box.x; x < right; x += 2) {
    const offset = (y * imageWidth + x) * channels
    const luminance = ((data[offset] ?? 255) + (data[offset + 1] ?? 255) + (data[offset + 2] ?? 255)) / 3
    if (luminance < 75) dark += 1
    sampled += 1
  }
  return sampled ? dark / sampled : 0
}

function countCameraLensCircles(data: Buffer | Uint8Array, imageWidth: number, imageHeight: number, channels: number, box: PixelBox): number {
  const regionWidth = Math.max(1, Math.round(box.width * 0.62))
  const regionHeight = Math.max(1, Math.round(box.height * 0.4))
  const mask = new Uint8Array(regionWidth * regionHeight)
  for (let y = 0; y < regionHeight; y += 1) for (let x = 0; x < regionWidth; x += 1) {
    const sourceX = Math.min(imageWidth - 1, box.x + x)
    const sourceY = Math.min(imageHeight - 1, box.y + y)
    if (pixelLuminance(data, imageWidth, channels, sourceX, sourceY) < 92) mask[y * regionWidth + x] = 1
  }
  const regionArea = regionWidth * regionHeight
  return connectedComponents(mask, regionWidth, regionHeight).filter((component) => {
    const aspect = component.width / Math.max(1, component.height)
    const fill = component.pixels / Math.max(1, component.width * component.height)
    return component.pixels >= regionArea * 0.012
      && component.width >= regionWidth * 0.1 && component.width <= regionWidth * 0.4
      && component.height >= regionHeight * 0.08 && component.height <= regionHeight * 0.4
      && aspect >= 0.68 && aspect <= 1.45
      && fill >= 0.52
  }).length
}

function measureCameraLowerEdgeStraightness(data: Buffer | Uint8Array, imageWidth: number, imageHeight: number, channels: number, box: PixelBox): number {
  const startX = Math.max(box.x, box.x + Math.round(box.width * 0.03))
  const endX = Math.min(imageWidth - 1, box.x + Math.round(box.width * 0.62))
  const startY = Math.max(box.y, box.y + Math.round(box.height * 0.18))
  const endY = Math.min(imageHeight - 1, box.y + Math.round(box.height * 0.42))
  let longest = 0
  for (let y = startY; y <= endY; y += 1) {
    let run = 0
    for (let x = startX; x <= endX; x += 1) {
      if (pixelLuminance(data, imageWidth, channels, x, y) < 130) run += 1
      else run = 0
      longest = Math.max(longest, run)
    }
  }
  return longest / Math.max(1, box.width)
}

function measureCornerForegroundRatio(
  data: Buffer | Uint8Array,
  imageWidth: number,
  imageHeight: number,
  channels: number,
  box: PixelBox,
  background: [number, number, number]
): number {
  let foreground = 0, sampled = 0
  const corners = [
    [0.02, 0.22, 0.02, 0.22], [0.78, 0.98, 0.02, 0.22],
    [0.02, 0.22, 0.78, 0.98], [0.78, 0.98, 0.78, 0.98]
  ] as const
  for (const [left, right, top, bottom] of corners) {
    const startX = Math.max(box.x, box.x + Math.round(box.width * left))
    const endX = Math.min(imageWidth - 1, box.x + Math.round(box.width * right))
    const startY = Math.max(box.y, box.y + Math.round(box.height * top))
    const endY = Math.min(imageHeight - 1, box.y + Math.round(box.height * bottom))
    for (let y = startY; y <= endY; y += 2) for (let x = startX; x <= endX; x += 2) {
      const offset = (y * imageWidth + x) * channels
      if (colorDistance(data[offset] ?? 255, data[offset + 1] ?? 255, data[offset + 2] ?? 255, background) > 30) foreground += 1
      sampled += 1
    }
  }
  return sampled ? foreground / sampled : 0
}

function countEnclosedRoundHoles(
  data: Buffer | Uint8Array,
  imageWidth: number,
  imageHeight: number,
  channels: number,
  box: PixelBox,
  background: [number, number, number]
): number {
  const mask = new Uint8Array(box.width * box.height)
  for (let y = 0; y < box.height; y += 1) for (let x = 0; x < box.width; x += 1) {
    const sourceX = Math.min(imageWidth - 1, box.x + x)
    const sourceY = Math.min(imageHeight - 1, box.y + y)
    const offset = (sourceY * imageWidth + sourceX) * channels
    if (colorDistance(data[offset] ?? 255, data[offset + 1] ?? 255, data[offset + 2] ?? 255, background) <= 26) {
      mask[y * box.width + x] = 1
    }
  }
  const boxArea = box.width * box.height
  return connectedComponents(mask, box.width, box.height).filter((component) => {
    if (component.x === 0 || component.y === 0 || component.x + component.width === box.width || component.y + component.height === box.height) return false
    const areaRatio = component.pixels / Math.max(1, boxArea)
    const aspect = component.width / Math.max(1, component.height)
    const fill = component.pixels / Math.max(1, component.width * component.height)
    return areaRatio >= 0.0015 && areaRatio <= 0.14
      && aspect >= 0.72 && aspect <= 1.38
      && fill >= 0.68
  }).length
}

interface IndicatorDot {
  x: number
  y: number
  area: number
}

function countBottomLeftIndicators(
  data: Buffer | Uint8Array,
  imageWidth: number,
  imageHeight: number,
  channels: number,
  box: PixelBox,
  background: [number, number, number]
): number {
  const regionWidth = Math.max(1, Math.round(box.width * 0.36))
  const regionHeight = Math.max(1, Math.round(box.height * 0.3))
  const startY = Math.max(box.y, box.y + box.height - regionHeight)
  const mask = new Uint8Array(regionWidth * regionHeight)
  for (let y = 0; y < regionHeight; y += 1) for (let x = 0; x < regionWidth; x += 1) {
    const sourceX = Math.min(imageWidth - 1, box.x + x)
    const sourceY = Math.min(imageHeight - 1, startY + y)
    const offset = (sourceY * imageWidth + sourceX) * channels
    const luminance = pixelLuminance(data, imageWidth, channels, sourceX, sourceY)
    const distance = colorDistance(data[offset] ?? 255, data[offset + 1] ?? 255, data[offset + 2] ?? 255, background)
    if (luminance < 105 && distance > 60) mask[y * regionWidth + x] = 1
  }
  const regionArea = regionWidth * regionHeight
  const dots: IndicatorDot[] = connectedComponents(mask, regionWidth, regionHeight).filter((component) => {
    const area = component.width * component.height
    const fill = component.pixels / Math.max(1, area)
    const centerX = component.x + component.width / 2
    const centerY = component.y + component.height / 2
    return component.width >= Math.max(2, regionWidth * 0.008)
      && component.height >= Math.max(2, regionHeight * 0.008)
      && component.pixels >= Math.max(4, regionArea * 0.00005)
      && area <= regionArea * 0.012
      && component.width <= regionWidth * 0.14 && component.height <= regionHeight * 0.12
      && fill >= 0.3
      && centerX >= regionWidth * 0.06 && centerX <= regionWidth * 0.94
      && centerY >= regionHeight * 0.06 && centerY <= regionHeight * 0.94
  }).map((component) => ({
    x: component.x + component.width / 2,
    y: component.y + component.height / 2,
    area: component.pixels
  }))
  return hasAlignedFiveIndicators(dots, regionWidth, regionHeight) ? 5 : 0
}

function hasAlignedFiveIndicators(dots: IndicatorDot[], width: number, height: number): boolean {
  return hasAlignedIndicatorAxis(dots, 'vertical', width, height)
    || hasAlignedIndicatorAxis(dots, 'horizontal', width, height)
}

function hasAlignedIndicatorAxis(dots: IndicatorDot[], axis: 'vertical' | 'horizontal', width: number, height: number): boolean {
  const crossTolerance = Math.max(2, (axis === 'vertical' ? width : height) * 0.035)
  const axisLength = axis === 'vertical' ? height : width
  for (const anchor of dots) {
    const anchorCross = axis === 'vertical' ? anchor.x : anchor.y
    const aligned = dots.filter((dot) => Math.abs((axis === 'vertical' ? dot.x : dot.y) - anchorCross) <= crossTolerance)
      .toSorted((left, right) => (axis === 'vertical' ? left.y - right.y : left.x - right.x))
    for (let start = 0; start + 5 <= aligned.length; start += 1) {
      const group = aligned.slice(start, start + 5)
      const positions = group.map((dot) => axis === 'vertical' ? dot.y : dot.x)
      const gaps = positions.slice(1).map((position, index) => position - (positions[index] ?? position))
      const smallestGap = Math.min(...gaps)
      const largestGap = Math.max(...gaps)
      const areas = group.map((dot) => dot.area)
      const span = (positions.at(-1) ?? 0) - (positions[0] ?? 0)
      if (smallestGap >= Math.max(1, axisLength * 0.022)
        && largestGap <= smallestGap * 2.1
        && span >= axisLength * 0.12 && span <= axisLength * 0.75
        && Math.max(...areas) <= Math.max(1, Math.min(...areas)) * 3.5) return true
    }
  }
  return false
}

function estimateBackground(data: Buffer | Uint8Array, width: number, height: number, channels: number): [number, number, number] {
  const samples: Array<[number, number, number]> = []
  const thickness = Math.max(1, Math.round(Math.min(width, height) * 0.012))
  const step = Math.max(1, Math.round(Math.max(width, height) / 240))
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      if (x >= thickness && x < width - thickness && y >= thickness && y < height - thickness) continue
      const offset = (y * width + x) * channels
      samples.push([data[offset] ?? 255, data[offset + 1] ?? 255, data[offset + 2] ?? 255])
    }
  }
  if (samples.length === 0) return [255, 255, 255]
  return [median(samples.map((sample) => sample[0])), median(samples.map((sample) => sample[1])), median(samples.map((sample) => sample[2]))]
}

function sampleBorderDistances(data: Buffer | Uint8Array, width: number, height: number, channels: number, background: [number, number, number]): number[] {
  const values: number[] = []
  const step = Math.max(1, Math.round(Math.max(width, height) / 300))
  for (let x = 0; x < width; x += step) for (const y of [0, height - 1]) {
    const offset = (y * width + x) * channels
    values.push(colorDistance(data[offset] ?? 255, data[offset + 1] ?? 255, data[offset + 2] ?? 255, background))
  }
  for (let y = 0; y < height; y += step) for (const x of [0, width - 1]) {
    const offset = (y * width + x) * channels
    values.push(colorDistance(data[offset] ?? 255, data[offset + 1] ?? 255, data[offset + 2] ?? 255, background))
  }
  return values
}

function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const horizontal = new Uint8Array(mask.length)
  const output = new Uint8Array(mask.length)
  for (let y = 0; y < height; y += 1) {
    let count = 0
    for (let x = 0; x < width; x += 1) {
      const added = x + radius
      const removed = x - radius - 1
      if (added < width) count += mask[y * width + added] ?? 0
      if (removed >= 0) count -= mask[y * width + removed] ?? 0
      if (count > 0) horizontal[y * width + x] = 1
    }
  }
  for (let x = 0; x < width; x += 1) {
    let count = 0
    for (let y = 0; y < height; y += 1) {
      const added = y + radius
      const removed = y - radius - 1
      if (added < height) count += horizontal[added * width + x] ?? 0
      if (removed >= 0) count -= horizontal[removed * width + x] ?? 0
      if (count > 0) output[y * width + x] = 1
    }
  }
  return output
}

function connectedComponents(mask: Uint8Array, width: number, height: number): PixelBox[] {
  const visited = new Uint8Array(mask.length)
  const queue = new Int32Array(mask.length)
  const boxes: PixelBox[] = []
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue
    let head = 0, tail = 0, minX = width, minY = height, maxX = 0, maxY = 0, pixels = 0
    queue[tail++] = start
    visited[start] = 1
    while (head < tail) {
      const current = queue[head++]!
      const x = current % width
      const y = Math.floor(current / width)
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); pixels += 1
      visit(current - 1, x > 0); visit(current + 1, x + 1 < width); visit(current - width, y > 0); visit(current + width, y + 1 < height)
    }
    boxes.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, pixels })
    function visit(index: number, allowed: boolean): void {
      if (allowed && mask[index] && !visited[index]) { visited[index] = 1; queue[tail++] = index }
    }
  }
  return boxes
}

function padBox(box: PixelBox, padding: number, width: number, height: number): PixelBox {
  const x = Math.max(0, box.x - padding), y = Math.max(0, box.y - padding)
  const right = Math.min(width, box.x + box.width + padding), bottom = Math.min(height, box.y + box.height + padding)
  return { ...box, x, y, width: right - x, height: bottom - y }
}

function readingOrder(left: PixelBox, right: PixelBox): number {
  const tolerance = Math.max(12, Math.min(left.height, right.height) * 0.35)
  return Math.abs(left.y - right.y) <= tolerance ? left.x - right.x : left.y - right.y
}

function removeNearDuplicates(boxes: PixelBox[]): PixelBox[] {
  const accepted: PixelBox[] = []
  for (const box of boxes) if (!accepted.some((candidate) => intersectionOverUnion(box, candidate) > 0.72)) accepted.push(box)
  return accepted
}

function intersectionOverUnion(left: PixelBox, right: PixelBox): number {
  const x1 = Math.max(left.x, right.x), y1 = Math.max(left.y, right.y)
  const x2 = Math.min(left.x + left.width, right.x + right.width), y2 = Math.min(left.y + left.height, right.y + right.height)
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const union = left.width * left.height + right.width * right.height - intersection
  return union <= 0 ? 0 : intersection / union
}

async function validateImagePath(sourceImagePath: string): Promise<string> {
  if (!SUPPORTED_EXTENSIONS.has(extname(sourceImagePath).toLocaleLowerCase())) throw new Error('仅支持 PNG、JPG、WEBP、TIF 或 TIFF 图片')
  await access(sourceImagePath)
  const safePath = await realpath(sourceImagePath)
  const sourceStat = await stat(safePath)
  if (!sourceStat.isFile()) throw new Error('选择的路径不是图片文件')
  if (sourceStat.size > MAX_SOURCE_BYTES) throw new Error('图片超过 250 MB，请先压缩后再导入')
  return safePath
}

function validateCrop(crop: CropBox, sourceWidth: number, sourceHeight: number): CropBox {
  if (![crop.x, crop.y, crop.width, crop.height].every(Number.isInteger)) throw new Error(`裁剪框 ${crop.label} 的坐标必须是整数`)
  if (crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0) throw new Error(`裁剪框 ${crop.label} 的尺寸无效`)
  if (crop.x + crop.width > sourceWidth || crop.y + crop.height > sourceHeight) throw new Error(`裁剪框 ${crop.label} 超出原图范围`)
  return crop
}

function isManuallyConfirmedCategory(crop: CropBox): boolean {
  return crop.categoryConfidence === 1 && crop.categoryReasons.some((reason) => reason.includes('人工确认'))
}

export async function createUniqueExportDirectory(parentDirectory: string, seriesName: string): Promise<string> {
  const parent = await realpath(parentDirectory)
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '-')
  const base = `CASEBANG裁图-${sanitizeFileSegment(seriesName || '未命名系列')}-${stamp}`
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = join(parent, attempt === 0 ? base : `${base}-${attempt}`)
    try { await mkdir(candidate, { recursive: false }); return candidate } catch (reason) {
      if ((reason as NodeJS.ErrnoException).code !== 'EEXIST') throw reason
    }
  }
  throw new Error('无法建立唯一的裁图输出目录')
}

function sanitizeFileSegment(value: string): string {
  return value.normalize('NFKC').trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').slice(0, 80) || '未命名'
}
function isRotatedOrientation(orientation: number | undefined): boolean { return orientation !== undefined && orientation >= 5 && orientation <= 8 }
function colorDistance(red: number, green: number, blue: number, background: [number, number, number]): number { return Math.sqrt((red - background[0]) ** 2 + (green - background[1]) ** 2 + (blue - background[2]) ** 2) }
function pixelLuminance(data: Buffer | Uint8Array, imageWidth: number, channels: number, x: number, y: number): number {
  const offset = (y * imageWidth + x) * channels
  return ((data[offset] ?? 255) + (data[offset + 1] ?? 255) + (data[offset + 2] ?? 255)) / 3
}
function median(values: number[]): number { const sorted = values.toSorted((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] ?? 255 }
function percentile(values: number[], ratio: number): number { if (!values.length) return 0; const sorted = values.toSorted((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0 }
function rgbToHex(color: [number, number, number]): string { return `#${color.map((value) => clampInteger(value, 0, 255).toString(16).padStart(2, '0')).join('')}` }
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)) }
function clampInteger(value: number, minimum: number, maximum: number): number { return Math.round(clamp(value, minimum, maximum)) }
function round(value: number, digits: number): number { const power = 10 ** digits; return Math.round(value * power) / power }
