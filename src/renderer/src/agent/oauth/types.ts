export interface OAuthCredentials {
  access: string
  refresh: string
  expires: number
  accountId?: string
}

export interface OAuthAuthInfo {
  url: string
  instructions?: string
}

export interface OAuthPromptInfo {
  message: string
}

export interface OAuthCallbacks {
  onAuth: (info: OAuthAuthInfo) => void
  onPrompt: (info: OAuthPromptInfo) => Promise<string>
  onProgress?: (msg: string) => void
}

export interface OAuthProvider {
  id: string
  name: string
  login: (callbacks: OAuthCallbacks) => Promise<OAuthCredentials>
  refreshToken: (credentials: OAuthCredentials) => Promise<OAuthCredentials>
  getApiKey: (credentials: OAuthCredentials) => string
}
