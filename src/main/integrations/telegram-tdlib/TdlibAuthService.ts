import type { TdlibClient } from './TdlibClient';
import type { TdlibObject } from './tdlibTypes';

export interface TdlibAuthConfig {
  apiId: number;
  apiHash: string;
  databaseDirectory: string;
  filesDirectory: string;
  databaseEncryptionKey: string;
}

export class TdlibAuthService {
  constructor(
    private readonly client: TdlibClient,
    private readonly config: TdlibAuthConfig
  ) {}

  async handleAuthorizationState(state: TdlibObject): Promise<void> {
    if (state['@type'] !== 'authorizationStateWaitTdlibParameters') {
      return;
    }

    await this.client.send({
      '@type': 'setTdlibParameters',
      use_test_dc: false,
      database_directory: this.config.databaseDirectory,
      files_directory: this.config.filesDirectory,
      database_encryption_key: this.config.databaseEncryptionKey,
      use_file_database: true,
      use_chat_info_database: true,
      use_message_database: true,
      use_secret_chats: false,
      api_id: this.config.apiId,
      api_hash: this.config.apiHash,
      system_language_code: 'ru',
      device_model: 'Team Space Desktop',
      system_version: process.platform,
      application_version: '0.1.0'
    });
  }

  async setPhoneNumber(phoneNumber: string): Promise<void> {
    await this.client.send({
      '@type': 'setAuthenticationPhoneNumber',
      phone_number: phoneNumber
    });
  }

  async checkCode(code: string): Promise<void> {
    await this.client.send({
      '@type': 'checkAuthenticationCode',
      code
    });
  }

  async checkPassword(password: string): Promise<void> {
    await this.client.send({
      '@type': 'checkAuthenticationPassword',
      password
    });
  }
}
