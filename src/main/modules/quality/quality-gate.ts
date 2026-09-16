export type QualityIssueCategory = 'image' | 'name' | 'code' | 'spreadsheet' | 'integration'

export interface QualityIssue {
  category: QualityIssueCategory
  severity: 'error' | 'warning'
  message: string
  reference?: string
}

export interface QualityReport {
  exportAllowed: boolean
  issues: QualityIssue[]
}

export function createQualityReport(issues: QualityIssue[]): QualityReport {
  return {
    exportAllowed: !issues.some((issue) => issue.severity === 'error'),
    issues
  }
}
