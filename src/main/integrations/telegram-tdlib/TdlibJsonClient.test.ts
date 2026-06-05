import { describe, expect, it } from 'vitest';
import { TdlibJsonClient, type TdlibJsonBinding } from './TdlibJsonClient';

function createBinding() {
  const sentRequests: Array<{ clientId: number; request: string }> = [];
  const receivedObjects: string[] = [];
  const binding: TdlibJsonBinding = {
    createClientId: () => 7,
    send: (clientId, request) => {
      sentRequests.push({ clientId, request });
    },
    receive: () => receivedObjects.shift() ?? null
  };
  return { binding, sentRequests, receivedObjects };
}

describe('TdlibJsonClient', () => {
  it('correlates sent requests with received responses by @extra', async () => {
    const { binding, sentRequests, receivedObjects } = createBinding();
    const client = new TdlibJsonClient('/tmp/libtdjson.dylib', () => binding);
    await client.start();

    const result = client.send({ '@type': 'getChats', limit: 1 });
    const sent = JSON.parse(sentRequests[0].request) as { '@extra': string };
    receivedObjects.push(JSON.stringify({ '@type': 'chats', '@extra': sent['@extra'], chat_ids: [] }));

    await expect(client.receive()).resolves.toBeNull();
    await expect(result).resolves.toEqual({ '@type': 'chats', '@extra': sent['@extra'], chat_ids: [] });
    expect(sentRequests[0].clientId).toBe(7);
  });

  it('rejects requests that receive TDLib errors', async () => {
    const { binding, sentRequests, receivedObjects } = createBinding();
    const client = new TdlibJsonClient('/tmp/libtdjson.dylib', () => binding);
    await client.start();

    const result = client.send({ '@type': 'getChat', chat_id: 42 });
    const sent = JSON.parse(sentRequests[0].request) as { '@extra': string };
    receivedObjects.push(JSON.stringify({
      '@type': 'error',
      '@extra': sent['@extra'],
      code: 404,
      message: 'Chat not found'
    }));

    await client.receive();
    await expect(result).rejects.toThrow('Chat not found');
  });

  it('returns updates that are not matched request responses', async () => {
    const { binding, receivedObjects } = createBinding();
    const client = new TdlibJsonClient('/tmp/libtdjson.dylib', () => binding);
    await client.start();
    receivedObjects.push(JSON.stringify({ '@type': 'updateNewMessage', message: { id: 9 } }));

    await expect(client.receive()).resolves.toEqual({
      '@type': 'updateNewMessage',
      message: { id: 9 }
    });
  });
});
