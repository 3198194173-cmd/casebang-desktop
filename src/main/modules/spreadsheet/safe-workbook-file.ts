import { copyFile, open } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const LOCK_ERROR_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])

export async function assertWorkbookWritable(filePath: string, label: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(filePath, 'r+')
  } catch (reason) {
    throw workbookFileError(reason, filePath, label, '覆盖')
  } finally {
    await handle?.close()
  }
}

export async function copyWorkbookWithRetry(
  sourcePath: string,
  destinationPath: string,
  options: { label: string; action: string; attempts?: number }
): Promise<void> {
  const attempts = options.attempts ?? 4
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await copyFile(sourcePath, destinationPath)
      return
    } catch (reason) {
      lastError = reason
      if (!isWorkbookLockError(reason) || attempt === attempts) break
      await delay(attempt * 250)
    }
  }
  throw workbookFileError(lastError, destinationPath, options.label, options.action)
}

export function isWorkbookLockError(reason: unknown): boolean {
  return LOCK_ERROR_CODES.has((reason as NodeJS.ErrnoException | undefined)?.code ?? '')
}

export function workbookFileError(reason: unknown, filePath: string, label: string, action: string): Error {
  if (isWorkbookLockError(reason)) {
    const code = (reason as NodeJS.ErrnoException).code
    const message = code === 'EBUSY'
      ? '当前文件已打开，请关闭文件后重试。'
      : '当前文件可能已打开或没有写入权限，请关闭文件后重试；若仍失败，请检查文件权限。'
    return new Error(`${message}\n${label}无法${action}。\n文件：${filePath}`)
  }
  return reason instanceof Error ? reason : new Error(`${label}${action}失败。`)
}
