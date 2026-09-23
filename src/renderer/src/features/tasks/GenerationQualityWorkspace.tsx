import { useEffect, useMemo, useRef, useState } from 'react'
import { useHistoryImages } from './use-history-images'
import { qualityFocus } from './quality-focus'
import type { WorkbookPreviewResult, WorkbookPreviewRequest } from '@shared/contracts'
import { desktopApi } from '../../app/desktop-api'
import type { GenerationWorkspaceData, PreviewCell } from '@shared/generation-contracts'
import type { ImageAnalysisResult } from '@shared/image-contracts'

export function GenerationQualityWorkspace({ workspace, analysis }: { workspace: GenerationWorkspaceData; analysis: ImageAnalysisResult }): React.JSX.Element {
  const [activeWorkbookId, setActiveWorkbookId] = useState(workspace.workbooks[0]?.id ?? 'barcode-reference')
  const workbook = workspace.workbooks.find((item) => item.id === activeWorkbookId) ?? workspace.workbooks[0]!
  const [activeSheetId, setActiveSheetId] = useState(workbook.sheets[0]?.id ?? '')
  const plannedSheet = workbook.sheets.find((item) => item.id === activeSheetId) ?? workbook.sheets[0]!
  const [history, setHistory] = useState<WorkbookPreviewResult | null>(null)
  const [historyError, setHistoryError] = useState('')
  const historyKind = workbook.id === 'domestic-naming' ? 'domesticNaming' : 'barcodeReference'
  const needsHistory = (workbook.id === 'domestic-naming' || (workbook.id === 'barcode-reference' && plannedSheet.id === 'series-code' && plannedSheet.showBusinessHeader === false)) && !plannedSheet.createIfMissing
  const [imageRange, setImageRange] = useState({ start: 1, end: 12 })
  const imageRequest = useMemo<WorkbookPreviewRequest | null>(() => needsHistory && history ? { kind: historyKind, sheetName: plannedSheet.name, imagesOnly: true, imageStartRow: imageRange.start, imageEndRow: imageRange.end } : null, [needsHistory, history, historyKind, plannedSheet.name, imageRange])
  const { images: historyImages, error: imageError } = useHistoryImages(`${historyKind}:${plannedSheet.name}:${workspace.generatedAt}`, imageRequest)
  useEffect(() => {
    let canceled = false
    setHistory(null); setHistoryError(''); setImageRange({ start: 1, end: 12 })
    if (needsHistory) desktopApi.baseFiles.preview({ kind: historyKind, sheetName: plannedSheet.name, imageEndRow: 0 })
      .then((result) => { if (!canceled) setHistory(result) })
      .catch((error) => { if (!canceled) setHistoryError(String(error)) })
    return () => { canceled = true }
  }, [needsHistory, historyKind, plannedSheet.name, workspace.generatedAt])
  const sheet = useMemo(() => {
    if (!needsHistory || history?.activeSheetName !== plannedSheet.name) return plannedSheet
    const columns = Math.max(history.columnCount, plannedSheet.columns.length)
    const count = Math.max(history.totalRows, (plannedSheet.startRow ?? 1) - 1 + plannedSheet.rows.length)
    const rows: PreviewCell[][] = Array.from({ length: count }, () => [])
    for (const row of history.rows) for (const cell of row.cells) {
      const col = [...cell.address.replace(/\d/g, '')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1
      rows[row.rowNumber - 1]![col] = { value: /DISPIMG\s*\(/i.test(cell.formula ?? cell.value) ? '' : cell.value, formula: cell.formula ?? undefined, historicalImageDataUrl: historyImages[cell.address] }
    }
    plannedSheet.rows.forEach((row, offset) => row.forEach((cell, col) => {
      if (cell.changed || cell.writeOnly) rows[(plannedSheet.startRow ?? 1) - 1 + offset]![col] = cell
    }))
    return { ...plannedSheet, startRow: 1, rows, columns: Array.from({ length: columns }, (_, i) => columnName(i + 1)),
      columnWidths: Array.from({ length: columns }, (_, i) => history.columnWidths?.[i] ?? plannedSheet.columnWidths?.[i] ?? 160),
      rowHeights: Array.from({ length: count }, (_, i) => plannedSheet.rowHeights?.[i - (plannedSheet.startRow ?? 1) + 1] ?? history.rowHeights?.[i + 1] ?? 20) }
  }, [plannedSheet, needsHistory, history, historyImages])
  const [selection, setSelection] = useState({ row: 0, column: 0 })
  const [qualityExpanded, setQualityExpanded] = useState(false)
  const selectedCell = sheet.rows[selection.row]?.[selection.column]
  const allPassed = workspace.checks.every((check) => check.passed)
  const variantSummary = useMemo(() => {
    const generated = workspace.workbooks.find((item) => item.id === 'generated-product')
    const images = generated?.sheets.find((item) => item.id === 'generated-products')?.rows ?? []
    const barcodes = generated?.sheets.find((item) => item.id === 'generated-barcodes')?.rows.filter((row) => row[3]?.value) ?? []
    const silverImages = images.filter((row) => row[2]?.value === '银框').length
    const silverBarcodes = barcodes.filter((row) => row[3]?.value.includes('（银框）')).length
    return `图片：普通 ${images.length - silverImages} / 银框 ${silverImages}；条码：普通 ${barcodes.length - silverBarcodes} / 银框 ${silverBarcodes}`
  }, [workspace])
  const cropById = useMemo(() => new Map(analysis.crops.map((crop) => [crop.id, crop])), [analysis.crops])
  const businessHeaderVisible = sheet.showBusinessHeader !== false
  const startRow = sheet.startRow ?? 1
  const dataStartRow = startRow + (businessHeaderVisible ? 1 : 0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [focusRequest, setFocusRequest] = useState(0)
  const historyReady = !needsHistory || history?.activeSheetName === plannedSheet.name
  const focusRef = useRef({ sheet, dataStartRow })
  focusRef.current = { sheet, dataStartRow }
  useEffect(() => {
    if (!historyReady) return
    const frame = window.requestAnimationFrame(() => {
      const { sheet: current, dataStartRow: firstRow } = focusRef.current
      const target = qualityFocus(current)
      setSelection(target)
      const container = scrollRef.current
      const cell = container?.querySelectorAll('tbody > tr')[target.row]?.children[target.column + 1] as HTMLElement | undefined
      if (container && cell) {
        const bounds = container.getBoundingClientRect()
        const rect = cell.getBoundingClientRect()
        const headerHeight = container.querySelector('thead')?.getBoundingClientRect().height ?? 40
        container.scrollTop = Math.max(0, container.scrollTop + rect.top - bounds.top - headerHeight - 10)
        container.scrollLeft = Math.max(0, container.scrollLeft + rect.left - bounds.left - 50)
      }
      if (needsHistory) setImageRange({ start: Math.max(1, firstRow + target.row - 5), end: firstRow + target.row + 12 })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [workbook.id, plannedSheet.id, workspace.generatedAt, historyReady, focusRequest, needsHistory])

  const chooseWorkbook = (id: typeof activeWorkbookId): void => {
    const next = workspace.workbooks.find((item) => item.id === id)
    if (!next) return
    setActiveWorkbookId(id); setActiveSheetId(next.sheets[0]?.id ?? ''); setFocusRequest(n => n + 1)
  }

  return <div className="generation-workspace compact-generation">
    <div className="generation-summary-bar compact">
      <div><strong>{allPassed ? '生成数据已通过质检' : '生成数据仍有待处理项'}</strong><span>{workspace.title} · {variantSummary} · 绿色单元格为本次新增或更新</span></div>
      <button className={allPassed ? 'quality-pass' : 'quality-fail'} onClick={() => setQualityExpanded((value) => !value)}>{workspace.checks.filter((item) => item.passed).length}/{workspace.checks.length} 通过 {qualityExpanded ? '收起' : '详情'}</button>
    </div>
    {qualityExpanded && <div className="quality-inline-list">{workspace.checks.map((check) => <div className={check.passed ? 'passed' : 'failed'} key={check.id}><span>{check.passed ? '✓' : '!'}</span><div><strong>{check.label}</strong><small>{check.detail}</small></div></div>)}</div>}
    <div className="workbook-tabs" role="tablist">{workspace.workbooks.map((item) => <button key={item.id} className={item.id === workbook.id ? 'active' : ''} onClick={() => chooseWorkbook(item.id)}><strong>{item.name}</strong><small>{item.sheets.length > 1 ? `${item.sheets.length} 个工作表` : item.sheets[0]?.name}</small></button>)}</div>
    <section className="embedded-workbook expanded-workbook">
      {needsHistory && !history && <div className="alert info">{historyError || '正在加载该分表的历史数据和图片…'}</div>}
      <header className="embedded-workbook-heading"><div><h4>{workbook.name} · {sheet.name}</h4><p>{workbook.role}</p></div><span>WPS 式只读预览</span></header>
      {imageError && <div className="alert error">图片加载失败：{imageError}</div>}
      <div className="spreadsheet-formula-bar"><strong>{selectedCell?.targetAddress ?? cellAddress(selection.column, dataStartRow + selection.row)}</strong><span>fx</span><input readOnly value={selectedCell?.formula ?? selectedCell?.value ?? ''} /></div>
      <div className="spreadsheet-scroll" ref={scrollRef} key={`${workbook.id}:${plannedSheet.name}`} onScroll={event => {
        if (!needsHistory) return
        const container = event.currentTarget
        const bounds = container.getBoundingClientRect()
        const renderedRows = Array.from(container.querySelectorAll('tbody > tr'))
        const firstVisible = renderedRows.findIndex(row => row.getBoundingClientRect().bottom >= bounds.top)
        const first = Math.max(0, firstVisible)
        const start = Math.max(1, Math.floor(Math.max(0, first - 3) / 8) * 8 + 1)
        let last = first
        while (last < renderedRows.length && renderedRows[last]!.getBoundingClientRect().top <= bounds.bottom) last++
        const end = Math.min(sheet.rows.length, Math.ceil((last + 3) / 8) * 8)
        setImageRange(current => current.start === start && current.end === end ? current : { start, end })
      }}>
        <table className="spreadsheet-grid source-shaped-grid">
          <colgroup><col style={{ width: 46 }} />{sheet.columns.map((_, index) => <col key={index} style={{ width: sheet.columnWidths?.[index] ?? 160 }} />)}</colgroup>
          <thead>
            <tr><th className="row-corner" />{sheet.columns.map((_, index) => <th key={index}>{columnName(index + 1)}</th>)}</tr>
            {businessHeaderVisible && <tr style={sheet.headerCells?.some((cell) => cell?.cropId) ? { height: 92 } : undefined}><th>{startRow}</th>{sheet.columns.map((column, index) => {
              const headerCell = sheet.headerCells?.[index]
              return <th className={`business-header ${headerCell?.cropId ? 'header-image-cell' : ''}`} key={`${column}-${index}`} title={column}>
                {headerCell?.cropId ? renderCell(headerCell, cropById, analysis) : column}
              </th>
            })}</tr>}
          </thead>
          <tbody>{sheet.rows.map((row, rowIndex) => <tr key={rowIndex} style={{ height: sheet.rowHeights?.[rowIndex] }}><th>{dataStartRow + rowIndex}</th>{sheet.columns.map((_, columnIndex) => {
            const value = row[columnIndex] ?? { value: '' }
            const active = selection.row === rowIndex && selection.column === columnIndex
            return <td style={value.fill === 'yellow' ? { backgroundColor: '#fff38a', color: '#a51d1d' } : undefined} title={value.value} key={columnIndex} className={`${value.changed ? 'changed' : ''} ${active ? 'selected' : ''} ${value.cropId ? 'image-data-cell' : ''}`} onClick={() => setSelection({ row: rowIndex, column: columnIndex })}>{renderCell(value, cropById, analysis)}</td>
          })}</tr>)}</tbody>
        </table>
      </div>
      <footer className="sheet-tabs"><span>☰</span>{workbook.sheets.map((item) => <button className={item.id === sheet.id ? 'active' : ''} key={item.id} onClick={() => { setActiveSheetId(item.id); setFocusRequest(n => n + 1) }}>{item.name}</button>)}</footer>
    </section>
  </div>
}

function renderCell(cell: PreviewCell, cropById: Map<string, ImageAnalysisResult['crops'][number]>, analysis: ImageAnalysisResult): React.JSX.Element | string {
  if (cell.historicalImageDataUrl) return <img loading="lazy" decoding="async" src={cell.historicalImageDataUrl} style={{ maxWidth: '100%', maxHeight: 210, objectFit: 'contain' }} alt="历史产品图片" />
  if (!cell.cropId) return cell.value
  const crop = cropById.get(cell.cropId)
  if (!crop) return cell.value
  const positionX = analysis.sourceWidth === crop.width ? 0 : (crop.x / (analysis.sourceWidth - crop.width)) * 100
  const positionY = analysis.sourceHeight === crop.height ? 0 : (crop.y / (analysis.sourceHeight - crop.height)) * 100
  const layout = cell.imageLayout
  const width = layout ? `${Math.min(100, (layout.imageWidthPx / layout.containerWidthPx) * 100)}%` : '100%'
  const height = layout ? `${Math.min(100, (layout.imageHeightPx / layout.containerHeightPx) * 100)}%` : '100%'
  return <span className="sheet-image-cell"><i style={{
    width,
    height,
    backgroundImage: `url(${analysis.previewDataUrl})`,
    backgroundSize: `${(analysis.sourceWidth / crop.width) * 100}% ${(analysis.sourceHeight / crop.height) * 100}%`,
    backgroundPosition: `${positionX}% ${positionY}%`
  }} /><em>{cell.value}</em></span>
}

function cellAddress(column: number, row: number): string { return `${columnName(column + 1)}${row}` }
function columnName(index: number): string { let name = ''; let value = index; while (value > 0) { name = String.fromCharCode(65 + ((value - 1) % 26)) + name; value = Math.floor((value - 1) / 26) } return name }
