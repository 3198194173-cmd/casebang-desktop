import { z } from 'zod'

export const artworkVisualInputSchema = z.object({
  pdfImageDataUrl: z.string().max(5_000_000).regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/),
  workbookImageDataUrl: z.string().max(5_000_000).regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/)
}).strict()

export type ArtworkVisualInput = z.infer<typeof artworkVisualInputSchema>
export interface ArtworkVisualResult {
  status: 'matched' | 'mismatched' | 'uncertain'
  confidence: number
  reason: string
  model: string
  checkedAt: string
}
