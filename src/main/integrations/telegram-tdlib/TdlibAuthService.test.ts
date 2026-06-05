import { describe, expect, it } from 'vitest';
import { FakeTdlibClient } from './FakeTdlibClient';
import { TdlibAuthService } from './TdlibAuthService';

describe('TdlibAuthService', () => {
  it('sets TDLib parameters when requested by authorization state', async () => {
    const client = new FakeTdlibClient();
    client.replyTo('setTdlibParameters', { '@type': 'ok' });
    const service = new TdlibAuthService(client, {
      apiId: 123,
      apiHash: 'hash',
      databaseDirectory: '/tmp/team-space/tdlib',
      filesDirectory: '/tmp/team-space/tdlib-files',
      databaseEncryptionKey: 'secret'
    });

    await service.handleAuthorizationState({ '@type': 'authorizationStateWaitTdlibParameters' });

    expect(client.sentRequests()[0]).toMatchObject({
      '@type': 'setTdlibParameters',
      api_id: 123,
      api_hash: 'hash',
      use_file_database: true,
      use_chat_info_database: true,
      use_message_database: true
    });
  });

  it('submits phone number and code through TDLib auth methods', async () => {
    const client = new FakeTdlibClient();
    client.replyTo('setAuthenticationPhoneNumber', { '@type': 'ok' });
    client.replyTo('checkAuthenticationCode', { '@type': 'ok' });
    const service = new TdlibAuthService(client, {
      apiId: 123,
      apiHash: 'hash',
      databaseDirectory: '/tmp/db',
      filesDirectory: '/tmp/files',
      databaseEncryptionKey: 'secret'
    });

    await service.setPhoneNumber('+79990000000');
    await service.checkCode('12345');

    expect(client.sentRequests().map((request) => request['@type'])).toEqual([
      'setAuthenticationPhoneNumber',
      'checkAuthenticationCode'
    ]);
  });

  it('ignores authorization states that do not request TDLib parameters', async () => {
    const client = new FakeTdlibClient();
    const service = new TdlibAuthService(client, {
      apiId: 123,
      apiHash: 'hash',
      databaseDirectory: '/tmp/db',
      filesDirectory: '/tmp/files',
      databaseEncryptionKey: 'secret'
    });

    await service.handleAuthorizationState({ '@type': 'authorizationStateWaitPhoneNumber' });

    expect(client.sentRequests()).toEqual([]);
  });

  it('submits two-factor password through TDLib auth method', async () => {
    const client = new FakeTdlibClient();
    client.replyTo('checkAuthenticationPassword', { '@type': 'ok' });
    const service = new TdlibAuthService(client, {
      apiId: 123,
      apiHash: 'hash',
      databaseDirectory: '/tmp/db',
      filesDirectory: '/tmp/files',
      databaseEncryptionKey: 'secret'
    });

    await service.checkPassword('secret-password');

    expect(client.sentRequests()).toEqual([{
      '@type': 'checkAuthenticationPassword',
      password: 'secret-password'
    }]);
  });
});
