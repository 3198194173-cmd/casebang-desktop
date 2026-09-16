import type { MaterialBrand } from './lifecycle-contracts'

export const MATERIAL_MODEL_DICTIONARY_VERSION = 'user-confirmed-2026-09-16'
export interface MaterialModel { brand: MaterialBrand; code: string; name: string; aliases: string[] }
const models = (brand: MaterialBrand, entries: Array<[string, string, ...string[]]>): MaterialModel[] => entries.map(([code, name, ...aliases]) => ({ brand, code, name, aliases }))
// Independent of upstream barcode display names. Never rewrite their labels.
export const MATERIAL_MODELS: MaterialModel[] = [
  ...models('AP', [
    ['53', 'iP13 Pro'], ['54', 'iP13 Pro Max'], ['57', 'iP14 Pro'], ['58', 'iP14 Pro Max'],
    ['59', 'iP15'], ['60', 'iP15 Plus'], ['61', 'iP15 Pro'], ['62', 'iP15 Pro Max'],
    ['63', 'iP16'], ['64', 'iP16 Plus'], ['65', 'iP16 Pro'], ['66', 'iP16 Pro Max'],
    ['47', 'iP16e', 'iP16e/17e'], ['72', 'iP17'], ['73', 'iP17 Air'],
    ['74', 'iP17 Pro', 'iP18 Pro/17 Pro'], ['75', 'iP17 Pro Max', 'iP18 Pro Max/17 Pro Max']
  ]),
  ...models('SA', [
    ['40', 'SAM S24'], ['41', 'SAM S24+'], ['42', 'SAM S24U'], ['43', 'SAM S25'],
    ['44', 'SAM S25+'], ['45', 'SAM S25U'], ['48', 'SAM S26'], ['49', 'SAM S26+'], ['50', 'SAM S26U'], ['14', 'SAM Z Fold8']
  ]),
  ...models('HW', [
    ['90', 'P70'], ['91', 'P70 Pro/Pro+'], ['92', 'P70 Ultra'], ['70', 'P80 Pro/Pro+'], ['71', 'P80 Ultra'],
    ['87', 'Mate 60'], ['88', 'Mate 60 Pro'], ['95', 'Mate 70 Pro/Pro+'], ['76', 'Mate 80/80 Pro'],
    ['77', 'Mate 80 Pro Max'], ['94', 'Mate 70'], ['51', 'Pu X Max'], ['10', 'P90 Pro'], ['11', 'P90 Pro Max'],
    ['12', 'Mate 90/90 Pro'], ['13', 'Mate 90 Pro Max'], ['16', 'Mate 90 RS'], ['15', 'HW PX View']
  ])
]
export const normalizeModel = (name: string): string => name.normalize('NFKC').replace(/\s+/g, '').toUpperCase()
export function findMaterialModel(name: string): MaterialModel | null {
  const key = normalizeModel(name)
  return MATERIAL_MODELS.find(model => [model.name, ...model.aliases, ...(model.brand === 'HW' && !model.name.startsWith('HW ') ? [`HW ${model.name}`] : [])].some(alias => normalizeModel(alias) === key)) ?? null
}
