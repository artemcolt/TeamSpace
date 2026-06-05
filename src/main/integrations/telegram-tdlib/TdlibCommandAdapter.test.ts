import { describe, expect, it } from 'vitest';
import { FakeTdlibClient } from './FakeTdlibClient';
import { TdlibCommandAdapter } from './TdlibCommandAdapter';
import { TdlibMediaService } from './TdlibMediaService';

describe('TdlibCommandAdapter', () => {
  it('sends text messages with reply metadata', async () => {
    const client = new FakeTdlibClient();
    client.replyTo('sendMessage', { '@type': 'message', id: 9, chat_id: 42 });
    const adapter = new TdlibCommandAdapter(client);

    await adapter.sendMessage({ chatId: '42', topicId: null, text: 'Ready', replyToMessageId: '42:7' });

    expect(client.sentRequests()[0]).toMatchObject({
      '@type': 'sendMessage',
      chat_id: 42,
      reply_to: {
        '@type': 'inputMessageReplyToMessage',
        message_id: 7
      },
      input_message_content: {
        '@type': 'inputMessageText',
        text: { '@type': 'formattedText', text: 'Ready', entities: [] },
        clear_draft: true
      }
    });
  });

  it('sends topic text messages through the topic root reply target', async () => {
    const client = new FakeTdlibClient();
    client.replyTo('sendMessage', { '@type': 'message', id: 10, chat_id: 42 });
    const adapter = new TdlibCommandAdapter(client);

    await adapter.sendMessage({ chatId: '42', topicId: '100', text: 'Topic update' });

    expect(client.sentRequests()[0]).toMatchObject({
      '@type': 'sendMessage',
      chat_id: 42,
      reply_to: {
        '@type': 'inputMessageReplyToMessage',
        message_id: 100
      }
    });
  });

  it('sends emoji reactions', async () => {
    const client = new FakeTdlibClient();
    client.replyTo('addMessageReaction', { '@type': 'ok' });
    const adapter = new TdlibCommandAdapter(client);

    await adapter.reactToMessage({ messageId: '42:7', emoticon: '👍' });

    expect(client.sentRequests()[0]).toMatchObject({
      '@type': 'addMessageReaction',
      chat_id: 42,
      message_id: 7,
      reaction_type: { '@type': 'reactionTypeEmoji', emoji: '👍' },
      is_big: false,
      update_recent_reactions: true
    });
  });
});

describe('TdlibMediaService', () => {
  it('downloads files synchronously and returns the local TDLib path', async () => {
    const client = new FakeTdlibClient();
    client.replyTo('downloadFile', {
      '@type': 'file',
      id: 11,
      local: { path: '/tmp/telegram/report.pdf' }
    });
    const media = new TdlibMediaService(client);

    await expect(media.downloadFile({ fileId: 11, priority: 16 })).resolves.toEqual({
      filePath: '/tmp/telegram/report.pdf'
    });
    expect(client.sentRequests()[0]).toEqual({
      '@type': 'downloadFile',
      file_id: 11,
      priority: 16,
      offset: 0,
      limit: 0,
      synchronous: true
    });
  });
});
