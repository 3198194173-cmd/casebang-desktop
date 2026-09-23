import type { LifecycleDraft, LifecycleRow, LifecycleRowPreview, LifecycleSource, MaterialIdentity, MaterialPatternPlan } from './lifecycle-contracts'
import { findMaterialModel, materialCodeBrand, materialModelNames, MATERIAL_MODELS, type MaterialModel } from './material-model-dictionary'

const normalize = (value: string): string => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase()
export function parseMaterialIdentity(name: string, itemClass: string, modelDictionary: readonly MaterialModel[] = MATERIAL_MODELS): MaterialIdentity {
  const normalized = name.normalize('NFKC').trim()
  const seriesMatch = /#([A-Z0-9]{1,8})系列[-－]?/i.exec(normalized)
  const category = ['磁吸支架背盖', '磁吸气囊支架', '磁吸背盖', '出镜壳', '出片壳', '出彩壳'].find(value => normalized.includes(value)) ?? ''
  const domain = itemClass === '单个片材' && category === '磁吸背盖' ? 'BG' : itemClass === '一体壳' && ['出镜壳', '出片壳', '出彩壳'].includes(category) ? 'CA' : null
  const variantTags = [...normalized.matchAll(/\(([^()]*)\)\s*/g)].map(match => match[1]!)
  const frame = variantTags.includes('银框') ? 'silver' : 'normal'
  const variant = variantTags.filter(tag => tag !== '银框').join('|')
  const withoutTags = normalized.replace(/\([^()]*\)/g, '').trim()
  const modelNames = modelDictionary.flatMap(materialModelNames).sort((a, b) => b.length - a.length)
  // Match the whole suffix with a boundary; Pro must never steal Pro Max.
  const modelName = modelNames.find(candidate => withoutTags.toUpperCase().endsWith(candidate.toUpperCase()) && /\s/.test(withoutTags[withoutTags.length - candidate.length - 1] ?? '')) ?? ''
  const model = domain ? findMaterialModel(modelName, modelDictionary) : null
  const tail = seriesMatch ? normalized.slice(seriesMatch.index + seriesMatch[0].length).trim() : ''
  const productMatch = /\b([A-Z]{2,6}\d{5})\b/i.exec(tail)
  let patternName = productMatch ? tail.slice(0, productMatch.index).trim() : ''
  if (!productMatch && modelName) {
    const cleanTail = tail.replace(/\([^()]*\)/g, '').trim()
    patternName = cleanTail.slice(0, -modelName.length).trim()
  }
  return { category, domain, series: seriesMatch?.[1]?.toUpperCase() ?? '', patternName, productCode: productMatch?.[1]?.toUpperCase() ?? '',
    modelName, brand: model ? materialCodeBrand(model.brand) : null, modelCode: model?.code ?? null, frame, variant }
}

/** A whole two-character allocation; never infer a universal silver suffix. */
export function patternVariantKey(identity: MaterialIdentity): string {
  return JSON.stringify([identity.domain, identity.category, identity.series, identity.productCode || normalize(identity.patternName), identity.frame, identity.variant])
}
export function parsePhoneMaterialCode(code: string): { domain: string; brand: string; series: string; patternVariant: string; modelCode: string } | null {
  const match = /^C\.K\.(BG|CA)\.(AP|SA|HW|MI|VV|OP|IQ|1\+|GG)\.([A-Z0-9]{1,8})\.([A-Z0-9]{2})(\d{2})$/.exec(code)
  return match ? { domain: match[1]!, brand: match[2]!, series: match[3]!, patternVariant: match[4]!, modelCode: match[5]! } : null
}
export function parsePhoneMaterialCodePrefix(code: string): { domain: string; brand: string; series: string; patternVariant: string } | null {
  const match = /^C\.K\.(BG|CA)\.(AP|SA|HW|MI|VV|OP|IQ|1\+|GG)\.([A-Z0-9]{1,8})\.([A-Z0-9]{2})$/.exec(code.trim())
  return match ? { domain: match[1]!, brand: match[2]!, series: match[3]!, patternVariant: match[4]! } : null
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
export function previewMaterialCodes(draft: Pick<LifecycleDraft, 'rows' | 'patternVariants'> & { sourceWorkflow?: LifecycleSource }): LifecycleRowPreview[] {
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
      const prefix = draft.sourceWorkflow === 'new-models' ? parsePhoneMaterialCodePrefix(row.materialCode) : null
      if (prefix) {
        if (prefix.domain !== identity.domain || prefix.brand !== identity.brand || prefix.series !== identity.series) issues.push('保留的历史编码前缀与当前物料名称不一致')
        if (variant && prefix.patternVariant !== variant) issues.push('保留的历史编码前缀与图案标识识别结果不一致')
        return { rowId: row.id, candidate: issues.length ? null : `${row.materialCode.trim()}${identity.modelCode}`,
          status: issues.length ? 'blocked' : 'candidate', issues }
      }
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

const proposedVariants = (): string[] => {
  const values: string[] = []
  for (const suffix of '0123456789') for (const prefix of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') values.push(`${prefix}${suffix}`)
  return values
}

/** Resolve the automatic result first, then apply a bounded post-recognition override when the workflow allows it. */
export function planMaterialPatterns(
  rows: LifecycleRow[],
  masterRows: LifecycleRow[],
  manualVariants: Record<string, string>,
  sourceWorkflow: LifecycleSource = 'manual'
): { patternVariants: Record<string, string>; plans: MaterialPatternPlan[] } {
  const identities = new Map<string, { identity: MaterialIdentity; rows: LifecycleRow[] }>()
  for (const row of rows) {
    const key = patternVariantKey(row.identity)
    const current = identities.get(key)
    if (current) current.rows.push(row)
    else identities.set(key, { identity: row.identity, rows: [row] })
  }
  const historical = new Map<string, Set<string>>()
  const occupied = new Map<string, Map<string, Set<string>>>()
  for (const row of masterRows) {
    const code = parsePhoneMaterialCode(row.materialCode)
    if (!code || code.domain !== row.identity.domain || code.brand !== row.identity.brand || code.series !== row.identity.series || code.modelCode !== row.identity.modelCode) continue
    const namespace = JSON.stringify([code.domain, code.series])
    const key = patternVariantKey(row.identity)
    const variants = occupied.get(namespace) ?? new Map<string, Set<string>>()
    const owners = variants.get(code.patternVariant) ?? new Set<string>()
    owners.add(key); variants.set(code.patternVariant, owners); occupied.set(namespace, variants)
    const values = historical.get(key) ?? new Set<string>()
    values.add(code.patternVariant); historical.set(key, values)
  }
  const masterOccupied = new Map([...occupied].map(([namespace, variants]) => [
    namespace,
    new Map([...variants].map(([variant, owners]) => [variant, new Set(owners)]))
  ]))
  const automatic = new Map<string, { variant: string | null; source: MaterialPatternPlan['source']; issues: string[] }>()
  const orderedIdentities = [...identities].sort(([, left], [, right]) => Number(left.identity.frame === 'silver') - Number(right.identity.frame === 'silver'))
  for (const [key, value] of orderedIdentities) {
    const identity = value.identity
    const issues: string[] = []
    const history = historical.get(key)
    let variant: string | null = null
    let source: MaterialPatternPlan['source'] = 'blocked'
    if (!identity.domain || !identity.series || (!identity.patternName && !identity.productCode)) {
      issues.push('图案身份或产品类别不完整')
    } else if (sourceWorkflow === 'new-models') {
      const prefixes = new Set(value.rows.map(row => parsePhoneMaterialCodePrefix(row.materialCode)).filter(Boolean).map(prefix => JSON.stringify(prefix)))
      if (prefixes.size > 1) {
        source = 'conflict'
        issues.push('同一图案包含多个历史编码前缀，不能自动补机型码')
      } else if (prefixes.size === 1) {
        const prefix = JSON.parse([...prefixes][0]!) as { domain: string; brand: string; series: string; patternVariant: string }
        if (prefix.domain !== identity.domain || prefix.brand !== identity.brand || prefix.series !== identity.series) issues.push('历史编码前缀与物料名称不一致')
        else { variant = prefix.patternVariant; source = 'master' }
      } else if (history?.size === 1) {
        variant = [...history][0]!
        source = 'master'
      } else {
        issues.push('补机型工作簿缺少可验证的历史编码前缀')
      }
    } else if (history?.size === 1) {
      variant = [...history][0]!
      source = 'master'
    } else if (history && history.size > 1) {
      source = 'conflict'
      issues.push(`物料总表存在多个标识：${[...history].sort().join('、')}`)
    } else if (identity.frame === 'silver' && ['出镜壳', '出彩壳'].includes(identity.category)) {
      const normalKey = patternVariantKey({ ...identity, frame: 'normal' })
      const normalHistory = historical.get(normalKey)
      const normalVariant = automatic.get(normalKey)?.variant ?? (normalHistory?.size === 1 ? [...normalHistory][0]! : null)
      const paired = /^([A-D])0$/.exec(normalVariant ?? '')
      if (paired) {
        variant = `${paired[1]}C`
        source = automatic.get(normalKey)?.source === 'proposed' ? 'proposed' : 'master'
      } else issues.push('银框未找到可按 A0→AC 规则配对的普通款图案标识')
    } else if (identity.frame === 'silver') {
      issues.push('银框没有历史映射，需人工确认两位标识')
    } else {
      const namespace = JSON.stringify([identity.domain, identity.series])
      const used = occupied.get(namespace) ?? new Map<string, Set<string>>()
      variant = proposedVariants().find(candidate => !used.has(candidate)) ?? null
      if (variant) {
        used.set(variant, new Set([key])); occupied.set(namespace, used); source = 'proposed'
      } else issues.push('该系列没有可用的两位候选标识')
    }
    automatic.set(key, { variant, source, issues })
  }

  const finalOwners = new Map<string, Map<string, Set<string>>>()
  for (const [namespace, variants] of masterOccupied) {
    finalOwners.set(namespace, new Map([...variants].map(([variant, owners]) => [variant, new Set(owners)])))
  }
  const finalValues = new Map<string, string | null>()
  for (const [key, value] of orderedIdentities) {
    const detected = automatic.get(key)?.variant ?? null
    const requested = manualVariants[key]
    const finalValue = requested && sourceWorkflow !== 'new-models' ? requested : detected
    finalValues.set(key, finalValue)
    if (!finalValue || !value.identity.domain || !value.identity.series) continue
    const namespace = JSON.stringify([value.identity.domain, value.identity.series])
    const variants = finalOwners.get(namespace) ?? new Map<string, Set<string>>()
    const owners = variants.get(finalValue) ?? new Set<string>()
    owners.add(key); variants.set(finalValue, owners); finalOwners.set(namespace, variants)
  }

  const resolved: Record<string, string> = {}
  const plans: MaterialPatternPlan[] = []
  for (const [key, value] of orderedIdentities) {
    const identity = value.identity
    const detected = automatic.get(key)!
    const requested = manualVariants[key]
    const customized = Boolean(requested && requested !== detected.variant)
    const warnings: string[] = []
    const issues = requested && sourceWorkflow !== 'new-models'
      ? detected.issues.filter(issue => !issue.startsWith('银框没有历史映射') && !issue.startsWith('银框未找到可按') && !issue.startsWith('该系列没有可用') && !issue.startsWith('物料总表存在多个标识'))
      : [...detected.issues]
    let variant = finalValues.get(key) ?? null
    let source = customized ? 'manual' as const : detected.source
    if (requested && sourceWorkflow === 'new-models' && requested !== detected.variant) {
      variant = detected.variant
      source = detected.source
      issues.push('产品补机型不允许修改图案标识，只能继承历史编码前缀')
    }
    if (variant && !/^[A-Z0-9]{2}$/.test(variant)) issues.push('图案标识必须是两位大写字母或数字')
    if (customized && detected.source === 'master') warnings.push('最终标识偏离物料总表历史映射，保存时必须填写修改原因')
    if (variant && identity.domain && identity.series) {
      const owners = finalOwners.get(JSON.stringify([identity.domain, identity.series]))?.get(variant) ?? new Set<string>()
      if ([...owners].some(owner => owner !== key)) issues.push('该两位标识已被同系列其他图案占用')
    }
    if (variant && !issues.length) resolved[key] = variant
    const referenceCode = identity.domain && identity.series
      ? `C.K.${identity.domain}.AP.${identity.series}.${variant ?? '__'}53`
      : null
    plans.push({ key, patternName: identity.patternName, productCode: identity.productCode, frame: identity.frame,
      variant, detectedVariant: detected.variant, referenceCode, rowCount: value.rows.length, source, customized, issues, warnings })
  }
  return { patternVariants: resolved, plans }
}
export function rowIdentityIssues(row: Pick<LifecycleRow, 'materialName' | 'barcode'>): string[] {
  const issues: string[] = []
  if (!row.materialName.trim()) issues.push('待补充资料：物料名称缺失')
  if (row.barcode && !/^\d{13}$/.test(row.barcode)) issues.push('已有 69 码不是 13 位数字，原值已保留')
  return issues
}
