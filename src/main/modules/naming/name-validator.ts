export type NameIssueSeverity = 'error' | 'warning'

export interface PatternNameInput {
  patternId: string
  englishName: string
}

export interface NameIssue {
  severity: NameIssueSeverity
  patternIds: [string, string]
  message: string
}

export interface NameValidationResult {
  valid: boolean
  issues: NameIssue[]
}

export function normalizePatternName(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[\s\-_.,'"/\\()[\]{}:;!?]+/g, '')
}

function singularize(value: string): string {
  if (value.endsWith('ies') && value.length > 3) return `${value.slice(0, -3)}y`
  if (value.endsWith('es') && value.length > 2) return value.slice(0, -2)
  if (value.endsWith('s') && value.length > 1) return value.slice(0, -1)
  return value
}

export function validateUniquePatternNames(items: PatternNameInput[]): NameValidationResult {
  const issues: NameIssue[] = []

  for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
    const left = items[leftIndex]
    if (!left) continue
    const leftNormalized = normalizePatternName(left.englishName)

    if (!leftNormalized) {
      issues.push({
        severity: 'error',
        patternIds: [left.patternId, left.patternId],
        message: `图案 ${left.patternId} 尚未填写英文名称`
      })
      continue
    }

    for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
      const right = items[rightIndex]
      if (!right) continue
      const rightNormalized = normalizePatternName(right.englishName)

      if (leftNormalized === rightNormalized) {
        issues.push({
          severity: 'error',
          patternIds: [left.patternId, right.patternId],
          message: `“${left.englishName}”与“${right.englishName}”标准化后重复，必须修改`
        })
      } else if (singularize(leftNormalized) === singularize(rightNormalized)) {
        issues.push({
          severity: 'warning',
          patternIds: [left.patternId, right.patternId],
          message: `“${left.englishName}”与“${right.englishName}”仅存在单复数近似，请人工确认`
        })
      }
    }
  }

  return {
    valid: !issues.some((issue) => issue.severity === 'error'),
    issues
  }
}
