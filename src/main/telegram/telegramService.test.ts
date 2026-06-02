import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultState } from '../domain/appState';
import type { AppState } from '../domain/types';
import type { LocalStore } from '../storage/localStore';
import { TelegramService } from './telegramService';

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

    await expect(service.sync()).rejects.toThrow('Telegram api_id/api_hash не сохранены');

    expect(store.setState).toHaveBeenCalledOnce();
    expect(store.getState().telegram).toMatchObject({
      status: 'error',
      hasApiCredentials: false,
      error: 'Telegram api_id/api_hash не сохранены. Откройте настройки Telegram и сохраните ключи заново.'
    });
  });
});
