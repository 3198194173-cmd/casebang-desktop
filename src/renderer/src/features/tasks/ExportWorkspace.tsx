import { useEffect, useRef, useState } from 'react'
import type { GenerationWorkspaceData } from '@shared/generation-contracts'
import type { AppSnapshot } from '@shared/contracts'
import type { ImageAnalysisResult } from '@shared/image-contracts'
import type { LifecycleSource } from '@shared/lifecycle-contracts'
import { desktopApi } from '../../app/desktop-api'

type WorkbookId = GenerationWorkspaceData['workbooks'][number]['id']
type BaseWorkbookId = Extract<WorkbookId, 'barcode-reference' | 'domestic-naming'>

interface Props {
  workspace: GenerationWorkspaceData
  templateName: string
  baseFiles: AppSnapshot['baseFiles']
  analysis: ImageAnalysisResult
  sourceWorkflow: Extract<LifecycleSource, 'new-series' | 'new-products'>
  onDataChanged(): Promise<void>
}

const DEFAULT_EXPORT_IDS: WorkbookId[] = ['generated-product']
const DEFAULT_BASE_IDS: BaseWorkbookId[] = ['barcode-reference', 'domestic-naming']

export function ExportWorkspace({ workspace, templateName, baseFiles, analysis, sourceWorkflow, onDataChanged }: Props): React.JSX.Element {
  const [busyMode, setBusyMode] = useState<'export' | 'overwrite' | 'publish' | 'open' | null>(null)
  const operationPending = useRef(false)
  const [result, setResult] = useState<string | null>(null)
  const [processedFiles, setProcessedFiles] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [baseUpdateIds, setBaseUpdateIds] = useState<BaseWorkbookId[]>(() => [...DEFAULT_BASE_IDS])
  const [requireQualityCheck, setRequireQualityCheck] = useState(true)
  const [publishedRecord, setPublishedRecord] = useState<{ id: string; revision: number } | null>(null)
  const ready = !requireQualityCheck || workspace.checks.every((check) => check.passed)

  useEffect(() => {
    void desktopApi.settings.get().then((value) => setRequireQualityCheck(value.requireQualityCheck))
  }, [])

  const generationRequest = (selectedWorkbookIds: WorkbookId[], overwriteBaseFiles: boolean) => {
    const namingFormula = baseFiles.namingFormula.path
    const barcodeReference = baseFiles.barcodeReference.path
    const domesticNaming = baseFiles.domesticNaming.path
    if (!namingFormula || !barcodeReference || !domesticNaming) throw new Error('三个基础表路径不完整，无法处理。')
    return {
      suggestedName: workspace.title,
      workspace: {
        ...workspace,
        workbooks: workspace.workbooks.filter((book) => selectedWorkbookIds.includes(book.id)).map((book) => ({
          ...book,
          sheets: book.sheets.map((sheet) => ({
            ...sheet,
            headerCells: sheet.headerCells?.map(({ historicalImageDataUrl: _image, ...cell }) => cell),
            rows: sheet.rows.map((row) => row.map(({ historicalImageDataUrl: _image, ...cell }) => cell))
          }))
        }))
      },
      templateName,
      sourcePaths: { namingFormula, barcodeReference, domesticNaming },
      imageSource: {
        path: analysis.sourceImagePath,
        crops: analysis.crops.map(({ id, x, y, width, height }) => ({ id, x, y, width, height }))
      },
      selectedWorkbookIds,
      overwriteBaseFiles
    }
  }

  const runOperation = async (mode: 'export' | 'overwrite'): Promise<void> => {
    if (operationPending.current) return
    const selectedWorkbookIds: WorkbookId[] = mode === 'export' ? DEFAULT_EXPORT_IDS : baseUpdateIds
    if (selectedWorkbookIds.length === 0) {
      setError(mode === 'export' ? '请至少选择一个要导出的表格。' : '请至少选择一个要覆盖的基础表。')
      return
    }
    if (mode === 'overwrite') {
      const labels = selectedWorkbookIds.map((id) => workspace.workbooks.find((item) => item.id === id)?.name ?? id).join('、')
      const confirmed = window.confirm(`确认覆盖：${labels}？\n程序会先自动备份，完成后可在“基础资料”中回滚。`)
      if (!confirmed) return
    }

    try {
      operationPending.current = true
      setBusyMode(mode)
      setError(null)
      setResult(null)
      setProcessedFiles([])
      // Paint the busy indicator before preparing the IPC payload.
      await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
      const response = await desktopApi.tasks.exportGenerationWorkbook(generationRequest(selectedWorkbookIds, mode === 'overwrite'))
      if (response.canceled) {
        setError(mode === 'export' ? '已取消选择导出目录，没有生成任何文件。' : '基础资料覆盖已取消。')
        return
      }

      if (mode === 'overwrite') {
        const overwritten = response.overwritten ?? []
        if (overwritten.length !== selectedWorkbookIds.length) {
          throw new Error(`基础资料覆盖未完整完成：应覆盖 ${selectedWorkbookIds.length} 份，实际覆盖 ${overwritten.length} 份。`)
        }
        await onDataChanged()
        setResult(`基础资料覆盖完成，已生成 1 组时间线记录，组内包含 ${overwritten.length} 张可独立回滚的基础表。`)
        setProcessedFiles(overwritten.map((item) => `${item.label}（已覆盖）`))
        return
      }

      const exported = response.files ?? []
      if (exported.length !== selectedWorkbookIds.length) {
        throw new Error(`文件导出未完整完成：应导出 ${selectedWorkbookIds.length} 份，实际导出 ${exported.length} 份。`)
      }
      setResult(`文件导出完成：${response.outputPath ?? ''}`)
      setProcessedFiles(exported.map((item) => item.fileName))
    } catch (reason) {
      setError(reason instanceof Error
        ? reason.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
        : mode === 'export' ? '导出失败' : '覆盖失败')
    } finally {
      operationPending.current = false
      setBusyMode(null)
    }
  }

  const toggleBaseUpdate = (id: BaseWorkbookId): void => {
    setBaseUpdateIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  }

  const publishWorkbook = async (): Promise<void> => {
    if (operationPending.current) return
    try {
      operationPending.current = true
      setBusyMode('publish'); setError(null); setResult(null); setProcessedFiles([])
      await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
      const response = await desktopApi.tasks.publishGenerationWorkbook({
        generation: generationRequest(DEFAULT_EXPORT_IDS, false),
        sourceWorkflow
      })
      setPublishedRecord({ id: response.item.id, revision: response.item.revision })
      setResult(response.duplicate ? '中央工作簿已经存在，已连接到原记录。' : '共享工作簿已建立，双方现在编辑同一份中央文件。')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '') : '建立共享工作簿失败')
    } finally {
      operationPending.current = false
      setBusyMode(null)
    }
  }

  const openOnlineWorkbook = async (): Promise<void> => {
    if (!publishedRecord || operationPending.current) return
    try {
      operationPending.current = true
      setBusyMode('open'); setError(null)
      await desktopApi.collaboration.openOnlineWorkbook({ workItemId: publishedRecord.id })
      setResult('已打开 WPS 在线工作簿；双方从“工作簿记录”进入时编辑的是同一份中央文件。')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '') : '打开 WPS 在线工作簿失败')
    } finally {
      operationPending.current = false
      setBusyMode(null)
    }
  }

  return <div className="export-workspace">
    <section className="export-card shared-workbook-export">
      <div className="export-file-icon update">共享</div>
      <div><span className="eyebrow">进入协作</span><h4>建立共享工作簿</h4><p>软件在后台生成并上传新建产品表，不需要先导出本地文件。建立后双方编辑同一份中央工作簿。</p><div className="base-update-operation-name"><span>中央工作簿</span><strong>{workspace.title}.xlsx</strong></div>{publishedRecord && <small>共享记录 {publishedRecord.id.slice(0, 8)} · 修订 {publishedRecord.revision}</small>}</div>
      <div className="shared-workbook-actions">
        <button className="primary-button" disabled={!ready || busyMode !== null || Boolean(publishedRecord)} onClick={() => void publishWorkbook()}>{busyMode === 'publish' ? '正在建立并上传…' : publishedRecord ? '共享工作簿已建立' : '建立共享工作簿'}</button>
        {publishedRecord && <button className="secondary-button" disabled={busyMode !== null} onClick={() => void openOnlineWorkbook()}>{busyMode === 'open' ? '正在打开…' : '打开 WPS 在线编辑'}</button>}
      </div>
    </section>

    <section className="export-card primary-export local-copy-export">
      <div className="export-file-icon">副本</div>
      <div>
        <span className="eyebrow">可选操作</span>
        <h4>导出本地副本</h4>
        <p>仅用于离线备份或发送。本地副本与中央工作簿相互独立，后续修改不会自动同步。</p>
      </div>
      <button className="secondary-button" disabled={!ready || busyMode !== null} onClick={() => void runOperation('export')}>
        {busyMode === 'export' ? '正在导出…' : '导出本地副本'}
      </button>
    </section>

    <section className="export-card base-update-export">
      <div className="export-file-icon update">覆盖</div>
      <div>
        <span className="eyebrow">更新基础资料</span>
        <h4>覆盖当前业务基础表</h4>
        <p>不弹出导出目录；直接执行“自动备份 → 覆盖原表 → 写入历史 → 刷新预览”。</p>
        <div className="base-update-operation-name"><span>本次时间线名称</span><strong>{workspace.title}.xlsx</strong></div>
        <div className="export-selection-list base-update-selection">
          <label>
            <input type="checkbox" checked={baseUpdateIds.includes('barcode-reference')} onChange={() => toggleBaseUpdate('barcode-reference')} />
            <span><strong>A 条码参考</strong><small>写回最新系列与已使用编码</small></span>
          </label>
          <label>
            <input type="checkbox" checked={baseUpdateIds.includes('domestic-naming')} onChange={() => toggleBaseUpdate('domestic-naming')} />
            <span><strong>国内命名表</strong><small>写回本次图片和图案名称</small></span>
          </label>
        </div>
      </div>
      <button className="danger-action-button" disabled={!ready || busyMode !== null || baseUpdateIds.length === 0} onClick={() => void runOperation('overwrite')}>
        {busyMode === 'overwrite' ? '正在覆盖…' : '备份并覆盖基础表'}
      </button>
    </section>

    {result && <div className="alert success">{result}{processedFiles.length > 0 ? `（${processedFiles.join('、')}）` : ''}</div>}
    {error && <div className="alert warning">{error}</div>}
  </div>
}
