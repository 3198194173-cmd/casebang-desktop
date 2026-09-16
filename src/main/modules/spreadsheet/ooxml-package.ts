import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import yauzl, { type Entry, type ZipFile } from 'yauzl'
import yazl from 'yazl'
import type { PackageEntryDifference } from '@shared/excel-contracts'

export interface PackageEntryRecord {
  path: string
  crc32: string
  compressedSize: number
  uncompressedSize: number
  isDirectory: boolean
  mtime: Date
  buffer: Buffer | null
}

const MAX_PACKAGE_BYTES = 1_500 * 1024 * 1024

export async function readOoxmlPackage(
  filePath: string,
  options: { skipMedia?: boolean } = {}
): Promise<PackageEntryRecord[]> {
  const file = await stat(filePath)
  if (!file.isFile()) throw new Error(`不是有效文件：${filePath}`)
  const zip = await openZip(filePath)
  const entries: PackageEntryRecord[] = []
  let totalBytes = 0

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const fail = (reason: unknown): void => {
      if (settled) return
      settled = true
      zip.close()
      reject(reason)
    }
    zip.on('error', fail)
    zip.on('end', () => {
      if (settled) return
      settled = true
      resolve()
    })
    zip.on('entry', (entry: Entry) => {
      void (async () => {
        const path = normalizeZipPath(entry.fileName)
        const isDirectory = path.endsWith('/')
        totalBytes += entry.uncompressedSize
        if (totalBytes > MAX_PACKAGE_BYTES) {
          throw new Error('工作簿解压后超过 1.5 GB，已停止以保护内存')
        }
        const skipBuffer = isDirectory || (options.skipMedia === true && path.startsWith('xl/media/'))
        entries.push({
          path,
          crc32: toCrc32(entry.crc32),
          compressedSize: entry.compressedSize,
          uncompressedSize: entry.uncompressedSize,
          isDirectory,
          mtime: entry.getLastModDate(),
          buffer: skipBuffer ? null : await readEntryBuffer(zip, entry)
        })
        zip.readEntry()
      })().catch(fail)
    })
    zip.readEntry()
  })
  return entries
}

export async function readOoxmlParts(filePath: string, requestedPaths: string[]): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>()
  await visitOoxmlParts(filePath, requestedPaths, async (path, buffer) => { result.set(path, buffer) })
  return result
}

/** One ZIP traversal, with only one decoded original retained during each visit. */
export async function visitOoxmlParts(filePath: string, requestedPaths: string[], visit: (path: string, buffer: Buffer) => Promise<void>): Promise<void> {
  if (requestedPaths.length === 0) return
  const file = await stat(filePath)
  if (!file.isFile()) throw new Error(`不是有效文件：${filePath}`)
  const requested = new Set(requestedPaths.map(normalizeZipPath))
  const found = new Set<string>()
  const zip = await openZip(filePath)

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const fail = (reason: unknown): void => {
      if (settled) return
      settled = true
      zip.close()
      reject(reason)
    }
    zip.on('error', fail)
    zip.on('end', () => {
      if (settled) return
      settled = true
      resolve()
    })
    zip.on('entry', (entry: Entry) => {
      void (async () => {
        const path = normalizeZipPath(entry.fileName)
        if (requested.has(path) && !path.endsWith('/')) {
          await visit(path, await readEntryBuffer(zip, entry))
          found.add(path)
          if (found.size === requested.size) { settled = true; zip.close(); resolve(); return }
        }
        zip.readEntry()
      })().catch(fail)
    })
    zip.readEntry()
  })

  const missing = [...requested].filter((path) => !found.has(path))
  if (missing.length > 0) throw new Error(`工作簿缺少必要部件：${missing.join(', ')}`)
}

export async function writeOoxmlPackage(
  destinationPath: string,
  entries: PackageEntryRecord[]
): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true })
  try {
    await stat(destinationPath)
    throw new Error(`目标文件已存在，为防止覆盖已停止：${destinationPath}`)
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code !== 'ENOENT') throw reason
  }

  const temporaryPath = `${destinationPath}.writing-${process.pid}-${Date.now()}`
  const output = createWriteStream(temporaryPath, { flags: 'wx' })
  const zip = new yazl.ZipFile()
  zip.outputStream.pipe(output)

  try {
    for (const entry of entries) {
      if (entry.isDirectory) zip.addEmptyDirectory(entry.path, { mtime: entry.mtime })
      else zip.addBuffer(entry.buffer ?? Buffer.alloc(0), entry.path, { mtime: entry.mtime, compress: true })
    }
    zip.end()
    await new Promise<void>((resolve, reject) => {
      output.on('close', resolve)
      output.on('error', reject)
      zip.outputStream.on('error', reject)
    })
    await rename(temporaryPath, destinationPath)
  } catch (reason) {
    output.destroy()
    await rm(temporaryPath, { force: true })
    throw reason
  }
}

export function findPackageText(entries: PackageEntryRecord[], path: string): string | null {
  const entry = entries.find((candidate) => candidate.path === normalizeZipPath(path))
  return entry?.buffer?.toString('utf8') ?? null
}

export function replacePackageText(
  entries: PackageEntryRecord[],
  path: string,
  text: string
): void {
  const normalized = normalizeZipPath(path)
  const entry = entries.find((candidate) => candidate.path === normalized)
  if (!entry || entry.isDirectory) throw new Error(`工作簿部件不存在：${normalized}`)
  entry.buffer = Buffer.from(text, 'utf8')
  entry.uncompressedSize = entry.buffer.length
}

export function comparePackages(
  before: PackageEntryRecord[],
  after: PackageEntryRecord[]
): PackageEntryDifference[] {
  const left = new Map(before.map((entry) => [entry.path, entry]))
  const right = new Map(after.map((entry) => [entry.path, entry]))
  const paths = new Set([...left.keys(), ...right.keys()])
  const differences: PackageEntryDifference[] = []
  for (const path of [...paths].sort()) {
    const source = left.get(path)
    const destination = right.get(path)
    if (!source) differences.push({ path, kind: 'added' })
    else if (!destination) differences.push({ path, kind: 'removed' })
    else if (
      source.crc32 !== destination.crc32 ||
      source.uncompressedSize !== destination.uncompressedSize
    ) {
      differences.push({ path, kind: 'changed' })
    }
  }
  return differences
}

export function normalizeZipPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '')
}

function openZip(filePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error) reject(error)
      else if (!zip) reject(new Error('无法打开 XLSX 压缩包'))
      else resolve(zip)
    })
  })
}

function readEntryBuffer(zip: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(error)
      if (!stream) return reject(new Error(`无法读取 ${entry.fileName}`))
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
      stream.on('error', reject)
      stream.on('end', () => resolve(Buffer.concat(chunks)))
    })
  })
}

function toCrc32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0')
}
