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

  it('includes selected chats that are missing from the first TDLib chat batch', async () => {
    const client = new FakeTdlibClient();
    client.replyTo('getChats', { '@type': 'chats', chat_ids: [], total_count: 0 });
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
    const service = new TelegramInboxService(client, repository);

    await expect(service.getInboxSnapshot()).resolves.toMatchObject({
      chats: [{
        id: '42',
        title: 'Backend',
        selected: true,
        unreadCount: 5
      }],
      unread: {
        selectedUnreadCount: 5,
        notifyingUnreadCount: 5
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

  it('loads a topic thread with getMessageThreadHistory', async () => {
    const client = new FakeTdlibClient();
    client.replyTo('getMessageThreadHistory', {
      '@type': 'messages',
      total_count: 1,
      messages: [{
        '@type': 'message',
        id: 8,
        chat_id: 42,
        date: 1780657210,
        is_outgoing: false,
        sender_id: { '@type': 'messageSenderUser', user_id: 9 },
        content: { '@type': 'messageText', text: { text: 'Topic reply' } }
      }]
    });
    const service = new TelegramInboxService(client, new InMemoryTelegramInboxRepository());

    await expect(service.getThread({ chatId: '42', topicId: '100', limit: 25 })).resolves.toMatchObject({
      key: { chatId: '42', topicId: '100' },
      messages: [{ id: '42:8', topicId: '100', text: 'Topic reply' }]
    });
    expect(client.sentRequests().map((request) => request['@type'])).toEqual(['getMessageThreadHistory']);
    expect(client.sentRequests()[0]).toMatchObject({
      '@type': 'getMessageThreadHistory',
      chat_id: 42,
      message_id: 100,
      limit: 25
    });
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

  it('uses raw TDLib pagination to report whether older messages exist', async () => {
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

    await expect(service.getThread({ chatId: '42', topicId: null })).resolves.toMatchObject({
      messages: [{ id: '42:8', topicId: null, text: 'Supported' }],
      hasOlder: false
    });
  });

  it.each([
    { requested: 0, sent: 1 },
    { requested: -2.7, sent: 1 },
    { requested: 12.9, sent: 12 },
    { requested: 150, sent: 100 }
  ])('clamps TDLib history limit $requested to $sent', async ({ requested, sent }) => {
    const client = new FakeTdlibClient();
    client.replyTo('getChatHistory', {
      '@type': 'messages',
      total_count: 0,
      messages: []
    });
    const service = new TelegramInboxService(client, new InMemoryTelegramInboxRepository());

    await service.getThread({ chatId: '42', topicId: null, limit: requested });

    expect(client.sentRequests()[0]).toMatchObject({
      '@type': 'getChatHistory',
      limit: sent
    });
  });
});
