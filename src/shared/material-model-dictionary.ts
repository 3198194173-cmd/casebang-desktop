import type { MaterialBrand, MaterialCodeBrand } from './lifecycle-contracts'

export const MATERIAL_MODEL_DICTIONARY_VERSION = 'user-confirmed-2026-09-23'
export interface MaterialModel { brand: MaterialBrand; code: string; name: string; aliases: string[] }

/** Display brand and material-code namespace are different for Honor and Redmi. */
export const MATERIAL_BRAND_GROUPS: readonly { id: MaterialBrand; label: string; codeBrand: MaterialCodeBrand }[] = [
  { id: 'AP', label: '苹果', codeBrand: 'AP' },
  { id: 'SA', label: '三星', codeBrand: 'SA' },
  { id: 'HW', label: '华为', codeBrand: 'HW' },
  { id: 'MI', label: '小米', codeBrand: 'MI' },
  { id: 'HON', label: '荣耀', codeBrand: 'HW' },
  { id: 'VV', label: 'vivo', codeBrand: 'VV' },
  { id: 'OP', label: 'OPPO', codeBrand: 'OP' },
  { id: 'IQ', label: 'iQOO', codeBrand: 'IQ' },
  { id: '1+', label: '一加', codeBrand: '1+' },
  { id: 'RM', label: 'Redmi', codeBrand: 'MI' },
  { id: 'GG', label: 'Google', codeBrand: 'GG' }
]
export function materialCodeBrand(brand: MaterialBrand): MaterialCodeBrand {
  const group = MATERIAL_BRAND_GROUPS.find(value => value.id === brand)
  if (!group) throw new Error(`未知机型品牌：${brand}`)
  return group.codeBrand
}
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
    ['44', 'SAM S25+'], ['45', 'SAM S25U'], ['48', 'SAM S26'], ['49', 'SAM S26+'],
    ['50', 'SAM S26U'], ['14', 'SAM Z Fold8'], ['01', 'SAM A56-5G']
  ]),
  ...models('HW', [
    ['90', 'P70'], ['91', 'P70 Pro/Pro+'], ['92', 'P70 Ultra'], ['70', 'P80 Pro/Pro+'], ['71', 'P80 Ultra'],
    ['87', 'Mate 60'], ['88', 'Mate 60 Pro'], ['95', 'Mate 70 Pro/Pro+', 'Mate 70 Pro'],
    ['76', 'Mate 80/80 Pro'], ['77', 'Mate 80 Pro Max'], ['94', 'Mate 70'],
    ['51', 'Pu X Max', 'PX Max'], ['10', 'P90 Pro'], ['11', 'P90 Pro Max'],
    ['12', 'Mate 90/90 Pro'], ['13', 'Mate 90 Pro Max'], ['16', 'Mate 90 RS'], ['15', 'HW PX View'],
    ['96', 'HW Mate 70 RS'], ['97', 'HW Mate X6'], ['78', 'HW Mate X7']
  ]),
  ...models('MI', [['35', 'MI 15'], ['36', 'MI 15 Pro'], ['37', 'MI 15U']]),
  ...models('HON', [
    ['98', 'HON Magic 7'], ['99', 'HON Magic 7 Pro'], ['01', 'HON 300'],
    ['02', 'HON 300 Pro'], ['03', 'HON 300 Ultra']
  ]),
  ...models('VV', [
    ['01', 'VV x200'], ['02', 'VV x200 Pro'], ['03', 'VV x200 Pro mini'],
    ['04', 'VV x200S'], ['05', 'VV x200 U']
  ]),
  ...models('OP', [
    ['01', 'OP Find X8'], ['02', 'OP Find X8 Pro'], ['03', 'OP Find X8 Ultra'],
    ['04', 'OP Find X8 S'], ['05', 'OP Find X8 S+']
  ]),
  ...models('IQ', [['01', 'IQ 13']]),
  ...models('1+', [['01', '1+ 13']]),
  ...models('RM', [['38', 'RM K80'], ['39', 'RM K80 Pro']]),
  ...models('GG', [['01', 'GG 9A']])
]
export const normalizeModel = (name: string): string => name.normalize('NFKC').replace(/\s+/g, '').toUpperCase()
export function materialModelNames(model: MaterialModel): string[] {
  const names = [model.name, ...model.aliases]
  return model.brand === 'HW' ? [...names, ...names.filter(name => !/^HW\s/i.test(name)).map(name => `HW ${name}`)] : names
}

/** Include newly shipped defaults without replacing user-edited mappings from older versions. */
export function mergeMaterialModels(saved: readonly MaterialModel[]): MaterialModel[] {
  const result = saved.map(model => ({ ...model, aliases: [...model.aliases] }))
  for (const seed of MATERIAL_MODELS) {
    const sameCode = result.find(model => materialCodeBrand(model.brand) === materialCodeBrand(seed.brand) && model.code === seed.code)
    if (sameCode) {
      if (sameCode.brand === seed.brand && normalizeModel(sameCode.name) === normalizeModel(seed.name)) {
        const known = new Set(materialModelNames(sameCode).map(normalizeModel))
        for (const alias of seed.aliases) if (!known.has(normalizeModel(alias))) sameCode.aliases.push(alias)
      }
      continue
    }
    if (result.some(model => materialModelNames(model).some(name => normalizeModel(name) === normalizeModel(seed.name)))) continue
    result.push({ ...seed, aliases: [...seed.aliases] })
  }
  return result
}
export function findMaterialModel(name: string, dictionary: readonly MaterialModel[] = MATERIAL_MODELS): MaterialModel | null {
  const key = normalizeModel(name)
  return dictionary.find(model => materialModelNames(model).some(alias => normalizeModel(alias) === key)) ?? null
}
