import { describe, expect, it } from 'vitest'
import { classifyTemplates } from '../src/main/modules/spreadsheet/ooxml-workbook-inspector'
import { VerifiedWorkbookCloner } from '../src/main/modules/spreadsheet/verified-workbook-cloner'
import type { WorksheetMetrics } from '../src/main/modules/spreadsheet/ooxml-types'

function worksheet(name: string, state: WorksheetMetrics['state'] = 'visible'): WorksheetMetrics {
  return {
    name,
    sheetId: '1',
    state,
    partPath: `xl/worksheets/${name}.xml`,
    usedRange: 'A1:J20',
    formulaCount: 1,
    styledCellCount: 10,
    rowCount: 20,
    customRowHeightCount: 2,
    columnDefinitionCount: 10,
    drawingReferenceCount: 0,
    partCrc32: '12345678',
    uncompressedBytes: 100
  }
}

describe('OOXML template engine', () => {
  it('classifies visible business sheets as templates', () => {
    const result = classifyTemplates([
      worksheet('可拆卸+其他'),
      worksheet('命名规则'),
      worksheet('系统辅助', 'veryHidden')
    ], 'naming-formula')

    expect(result.map((item) => item.classification)).toEqual([
      'template',
      'reference',
      'helper'
    ])
  })

  it('does not classify sheets from reference workbooks as templates', () => {
    expect(classifyTemplates([worksheet('可拆卸+其他')], 'barcode-reference')).toEqual([])
  })

  it('rejects cloning over the source file', async () => {
    const cloner = new VerifiedWorkbookCloner()
    await expect(cloner.cloneAndVerify('same.xlsx', 'same.xlsx')).rejects.toThrow(
      '副本路径不能与源文件相同'
    )
  })
})
