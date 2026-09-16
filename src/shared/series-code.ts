export interface SeriesCodeGridRow {
  row: number
  values: string[]
}

export interface SeriesCodeSupplementWrite {
  row: number
  address: string
  code: string
}

export interface SeriesCodeReservePlan {
  anchorCode: string
  requiredReserveCount: number
  availableReserveCodes: string[]
  supplementWrites: SeriesCodeSupplementWrite[]
}

export interface NextSeriesRecord {
  code: string
  row: number
  usedCodes: string[]
}

const SERIES_CODE_PATTERN = /^([A-Z])(0|[1-9]\d*)$/

export function isValidSeriesCode(value: string): boolean {
  return SERIES_CODE_PATTERN.test(value.trim().toUpperCase())
}

export function compareSeriesCodes(left: string, right: string): number {
  const leftParts = parseSeriesCode(left)
  const rightParts = parseSeriesCode(right)
  if (!leftParts || !rightParts) return left.localeCompare(right)
  const leftTier = leftParts.number <= 9 ? 1 : String(leftParts.number).length
  const rightTier = rightParts.number <= 9 ? 1 : String(rightParts.number).length
  return leftTier - rightTier || leftParts.letterIndex - rightParts.letterIndex || leftParts.number - rightParts.number
}

export function nextSeriesCode(value: string): string {
  const parsed = parseSeriesCode(value)
  if (!parsed) throw new Error(`无效系列编码：${value}`)
  const { letterIndex, number } = parsed
  if (number < 9) return `${letter(letterIndex)}${number + 1}`
  if (number === 9) return letterIndex < 25 ? `${letter(letterIndex + 1)}0` : 'A10'
  const tierStart = 10 ** (String(number).length - 1)
  const tierEnd = 10 ** String(number).length - 1
  if (number < tierEnd) return `${letter(letterIndex)}${number + 1}`
  return letterIndex < 25 ? `${letter(letterIndex + 1)}${tierStart}` : `A${tierEnd + 1}`
}

/**
 * New-table tasks are append-only. The next record is derived exclusively from
 * the last row that already has a series name; matching names never reuse it.
 */
export function resolveNextSeriesRecord(rows: SeriesCodeGridRow[]): NextSeriesRecord {
  const filled = rows.flatMap((item) => {
    const code = (item.values[0] ?? '').trim().toUpperCase()
    const used = Boolean((item.values[1] ?? '').trim() || (item.values[2] ?? '').trim())
    return isValidSeriesCode(code) && used ? [{ row: item.row, code }] : []
  }).sort((left, right) => left.row - right.row)
  const latest = filled.at(-1)
  return {
    code: latest ? nextSeriesCode(latest.code) : 'A0',
    row: (latest?.row ?? 1) + 1,
    usedCodes: filled.map((item) => item.code)
  }
}

export function buildSeriesCodeReservePlan(
  rows: SeriesCodeGridRow[],
  selectedCode: string,
  requiredReserveCount = 10
): SeriesCodeReservePlan {
  const normalizedSelected = selectedCode.trim().toUpperCase()
  if (!isValidSeriesCode(normalizedSelected)) {
    return { anchorCode: normalizedSelected, requiredReserveCount, availableReserveCodes: [], supplementWrites: [] }
  }
  const entries = rows.flatMap((item) => {
    const code = (item.values[0] ?? '').trim().toUpperCase()
    return isValidSeriesCode(code)
      ? [{ row: item.row, code, used: Boolean((item.values[1] ?? '').trim() || (item.values[2] ?? '').trim()) }]
      : []
  })
  const occupied = [...new Set(entries.filter((entry) => entry.used).map((entry) => entry.code))]
  const anchorCode = [...occupied, normalizedSelected].sort(compareSeriesCodes).at(-1) ?? normalizedSelected
  const existingCodes = new Set(entries.map((entry) => entry.code))
  const desiredCodes: string[] = []
  let cursor = anchorCode
  while (desiredCodes.length < requiredReserveCount) {
    cursor = nextSeriesCode(cursor)
    desiredCodes.push(cursor)
  }
  const availableReserveCodes = desiredCodes.filter((code) => existingCodes.has(code))
  let targetRow = Math.max(1, ...rows.map((row) => row.row)) + 1
  const supplementWrites = desiredCodes
    .filter((code) => !existingCodes.has(code))
    .map((code) => {
      const write = { row: targetRow, address: `A${targetRow}`, code }
      targetRow += 1
      return write
    })
  return { anchorCode, requiredReserveCount, availableReserveCodes, supplementWrites }
}

function parseSeriesCode(value: string): { letterIndex: number; number: number } | null {
  const match = SERIES_CODE_PATTERN.exec(value.trim().toUpperCase())
  if (!match?.[1] || match[2] === undefined) return null
  return { letterIndex: match[1].charCodeAt(0) - 65, number: Number(match[2]) }
}

function letter(index: number): string {
  return String.fromCharCode(65 + index)
}
