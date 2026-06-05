import { describe, expect, it } from 'vitest';
import { FakeTdlibClient } from './FakeTdlibClient';
import type { TdlibAuthConfig } from './TdlibAuthService';
import { TdlibAuthService } from './TdlibAuthService';

const validConfig: TdlibAuthConfig = {
  apiId: 123,
  apiHash: 'hash',
  databaseDirectory: '/tmp/db',
  filesDirectory: '/tmp/files',
  databaseEncryptionKey: 'secret'
};

describe('TdlibAuthService', () => {
  it('sets TDLib parameters when requested by authorization state', async () => {
    const client = new FakeTdlibClient();
    client.replyTo('setTdlibParameters', { '@type': 'ok' });
    const service = new TdlibAuthService(client, {
      apiId: 123,
      apiHash: ' hash ',
      databaseDirectory: ' /tmp/team-space/tdlib ',
      filesDirectory: ' /tmp/team-space/tdlib-files ',
      databaseEncryptionKey: ' secret '
    });

    await service.handleAuthorizationState({ '@type': 'authorizationStateWaitTdlibParameters' });

    expect(client.sentRequests()[0]).toEqual({
      '@type': 'setTdlibParameters',
      use_test_dc: false,
      database_directory: '/tmp/team-space/tdlib',
      files_directory: '/tmp/team-space/tdlib-files',
      database_encryption_key: 'secret',
      use_file_database: true,
      use_chat_info_database: true,
      use_message_database: true,
      use_secret_chats: false,
      api_id: 123,
      api_hash: 'hash',
      system_language_code: 'ru',
      device_model: 'Team Space Desktop',
      system_version: process.platform,
      application_version: '0.1.0'
    });
  });

  it('submits phone number and code through TDLib auth methods', async () => {
    const client = new FakeTdlibClient();
    client.replyTo('setAuthenticationPhoneNumber', { '@type': 'ok' });
    client.replyTo('checkAuthenticationCode', { '@type': 'ok' });
    const service = new TdlibAuthService(client, validConfig);

    await service.setPhoneNumber('+79990000000');
    await service.checkCode('12345');

    expect(client.sentRequests().map((request) => request['@type'])).toEqual([
      'setAuthenticationPhoneNumber',
      'checkAuthenticationCode'
    ]);
  });

  it('ignores authorization states that do not request TDLib parameters', async () => {
    const client = new FakeTdlibClient();
    const service = new TdlibAuthService(client, validConfig);

    await service.handleAuthorizationState({ '@type': 'authorizationStateWaitPhoneNumber' });

    expect(client.sentRequests()).toEqual([]);
  });

  it('submits two-factor password through TDLib auth method', async () => {
    const client = new FakeTdlibClient();
    client.replyTo('checkAuthenticationPassword', { '@type': 'ok' });
    const service = new TdlibAuthService(client, validConfig);

    await service.checkPassword('secret-password');

    expect(client.sentRequests()).toEqual([{
      '@type': 'checkAuthenticationPassword',
      password: 'secret-password'
    }]);
  });

  it.each([
    ['apiId', { apiId: 0 }],
    ['apiId', { apiId: 1.5 }],
    ['apiHash', { apiHash: '   ' }],
    ['databaseDirectory', { databaseDirectory: '   ' }],
    ['filesDirectory', { filesDirectory: '   ' }],
    ['databaseEncryptionKey', { databaseEncryptionKey: '   ' }]
  ] satisfies Array<[string, Partial<TdlibAuthConfig>]>)('rejects invalid %s config', (field, override) => {
    expect(() => new TdlibAuthService(new FakeTdlibClient(), {
      ...validConfig,
      ...override
    })).toThrow(new RegExp(field));
  });
});
