import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppSnapshot, BaseFileKind, BaseFileUpdateRecord, WorkbookPreviewResult } from '@shared/contracts'
import type { BaseWorkbookInspectionReport } from '@shared/excel-contracts'
import { desktopApi } from '../../app/desktop-api'
import { groupUpdateHistory } from './base-file-history'

interface Props {
  snapshot: AppSnapshot
  onChanged(): Promise<void>
}

export function BaseFilesPage({ snapshot, onChanged }: Props): React.JSX.Element {
  const [busy, setBusy] = useState<BaseFileKind | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [inspection, setInspection] = useState<BaseWorkbookInspectionReport | null>(null)
  const [scanning, setScanning] = useState(false)
  const [preview, setPreview] = useState<WorkbookPreviewResult | null>(null)
  const [previewing, setPreviewing] = useState<BaseFileKind | null>(null)
  const previewSequence = useRef(0)
  useEffect(() => () => { previewSequence.current += 1 }, [])
  const [history, setHistory] = useState<BaseFileUpdateRecord[]>([])
  const [rollingBack, setRollingBack] = useState<string | null>(null)
  const [expandedHistoryIds, setExpandedHistoryIds] = useState<string[]>([])
  const allReady = Object.values(snapshot.baseFiles).filter((file) => file.kind !== 'productImageMapping').every((file) => file.status === 'ready')
  const historyGroups = useMemo(() => groupUpdateHistory(history), [history])

  useEffect(() => { void desktopApi.baseFiles.history().then(setHistory) }, [])
  useEffect(() => {
    setExpandedHistoryIds((current) => {
      const available = current.filter((id) => historyGroups.some((group) => group.id === id))
      return available.length > 0 ? available : historyGroups[0] ? [historyGroups[0].id] : []
    })
  }, [historyGroups])

  const selectFile = async (kind: BaseFileKind): Promise<void> => {
    try {
      setBusy(kind)
      const record = await desktopApi.baseFiles.select(kind)
      setMessage(record.status === 'ready' ? `${record.label}已保存` : null)
      setPreview(null)
      await onChanged()
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '文件选择失败')
    } finally {
      setBusy(null)
    }
  }

  const loadPreview = async (kind: BaseFileKind, sheetName?: string): Promise<void> => {
    const sequence = ++previewSequence.current
    try {
      setPreviewing(kind); setMessage('正在读取工作簿数据…')
      const result = await desktopApi.baseFiles.preview({ kind, sheetName, imageEndRow: 0 })
      if (sequence !== previewSequence.current) return
      setPreview(result); setMessage(null)
    } catch (reason) {
      if (sequence !== previewSequence.current) return
      setMessage(reason instanceof Error ? reason.message : '工作簿预览失败')
    } finally { if (sequence === previewSequence.current) setPreviewing(null) }
  }

  const rollback = async (record: BaseFileUpdateRecord): Promise<void> => {
    if (!window.confirm(`确认将“${record.sourceFileName}”恢复到此次覆盖前的版本吗？\n当前文件会先自动备份。`)) return
    try {
      setRollingBack(record.id); setMessage('正在备份当前文件并回滚…')
      await desktopApi.baseFiles.rollback(record.id)
      setHistory(await desktopApi.baseFiles.history())
      setPreview(null)
      await onChanged()
      setMessage('回滚完成，后续预览和业务流程将使用恢复后的基础表。')
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '回滚失败')
    } finally { setRollingBack(null) }
  }

  const inspectWorkbooks = async (): Promise<void> => {
    try {
      setScanning(true)
      setMessage('正在读取三个基础表，大文件可能需要一些时间…')
      const report = await desktopApi.excel.inspectBaseFiles()
      setInspection(report)
      setMessage(`检查完成，共识别 ${report.templateCount} 个业务模板。`)
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '工作簿检查失败')
    } finally {
      setScanning(false)
    }
  }

  return (
    <div className="stack-xl">
      <section className="notice-card">
        <strong>业务基础资料</strong>
        <p>A 条码参考和国内命名表支持本次业务覆盖与独立回滚；新建产品表单独生成。K3 图片对应表保留历史资料查看，不再由新系列建表或系列补产品写入。</p>
      </section>
      {message && <div className="alert info">{message}</div>}
      <section className="file-grid">
        {Object.values(snapshot.baseFiles).map((file, index) => (
          <article className="file-card" key={file.kind}>
            <div className="file-number">0{index + 1}</div>
            <div className="file-title">
              <span className={file.status === 'ready' ? 'status-label ready' : 'status-label'}>
                {file.status === 'ready' ? '已就绪' : file.status === 'missing' ? '路径失效' : '未导入'}
              </span>
              <h3>{file.label}</h3>
              <p>{file.fileName ?? '请选择对应的 Excel 工作簿'}</p>
            </div>
            <div className="file-card-actions">
              <button className="secondary-button" disabled={file.status !== 'ready' || previewing !== null} onClick={() => void loadPreview(file.kind)}>{previewing === file.kind ? '读取中…' : '预览数据'}</button>
              <button className="secondary-button" disabled={busy !== null} onClick={() => void selectFile(file.kind)}>{busy === file.kind ? '正在读取…' : file.status === 'ready' ? '替换文件' : '选择文件'}</button>
            </div>
          </article>
        ))}
      </section>
      {preview && <WorkbookPreviewPanel preview={preview} onChange={(sheetName) => void loadPreview(preview.kind, sheetName)} onClose={() => { previewSequence.current += 1; setPreviewing(null); setPreview(null) }} />}
      <section className="panel compact">
        <div className="panel-heading history-panel-heading"><div><span className="eyebrow">VERSION HISTORY</span><h3>基础表覆盖记录</h3><p>每次业务覆盖归为一组，展开后可按表格独立回滚。</p></div><span className="history-count">{historyGroups.length} 次操作</span></div>
        {historyGroups.length === 0 ? <div className="history-empty"><strong>暂无覆盖记录</strong><span>完成业务流程并覆盖基础表后，记录会显示在这里。</span></div> : <div className="base-history-timeline">{historyGroups.map((group, index) => {
          const expanded = expandedHistoryIds.includes(group.id)
          const fullyRolledBack = group.records.every((record) => record.rolledBackAt)
          const partlyRolledBack = !fullyRolledBack && group.records.some((record) => record.rolledBackAt)
          return <article className={`base-history-group ${expanded ? 'expanded' : ''}`} key={group.id}>
            <button className="history-group-summary" type="button" aria-expanded={expanded} onClick={() => setExpandedHistoryIds((current) => current.includes(group.id) ? current.filter((id) => id !== group.id) : [...current, group.id])}>
              <span className="history-sequence">{index === 0 ? '最新' : String(historyGroups.length - index).padStart(2, '0')}</span>
              <span className="history-summary-copy"><strong>{group.name}</strong><small>{new Date(group.createdAt).toLocaleString()}<i />更新 {group.records.length} 张基础表</small></span>
              <span className={`history-state ${fullyRolledBack ? 'rolled-back' : partlyRolledBack ? 'partial' : ''}`}>{fullyRolledBack ? '已全部回滚' : partlyRolledBack ? '部分已回滚' : '可回滚'}</span>
              <span className="history-chevron" aria-hidden>{expanded ? '−' : '+'}</span>
            </button>
            {expanded && <div className="history-group-files">{group.records.map((record) => <section className="history-file-row" key={record.id}>
              <span className="history-file-kind">{record.kind === 'barcodeReference' ? 'A' : record.kind === 'productImageMapping' ? 'K3' : '国'}</span>
              <div className="history-node-copy"><b>{record.kind === 'barcodeReference' ? 'A 条码参考' : record.kind === 'productImageMapping' ? 'K3 名称对应产品图片' : '国内命名表'}</b><span>{record.changeSummary ?? record.sourceFileName}</span><details className="history-backup-detail"><summary>查看备份信息</summary><code>{record.sourceFileName}<br />{record.backupPath}</code></details></div>
              {record.rolledBackAt ? <span className="history-rollback-time"><b>已回滚</b><small>{new Date(record.rolledBackAt).toLocaleString()}</small></span> : <button className="secondary-button" disabled={rollingBack !== null} onClick={() => void rollback(record)}>{rollingBack === record.id ? '回滚中…' : '回滚此表'}</button>}
            </section>)}</div>}
          </article>
        })}</div>}
      </section>
      <section className="panel compact">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">OOXML TEMPLATE ENGINE</span>
            <h3>模板扫描与结构指纹</h3>
          </div>
          <button
            className="primary-button"
            disabled={!allReady || scanning}
            onClick={() => void inspectWorkbooks()}
          >
            {scanning ? '正在扫描…' : '扫描三个基础表'}
          </button>
        </div>
        {!inspection ? (
          <p className="muted">扫描会读取工作表清单、公式数量、样式定义、行列结构、媒体文件和图片锚点，并为后续复制验证生成结构指纹。</p>
        ) : (
          <div className="inspection-result">
            <div className="inspection-metrics">
              <div><span>命名-公式</span><strong>{inspection.namingFormula.worksheetCount} 张表</strong></div>
              <div><span>A条码参考</span><strong>{inspection.barcodeReference.worksheetCount} 张表</strong></div>
              <div><span>国内命名表</span><strong>{inspection.domesticNaming.worksheetCount} 张表</strong></div>
              <div><span>识别模板</span><strong>{inspection.templateCount} 个</strong></div>
            </div>
            <div className="template-chip-list">
              {inspection.templates.map((template) => <span key={template.id}>{template.sheetName}</span>)}
            </div>
          </div>
        )}
      </section>
      <section className="panel compact">
        <h3>文件保护策略</h3>
        <div className="protection-grid">
          <div><strong>命名-公式</strong><span>永久只读，只作为模板来源</span></div>
          <div><strong>A 条码/国内命名</strong><span>导出页确认后才允许覆盖</span></div>
          <div><strong>本次任务副本</strong><span>失败可以直接丢弃重做</span></div>
          <div><strong>版本与回滚</strong><span>每次覆盖前自动保留历史版本</span></div>
        </div>
      </section>
    </div>
  )
}

const PREVIEW_ROW_HEIGHT = 44
const PREVIEW_VIEWPORT_HEIGHT = 560
const PREVIEW_OVERSCAN = 12

function WorkbookPreviewPanel({ preview, onChange, onClose }: { preview: WorkbookPreviewResult; onChange(sheetName: string): void; onClose(): void }): React.JSX.Element {
  const [scrollTop, setScrollTop] = useState(0)
  const [images, setImages] = useState<Record<string, string>>({})
  const [imageError, setImageError] = useState<string | null>(null)
  const [loadedRange, setLoadedRange] = useState('')
  const imageRequestBusy = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const columns = useMemo(() => Array.from({ length: preview.columnCount }, (_, index) => columnName(index + 1)), [preview.columnCount])
  const start = Math.max(0, Math.floor(scrollTop / PREVIEW_ROW_HEIGHT) - PREVIEW_OVERSCAN)
  const visibleCount = Math.ceil(PREVIEW_VIEWPORT_HEIGHT / PREVIEW_ROW_HEIGHT) + PREVIEW_OVERSCAN * 2
  const end = Math.min(preview.rows.length, start + visibleCount)
  const visibleRows = preview.rows.slice(start, end)
  useEffect(() => { setScrollTop(0); setImages({}); if (scrollRef.current) scrollRef.current.scrollTop = 0 }, [preview.kind, preview.activeSheetName, preview.fileName])
  const firstRow = visibleRows[0]?.rowNumber ?? 1
  const lastRow = visibleRows.at(-1)?.rowNumber ?? firstRow
  const rangeKey = `${preview.kind}:${preview.activeSheetName}:${firstRow}:${lastRow}`
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const load = async (): Promise<void> => {
      if (disposed) return
      if (imageRequestBusy.current) { timer = setTimeout(() => void load(), 80); return }
      imageRequestBusy.current = true
      try {
        const result = await desktopApi.baseFiles.preview({ kind: preview.kind, sheetName: preview.activeSheetName, imageStartRow: firstRow, imageEndRow: lastRow, imagesOnly: true })
        if (!disposed) {
          setImages(Object.fromEntries(result.rows.flatMap((row) => row.cells.filter((cell) => cell.generatedImageDataUrl).map((cell) => [cell.address, cell.generatedImageDataUrl!]))))
          setImageError(null)
          setLoadedRange(rangeKey)
        }
      } catch { if (!disposed) setImageError('当前区域图片加载失败，请滚动后重试。') }
      finally { imageRequestBusy.current = false }
    }
    timer = setTimeout(() => void load(), 150)
    return () => { disposed = true; clearTimeout(timer) }
  }, [preview, firstRow, lastRow, rangeKey])
  return <section className="panel compact base-preview-panel">
    <header className="base-preview-heading"><div><span className="eyebrow">完整工作簿预览</span><h3>{preview.fileName}</h3><p>{preview.activeSheetName} · 工作表末行 {preview.totalRows} · {preview.dataRowCount} 行包含数据 · 连续滚动</p></div><button className="secondary-button" onClick={onClose}>关闭预览</button></header>
    <div className="base-preview-tabs">{preview.sheetNames.map((name) => <button className={name === preview.activeSheetName ? 'active' : ''} key={name} onClick={() => onChange(name)}>{name}</button>)}</div>
    {imageError && <p role="status">{imageError}</p>}
    <div ref={scrollRef} className="base-preview-scroll" onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}><table className="base-preview-grid"><thead><tr><th>#</th>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>
      {start > 0 && <tr className="base-preview-spacer" aria-hidden><td colSpan={columns.length + 1} style={{ height: start * PREVIEW_ROW_HEIGHT }} /></tr>}
      {visibleRows.map((row) => {
      const byColumn = new Map(row.cells.map((cell) => [columnIndex(cell.address), cell] as const))
      return <tr key={row.rowNumber}><th>{row.rowNumber}</th>{columns.map((_, index) => { const cell = byColumn.get(index); const displayValue = cell?.value || (cell?.formula ? `=${cell.formula}` : ''); const isImage = /DISPIMG\s*\(/i.test(cell?.formula || cell?.value || '') || cell?.generatedImageDataUrl === ''; const image = cell ? images[cell.address] : undefined; return <td key={index} title={cell?.formula ? `=${cell.formula}` : cell?.value}>{image ? <img src={image} decoding="async" alt="工作簿图片" /> : isImage ? <span>{loadedRange !== rangeKey ? '图片加载中…' : '图片缺失或格式不支持'}</span> : displayValue}</td> })}</tr>
      })}
      {end < preview.rows.length && <tr className="base-preview-spacer" aria-hidden><td colSpan={columns.length + 1} style={{ height: (preview.rows.length - end) * PREVIEW_ROW_HEIGHT }} /></tr>}
    </tbody></table></div>
  </section>
}

function columnIndex(address: string): number { const name = /^[A-Z]+/i.exec(address)?.[0] ?? 'A'; return [...name.toUpperCase()].reduce((value, character) => value * 26 + character.charCodeAt(0) - 64, 0) - 1 }
function columnName(index: number): string { let name = ''; let value = index; while (value > 0) { name = String.fromCharCode(65 + ((value - 1) % 26)) + name; value = Math.floor((value - 1) / 26) } return name }
