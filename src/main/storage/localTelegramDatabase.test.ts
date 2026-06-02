import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalTelegramDatabase } from './localTelegramDatabase';

const tempDirs: string[] = [];

describe('LocalTelegramDatabase', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes messages that are no longer present in the saved Telegram state', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-space-telegram-cache-'));
    tempDirs.push(dataDir);
    const db = new LocalTelegramDatabase();
    await db.initialize(dataDir);

    const telegramState = {
      chats: [
        {
          id: 'chat_1',
          title: 'Team',
          type: 'group' as const,
          avatar: null,
          hasTopics: false,
          selected: true,
          notificationsEnabled: true,
          lastSyncedAt: '2026-05-29T10:00:00.000Z',
          lastMessageAt: '2026-05-29T10:00:00.000Z',
          unreadCount: 0
        }
      ],
      topics: [],
      messages: [
        {
          id: 'chat_1:10',
          chatId: 'chat_1',
          topicId: null,
          replyToMessageId: null,
          replyToSenderName: null,
          replyToText: null,
          senderId: 'user_1',
          senderName: 'Иван',
          senderAvatar: null,
          sentAt: '2026-05-29T10:00:00.000Z',
          text: 'Оставить',
          attachments: [],
          status: 'new' as const,
          createdAt: '2026-05-29T10:00:00.000Z',
          updatedAt: '2026-05-29T10:00:00.000Z'
        },
        {
          id: 'chat_1:11',
          chatId: 'chat_1',
          topicId: null,
          replyToMessageId: null,
          replyToSenderName: null,
          replyToText: null,
          senderId: 'user_1',
          senderName: 'Иван',
          senderAvatar: null,
          sentAt: '2026-05-29T10:01:00.000Z',
          text: 'Удалить',
          attachments: [],
          status: 'new' as const,
          createdAt: '2026-05-29T10:01:00.000Z',
          updatedAt: '2026-05-29T10:01:00.000Z'
        }
      ],
      folders: [],
      selectedFolderId: null,
      status: 'connected' as const,
      phoneMasked: null,
      hasApiCredentials: true,
      codeRequested: false,
      codeDelivery: null,
      error: null
    };

    db.save(telegramState);
    expect(db.load().messages.map((message) => message.id)).toEqual(['chat_1:11', 'chat_1:10']);

    db.save({
      ...telegramState,
      messages: telegramState.messages.filter((message) => message.id !== 'chat_1:11')
    });

    expect(db.load().messages.map((message) => message.id)).toEqual(['chat_1:10']);
  });

  it('normalizes cached mp4 previews that were stored as jpeg images', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-space-telegram-cache-'));
    tempDirs.push(dataDir);
    const db = new LocalTelegramDatabase();
    await db.initialize(dataDir);
    const mp4Header = Buffer.from('00000018667479706d703432', 'hex').toString('base64');

    db.save({
      chats: [
        {
          id: 'chat_1',
          title: 'Team',
          type: 'group',
          avatar: null,
          hasTopics: false,
          selected: true,
          notificationsEnabled: true,
          lastSyncedAt: '2026-05-29T10:00:00.000Z',
          lastMessageAt: '2026-05-29T10:00:00.000Z',
          unreadCount: 0
        }
      ],
      topics: [],
      messages: [
        {
          id: 'chat_1:10',
          chatId: 'chat_1',
          topicId: null,
          replyToMessageId: null,
          replyToSenderName: null,
          replyToText: null,
          senderId: 'user_1',
          senderName: 'Иван',
          senderAvatar: null,
          sentAt: '2026-05-29T10:00:00.000Z',
          text: 'Видео',
          attachments: [{
            id: 'chat_1:10:attachment',
            type: 'image',
            fileName: 'image.jpg',
            mimeType: 'image/jpeg',
            size: 1024,
            dataUrl: `data:image/jpeg;base64,${mp4Header}`
          }],
          reactions: [],
          status: 'new',
          createdAt: '2026-05-29T10:00:00.000Z',
          updatedAt: '2026-05-29T10:00:00.000Z'
        }
      ],
      folders: [],
      selectedFolderId: null,
      status: 'connected',
      phoneMasked: null,
      hasApiCredentials: true,
      codeRequested: false,
      codeDelivery: null,
      error: null
    });

    expect(db.load().messages[0].attachments).toEqual([{
      id: 'chat_1:10:attachment',
      type: 'file',
      fileName: 'video.mp4',
      mimeType: 'video/mp4',
      size: 1024,
      dataUrl: `data:video/mp4;base64,${mp4Header}`
    }]);
  });
});
