import { useEffect, useMemo, useState } from 'react'
import type { MaterialMasterPreview, MaterialBrand, SaveMaterialModelInput } from '@shared/lifecycle-contracts'
import type { MaterialModel } from '@shared/material-model-dictionary'
import type { CollaborationWorkItem } from '@shared/contracts'
import { desktopApi } from '../../app/desktop-api'
import '../../styles/material-data.css'

const emptyModel = (): SaveMaterialModelInput => ({ brand: 'AP', code: '', name: '', aliases: [] })
const brandName = (brand: MaterialBrand): string => brand === 'AP' ? 'Apple' : brand === 'SA' ? 'Samsung' : 'Huawei'

export function MaterialDataPage({ enabled }: { enabled: boolean }): React.JSX.Element {
  const [tab, setTab] = useState<'master' | 'models'>('master')
  const [master, setMaster] = useState<MaterialMasterPreview | null>(null)
  const [centralMaster, setCentralMaster] = useState<CollaborationWorkItem | null>(null)
  const [models, setModels] = useState<MaterialModel[]>([])
  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [page, setPage] = useState(0)
  const [form, setForm] = useState<SaveMaterialModelInput>(emptyModel)
  const [aliasText, setAliasText] = useState('')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const pageSize = 40

  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(''); setMessage('')
    try { await operation() } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy(false) }
  }
  const loadMaster = async (nextPage = page, nextQuery = appliedQuery): Promise<void> => {
    const result = await desktopApi.lifecycle.previewMaterialMaster({ page: nextPage, pageSize, query: nextQuery || undefined })
    setMaster(result); setPage(nextPage)
  }
  const loadModels = async (): Promise<void> => setModels(await desktopApi.lifecycle.listMaterialModels())
  const loadCentralMaster = async (): Promise<void> => setCentralMaster(await desktopApi.collaboration.materialMaster())
  useEffect(() => {
    if (!enabled) return
    void run(async () => { await Promise.all([loadMaster(0, '').catch(() => undefined), loadModels(), loadCentralMaster()]) })
  }, [enabled])

  const chooseMaster = async (): Promise<void> => {
    const path = await desktopApi.supplement.selectMaster()
    if (!path) return
    setQuery(''); setAppliedQuery('')
    await loadMaster(0, '')
    setMessage('物料总表已更新，后续编码将使用此文件。')
  }
  const publishMaster = async (): Promise<void> => {
    if (!window.confirm(centralMaster ? '把当前本地物料总表保存为新的中央版本？' : '把当前本地物料总表建立为中央共享总表？')) return
    const result = await desktopApi.collaboration.publishMaterialMaster()
    setCentralMaster(result.item)
    setMessage(result.duplicate ? '中央物料总表内容未变化。' : `中央物料总表已更新到版本 ${result.item.revision}。`)
  }
  const syncMaster = async (): Promise<void> => {
    const result = await desktopApi.collaboration.syncMaterialMaster()
    setCentralMaster(result.item); setQuery(''); setAppliedQuery('')
    await loadMaster(0, '')
    setMessage(`已同步中央物料总表版本 ${result.item.revision}，后续编码统一使用该版本。`)
  }
  const editModel = (model: MaterialModel): void => {
    setEditing(true)
    setForm({ originalBrand: model.brand, originalCode: model.code, brand: model.brand, code: model.code, name: model.name, aliases: [...model.aliases] })
    setAliasText(model.aliases.join('、'))
  }
  const resetForm = (): void => { setEditing(false); setForm(emptyModel()); setAliasText('') }
  const saveModel = async (): Promise<void> => {
    const aliases = aliasText.split(/[、,，\n]/).map(value => value.trim()).filter(Boolean)
    if (editing && !window.confirm('修改机型名称或编码会影响后续物料编码识别。确认保存吗？')) return
    const values = await desktopApi.lifecycle.saveMaterialModel({ ...form, aliases })
    setModels(values); resetForm(); setMessage(editing ? '机型映射已修改。' : '机型映射已新增。')
  }
  const visibleModels = useMemo(() => {
    const key = query.trim().toUpperCase()
    return key ? models.filter(model => [model.brand, model.code, model.name, ...model.aliases].some(value => value.toUpperCase().includes(key))) : models
  }, [models, query])

  return <div className="material-data-page">
    <header className="md-intro"><div><small>下游资料</small><h2>资料管理</h2><p>统一维护物料总表和机型两位编码。这里的修改会直接影响后续共享工作表分析。</p></div><nav><button aria-pressed={tab === 'master'} onClick={() => setTab('master')}>物料总表</button><button aria-pressed={tab === 'models'} onClick={() => setTab('models')}>机型编码</button></nav></header>
    {error && <div className="alert error">{error}</div>}{message && <div className="alert info">{message}</div>}
    {tab === 'master' ? <section className="md-panel">
      <header><div><span className="eyebrow">MATERIAL MASTER</span><h3>物料总表管理与预览</h3><p>{master?.path ?? '尚未配置物料总表'}</p></div><button disabled={busy} onClick={() => void run(chooseMaster)}>{master ? '选择 / 更换物料总表' : '选择物料总表'}</button></header>
      <div className="md-central-master"><div><strong>中央共享总表</strong><span>{centralMaster ? `${centralMaster.title} · 版本 ${centralMaster.revision}` : '尚未建立'}</span><small>编码前会自动同步中央最新版；钉盘同步接口暂未启用。</small></div><nav><button disabled={busy || !master} onClick={() => void run(publishMaster)}>{centralMaster ? '上传本地更新' : '建立共享总表'}</button><button disabled={busy || !centralMaster} onClick={() => void run(syncMaster)}>同步中央最新版</button><button disabled={busy || !centralMaster} onClick={() => void run(async () => { await desktopApi.collaboration.openOnlineWorkbook({ workItemId: centralMaster!.id }); setMessage('已打开中央物料总表。') })}>WPS 在线编辑</button></nav></div>
      <div className="md-toolbar"><form onSubmit={event => { event.preventDefault(); setAppliedQuery(query.trim()); void run(async () => loadMaster(0, query.trim())) }}><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索物料名称、编码、类目或工作表" /><button disabled={busy}>查询</button></form><span>{master ? `共 ${master.totalRows} 条` : '等待选择文件'}</span></div>
      {master && <><div className="md-table"><table><thead><tr><th>位置</th><th>类目</th><th>物料编码</th><th>物料名称</th><th>图案标识</th><th>机型码</th></tr></thead><tbody>{master.rows.map(row => <tr key={row.id}><td>{row.sheet}!{row.row}</td><td>{row.itemClass || '—'}</td><td><code>{row.materialCode}</code></td><td>{row.materialName}</td><td>{/^\d{2}$/.test(row.materialCode.slice(-2)) ? row.materialCode.slice(-4, -2) : '—'}</td><td>{row.identity.modelCode ?? '未识别'}</td></tr>)}</tbody></table></div><footer className="md-pagination"><button disabled={busy || page === 0} onClick={() => void run(async () => loadMaster(page - 1))}>上一页</button><span>第 {page + 1} 页</span><button disabled={busy || (page + 1) * pageSize >= master.totalRows} onClick={() => void run(async () => loadMaster(page + 1))}>下一页</button></footer></>}
    </section> : <div className="md-model-layout"><section className="md-panel md-model-list"><header><div><span className="eyebrow">MODEL DICTIONARY</span><h3>机型与两位编码</h3><p>共 {models.length} 条；支持新增和修改，不在这里删除历史映射。</p></div><button onClick={resetForm}>新增机型</button></header><input className="md-model-search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索机型、别名或编码" /><div className="md-model-rows">{visibleModels.map(model => <button key={`${model.brand}-${model.code}`} className={editing && form.originalBrand === model.brand && form.originalCode === model.code ? 'selected' : ''} onClick={() => editModel(model)}><span>{brandName(model.brand)}</span><strong>{model.name}</strong><code>{model.code}</code><small>{model.aliases.length ? `别名：${model.aliases.join('、')}` : '无别名'}</small></button>)}</div></section>
      <section className="md-panel md-model-form"><header><div><span className="eyebrow">{editing ? 'EDIT MODEL' : 'NEW MODEL'}</span><h3>{editing ? '修改机型映射' : '新增机型映射'}</h3><p>名称必须与物料名称末尾的机型写法一致；组合机型可加入别名。</p></div></header><label>品牌<select value={form.brand} onChange={event => setForm(current => ({ ...current, brand: event.target.value as MaterialBrand }))}><option value="AP">Apple</option><option value="SA">Samsung</option><option value="HW">Huawei</option></select></label><label>两位机型码<input inputMode="numeric" maxLength={2} value={form.code} onChange={event => setForm(current => ({ ...current, code: event.target.value.replace(/\D/g, '').slice(0, 2) }))} placeholder="例如 75" /></label><label>标准机型名称<input value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} placeholder="例如 iP18 Pro Max/17 Pro Max" /></label><label>别名<textarea value={aliasText} onChange={event => setAliasText(event.target.value)} placeholder="多个别名使用逗号、顿号或换行分隔" /></label><div className="md-form-actions"><button onClick={resetForm}>取消</button><button className="primary" disabled={busy || !/^\d{2}$/.test(form.code) || !form.name.trim()} onClick={() => void run(saveModel)}>{busy ? '保存中…' : '保存映射'}</button></div></section></div>}
  </div>
}
