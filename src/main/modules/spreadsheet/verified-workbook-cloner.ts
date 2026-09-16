import { constants } from 'node:fs'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { VerifiedWorkbookCloneReport, WorkbookRole } from './ooxml-types'
import { OoxmlWorkbookInspector } from './ooxml-workbook-inspector'

export class VerifiedWorkbookCloner {
  constructor(private readonly inspector = new OoxmlWorkbookInspector()) {}

  async cloneAndVerify(
    sourcePath: string,
    clonePath: string,
    role: WorkbookRole = 'unknown'
  ): Promise<VerifiedWorkbookCloneReport> {
    if (resolve(sourcePath).toLocaleLowerCase() === resolve(clonePath).toLocaleLowerCase()) {
      throw new Error('副本路径不能与源文件相同')
    }

    const before = await stat(sourcePath)
    await mkdir(dirname(clonePath), { recursive: true })
    await copyFile(sourcePath, clonePath, constants.COPYFILE_EXCL)
    const after = await stat(sourcePath)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('复制过程中源工作簿发生变化，已停止验证')
    }

    return this.verifyExisting(sourcePath, clonePath, role)
  }

  async verifyExisting(
    sourcePath: string,
    clonePath: string,
    role: WorkbookRole = 'unknown'
  ): Promise<VerifiedWorkbookCloneReport> {
    const [source, clone] = await Promise.all([
      this.inspector.inspect(sourcePath, role),
      this.inspector.inspect(clonePath, role)
    ])

    const checks = {
      formulas: source.componentFingerprints.worksheets === clone.componentFingerprints.worksheets,
      styles: source.componentFingerprints.styles === clone.componentFingerprints.styles,
      rowColumnDimensions:
        source.componentFingerprints.worksheets === clone.componentFingerprints.worksheets,
      imageAnchors: source.componentFingerprints.drawings === clone.componentFingerprints.drawings,
      media: source.componentFingerprints.media === clone.componentFingerprints.media,
      relationships:
        source.componentFingerprints.relationships === clone.componentFingerprints.relationships,
      worksheetInventory:
        JSON.stringify(source.worksheets) === JSON.stringify(clone.worksheets)
    }
    const exactBinaryMatch = source.sha256 === clone.sha256 && source.fileSize === clone.fileSize

    return {
      generatedAt: new Date().toISOString(),
      sourcePath,
      clonePath,
      sourceSha256: source.sha256,
      cloneSha256: clone.sha256,
      exactBinaryMatch,
      checks,
      source,
      clone,
      passed: exactBinaryMatch && Object.values(checks).every(Boolean)
    }
  }
}
