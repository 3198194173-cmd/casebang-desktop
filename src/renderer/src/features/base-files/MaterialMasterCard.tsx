import { useEffect, useState } from 'react'
import { desktopApi } from '../../app/desktop-api'
export function MaterialMasterCard(): React.JSX.Element {
  const [path, setPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { void desktopApi.supplement.getMaster().then(setPath).catch(e => setError(String(e))) }, [])
  return <section className="panel material-master-card"><span className="material-priority">首要基础资料 · 总物料表</span><h2>物料名称汇总</h2><p>原有产品补充新机型的首要匹配来源。保存文件位置，下次无需重复导入；不会覆盖总表。</p><p className="supplement-path">{path || '尚未配置，请先导入总物料表。'}</p><button className="primary-button" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { const p = await desktopApi.supplement.selectMaster(); if (p) setPath(p) } catch (e) { setError(String(e)) } finally { setBusy(false) } }}>{busy ? '正在选择…' : path ? '更换总物料表' : '导入总物料表'}</button>{error && <div className="alert error">{error}</div>}</section>
}
