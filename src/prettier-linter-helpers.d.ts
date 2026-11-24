declare module 'prettier-linter-helpers' {
  export interface Difference {
    operation: 'insert' | 'delete' | 'replace'
    offset: number
    insertText?: string
    deleteText?: string
  }

  interface GenerateDifferences {
    (source: string, formatted: string): Difference[]
    readonly INSERT: 'insert'
    readonly DELETE: 'delete'
    readonly REPLACE: 'replace'
  }

  export const generateDifferences: GenerateDifferences

  export function showInvisibles(text: string): string
}
