export interface DialogApi {
  open(options: unknown): Promise<string[]>
  openExternal(url: string): Promise<void>
}
