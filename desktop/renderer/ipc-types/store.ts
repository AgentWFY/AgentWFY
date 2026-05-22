export interface StoreApi {
  get<T = unknown>(key: string): Promise<T>
  set<T = unknown>(key: string, value: T): Promise<void>
  remove(key: string): Promise<void>
}
