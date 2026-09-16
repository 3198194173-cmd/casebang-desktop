import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import sharp from 'sharp'

const source = process.argv[2]
if (!source) throw new Error('请提供图标源 PNG 路径')

const root = resolve(import.meta.dirname, '..')
const rendererIcon = resolve(root, 'src/renderer/public/casebang-app-icon.png')
const resourceIcon = resolve(root, 'resources/casebang-app-icon.png')
const buildPng = resolve(root, 'build/icon.png')
const buildIco = resolve(root, 'build/icon.ico')

await Promise.all([rendererIcon, resourceIcon, buildPng, buildIco].map((path) => mkdir(dirname(path), { recursive: true })))

const fullSize = await sharp(source).resize(512, 512, { fit: 'contain' }).png().toBuffer()
const iconSize = await sharp(source).resize(256, 256, { fit: 'contain' }).png().toBuffer()
await Promise.all([
  writeFile(rendererIcon, fullSize),
  writeFile(resourceIcon, fullSize),
  writeFile(buildPng, fullSize)
])

const icoHeader = Buffer.alloc(22)
icoHeader.writeUInt16LE(0, 0)
icoHeader.writeUInt16LE(1, 2)
icoHeader.writeUInt16LE(1, 4)
icoHeader.writeUInt8(0, 6)
icoHeader.writeUInt8(0, 7)
icoHeader.writeUInt8(0, 8)
icoHeader.writeUInt8(0, 9)
icoHeader.writeUInt16LE(1, 10)
icoHeader.writeUInt16LE(32, 12)
icoHeader.writeUInt32LE(iconSize.length, 14)
icoHeader.writeUInt32LE(22, 18)
await writeFile(buildIco, Buffer.concat([icoHeader, iconSize]))

// Keep one lossless source copy beside the packaged runtime asset.
await copyFile(source, resolve(root, 'resources/casebang-app-icon-source.png'))
await readFile(buildIco)
