import { useEffect, useState } from 'react'
import type { CollaborationWorkItem, LocalWorkbookEditSession } from '@shared/contracts'
import { desktopApi } from '../../app/desktop-api'
import { accountError } from '../../app/account-context'

export function LocalWorkbookEditPanel({ workItemId, currentRevision, onSaved }: {
  workItemId: string
  currentRevision?: number
  onSaved?: (item: CollaborationWorkItem) => void | Promise<void>
}): React.JSX.Element {
  const [session, setSession] = useState<LocalWorkbookEditSession | null>(null)
  const [editorPath, setEditorPath] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [conflict, setConflict] = useState(false)
  const stale = Boolean(session && currentRevision && currentRevision > session.baseRevision)

  useEffect(() => {
    let active = true
    setSession(null); setError(''); setMessage(''); setConflict(false)
    void desktopApi.collaboration.activeLocalEdit({ workItemId }).then(value => { if (active) setSession(value) })
      .catch(cause => { if (active) setError(accountError(cause, '读取本地编辑稿失败')) })
    return () => { active = false }
  }, [workItemId])

  useEffect(() => {
    void desktopApi.collaboration.localEditor().then(setEditorPath)
      .catch(cause => setError(accountError(cause, '读取本地编辑器设置失败')))
  }, [])

  const selectEditor = async (): Promise<void> => {
    setBusy(true); setError('')
    try { setEditorPath(await desktopApi.collaboration.selectLocalEditor()) }
    catch (cause) { setError(accountError(cause, '选择本地编辑器失败')) }
    finally { setBusy(false) }
  }

  const clearEditor = async (): Promise<void> => {
    setBusy(true); setError('')
    try { await desktopApi.collaboration.clearLocalEditor(); setEditorPath(null) }
    catch (cause) { setError(accountError(cause, '恢复系统默认编辑器失败')) }
    finally { setBusy(false) }
  }

  const begin = async (forceNew = false): Promise<void> => {
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await desktopApi.collaboration.beginLocalEdit({ workItemId, ...(forceNew ? { forceNew: true } : {}) })
      setSession(result); setConflict(false)
      setMessage(`已打开本地工作簿（基于中央修订 ${result.baseRevision}）。请在本地表格软件中保存，完成后返回这里提交。`)
    } catch (cause) {
      setSession(await desktopApi.collaboration.activeLocalEdit({ workItemId }).catch(() => null))
      setError(accountError(cause, '打开本地工作簿失败'))
    }
    finally { setBusy(false) }
  }

  const open = async (): Promise<void> => {
    if (!session) return
    setBusy(true); setError('')
    try { setSession(await desktopApi.collaboration.openLocalEdit({ workItemId, sessionId: session.id })) }
    catch (cause) { setError(accountError(cause, '打开本地编辑稿失败')) }
    finally { setBusy(false) }
  }

  const commit = async (): Promise<void> => {
    if (!session) return
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await desktopApi.collaboration.commitLocalEdit({
        workItemId, sessionId: session.id, ...(reason.trim() ? { changeReason: reason.trim() } : {})
      })
      if (result.unchanged) {
        setMessage('本地工作簿与下载时相同，没有新修订；如已修改，请先在本地表格软件中保存。')
      } else {
        setMessage(`已提交中央修订 ${result.item?.revision ?? ''}${result.hasRemainingChanges ? '；本地还有上传期间产生的改动，请再次提交。' : '；编辑时间轴已更新。'}`)
        setReason('')
        setSession(await desktopApi.collaboration.activeLocalEdit({ workItemId }).catch(() => null))
        if (result.item && onSaved) {
          try { await onSaved(result.item) }
          catch (cause) { setMessage(`中央修订 ${result.item.revision} 已提交，但页面刷新失败：${accountError(cause, '请手动刷新记录')}`) }
        }
      }
    } catch (cause) {
      const value = accountError(cause, '提交本地修改失败')
      setError(value)
      setConflict(/版本|冲突|状态.*变化/.test(value))
    } finally { setBusy(false) }
  }

  return <div className="local-workbook-edit">
    <div className="local-workbook-editor-choice"><small title={editorPath ?? undefined}>打开方式：{editorPath ?? 'Windows 默认 .xlsx 程序'}</small>
      <button className="secondary-button" disabled={busy} onClick={() => void selectEditor()}>选择 WPS/Excel 程序</button>
      {editorPath && <button className="secondary-button" disabled={busy} onClick={() => void clearEditor()}>恢复系统默认</button>}</div>
    <div className="local-workbook-edit-actions">
      {!session ? <button className="secondary-button" disabled={busy} onClick={() => void begin()}>{busy ? '下载并打开中…' : '下载最新版并用本地表格软件编辑'}</button>
        : <><button className="secondary-button" disabled={busy} onClick={() => void open()}>重新打开本地稿</button>
          <button className="primary-button" disabled={busy || stale} onClick={() => void commit()}>{busy ? '提交中…' : '提交本地修改到工作簿记录'}</button></>}
    </div>
    {session && <><small>本地稿基于中央修订 {session.baseRevision}。请先在本机表格软件保存，再点击提交；本地保存不会自动同步。</small>
      <small className="local-workbook-edit-path" title={session.filePath}>恢复文件：{session.filePath}</small>
      <label>修改说明（可选）<input value={reason} maxLength={500} onChange={event => setReason(event.target.value)} placeholder="例如：修正条码表名称" /></label></>}
    {(conflict || stale) && session && <div className="alert error"><p>中央版本已变化。本地稿不会被覆盖；请保留上方路径，与中央最新版人工合并。</p>
      <button className="secondary-button" disabled={busy} onClick={() => void begin(true)}>保留旧稿并下载中央最新版</button></div>}
    {error && <div className="alert error">{error}</div>}
    {message && <div className="alert success">{message}</div>}
  </div>
}
