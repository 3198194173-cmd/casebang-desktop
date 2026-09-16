export interface SupplementInputCell { ref: string; value: string; original?: string; issue?: string; conflict?: boolean }
export const chineseLookupKey = (value: string): string => value.normalize('NFKC').replace(/^CASEBANG\s*/i, '').replace(/[\s‐‑–—-]+/g, '').toLowerCase()

/** Image anchors define product blocks; a caption below a full SKU is not a second product. */
export function collectSupplementInputs(cells: SupplementInputCell[], imageAddresses: string[], isSku: (value: string) => boolean, resolveChinese: (value: string) => { value?: string; issue?: string; conflict?: boolean }): SupplementInputCell[] {
  const output: SupplementInputCell[] = cells.filter(c => isSku(c.value))
  // Preserve batch headings for the existing grouping logic.
  output.push(...cells.filter(c => /^A\d+$/.test(c.ref) && /第.+批/.test(c.value)))
  const handled = new Set(output.map(c => c.ref))
  const column = (ref: string) => ref.replace(/\d/g, '')
  const row = (ref: string) => Number(ref.replace(/\D/g, ''))
  for (const address of [...new Set(imageAddresses)]) {
    if (column(address) === 'A') continue // Series overview/batch column, not a product.
    const start = row(address)
    const next = Math.min(start + 5, ...imageAddresses.filter(a => column(a) === column(address) && row(a) > start).map(row))
    const block = cells.filter(c => column(c.ref) === column(address) && row(c.ref) >= start && row(c.ref) < next)
    if (block.some(c => isSku(c.value))) { block.forEach(c => handled.add(c.ref)); continue }
    const caption = block.find(c => /[\u3400-\u9fff]/.test(c.value) && !/名字重新|重新命名|待命名|待补充|^新增$/.test(c.value))
    if (caption && !handled.has(caption.ref)) {
      handled.add(caption.ref)
      const resolved = resolveChinese(caption.value)
      output.push({ ref: caption.ref, value: resolved.value ?? caption.value, original: caption.value, issue: resolved.issue, conflict: resolved.conflict })
    } else if (!caption) {
      output.push({ ref: address, value: '待补充资料', original: '图片缺少可检索的物料名称', issue: '待补充资料：该图片下方没有独立物料名称，请补充中文名称或完整物料名称。' })
    }
  }
  // Also handle explicit Chinese material names in text-only lists.
  for (const cell of cells) if (!handled.has(cell.ref) && /(?:出镜壳|出片壳|磁吸背盖|奇趣壳).*系列/.test(cell.value)) {
    const resolved = resolveChinese(cell.value)
    output.push({ ...cell, original: cell.value, value: resolved.value ?? cell.value, issue: resolved.issue, conflict: resolved.conflict })
  }
  return output.sort((a, b) => row(a.ref) - row(b.ref) || column(a.ref).length - column(b.ref).length || column(a.ref).localeCompare(column(b.ref)))
}
