type LogContext = Record<string, unknown>

function write(level: 'INFO' | 'WARN' | 'ERROR', message: string, context?: LogContext): void {
  const suffix = context ? ` ${JSON.stringify(context)}` : ''
  const line = `[${new Date().toISOString()}] [${level}] ${message}${suffix}`

  if (level === 'ERROR') {
    console.error(line)
  } else if (level === 'WARN') {
    console.warn(line)
  } else {
    console.info(line)
  }
}

export const logger = {
  info: (message: string, context?: LogContext): void => write('INFO', message, context),
  warn: (message: string, context?: LogContext): void => write('WARN', message, context),
  error: (message: string, context?: LogContext): void => write('ERROR', message, context)
}
