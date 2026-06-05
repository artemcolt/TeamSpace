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
    setSecret: vi.fn(),
    deleteSecret: vi.fn(),
    getTelegramAvatar: vi.fn(() => null),
    saveTelegramAvatar: vi.fn(),
    setState: vi.fn((updater: (draft: AppState) => void) => {
      updater(state);
      return structuredClone(state);
    })
  } as unknown as LocalStore;
}

function telegramMessage(overrides: Partial<AppState['telegram']['messages'][number]>): AppState['telegram']['messages'][number] {
  return {
    id: 'chat_1:1',
    chatId: 'chat_1',
    topicId: null,
    senderId: null,
    senderName: 'Sender',
    senderAvatar: null,
    sentAt: '2026-06-01T10:00:00.000Z',
    text: 'Message',
    status: 'new',
    createdAt: '2026-06-01T10:00:00.000Z',
    updatedAt: '2026-06-01T10:00:00.000Z',
    ...overrides
  };
}

function installReadPathStubs(service: TelegramService, store: LocalStore) {
  const client = {
    markAsRead: vi.fn(async () => undefined),
    session: { save: vi.fn(() => '') }
  };
  vi.spyOn(service as unknown as { getStoredClient: () => Promise<typeof client> }, 'getStoredClient')
    .mockResolvedValue(client);
  vi.spyOn(service as unknown as { findDialog: () => Promise<{ entity: object }> }, 'findDialog')
    .mockResolvedValue({ entity: {} });
  vi.spyOn(service as unknown as {
    loadMessagesForDialog: () => Promise<AppState['telegram']['messages']>;
  }, 'loadMessagesForDialog')
    .mockImplementation(async () => store.getState().telegram.messages);
  return client;
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

describe('TelegramService workspace sync', () => {
  it('exposes focused inbox methods during TDLib migration', async () => {
    const store = createStore();
    const service = new TelegramService(store);

    await expect(service.getInboxSnapshot()).resolves.toMatchObject({
      status: store.getState().telegram.status,
      chats: [],
      topics: [],
      unread: { selectedUnreadCount: 0, notifyingUnreadCount: 0 }
    });
  });

  it('counts unread inbox totals for selected notifying chats', async () => {
    const state = defaultState();
    state.telegram.chats = [
      {
        id: 'selected_notify',
        title: 'Selected Notify',
        type: 'group',
        avatar: null,
        hasTopics: false,
        selected: true,
        notificationsEnabled: true,
        lastSyncedAt: null,
        lastMessageAt: '2026-06-01T10:00:00.000Z',
        unreadCount: 3
      },
      {
        id: 'selected_muted',
        title: 'Selected Muted',
        type: 'group',
        avatar: null,
        hasTopics: false,
        selected: true,
        notificationsEnabled: false,
        lastSyncedAt: null,
        lastMessageAt: '2026-06-01T10:30:00.000Z',
        unreadCount: 5
      },
      {
        id: 'unselected_notify',
        title: 'Unselected Notify',
        type: 'group',
        avatar: null,
        hasTopics: false,
        selected: false,
        notificationsEnabled: true,
        lastSyncedAt: null,
        lastMessageAt: '2026-06-01T11:00:00.000Z',
        unreadCount: 7
      }
    ];
    const store = createStore(state);
    const service = new TelegramService(store);

    await expect(service.getInboxSnapshot()).resolves.toMatchObject({
      unread: {
        selectedUnreadCount: 8,
        notifyingUnreadCount: 3
      }
    });
  });

  it('loads a focused thread without clearing unread counts', async () => {
    const state = defaultState();
    state.telegram.chats = [
      {
        id: 'chat_1',
        title: 'Team Chat',
        type: 'group',
        avatar: null,
        hasTopics: false,
        selected: true,
        notificationsEnabled: true,
        lastSyncedAt: null,
        lastMessageAt: '2026-06-01T10:00:00.000Z',
        unreadCount: 3
      }
    ];
    state.telegram.messages = [
      telegramMessage({ id: 'chat_1:1', sentAt: '2026-06-01T10:00:00.000Z' })
    ];
    const store = createStore(state);
    const service = new TelegramService(store);
    const client = installReadPathStubs(service, store);

    await expect(service.getThread({ chatId: 'chat_1', topicId: null })).resolves.toMatchObject({
      key: { chatId: 'chat_1', topicId: null },
      messages: [{ id: 'chat_1:1' }]
    });

    expect(client.markAsRead).not.toHaveBeenCalled();
    expect(store.getState().telegram.chats[0]?.unreadCount).toBe(3);
  });

  it('marks a topic thread read without clearing sibling topic or chat remainder', async () => {
    const state = defaultState();
    state.telegram.chats = [
      {
        id: 'chat_1',
        title: 'Team Chat',
        type: 'group',
        avatar: null,
        hasTopics: true,
        selected: true,
        notificationsEnabled: true,
        lastSyncedAt: null,
        lastMessageAt: '2026-06-01T10:00:00.000Z',
        unreadCount: 7
      }
    ];
    state.telegram.topics = [
      {
        id: 'chat_1:topic:1',
        chatId: 'chat_1',
        title: 'Support',
        topMessageId: '1',
        unreadCount: 3,
        lastMessageAt: '2026-06-01T10:00:00.000Z'
      },
      {
        id: 'chat_1:topic:2',
        chatId: 'chat_1',
        title: 'Deploys',
        topMessageId: '2',
        unreadCount: 4,
        lastMessageAt: '2026-06-01T10:30:00.000Z'
      }
    ];
    const store = createStore(state);
    const service = new TelegramService(store);
    const client = installReadPathStubs(service, store);

    await service.markThreadRead({ chatId: 'chat_1', topicId: 'chat_1:topic:1' });

    const telegram = store.getState().telegram;
    expect(client.markAsRead).not.toHaveBeenCalled();
    expect(telegram.chats[0]?.unreadCount).toBe(4);
    expect(telegram.topics.find((topic) => topic.id === 'chat_1:topic:1')?.unreadCount).toBe(0);
    expect(telegram.topics.find((topic) => topic.id === 'chat_1:topic:2')?.unreadCount).toBe(4);
  });

  it('returns the newest limited thread messages in chronological order with hasOlder', async () => {
    const state = defaultState();
    state.telegram.chats = [
      {
        id: 'chat_1',
        title: 'Team Chat',
        type: 'group',
        avatar: null,
        hasTopics: false,
        selected: true,
        notificationsEnabled: true,
        lastSyncedAt: null,
        lastMessageAt: '2026-06-01T10:03:00.000Z',
        unreadCount: 0
      }
    ];
    state.telegram.messages = [
      telegramMessage({ id: 'chat_1:1', sentAt: '2026-06-01T10:00:00.000Z', text: 'First' }),
      telegramMessage({ id: 'chat_1:2', sentAt: '2026-06-01T10:01:00.000Z', text: 'Second' }),
      telegramMessage({ id: 'chat_1:3', sentAt: '2026-06-01T10:02:00.000Z', text: 'Third' }),
      telegramMessage({ id: 'chat_1:4', sentAt: '2026-06-01T10:03:00.000Z', text: 'Fourth' })
    ];
    const store = createStore(state);
    const service = new TelegramService(store);
    installReadPathStubs(service, store);

    const thread = await service.getThread({ chatId: 'chat_1', topicId: null, limit: 2 });

    expect(thread.messages.map((message) => message.id)).toEqual(['chat_1:3', 'chat_1:4']);
    expect(thread.hasOlder).toBe(true);
  });

  it('returns cached focused thread messages when network refresh is delayed or failing', async () => {
    const state = defaultState();
    state.telegram.chats = [
      {
        id: 'chat_1',
        title: 'Team Chat',
        type: 'group',
        avatar: null,
        hasTopics: false,
        selected: true,
        notificationsEnabled: true,
        lastSyncedAt: '2026-06-01T09:00:00.000Z',
        lastMessageAt: '2026-06-01T10:00:00.000Z',
        unreadCount: 0
      }
    ];
    state.telegram.messages = [
      telegramMessage({ id: 'chat_1:1', text: 'Cached message' })
    ];
    const store = createStore(state);
    const service = new TelegramService(store);
    const refresh = vi.spyOn(service as unknown as {
      loadChatMessagesForCache: () => Promise<AppState>;
    }, 'loadChatMessagesForCache')
      .mockRejectedValue(new Error('network blocked'));

    await expect(service.getThread({ chatId: 'chat_1', topicId: null, limit: 50 })).resolves.toMatchObject({
      key: { chatId: 'chat_1', topicId: null },
      messages: [{ id: 'chat_1:1', text: 'Cached message' }]
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('keeps selected cached chats when Telegram does not return them in the dialog batch', async () => {
    const state = defaultState();
    state.telegram.chats = [
      {
        id: 'cached_chat',
        title: 'Cached Team Chat',
        type: 'group',
        avatar: null,
        hasTopics: true,
        selected: true,
        notificationsEnabled: true,
        lastSyncedAt: '2026-06-01T10:00:00.000Z',
        lastMessageAt: '2026-06-01T10:00:00.000Z',
        unreadCount: 4
      },
      {
        id: 'unselected_cached_chat',
        title: 'Unselected Chat',
        type: 'group',
        avatar: null,
        hasTopics: false,
        selected: false,
        notificationsEnabled: true,
        lastSyncedAt: '2026-06-01T09:00:00.000Z',
        lastMessageAt: '2026-06-01T09:00:00.000Z',
        unreadCount: 0
      }
    ];
    state.telegram.topics = [
      {
        id: 'cached_chat:topic:1',
        chatId: 'cached_chat',
        title: 'Support',
        topMessageId: '1',
        unreadCount: 1,
        lastMessageAt: '2026-06-01T10:00:00.000Z'
      }
    ];
    const store = createStore(state);
    const service = new TelegramService(store);
    const loadWorkspace = Reflect.get(service, 'loadWorkspace') as (
      client: { getDialogs: () => Promise<unknown[]>; invoke: () => Promise<unknown> },
      existingState: AppState['telegram']
    ) => Promise<Pick<AppState['telegram'], 'chats' | 'topics'>>;

    const workspace = await loadWorkspace.call(
      service,
      {
        getDialogs: vi.fn(async () => []),
        invoke: vi.fn(async () => ({ filters: [] }))
      },
      state.telegram
    );

    expect(workspace.chats.map((chat) => chat.id)).toEqual(['cached_chat']);
    expect(workspace.chats[0]).toMatchObject({
      selected: true,
      title: 'Cached Team Chat',
      unreadCount: 4
    });
    expect(workspace.topics.map((topic) => topic.id)).toEqual(['cached_chat:topic:1']);
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
