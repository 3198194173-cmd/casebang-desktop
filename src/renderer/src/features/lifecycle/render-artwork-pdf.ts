import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist'

GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).toString()

/** Render the actual first PDF page; a DingTalk node URL is not an image source. */
export async function renderArtworkPdf(dataUrl: string): Promise<string> {
  if (!dataUrl.startsWith('data:application/pdf;base64,')) throw new Error('PDF 内容格式错误')
  const binary = atob(dataUrl.slice('data:application/pdf;base64,'.length))
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  const pdfDocument = await getDocument({ data: bytes, useSystemFonts: true }).promise
  try {
    const page = await pdfDocument.getPage(1)
    const natural = page.getViewport({ scale: 1 })
    const scale = Math.min(2.5, 1400 / Math.max(natural.width, natural.height))
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建 PDF 渲染画布')
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvas, canvasContext: context, viewport }).promise
    return canvas.toDataURL('image/png')
  } finally { await pdfDocument.destroy() }
}
