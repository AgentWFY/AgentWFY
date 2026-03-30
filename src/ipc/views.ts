import { ipcMain } from 'electron'
import { Channels } from './channels.js'

interface ViewFetchParams {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

export function registerViewHandlers(): void {
  ipcMain.handle(Channels.views.fetch, async (_event, params: ViewFetchParams) => {
    const { url, method, headers, body } = params
    if (typeof url !== 'string' || url.trim().length === 0) {
      throw new Error('fetch requires a non-empty url string')
    }
    const response = await fetch(url, {
      method: method ?? 'GET',
      headers: headers ?? undefined,
      body: body ?? undefined,
    })
    return { status: response.status, body: await response.text() }
  })
}
