import { useEffect, useMemo, useRef, useState } from 'react'
import type { BarcodeModelSetting, CategoryFramePriceRule, TaskDraftInput } from '@shared/contracts'
import type { ImageAnalysisResult } from '@shared/image-contracts'
import { sortBarcodeModelsByReference, type PhoneModelBrand } from '@shared/product-business-rules'
import { referenceFrameModel, referenceFrameModels } from '@shared/frame-product-reference'
import { PRODUCT_MODEL_TYPES, createDefaultProductModelSettings, productModelType, supportsSilverFrame, type ProductModelSettings, type ProductModelType } from '@shared/product-model-settings'
import { desktopApi } from '../../app/desktop-api'
import { MODEL_BRANDS, FramePriceEditor, ModelPriceOverrides } from './FramePriceEditor'
import { allProductModelsConfirmed, applyFrameReferenceToDraft, initializeProductModelState, normalizeProductModels, productModelIssues } from './product-model-state'

interface Props {
  analysis: ImageAnalysisResult
  form: TaskDraftInput
  onChange(settings: ProductModelSettings, confirmed: ProductModelType[]): void
  framePriceRules: Record<string, CategoryFramePriceRule>
  onFramePriceRulesChange(rules: Record<string, CategoryFramePriceRule>): void
  onConfirmedChange(confirmed: boolean): void
}

export function ProductModelSelector({ analysis, form, onChange, framePriceRules, onFramePriceRulesChange, onConfirmedChange }: Props): React.JSX.Element {
  const productCounts = useMemo(() => {
    const counts = new Map<ProductModelType, number>()
    for (const crop of analysis.crops) {
      const type = crop.role !== 'series-overview' ? productModelType(crop.productCategory) : null
      if (type) counts.set(type, (counts.get(type) ?? 0) + 1)
    }
    return counts
  }, [analysis])
  const requiredTypes = useMemo(() => PRODUCT_MODEL_TYPES.filter(type => productCounts.has(type)), [productCounts])
  const [activeType, setActiveType] = useState<ProductModelType>(() => requiredTypes[0] ?? PRODUCT_MODEL_TYPES[0]!)
  const [activeBrand, setActiveBrand] = useState<PhoneModelBrand>('apple')
  const [newModelBrand, setNewModelBrand] = useState<PhoneModelBrand>('apple')
  const [newModel, setNewModel] = useState('')
  const [search, setSearch] = useState('')
  const [memoryLoaded, setMemoryLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [referenceResetPending, setReferenceResetPending] = useState(false)
  const mounted = useRef(true)
  const formRef = useRef(form)
  formRef.current = form
  const settings = form.productModelSettings ?? createDefaultProductModelSettings()
  const confirmed = form.productModelsConfirmed ?? []
  const models = settings[activeType] ?? []
  const enabledCount = models.filter(model => model.enabled).length
  const silver = supportsSilverFrame(activeType)
  const referenceModels = referenceFrameModels(activeType)
  const silverCount = models.filter(model => model.enabled && model.silverEnabled).length
  const allConfirmed = memoryLoaded && allProductModelsConfirmed(requiredTypes, confirmed, settings)
  const query = search.trim().normalize('NFKC').toLocaleLowerCase()
  const groups = MODEL_BRANDS.map(brand => ({ ...brand, models: sortBarcodeModelsByReference(models.filter(model => model.brand === brand.id)) }))
  const visibleModels = (query ? sortBarcodeModelsByReference(models) : groups.find(group => group.id === activeBrand)?.models ?? []).filter(model => !query
    || `${model.name} ${MODEL_BRANDS.find(brand => brand.id === model.brand)?.label}`.normalize('NFKC').toLocaleLowerCase().includes(query))
  const priceCategories = [...new Set(analysis.crops.filter(crop => crop.role !== 'series-overview' && productModelType(crop.productCategory) === activeType).map(crop => crop.productCategory))]
  if (!priceCategories.length) priceCategories.push(activeType)

  const loadMemory = async (): Promise<void> => {
    try {
      setLoadError(null)
      const remembered = await desktopApi.settings.getProductModelSettings()
      if (!mounted.current) return
      const initial = initializeProductModelState(formRef.current, remembered)
      onChange(initial.settings, initial.confirmed)
      setMemoryLoaded(true)
    } catch (error) {
      if (!mounted.current) return
      setLoadError(error instanceof Error ? error.message : '机型记忆读取失败，请重试。')
    }
  }
  useEffect(() => { mounted.current = true; void loadMemory(); return () => { mounted.current = false } }, [])
  useEffect(() => { onConfirmedChange(allConfirmed) }, [allConfirmed])

  const editModels = (next: BarcodeModelSetting[]): void => {
    if (productCounts.has(activeType)) onConfirmedChange(false)
    onChange({ ...settings, [activeType]: next.map(model => ({ ...model, silverEnabled: silver && model.silverEnabled })) }, confirmed.filter(type => type !== activeType))
    setMessage(null)
  }
  const updateModel = (id: string, patch: Partial<BarcodeModelSetting>): void => editModels(models.map(model => model.id === id ? { ...model, ...patch } : model))
  const enableModels = (items: BarcodeModelSetting[], enabled: boolean): void => {
    const ids = new Set(items.map(model => model.id))
    editModels(models.map(model => ids.has(model.id) ? { ...model, enabled } : model))
  }
  const chooseType = (type: ProductModelType): void => {
    setActiveType(type)
    setSearch('')
    setMessage(null)
    setNewModel('')
    setReferenceResetPending(false)
    const nextModels = settings[type] ?? []
    setActiveBrand(nextModels.find(model => model.enabled)?.brand ?? nextModels[0]?.brand ?? 'apple')
  }
  const addModel = (): void => {
    const name = newModel.trim()
    if (!name) return
    const existing = models.find(model => model.name.normalize('NFKC').toLocaleLowerCase() === name.normalize('NFKC').toLocaleLowerCase())
    if (existing) {
      setMessage('该机型已经存在，可搜索后修改或重新启用。')
      setSearch(name)
      setActiveBrand(existing.brand)
      return
    }
    editModels([...models, { id: crypto.randomUUID(), name, brand: newModelBrand, enabled: true, silverEnabled: silver && Boolean(referenceFrameModel(activeType, name)?.silver) }])
    setNewModel('')
    setSearch('')
    setActiveBrand(newModelBrand)
  }
  const applyReference = (): void => {
    const next = applyFrameReferenceToDraft({ ...form, framePriceRules }, activeType)
    onFramePriceRulesChange(next.framePriceRules ?? {})
    onChange(next.productModelSettings ?? {}, next.productModelsConfirmed ?? [])
    if (productCounts.has(activeType)) onConfirmedChange(false)
    setReferenceResetPending(false)
    setSearch('')
    setNewModel('')
    setActiveBrand('apple')
    setMessage(`已套用 ${activeType}的 260928 参考机型与价格，请检查后确认并记忆。只替换当前类型，其他类型未改变。`)
  }
  const confirmType = async (): Promise<void> => {
    const issues = productModelIssues(models, productCounts.has(activeType))
    if (issues.length) { setMessage(issues.join(' ')); return }
    const ordered = normalizeProductModels(activeType, models)
    try {
      setSaving(true)
      await desktopApi.settings.saveProductModelSettings({ productType: activeType, models: ordered })
      if (!mounted.current) return
      onChange({ ...settings, [activeType]: ordered }, [...new Set([...confirmed, activeType])])
      setMessage(`已确认并记忆 ${activeType}的 ${enabledCount} 个机型。之后的新系列和系列补产品会沿用，重新修改确认后才更新记忆。`)
    } catch (error) {
      if (!mounted.current) return
      setMessage(error instanceof Error ? error.message : '机型记忆保存失败，请重试。')
    } finally { if (mounted.current) setSaving(false) }
  }

  return <section className={`model-confirmation-panel product-model-selector${allConfirmed ? ' confirmed' : ''}`}>
    <header>
      <div><strong>按产品类型选择条码机型</strong><span>八类机型独立维护。手机机型按苹果 → 三星 → 华为 → 其他排列，每个机型内按产品编码升序排列图案。</span></div>
      <b>{allConfirmed ? '本次类型已确认' : '待确认'}</b>
    </header>
    <div className="product-model-type-picker">
      <label><span>壳体 / 产品类型</span><select aria-label="壳体 / 产品类型" value={activeType} onChange={event => chooseType(event.target.value as ProductModelType)} disabled={saving || !memoryLoaded}>
        {PRODUCT_MODEL_TYPES.map(type => <option key={type} value={type} style={{ color: productCounts.has(type) ? '#394dff' : '#8893a5' }}>{type} · {productCounts.has(type) ? `本次 ${productCounts.get(type)} 个产品` : '本次未出现（可维护）'}</option>)}
      </select></label>
      <p>高亮类型出现在当前总图中；灰色类型未出现，也可以选择、维护和记忆，不会因此生成额外产品。</p>
    </div>
    <div className="product-model-type-status" aria-label="产品类型机型配置状态">
      {PRODUCT_MODEL_TYPES.map(type => <button key={type} type="button" disabled={saving || !memoryLoaded} className={`${productCounts.has(type) ? 'present' : 'absent'}${type === activeType ? ' active' : ''}`} onClick={() => chooseType(type)} aria-pressed={type === activeType}>
        <strong>{type}</strong><span>{productCounts.has(type) ? `${productCounts.get(type)} 个产品` : '未出现'} · {confirmed.includes(type) ? '已确认' : '待确认'}</span>
      </button>)}
    </div>
    {!memoryLoaded && <div className={`alert ${loadError ? 'warning' : 'info'}`} role="status">{loadError ?? '正在读取本机记忆的各类型机型…'}{loadError && <button type="button" onClick={() => void loadMemory()}>重新读取</button>}</div>}
    <fieldset className="product-model-controls" disabled={!memoryLoaded || saving}>
      {referenceModels && <div className="frame-reference-panel">
        <div><strong>260928 条码参考 · {activeType}</strong><p>参考黑框 {referenceModels.length} 个机型 / 银框 {referenceModels.filter(model => model.silver).length} 个机型。{activeType === '出镜壳' ? '黑框按机型为 ¥129 / US$28.99 或 ¥149 / US$31.99。' : '黑框为 ¥149 / US$31.99。'}银框为 ¥169 / US$36.99。</p><small>已保留当前草稿和本机记忆；下方显示实际生效价，可单独调整。</small></div>
        <button type="button" onClick={() => setReferenceResetPending(true)}>套用 260928 参考机型与价格</button>
        {referenceResetPending && <div className="frame-reference-confirm" role="alert"><p>将替换当前类型的机型、勾选和手动价格，恢复参考名单与价格。其他类型不变；点击「确认并记忆」后才更新本机记忆。</p><div><button type="button" onClick={() => setReferenceResetPending(false)}>保留当前配置</button><button type="button" className="primary-button" onClick={applyReference}>确认套用参考</button></div></div>}
      </div>}
      <div className="model-toolbar">
        <span>{activeType} · 已勾选 {enabledCount} / {models.length} 个</span>
        <button type="button" onClick={() => enableModels(models, true)}>全选</button><button type="button" onClick={() => enableModels(models, false)}>清空</button>
        <div><select aria-label="新增机型品牌" value={newModelBrand} onChange={event => setNewModelBrand(event.target.value as PhoneModelBrand)}>{MODEL_BRANDS.map(brand => <option key={brand.id} value={brand.id}>{brand.label}</option>)}</select>
          <input aria-label="新增机型名称" value={newModel} maxLength={100} onChange={event => setNewModel(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addModel() } }} placeholder="输入新增机型" />
          <button type="button" onClick={addModel}>添加机型</button></div>
      </div>
      <label className="product-model-search"><span>查询当前类型的机型（跨品牌）</span><input aria-label="查询机型" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索机型名称或品牌（不改变勾选）" /></label>
      <div className="model-brand-tabs" aria-label="按品牌查看机型">
        {groups.map(group => <button type="button" key={group.id} aria-pressed={activeBrand === group.id} onClick={() => setActiveBrand(group.id)}>{group.label}<span>{group.models.filter(model => model.enabled).length} / {group.models.length}</span></button>)}
      </div>
      <div className="model-brand-list" key={`${activeType}-${activeBrand}`}><section className="model-brand-group">
        <header><div><strong>{query ? '全部品牌搜索结果' : MODEL_BRANDS.find(brand => brand.id === activeBrand)?.label}</strong><span>显示 {visibleModels.length} 个机型；搜索结果内全选 / 清空</span></div><div><button type="button" disabled={!visibleModels.length} onClick={() => enableModels(visibleModels, true)}>全选</button><button type="button" disabled={!visibleModels.length} onClick={() => enableModels(visibleModels, false)}>清空</button></div></header>
        {visibleModels.length ? <div className="model-edit-list">{visibleModels.map(model => <div className={`model-edit-row product-model-edit-row${model.enabled ? ' enabled' : ''}`} key={model.id}>
          <label className="model-enabled"><input type="checkbox" checked={model.enabled} onChange={event => updateModel(model.id, { enabled: event.target.checked })} /><span>启用</span></label>
          <label><span>机型名称</span><input value={model.name} maxLength={100} onChange={event => updateModel(model.id, { name: event.target.value })} /></label>
          <label><span>品牌</span><select value={model.brand} onChange={event => updateModel(model.id, { brand: event.target.value as PhoneModelBrand })}>{MODEL_BRANDS.map(brand => <option key={brand.id} value={brand.id}>{brand.label}</option>)}</select></label>
          <button type="button" className="product-model-delete" aria-label={`删除机型 ${model.name}`} onClick={() => editModels(models.filter(item => item.id !== model.id))}>删除</button>
          {silver && <label className="model-silver-enabled"><input type="checkbox" checked={model.silverEnabled} onChange={event => updateModel(model.id, { silverEnabled: event.target.checked })} /><span>生成银框</span></label>}
          {silver && model.enabled && <ModelPriceOverrides model={model} categories={priceCategories} rules={framePriceRules} onChange={next => updateModel(model.id, next)} />}
        </div>)}</div> : <p>{query ? '没有符合搜索条件的机型。' : '暂无机型，可通过上方输入框添加。'}</p>}
      </section></div>
      {silver && <FramePriceEditor categories={priceCategories} rules={framePriceRules} onChange={rules => { onFramePriceRulesChange(rules); onChange(settings, confirmed.filter(type => type !== activeType)) }} />}
    </fieldset>
    {!silver && <p className="product-model-frame-note">{activeType}只生成普通款，不生成银框。产品价格沿用步骤 2 的设置。</p>}
    {message && <div className="alert info" role="status">{message}</div>}
    <footer><span>{productCounts.has(activeType) ? `${productCounts.get(activeType)} 个产品 × ${enabledCount} 个黑框 / 普通机型${silver ? ` + ${silverCount} 个银框机型` : ''}` : '本次没有该类型产品；确认仅保存机型记忆。'}{requiredTypes.filter(type => !confirmed.includes(type)).length > 0 && ` 待确认：${requiredTypes.filter(type => !confirmed.includes(type)).join('、')}`}</span>
      <button className="primary-button" type="button" disabled={!memoryLoaded || saving} onClick={() => void confirmType()}>{saving ? '正在保存…' : `确认并记忆 ${activeType}机型`}</button></footer>
  </section>
}
