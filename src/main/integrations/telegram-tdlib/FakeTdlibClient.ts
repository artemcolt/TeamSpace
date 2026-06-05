import type { TdlibClient } from './TdlibClient';
import type { TdlibRequest, TdlibResponse, TdlibUpdate } from './tdlibTypes';

function cloneTdlibValue<T>(value: T): T {
  return structuredClone(value);
}

export class FakeTdlibClient implements TdlibClient {
  private readonly requests: TdlibRequest[] = [];
  private readonly responses = new Map<string, TdlibResponse[]>();
  private readonly updates: TdlibUpdate[] = [];

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async send<T extends TdlibResponse = TdlibResponse>(request: TdlibRequest): Promise<T> {
    this.requests.push(cloneTdlibValue(request));
    const queue = this.responses.get(request['@type']) ?? [];
    const response = queue.shift();
    if (!response) {
      throw new Error(`No fake TDLib response for ${request['@type']}`);
    }
    return cloneTdlibValue(response) as T;
  }

  async receive(): Promise<TdlibUpdate | null> {
    const update = this.updates.shift();
    return update ? cloneTdlibValue(update) : null;
  }

  replyTo(type: string, response: TdlibResponse): void {
    const queue = this.responses.get(type) ?? [];
    queue.push(cloneTdlibValue(response));
    this.responses.set(type, queue);
  }

  pushUpdate(update: TdlibUpdate): void {
    this.updates.push(cloneTdlibValue(update));
  }

  sentRequests(): TdlibRequest[] {
    return cloneTdlibValue(this.requests);
  }
}
