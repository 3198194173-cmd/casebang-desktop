import { ExistingSeriesPicker } from './ExistingSeriesPicker'
import { useExistingSeriesLayout } from './use-existing-series-layout'
import { appendExistingSeries, type ExistingSeriesSelection, type ExistingSeriesTarget, type HistoricalPatternOption } from './existing-series'
import { useDraftState } from '../../app/use-draft-state'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppSnapshot, TaskDraftInput } from '@shared/contracts'
import type { ImageAnalysisResult } from '@shared/image-contracts'
import type { EncodingPreviewResult } from '@shared/coding-contracts'
import { desktopApi } from '../../app/desktop-api'
import { ImageCropWorkspace } from './ImageCropWorkspace'
import { EncodingPreviewWorkspace, getEncodingPreviewIssues } from './EncodingPreviewWorkspace'
import { buildGenerationWorkspace } from './generation-workspace-builder'
import { GenerationQualityWorkspace } from './GenerationQualityWorkspace'
import { ExportWorkspace } from './ExportWorkspace'
import { REFERENCE_PHONE_MODELS } from '@shared/product-business-rules'

const TEMPLATE_OPTIONS = [
  '可拆卸+其他', '出镜壳', '出彩壳', '出片壳', '奇趣壳', '卡包', 'Macbook',
  'Macbook Pad（带系列编码）', '镜头膜', '流沙磁吸支架背盖', '无编码系列0418'
]

const WIZARD_STEPS = [
  { title: '模板与系列', short: '选择模板、填写系列资料', icon: '01' },
  { title: '导入、裁图与命名', short: '识别、排组、归类与 AI 命名', icon: '02' },
  { title: '编码与机型', short: '确认系列码、产品码与条码机型', icon: '03' },
  { title: '生成与质检', short: '受控写入并检查工作簿', icon: '04' },
  { title: '导出与覆盖', short: '另存新建产品表，原位更新业务基础表', icon: '05' }
] as const

const STEP_DETAILS = [
  ['识别“命名-公式”的全部模板', '读取系列名称与主图', '建立不修改基础表的任务副本'],
  ['自动寻找并确认产品图片边界', '按图案关系排组并确认产品类别', 'AI 命名并检查国内命名表中的重复项'],
  ['读取“已使用编码”中的最大编号', '按产品类别和图案顺序连续分配', '勾选本次条码表使用的机型'],
  ['先生成图片表，再由条码名组合机型生成条码表', '公式、样式、行列尺寸和图片关系复核', '异常时停止输出并给出检查报告'],
  ['新建产品表可另存到指定文件夹', 'A 条码参考和国内命名表原位备份并覆盖', '每次覆盖形成一组时间线，组内可按表回滚']
] as const

export function NewTaskPage({ snapshot, onDataChanged, existingSeries = false }: { snapshot: AppSnapshot; existingSeries?: boolean; onDataChanged(): Promise<void> }): React.JSX.Element {
  const draftPrefix = existingSeries ? 'existing-products' : 'encoding'
  const steps = existingSeries ? WIZARD_STEPS.map((step, index) => index === 0 ? { ...step, title: '导入新增产品', short: '选择产品模板与新增产品总图' } : index === 1 ? { ...step, title: '选择系列与图案比对', short: '沿用系列、复用历史名称或 AI 命名' } : step) : WIZARD_STEPS
  const [selection, setSelection] = useDraftState<ExistingSeriesSelection | null>(`${draftPrefix}.selection`, null)
  const [target, setTarget] = useDraftState<ExistingSeriesTarget | null>(`${draftPrefix}.target`, null)
  const [historicalPatterns, setHistoricalPatterns] = useState<HistoricalPatternOption[]>([])
  const [historyConfirmed, setHistoryConfirmed] = useDraftState(`${draftPrefix}.historyConfirmed`, false)
  const [activeStep, setActiveStep] = useDraftState(`${draftPrefix}.activeStep`, 0)
  const [form, setForm] = useDraftState<TaskDraftInput>(`${draftPrefix}.form`, {
    templateName: TEMPLATE_OPTIONS[0] ?? '', seriesNameZh: '', seriesNameEn: '', ipRemark: '', selectedModels: [...REFERENCE_PHONE_MODELS], modelBrandAssignments: {}, modelSettings: [], framePriceRules: {}, masterImagePath: ''
  })
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [imageAnalysis, setImageAnalysis] = useDraftState<ImageAnalysisResult | null>(`${draftPrefix}.imageAnalysis`, null)
  const [encodingPreview, setEncodingPreview] = useDraftState<EncodingPreviewResult | null>(`${draftPrefix}.encodingPreview`, null)
  const [englishNameManuallyEdited, setEnglishNameManuallyEdited] = useDraftState(`${draftPrefix}.englishNameManuallyEdited`, false)
  const [translationBusy, setTranslationBusy] = useState(false)
  const [translationHint, setTranslationHint] = useState('填写中文系列名后，将使用接口中心当前模型进行真正的中译英。')
  const [modelsConfirmed, setModelsConfirmed] = useDraftState(`${draftPrefix}.modelsConfirmed`, false)
  useEffect(() => {
    if (imageAnalysis?.crops.some(crop => crop.productCategory === '流沙镜头膜')) {
      setImageAnalysis({ ...imageAnalysis, crops: imageAnalysis.crops.map(crop => crop.productCategory === '流沙镜头膜' ? { ...crop, productCategory: '镜头膜' } : crop) })
      setEncodingPreview(null)
      setModelsConfirmed(false)
    }
  }, [imageAnalysis])
  const translationRequestRef = useRef(0)
  const baseFilesReady = useMemo(
    () => Object.values(snapshot.baseFiles).filter((file) => file.kind !== 'productImageMapping').every((file) => file.status === 'ready'), [snapshot]
  )
  const duplicateNameIssues = useMemo(
    () => buildDuplicateNameIssues(imageAnalysis, (snapshot.domesticPatternNames ?? []).filter(record => !existingSeries || !target?.names.includes(record.englishName))),
    [imageAnalysis, snapshot.domesticPatternNames, target, existingSeries]
  )
  const productCrops = useMemo(
    () => imageAnalysis?.crops.filter((crop) => crop.role !== 'series-overview') ?? [],
    [imageAnalysis]
  )
  const basicsComplete = baseFilesReady
    && Boolean(form.templateName.trim() && (existingSeries || form.seriesNameEn.trim()) && form.masterImagePath)
  const cropStepComplete = Boolean(imageAnalysis)
    && imageAnalysis?.crops.filter((crop) => crop.role === 'series-overview').length === 1
    && productCrops.length > 0
  const namingStepComplete = (!existingSeries || Boolean(selection && target && historyConfirmed)) && cropStepComplete
    && Object.keys(duplicateNameIssues).length === 0
    && productCrops.every((crop) => crop.productCategory !== '待确认' && crop.patternNameEn.trim())
  const encodingDataComplete = getEncodingPreviewIssues(encodingPreview).length === 0
  const encodingStepComplete = encodingDataComplete && modelsConfirmed
  const currentLayout = useExistingSeriesLayout(existingSeries, activeStep, selection, target)
  const generationWorkspace = useMemo(
    () => imageAnalysis && encodingPreview && encodingStepComplete && (!existingSeries || Boolean(currentLayout.selection && currentLayout.target))
      ? (() => { const workspace = buildGenerationWorkspace(form, imageAnalysis, encodingPreview, snapshot.domesticPatternNames)
          return existingSeries && currentLayout.selection && currentLayout.target ? appendExistingSeries(workspace, currentLayout.target, currentLayout.selection, new Map(imageAnalysis.crops.map(c => [c.id, c.productCategory])), imageAnalysis) : workspace })()
      : null,
    [form, imageAnalysis, encodingPreview, encodingStepComplete, snapshot.domesticPatternNames, existingSeries, currentLayout.selection, currentLayout.target]
  )
  const generationStepComplete = Boolean(generationWorkspace?.checks.every((check) => check.passed))
  const maxUnlockedStep = !basicsComplete ? 0 : !namingStepComplete ? 1 : !encodingStepComplete ? 2 : !generationStepComplete ? 3 : 4
  useEffect(() => {
    const chineseName = form.seriesNameZh.trim()
    if (!chineseName || englishNameManuallyEdited || form.seriesNameEn.trim()) return
    const requestId = ++translationRequestRef.current
    setTranslationHint('正在等待输入完成…')
    const timer = window.setTimeout(() => {
      setTranslationBusy(true)
      setTranslationHint('正在翻译中文系列名…')
      void desktopApi.ai.translateSeriesName({ chineseName }).then((result) => {
        if (requestId !== translationRequestRef.current) return
        setForm((current) => current.seriesNameZh.trim() === chineseName
          ? { ...current, seriesNameEn: result.englishName }
          : current)
        setTranslationHint(`已由 ${result.model} 完成中译英；仍可手工修改。`)
      }).catch((reason) => {
        if (requestId !== translationRequestRef.current) return
        setTranslationHint(reason instanceof Error ? reason.message : '系列名翻译失败，请重试或手工填写。')
      }).finally(() => {
        if (requestId === translationRequestRef.current) setTranslationBusy(false)
      })
    }, 700)
    return () => {
      window.clearTimeout(timer)
      if (translationRequestRef.current === requestId) translationRequestRef.current += 1
    }
  }, [form.seriesNameZh, englishNameManuallyEdited])

  const chooseImage = async (): Promise<string | null> => {
    const result = await desktopApi.tasks.selectMasterImage()
    if (result.path) {
      setForm((current) => ({ ...current, masterImagePath: result.path! }))
      setImageAnalysis(null)
      setEncodingPreview(null)
      setModelsConfirmed(false)
    }
    return result.path
  }

  const createDraft = async (): Promise<void> => {
    if (!basicsComplete) {
      setMessage(buildBasicsIncompleteMessage(baseFilesReady, form))
      return
    }
    try {
      setBusy(true)
      const task = existingSeries ? { id: 'existing-series' } : await desktopApi.tasks.createDraft(form)
      setMessage(`任务草稿 ${task.id.slice(0, 8)} 已建立，可继续体验后续向导页面。`)
      setActiveStep(1)
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '任务创建失败')
    } finally {
      setBusy(false)
    }
  }

  const updateChineseSeriesName = (seriesNameZh: string): void => {
    setEncodingPreview(null)
    setEnglishNameManuallyEdited(false)
    setForm((current) => ({ ...current, seriesNameZh, seriesNameEn: '' }))
  }

  const applyAutomaticTranslation = async (): Promise<void> => {
    setEncodingPreview(null)
    const chineseName = form.seriesNameZh.trim()
    if (!chineseName) {
      setTranslationHint('请先填写中文系列名。')
      return
    }
    const requestId = ++translationRequestRef.current
    setEnglishNameManuallyEdited(false)
    setTranslationBusy(true)
    setTranslationHint('正在重新翻译中文系列名…')
    try {
      const result = await desktopApi.ai.translateSeriesName({ chineseName })
      if (requestId !== translationRequestRef.current) return
      setForm((current) => ({ ...current, seriesNameEn: result.englishName }))
      setTranslationHint(`已由 ${result.model} 完成中译英；仍可手工修改。`)
      setMessage('英文系列名已重新翻译完成。')
    } catch (reason) {
      if (requestId !== translationRequestRef.current) return
      const error = reason instanceof Error ? reason.message : '系列名翻译失败，请重试或手工填写。'
      setTranslationHint(error)
      setMessage(error)
    } finally {
      if (requestId === translationRequestRef.current) setTranslationBusy(false)
    }
  }

  const navigateToStep = (index: number): void => {
    if (index > maxUnlockedStep) {
      setMessage(buildStepLockedMessage(index, basicsComplete, cropStepComplete, namingStepComplete, encodingStepComplete, generationStepComplete))
      return
    }
    setActiveStep(index)
  }

  const currentStep = steps[activeStep] ?? WIZARD_STEPS[0]
  return (
    <div className="wizard-shell">
      <nav className="wizard-steps" aria-label="任务步骤">
        {steps.map((step, index) => (
          <button
            className={`wizard-step ${index === activeStep ? 'active' : ''} ${index < activeStep ? 'visited' : ''}`}
            key={step.title}
            disabled={index > maxUnlockedStep}
            title={index > maxUnlockedStep ? buildStepLockedMessage(index, basicsComplete, cropStepComplete, namingStepComplete, encodingStepComplete, generationStepComplete) : undefined}
            onClick={() => navigateToStep(index)}
          >
            <span>{step.icon}</span>
            <div><strong>{step.title}</strong><small>{step.short}</small></div>
          </button>
        ))}
      </nav>

      <section className="panel wizard-workspace">
        <div className="panel-heading wizard-heading">
          <div>
            <span className="eyebrow">STEP {String(activeStep + 1).padStart(2, '0')} / 05</span>
            <h3>{currentStep.title}</h3>
            <p>{currentStep.short}</p>
          </div>
          <span className={`status-label ${activeStep <= 1 ? 'ready' : ''}`}>
            {activeStep === 0 ? '基础资料可操作' : activeStep === 1 ? '裁图与命名可操作' : activeStep === 2 ? '编码预览可操作' : activeStep === 3 ? '真实表格预览与质检' : '导出可操作'}
          </span>
        </div>
        {!baseFilesReady && activeStep === 0 && (
          <div className="alert warning">三个基础表尚未全部就绪。请先到“基础表管理”完成导入，当前任务不能进入下一步。</div>
        )}
        {message && <div className="alert info">{message}</div>}
        {existingSeries && activeStep >= 3 && !generationWorkspace && <div className={`alert ${currentLayout.error ? 'error' : 'info'}`}>{currentLayout.error || '正在读取原表并重新计算当前系列的追加位置…'}</div>}
        {existingSeries && activeStep === 1 && <ExistingSeriesPicker selection={selection} target={target} confirmed={historyConfirmed} onSelect={value => { setSelection(value); setHistoryConfirmed(false); setForm(current => ({ ...current, seriesNameEn: value.englishName, seriesNameZh: value.chineseName })); setEncodingPreview(null); setModelsConfirmed(false) }} onTarget={value => { setTarget(value); setHistoryConfirmed(false) }} onConfirmedChange={setHistoryConfirmed} analysis={imageAnalysis} onAnalysis={value => { setImageAnalysis(value); setEncodingPreview(null); setModelsConfirmed(false) }} onHistoricalPatterns={setHistoricalPatterns} />}
        {activeStep === 0 ? (
          <TaskBasics
            existingSeries={existingSeries}
            form={form}
            setForm={(value) => { setEncodingPreview(null); setForm(value) }}
            chooseImage={chooseImage}
            updateChineseSeriesName={updateChineseSeriesName}
            updateEnglishSeriesName={(seriesNameEn) => {
              translationRequestRef.current += 1
              setEnglishNameManuallyEdited(true)
              setEncodingPreview(null)
              setForm((current) => ({ ...current, seriesNameEn }))
            }}
            applyAutomaticTranslation={applyAutomaticTranslation}
            translationBusy={translationBusy}
            translationHint={englishNameManuallyEdited ? '当前英文名已手工修改。' : translationHint}
          />
        ) : activeStep === 1 ? (
          <ImageCropWorkspace comparisonMode={existingSeries} sourceImagePath={form.masterImagePath} seriesNameZh={form.seriesNameZh} seriesNameEn={form.seriesNameEn} productTypes={snapshot.productTypes} domesticEnglishNames={snapshot.domesticPatternNames.map((record) => record.englishName)} historicalPatterns={existingSeries ? historicalPatterns : []} duplicateNameIssues={duplicateNameIssues} analysis={imageAnalysis} setAnalysis={(next) => { setEncodingPreview(null); setModelsConfirmed(false); setImageAnalysis(next) }} chooseImage={chooseImage} />
        ) : activeStep === 2 && imageAnalysis ? (
          <EncodingPreviewWorkspace
            existingSeriesCode={existingSeries ? selection?.code : undefined}
            seriesNameZh={form.seriesNameZh}
            seriesNameEn={form.seriesNameEn}
            analysis={imageAnalysis}
            preview={encodingPreview}
            setPreview={setEncodingPreview}
            selectedModels={form.selectedModels}
            setSelectedModels={(selectedModels) => setForm((current) => ({ ...current, selectedModels }))}
            modelBrandAssignments={form.modelBrandAssignments}
            setModelBrandAssignments={(modelBrandAssignments) => setForm((current) => ({ ...current, modelBrandAssignments }))}
            modelSettings={form.modelSettings ?? []}
            setModelSettings={(modelSettings) => setForm((current) => ({ ...current, modelSettings }))}
            framePriceRules={form.framePriceRules ?? {}}
            setFramePriceRules={(framePriceRules) => setForm((current) => ({ ...current, framePriceRules }))}
            modelsConfirmed={modelsConfirmed}
            setModelsConfirmed={setModelsConfirmed}
          />
        ) : activeStep === 3 && imageAnalysis && generationWorkspace ? (
          <GenerationQualityWorkspace workspace={generationWorkspace} analysis={imageAnalysis} />
        ) : activeStep === 4 && generationWorkspace && imageAnalysis ? (
          <ExportWorkspace workspace={generationWorkspace} templateName={form.templateName} baseFiles={snapshot.baseFiles} analysis={imageAnalysis} sourceWorkflow={existingSeries ? 'new-products' : 'new-series'} onDataChanged={onDataChanged} />
        ) : (
          <StepPlaceholder step={activeStep} />
        )}
        {activeStep === 1 && Object.keys(duplicateNameIssues).length > 0 && <div className="alert warning">发现 {Object.keys(duplicateNameIssues).length} 张图片存在重复英文名称，已在切片上标红。请修改后再进入“编码预览”。</div>}
        <div className="wizard-actions">
          <button className="secondary-button" disabled={activeStep === 0} onClick={() => setActiveStep((current) => Math.max(0, current - 1))}>上一步</button>
          {activeStep === 0 ? (
            <button className="primary-button" disabled={busy || !basicsComplete} onClick={() => void createDraft()}>
              {busy ? '正在创建…' : '建立草稿并继续'}
            </button>
          ) : activeStep < 4 ? (
            <button className="primary-button" disabled={!canContinueFromStep(activeStep, cropStepComplete, namingStepComplete, encodingStepComplete, generationStepComplete)} onClick={() => navigateToStep(activeStep + 1)}>下一步</button>
          ) : (
            <span className="wizard-finished-label">当前任务已进入导出阶段</span>
          )}
        </div>
      </section>
    </div>
  )
}

function TaskBasics({
  existingSeries = false,
  form,
  setForm,
  chooseImage,
  updateChineseSeriesName,
  updateEnglishSeriesName,
  applyAutomaticTranslation,
  translationBusy,
  translationHint
}: {
  existingSeries?: boolean
  form: TaskDraftInput
  setForm: (value: TaskDraftInput) => void
  chooseImage: () => Promise<string | null>
  updateChineseSeriesName: (value: string) => void
  updateEnglishSeriesName: (value: string) => void
  applyAutomaticTranslation: () => void
  translationBusy: boolean
  translationHint: string
}): React.JSX.Element {
  return (
    <div className="wizard-form-grid">
      <div>
        <label className="field">
          <span>产品模板</span>
          <select value={form.templateName} onChange={(event) => setForm({ ...form, templateName: event.target.value })}>
            {TEMPLATE_OPTIONS.map((option) => <option key={option}>{option}</option>)}
          </select>
          <small>正式版将由模板配置自动生成该清单，不在页面里写死。</small>
        </label>
        {!existingSeries && <div className="field-row">
          <label className="field"><span>中文系列名（选填）</span><input value={form.seriesNameZh} onChange={(event) => updateChineseSeriesName(event.target.value)} placeholder="可留空；例如：杭州限定系列" /><small>留空时直接使用英文系列名继续业务流程。</small></label>
          <label className="field"><span className="field-title-row"><span>英文系列名</span><button type="button" disabled={translationBusy} onClick={applyAutomaticTranslation}>{translationBusy ? '翻译中…' : '重新翻译'}</button></span><input value={form.seriesNameEn} onChange={(event) => updateEnglishSeriesName(event.target.value)} placeholder="填写中文名后自动翻译，也可以手工修改" /><small>{translationHint}</small></label>
        </div>}
        {existingSeries && <p>先选择新增产品总图，下一步选择已有系列并比对历史图案。</p>}
        <label className="field">
          <span>备注（IP）（选填）</span>
          <input value={form.ipRemark} onChange={(event) => setForm({ ...form, ipRemark: event.target.value })} placeholder="例如：杭州限定" />
          <small>只写入新建表“条码”工作表的备注（IP）列。</small>
        </label>
        <label className="field">
          <span>一张产品排版总图</span>
          <div className="file-picker"><input readOnly value={form.masterImagePath} placeholder="请选择 PNG / JPG / WEBP / TIFF" /><button className="secondary-button" onClick={() => void chooseImage()}>选择总图</button></div>
          <small>不需要图片文件夹；后续程序会从这张总图中自动裁出各产品图。</small>
        </label>
      </div>
      <div className="template-protection-card">
        <span className="eyebrow">CONTROLLED WORKBOOKS</span><h4>基础资料受控写入</h4>
        <p>命名-公式始终只读；A 条码参考和国内命名表只有在质检通过并确认后，才按预览坐标备份、覆盖。</p>
        <div><strong>3 个</strong><small>初始化基础表</small></div>
        <div><strong>11 个</strong><small>已识别通用模板</small></div>
        <div><strong>自动</strong><small>覆盖前备份并支持回滚</small></div>
      </div>
    </div>
  )
}

function canContinueFromStep(step: number, cropStepComplete: boolean, namingStepComplete: boolean, encodingStepComplete: boolean, generationStepComplete: boolean): boolean {
  if (step === 1) return cropStepComplete && namingStepComplete
  if (step === 2) return encodingStepComplete
  if (step === 3) return generationStepComplete
  return false
}

function buildBasicsIncompleteMessage(baseFilesReady: boolean, form: TaskDraftInput): string {
  if (!baseFilesReady) return '请先到“基础表管理”导入并确认三个基础表，再建立任务。'
  if (!form.seriesNameEn.trim()) return '英文系列名尚未生成，请自动匹配或手工填写后再继续。'
  if (!form.masterImagePath) return '请先选择一张产品排版总图。'
  return '请先完成当前步骤。'
}

function buildStepLockedMessage(index: number, basicsComplete: boolean, cropStepComplete: boolean, namingStepComplete: boolean, encodingStepComplete: boolean, generationStepComplete: boolean): string {
  if (!basicsComplete) return '步骤 1 尚未完成：三个基础表、模板、英文系列名和产品总图必须就绪；中文系列名可留空。'
  if (index >= 2 && !cropStepComplete) return '步骤 2 尚未完成：请先识别总图并确认裁剪区域。'
  if (index >= 2 && !namingStepComplete) return '步骤 2 尚未完成：请确认产品类别、补齐英文图案名，并处理本次任务或国内命名表中的重复名称。'
  if (index >= 3 && !encodingStepComplete) return '步骤 3 尚未完成：请处理编码问题，并点击“确认机型”。'
  if (index >= 4 && !generationStepComplete) return '步骤 4 尚未通过质检：请先处理真实表格预览中的失败检查项。'
  return '当前步骤的真实功能尚未完成，暂不能继续。'
}

function buildDuplicateNameIssues(
  analysis: ImageAnalysisResult | null,
  domesticNames: AppSnapshot['domesticPatternNames']
): Record<string, string[]> {
  const products = (analysis?.crops ?? []).filter((crop) => crop.role !== 'series-overview' && crop.patternNameEn.trim())
  const issues: Record<string, string[]> = {}
  const unitsByName = new Map<string, Map<string, typeof products>>()

  for (const crop of products) {
    const normalizedName = normalizePatternName(crop.patternNameEn)
    const units = unitsByName.get(normalizedName) ?? new Map<string, typeof products>()
    const unitKey = crop.patternGroupId ?? crop.id
    const members = units.get(unitKey) ?? []
    members.push(crop)
    units.set(unitKey, members)
    unitsByName.set(normalizedName, units)
  }

  for (const units of unitsByName.values()) {
    if (units.size < 2) continue
    for (const crops of units.values()) {
      for (const crop of crops) addDuplicateIssue(issues, crop.id, '本次任务中另一个独立图案或图案组使用了相同英文名称。')
    }
  }

  const domesticByName = new Map(domesticNames.map((record) => [normalizePatternName(record.englishName), record]))
  for (const crop of products) {
    const historical = domesticByName.get(normalizePatternName(crop.patternNameEn))
    if (historical) addDuplicateIssue(issues, crop.id, `国内命名表“${historical.sheetName}”的 ${historical.cellAddress} 已使用名称“${historical.englishName}”。`)
  }

  return issues
}

function addDuplicateIssue(issues: Record<string, string[]>, cropId: string, message: string): void {
  const messages = issues[cropId] ?? []
  if (!messages.includes(message)) messages.push(message)
  issues[cropId] = messages
}

function normalizePatternName(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, ' ').trim()
}

function StepPlaceholder({ step }: { step: number }): React.JSX.Element {
  return (
    <div className="placeholder-workspace">
      <div className="placeholder-canvas"><span className="placeholder-icon">{WIZARD_STEPS[step]?.icon}</span><h4>{WIZARD_STEPS[step]?.title}工作区</h4><p>页面结构已经接通，当前暂不执行真实数据操作。</p></div>
      <div className="placeholder-checklist">
        <span className="eyebrow">PLANNED CAPABILITIES</span>
        {(STEP_DETAILS[step] ?? []).map((detail, index) => <div key={detail}><span>{index + 1}</span><p>{detail}</p><i>待接入</i></div>)}
      </div>
    </div>
  )
}
