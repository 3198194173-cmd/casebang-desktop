import type { PreviewSheet } from '@shared/generation-contracts'

export function qualityFocus(sheet: PreviewSheet): { row: number; column: number } {
  const recent = sheet.id === 'used-codes' || sheet.name.includes('已使用编码')
  const order = Array.from({ length: sheet.rows.length }, (_, i) => recent ? sheet.rows.length - 1 - i : i)
  for (const row of order) {
    const column = sheet.rows[row]!.findIndex(cell => cell && (cell.changed || cell.writeOnly))
    if (column >= 0) return { row, column }
  }
  if (recent) for (const row of order) {
    const column = sheet.rows[row]!.findIndex(cell => cell && Boolean(cell.value?.trim() || cell.formula || cell.cropId))
    if (column >= 0) return { row, column }
  }
  return { row: 0, column: 0 }
}
