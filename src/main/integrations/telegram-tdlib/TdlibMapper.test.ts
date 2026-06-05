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
    }, { selected: true, notificationsEnabled: false })).toEqual({
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
});
