import { describe, expect, it } from 'vitest';
import { tdlibChatToSummary, tdlibMessageToView } from './TdlibMapper';

describe('TdlibMapper', () => {
  it('maps a TDLib chat into a Team Space chat summary', () => {
    expect(tdlibChatToSummary({
      '@type': 'chat',
      id: 42,
      title: 'Backend',
      type: { '@type': 'chatTypeSupergroup', is_channel: false },
      unread_count: 3,
      last_message: { date: 1780638000 },
      photo: { small: { id: 10 } }
    }, { selected: true, notificationsEnabled: false, hasTopics: true })).toEqual({
      id: '42',
      title: 'Backend',
      type: 'group',
      avatar: null,
      selected: true,
      notificationsEnabled: false,
      hasTopics: true,
      unreadCount: 3,
      lastMessageAt: '2026-06-05T05:40:00.000Z'
    });
  });

  it('maps text messages without downloading files', () => {
    expect(tdlibMessageToView({
      '@type': 'message',
      id: 77,
      chat_id: 42,
      date: 1780638000,
      is_outgoing: false,
      sender_id: { '@type': 'messageSenderUser', user_id: 9 },
      content: {
        '@type': 'messageText',
        text: { text: 'Fix release notes' }
      }
    }, { senderName: 'Dasha', topicId: null, status: 'new' })).toMatchObject({
      id: '42:77',
      chatId: '42',
      topicId: null,
      senderId: '9',
      senderName: 'Dasha',
      text: 'Fix release notes',
      attachments: [],
      status: 'new'
    });
  });

  it('maps delivery status only for TDLib sending states', () => {
    const baseMessage = {
      '@type': 'message',
      id: 77,
      chat_id: 42,
      date: 1780638000,
      is_outgoing: false,
      sender_id: { '@type': 'messageSenderUser', user_id: 9 },
      content: {
        '@type': 'messageText',
        text: { text: 'Fix release notes' }
      }
    };
    const context = { senderName: 'Dasha', topicId: null, status: 'new' as const };

    expect(tdlibMessageToView(baseMessage, context)?.deliveryStatus).toBeUndefined();
    expect(tdlibMessageToView({
      ...baseMessage,
      sending_state: { '@type': 'messageSendingStatePending' }
    }, context)?.deliveryStatus).toBe('sending');
    expect(tdlibMessageToView({
      ...baseMessage,
      sending_state: { '@type': 'messageSendingStateFailed' }
    }, context)?.deliveryStatus).toBe('failed');
  });

  it('defaults supergroup and channel topics to false unless local context enables them', () => {
    const supergroupChat = {
      '@type': 'chat',
      id: 42,
      title: 'Backend',
      type: { '@type': 'chatTypeSupergroup', is_channel: false },
      unread_count: 0
    };
    const channelChat = {
      ...supergroupChat,
      id: 43,
      title: 'Announcements',
      type: { '@type': 'chatTypeSupergroup', is_channel: true }
    };

    expect(tdlibChatToSummary(supergroupChat, {
      selected: false,
      notificationsEnabled: true
    }).hasTopics).toBe(false);
    expect(tdlibChatToSummary(channelChat, {
      selected: false,
      notificationsEnabled: true
    }).hasTopics).toBe(false);
    expect(tdlibChatToSummary(supergroupChat, {
      selected: false,
      notificationsEnabled: true,
      hasTopics: true
    }).hasTopics).toBe(true);
  });

  it('maps sticker and video content into attachment metadata', () => {
    const context = { senderName: 'Dasha', topicId: null, status: 'new' as const };

    expect(tdlibMessageToView({
      '@type': 'message',
      id: 78,
      chat_id: 42,
      date: 1780638000,
      is_outgoing: false,
      sender_id: { '@type': 'messageSenderUser', user_id: 9 },
      content: {
        '@type': 'messageSticker',
        sticker: {
          sticker: { id: 100, size: 2048 }
        }
      }
    }, context)?.attachments).toEqual([{
      id: '42:78:attachment',
      type: 'sticker',
      fileName: 'sticker.webp',
      mimeType: 'image/webp',
      size: 2048,
      dataUrl: null
    }]);

    expect(tdlibMessageToView({
      '@type': 'message',
      id: 79,
      chat_id: 42,
      date: 1780638000,
      is_outgoing: false,
      sender_id: { '@type': 'messageSenderUser', user_id: 9 },
      content: {
        '@type': 'messageVideo',
        video: {
          file_name: 'demo.mp4',
          mime_type: 'video/mp4',
          video: { id: 101, size: 4096 }
        }
      }
    }, context)?.attachments).toEqual([{
      id: '42:79:attachment',
      type: 'file',
      fileName: 'demo.mp4',
      mimeType: 'video/mp4',
      size: 4096,
      dataUrl: null
    }]);
  });

  it('returns null for unsupported empty media', () => {
    expect(tdlibMessageToView({
      '@type': 'message',
      id: 80,
      chat_id: 42,
      date: 1780638000,
      is_outgoing: false,
      sender_id: { '@type': 'messageSenderUser', user_id: 9 },
      content: { '@type': 'messageAudio' }
    }, { senderName: 'Dasha', topicId: null, status: 'new' })).toBeNull();
  });

  it('returns null for malformed message dates and chat last message dates', () => {
    expect(tdlibMessageToView({
      '@type': 'message',
      id: 81,
      chat_id: 42,
      date: Number.NaN,
      is_outgoing: false,
      sender_id: { '@type': 'messageSenderUser', user_id: 9 },
      content: {
        '@type': 'messageText',
        text: { text: 'Broken date' }
      }
    }, { senderName: 'Dasha', topicId: null, status: 'new' })).toBeNull();

    expect(tdlibChatToSummary({
      '@type': 'chat',
      id: 44,
      title: 'Malformed',
      type: { '@type': 'chatTypePrivate' },
      unread_count: 0,
      last_message: { date: Number.NaN }
    }, { selected: false, notificationsEnabled: true }).lastMessageAt).toBeNull();
  });
});
