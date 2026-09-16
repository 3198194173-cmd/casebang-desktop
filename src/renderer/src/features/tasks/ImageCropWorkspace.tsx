import { applyMaterial } from '@shared/material-recognition'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent, SetStateAction } from 'react'
import type { CropBox, ImageAnalysisResult, ProductCategory } from '@shared/image-contracts'
import { BARCODE_PRICE_PRESETS, MATERIAL_COLOR_OPTIONS, isPairedWireless, wirelessPrices, productBusinessSpecification } from '@shared/product-business-rules'
import { sanitizeEnglishPatternNameInput } from '@shared/pattern-name'
import { applyBatchNameSuggestions, mergeForbiddenEnglishNames } from '@shared/image-naming-state'
import { desktopApi } from '../../app/desktop-api'
import type { HistoricalPatternOption } from './existing-series'
import { HistoricalNamePicker } from './HistoricalNamePicker'

interface ImageCropWorkspaceProps {
  sourceImagePath: string
  seriesNameZh: string
  seriesNameEn: string
  productTypes: string[]
  domesticEnglishNames: string[]
  historicalPatterns?: HistoricalPatternOption[]
  comparisonMode?: boolean
  duplicateNameIssues: Record<string, string[]>
  analysis: ImageAnalysisResult | null
  setAnalysis: Dispatch<SetStateAction<ImageAnalysisResult | null>>
  chooseImage: () => Promise<string | null>
}

interface DragState {
  cropId: string
  mode: 'move' | 'resize'
  startClientX: number
  startClientY: number
  startCrop: CropBox
}

interface AiBatchStatus {
  kind: 'running' | 'success' | 'warning' | 'error'
  text: string
}

export function ImageCropWorkspace({
  sourceImagePath,
  seriesNameZh,
  seriesNameEn,
  productTypes,
  domesticEnglishNames,
  historicalPatterns = [],
  comparisonMode = false,
  duplicateNameIssues,
  analysis,
  setAnalysis,
  chooseImage
}: ImageCropWorkspaceProps): React.JSX.Element {
  const [selectedCropId, setSelectedCropId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [refining, setRefining] = useState(false)
  const [naming, setNaming] = useState(false)
  const [materialMessage, setMaterialMessage] = useState('')
  const materialRun = useRef(0)
  useEffect(() => { materialRun.current++; setMaterialMessage(''); return () => { materialRun.current++ } }, [analysis?.sourceImagePath])
  const [batchNaming, setBatchNaming] = useState(false)
  const [batchStatus, setBatchStatus] = useState<AiBatchStatus | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [workspaceMode, setWorkspaceMode] = useState<'crop' | 'group'>('crop')
  const [draggedPatternId, setDraggedPatternId] = useState<string | null>(null)
  const [patternDropTarget, setPatternDropTarget] = useState<string | null>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const propertiesRef = useRef<HTMLDivElement>(null)
  const arrangementScrollRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const scrollFrame = useRef<number | null>(null)
  const scrollY = useRef(0)
  const arrangementThumbnails = useMemo(() => new Map(analysis?.crops.map((crop, index) => [crop.id, {
    index,
    style: { ...thumbnailStyle(crop, analysis), aspectRatio: `${crop.width} / ${crop.height}` }
  }]) ?? []), [analysis])
  useEffect(() => () => { if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current) }, [])
  const selectedCrop = useMemo(
    () => analysis?.crops.find((crop) => crop.id === selectedCropId) ?? analysis?.crops[0] ?? null,
    [analysis, selectedCropId]
  )
  const selectedBusiness = selectedCrop ? productBusinessSpecification(selectedCrop.productCategory) : null
  useEffect(() => { if (comparisonMode && propertiesRef.current) propertiesRef.current.scrollTop = 0 }, [selectedCrop?.id, comparisonMode])
  const selectedPricePreset = selectedCrop
    ? BARCODE_PRICE_PRESETS.find((preset) => preset.suggestedRetailPrice === selectedCrop.suggestedRetailPrice
      && preset.overseasRetailPrice === selectedCrop.overseasRetailPrice)
    : undefined
  const availableProductTypes = useMemo(
    () => [...new Set(['待确认', ...productTypes, '其他'])],
    [productTypes]
  )
  const selectedDuplicateIssues = selectedCrop ? duplicateNameIssues[selectedCrop.id] ?? [] : []
  const requiredIssuesByCropId = useMemo(() => new Map(
    (analysis?.crops ?? []).flatMap((crop) => {
      const issues = requiredCropFieldIssues(crop)
      return issues.length > 0 ? [[crop.id, issues] as const] : []
    })
  ), [analysis])
  const missingRequiredCrops = useMemo(
    () => (analysis?.crops ?? []).filter((crop) => requiredIssuesByCropId.has(crop.id)),
    [analysis, requiredIssuesByCropId]
  )
  const selectedRequiredIssues = selectedCrop ? requiredIssuesByCropId.get(selectedCrop.id) ?? [] : []
  const patternGroups = useMemo(
    () => buildPatternGroupOptions(analysis?.crops ?? []),
    [analysis]
  )
  const namingSummary = useMemo(
    () => summarizeNamingUnits(analysis?.crops ?? []),
    [analysis]
  )
  const remainingNamingCount = useMemo(
    () => buildNamingTargets((analysis?.crops ?? []).filter((crop) => crop.role !== 'series-overview' && !crop.patternNameEn.trim())).length,
    [analysis]
  )
  const duplicateNamingRegions = useMemo(
    () => (analysis?.crops ?? []).filter((crop) => crop.role !== 'series-overview' && Boolean(duplicateNameIssues[crop.id]?.length)),
    [analysis, duplicateNameIssues]
  )
  const duplicateNamingCount = useMemo(
    () => buildNamingTargets(duplicateNamingRegions).length,
    [duplicateNamingRegions]
  )
  const duplicateRegionCount = duplicateNamingRegions.length
  const independentPatterns = useMemo(
    () => (analysis?.crops ?? []).filter((crop) => crop.role !== 'series-overview' && !crop.patternGroupId),
    [analysis]
  )
  const arrangedPatternGroups = useMemo(
    () => patternGroups.map((group) => ({
      ...group,
      members: (analysis?.crops ?? []).filter((crop) => crop.role !== 'series-overview' && crop.patternGroupId === group.id)
    })),
    [analysis, patternGroups]
  )

  const analyze = async (path = sourceImagePath): Promise<void> => {
    if (!path) {
      setMessage('请先选择一张产品排版总图。')
      return
    }
    try {
      setBusy(true)
      setMessage(null)
      setBatchStatus(null)
      const result = await desktopApi.images.analyze({ sourceImagePath: path })
      const crops = assignAutomaticStandGroups(result.crops.map((crop) => normalizeCrop(crop, result.sourceWidth, result.sourceHeight)))
      setAnalysis({ ...result, crops })
      setSelectedCropId(result.crops[0]?.id ?? null)
      const pairedCount = crops.filter((crop) => crop.patternGroupId?.startsWith('auto-stand-')).length / 2
      setMessage(`识别完成：保留 1 张全系列主图，并找到 ${Math.max(0, result.crops.length - 1)} 个候选区域。${pairedCount > 0 ? `已自动建立 ${pairedCount} 对支架同图案组。` : ''}`)
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '图片识别失败')
    } finally {
      setBusy(false)
    }
  }

  const chooseAndAnalyze = async (): Promise<void> => {
    const path = await chooseImage()
    if (path) await analyze(path)
  }

  const updateCrop = (cropId: string, patch: Partial<CropBox>): void => {
    setAnalysis((current) => {
      if (!current) return current
      return {
        ...current,
        crops: current.crops.map((crop) =>
          crop.id === cropId
            ? normalizeCrop({ ...crop, ...patch }, current.sourceWidth, current.sourceHeight)
            : crop
        )
      }
    })
  }

  const updatePatternName = (cropId: string, patternNameEn: string, patternNameZh: string): void => {
    const safePatternNameEn = sanitizeEnglishPatternNameInput(patternNameEn)
    setAnalysis((current) => {
      if (!current) return current
      const source = current.crops.find((crop) => crop.id === cropId)
      if (!source) return current
      return {
        ...current,
        crops: current.crops.map((crop) =>
          crop.id === cropId || (source.patternGroupId && crop.patternGroupId === source.patternGroupId)
            ? { ...crop, patternNameEn: safePatternNameEn, patternNameZh }
            : crop
        )
      }
    })
  }

  const updateProductCategory = (cropId: string, productCategory: ProductCategory): void => {
    const business = productBusinessSpecification(productCategory)
    setAnalysis((current) => current ? {
      ...current,
      crops: current.crops.map((crop) => crop.id === cropId
        ? {
            ...crop,
            productCategory,
            suggestedRetailPrice: business.suggestedRetailPrice,
            overseasRetailPrice: business.overseasRetailPrice,
            material: crop.material,
            categoryConfidence: 1,
            categoryReasons: ['已由人工确认产品类别']
          }
        : crop)
    } : current)
  }

  const makePatternIndependent = (cropId: string): void => {
    setAnalysis((current) => current ? {
      ...current,
      crops: cleanupSingletonPatternGroups(current.crops.map((crop) => crop.id === cropId
        ? { ...crop, patternGroupId: null }
        : crop))
    } : current)
  }

  const linkPatternWithCrop = (cropId: string, otherCropId: string): void => {
    if (!otherCropId || cropId === otherCropId) return
    setAnalysis((current) => {
      if (!current) return current
      const source = current.crops.find((crop) => crop.id === cropId)
      const target = current.crops.find((crop) => crop.id === otherCropId)
      if (!source || !target || source.role === 'series-overview' || target.role === 'series-overview') return current
      const patternGroupId = target.patternGroupId ?? `manual-pattern-${globalThis.crypto.randomUUID()}`
      const namedTarget = current.crops.find((crop) => crop.patternGroupId === patternGroupId && crop.patternNameEn.trim()) ?? target
      const patternNameEn = namedTarget.patternNameEn.trim() ? namedTarget.patternNameEn : source.patternNameEn
      const patternNameZh = namedTarget.patternNameZh.trim() ? namedTarget.patternNameZh : source.patternNameZh
      const crops = current.crops.map((crop) => crop.id === source.id || crop.id === target.id || crop.patternGroupId === patternGroupId
        ? { ...crop, patternGroupId, patternNameEn, patternNameZh }
        : crop)
      return { ...current, crops: cleanupSingletonPatternGroups(crops) }
    })
  }

  const movePatternToGroup = (cropId: string, patternGroupId: string): void => {
    setAnalysis((current) => {
      if (!current) return current
      const source = current.crops.find((crop) => crop.id === cropId)
      const target = current.crops.find((crop) => crop.patternGroupId === patternGroupId && crop.id !== cropId && crop.patternNameEn.trim())
        ?? current.crops.find((crop) => crop.patternGroupId === patternGroupId && crop.id !== cropId)
      if (!source || !target || source.role === 'series-overview' || source.patternGroupId === patternGroupId) return current
      const patternNameEn = target.patternNameEn.trim() ? target.patternNameEn : source.patternNameEn
      const patternNameZh = target.patternNameZh.trim() ? target.patternNameZh : source.patternNameZh
      const crops = current.crops.map((crop) => crop.id === source.id || crop.patternGroupId === patternGroupId
        ? { ...crop, patternGroupId, patternNameEn, patternNameZh }
        : crop)
      return { ...current, crops: cleanupSingletonPatternGroups(crops) }
    })
  }

  const beginPatternDrag = (event: ReactDragEvent<HTMLElement>, cropId: string): void => {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-casebang-pattern', cropId)
    event.dataTransfer.setData('text/plain', cropId)
    setDraggedPatternId(cropId)
  }

  const allowPatternDrop = (event: ReactDragEvent<HTMLElement>, target: string): void => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    scrollY.current = event.clientY
    if (scrollFrame.current === null) {
      scrollFrame.current = requestAnimationFrame(() => {
        scrollFrame.current = null
        autoScrollArrangement(scrollY.current)
      })
    }
    setPatternDropTarget((current) => current === target ? current : target)
  }

  const autoScrollArrangement = (clientY: number): void => {
    const container = arrangementScrollRef.current
    if (!container) return
    const bounds = container.getBoundingClientRect()
    const edge = Math.min(110, Math.max(64, bounds.height * 0.18))
    const distanceFromTop = clientY - bounds.top
    const distanceFromBottom = bounds.bottom - clientY
    if (distanceFromTop < edge) {
      const intensity = Math.max(0, Math.min(1, (edge - distanceFromTop) / edge))
      container.scrollTop -= Math.ceil(8 + intensity * 30)
    } else if (distanceFromBottom < edge) {
      const intensity = Math.max(0, Math.min(1, (edge - distanceFromBottom) / edge))
      container.scrollTop += Math.ceil(8 + intensity * 30)
    }
  }

  const finishPatternDrag = (): void => {
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current)
    scrollFrame.current = null
    setDraggedPatternId(null)
    setPatternDropTarget(null)
  }

  const draggedCropIdFromEvent = (event: ReactDragEvent<HTMLElement>): string | null => (
    event.dataTransfer.getData('application/x-casebang-pattern')
    || event.dataTransfer.getData('text/plain')
    || draggedPatternId
    || null
  )

  const dropPatternAsIndependent = (event: ReactDragEvent<HTMLElement>): void => {
    event.preventDefault()
    const cropId = draggedCropIdFromEvent(event)
    if (cropId) {
      makePatternIndependent(cropId)
      setMessage('已移回独立图案；它将单独占用一个命名数量。')
    }
    finishPatternDrag()
  }

  const dropPatternOnCrop = (event: ReactDragEvent<HTMLElement>, targetCropId: string): void => {
    event.preventDefault()
    event.stopPropagation()
    const cropId = draggedCropIdFromEvent(event)
    if (cropId && cropId !== targetCropId) {
      linkPatternWithCrop(cropId, targetCropId)
      setMessage('图案已合并到同一组；只共用名称，产品类型和编码仍保持独立。')
    }
    finishPatternDrag()
  }

  const dropPatternOnGroup = (event: ReactDragEvent<HTMLElement>, patternGroupId: string): void => {
    event.preventDefault()
    const cropId = draggedCropIdFromEvent(event)
    if (cropId) {
      movePatternToGroup(cropId, patternGroupId)
      setMessage('图案已移动到目标组，排组视图已自动重新排列。')
    }
    finishPatternDrag()
  }

  const addCrop = (): void => {
    if (!analysis) return
    const crop: CropBox = normalizeCrop({
      id: globalThis.crypto.randomUUID(),
      x: Math.round(analysis.sourceWidth * 0.1),
      y: Math.round(analysis.sourceHeight * 0.1),
      width: Math.round(analysis.sourceWidth * 0.28),
      height: Math.round(analysis.sourceHeight * 0.28),
      role: 'product-pattern',
      label: `手工区域 ${analysis.crops.length}`,
      productCategory: '待确认',
      suggestedRetailPrice: null,
      overseasRetailPrice: null,
      material: '',
      patternGroupId: null,
      confidence: 1,
      categoryConfidence: null,
      categoryReasons: ['手工添加区域，等待产品类型确认'],
      patternNameEn: '', patternNameZh: '', nameCandidates: []
    }, analysis.sourceWidth, analysis.sourceHeight)
    setAnalysis({ ...analysis, crops: [...analysis.crops, crop] })
    setSelectedCropId(crop.id)
  }

  const deleteSelected = (): void => {
    if (!analysis || !selectedCrop) return
    if (selectedCrop.role === 'series-overview') {
      setMessage('全系列主图是后续命名和表格写入的基准，不能删除。')
      return
    }
    const selectedIndex = analysis.crops.findIndex((crop) => crop.id === selectedCrop.id)
    const crops = cleanupSingletonPatternGroups(analysis.crops.filter((crop) => crop.id !== selectedCrop.id))
    const nextCrop = crops[selectedIndex]
      ?? crops[selectedIndex - 1]
      ?? crops.find((crop) => crop.role !== 'series-overview')
      ?? crops[0]
    setAnalysis({ ...analysis, crops })
    setSelectedCropId(nextCrop?.id ?? null)
    dragRef.current = null
    setMessage(nextCrop?.role === 'series-overview'
      ? '区域已删除；当前没有其他产品区域。'
      : `区域已删除，已自动切换到“${nextCrop?.label ?? '相邻区域'}”。`)
  }

  const exportCrops = async (): Promise<void> => {
    if (!analysis || analysis.crops.length === 0) return
    try {
      setExporting(true)
      const result = await desktopApi.images.exportCrops({
        sourceImagePath: analysis.sourceImagePath,
        seriesName: seriesNameEn || seriesNameZh,
        crops: analysis.crops
      })
      if (!result.canceled) setMessage(`已导出 ${result.files.length} 张图片：${result.outputDirectory}`)
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '裁图导出失败')
    } finally {
      setExporting(false)
    }
  }

  const refineSelected = async (): Promise<void> => {
    if (!analysis || !selectedCrop || selectedCrop.role === 'series-overview') return
    try {
      setRefining(true)
      setMessage(null)
      const result = await desktopApi.images.refineCrop({
        sourceImagePath: analysis.sourceImagePath,
        crop: selectedCrop
      })
      const selectedIndex = analysis.crops.findIndex((crop) => crop.id === selectedCrop.id)
      const crops = [...analysis.crops]
      crops.splice(selectedIndex, 1, ...result.crops)
      setAnalysis({ ...analysis, crops: assignAutomaticStandGroups(crops) })
      setSelectedCropId(result.crops[0]?.id ?? null)
      setMessage(result.message)
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '区域细分识别失败')
    } finally {
      setRefining(false)
    }
  }

  const recognizeMaterials = async (crops: CropBox[]): Promise<void> => {
    if (!analysis) return
    const run = ++materialRun.current
    let failures = 0
    for (let i = 0; i < crops.length; i++) {
      if (run !== materialRun.current) return
      const crop = crops[i]!
      setMaterialMessage(`材质识别 ${i + 1}/${crops.length}：${crop.label}`)
      const input = { sourceImagePath: analysis.sourceImagePath, crop }
      try {
        const result = await desktopApi.ai.recognizeMaterial(input)
        if (run !== materialRun.current) return
        setAnalysis(current => current ? applyMaterial(current, input, result) : current)
      } catch { failures++ }
    }
    setMaterialMessage(`材质识别完成：${crops.length - failures}/${crops.length}；${failures ? `${failures} 项识别失败，保留原值，请人工填写。` : '已填写到各产品颜色（材质），请核对；可手动修改。'}`)
  }

  const suggestNames = async (): Promise<void> => {
    if (!analysis || !selectedCrop || selectedCrop.role === 'series-overview') return
    const materials = recognizeMaterials(analysis.crops.filter(c => c.id === selectedCrop.id || (selectedCrop.patternGroupId && c.patternGroupId === selectedCrop.patternGroupId && c.role !== 'series-overview')))
    const existingEnglishNames = mergeForbiddenEnglishNames(analysis.crops
      .filter((crop) => crop.role !== 'series-overview' && crop.patternNameEn.trim())
      .map((crop) => crop.patternNameEn))
    try {
      setNaming(true)
      setMessage(null)
      const result = await desktopApi.ai.suggestImageNames({
        sourceImagePath: analysis.sourceImagePath,
        crop: selectedCrop,
        seriesNameZh,
        seriesNameEn,
        existingEnglishNames,
        forbiddenEnglishNames: mergeForbiddenEnglishNames(domesticEnglishNames)
      })
      const first = result.candidates[0]
      updateCrop(selectedCrop.id, {
        nameCandidates: result.candidates
      })
      if (first && !selectedCrop.patternNameEn.trim()) updatePatternName(selectedCrop.id, first.englishName, first.chineseName)
      setMessage(`已由 ${result.model} 提供 ${result.candidates.length} 个名称建议，可选择或手工修改。`)
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'AI 图片命名失败')
    } finally {
      await materials
      setNaming(false)
    }
  }

  const suggestAllNames = async (): Promise<void> => {
    if (!analysis) return
    const unnamedRegions = analysis.crops.filter((crop) => crop.role !== 'series-overview' && !crop.patternNameEn.trim())
    const duplicateRegions = analysis.crops.filter((crop) => crop.role !== 'series-overview' && Boolean(duplicateNameIssues[crop.id]?.length))
    const targetRegions = uniqueCropsById([...duplicateRegions, ...unnamedRegions])
    const targets = buildNamingTargets(targetRegions)
    const renamingDuplicates = duplicateRegions.length > 0
    const existingEnglishNames = mergeForbiddenEnglishNames(analysis.crops
      .filter((crop) => crop.role !== 'series-overview' && crop.patternNameEn.trim())
      .map((crop) => crop.patternNameEn))
    if (targets.length === 0) {
      setBatchNaming(true)
      await recognizeMaterials(analysis.crops.filter(c => c.role !== 'series-overview'))
      setBatchNaming(false)
      const completeMessage = '所有产品区域都已有英文名称；如需修改，请选择区域后使用“单图重新建议”。'
      setMessage(completeMessage)
      setBatchStatus({ kind: 'success', text: completeMessage })
      return
    }
    const materials = recognizeMaterials(analysis.crops.filter(c => c.role !== 'series-overview'))
    try {
      setBatchNaming(true)
      const runningMessage = renamingDuplicates
        ? `正在一次性重新命名 ${buildNamingTargets(duplicateRegions).length} 个重复图案，并补齐尚未命名的图案；图案组只识别一次，产品类型和编码仍保持分开。`
        : `正在识别 ${targets.length} 个图案（对应 ${targetRegions.length} 个产品区域）；同图案只命名一次，但产品类型、编码和写表记录保持分开。`
      setMessage(runningMessage)
      setBatchStatus({ kind: 'running', text: runningMessage })
      const result = await desktopApi.ai.suggestImageNamesBatch({
        sourceImagePath: analysis.sourceImagePath,
        crops: targets,
        seriesNameZh,
        seriesNameEn,
        existingEnglishNames,
        forbiddenEnglishNames: mergeForbiddenEnglishNames(domesticEnglishNames)
      })
      setAnalysis((current) => current ? {
        ...current,
        crops: applyBatchNameSuggestions(current.crops, targets, result.items)
      } : current)
      const firstRecognizedCropId = result.items[0]?.cropId
      const recognizedCropIds = new Set(result.items.map((item) => item.cropId))
      const firstUnresolvedCropId = targets.find((crop) => !recognizedCropIds.has(crop.id))?.id
      if (firstUnresolvedCropId || firstRecognizedCropId) setSelectedCropId(firstUnresolvedCropId ?? firstRecognizedCropId ?? null)
      const missingCount = Math.max(0, targets.length - result.items.length)
      const warningCount = result.warnings?.length ?? 0
      const warningText = result.warnings?.join('；') ?? ''
      const completeMessage = missingCount === 0 && warningCount === 0
        ? `${renamingDuplicates ? '重复项重新命名' : '批量命名'}完成：${result.items.length}/${targets.length} 个图案已由 ${result.model} 命名，并同步到 ${targetRegions.length} 个产品记录；系统会立即重新检测重复名称。`
        : `批量命名部分完成：成功 ${result.items.length}/${targets.length} 个图案，${missingCount} 个仍需人工确认。${warningText}`
      setMessage(completeMessage)
      setBatchStatus({ kind: missingCount === 0 && warningCount === 0 ? 'success' : 'warning', text: completeMessage })
    } catch (reason) {
      const errorMessage = reason instanceof Error ? reason.message : 'AI 批量命名失败'
      setMessage(errorMessage)
      setBatchStatus({ kind: 'error', text: errorMessage })
    } finally {
      await materials
      setBatchNaming(false)
    }
  }

  const startDrag = (event: ReactPointerEvent<HTMLElement>, crop: CropBox, mode: DragState['mode']): void => {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    setSelectedCropId(crop.id)
    dragRef.current = {
      cropId: crop.id,
      mode,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startCrop: crop
    }
  }

  const continueDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current
    const canvas = canvasRef.current
    if (!drag || !analysis || !canvas) return
    const bounds = canvas.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) return
    const deltaX = (event.clientX - drag.startClientX) * analysis.sourceWidth / bounds.width
    const deltaY = (event.clientY - drag.startClientY) * analysis.sourceHeight / bounds.height
    updateCrop(drag.cropId, drag.mode === 'move'
      ? { x: Math.round(drag.startCrop.x + deltaX), y: Math.round(drag.startCrop.y + deltaY) }
      : { width: Math.round(drag.startCrop.width + deltaX), height: Math.round(drag.startCrop.height + deltaY) })
  }

  const stopDrag = (): void => { dragRef.current = null }

  if (!analysis) {
    return (
      <div className="crop-empty-state">
        <div className="crop-empty-icon">▧</div>
        <h4>导入一张产品排版总图</h4>
        <p>{sourceImagePath || '尚未选择图片。支持 PNG、JPG、WEBP、TIF 和 TIFF。'}</p>
        {message && <div className="alert info">{message}</div>}
        <div className="crop-empty-actions">
          <button className="secondary-button" onClick={() => void chooseAndAnalyze()}>重新选择图片</button>
          <button className="primary-button" disabled={busy || !sourceImagePath} onClick={() => void analyze()}>{busy ? '正在识别…' : '自动识别并进入裁图'}</button>
        </div>
      </div>
    )
  }

  const renderArrangementCard = (crop: CropBox): React.JSX.Element => {
    const thumbnail = arrangementThumbnails.get(crop.id)!
    const cropIndex = thumbnail.index
    return (
      <div
        className={`arrangement-card ${crop.id === selectedCrop?.id ? 'active' : ''} ${crop.id === draggedPatternId ? 'dragging' : ''} ${patternDropTarget === `crop:${crop.id}` ? 'drop-target' : ''} ${requiredIssuesByCropId.has(crop.id) ? 'missing-required' : ''} ${duplicateNameIssues[crop.id]?.length ? 'duplicate-name' : ''}`}
        draggable
        key={crop.id}
        role="button"
        tabIndex={0}
        onClick={() => setSelectedCropId(crop.id)}
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setSelectedCropId(crop.id) }}
        onDragStart={(event) => beginPatternDrag(event, crop.id)}
        onDragEnd={finishPatternDrag}
        onDragOver={(event) => {
          event.stopPropagation()
          allowPatternDrop(event, `crop:${crop.id}`)
        }}
        onDrop={(event) => dropPatternOnCrop(event, crop.id)}
      >
        <span className="arrangement-card-number">区域 {String(cropIndex).padStart(2, '0')}</span>
        <span className="arrangement-card-thumb" style={thumbnail.style} />
        <span className="arrangement-card-copy">
          <strong>{crop.productCategory}</strong>
          <small>{crop.patternNameEn || '等待图案命名'}</small>
        </span>
        {duplicateNameIssues[crop.id]?.length ? <b className="duplicate-name-badge">名称重复</b> : null}
        {!duplicateNameIssues[crop.id]?.length && requiredIssuesByCropId.has(crop.id) ? <b className="missing-required-badge">缺少必填</b> : null}
        <i>⠿</i>
      </div>
    )
  }

  return (
    <div className={`crop-workspace ${comparisonMode ? 'comparison-crop-workspace' : ''}`}>
      <div className="crop-toolbar">
        <div><strong>{analysis.fileName}</strong><span>{analysis.sourceWidth} × {analysis.sourceHeight} · {analysis.format.toUpperCase()}</span></div>
        <div className="crop-toolbar-actions">
          <button className="secondary-button" onClick={() => void chooseAndAnalyze()}>换一张图</button>
          <button className="secondary-button" disabled={busy} onClick={() => void analyze(analysis.sourceImagePath)}>{busy ? '识别中…' : '重新识别'}</button>
          <button className="secondary-button" onClick={addCrop}>添加区域</button>
          <button
            className={`batch-ai-button ${duplicateNamingCount > 0 ? 'has-duplicates' : ''}`}
            disabled={batchNaming || naming || analysis.crops.length <= 1 || (remainingNamingCount === 0 && duplicateNamingCount === 0)}
            onClick={() => void suggestAllNames()}
          >
            {batchNaming
              ? duplicateNamingCount > 0 ? '正在重新命名全部重复项…' : '正在识别全部图案…'
              : duplicateNamingCount > 0 ? `全部重新命名（${duplicateNamingCount}）`
                : remainingNamingCount > 0 ? `AI 命名 ${remainingNamingCount} 个图案` : '图案已全部命名'}
          </button>
          <button className="primary-button" disabled={exporting || analysis.crops.length === 0} onClick={() => void exportCrops()}>{exporting ? '正在导出…' : `导出 ${analysis.crops.length} 张裁图`}</button>
        </div>
      </div>
      <div className="naming-unit-summary">
        <strong>命名数量 {namingSummary.namingCount}</strong>
        <span>= 独立图案 {namingSummary.independentCount} + 图案组 {namingSummary.groupCount}</span>
        <small>{namingSummary.productCount} 个产品区域仍分别保留产品类型、编码和表格记录</small>
      </div>
      {missingRequiredCrops.length > 0 && (
        <div className="missing-required-alert">
          <div>
            <strong>还有 {missingRequiredCrops.length} 个区域缺少必填项</strong>
            <span>{summarizeMissingRequiredFields(missingRequiredCrops)}；对应区域会持续闪烁黄色。</span>
          </div>
          <button onClick={() => { setSelectedCropId(missingRequiredCrops[0]?.id ?? null); setWorkspaceMode('crop') }}>定位第一项</button>
        </div>
      )}
      {duplicateNamingCount > 0 && (
        <div className="duplicate-batch-alert">
          <div>
            <strong>检测到 {duplicateNamingCount} 个命名单位重复</strong>
            <span>共影响 {duplicateRegionCount} 个产品区域；点击上方“全部重新命名”可一次处理全部冲突，图案组成员会同步更新。</span>
          </div>
          <button disabled={batchNaming || naming} onClick={() => void suggestAllNames()}>全部重新命名</button>
        </div>
      )}
      {message && <div className="alert info crop-message">{message}</div>}
      {materialMessage && <div className="alert info crop-message">{materialMessage}</div>}
      {analysis.warnings.map((warning) => <div className="alert warning crop-message" key={warning}>{warning}</div>)}
      <div className="crop-editor-grid">
        <div className="crop-stage-panel">
          <div className="crop-stage-toolbar">
            <div><strong>图片切片与排组</strong><span>{workspaceMode === 'crop' ? '点击切片可立即编辑；拖动边框调整位置和大小。' : '把一个切片拖到另一个切片上即可建组或换组；拖回“独立图案”区域可取消分组。'}</span></div>
            <div className="crop-mode-switch">
              <button className={workspaceMode === 'crop' ? 'active' : ''} onClick={() => { finishPatternDrag(); setWorkspaceMode('crop') }}>1　调整切片</button>
              <button className={workspaceMode === 'group' ? 'active' : ''} onClick={() => { dragRef.current = null; setWorkspaceMode('group') }}>2　图案排组</button>
            </div>
            <button className="overview-shortcut" onClick={() => setSelectedCropId(analysis.crops.find((crop) => crop.role === 'series-overview')?.id ?? null)}>全系列主图</button>
          </div>
          {workspaceMode === 'crop' ? (
            <div className="crop-stage" ref={canvasRef} style={{ aspectRatio: `${analysis.sourceWidth} / ${analysis.sourceHeight}` }}>
              <img src={analysis.previewDataUrl} alt="产品排版总图" draggable={false} />
              {analysis.crops.map((crop, index) => (
                <div
                  className={`crop-overlay ${crop.id === selectedCrop?.id && crop.role !== 'series-overview' ? 'selected' : ''} ${crop.role === 'series-overview' ? 'overview' : ''} ${requiredIssuesByCropId.has(crop.id) ? 'missing-required' : ''} ${duplicateNameIssues[crop.id]?.length ? 'duplicate-name' : ''}`}
                  key={crop.id}
                  style={boxStyle(crop, analysis)}
                  onClick={() => setSelectedCropId(crop.id)}
                  onPointerDown={(event) => startDrag(event, crop, 'move')}
                  onPointerMove={continueDrag}
                  onPointerUp={stopDrag}
                  onPointerCancel={stopDrag}
                >
                  <span>{crop.role === 'series-overview' ? '全图' : `${index}${crop.patternGroupId ? ` · ${patternGroupShortLabel(patternGroups, crop.patternGroupId)}` : ''}`}</span>
                  {crop.role !== 'series-overview' && <i
                    className="crop-resize-handle"
                    onPointerDown={(event) => startDrag(event, crop, 'resize')}
                    onPointerMove={continueDrag}
                    onPointerUp={stopDrag}
                    onPointerCancel={stopDrag}
                  />}
                </div>
              ))}
            </div>
          ) : (
            <div
              className={`arrangement-workspace ${draggedPatternId ? 'drag-active' : ''}`}
              ref={arrangementScrollRef}
              onDragOver={(event) => {
                event.preventDefault()
                autoScrollArrangement(event.clientY)
              }}
            >
              <section
                className={`arrangement-section independent ${patternDropTarget === 'independent' ? 'drop-target' : ''}`}
                onDragOver={(event) => allowPatternDrop(event, 'independent')}
                onDrop={dropPatternAsIndependent}
              >
                <header><div><strong>独立图案</strong><span>{independentPatterns.length} 张图片，每张单独命名</span></div><small>把组内图片拖到这里可取消分组</small></header>
                <div className="arrangement-card-grid">
                  {independentPatterns.length > 0 ? independentPatterns.map(renderArrangementCard) : <p>目前没有独立图案</p>}
                </div>
              </section>
              <div className="arrangement-group-grid">
                {arrangedPatternGroups.map((group, groupIndex) => (
                  <section
                    className={`arrangement-section group ${patternDropTarget === `group:${group.id}` ? 'drop-target' : ''}`}
                    key={group.id}
                    style={{ '--pattern-group-color': patternGroupPalette(groupIndex) } as React.CSSProperties}
                    onDragOver={(event) => allowPatternDrop(event, `group:${group.id}`)}
                    onDrop={(event) => dropPatternOnGroup(event, group.id)}
                  >
                    <header><div><strong>{group.label}</strong><span>{group.members.length} 张图片，共用一个图案名称</span></div><small>可拖入其他图片</small></header>
                    <div className="arrangement-card-grid">{group.members.map(renderArrangementCard)}</div>
                  </section>
                ))}
                {arrangedPatternGroups.length === 0 && <div className="arrangement-empty-groups"><strong>还没有图案组</strong><span>把一张独立图案拖到另一张上，就会自动生成第一个图案组。</span></div>}
              </div>
            </div>
          )}
          <div className="crop-stage-help">{workspaceMode === 'crop' ? '点击任意切片框会立即显示右侧设置；拖动框体移动，拖动右下角圆点缩放。' : '排组后图片会自动移动到对应组；拖回“独立图案”区域即可取消分组。'}</div>
          {batchStatus && <div className={`ai-batch-status ${batchStatus.kind}`}><strong>{batchStatus.kind === 'running' ? 'AI 正在处理' : batchStatus.kind === 'success' ? 'AI 识别完成' : batchStatus.kind === 'warning' ? 'AI 部分完成' : 'AI 识别失败'}</strong><span>{batchStatus.text}</span></div>}
        </div>
        <div className="crop-side-panel">
          {selectedCrop && (
            <div className="crop-properties" ref={propertiesRef}>
              <div className="crop-properties-heading">
                <strong>当前区域设置</strong>
                <div>
                  <button className="refine-button" disabled={refining || selectedCrop.role === 'series-overview'} onClick={() => void refineSelected()}>{refining ? '细分中…' : '细分识别'}</button>
                  <button className="delete-crop-button" disabled={selectedCrop.role === 'series-overview'} onClick={deleteSelected}>删除此区域</button>
                </div>
              </div>
              {selectedCrop.role !== 'series-overview' && (
                <div className="image-name-section">
                  <div className="pattern-group-control">
                    <div className="pattern-group-heading">
                      <div><strong>当前命名关系</strong><span>需要调整时，请直接在左侧“图案排组”中拖动图片。</span></div>
                      <mark>{selectedCrop.patternGroupId ? patternGroupLabel(patternGroups, selectedCrop.patternGroupId) : '独立图案'}</mark>
                    </div>
                    {selectedCrop.patternGroupId && <small>{patternGroupMemberSummary(patternGroups, selectedCrop.patternGroupId)}；产品类型和产品编码仍各自独立。</small>}
                  </div>
                  <div className="image-name-heading"><div><strong>图片对应名称</strong><span>批量先填首选；不满意时可单图获取 3 个备选</span></div><button className="secondary-button" disabled={naming || batchNaming} onClick={() => void suggestNames()}>{naming ? '识别命名中…' : '单图重新建议'}</button></div>
                  {selectedCrop.nameCandidates.length > 0 && <div className="name-candidate-list">{selectedCrop.nameCandidates.map((candidate) => <button key={`${candidate.englishName}-${candidate.chineseName}`} onClick={() => updatePatternName(selectedCrop.id, candidate.englishName, candidate.chineseName)}><strong>{candidate.englishName}</strong><span>{candidate.chineseName} · {Math.round(candidate.confidence * 100)}%</span><small>{candidate.reason}</small></button>)}</div>}
                  <div className="field-row naming-field-row">
                    <div className={`historical-name-field ${!selectedCrop.patternNameEn.trim() ? 'missing-required-field' : ''}`}><label><span>图案对应命名（必填，写入表格）</span><input value={selectedCrop.patternNameEn} onChange={(event) => updatePatternName(selectedCrop.id, event.target.value, selectedCrop.patternNameZh)} placeholder="输入名称，或从历史图案中选择" /><small>只允许英文字母和单词间空格，其他符号会自动移除。</small></label>
                    </div>
                    <label><span>中文对应（仅供确认）</span><input value={selectedCrop.patternNameZh} onChange={(event) => updatePatternName(selectedCrop.id, selectedCrop.patternNameEn, event.target.value)} placeholder="例如 汤姆奶酪追逐" /><small>只用于人工核对，不写入业务表格。</small></label>
                  </div>
                  {historicalPatterns.length > 0 && <HistoricalNamePicker key={selectedCrop.id} options={historicalPatterns} value={selectedCrop.patternNameEn} onSelect={name => updatePatternName(selectedCrop.id, name, selectedCrop.patternNameZh)} />}
                  {selectedDuplicateIssues.length > 0 && <div className="duplicate-name-warning"><strong>名称重复，暂不能进入编码预览</strong>{selectedDuplicateIssues.map((issue) => <span key={issue}>· {issue}</span>)}</div>}
                  {selectedRequiredIssues.length > 0 && <div className="selected-required-warning"><strong>当前区域还不能完成业务流程</strong><span>请补齐：{selectedRequiredIssues.join('、')}</span></div>}
                </div>
              )}
              {selectedCrop.role !== 'series-overview' && (
                <div className={`classification-box ${(selectedCrop.categoryConfidence ?? 0) < 0.65 ? 'low-confidence' : ''}`}>
                  <span>产品类型初判</span>
                  <strong>{selectedCrop.productCategory} · {Math.round((selectedCrop.categoryConfidence ?? 0) * 100)}%</strong>
                  {selectedCrop.categoryReasons.map((reason) => <p key={reason}>· {reason}</p>)}
                </div>
              )}
              <label><span>区域名称</span><input value={selectedCrop.label} onChange={(event) => updateCrop(selectedCrop.id, { label: event.target.value })} /></label>
              <div className="field-row">
                <label><span>用途</span><select disabled={selectedCrop.role === 'series-overview'} value={selectedCrop.role} onChange={(event) => updateCrop(selectedCrop.id, { role: event.target.value as CropBox['role'] })}><option value="series-overview">全系列主图</option><option value="product-pattern">产品/图案图</option><option value="unknown">待确认</option></select></label>
                {selectedCrop.role !== 'series-overview' && <label className={selectedCrop.productCategory === '待确认' ? 'missing-required-field' : ''}><span>产品类别（可输入或选择）</span><input list="casebang-product-categories" value={selectedCrop.productCategory === '流沙镜头膜' ? '镜头膜' : selectedCrop.productCategory} onChange={(event) => updateProductCategory(selectedCrop.id, event.target.value as ProductCategory)} /><datalist id="casebang-product-categories">{[...new Set(availableProductTypes.map(category => category === '流沙镜头膜' ? '镜头膜' : category))].map(category => <option key={category} value={category} />)}</datalist></label>}
              </div>
              {selectedCrop.role !== 'series-overview' && (
                <div className="crop-business-fields">
                  <div className="crop-business-fields-heading">
                    <div><strong>条码表字段</strong><span>价格和颜色建议来自物料总表，仍可手工修改。</span></div>
                    <div className="barcode-item-class"><span>条码品类</span><b>{selectedBusiness?.itemClass ?? '待确认'}</b></div>
                  </div>
                  {isPairedWireless(selectedCrop.productCategory) && <div className="wireless-variant-settings">
                    <strong>同图双产品：CP002 / MP16</strong>
                    <p>共用图片、图案名称和 PB 编码，分别生成两条产品记录。</p>
                    {(['cp002', 'mp16'] as const).map((variant) => {
                      const prices = wirelessPrices(selectedCrop)
                      return <div key={variant}>
                        <strong>{variant === 'cp002' ? 'CP002 磁吸充电宝' : 'MP16 磁吸充电宝（10000mAh）'}</strong>
                        <div className="field-row">
                          <label><span>建议零售价</span><input type="number" min="0.01" step="0.01" value={prices[variant].retail || ''} onChange={(event) => updateCrop(selectedCrop.id, { wirelessVariantPrices: { ...prices, [variant]: { ...prices[variant], retail: Number(event.target.value) } } })} /></label>
                          <label><span>海外零售价</span><input type="number" min="0.01" step="0.01" value={prices[variant].overseas || ''} onChange={(event) => updateCrop(selectedCrop.id, { wirelessVariantPrices: { ...prices, [variant]: { ...prices[variant], overseas: Number(event.target.value) } } })} /></label>
                        </div>
                      </div>
                    })}
                  </div>}
                  {comparisonMode && !isPairedWireless(selectedCrop.productCategory) && <div className="comparison-price-note">普通款、银框款及不同品牌/机型的价格统一在下一步“编码与机型”中设置。</div>}
                  {!comparisonMode && !isPairedWireless(selectedCrop.productCategory) && <><label className="price-preset-field">
                    <span>常用价格组合</span>
                    <select
                      value={selectedPricePreset ? pricePresetKey(selectedPricePreset.suggestedRetailPrice, selectedPricePreset.overseasRetailPrice) : ''}
                      onChange={(event) => {
                        const preset = BARCODE_PRICE_PRESETS.find((item) => pricePresetKey(item.suggestedRetailPrice, item.overseasRetailPrice) === event.target.value)
                        if (preset) updateCrop(selectedCrop.id, { suggestedRetailPrice: preset.suggestedRetailPrice, overseasRetailPrice: preset.overseasRetailPrice })
                      }}
                    >
                      <option value="">自定义价格</option>
                      {BARCODE_PRICE_PRESETS.map((preset) => <option key={pricePresetKey(preset.suggestedRetailPrice, preset.overseasRetailPrice)} value={pricePresetKey(preset.suggestedRetailPrice, preset.overseasRetailPrice)}>{preset.label}</option>)}
                    </select>
                  </label>
                  <div className="field-row three-columns">
                    <label className={selectedCrop.suggestedRetailPrice === null ? 'missing-required-field' : ''}><span>建议零售价（必填）</span><input type="number" min="0.01" step="0.01" value={selectedCrop.suggestedRetailPrice ?? ''} onChange={(event) => updateCrop(selectedCrop.id, { suggestedRetailPrice: nullablePositiveNumber(event.target.value) })} placeholder="例如 89.00" /></label>
                    <label className={selectedCrop.overseasRetailPrice === null ? 'missing-required-field' : ''}><span>海外零售价（必填）</span><input type="number" min="0.01" step="0.01" value={selectedCrop.overseasRetailPrice ?? ''} onChange={(event) => updateCrop(selectedCrop.id, { overseasRetailPrice: nullablePositiveNumber(event.target.value) })} placeholder="例如 19.99" /></label>
                  </div>
                  </>}
                  <label><span>颜色（材质）</span><input list="casebang-material-colors" value={selectedCrop.material} onChange={(event) => updateCrop(selectedCrop.id, { material: event.target.value, materialSource: 'manual' })} placeholder="选择或输入颜色" /></label>
                  <datalist id="casebang-material-colors">{MATERIAL_COLOR_OPTIONS.map((material) => <option key={material} value={material} />)}</datalist>
                </div>
              )}
              <div className="crop-coordinate-grid">
                {(['x', 'y', 'width', 'height'] as const).map((key) => <label key={key}><span>{coordinateLabel(key)}</span><input type="number" min={key === 'width' || key === 'height' ? 1 : 0} value={selectedCrop[key]} onChange={(event) => updateCrop(selectedCrop.id, { [key]: Number(event.target.value) })} /></label>)}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function requiredCropFieldIssues(crop: CropBox): string[] {
  if (crop.role === 'series-overview') return []
  const issues: string[] = []
  if (crop.productCategory === '待确认' || !crop.productCategory.trim()) issues.push('产品类别')
  if (!crop.patternNameEn.trim()) issues.push('英文图片名称')
  if (isPairedWireless(crop.productCategory)) {
    const prices = wirelessPrices(crop)
    for (const variant of ['cp002', 'mp16'] as const) {
      if (!Number.isFinite(prices[variant].retail) || prices[variant].retail <= 0) issues.push(`${variant.toUpperCase()} 建议零售价`)
      if (!Number.isFinite(prices[variant].overseas) || prices[variant].overseas <= 0) issues.push(`${variant.toUpperCase()} 海外零售价`)
    }
  } else {
    if (crop.suggestedRetailPrice === null || crop.suggestedRetailPrice <= 0) issues.push('建议零售价')
    if (crop.overseasRetailPrice === null || crop.overseasRetailPrice <= 0) issues.push('海外零售价')
  }
  return issues
}

function summarizeMissingRequiredFields(crops: CropBox[]): string {
  const counts = new Map<string, number>()
  for (const crop of crops) {
    for (const issue of requiredCropFieldIssues(crop)) counts.set(issue, (counts.get(issue) ?? 0) + 1)
  }
  return [...counts.entries()].map(([field, count]) => `${field} ${count} 项`).join('、')
}

function normalizeCrop(crop: CropBox, sourceWidth: number, sourceHeight: number): CropBox {
  const width = clamp(Math.round(crop.width), 20, sourceWidth)
  const height = clamp(Math.round(crop.height), 20, sourceHeight)
  const x = clamp(Math.round(crop.x), 0, sourceWidth - width)
  const y = clamp(Math.round(crop.y), 0, sourceHeight - height)
  const business = productBusinessSpecification(crop.productCategory)
  return {
    ...crop,
    x, y, width, height,
    suggestedRetailPrice: crop.suggestedRetailPrice ?? business.suggestedRetailPrice,
    overseasRetailPrice: crop.overseasRetailPrice ?? business.overseasRetailPrice,
    material: crop.material ?? ''
  }
}

function nullablePositiveNumber(value: string): number | null {
  if (!value.trim()) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function pricePresetKey(suggestedRetailPrice: number, overseasRetailPrice: number): string {
  return `${suggestedRetailPrice.toFixed(2)}|${overseasRetailPrice.toFixed(2)}`
}

interface PatternGroupOption {
  id: string
  label: string
  memberLabels: string[]
}

interface NamingUnitSummary {
  productCount: number
  independentCount: number
  groupCount: number
  namingCount: number
}

function assignAutomaticStandGroups(crops: CropBox[]): CropBox[] {
  const cleared = crops.map((crop) => crop.patternGroupId?.startsWith('auto-stand-')
    ? { ...crop, patternGroupId: null }
    : crop)
  const backCovers = cleared.filter((crop) => !crop.patternGroupId && crop.productCategory === '磁吸支架背盖').slice().sort(readingOrderCrop)
  const airbagStands = cleared.filter((crop) => !crop.patternGroupId && crop.productCategory === '磁吸气囊支架').slice().sort(readingOrderCrop)
  const pairCount = Math.min(backCovers.length, airbagStands.length)
  const groupByCropId = new Map<string, string>()
  for (let index = 0; index < pairCount; index += 1) {
    const groupId = `auto-stand-${String(index + 1).padStart(2, '0')}`
    const backCover = backCovers[index]
    const airbagStand = airbagStands[index]
    if (backCover) groupByCropId.set(backCover.id, groupId)
    if (airbagStand) groupByCropId.set(airbagStand.id, groupId)
  }
  const assigned = cleared.map((crop) => groupByCropId.has(crop.id)
    ? { ...crop, patternGroupId: groupByCropId.get(crop.id) ?? null }
    : crop)
  const nameByGroup = new Map<string, { english: string; chinese: string }>()
  for (const crop of assigned) {
    if (crop.patternGroupId && crop.patternNameEn.trim() && !nameByGroup.has(crop.patternGroupId)) {
      nameByGroup.set(crop.patternGroupId, { english: crop.patternNameEn, chinese: crop.patternNameZh })
    }
  }
  return cleanupSingletonPatternGroups(assigned.map((crop) => {
    const sharedName = crop.patternGroupId ? nameByGroup.get(crop.patternGroupId) : undefined
    return sharedName ? { ...crop, patternNameEn: sharedName.english, patternNameZh: sharedName.chinese } : crop
  }))
}

function buildNamingTargets(crops: CropBox[]): CropBox[] {
  const seen = new Set<string>()
  return crops.filter((crop) => {
    const key = crop.patternGroupId ?? crop.id
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function uniqueCropsById(crops: CropBox[]): CropBox[] {
  const seen = new Set<string>()
  return crops.filter((crop) => {
    if (seen.has(crop.id)) return false
    seen.add(crop.id)
    return true
  })
}

function buildPatternGroupOptions(crops: CropBox[]): PatternGroupOption[] {
  const groups = new Map<string, string[]>()
  crops.forEach((crop, index) => {
    if (!crop.patternGroupId || crop.role === 'series-overview') return
    const labels = groups.get(crop.patternGroupId) ?? []
    labels.push(String(index).padStart(2, '0'))
    groups.set(crop.patternGroupId, labels)
  })
  return [...groups.entries()].map(([id, memberLabels], index) => ({
    id,
    label: `图案组 ${String(index + 1).padStart(2, '0')}`,
    memberLabels
  }))
}

function patternGroupLabel(groups: PatternGroupOption[], groupId: string): string {
  return groups.find((group) => group.id === groupId)?.label ?? '同图案组'
}

function patternGroupShortLabel(groups: PatternGroupOption[], groupId: string): string {
  const label = patternGroupLabel(groups, groupId)
  return label.replace('图案组 ', '组')
}

const PATTERN_GROUP_COLORS = ['#e47e32', '#8b67c8', '#2d9b7a', '#d0587d', '#477fc5', '#a8752d', '#647b3d', '#a554b0']

function patternGroupPalette(index: number): string {
  return PATTERN_GROUP_COLORS[index % PATTERN_GROUP_COLORS.length] ?? '#2f8fc7'
}

function patternGroupMemberSummary(groups: PatternGroupOption[], groupId: string): string {
  const group = groups.find((item) => item.id === groupId)
  return group ? `包含区域 ${group.memberLabels.join('、')}` : '与组内区域共用名称'
}

function summarizeNamingUnits(crops: CropBox[]): NamingUnitSummary {
  const products = crops.filter((crop) => crop.role !== 'series-overview')
  const groupCounts = new Map<string, number>()
  for (const crop of products) {
    if (crop.patternGroupId) groupCounts.set(crop.patternGroupId, (groupCounts.get(crop.patternGroupId) ?? 0) + 1)
  }
  const groupCount = [...groupCounts.values()].filter((count) => count >= 2).length
  const independentCount = products.filter((crop) => !crop.patternGroupId || (groupCounts.get(crop.patternGroupId) ?? 0) < 2).length
  return {
    productCount: products.length,
    independentCount,
    groupCount,
    namingCount: independentCount + groupCount
  }
}

function cleanupSingletonPatternGroups(crops: CropBox[]): CropBox[] {
  const counts = new Map<string, number>()
  for (const crop of crops) {
    if (crop.patternGroupId) counts.set(crop.patternGroupId, (counts.get(crop.patternGroupId) ?? 0) + 1)
  }
  return crops.map((crop) => crop.patternGroupId && (counts.get(crop.patternGroupId) ?? 0) < 2
    ? { ...crop, patternGroupId: null }
    : crop)
}

function readingOrderCrop(left: CropBox, right: CropBox): number {
  const tolerance = Math.max(20, Math.min(left.height, right.height) * 0.35)
  return Math.abs(left.y - right.y) <= tolerance ? left.x - right.x : left.y - right.y
}

function boxStyle(crop: CropBox, analysis: ImageAnalysisResult): React.CSSProperties {
  return {
    left: `${crop.x / analysis.sourceWidth * 100}%`,
    top: `${crop.y / analysis.sourceHeight * 100}%`,
    width: `${crop.width / analysis.sourceWidth * 100}%`,
    height: `${crop.height / analysis.sourceHeight * 100}%`
  }
}

function thumbnailStyle(crop: CropBox, analysis: ImageAnalysisResult): React.CSSProperties {
  const x = analysis.sourceWidth === crop.width ? 50 : crop.x / (analysis.sourceWidth - crop.width) * 100
  const y = analysis.sourceHeight === crop.height ? 50 : crop.y / (analysis.sourceHeight - crop.height) * 100
  return {
    backgroundImage: `url(${analysis.previewDataUrl})`,
    backgroundSize: `${analysis.sourceWidth / crop.width * 100}% ${analysis.sourceHeight / crop.height * 100}%`,
    backgroundPosition: `${x}% ${y}%`
  }
}

function coordinateLabel(key: 'x' | 'y' | 'width' | 'height'): string {
  return ({ x: '左边距', y: '上边距', width: '宽度', height: '高度' })[key]
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum
  return Math.min(maximum, Math.max(minimum, value))
}
