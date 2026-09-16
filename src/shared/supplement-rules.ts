export const silverVariant = (v: string): boolean => /[（(]银框[）)]/.test(v)
export const priceGroup = (v: string): string => silverVariant(v) ? '（银框）' : ''
export const withoutSilver = (v: string): string => v.replace(/[（(]银框[）)]/g, '').trim()
export const needsSilver = (name: string): boolean => /出镜壳|出片壳/.test(name.split('-')[0] ?? '')
