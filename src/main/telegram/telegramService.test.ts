import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultState } from '../domain/appState';
import type { AppState } from '../domain/types';
import type { LocalStore } from '../storage/localStore';
import { parseTelegramProxy, TelegramService } from './telegramService';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp')
  }
}));

function createStore(initialState: AppState = defaultState()) {
  let state = structuredClone(initialState);
  return {
    getState: vi.fn(() => structuredClone(state)),
    getSecret: vi.fn(() => null),
    setState: vi.fn((updater: (draft: AppState) => void) => {
      updater(state);
      return structuredClone(state);
    })
  } as unknown as LocalStore;
}

describe('TelegramService stored credentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks Telegram as error when stored credentials are missing', async () => {
    const store = createStore({
      ...defaultState(),
      telegram: {
        ...defaultState().telegram,
        status: 'connected',
        hasApiCredentials: true
      }
    });
    const service = new TelegramService(store);

    await expect(service.sync()).rejects.toThrow('Telegram api_id/api_hash не настроены');

    expect(store.setState).toHaveBeenCalledOnce();
    expect(store.getState().telegram).toMatchObject({
      status: 'error',
      hasApiCredentials: false,
      error: 'Telegram api_id/api_hash не настроены. Заполните TELEGRAM_API_ID и TELEGRAM_API_HASH в .env.'
    });
  });
});

describe('parseTelegramProxy', () => {
  it('supports Telegram MTProxy deep links', () => {
    expect(parseTelegramProxy('https://t.me/proxy?server=203.0.113.10&port=9443&secret=secret-value')).toEqual({
      ip: '203.0.113.10',
      port: 9443,
      secret: 'secret-value',
      MTProxy: true,
      timeout: 10
    });
  });

  it('supports mtproxy URLs', () => {
    expect(parseTelegramProxy('mtproxy://203.0.113.10:9443?secret=secret-value')).toEqual({
      ip: '203.0.113.10',
      port: 9443,
      secret: 'secret-value',
      MTProxy: true,
      timeout: 10
    });
  });

  it('supports socks URLs with credentials', () => {
    expect(parseTelegramProxy('socks5://user:password@127.0.0.1:1080')).toEqual({
      ip: '127.0.0.1',
      port: 1080,
      socksType: 5,
      username: 'user',
      password: 'password',
      timeout: 10
    });
  });

  it('rejects MTProxy URLs without secret', () => {
    expect(() => parseTelegramProxy('mtproxy://203.0.113.10:9443')).toThrow('MTProxy требует secret.');
  });
});
