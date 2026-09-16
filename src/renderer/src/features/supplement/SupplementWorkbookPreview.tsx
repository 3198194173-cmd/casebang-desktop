import { useMemo, useState } from 'react'
import type { SupplementResult, SupplementVariantOverride } from '@shared/supplement-contracts'
import { supplementLayout, supplementWidths, supplementHeaders } from '@shared/supplement-layout'
import { priceGroup } from '@shared/supplement-rules'
export function SupplementWorkbookPreview({ result, variants }: { result: SupplementResult; variants: SupplementVariantOverride[] }): React.JSX.Element {
  const sheets = useMemo(() => [...supplementLayout({ ...result, rows: result.rows.map(r => {
    if (r.status !== 'matched') return r
    const v = variants.find(v => priceGroup(v.variant) === priceGroup(r.variant))
    const values = [...r.values]
    if (v?.domesticPrice?.trim()) values[4] = v.domesticPrice.trim()
    if (v?.overseasPrice?.trim()) values[5] = `US$${v.overseasPrice.trim()}`
    return { ...r, values }
  }) })], [result, variants])
  const [tab, setTab] = useState(0)
  const [selection, setSelection] = useState({ row: 0, col: 0 })
  const [top, setTop] = useState(0)
  const sheet = sheets[tab] ?? sheets[0]
  if (!sheet) return <section className="panel">没有可预览的数据。</section>
  const rows = sheet[1]; const start = Math.max(0, Math.floor(top / 28) - 8); const end = Math.min(rows.length, start + 50)
  return <section className="embedded-workbook expanded-workbook supplement-excel">
    <header className="embedded-workbook-heading"><div><h4>导出工作簿预览 · {sheet[0]}</h4><p>与导出共用列顺序、分组及空行。未匹配行保留原名称，价格留空；J–L列标明状态、来源和原因。</p></div></header>
    <div className="spreadsheet-formula-bar"><strong>{String.fromCharCode(65 + selection.col)}{selection.row + 1}</strong><span>fx</span><input readOnly value={rows[selection.row]?.[selection.col] ?? ''} /></div>
    <div className="spreadsheet-scroll" key={sheet[0]} onScroll={e => setTop(e.currentTarget.scrollTop)} style={{ height: 560 }}><table className="spreadsheet-grid source-shaped-grid">
      <colgroup><col style={{ width: 46 }}/>{supplementWidths.map((w, i) => <col key={i} style={{ width: w * 7 + 5 }}/>)}</colgroup>
      <thead><tr><th/>{supplementHeaders.map((_, i) => <th key={i}>{String.fromCharCode(65 + i)}</th>)}</tr></thead>
      <tbody>{start > 0 && <tr style={{ height: start * 28 }}><td colSpan={13}/></tr>}{rows.slice(start, end).map((row, offset) => { const r = start + offset; const pending = row[9] === '未匹配' || row[9] === '待确认'; return <tr key={r} style={{ height: 28 }}><th>{r + 1}</th>{supplementHeaders.map((_, c) => <td key={c} className={selection.row === r && selection.col === c ? 'selected' : ''} style={{ backgroundColor: pending ? '#fff4d6' : r === 0 ? '#f0f1f3' : undefined, fontWeight: r === 0 ? 600 : undefined }} onClick={() => setSelection({ row: r, col: c })} title={row[c] ?? ''}><div>{row[c] ?? ''}</div></td>)}</tr> })}{end < rows.length && <tr style={{ height: (rows.length - end) * 28 }}><td colSpan={13}/></tr>}</tbody>
    </table></div>
    <footer className="sheet-tabs"><span>☰</span>{sheets.map(([name], i) => <button className={tab === i ? 'active' : ''} key={name} onClick={() => { setTab(i); setTop(0); setSelection({ row: 0, col: 0 }) }}>{i + 1}-{name}</button>)}</footer>
  </section>
}
