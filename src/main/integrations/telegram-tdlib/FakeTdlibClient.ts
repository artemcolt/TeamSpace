import type { TdlibClient } from './TdlibClient';
import type { TdlibRequest, TdlibResponse, TdlibUpdate } from './tdlibTypes';

export class FakeTdlibClient implements TdlibClient {
  private readonly requests: TdlibRequest[] = [];
  private readonly responses = new Map<string, TdlibResponse[]>();
  private readonly updates: TdlibUpdate[] = [];

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async send<T extends TdlibResponse = TdlibResponse>(request: TdlibRequest): Promise<T> {
    this.requests.push(request);
    const queue = this.responses.get(request['@type']) ?? [];
    const response = queue.shift();
    if (!response) {
      throw new Error(`No fake TDLib response for ${request['@type']}`);
    }
    return response as T;
  }

  async receive(): Promise<TdlibUpdate | null> {
    return this.updates.shift() ?? null;
  }

  replyTo(type: string, response: TdlibResponse): void {
    const queue = this.responses.get(type) ?? [];
    queue.push(response);
    this.responses.set(type, queue);
  }

  pushUpdate(update: TdlibUpdate): void {
    this.updates.push(update);
  }

  sentRequests(): TdlibRequest[] {
    return structuredClone(this.requests);
  }
}
