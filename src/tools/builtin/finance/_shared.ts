import type { ToolResult } from '../../../core/types.js'

export function jsonResult(value: unknown): ToolResult {
  return { success: true, output: JSON.stringify(value, null, 2) }
}

export function errorResult(error: unknown): ToolResult {
  return {
    success: false,
    output: '',
    error: error instanceof Error ? error.message : String(error),
  }
}
