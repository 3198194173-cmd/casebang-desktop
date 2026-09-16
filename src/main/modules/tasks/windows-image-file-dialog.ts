import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { extname } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff'])

/**
 * Uses the classic Windows common-file dialog. Electron 44's modern Windows
 * shell picker can hang while loading Explorer thumbnail/shell extensions.
 */
export async function selectImageWithClassicWindowsDialog(initialDirectory: string | null): Promise<string | null> {
  const script = String.raw`
Add-Type -AssemblyName System.Windows.Forms
$picker = New-Object System.Windows.Forms.OpenFileDialog
$picker.AutoUpgradeEnabled = $false
$picker.Title = '选择一张产品排版总图'
$picker.Filter = '产品图片|*.png;*.jpg;*.jpeg;*.webp;*.tif;*.tiff|所有文件|*.*'
$picker.Multiselect = $false
$picker.CheckFileExists = $true
$picker.CheckPathExists = $true
$picker.RestoreDirectory = $true
$owner = New-Object System.Windows.Forms.Form
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
$owner.Opacity = 0
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$owner.Location = New-Object System.Drawing.Point(-32000, -32000)
$owner.Size = New-Object System.Drawing.Size(1, 1)
if ($env:CASEBANG_IMAGE_DIRECTORY -and (Test-Path -LiteralPath $env:CASEBANG_IMAGE_DIRECTORY -PathType Container)) {
  $picker.InitialDirectory = $env:CASEBANG_IMAGE_DIRECTORY
}
try {
  $owner.Show()
  if ($picker.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($picker.FileName))
  }
} finally {
  $picker.Dispose()
  $owner.Dispose()
}
`
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64')
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand
  ], {
    // `windowsHide: true` also hides child-owned WinForms windows. PowerShell
    // hides its own console via -WindowStyle while the picker stays visible.
    windowsHide: false,
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    env: { ...process.env, CASEBANG_IMAGE_DIRECTORY: initialDirectory ?? '' }
  })
  const encodedPath = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)
  if (!encodedPath) return null
  const filePath = Buffer.from(encodedPath, 'base64').toString('utf8')
  if (!imageExtensions.has(extname(filePath).toLowerCase())) throw new Error('请选择 PNG、JPG、WEBP 或 TIFF 图片。')
  await access(filePath)
  return filePath
}
