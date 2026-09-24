import { useDraftState } from '../../app/use-draft-state'
import { useEffect, useRef, useState } from 'react'
import { desktopApi } from '../../app/desktop-api'
import type { SupplementResult, SupplementVariantOverride } from '@shared/supplement-contracts'
import { SupplementWorkbookPreview } from './SupplementWorkbookPreview'
import { priceGroup } from '@shared/supplement-rules'
const key = priceGroup
export function SupplementPage({ active, onOpenMaterialData }: { active: boolean; onOpenMaterialData(): void }): React.JSX.Element {
  const [masterPath, setMaster] = useState('')
  const [inputPath, setInput] = useDraftState('supplement.inputPath', '')
  const [targetModel, setModel] = useDraftState('supplement.targetModel', 'iP Fold（Duo）')
  const [result, setResult] = useDraftState<SupplementResult | null>('supplement.result', null)
  const [variants, setVariants] = useDraftState<SupplementVariantOverride[]>('supplement.variants', [])
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const [message, setMessage] = useState('')
  const [publishedRecord, setPublishedRecord] = useState<{ id: string; revision: number } | null>(null)
  useEffect(() => {
    if (!active) return
    void desktopApi.supplement.getMaster().then(p => { setMaster(p ?? ''); setMessage('') }).catch(e => setMessage(String(e)))
  }, [active])
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (lock.current) return
    lock.current = true; setBusy(true); setMessage('')
    try { await action() } catch (e) { setMessage(e instanceof Error ? e.message : String(e)) }
    finally { lock.current = false; setBusy(false) }
  }
  const matched = result?.rows.filter(r => r.status === 'matched') ?? []
  return <div className="stack-xl supplement-page">
    <section className="panel supplement-setup"><div className="supplement-heading"><div><span className="eyebrow">新机型补充</span><h2>原有产品补充新机型</h2><p>用补齐表中的原物料名称检索总表，再生成目标机型的新记录。</p></div><span className={`supplement-ready ${masterPath ? 'ready' : ''}`}>{masterPath ? '总表已就绪' : '缺少总物料表'}</span></div>
      <div className={`supplement-source ${masterPath ? 'is-ready' : 'is-empty'}`}><div className="supplement-source-icon">总</div><div><strong>总物料表</strong><small>首要匹配来源 · 由资料管理统一维护</small><p className="supplement-path" title={masterPath}>{masterPath ? masterPath.split(/[\\/]/).pop() : '尚未配置，请到资料管理选择物料总表'}</p></div><button className="secondary-button" disabled={busy} onClick={onOpenMaterialData}>{masterPath ? '查看资料管理' : '前往资料管理'}</button></div>
      <div className="supplement-input-grid"><div className="supplement-input-card"><span className="supplement-step-number">1</span><div><strong>导入补齐表</strong><small>包含产品图片和原物料名称</small><button className="secondary-button" disabled={busy} onClick={() => void run(async () => { const p = await desktopApi.supplement.select(); if (p) { setInput(p); setResult(null); setVariants([]); setPublishedRecord(null) } })}>{inputPath ? '更换补齐表' : '选择补齐表'}</button><p className="supplement-path">{inputPath || '尚未选择 .xlsx 文件'}</p></div></div>
        <label className="supplement-input-card"><span className="supplement-step-number">2</span><div><strong>填写新增目标机型</strong><small>无需在总表中已经存在</small><input disabled={busy} value={targetModel} placeholder="例如 HW PX VIEW、iP Fold（Duo）" onChange={e => { setModel(e.target.value); setResult(null); setVariants([]); setPublishedRecord(null) }} /><small>款式后缀从补齐表保留，目标机型用于生成新记录。</small></div></label></div>
      <div className="supplement-run-row"><div><strong>准备完成后开始识别</strong><small>不会修改总物料表和补齐表</small></div><button className="primary-button" disabled={busy || !masterPath || !inputPath || !targetModel.trim()} onClick={() => void run(async () => {
        setResult(null); setVariants([]); setPublishedRecord(null)
        const latest = await desktopApi.supplement.getMaster(); if (!latest) throw new Error('请先在资料管理中选择物料总表')
        setMaster(latest)
        const data = await desktopApi.supplement.analyze({ masterPath: latest, inputPath, targetModel }); setResult(data)
        const groups = new Map<string, string>()
        for (const r of data.rows.filter(r => r.status === 'matched')) if (!groups.has(key(r.variant))) groups.set(key(r.variant), key(r.variant))
        setVariants([...groups.values()].sort().map(variant => ({ variant, domesticPrice: '', overseasPrice: '' })))
      })}>{busy ? '处理中，请稍候…' : '识别并匹配'}</button></div>
    </section>
    {message && <div className="alert">{message}</div>}
    {result && <>
      <section className="panel"><h3>识别 {result.rows.length} 条 · 可生成 {result.matched} 条 · 未匹配 {result.missing} 条 · 冲突 {result.conflict} 条</h3>
        <h3>按版本设置价格</h3><p>出镜壳 / 出片壳自动补齐普通版和银框版，其他产品不自动增加银框。Y 标记与同版本共用价格设置；备注直接沿用总表，不做统一改写。留空保留参考价格。</p>
        {variants.map((v, i) => <fieldset className="supplement-variant" disabled={busy} key={v.variant}><legend>{v.variant || '普通款'} · {matched.filter(r => key(r.variant) === key(v.variant)).length} 条</legend><div className="supplement-form-grid"><label>目标机型<input readOnly value={targetModel + v.variant} /></label>
          {(['domesticPrice', 'overseasPrice'] as const).map((field, f) => <label key={field}>{['建议零售价（元）', '海外零售价（美元）'][f]}<input inputMode="decimal" value={v[field] ?? ''} placeholder="留空保留参考值" onChange={e => { setVariants(current => current.map((item, n) => n === i ? { ...item, [field]: e.target.value } : item)); setPublishedRecord(null) }} /></label>)}
        </div></fieldset>)}
        <div className="supplement-final-actions">
          <button className="primary-button" disabled={busy || !matched.length || Boolean(publishedRecord)} onClick={() => void run(async () => { const response = await desktopApi.supplement.publishShared({ title: `产品补机型-${targetModel}`, overrides: { variants, draft: { result, sourcePaths: [masterPath, inputPath] } } }); setPublishedRecord({ id: response.item.id, revision: response.item.revision }); setMessage(response.duplicate ? '中央工作簿已经存在，已连接到原记录。' : '共享工作簿已建立，双方现在编辑同一份中央文件。') })}>{publishedRecord ? '共享工作簿已建立' : '建立共享工作簿'}</button>
          {publishedRecord && <button className="secondary-button" disabled={busy} onClick={() => void run(async () => { await desktopApi.collaboration.openOnlineWorkbook({ workItemId: publishedRecord.id }); setMessage('已打开 WPS 在线工作簿。') })}>打开 WPS 在线编辑</button>}
          <button className="secondary-button" disabled={busy || !matched.length} onClick={() => void run(async () => { const path = await desktopApi.supplement.export({ variants, draft: { result, sourcePaths: [masterPath, inputPath] } }); if (path) setMessage(`本地副本已导出：${path}；后续修改不会自动同步到中央工作簿。`) })}>导出本地副本</button>
        </div>
        <p>共享工作簿会在后台直接生成并上传；本地副本仅用于离线备份，不是进入协作流程的前置步骤。</p>
      </section>
      <SupplementWorkbookPreview result={result} variants={variants} />
    </>}
  </div>
}
