export interface AuthApi {
  readConfig(): Promise<string>
  writeConfig(content: string): Promise<void>
  readLegacyKey(): Promise<string>
}
