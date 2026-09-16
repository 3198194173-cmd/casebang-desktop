export interface AllocateCodeInput {
  prefix: string
  count: number
  usedCodes: string[]
  sharedPrefixes?: string[]
  minimumNumber?: number
  width?: number
}

export interface CodeAllocation {
  prefix: string
  numbers: number[]
  codes: string[]
}

function extractNumber(code: string, allowedPrefixes: string[]): number | null {
  const match = /^([A-Z]+)(\d+)$/i.exec(code.trim())
  if (!match?.[1] || !match[2]) return null
  if (!allowedPrefixes.includes(match[1].toUpperCase())) return null
  return Number.parseInt(match[2], 10)
}

export function allocateCodes(input: AllocateCodeInput): CodeAllocation {
  const prefix = input.prefix.trim().toUpperCase()
  if (!/^[A-Z]+$/.test(prefix)) throw new Error('产品编码前缀必须由英文字母组成')
  if (!Number.isInteger(input.count) || input.count < 0) throw new Error('产品数量必须是非负整数')

  const width = input.width ?? 5
  const allowedPrefixes = [prefix, ...(input.sharedPrefixes ?? []).map((item) => item.toUpperCase())]
  const occupied = new Set(
    input.usedCodes
      .map((code) => extractNumber(code, allowedPrefixes))
      .filter((value): value is number => value !== null)
  )

  const numbers: number[] = []
  let candidate = Math.max(input.minimumNumber ?? 1, 1)
  while (numbers.length < input.count) {
    if (!occupied.has(candidate)) numbers.push(candidate)
    candidate += 1
  }

  return {
    prefix,
    numbers,
    codes: numbers.map((number) => `${prefix}${number.toString().padStart(width, '0')}`)
  }
}
