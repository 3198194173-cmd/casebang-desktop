import { useEffect, useState } from 'react'
import { desktopApi } from '../../app/desktop-api'
import { findSeriesTargets, nextOccupiedColumn, type ExistingSeriesSelection, type ExistingSeriesTarget } from './existing-series'

// Saved drafts identify the series, not its current append coordinates.
export function useExistingSeriesLayout(enabled: boolean, step: number, selection: ExistingSeriesSelection | null, target: ExistingSeriesTarget | null) {
  const key = enabled && selection && target ? JSON.stringify([step, selection.code, selection.englishName, selection.referenceSheet, selection.referenceRow, target.sheet, target.nameRow]) : ''
  const [state, setState] = useState<{ key: string; selection?: ExistingSeriesSelection; target?: ExistingSeriesTarget; error?: string }>({ key: '' })
  useEffect(() => {
    if (!key || !selection || !target) return
    let active = true
    void Promise.all([
      desktopApi.baseFiles.preview({ kind: 'barcodeReference', sheetName: selection.referenceSheet, imageEndRow: 0 }),
      desktopApi.baseFiles.preview({ kind: 'domesticNaming', sheetName: target.sheet, imageEndRow: 0 })
    ]).then(([reference, domestic]) => {
      if (!active) return
      const row = reference.rows.find(r => r.rowNumber === selection.referenceRow)
      if (reference.activeSheetName !== selection.referenceSheet || row?.cells.find(c => c.address === `A${selection.referenceRow}`)?.value.trim() !== selection.code || row?.cells.find(c => c.address === `B${selection.referenceRow}`)?.value.trim() !== selection.englishName.trim()) throw new Error('原系列位置已变化，请回到步骤 2 重新选择系列。')
      const freshTarget = findSeriesTargets(domestic, selection).find(t => t.sheet === target.sheet && t.nameRow === target.nameRow)
      if (!freshTarget) throw new Error('国内命名表系列位置已变化，请回到步骤 2 重新确认。')
      setState({ key, selection: { ...selection, referenceAppendColumn: nextOccupiedColumn(reference, [selection.referenceRow]) }, target: freshTarget })
    }).catch(error => { if (active) setState({ key, error: String(error) }) })
    return () => { active = false }
  }, [key])
  return state.key === key ? state : { key }
}
