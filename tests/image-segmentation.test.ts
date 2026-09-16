import { describe, expect, it } from 'vitest'
import {
  classifyProductBox,
  detectForegroundBoxes,
  mergeIntersectingFragments,
  splitByVerticalGaps,
  splitWideSelection
} from '../src/main/modules/image/sharp-image-segmentation-service'
import { exportConfirmedCropsInputSchema } from '../src/shared/schemas'

describe('image segmentation', () => {
  it('finds separate objects on a white product board', () => {
    const width = 120
    const height = 80
    const data = Buffer.alloc(width * height * 3, 255)
    paintRectangle(data, width, 3, 12, 10, 24, 32, [25, 35, 45])
    paintRectangle(data, width, 3, 72, 18, 28, 40, [70, 90, 120])
    const result = detectForegroundBoxes(data, width, height, 3)
    expect(result.background).toEqual([255, 255, 255])
    expect(result.boxes).toHaveLength(2)
    expect(result.boxes[0]?.x).toBeLessThan(result.boxes[1]?.x ?? 0)
  })

  it('requires exactly one series overview before export', () => {
    const common = {
      sourceImagePath: 'C:\\images\\board.png',
      seriesName: 'Hangzhou Limited Series',
      crops: [{
        id: 'product-1', x: 0, y: 0, width: 100, height: 100,
        role: 'product-pattern' as const,
        label: 'Mint Dot', productCategory: '磁吸背盖' as const,
        suggestedRetailPrice: 89, overseasRetailPrice: 19.99, material: '',
        patternGroupId: null, confidence: 0.9,
        categoryConfidence: 0.7, categoryReasons: ['测试初判'],
        patternNameEn: '', patternNameZh: '', nameCandidates: []
      }]
    }
    expect(exportConfirmedCropsInputSchema.safeParse(common).success).toBe(false)
    expect(exportConfirmedCropsInputSchema.safeParse({
      ...common,
      crops: [{ ...common.crops[0], id: 'overview', role: 'series-overview' as const }]
    }).success).toBe(true)
  })

  it('splits a wide selected region at reliable vertical gaps', () => {
    const width = 180
    const height = 60
    const mask = new Uint8Array(width * height)
    for (const [left, right] of [[4, 50], [66, 112], [128, 174]] as Array<[number, number]>) {
      for (let y = 5; y < 55; y += 1) for (let x = left; x <= right; x += 1) mask[y * width + x] = 1
    }
    const boxes = splitByVerticalGaps(mask, width, height)
    expect(boxes).toHaveLength(3)
    expect(boxes.map((box) => box.x)).toEqual([...boxes.map((box) => box.x)].sort((a, b) => a - b))
  })

  it('splits three touching round products by the selected region shape', () => {
    const width = 300
    const height = 100
    const mask = new Uint8Array(width * height)
    for (let y = 8; y < 92; y += 1) for (let x = 5; x < 295; x += 1) mask[y * width + x] = 1
    const boxes = splitWideSelection(mask, width, height)
    expect(boxes).toHaveLength(3)
    expect(boxes.every((box) => box.width >= 90 && box.width <= 110)).toBe(true)
  })

  it('merges overlapping fragments that belong to one wide notebook shell', () => {
    const result = mergeIntersectingFragments([
      { x: 10, y: 10, width: 90, height: 80, pixels: 4_000 },
      { x: 82, y: 12, width: 90, height: 78, pixels: 4_000 }
    ])
    expect(result).toEqual([{ x: 10, y: 10, width: 162, height: 80, pixels: 8_000 }])
  })

  it('recognizes lens protectors by their wide perforated plate shape', () => {
    const image = createProductCanvas(190, 120, { x: 10, y: 10, width: 170, height: 100 })
    for (const [x, y, radius] of [[40, 38, 14], [80, 60, 18], [132, 38, 11], [142, 72, 8], [45, 82, 13]] as const) {
      paintCircle(image.data, image.width, 3, x, y, radius, [255, 255, 255])
    }
    expect(classifyProductBox(image.data, image.width, image.height, 3, image.box, [255, 255, 255]).category).toBe('镜头膜')
  })

  it('recognizes a wide solid rectangle as a MacBook shell instead of a stand', () => {
    const image = createProductCanvas(190, 120, { x: 10, y: 10, width: 170, height: 100 })
    expect(classifyProductBox(image.data, image.width, image.height, 3, image.box, [255, 255, 255]).category).toBe('Macbook保护壳')
  })

  it('distinguishes power banks and a push-card wallet by border and indicator dots', () => {
    const withoutDots = createProductCanvas(100, 150, { x: 10, y: 10, width: 80, height: 120 }, true)
    expect(classifyProductBox(withoutDots.data, withoutDots.width, withoutDots.height, 3, withoutDots.box, [255, 255, 255]).category).toBe('CP006自带线移动电源')

    const withDots = createProductCanvas(140, 200, { x: 10, y: 10, width: 120, height: 180 }, true)
    for (const y of [142, 148, 154, 160, 166]) paintCircle(withDots.data, withDots.width, 3, 28, y, 2, [20, 20, 20])
    expect(classifyProductBox(withDots.data, withDots.width, withDots.height, 3, withDots.box, [255, 255, 255]).category).toBe('CP002磁吸充电宝')

    const wallet = createProductCanvas(100, 150, { x: 10, y: 10, width: 80, height: 120 })
    expect(classifyProductBox(wallet.data, wallet.width, wallet.height, 3, wallet.box, [255, 255, 255]).category).toBe('推卡卡包')
  })

  it('does not classify a filled square fragment as a round support', () => {
    const image = createProductCanvas(120, 120, { x: 10, y: 10, width: 100, height: 100 })
    expect(classifyProductBox(image.data, image.width, image.height, 3, image.box, [255, 255, 255]).category).toBe('其他')
  })

  it('recognizes a circular support even when its crop is tight', () => {
    const data = Buffer.alloc(120 * 120 * 3, 255)
    paintCircle(data, 120, 3, 60, 60, 46, [25, 25, 25])
    paintCircle(data, 120, 3, 60, 60, 36, [205, 220, 225])
    const category = classifyProductBox(
      data, 120, 120, 3,
      { x: 10, y: 10, width: 100, height: 100, pixels: 6_650 },
      [255, 255, 255]
    ).category
    expect(category).toBe('磁吸支架背盖')
  })
})

function createProductCanvas(
  width: number,
  height: number,
  box: { x: number; y: number; width: number; height: number },
  blackBorder = false
): { data: Buffer; width: number; height: number; box: { x: number; y: number; width: number; height: number; pixels: number } } {
  const data = Buffer.alloc(width * height * 3, 255)
  paintRectangle(data, width, 3, box.x, box.y, box.width, box.height, blackBorder ? [25, 25, 25] : [185, 205, 215])
  if (blackBorder) paintRectangle(data, width, 3, box.x + 5, box.y + 5, box.width - 10, box.height - 10, [210, 225, 230])
  return { data, width, height, box: { ...box, pixels: box.width * box.height } }
}

function paintCircle(
  data: Buffer,
  width: number,
  channels: number,
  centerX: number,
  centerY: number,
  radius: number,
  color: [number, number, number]
): void {
  for (let y = centerY - radius; y <= centerY + radius; y += 1) for (let x = centerX - radius; x <= centerX + radius; x += 1) {
    if ((x - centerX) ** 2 + (y - centerY) ** 2 <= radius ** 2) {
      const offset = (y * width + x) * channels
      data[offset] = color[0]
      data[offset + 1] = color[1]
      data[offset + 2] = color[2]
    }
  }
}

function paintRectangle(
  data: Buffer,
  width: number,
  channels: number,
  x: number,
  y: number,
  rectangleWidth: number,
  rectangleHeight: number,
  color: [number, number, number]
): void {
  for (let row = y; row < y + rectangleHeight; row += 1) {
    for (let column = x; column < x + rectangleWidth; column += 1) {
      const offset = (row * width + column) * channels
      data[offset] = color[0]
      data[offset + 1] = color[1]
      data[offset + 2] = color[2]
    }
  }
}
