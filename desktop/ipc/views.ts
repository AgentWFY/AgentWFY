import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { Channels } from './channels.cjs'
import { registerViewWsHeaders, type ViewWsHeaderRegistration } from '../protocol/view-ws-headers.js'

interface ViewFetchParams {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

export function registerViewHandlers(
  getAgentId: (e: IpcMainInvokeEvent) => string,
): void {
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

  ipcMain.handle(Channels.views.setWsHeaders, (event, params: ViewWsHeaderRegistration) => {
    registerViewWsHeaders(getAgentId(event), params)
  })
}
