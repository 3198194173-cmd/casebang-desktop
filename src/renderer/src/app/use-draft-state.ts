import { createElement, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'

let database: Promise<IDBDatabase> | undefined
function db(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('casebang-workflow-drafts', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('drafts')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => { database = undefined; reject(request.error) }
  })
}
const announce = (message: string): void => { window.dispatchEvent(new CustomEvent('draft-status', { detail: message })) }
export function useDraftState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(initial)
  const [ready, setReady] = useState(false)
  const edited = useRef(false)
  useEffect(() => {
    let active = true
    void db().then(database => new Promise<T | undefined>((resolve, reject) => {
      const request = database.transaction('drafts').objectStore('drafts').get(key)
      request.onsuccess = () => resolve(request.result as T | undefined)
      request.onerror = () => reject(request.error)
    })).then(saved => { if (active && saved !== undefined && !edited.current) setValue(saved) }).catch(() => announce('草稿读取失败，请勿关闭当前页面')).finally(() => { if (active) setReady(true) })
    return () => { active = false }
  }, [key])
  useEffect(() => {
    if (!ready) return
    const save = (): void => {
      void db().then(database => new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('drafts', 'readwrite')
        transaction.objectStore('drafts').put(value, key)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })).then(() => announce('草稿已自动保存 · 切换流程不会丢失')).catch(() => announce('草稿保存失败（可能空间不足），请先完成导出，不要关闭程序'))
    }
    const timer = window.setTimeout(save, 350)
    window.addEventListener('save-workflow-drafts', save)
    return () => { window.clearTimeout(timer); window.removeEventListener('save-workflow-drafts', save) }
  }, [key, value, ready])
  return [value, action => { edited.current = true; setValue(action) }]
}
export function DraftStatus(): React.JSX.Element {
  const [status, setStatus] = useState('支持自动保存草稿 · 本机恢复')
  useEffect(() => { const listener = (event: Event): void => setStatus((event as CustomEvent<string>).detail); window.addEventListener('draft-status', listener); return () => window.removeEventListener('draft-status', listener) }, [])
  const failed = status.includes('失败')
  const saved = status.includes('已自动保存')
  return createElement('section', { className: `workflow-draft-bar${failed ? ' has-error' : ''}`, 'aria-label': '业务流程草稿' },
    createElement('div', { className: 'workflow-draft-summary', role: 'status', 'aria-live': 'polite' },
      createElement('span', { className: 'workflow-draft-icon', 'aria-hidden': true },
        createElement('svg', { width: 19, height: 19, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
          createElement('path', { d: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z' }),
          createElement('path', { d: 'M14 3v6h6M8 13h8M8 17h5' }))),
      createElement('div', { className: 'workflow-draft-copy' },
        createElement('div', { className: 'workflow-draft-title' }, '工作草稿', createElement('span', { className: 'workflow-draft-badge' }, failed ? '需要处理' : saved ? '已保存' : '自动保存')),
        createElement('p', null, failed ? status : '仅保存在本机，切换业务流程可继续编辑'))),
    createElement('button', { className: 'workflow-draft-save', onClick: () => window.dispatchEvent(new Event('save-workflow-drafts')) }, '保存草稿'))
}
