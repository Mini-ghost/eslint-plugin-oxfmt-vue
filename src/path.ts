import { relative } from 'node:path'

export function toPosixRelativePath(from: string, path: string) {
  return relative(from, path).replaceAll('\\', '/')
}
