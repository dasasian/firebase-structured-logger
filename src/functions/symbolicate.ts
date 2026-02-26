import { TraceMap, originalPositionFor, type EncodedSourceMap } from '@jridgewell/trace-mapping'

export interface StackFrame {
  raw: string
  fileName?: string
  functionName?: string
  lineNumber?: number
  columnNumber?: number
}


/**
 * Parse browser stack trace into structured frames.
 * Handles Chrome, Firefox, and Safari formats (including anonymous frames).
 */
export function parseStackTrace(stack: string): StackFrame[] {
  const frames: StackFrame[] = []

  for (const line of stack.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // Chrome: "at functionName (file:line:col)"
    const chromeMatch = trimmed.match(/^at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)$/)
    if (chromeMatch) {
      frames.push({
        raw: trimmed,
        functionName: chromeMatch[1],
        fileName: chromeMatch[2],
        lineNumber: parseInt(chromeMatch[3], 10),
        columnNumber: parseInt(chromeMatch[4], 10),
      })
      continue
    }

    // Chrome without function: "at file:line:col"
    const chromeSimple = trimmed.match(/^at\s+(.+?):(\d+):(\d+)$/)
    if (chromeSimple) {
      frames.push({
        raw: trimmed,
        functionName: 'anonymous',
        fileName: chromeSimple[1],
        lineNumber: parseInt(chromeSimple[2], 10),
        columnNumber: parseInt(chromeSimple[3], 10),
      })
      continue
    }

    // Firefox/Safari: "functionName@file:line:col" or "@file:line:col" (anonymous)
    const firefoxMatch = trimmed.match(/^(.*?)@(.+?):(\d+):(\d+)$/)
    if (firefoxMatch) {
      frames.push({
        raw: trimmed,
        functionName: firefoxMatch[1] || 'anonymous',
        fileName: firefoxMatch[2],
        lineNumber: parseInt(firefoxMatch[3], 10),
        columnNumber: parseInt(firefoxMatch[4], 10),
      })
      continue
    }

    frames.push({ raw: trimmed })
  }

  return frames
}

/**
 * Look up original source location for a generated line/column.
 */
export function symbolicate(
  sourceMap: EncodedSourceMap,
  generatedLine: number,
  generatedColumn: number,
): { source: string; line: number; column: number; name?: string } | null {
  try {
    const tracer = new TraceMap(sourceMap)
    const result = originalPositionFor(tracer, { line: generatedLine, column: generatedColumn })
    if (!result.source) return null
    return {
      source: result.source,
      line: result.line ?? generatedLine,
      column: result.column ?? generatedColumn,
      name: result.name ?? undefined,
    }
  } catch {
    return null
  }
}

/**
 * Apply source map to all frames in a stack trace.
 */
export function symbolicateStackTrace(
  frames: StackFrame[],
  sourceMap: EncodedSourceMap,
): StackFrame[] {
  return frames.map((frame) => {
    if (!frame.lineNumber || !frame.columnNumber || !frame.fileName) return frame
    if (!frame.fileName.includes('.js')) return frame

    const result = symbolicate(sourceMap, frame.lineNumber, frame.columnNumber)
    if (!result) return frame

    return {
      ...frame,
      fileName: result.source,
      lineNumber: result.line,
      columnNumber: result.column,
      functionName: result.name ?? frame.functionName,
    }
  })
}

/**
 * Format symbolicated frames back to a stack trace string.
 */
export function formatStackTrace(frames: StackFrame[]): string {
  return frames
    .map((frame) => {
      if (!frame.fileName) return frame.raw
      const func = frame.functionName ?? 'anonymous'
      return `    at ${func} (${frame.fileName}:${frame.lineNumber ?? '?'}:${frame.columnNumber ?? '?'})`
    })
    .join('\n')
}
