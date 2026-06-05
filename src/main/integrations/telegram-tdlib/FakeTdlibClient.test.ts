import { describe, expect, it } from 'vitest';
import { FakeTdlibClient } from './FakeTdlibClient';

describe('FakeTdlibClient', () => {
  it('correlates sent requests and scripted responses', async () => {
    const client = new FakeTdlibClient();
    client.replyTo('getChats', { '@type': 'chats', chat_ids: ['1'], total_count: 1 });

    await expect(client.send({ '@type': 'getChats', limit: 20 })).resolves.toEqual({
      '@type': 'chats',
      chat_ids: ['1'],
      total_count: 1
    });
    expect(client.sentRequests()).toEqual([{ '@type': 'getChats', limit: 20 }]);
  });

  it('receives scripted updates in order', async () => {
    const client = new FakeTdlibClient();
    client.pushUpdate({ '@type': 'updateAuthorizationState', authorization_state: { '@type': 'authorizationStateReady' } });

    await expect(client.receive()).resolves.toEqual({
      '@type': 'updateAuthorizationState',
      authorization_state: { '@type': 'authorizationStateReady' }
    });
  });
});
