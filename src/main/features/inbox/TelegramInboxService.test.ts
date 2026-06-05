import { describe, expect, it } from 'vitest';
import { FakeTdlibClient } from '../../integrations/telegram-tdlib/FakeTdlibClient';
import { InMemoryTelegramInboxRepository } from '../../storage/repositories/telegramInboxRepository';
import { TelegramInboxService } from './TelegramInboxService';

describe('TelegramInboxService', () => {
  it('builds an inbox snapshot from TDLib chats and local settings', async () => {
    const client = new FakeTdlibClient();
    client.replyTo('getChats', { '@type': 'chats', chat_ids: [42], total_count: 1 });
    client.replyTo('getChat', {
      '@type': 'chat',
      id: 42,
      title: 'Backend',
      type: { '@type': 'chatTypeSupergroup', is_channel: false },
      unread_count: 5,
      last_message: { date: 1780657200 }
    });
    const repository = new InMemoryTelegramInboxRepository();
    repository.selectWorkspaceChats(['42']);
    repository.setChatNotifications('42', false);
    const service = new TelegramInboxService(client, repository);

    await expect(service.getInboxSnapshot()).resolves.toMatchObject({
      status: 'connected',
      chats: [{
        id: '42',
        title: 'Backend',
        selected: true,
        notificationsEnabled: false,
        unreadCount: 5
      }],
      unread: {
        selectedUnreadCount: 5,
        notifyingUnreadCount: 0
      }
    });
  });

  it('loads a thread without marking it read', async () => {
    const client = new FakeTdlibClient();
    client.replyTo('getChatHistory', {
      '@type': 'messages',
      total_count: 1,
      messages: [{
        '@type': 'message',
        id: 7,
        chat_id: 42,
        date: 1780657200,
        is_outgoing: false,
        sender_id: { '@type': 'messageSenderUser', user_id: 9 },
        content: { '@type': 'messageText', text: { text: 'Need QA' } }
      }]
    });
    const service = new TelegramInboxService(client, new InMemoryTelegramInboxRepository());

    await expect(service.getThread({ chatId: '42', topicId: null, limit: 50 })).resolves.toMatchObject({
      key: { chatId: '42', topicId: null },
      messages: [{ id: '42:7', text: 'Need QA' }],
      hasOlder: false
    });
    expect(client.sentRequests().map((request) => request['@type'])).not.toContain('viewMessages');
  });

  it('preserves local workflow status when loading a thread', async () => {
    const client = new FakeTdlibClient();
    client.replyTo('getChatHistory', {
      '@type': 'messages',
      total_count: 1,
      messages: [{
        '@type': 'message',
        id: 7,
        chat_id: 42,
        date: 1780657200,
        is_outgoing: false,
        sender_id: { '@type': 'messageSenderUser', user_id: 9 },
        content: { '@type': 'messageText', text: { text: 'Need QA' } }
      }]
    });
    const repository = new InMemoryTelegramInboxRepository();
    repository.setMessageStatus({ messageId: '42:7', chatId: '42', topicId: null, status: 'created' });
    const service = new TelegramInboxService(client, repository);

    await expect(service.getThread({ chatId: '42', topicId: null })).resolves.toMatchObject({
      messages: [{ id: '42:7', status: 'created' }]
    });
  });

  it('filters TDLib messages that cannot be mapped to inbox views', async () => {
    const client = new FakeTdlibClient();
    client.replyTo('getChatHistory', {
      '@type': 'messages',
      total_count: 2,
      messages: [{
        '@type': 'message',
        id: 7,
        chat_id: 42,
        date: 1780657200,
        is_outgoing: false,
        sender_id: { '@type': 'messageSenderUser', user_id: 9 },
        content: { '@type': 'messageAudio' }
      }, {
        '@type': 'message',
        id: 8,
        chat_id: 42,
        date: 1780657210,
        is_outgoing: false,
        sender_id: { '@type': 'messageSenderUser', user_id: 9 },
        content: { '@type': 'messageText', text: { text: 'Supported' } }
      }]
    });
    const service = new TelegramInboxService(client, new InMemoryTelegramInboxRepository());

    await expect(service.getThread({ chatId: '42', topicId: 'topic-1' })).resolves.toMatchObject({
      messages: [{ id: '42:8', topicId: 'topic-1', text: 'Supported' }]
    });
  });
});
