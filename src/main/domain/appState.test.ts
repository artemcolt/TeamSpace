import { describe, expect, it } from 'vitest';
import { defaultState, telegramUnreadNotificationCount } from './appState';
import type { TelegramChat } from './types';

function chat(overrides: Partial<TelegramChat>): TelegramChat {
  return {
    id: 'chat',
    title: 'Chat',
    type: 'group',
    avatar: null,
    hasTopics: false,
    selected: true,
    notificationsEnabled: true,
    lastSyncedAt: null,
    lastMessageAt: null,
    unreadCount: 0,
    ...overrides
  };
}

describe('telegramUnreadNotificationCount', () => {
  it('counts unread messages only in selected chats with enabled notifications', () => {
    const state = defaultState();
    state.telegram.chats = [
      chat({ id: 'selected_enabled', unreadCount: 3 }),
      chat({ id: 'selected_muted', notificationsEnabled: false, unreadCount: 5 }),
      chat({ id: 'unselected_enabled', selected: false, unreadCount: 7 }),
      chat({ id: 'selected_enabled_negative', unreadCount: -2 })
    ];

    expect(telegramUnreadNotificationCount(state.telegram)).toBe(3);
  });
});
