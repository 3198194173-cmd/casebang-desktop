import type { LifecycleDraft, LifecycleRow, LifecycleRowPreview, MaterialIdentity } from './lifecycle-contracts'
import { findMaterialModel, MATERIAL_MODELS } from './material-model-dictionary'

const normalize = (value: string): string => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase()
export function parseMaterialIdentity(name: string, itemClass: string): MaterialIdentity {
  const normalized = name.normalize('NFKC').trim()
  const seriesMatch = /#([A-Z0-9]{1,8})系列[-－]?/i.exec(normalized)
  const category = ['磁吸支架背盖', '磁吸气囊支架', '磁吸背盖', '出镜壳', '出片壳', '出彩壳'].find(value => normalized.includes(value)) ?? ''
  const domain = itemClass === '单个片材' && category === '磁吸背盖' ? 'BG' : itemClass === '一体壳' && ['出镜壳', '出片壳', '出彩壳'].includes(category) ? 'CA' : null
  const variantTags = [...normalized.matchAll(/\(([^()]*)\)\s*/g)].map(match => match[1]!)
  const frame = variantTags.includes('银框') ? 'silver' : 'normal'
  const variant = variantTags.filter(tag => tag !== '银框').join('|')
  const withoutTags = normalized.replace(/\([^()]*\)/g, '').trim()
  const modelNames = MATERIAL_MODELS.flatMap(model => [model.name, ...model.aliases, ...(model.brand === 'HW' && !model.name.startsWith('HW ') ? [`HW ${model.name}`] : [])]).sort((a, b) => b.length - a.length)
  // Match the whole suffix with a boundary; Pro must never steal Pro Max.
  const modelName = modelNames.find(candidate => withoutTags.toUpperCase().endsWith(candidate.toUpperCase()) && /\s/.test(withoutTags[withoutTags.length - candidate.length - 1] ?? '')) ?? ''
  const model = domain ? findMaterialModel(modelName) : null
  const tail = seriesMatch ? normalized.slice(seriesMatch.index + seriesMatch[0].length).trim() : ''
  const productMatch = /\b([A-Z]{2,6}\d{5})\b/i.exec(tail)
  let patternName = productMatch ? tail.slice(0, productMatch.index).trim() : ''
  if (!productMatch && modelName) {
    const cleanTail = tail.replace(/\([^()]*\)/g, '').trim()
    patternName = cleanTail.slice(0, -modelName.length).trim()
  }
  return { category, domain, series: seriesMatch?.[1]?.toUpperCase() ?? '', patternName, productCode: productMatch?.[1]?.toUpperCase() ?? '',
    modelName, brand: model?.brand ?? null, modelCode: model?.code ?? null, frame, variant }
}

/** A whole two-character allocation; never infer a universal silver suffix. */
export function patternVariantKey(identity: MaterialIdentity): string {
  return JSON.stringify([identity.domain, identity.category, identity.series, identity.productCode || normalize(identity.patternName), identity.frame, identity.variant])
}
export function parsePhoneMaterialCode(code: string): { domain: string; brand: string; series: string; patternVariant: string; modelCode: string } | null {
  const match = /^C\.K\.(BG|CA)\.(AP|SA|HW)\.([A-Z0-9]{1,8})\.([A-Z0-9]{2})(\d{2})$/.exec(code)
  return match ? { domain: match[1]!, brand: match[2]!, series: match[3]!, patternVariant: match[4]!, modelCode: match[5]! } : null
}
export function internalBarcodeCandidate(month: string, sequence: number): string {
  if (!/^\d{4}(0[1-9]|1[0-2])$/.test(month) || !Number.isSafeInteger(sequence) || sequence < 1 || sequence > 9_999_999) throw new Error('年月或流水范围无效')
  return month + String(sequence).padStart(7, '0')
}
/** Checksum only: passing this does not establish GS1 registration or ownership. */
export function hasValidGtin13Checksum(value: string): boolean {
  if (!/^\d{13}$/.test(value)) return false
  const sum = [...value.slice(0, 12)].reduce((n, char, index) => n + Number(char) * (index % 2 ? 3 : 1), 0)
  return (10 - sum % 10) % 10 === Number(value[12])
}
export function previewMaterialCodes(draft: Pick<LifecycleDraft, 'rows' | 'patternVariants'>): LifecycleRowPreview[] {
  const history = new Map<string, Set<string>>()
  for (const row of draft.rows) {
    const code = parsePhoneMaterialCode(row.materialCode)
    const identity = row.identity
    if (!code || row.issues.length || code.domain !== identity.domain || code.brand !== identity.brand || code.series !== identity.series || code.modelCode !== identity.modelCode) continue
    const key = patternVariantKey(identity)
    const values = history.get(key) ?? new Set<string>()
    values.add(code.patternVariant); history.set(key, values)
  }
  const results = draft.rows.map((row): LifecycleRowPreview => {
    const identity = row.identity
    const issues = [...row.issues]
    if (!identity.domain) issues.push('该产品类别规则尚未配置；保留原行和已有编码')
    if (!identity.series) issues.push('缺少系列代码')
    if (!identity.patternName && !identity.productCode) issues.push('图案身份无法确定')
    if (!identity.modelCode) issues.push('机型未匹配已确认字典，请核实完整名称')
    const key = patternVariantKey(identity)
    const found = history.get(key)
    if (found && found.size > 1) issues.push('同图案／框型存在多个历史标识，不能自动选择')
    const historicalVariant = found?.size === 1 ? [...found][0] : undefined
    const manual = draft.patternVariants[key]
    if (manual && historicalVariant && manual !== historicalVariant) issues.push('手填标识与本文件已有编码冲突')
    const variant = historicalVariant ?? manual
    if (row.materialCode) {
      const code = parsePhoneMaterialCode(row.materialCode)
      if (identity.domain && (!code || code.domain !== identity.domain || code.brand !== identity.brand || code.series !== identity.series || code.modelCode !== identity.modelCode)) issues.push('已有物料编码与当前已确认规则或机型不一致，不自动覆盖')
      return { rowId: row.id, candidate: row.materialCode, status: issues.length ? 'blocked' : 'existing', issues }
    }
    if (!variant) issues.push(identity.frame === 'silver' ? '银框缺少已确认的两位款式标识，不套用 AC' : '缺少两位图案标识；须核对总表占用后确认')
    if (variant && !/^[A-Z0-9]{2}$/.test(variant)) issues.push('图案／款式标识必须是两位大写字母或数字')
    return { rowId: row.id, candidate: issues.length ? null : `C.K.${identity.domain}.${identity.brand}.${identity.series}.${variant}${identity.modelCode}`,
      status: issues.length ? 'blocked' : 'candidate', issues }
  })
  const owners = new Map<string, LifecycleRowPreview[]>()
  for (const result of results) if (result.candidate) {
    const values = owners.get(result.candidate) ?? []; values.push(result); owners.set(result.candidate, values)
  }
  // Duplicated rows also need a human decision; never silently drop them.
  for (const values of owners.values()) if (values.length > 1) for (const result of values) {
    result.status = 'blocked'; result.issues.push('本工作簿中物料编码重复，请核实重复行或标识冲突')
  }
  return results
}
export function rowIdentityIssues(row: Pick<LifecycleRow, 'materialName' | 'barcode'>): string[] {
  const issues: string[] = []
  if (!row.materialName.trim()) issues.push('待补充资料：物料名称缺失')
  if (row.barcode && !/^\d{13}$/.test(row.barcode)) issues.push('已有 69 码不是 13 位数字，原值已保留')
  return issues
}
