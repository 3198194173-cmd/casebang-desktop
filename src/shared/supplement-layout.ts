import type { SupplementResult } from './supplement-contracts'
export const supplementWidths = [14, 20, 24, 110, 18, 18, 20, 24, 80, 16, 28, 65]
export const supplementHeaders = ['品类', '69码', '物料编码', '物料名称', '建议零售价', '海外零售价', '备注', '联名IP', '中文名称', '匹配状态', '输入来源', '未匹配原因']
export function supplementLayout(result: SupplementResult): Map<string, string[][]> {
  const sheets = new Map<string, string[][]>()
  for (const batch of new Set(result.rows.map(r => r.batch))) {
    const rows = [supplementHeaders]
    for (const series of new Set(result.rows.filter(r => r.batch === batch).map(r => r.series))) {
      if (rows.length > 1) rows.push([])
      const designs = new Map<string, typeof result.rows>()
      for (const r of result.rows.filter(r => r.batch === batch && r.series === series)) {
        const id = r.original.replace(r.model, '').replace(r.variant || /$^/, '')
        if (!designs.has(id)) designs.set(id, [])
        designs.get(id)!.push(r)
      }
      for (const group of designs.values()) for (const r of group) {
        const values = r.status === 'matched' ? [...r.values] : ['', '', '', r.original, '', '', '', '', '']
        rows.push([...values, r.status === 'matched' ? '已匹配' : r.status === 'missing' ? '未匹配' : '待确认', r.source, r.status === 'matched' ? '' : r.reason])
      }
    }
    sheets.set(batch, rows)
  }
  return sheets
}
