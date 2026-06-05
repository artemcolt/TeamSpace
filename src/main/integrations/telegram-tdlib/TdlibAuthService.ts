import type { TdlibClient } from './TdlibClient';
import type { TdlibObject } from './tdlibTypes';

export interface TdlibAuthConfig {
  apiId: number;
  apiHash: string;
  databaseDirectory: string;
  filesDirectory: string;
  databaseEncryptionKey: string;
}

function normalizeRequiredString(field: keyof TdlibAuthConfig, value: string): string {
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    throw new Error(`Invalid TDLib auth config: ${field} must be non-empty`);
  }
  return normalizedValue;
}

function normalizeConfig(config: TdlibAuthConfig): TdlibAuthConfig {
  if (!Number.isInteger(config.apiId) || config.apiId <= 0) {
    throw new Error('Invalid TDLib auth config: apiId must be a positive integer');
  }

  return {
    apiId: config.apiId,
    apiHash: normalizeRequiredString('apiHash', config.apiHash),
    databaseDirectory: normalizeRequiredString('databaseDirectory', config.databaseDirectory),
    filesDirectory: normalizeRequiredString('filesDirectory', config.filesDirectory),
    databaseEncryptionKey: normalizeRequiredString('databaseEncryptionKey', config.databaseEncryptionKey)
  };
}

export class TdlibAuthService {
  private readonly config: TdlibAuthConfig;

  constructor(
    private readonly client: TdlibClient,
    config: TdlibAuthConfig
  ) {
    this.config = normalizeConfig(config);
  }

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
