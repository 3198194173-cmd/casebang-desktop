import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { expect, it } from 'vitest'
import { WorkbookPreviewService } from '../src/main/modules/spreadsheet/workbook-preview-service'
import { writeOoxmlPackage } from '../src/main/modules/spreadsheet/ooxml-package'

it('loads DISPIMG and floating pictures only in the requested range, without caching image payloads in metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'preview-images-'))
  try {
    const path = join(dir, 'test.xlsx')
    const png = await sharp({ create: { width: 600, height: 400, channels: 3, background: 'red' } }).png().toBuffer()
    const parts: Record<string, string | Buffer> = {
      'xl/workbook.xml': '<workbook><sheets><sheet name="test" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="2"><c r="A2"><f>_xlfn.DISPIMG(&quot;ID_ONE&quot;,1)</f></c></row><row r="100"><c r="A100"><f>DISPIMG("MISSING",1)</f></c></row></sheetData><drawing r:id="d1"/></worksheet>',
      'xl/worksheets/_rels/sheet1.xml.rels': '<Relationships><Relationship Id="d1" Target="../drawings/drawing1.xml"/></Relationships>',
      'xl/drawings/drawing1.xml': '<d:wsDr><d:oneCellAnchor><d:from><d:col>1</d:col><d:row>49</d:row></d:from><d:pic><a:blip r:embed="i1"/></d:pic></d:oneCellAnchor></d:wsDr>',
      'xl/drawings/_rels/drawing1.xml.rels': '<Relationships><Relationship Id="i1" Target="../media/image1.png"/></Relationships>',
      'xl/cellimages.xml': '<etc:cellImages><etc:cellImage><xdr:pic><xdr:nvPicPr><xdr:cNvPr name="ID_ONE"/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="i1"/></xdr:blipFill></xdr:pic></etc:cellImage></etc:cellImages>',
      'xl/_rels/cellimages.xml.rels': '<Relationships><Relationship Id="i1" Target="media/image1.png"/></Relationships>',
      'xl/media/image1.png': png
    }
    await writeOoxmlPackage(path, Object.entries(parts).map(([name, value]) => ({ path: name, buffer: Buffer.isBuffer(value) ? value : Buffer.from(value), crc32: '', compressedSize: 0, uncompressedSize: value.length, isDirectory: false, mtime: new Date() })))
    const service = new WorkbookPreviewService()
    const metadata = await service.read(path, { kind: 'barcodeReference', imageEndRow: 0 })
    expect(metadata.rows.map((row) => row.rowNumber)).toEqual([2, 50, 100])
    expect(metadata.rows.every((row) => row.cells.every((cell) => !cell.generatedImageDataUrl))).toBe(true)
    const first = await service.read(path, { kind: 'barcodeReference', imageStartRow: 1, imageEndRow: 10, imagesOnly: true })
    expect(first.rows).toHaveLength(1)
    const url = first.rows[0]!.cells[0]!.generatedImageDataUrl!
    expect(url).toMatch(/^data:image\/png;base64,/)
    expect((await sharp(Buffer.from(url.split(',')[1]!, 'base64')).metadata()).width).toBe(320)
    const second = await service.read(path, { kind: 'barcodeReference', imageStartRow: 50, imageEndRow: 50, imagesOnly: true })
    expect(second.rows[0]!.cells[0]!.address).toBe('B50')
    expect(second.rows[0]!.cells[0]!.generatedImageDataUrl).toBe(url)
    const missing = await service.read(path, { kind: 'barcodeReference', imageStartRow: 100, imageEndRow: 100, imagesOnly: true })
    expect(missing.rows[0]!.cells[0]!.generatedImageDataUrl).toBeNull()
    expect(missing.rows[0]!.cells[0]!.formula).toContain('MISSING')
    expect((await service.read(path, { kind: 'barcodeReference', imageEndRow: 0 })).rows[0]!.cells[0]!.generatedImageDataUrl).toBeNull()
  } finally { await rm(dir, { recursive: true, force: true }) }
})
