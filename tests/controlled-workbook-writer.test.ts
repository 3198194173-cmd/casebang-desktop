import { describe, expect, it } from 'vitest'
import { ControlledWorkbookWriter } from '../src/main/modules/spreadsheet/controlled-workbook-writer'
import { comparePackages, type PackageEntryRecord } from '../src/main/modules/spreadsheet/ooxml-package'

function entry(path: string, crc32: string): PackageEntryRecord {
  return {
    path,
    crc32,
    compressedSize: 10,
    uncompressedSize: 20,
    isDirectory: false,
    mtime: new Date(0),
    buffer: Buffer.from('test')
  }
}

describe('controlled workbook writer', () => {
  it('detects the exact OOXML part that changed', () => {
    const before = [entry('xl/styles.xml', '11111111'), entry('xl/worksheets/sheet1.xml', '22222222')]
    const after = [entry('xl/styles.xml', '11111111'), entry('xl/worksheets/sheet1.xml', '33333333')]
    expect(comparePackages(before, after)).toEqual([
      { path: 'xl/worksheets/sheet1.xml', kind: 'changed' }
    ])
  })

  it('refuses to overwrite the source workbook', async () => {
    const writer = new ControlledWorkbookWriter()
    await expect(writer.write({
      sourcePath: 'same.xlsx',
      destinationPath: 'same.xlsx',
      sheetName: '可拆卸+其他',
      rows: [{ row: 2, values: { seriesName: 'Test' } }],
      config: {
        schemaVersion: 1,
        generatedAt: new Date(0).toISOString(),
        sourcePath: 'same.xlsx',
        sourceSha256: '',
        templates: [],
        warnings: []
      }
    })).rejects.toThrow('输出文件不能覆盖源工作簿')
  })
})
