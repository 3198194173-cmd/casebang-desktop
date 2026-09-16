import { useEffect, useRef, useState } from 'react'
import { desktopApi } from '../../app/desktop-api'
import type { WorkbookPreviewRequest } from '@shared/contracts'

// One request at a time; scrolling replaces pending work instead of piling it up.
export function useHistoryImages(identity: string, request: WorkbookPreviewRequest | null): { images: Record<string, string>; error: string } {
  const [images, setImages] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const state = useRef({ identity, wanted: '', running: false, pending: null as WorkbookPreviewRequest | null, cache: new Map<string, Record<string, string>>(), bytes: 0, alive: true })
  useEffect(() => { state.current.alive = true; return () => { state.current.alive = false; state.current.pending = null } }, [])
  useEffect(() => {
    const s = state.current
    if (s.identity !== identity) { s.identity = identity; s.cache.clear(); s.bytes = 0; s.pending = null; setImages({}); setError('') }
    if (!request) { s.pending = null; s.wanted = ''; return }
    const cacheKey = (r: WorkbookPreviewRequest): string => `${r.imageStartRow}:${r.imageEndRow}`
    s.wanted = cacheKey(request)
    const cached = s.cache.get(cacheKey(request))
    if (cached) { s.pending = null; s.cache.delete(cacheKey(request)); s.cache.set(cacheKey(request), cached); setImages(cached); return }
    s.pending = request
    const pump = async (): Promise<void> => {
      if (s.running || !s.pending || !s.alive) return
      s.running = true
      const next = s.pending; s.pending = null; const version = s.identity
      try {
        const result = await desktopApi.baseFiles.preview(next)
        if (!s.alive || version !== s.identity) return
        const mapped: Record<string, string> = {}
        for (const row of result.rows) for (const cell of row.cells) if (cell.generatedImageDataUrl) mapped[cell.address] = cell.generatedImageDataUrl
        const size = Object.values(mapped).reduce((n, v) => n + v.length * 2, 0)
        if (size <= 8 * 1024 * 1024) {
          const previous = s.cache.get(cacheKey(next))
          if (previous) s.bytes -= Object.values(previous).reduce((n, v) => n + v.length * 2, 0)
          s.cache.set(cacheKey(next), mapped); s.bytes += size
          while (s.bytes > 8 * 1024 * 1024 || s.cache.size > 8) {
            const first = s.cache.keys().next().value!; s.bytes -= Object.values(s.cache.get(first)!).reduce((n, v) => n + v.length * 2, 0); s.cache.delete(first)
          }
        }
        if (s.wanted === cacheKey(next)) { setImages(mapped); setError('') }
      } catch (e) { if (s.alive && version === s.identity) setError(String(e)) }
      finally { s.running = false; if (s.pending) void pump() }
    }
    const timer = window.setTimeout(() => void pump(), 60)
    return () => window.clearTimeout(timer)
  }, [identity, request])
  return { images, error }
}
