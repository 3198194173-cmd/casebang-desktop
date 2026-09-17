import { useEffect, useRef, useState } from 'react'
import type { GenerationWorkspaceData } from '@shared/generation-contracts'
import type { AppSnapshot } from '@shared/contracts'
import type { ImageAnalysisResult } from '@shared/image-contracts'
import type { LifecycleSource } from '@shared/lifecycle-contracts'
import { desktopApi } from '../../app/desktop-api'

type WorkbookId = GenerationWorkspaceData['workbooks'][number]['id']
type BaseWorkbookId = Exclude<WorkbookId, 'generated-product'>

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
  const [busyMode, setBusyMode] = useState<'export' | 'overwrite' | 'publish' | null>(null)
  const operationPending = useRef(false)
  const [result, setResult] = useState<string | null>(null)
  const [processedFiles, setProcessedFiles] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [exportIds, setExportIds] = useState<WorkbookId[]>(DEFAULT_EXPORT_IDS)
  const [baseUpdateIds, setBaseUpdateIds] = useState<BaseWorkbookId[]>(() => workspace.workbooks.some((item) => item.id === 'product-image-mapping') ? [...DEFAULT_BASE_IDS, 'product-image-mapping'] : DEFAULT_BASE_IDS)
  const [requireQualityCheck, setRequireQualityCheck] = useState(true)
  const [sharedFile, setSharedFile] = useState<{ path: string; fileName: string } | null>(null)
  const [publishedRecord, setPublishedRecord] = useState<{ id: string; revision: number } | null>(null)
  const ready = !requireQualityCheck || workspace.checks.every((check) => check.passed)

  useEffect(() => {
    void desktopApi.settings.get().then((value) => setRequireQualityCheck(value.requireQualityCheck))
  }, [])

  const runOperation = async (mode: 'export' | 'overwrite'): Promise<void> => {
    if (operationPending.current) return
    const selectedWorkbookIds: WorkbookId[] = mode === 'export' ? exportIds : baseUpdateIds
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
      if (mode === 'export') { setSharedFile(null); setPublishedRecord(null) }
      // Paint the busy indicator before preparing the IPC payload.
      await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
      const namingFormula = baseFiles.namingFormula.path
      const barcodeReference = baseFiles.barcodeReference.path
      const domesticNaming = baseFiles.domesticNaming.path
      if (!namingFormula || !barcodeReference || !domesticNaming) throw new Error('三个基础表路径不完整，无法处理。')
      const response = await desktopApi.tasks.exportGenerationWorkbook({
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
        sourcePaths: { namingFormula, barcodeReference, domesticNaming, productImageMapping: baseFiles.productImageMapping?.path ?? undefined },
        imageSource: {
          path: analysis.sourceImagePath,
          crops: analysis.crops.map(({ id, x, y, width, height }) => ({ id, x, y, width, height }))
        },
        selectedWorkbookIds,
        overwriteBaseFiles: mode === 'overwrite'
      })
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
      const generated = exported.find(item => item.label === '新建产品表')
      if (generated) { setSharedFile({ path: generated.path, fileName: generated.fileName }); setPublishedRecord(null) }
    } catch (reason) {
      setError(reason instanceof Error
        ? reason.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
        : mode === 'export' ? '导出失败' : '覆盖失败')
    } finally {
      operationPending.current = false
      setBusyMode(null)
    }
  }

  const toggleExport = (id: WorkbookId): void => {
    setExportIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  }
  const toggleBaseUpdate = (id: BaseWorkbookId): void => {
    setBaseUpdateIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  }

  const publishWorkbook = async (): Promise<void> => {
    if (!sharedFile || operationPending.current) return
    try {
      operationPending.current = true
      setBusyMode('publish'); setError(null); setResult(null)
      const response = await desktopApi.collaboration.publishWorkbook({ path: sharedFile.path, title: sharedFile.fileName, sourceWorkflow })
      setPublishedRecord({ id: response.item.id, revision: response.item.revision })
      setResult(response.duplicate ? '该工作簿已在共享流程中，未重复建立记录。' : '已导入共享工作簿，阶段为“已建表，待下游加工”。')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '') : '导入共享工作簿失败')
    } finally {
      operationPending.current = false
      setBusyMode(null)
    }
  }

  return <div className="export-workspace">
    <section className="export-card primary-export">
      <div className="export-file-icon">导出</div>
      <div>
        <span className="eyebrow">导出副本</span>
        <h4>另存新建产品表</h4>
        <p>A 条码参考和国内命名表通过下方覆盖流程原位更新，不再要求导出副本。</p>
        <div className="export-selection-list">
          {workspace.workbooks.filter((item) => item.id === 'generated-product').map((item) => <label key={item.id}>
            <input type="checkbox" checked={exportIds.includes(item.id)} onChange={() => toggleExport(item.id)} />
            <span><strong>{item.name}</strong><small>包含图片表和条码表</small></span>
          </label>)}
        </div>
      </div>
      <button className="primary-button" disabled={!ready || busyMode !== null || exportIds.length === 0} onClick={() => void runOperation('export')}>
        {busyMode === 'export' ? '正在导出…' : '导出所选文件'}
      </button>
    </section>

    <section className="export-card shared-workbook-export">
      <div className="export-file-icon update">共享</div>
      <div><span className="eyebrow">进入流程</span><h4>导入共享工作簿</h4><p>将已质检的新建表保存到中央服务，双方共用一条工作簿记录。</p><div className="base-update-operation-name"><span>当前文件</span><strong>{sharedFile?.fileName ?? '请先在上方导出新建产品表'}</strong></div>{publishedRecord && <small>共享记录 {publishedRecord.id.slice(0, 8)} · 修订 {publishedRecord.revision}</small>}</div>
      <button className="primary-button" disabled={!ready || !sharedFile || busyMode !== null || Boolean(publishedRecord)} onClick={() => void publishWorkbook()}>{busyMode === 'publish' ? '正在导入…' : publishedRecord ? '已进入共享流程' : '导入共享工作簿'}</button>
    </section>

    <section className="export-card base-update-export">
      <div className="export-file-icon update">覆盖</div>
      <div>
        <span className="eyebrow">更新基础资料</span>
        <h4>覆盖当前业务基础表</h4>
        <p>不弹出导出目录；直接执行“自动备份 → 覆盖原表 → 写入历史 → 刷新预览”。</p>
        <div className="base-update-operation-name"><span>本次时间线名称</span><strong>{workspace.title}.xlsx</strong></div>
        <div className="export-selection-list base-update-selection">
          {workspace.workbooks.some((item) => item.id === 'product-image-mapping') && <label>
            <input type="checkbox" checked={baseUpdateIds.includes('product-image-mapping')} onChange={() => toggleBaseUpdate('product-image-mapping')} />
            <span><strong>K3 名称对应产品图片</strong><small>按产品类别追加图片、物料名称和中文对应</small></span>
          </label>}
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
