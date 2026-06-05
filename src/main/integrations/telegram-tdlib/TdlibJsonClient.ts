import { randomUUID } from 'node:crypto';
import koffi from 'koffi';
import type { TdlibClient } from './TdlibClient';
import type { TdlibRequest, TdlibResponse, TdlibUpdate } from './tdlibTypes';

export type TdlibJsonBinding = {
  createClientId: () => number;
  send: (clientId: number, request: string) => void;
  receive: (timeoutSeconds: number) => string | null;
};

export type TdlibJsonBindingLoader = (libraryPath: string) => TdlibJsonBinding;

type PendingRequest = {
  resolve: (response: TdlibResponse) => void;
  reject: (error: Error) => void;
};

function loadKoffiBinding(libraryPath: string): TdlibJsonBinding {
  try {
    const library = koffi.load(libraryPath);
    return {
      createClientId: library.func('td_create_client_id', 'int', []) as () => number,
      send: library.func('td_send', 'void', ['int', 'str']) as (clientId: number, request: string) => void,
      receive: library.func('td_receive', 'str', ['double']) as (timeoutSeconds: number) => string | null
    };
  } catch (error) {
    throw new Error(
      `TDLib native binding is not available at ${libraryPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export class TdlibJsonClient implements TdlibClient {
  private clientId = 0;
  private readonly binding: TdlibJsonBinding;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly updateQueue: TdlibUpdate[] = [];
  private receiveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    libraryPath: string,
    loadBinding: TdlibJsonBindingLoader = loadKoffiBinding
  ) {
    this.binding = loadBinding(libraryPath);
  }

  async start(): Promise<void> {
    if (this.clientId !== 0) {
      return;
    }
    this.clientId = this.binding.createClientId();
    this.receiveTimer = setInterval(() => this.drainReceiveQueue(), 25);
  }

  async stop(): Promise<void> {
    if (this.receiveTimer) {
      clearInterval(this.receiveTimer);
      this.receiveTimer = null;
    }
    for (const pending of this.pending.values()) {
      pending.reject(new Error('TDLib client stopped.'));
    }
    this.pending.clear();
    this.updateQueue.length = 0;
    this.clientId = 0;
  }

  async send<T extends TdlibResponse = TdlibResponse>(request: TdlibRequest): Promise<T> {
    if (this.clientId === 0) {
      throw new Error('TDLib client is not started.');
    }
    const extra = typeof request['@extra'] === 'string' ? request['@extra'] : randomUUID();
    const requestWithExtra = { ...request, '@extra': extra };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(extra, {
        resolve: (response) => resolve(response as T),
        reject
      });
      try {
        this.binding.send(this.clientId, JSON.stringify(requestWithExtra));
      } catch (error) {
        this.pending.delete(extra);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async receive(): Promise<TdlibUpdate | null> {
    const queued = this.updateQueue.shift();
    if (queued) {
      return queued;
    }
    while (true) {
      const raw = this.binding.receive(0.1);
      if (!raw) {
        return null;
      }
      const object = JSON.parse(raw) as TdlibUpdate;
      if (!this.routeObject(object)) {
        return object;
      }
    }
  }

  private drainReceiveQueue(): void {
    while (true) {
      const raw = this.binding.receive(0);
      if (!raw) {
        return;
      }
      const object = JSON.parse(raw) as TdlibUpdate;
      if (!this.routeObject(object)) {
        this.updateQueue.push(object);
      }
    }
  }

  private routeObject(object: TdlibUpdate): boolean {
    const extra = typeof object['@extra'] === 'string' ? object['@extra'] : '';
    if (!extra) {
      return false;
    }
    const pending = this.pending.get(extra);
    if (!pending) {
      return false;
    }
    this.pending.delete(extra);
    if (object['@type'] === 'error') {
      pending.reject(new Error(typeof object.message === 'string' ? object.message : 'TDLib request failed.'));
      return true;
    }
    pending.resolve(object);
    return true;
  }
}
