import type { TdlibRequest, TdlibResponse, TdlibUpdate } from './tdlibTypes';

export interface TdlibClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  send<T extends TdlibResponse = TdlibResponse>(request: TdlibRequest): Promise<T>;
  receive(): Promise<TdlibUpdate | null>;
}
