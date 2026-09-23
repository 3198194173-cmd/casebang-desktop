import { useEffect, useMemo, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { EncodingPreviewResult, EncodingPreviewRow } from '@shared/coding-contracts'
import type { ImageAnalysisResult } from '@shared/image-contracts'
import type { BarcodeModelSetting, CategoryFramePriceRule, FramePricePair } from '@shared/contracts'
import { desktopApi } from '../../app/desktop-api'
import { buildSeriesCodeReservePlan, isValidSeriesCode } from '@shared/series-code'
import { phoneModelBrand, productBusinessSpecification, REFERENCE_PHONE_MODELS, sortBarcodeModelsByReference, type PhoneModelBrand } from '@shared/product-business-rules'

const MODEL_BRANDS: Array<{ id: PhoneModelBrand; label: string }> = [
  { id: 'apple', label: '苹果' },
  { id: 'samsung', label: '三星' },
  { id: 'huawei', label: '华为' },
  { id: 'other', label: '其他' }
]

interface EncodingPreviewWorkspaceProps {
  existingSeriesCode?: string
  seriesNameZh: string
  seriesNameEn: string
  analysis: ImageAnalysisResult
  preview: EncodingPreviewResult | null
  setPreview: Dispatch<SetStateAction<EncodingPreviewResult | null>>
  selectedModels: string[]
  setSelectedModels: (models: string[]) => void
  modelBrandAssignments: Record<string, PhoneModelBrand>
  setModelBrandAssignments: (assignments: Record<string, PhoneModelBrand>) => void
  modelSettings: BarcodeModelSetting[]
  setModelSettings: (settings: BarcodeModelSetting[]) => void
  framePriceRules: Record<string, CategoryFramePriceRule>
  setFramePriceRules: (rules: Record<string, CategoryFramePriceRule>) => void
  modelsConfirmed: boolean
  setModelsConfirmed: (confirmed: boolean) => void
}

export function EncodingPreviewWorkspace({
  existingSeriesCode,
  seriesNameZh,
  seriesNameEn,
  analysis,
  preview,
  setPreview,
  selectedModels,
  setSelectedModels,
  modelBrandAssignments,
  setModelBrandAssignments,
  modelSettings,
  setModelSettings,
  framePriceRules,
  setFramePriceRules,
  modelsConfirmed,
  setModelsConfirmed
}: EncodingPreviewWorkspaceProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [newModel, setNewModel] = useState('')
  const [newModelBrand, setNewModelBrand] = useState<PhoneModelBrand>('apple')
  const [activeModelBrand, setActiveModelBrand] = useState<PhoneModelBrand>('apple')
  const pairedFrameCategories = useMemo(() => [...new Set(analysis.crops
    .filter((crop) => /出镜壳|出片壳/.test(crop.productCategory))
    .map((crop) => crop.productCategory))], [analysis])

  const loadPreview = async (): Promise<void> => {
    try {
      setBusy(true)
      setMessage(null)
      const result = await desktopApi.excel.buildEncodingPreview({
        seriesNameZh,
        seriesNameEn,
        crops: analysis.crops
          .filter((crop) => crop.role !== 'series-overview')
          .map((crop) => ({
            cropId: crop.id,
            productCategory: crop.productCategory,
            patternGroupId: crop.patternGroupId,
            patternNameEn: crop.patternNameEn
          }))
      })
      setPreview(existingSeriesCode ? { ...result, seriesCode: existingSeriesCode, recommendedSeriesCode: existingSeriesCode, seriesCodeWithSuffix: `${existingSeriesCode}系列`, seriesCodeStatus: 'existing', seriesCodeMessage: '已锁定选定系列；产品编码仍按类别新增。' } : result)
      setMessage(`已读取 A条码参考，共生成 ${result.rows.length} 条产品编码预览。`)
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '编码预览生成失败')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!preview && !busy) void loadPreview()
  }, [])

  const issues = useMemo(() => getEncodingPreviewIssues(preview), [preview])
  const rowsByCategory = useMemo(() => {
    const groups = new Map<string, EncodingPreviewRow[]>()
    for (const row of preview?.rows ?? []) {
      const rows = groups.get(row.productCategory) ?? []
      rows.push(row)
      groups.set(row.productCategory, rows)
    }
    return [...groups.entries()]
  }, [preview])
  const availableModels = useMemo(
    () => [...new Set([...REFERENCE_PHONE_MODELS, ...Object.keys(modelBrandAssignments), ...selectedModels])],
    [modelBrandAssignments, selectedModels]
  )
  const effectiveModelSettings = useMemo<BarcodeModelSetting[]>(() => modelSettings.length > 0
    ? modelSettings
    : availableModels.map((name, index) => ({
        id: 'model-' + index + '-' + name,
        name,
        brand: modelBrandAssignments[name] ?? phoneModelBrand(name),
        enabled: selectedModels.includes(name),
        silverEnabled: true
      })), [modelSettings, availableModels, modelBrandAssignments, selectedModels])
  const modelGroups = useMemo(() => MODEL_BRANDS.map((brand) => ({
    ...brand,
    models: sortBarcodeModelsByReference(effectiveModelSettings.filter((model) => model.brand === brand.id))
  })), [effectiveModelSettings])
  const modelDependentProductCount = useMemo(
    () => analysis.crops.filter((crop) => crop.role !== 'series-overview' && productBusinessSpecification(crop.productCategory).expandsByModel).length,
    [analysis]
  )

  useEffect(() => {
    if (modelSettings.length === 0 && effectiveModelSettings.length > 0) setModelSettings(effectiveModelSettings)
  }, [modelSettings.length])

  const commitModelSettings = (settings: BarcodeModelSetting[]): void => {
    const ordered = sortBarcodeModelsByReference(settings)
    setModelsConfirmed(false)
    setModelSettings(ordered)
    const enabled = ordered.filter((model) => model.enabled && model.name.trim())
    setSelectedModels(enabled.map((model) => model.name.trim()))
    setModelBrandAssignments(Object.fromEntries(ordered.filter((model) => model.name.trim()).map((model) => [model.name.trim(), model.brand])))
  }

  const updateModels = (models: string[]): void => {
    const enabled = new Set(models)
    commitModelSettings(effectiveModelSettings.map((model) => ({ ...model, enabled: enabled.has(model.name) })))
  }

  const toggleModel = (model: BarcodeModelSetting): void => {
    commitModelSettings(effectiveModelSettings.map((item) => item.id === model.id ? { ...item, enabled: !item.enabled } : item))
  }

  const selectModelGroup = (models: BarcodeModelSetting[]): void => {
    const ids = new Set(models.map((model) => model.id))
    commitModelSettings(effectiveModelSettings.map((model) => ids.has(model.id) ? { ...model, enabled: true } : model))
  }

  const clearModelGroup = (models: BarcodeModelSetting[]): void => {
    const ids = new Set(models.map((model) => model.id))
    commitModelSettings(effectiveModelSettings.map((model) => ids.has(model.id) ? { ...model, enabled: false } : model))
  }

  const addModel = (): void => {
    const model = newModel.trim()
    if (!model) return
    const existing = availableModels.find((item) => item.toLocaleLowerCase() === model.toLocaleLowerCase())
    const canonicalModel = existing ?? model
    const existingSetting = effectiveModelSettings.find((item) => item.name.toLocaleLowerCase() === canonicalModel.toLocaleLowerCase())
    if (existingSetting) commitModelSettings(effectiveModelSettings.map((item) => item.id === existingSetting.id ? { ...item, enabled: true, brand: newModelBrand } : item))
    else commitModelSettings([...effectiveModelSettings, { id: 'custom-' + Date.now(), name: canonicalModel, brand: newModelBrand, enabled: true, silverEnabled: true }])
    setNewModel('')
    setActiveModelBrand(newModelBrand)
  }

  const confirmModels = (): void => {
    const enabledModels = effectiveModelSettings.filter((model) => model.enabled)
    const names = enabledModels.map((model) => model.name.trim()).filter(Boolean)
    if (enabledModels.some((model) => !model.name.trim())) {
      setModelsConfirmed(false)
      setMessage('已启用机型的名称不能为空，请填写名称或取消勾选。')
      return
    }
    if (modelDependentProductCount > 0 && names.length === 0) {
      setModelsConfirmed(false)
      setMessage('当前包含单个片材产品，请至少勾选一个机型。')
      return
    }
    if (new Set(names.map((name) => name.toLocaleLowerCase())).size !== names.length) {
      setModelsConfirmed(false)
      setMessage('已启用机型的名称不能为空或重复，请修正后再确认。')
      return
    }
    setModelsConfirmed(true)
    setMessage(modelDependentProductCount > 0
      ? `已确认 ${names.length} 个机型；出镜壳/出片壳会按各机型的银框开关和价格设置生成。`
      : '当前产品不需要按机型展开，已确认本次不生成机型条码记录。')
  }

  const updateSeriesCode = (seriesCode: string): void => {
    const normalized = seriesCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
    setPreview((current) => current ? {
      ...current,
      seriesCode: normalized,
      seriesCodeWithSuffix: `${normalized}系列`,
      seriesCodeReservePlan: buildSeriesCodeReservePlan(current.referencePreview?.seriesRows ?? [], normalized)
    } : current)
  }

  const updateProductCode = (cropId: string, productCode: string): void => {
    setPreview((current) => current ? {
      ...current,
      rows: current.rows.map((row) => row.cropId === cropId
        ? { ...row, productCode: productCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11) }
        : row)
    } : current)
  }

  if (!preview) {
    return (
      <div className="encoding-loading-state">
        <span>03</span>
        <h4>{busy ? '正在读取 A条码参考并计算编码…' : '尚未生成编码预览'}</h4>
        <p>程序只读取基础表，不会在此步骤修改原文件。</p>
        {message && <div className="alert warning">{message}</div>}
        {!busy && <button className="primary-button" onClick={() => void loadPreview()}>生成编码预览</button>}
      </div>
    )
  }

  return (
    <div className="encoding-preview-workspace">
      <div className="encoding-preview-toolbar">
        <div><strong>编码分配预览</strong><span>依据“A条码参考 → 系列名对应代码、已使用编码”实时计算；确认前不会写入任何表格。</span></div>
        <button className="secondary-button" disabled={busy} onClick={() => void loadPreview()}>{busy ? '正在重新计算…' : '重新读取并计算'}</button>
      </div>
      {message && <div className="alert info">{message}</div>}
      <div className="encoding-summary-grid">
        <section className={`encoding-series-card ${seriesCodeIssue(preview) ? 'error' : ''}`}>
          <span>系列编码</span>
          <div><input readOnly={Boolean(existingSeriesCode)} value={preview.seriesCode} onChange={(event) => updateSeriesCode(event.target.value)} /><b>系列</b></div>
          <strong>{preview.seriesCodeStatus === 'existing' ? '基础表已有系列' : '建议使用的新系列码'}</strong>
          <small>{preview.seriesCodeMessage}</small>
          <small>覆盖后保留 {preview.seriesCodeReservePlan.requiredReserveCount} 个可用系列码；本次将自动补充 {preview.seriesCodeReservePlan.supplementWrites.length > 0 ? preview.seriesCodeReservePlan.supplementWrites.map((item) => item.code).join('、') : '无需补充'}。</small>
          {seriesCodeIssue(preview) && <mark>{seriesCodeIssue(preview)}</mark>}
        </section>
        <section><span>产品记录</span><strong>{preview.rows.length}</strong><small>每张产品切片保留一条独立编码</small></section>
        <section><span>产品类别</span><strong>{rowsByCategory.length}</strong><small>按“已使用编码”的类别列分别分配</small></section>
        <section className={issues.length > 0 ? 'error' : 'ready'}><span>编码检查</span><strong>{issues.length > 0 ? `${issues.length} 项待处理` : '全部通过'}</strong><small>{issues.length > 0 ? '修正红色项目后才能进入生成步骤' : '未发现格式、占用或重复冲突'}</small></section>
      </div>
      {issues.length > 0 && <div className="alert warning">编码预览还有 {issues.length} 项问题。红色输入框会指出具体位置；修改后将即时重新检查。</div>}
      <section className={`model-confirmation-panel ${modelsConfirmed ? 'confirmed' : ''}`}>
        <header>
          <div>
            <strong>条码机型</strong>
            <span>参考表统计到 {REFERENCE_PHONE_MODELS.length} 个机型。生成顺序为苹果 → 三星 → 华为 → 其他；每个机型下依次排列全部图案。</span>
          </div>
          <b>{modelsConfirmed ? '已确认' : '待确认'}</b>
        </header>
        <div className="model-toolbar">
          <span>已勾选 {selectedModels.length} 个</span>
          <button type="button" onClick={() => commitModelSettings(effectiveModelSettings.map((model) => ({ ...model, enabled: true })))}>全选</button>
          <button type="button" onClick={() => updateModels([])}>清空</button>
          <div>
            <select aria-label="新增机型品牌" value={newModelBrand} onChange={(event) => setNewModelBrand(event.target.value as PhoneModelBrand)}>
              {MODEL_BRANDS.map((brand) => <option key={brand.id} value={brand.id}>{brand.label}</option>)}
            </select>
            <input value={newModel} onChange={(event) => setNewModel(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addModel() } }} placeholder="输入新增机型" />
            <button type="button" onClick={addModel}>添加机型</button>
          </div>
        </div>
        <div className="model-brand-tabs" aria-label="按品牌查看机型">
          {modelGroups.map((group) => <button type="button" key={group.id} aria-pressed={activeModelBrand === group.id} onClick={() => setActiveModelBrand(group.id)}>
            {group.label}<span>{group.models.filter((model) => model.enabled).length} / {group.models.length}</span>
          </button>)}
        </div>
        <div className="model-brand-list" key={activeModelBrand}>
          {modelGroups.filter((group) => group.id === activeModelBrand).map((group) => (
            <section className="model-brand-group" key={group.id}>
              <header>
                <div><strong>{group.label}</strong><span>{group.models.length} 个机型 · 已选 {group.models.filter((model) => model.enabled).length} 个</span></div>
                <div><button type="button" onClick={() => selectModelGroup(group.models)} disabled={group.models.length === 0}>全选</button><button type="button" onClick={() => clearModelGroup(group.models)} disabled={group.models.length === 0}>清空</button></div>
              </header>
              {group.models.length > 0
                ? <div className="model-edit-list">{group.models.map((model) => <div className={'model-edit-row ' + (model.enabled ? 'enabled' : '')} key={model.id}>
                  <label className="model-enabled"><input type="checkbox" checked={model.enabled} onChange={() => toggleModel(model)} /><span>启用</span></label>
                  <label><span>机型名称</span><input value={model.name} onChange={(event) => commitModelSettings(effectiveModelSettings.map((item) => item.id === model.id ? { ...item, name: event.target.value } : item))} /></label>
                  <label><span>品牌</span><select value={model.brand} onChange={(event) => commitModelSettings(effectiveModelSettings.map((item) => item.id === model.id ? { ...item, brand: event.target.value as PhoneModelBrand } : item))}>{MODEL_BRANDS.map((brand) => <option key={brand.id} value={brand.id}>{brand.label}</option>)}</select></label>
                  {pairedFrameCategories.length > 0 && <label className="model-silver-enabled"><input type="checkbox" checked={model.silverEnabled} onChange={(event) => commitModelSettings(effectiveModelSettings.map((item) => item.id === model.id ? { ...item, silverEnabled: event.target.checked } : item))} /><span>生成银框</span></label>}
                  {model.enabled && pairedFrameCategories.length > 0 && <ModelPriceOverrides model={model} categories={pairedFrameCategories} onChange={(next) => commitModelSettings(effectiveModelSettings.map((item) => item.id === model.id ? next : item))} />}
                </div>)}</div>
                : <p>暂无机型，可通过上方输入框添加。</p>}
            </section>
          ))}
        </div>
        {pairedFrameCategories.length > 0 && <FramePriceEditor categories={pairedFrameCategories} rules={framePriceRules} onChange={(rules) => { setModelsConfirmed(false); setFramePriceRules(rules) }} />}
        <footer>
          <span>{modelDependentProductCount > 0 ? `${modelDependentProductCount} 个单个片材产品 × ${selectedModels.length} 个机型` : '当前产品类型不按机型展开'}</span>
          <button className="primary-button" type="button" onClick={confirmModels}>{modelsConfirmed ? '重新确认机型 ✓' : '确认机型 ✓'}</button>
        </footer>
      </section>
      <div className="encoding-category-list">
        {rowsByCategory.map(([category, rows]) => (
          <section className="encoding-category-card" key={category}>
            <header>
              <div><strong>{category}</strong><span>{rows.length} 个产品 · 编码池 {rows[0]?.poolColumn ?? '未匹配'}列「{rows[0]?.poolHeader ?? '待人工确认'}」</span></div>
              <small>历史最新：{rows[0]?.previousLatestCode ?? '无记录'}</small>
            </header>
            <div className="encoding-row-list">
              {rows.map((row) => {
                const crop = analysis.crops.find((candidate) => candidate.id === row.cropId)
                const rowIssues = productCodeIssues(row, preview)
                return (
                  <article className={`encoding-row ${rowIssues.length > 0 ? 'error' : ''}`} key={row.cropId}>
                    {crop && <span className="encoding-thumb" style={{ ...cropThumbnailStyle(crop, analysis), aspectRatio: `${crop.width} / ${crop.height}` }} />}
                    <div className="encoding-row-name"><span>图案顺序 {String(row.order).padStart(2, '0')}</span><strong>{row.patternNameEn}</strong><small>{row.patternGroupId ? '同图案组产品，名称共享但编码独立' : '独立图案'}</small></div>
                    <div className="encoding-code-field"><label>产品编码</label><input value={row.productCode} onChange={(event) => updateProductCode(row.cropId, event.target.value)} /><small>{row.message}</small></div>
                    <div className="encoding-row-status">{rowIssues.length > 0 ? <mark>{rowIssues.join('；')}</mark> : <b>可使用</b>}</div>
                  </article>
                )
              })}
            </div>
          </section>
        ))}
      </div>
      <div className="encoding-rule-note">
        <strong>本次分配规则</strong>
        <span>同一产品类别按图片/图案顺序连续分配；磁吸支架背盖与磁吸气囊支架按图案组共用数字序号，但各自保留 ZJBG、ZJQN 前缀和独立产品记录。</span>
      </div>
    </div>
  )
}

function ModelPriceOverrides({ model, categories, onChange }: {
  model: BarcodeModelSetting
  categories: string[]
  onChange(model: BarcodeModelSetting): void
}): React.JSX.Element {
  const update = (category: string, frame: 'normal' | 'silver', field: 'domestic' | 'overseas', raw: string): void => {
    const numeric = raw.trim() ? Number(raw) : null
    const categoriesMap = model.pricesByCategory ?? {}
    const categoryRule = categoriesMap[category] ?? {}
    const price = categoryRule[frame] ?? { domestic: null, overseas: null }
    onChange({
      ...model,
      pricesByCategory: {
        ...categoriesMap,
        [category]: { ...categoryRule, [frame]: { ...price, [field]: Number.isFinite(numeric) ? numeric : null } }
      }
    })
  }
  return <details className="model-price-overrides">
    <summary>单独设置此机型价格（可选）</summary>
    {categories.map((category) => <div className="model-price-category" key={category}>
      <strong>{category}</strong>
      {(['normal', 'silver'] as const).map((frame) => {
        const value = model.pricesByCategory?.[category]?.[frame]
        return <div key={frame}><span>{frame === 'normal' ? '普通款' : '银框款'}</span>
          <label><span>建议零售价（元）</span><input type="number" min="0.01" step="0.01" value={value?.domestic ?? ''} placeholder="留空继承品牌价格" onChange={(event) => update(category, frame, 'domestic', event.target.value)} /></label>
          <label><span>海外零售价（美元）</span><input type="number" min="0.01" step="0.01" value={value?.overseas ?? ''} placeholder="留空继承品牌价格" onChange={(event) => update(category, frame, 'overseas', event.target.value)} /></label>
        </div>
      })}
    </div>)}
  </details>
}

function FramePriceEditor({ categories, rules, onChange }: {
  categories: string[]
  rules: Record<string, CategoryFramePriceRule>
  onChange(rules: Record<string, CategoryFramePriceRule>): void
}): React.JSX.Element {
  const pair = (category: string, brand: PhoneModelBrand | null, frame: 'normal' | 'silver'): FramePricePair['normal'] => {
    const existing = brand ? rules[category]?.brands?.[brand]?.[frame] : rules[category]?.[frame]
    if (existing) return existing
    if (brand) return { domestic: null, overseas: null }
    return frame === 'silver'
      ? { domestic: 169, overseas: 36.99 }
      : { domestic: 149, overseas: 31.99 }
  }
  const update = (category: string, brand: PhoneModelBrand | null, frame: 'normal' | 'silver', field: 'domestic' | 'overseas', raw: string): void => {
    const value = raw.trim() ? Number(raw) : null
    const current = rules[category] ?? {}
    if (brand) {
      const brands = current.brands ?? {}
      const brandRule = brands[brand] ?? {}
      onChange({ ...rules, [category]: { ...current, brands: { ...brands, [brand]: { ...brandRule, [frame]: { ...pair(category, brand, frame), [field]: Number.isFinite(value) ? value : null } } } } })
    } else {
      onChange({ ...rules, [category]: { ...current, [frame]: { ...pair(category, null, frame), [field]: Number.isFinite(value) ? value : null } } })
    }
  }
  const priceInputs = (category: string, brand: PhoneModelBrand | null, frame: 'normal' | 'silver'): React.JSX.Element => {
    const value = pair(category, brand, frame)
    const defaults = pair(category, null, frame)
    return <div className="frame-price-pair" role="group" aria-label={`${category} / ${brand ? MODEL_BRANDS.find((item) => item.id === brand)?.label : '类别默认'} / ${frame === 'normal' ? '普通款' : '银框款'}`}>
      <label><span>建议零售价（元）</span><input type="number" min="0.01" step="0.01" value={value?.domestic ?? ''} placeholder={brand ? `继承 ${defaults?.domestic ?? '类别价格'}` : ''} onChange={(event) => update(category, brand, frame, 'domestic', event.target.value)} /></label>
      <label><span>海外零售价（美元）</span><input type="number" min="0.01" step="0.01" value={value?.overseas ?? ''} placeholder={brand ? `继承 ${defaults?.overseas ?? '类别价格'}` : ''} onChange={(event) => update(category, brand, frame, 'overseas', event.target.value)} /></label>
    </div>
  }
  return <section className="frame-price-editor">
    <header><div><strong>出镜壳 / 出片壳价格</strong><span>普通款与银框款分别设置。生效顺序：单机型价格 → 品牌价格 → 类别默认；留空自动继承。</span></div></header>
    {categories.map((category) => <details key={category} open>
      <summary>{category}</summary>
      <div className="frame-price-table">
        <div className="frame-price-header"><span>适用范围</span><b>普通款</b><b>银框款</b></div>
        <div className="frame-price-row"><strong>类别默认</strong>{priceInputs(category, null, 'normal')}{priceInputs(category, null, 'silver')}</div>
        {MODEL_BRANDS.map((brand) => <div className="frame-price-row" key={brand.id}><strong>{brand.label}</strong>{priceInputs(category, brand.id, 'normal')}{priceInputs(category, brand.id, 'silver')}</div>)}
      </div>
    </details>)}
  </section>
}

export function getEncodingPreviewIssues(preview: EncodingPreviewResult | null): string[] {
  if (!preview) return ['尚未生成编码预览']
  const issues: string[] = []
  const seriesIssue = seriesCodeIssue(preview)
  if (seriesIssue) issues.push(seriesIssue)
  for (const row of preview.rows) issues.push(...productCodeIssues(row, preview).map((issue) => `${row.productCategory} / ${row.patternNameEn}：${issue}`))
  return issues
}

function seriesCodeIssue(preview: EncodingPreviewResult): string | null {
  if (!isValidSeriesCode(preview.seriesCode)) return '系列编码必须是一个大写字母加数字，例如 K1 或 A10。'
  const occupied = preview.usedSeriesCodes.includes(preview.seriesCode)
  if (occupied && !(preview.seriesCodeStatus === 'existing' && preview.seriesCode === preview.recommendedSeriesCode)) return '该系列编码已被其他系列使用。'
  return null
}

function productCodeIssues(row: EncodingPreviewRow, preview: EncodingPreviewResult): string[] {
  const issues: string[] = []
  if (row.status === 'unmapped') issues.push('产品类别未匹配编码池')
  if (!/^[A-Z]{2,6}\d{5}$/.test(row.productCode)) issues.push('格式应为字母前缀加 5 位数字')
  const historicalCodes = new Set(preview.pools.flatMap((pool) => pool.usedCodes))
  if (historicalCodes.has(row.productCode)) issues.push('该编码已存在于 A条码参考')
  if (row.productCode && preview.rows.some((candidate) => candidate.cropId !== row.cropId && candidate.productCode === row.productCode)) issues.push('与本次任务另一产品编码重复')
  return issues
}

function cropThumbnailStyle(crop: ImageAnalysisResult['crops'][number], analysis: ImageAnalysisResult): React.CSSProperties {
  const x = analysis.sourceWidth === crop.width ? 50 : crop.x / (analysis.sourceWidth - crop.width) * 100
  const y = analysis.sourceHeight === crop.height ? 50 : crop.y / (analysis.sourceHeight - crop.height) * 100
  return {
    backgroundImage: `url(${analysis.previewDataUrl})`,
    backgroundSize: `${analysis.sourceWidth / crop.width * 100}% ${analysis.sourceHeight / crop.height * 100}%`,
    backgroundPosition: `${x}% ${y}%`
  }
}
