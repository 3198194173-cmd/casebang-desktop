/** Final table value: ASCII English letters separated by single spaces only. */
export function sanitizeEnglishPatternName(value: string): string {
  return sanitizeEnglishPatternNameInput(value).trim()
}

/** Editing value: keeps one trailing space so users can continue typing words. */
export function sanitizeEnglishPatternNameInput(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[^A-Za-z ]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/^ +/, '')
}

export function isValidEnglishPatternName(value: string): boolean {
  return /^[A-Za-z]+(?: [A-Za-z]+)*$/.test(value.trim())
}
