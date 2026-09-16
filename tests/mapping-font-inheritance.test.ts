import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { exportFormatPreservingWorkbook } from '../src/main/modules/tasks/format-preserving-generation-exporter'
import { writeOoxmlPackage, readOoxmlPackage, findPackageText } from '../src/main/modules/spreadsheet/ooxml-package'

it.each([false, true])('uses consistent historical fonts despite nearby bad exports (indexed yellow: %s)', async (indexedYellow) => {
  const directory = await mkdtemp(join(tmpdir(), 'mapping-font-test-'))
  try {
    const source = join(directory, 'source.xlsx')
    const destination = join(directory, 'result.xlsx')
    const oldCells = '<row r="2"><c r="A2" s="1" t="inlineStr"><is><t>Original name</t></is></c><c r="B2" s="1" t="inlineStr"><is><t>Original second</t></is></c></row><row r="3"><c r="A3" s="2" t="inlineStr"><is><t>中文名称</t></is></c><c r="B3" s="2" t="inlineStr"><is><t>中文参考</t></is></c></row><row r="4"><c r="A4" s="0" t="inlineStr"><is><t>Previously wrong font</t></is></c></row>'
    const parts = {
      'xl/workbook.xml': '<workbook><sheets><sheet name="支架" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${oldCells}<row r="5"><c r="A5" s="0"/></row><row r="6"><c r="A6" s="0"/></row></sheetData></worksheet>`,
      'xl/styles.xml': '<styleSheet><fonts count="3"><font><sz val="11"/></font><font><sz val="9"/><name val="宋体"/></font><font><sz val="10"/><name val="楷体"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills><borders count="1"><border/></borders><cellXfs count="3"><xf fontId="0" fillId="0"/><xf fontId="1" fillId="0"/><xf fontId="2" fillId="1"/></cellXfs></styleSheet>'
    }
    if (indexedYellow) parts['xl/styles.xml'] = parts['xl/styles.xml'].replace('rgb="FFFFFF00"', 'indexed="6"')
    await writeOoxmlPackage(source, Object.entries(parts).map(([path, content]) => ({ path, buffer: Buffer.from(content), crc32: '', compressedSize: 0, uncompressedSize: Buffer.byteLength(content), isDirectory: false, mtime: new Date() })))
    await exportFormatPreservingWorkbook(source, destination, {
      id: 'product-image-mapping', name: 'K3', role: 'test', sheets: [{ id: 'stand', name: '支架', columns: ['A'], rows: [
        [{ value: 'New name', targetAddress: 'A5', changed: true }, { value: 'New second', targetAddress: 'B5', changed: true }],
        [{ value: '新增中文', targetAddress: 'A6', changed: true, fill: 'yellow' }]
      ] }]
    }, { suggestedName: 'test', templateName: '', sourcePaths: { namingFormula: source, barcodeReference: source, domesticNaming: source }, imageSource: { path: '', crops: [] }, workspace: { title: '', generatedAt: '', workbooks: [], checks: [] } })
    const result = await readOoxmlPackage(destination)
    const sheet = findPackageText(result, 'xl/worksheets/sheet1.xml')!
    const styles = findPackageText(result, 'xl/styles.xml')!
    const xfs = [...styles.split('<cellXfs')[1]!.matchAll(/<xf\b[^>]*?(?:\/>|(?<!\/)>[\s\S]*?<\/xf>)/g)].map((m) => m[0])
    expect(sheet).toContain(oldCells)
    for (const [address, fontId] of [['A5', '1'], ['B5', '1'], ['A6', '2']]) {
      const styleId = Number(new RegExp(`<c[^>]*r="${address}"[^>]*s="(\\d+)"`).exec(sheet)?.[1])
      expect(xfs[styleId]).toContain(`fontId="${fontId}"`)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
