import type { WorkerGrepOptions } from '../runtime/types.js'

export interface FilesApi {
  read(path: string, offset?: number, limit?: number): Promise<string>
  write(path: string, content: string): Promise<string>
  writeBinary(path: string, base64: string): Promise<string>
  edit(path: string, oldText: string, newText: string): Promise<string>
  ls(path?: string, limit?: number): Promise<string>
  mkdir(path: string, recursive?: boolean): Promise<void>
  remove(path: string, recursive?: boolean): Promise<void>
  find(pattern: string, path?: string, limit?: number): Promise<string>
  grep(pattern: string, path?: string, options?: WorkerGrepOptions): Promise<string>
}
