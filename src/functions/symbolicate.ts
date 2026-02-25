export interface StackFrame {
  raw: string
  fileName?: string
  functionName?: string
  lineNumber?: number
  columnNumber?: number
}

export interface SourceMapObject {
  version: number
  sources: string[]
  sourcesContent?: string[]
  names: string[]
  mappings: string
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * Decode VLQ-encoded source map mappings string.
 * Returns flat array of delta values per line (groups of 1-5 concatenated).
 */
function decodeVLQ(mappings: string): number[][] {
  return mappings.split(';').map((line) => {
    if (!line) return []

    const values: number[] = []
    for (const segment of line.split(',')) {
      if (!segment) continue
      let value = 0
      let shift = 0
      for (const char of segment) {
        const digit = BASE64.indexOf(char)
        if (digit === -1) break
        const hasContinuation = !!(digit & 32)
        value += (digit & 31) << shift
        if (hasContinuation) {
          shift += 5
        } else {
          const shouldNegate = value & 1
          value >>>= 1
          values.push(shouldNegate ? -value : value)
          value = 0
          shift = 0
        }
      }
    }
    return values
  })
}

/**
 * Parse browser stack trace into structured frames.
 * Handles Chrome, Firefox, and Safari formats.
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

    // Firefox: "functionName@file:line:col"
    const firefoxMatch = trimmed.match(/^(.+?)@(.+?):(\d+):(\d+)$/)
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
  sourceMap: SourceMapObject,
  generatedLine: number,
  generatedColumn: number,
): { source: string; line: number; column: number; name?: string } | null {
  try {
    const mappings = decodeVLQ(sourceMap.mappings)
    const targetLine = generatedLine - 1
    const lineData = mappings[targetLine]
    if (!lineData || lineData.length === 0) return null

    let generatedCol = 0
    let sourceFile = 0
    let sourceLine = 0
    let sourceCol = 0
    let nameIndex = 0

    // Each group is 1-5 values. Advance i by the number of values in each group.
    // Groups are implicitly 4 or 5 values; we advance conservatively by checking length.
    let i = 0
    while (i < lineData.length) {
      generatedCol += lineData[i]

      if (generatedCol > generatedColumn) break

      if (i + 1 < lineData.length) sourceFile += lineData[i + 1]
      if (i + 2 < lineData.length) sourceLine += lineData[i + 2]
      if (i + 3 < lineData.length) sourceCol += lineData[i + 3]
      if (i + 4 < lineData.length) nameIndex += lineData[i + 4]

      i += 5
    }

    const source = sourceMap.sources[sourceFile] ?? 'unknown'
    const name = sourceMap.names[nameIndex]

    return { source, line: sourceLine + 1, column: sourceCol, name }
  } catch {
    return null
  }
}

/**
 * Apply source map to all frames in a stack trace.
 */
export function symbolicateStackTrace(
  frames: StackFrame[],
  sourceMap: SourceMapObject,
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
