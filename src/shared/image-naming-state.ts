import type { CropBox, SuggestedCropNames } from './image-contracts'

interface NamingAssignment {
  target: CropBox
  unitKey: string
  categories: Set<string>
  candidates: SuggestedCropNames['candidates']
  finalPatternGroupId: string | null
  canonicalCandidates: SuggestedCropNames['candidates']
}

/**
 * Applies one batch naming response to the current crop state.
 *
 * A repeated name can be intentional when the same visual pattern is carried by
 * different product categories. Those targets become one naming unit. Targets
 * from the same category stay separate so an accidental model duplicate remains
 * visible to the normal duplicate-name validation.
 */
export function applyBatchNameSuggestions(
  crops: readonly CropBox[],
  targets: readonly CropBox[],
  items: readonly SuggestedCropNames[]
): CropBox[] {
  const itemByCropId = new Map<string, SuggestedCropNames>()
  for (const item of items) {
    if (!itemByCropId.has(item.cropId) && item.candidates[0]) itemByCropId.set(item.cropId, item)
  }

  const assignments: NamingAssignment[] = []
  for (const target of targets) {
    const candidates = itemByCropId.get(target.id)?.candidates
    const first = candidates?.[0]
    if (!candidates || !first || !normalizeEnglishNameKey(first.englishName)) continue
    const members = crops.filter((crop) => belongsToNamingTarget(crop, target))
    assignments.push({
      target,
      unitKey: namingUnitKey(target),
      categories: new Set(members.map((crop) => crop.productCategory.trim()).filter(Boolean)),
      candidates,
      finalPatternGroupId: target.patternGroupId,
      canonicalCandidates: candidates
    })
  }

  const assignmentsByName = new Map<string, NamingAssignment[]>()
  for (const assignment of assignments) {
    const englishName = assignment.candidates[0]?.englishName ?? ''
    const key = normalizeEnglishNameKey(englishName)
    const sameName = assignmentsByName.get(key) ?? []
    sameName.push(assignment)
    assignmentsByName.set(key, sameName)
  }

  const occupiedGroupIds = new Set(crops.flatMap((crop) => crop.patternGroupId ? [crop.patternGroupId] : []))
  for (const [nameKey, sameNameAssignments] of assignmentsByName) {
    for (const crossCategoryGroup of partitionByDistinctCategories(sameNameAssignments)) {
      if (crossCategoryGroup.length < 2) continue
      const canonical = crossCategoryGroup[0]
      if (!canonical) continue
      const existingGroupId = crossCategoryGroup.find((assignment) => assignment.target.patternGroupId)?.target.patternGroupId
      const groupId = existingGroupId ?? createAvailableAutoGroupId(
        nameKey,
        crossCategoryGroup.map((assignment) => assignment.unitKey),
        occupiedGroupIds
      )
      occupiedGroupIds.add(groupId)
      for (const assignment of crossCategoryGroup) {
        assignment.finalPatternGroupId = groupId
        assignment.canonicalCandidates = canonical.candidates
      }
    }
  }

  return crops.map((crop) => {
    const assignment = assignments.find((candidate) => belongsToNamingTarget(crop, candidate.target))
    const first = assignment?.canonicalCandidates[0]
    if (!assignment || !first) return crop
    return {
      ...crop,
      patternGroupId: assignment.finalPatternGroupId,
      nameCandidates: assignment.canonicalCandidates,
      patternNameEn: first.englishName,
      patternNameZh: first.chineseName
    }
  })
}

/** Builds a normalized, stable forbidden-name list while preserving display text. */
export function mergeForbiddenEnglishNames(...sources: ReadonlyArray<readonly string[]>): string[] {
  const names = new Map<string, string>()
  for (const source of sources) {
    for (const rawName of source) {
      const name = rawName.normalize('NFKC').trim().replace(/\s+/g, ' ')
      const key = normalizeEnglishNameKey(name)
      if (key && !names.has(key)) names.set(key, name)
    }
  }
  return [...names.values()]
}

export function normalizeEnglishNameKey(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, ' ').trim()
}

function namingUnitKey(crop: CropBox): string {
  return crop.patternGroupId ?? crop.id
}

function belongsToNamingTarget(crop: CropBox, target: CropBox): boolean {
  return crop.id === target.id
    || Boolean(target.patternGroupId && crop.patternGroupId === target.patternGroupId)
}

function partitionByDistinctCategories(assignments: NamingAssignment[]): NamingAssignment[][] {
  const partitions: Array<{ assignments: NamingAssignment[]; categories: Set<string> }> = []
  for (const assignment of assignments) {
    const partition = partitions.find((candidate) => setsAreDisjoint(candidate.categories, assignment.categories))
    if (partition) {
      partition.assignments.push(assignment)
      for (const category of assignment.categories) partition.categories.add(category)
    } else {
      partitions.push({ assignments: [assignment], categories: new Set(assignment.categories) })
    }
  }
  return partitions.map((partition) => partition.assignments)
}

function setsAreDisjoint(left: Set<string>, right: Set<string>): boolean {
  for (const value of right) {
    if (left.has(value)) return false
  }
  return true
}

function createAvailableAutoGroupId(nameKey: string, unitKeys: string[], occupied: Set<string>): string {
  const seed = `${nameKey}\u0000${unitKeys.slice().sort().join('\u0000')}`
  const base = `auto-name-${stableHash(seed)}`
  if (!occupied.has(base)) return base
  let suffix = 2
  while (occupied.has(`${base}-${suffix}`)) suffix += 1
  return `${base}-${suffix}`
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}
