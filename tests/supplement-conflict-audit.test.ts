import { it } from 'vitest'
import { readSheets, splitModel } from '../src/main/modules/supplement/supplement-engine'
const norm = (v: string): string => v.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
function key(value: string): string | null {
  const p = splitModel(value); if (!p) return null
  const code = p.base.match(/\b[A-Z]{2,5}\d{5,8}\b/i)?.[0]
  const id = code ? norm(p.base.split('-')[0]!.replace(/^CASEBANG\s*/i, '')) + ':' + code.toUpperCase() : norm(p.base.replace(/^CASEBANG\s*/i, '').replace(/^(?:联名)?(?:防摔保护壳|手机壳|保护壳)?潮流款(?=-)/, '出镜壳'))
  return id + ':' + norm(p.variant)
}
it.runIf(process.env.CASEBANG_SUPPLEMENT_REAL === '1')('audit reference differences read-only', async () => {
  const root = 'C:/Users/Administrator/Desktop/CASEBANG 表格编码自动化/表格文件/'
  const index = new Map<string, { sheet: string; row: number; values: Record<string, string> }[]>()
  for (const sheet of await readSheets(root + 'CASEBANG 物料名称汇总-260908（含建议零售价）.xlsx')) {
    const rows = new Map<number, Record<string, string>>()
    for (const c of sheet.cells) { const r = Number(c.ref.match(/\d+$/)![0]); if (!rows.has(r)) rows.set(r, {}); rows.get(r)![c.ref.replace(/\d+$/, '')] = c.value }
    for (const [row, values] of rows) { const k = key(values.D ?? ''); if (!k) continue; if (!index.has(k)) index.set(k, []); index.get(k)!.push({ sheet: sheet.name, row, values }) }
  }
  for (const sheet of await readSheets(root + '补Iphone18折叠屏系列-260826(1).xlsx')) {
    for (const cell of sheet.cells) {
      const k = key(cell.value); if (!k) continue
      const candidates = index.get(k) ?? []
      const diffs = ['A', 'E', 'F', 'G', 'H', 'I'].flatMap(col => {
        const groups = new Map<string, string[]>()
        for (const c of candidates) { const value = c.values[col] ?? ''; if (!groups.has(value)) groups.set(value, []); groups.get(value)!.push(`${c.sheet}!${col}${c.row}`) }
        return groups.size > 1 ? [{ col, groups: [...groups].map(([value, refs]) => ({ value, count: refs.length, refs: refs.slice(0, 3) })) }] : []
      })
      if (diffs.length) console.log(JSON.stringify({ source: `${sheet.name}!${cell.ref}`, name: cell.value, diffs }))
      if (['R3', 'J7'].includes(cell.ref)) console.log('EXAMPLE', JSON.stringify(candidates.filter(c => [39276, 39352, 9182, 9226, 9258].includes(c.row))))
    }
  }
}, 60000)
