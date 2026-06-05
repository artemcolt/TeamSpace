import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { now } from '../domain/appState';
import type {
  AppState,
  CachedTelegramAvatar,
  MessageStatus,
  TelegramChat,
  TelegramMessageAttachment,
  TelegramMessageReaction,
  TelegramTopic
} from '../domain/types';
import { SqlTelegramInboxRepository, type TelegramInboxRepository } from './repositories/telegramInboxRepository';

function sniffDataUrlMimeType(dataUrl: string | null): string | null {
  const match = dataUrl?.match(/^data:[^;,]+;base64,([A-Za-z0-9+/=]+)/);
  if (!match) {
    return null;
  }

  const buffer = Buffer.from(match[1].slice(0, 64), 'base64');
  if (buffer.length >= 8 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    return 'video/mp4';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 6 && buffer.toString('ascii', 0, 3) === 'GIF') {
    return 'image/gif';
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }

  return null;
}

function dataUrlWithMimeType(dataUrl: string | null, mimeType: string): string | null {
  const match = dataUrl?.match(/^data:[^;,]+;base64,([A-Za-z0-9+/=]+)$/);
  return match ? `data:${mimeType};base64,${match[1]}` : dataUrl;
}

function attachmentTypeForMimeType(
  mimeType: string,
  fileName: string,
  currentType: TelegramMessageAttachment['type']
): TelegramMessageAttachment['type'] {
  const normalizedMimeType = mimeType.toLowerCase();
  const normalizedFileName = fileName.toLowerCase();
  if (normalizedMimeType === 'video/mp4') {
    return 'file';
  }
  if (
    normalizedMimeType === 'video/webm' ||
    normalizedMimeType === 'image/webp' ||
    normalizedFileName.includes('sticker') ||
    currentType === 'sticker'
  ) {
    return 'sticker';
  }
  return normalizedMimeType.startsWith('image/') ? 'image' : 'file';
}

export class LocalTelegramDatabase {
  private dbPath = '';
  private db: import('sql.js').Database | null = null;
  private inboxRepository: SqlTelegramInboxRepository | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  async initialize(dataDir: string): Promise<void> {
    this.dbPath = path.join(dataDir, 'telegram-cache.sqlite');
    const SQL = await initSqlJs({
      locateFile: (file) => require.resolve(`sql.js/dist/${file}`)
    });
    const bytes = fs.existsSync(this.dbPath) ? fs.readFileSync(this.dbPath) : undefined;
    this.db = bytes ? new SQL.Database(bytes) : new SQL.Database();
    this.migrate();
    this.inboxRepository = new SqlTelegramInboxRepository(this.db);
    this.inboxRepository.initialize();
    this.flush();
  }

  load(): Pick<AppState['telegram'], 'chats' | 'topics' | 'messages'> {
    if (!this.db) {
      return { chats: [], topics: [], messages: [] };
    }

    const chats = this.rows<{
      id: string;
      title: string;
      type: TelegramChat['type'];
      avatar: string | null;
      has_topics: number;
      selected: number;
      notifications_enabled: number;
      last_synced_at: string | null;
      last_message_at: string | null;
      unread_count: number;
    }>(
      `select id, title, type, avatar, has_topics, selected, notifications_enabled, last_synced_at, last_message_at, unread_count
       from telegram_chats
       order by coalesce(last_message_at, last_synced_at, '') desc, title collate nocase asc`
    ).map((row) => ({
      id: row.id,
      title: row.title,
      type: row.type,
      avatar: row.avatar,
      hasTopics: row.has_topics !== 0,
      selected: Boolean(row.selected),
      notificationsEnabled: row.notifications_enabled !== 0,
      lastSyncedAt: row.last_synced_at,
      lastMessageAt: row.last_message_at,
      unreadCount: row.unread_count ?? 0
    }));

    const topics = this.rows<{
      id: string;
      chat_id: string;
      title: string;
      top_message_id: string;
      unread_count: number;
      last_message_at: string | null;
    }>(
      `select id, chat_id, title, top_message_id, unread_count, last_message_at
       from telegram_topics
       order by chat_id, unread_count desc, coalesce(last_message_at, '') desc, title collate nocase asc`
    ).map((row): TelegramTopic => ({
      id: row.id,
      chatId: row.chat_id,
      title: row.title,
      topMessageId: row.top_message_id,
      unreadCount: row.unread_count ?? 0,
      lastMessageAt: row.last_message_at
    }));

    const messages = this.rows<{
      id: string;
      chat_id: string;
      topic_id: string | null;
      reply_to_message_id: string | null;
      reply_to_sender_name: string | null;
      reply_to_text: string | null;
      sender_id: string | null;
      sender_name: string;
      sender_avatar: string | null;
      sent_at: string;
      text: string;
      attachments_json: string | null;
      reactions_json: string | null;
      status: MessageStatus;
      created_at: string;
      updated_at: string;
    }>(
      `select id, chat_id, topic_id, reply_to_message_id, reply_to_sender_name, reply_to_text, sender_id, sender_name, sender_avatar, sent_at, text, attachments_json, reactions_json, status, created_at, updated_at
       from telegram_messages
       order by sent_at desc`
    ).map((row) => ({
      id: row.id,
      chatId: row.chat_id,
      topicId: row.topic_id,
      replyToMessageId: row.reply_to_message_id,
      replyToSenderName: row.reply_to_sender_name,
      replyToText: row.reply_to_text,
      senderId: row.sender_id,
      senderName: row.sender_name,
      senderAvatar: row.sender_avatar,
      sentAt: row.sent_at,
      text: row.text,
      attachments: this.parseAttachments(row.attachments_json),
      reactions: this.parseReactions(row.reactions_json),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));

    return { chats, topics, messages };
  }

  save(telegram: AppState['telegram']): void {
    if (!this.db) {
      return;
    }

    this.db.run('begin');
    try {
      this.db.run('create temp table if not exists telegram_saved_message_ids (id text primary key)');
      this.db.run('delete from telegram_saved_message_ids');

      for (const chat of telegram.chats) {
        this.db.run(
          `insert into telegram_chats
             (id, title, type, avatar, has_topics, selected, notifications_enabled, last_synced_at, last_message_at, unread_count)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(id) do update set
             title = excluded.title,
             type = excluded.type,
             avatar = coalesce(excluded.avatar, telegram_chats.avatar),
             has_topics = excluded.has_topics,
             selected = excluded.selected,
             notifications_enabled = excluded.notifications_enabled,
             last_synced_at = excluded.last_synced_at,
             last_message_at = excluded.last_message_at,
             unread_count = excluded.unread_count`,
          [
            chat.id,
            chat.title,
            chat.type,
            chat.avatar,
            chat.hasTopics ? 1 : 0,
            chat.selected ? 1 : 0,
            chat.notificationsEnabled === false ? 0 : 1,
            chat.lastSyncedAt,
            chat.lastMessageAt,
            chat.unreadCount ?? 0
          ]
        );
        if (chat.avatar) {
          this.db.run(
            `insert into telegram_avatars (key, data_url, fetched_at, failed_at)
             values (?, ?, ?, null)
             on conflict(key) do update set
               data_url = excluded.data_url,
               fetched_at = excluded.fetched_at,
               failed_at = null`,
            [chat.id, chat.avatar, now()]
          );
        }
      }

      for (const topic of telegram.topics) {
        this.db.run(
          `insert into telegram_topics
             (id, chat_id, title, top_message_id, unread_count, last_message_at)
           values (?, ?, ?, ?, ?, ?)
           on conflict(id) do update set
             chat_id = excluded.chat_id,
             title = excluded.title,
             top_message_id = excluded.top_message_id,
             unread_count = excluded.unread_count,
             last_message_at = excluded.last_message_at`,
          [
            topic.id,
            topic.chatId,
            topic.title,
            topic.topMessageId,
            topic.unreadCount ?? 0,
            topic.lastMessageAt
          ]
        );
      }

      for (const message of telegram.messages) {
        this.db.run(
          `insert into telegram_messages
             (id, chat_id, topic_id, reply_to_message_id, reply_to_sender_name, reply_to_text, sender_id, sender_name, sender_avatar, sent_at, text, attachments_json, reactions_json, status, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(id) do update set
             sender_id = coalesce(excluded.sender_id, telegram_messages.sender_id),
             topic_id = coalesce(excluded.topic_id, telegram_messages.topic_id),
             reply_to_message_id = excluded.reply_to_message_id,
             reply_to_sender_name = excluded.reply_to_sender_name,
             reply_to_text = excluded.reply_to_text,
             sender_name = excluded.sender_name,
             sender_avatar = coalesce(excluded.sender_avatar, telegram_messages.sender_avatar),
             sent_at = excluded.sent_at,
             text = excluded.text,
             attachments_json = excluded.attachments_json,
             reactions_json = excluded.reactions_json,
             status = excluded.status,
             updated_at = excluded.updated_at`,
          [
            message.id,
            message.chatId,
            message.topicId,
            message.replyToMessageId,
            message.replyToSenderName,
            message.replyToText,
            message.senderId,
            message.senderName,
            message.senderAvatar,
            message.sentAt,
            message.text,
            JSON.stringify(message.attachments ?? []),
            JSON.stringify(message.reactions ?? []),
            message.status,
            message.createdAt,
            message.updatedAt
          ]
        );
        this.db.run('insert or ignore into telegram_saved_message_ids (id) values (?)', [message.id]);
        if (message.senderId && message.senderAvatar) {
          this.db.run(
            `insert into telegram_avatars (key, data_url, fetched_at, failed_at)
             values (?, ?, ?, null)
             on conflict(key) do update set
               data_url = excluded.data_url,
               fetched_at = excluded.fetched_at,
               failed_at = null`,
            [message.senderId, message.senderAvatar, now()]
          );
        }
      }

      this.db.run(`
        delete from telegram_messages
        where not exists (
          select 1 from telegram_saved_message_ids
          where telegram_saved_message_ids.id = telegram_messages.id
        )
      `);
      this.db.run('delete from telegram_saved_message_ids');

      this.db.run('commit');
      this.scheduleFlush();
    } catch (error) {
      this.db.run('rollback');
      throw error;
    }
  }

  clear(): void {
    if (!this.db) {
      return;
    }
    this.db.run('delete from telegram_messages');
    this.db.run('delete from telegram_topics');
    this.db.run('delete from telegram_chats');
    this.db.run('delete from telegram_avatars');
    this.db.run('delete from telegram_workspace_chats');
    this.db.run('delete from telegram_notification_settings');
    this.db.run('delete from telegram_message_workflow_status');
    this.flush();
  }

  getInboxRepository(): TelegramInboxRepository {
    if (!this.inboxRepository) {
      throw new Error('Telegram inbox repository is not initialized.');
    }
    return this.inboxRepository;
  }

  getAvatar(key: string): CachedTelegramAvatar | null {
    const avatar = this.rows<{
      dataUrl: string | null;
      fetchedAt: string | null;
      failedAt: string | null;
    }>(
      'select data_url as dataUrl, fetched_at as fetchedAt, failed_at as failedAt from telegram_avatars where key = ?',
      [key]
    ).at(0);
    return avatar ?? null;
  }

  saveAvatar(key: string, dataUrl: string | null): void {
    if (!this.db) {
      return;
    }

    const attemptedAt = now();
    this.db.run(
      `insert into telegram_avatars (key, data_url, fetched_at, failed_at)
       values (?, ?, ?, ?)
       on conflict(key) do update set
         data_url = excluded.data_url,
         fetched_at = excluded.fetched_at,
         failed_at = excluded.failed_at`,
      [key, dataUrl, dataUrl ? attemptedAt : null, dataUrl ? null : attemptedAt]
    );
    this.scheduleFlush();
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.writeToDisk();
  }

  private migrate(): void {
    if (!this.db) {
      return;
    }

    this.db.run(`
      create table if not exists telegram_chats (
        id text primary key,
        title text not null,
        type text not null,
        avatar text,
        has_topics integer not null default 0,
        selected integer not null default 0,
        notifications_enabled integer not null default 1,
        last_synced_at text,
        last_message_at text,
        unread_count integer not null default 0
      );
    `);
    this.db.run(`
      create table if not exists telegram_topics (
        id text primary key,
        chat_id text not null,
        title text not null,
        top_message_id text not null,
        unread_count integer not null default 0,
        last_message_at text
      );
    `);
    this.db.run(`
      create table if not exists telegram_messages (
        id text primary key,
        chat_id text not null,
        topic_id text,
        reply_to_message_id text,
        reply_to_sender_name text,
        reply_to_text text,
        sender_id text,
        sender_name text not null,
        sender_avatar text,
        sent_at text not null,
        text text not null,
        attachments_json text not null default '[]',
        reactions_json text not null default '[]',
        status text not null,
        created_at text not null,
        updated_at text not null
      );
    `);
    this.db.run(`
      create table if not exists telegram_avatars (
        key text primary key,
        data_url text,
        fetched_at text,
        failed_at text
      );
    `);
    this.addColumnIfMissing('telegram_chats', 'avatar', 'avatar text');
    this.addColumnIfMissing('telegram_chats', 'has_topics', 'has_topics integer not null default 0');
    this.addColumnIfMissing('telegram_chats', 'notifications_enabled', 'notifications_enabled integer not null default 1');
    this.addColumnIfMissing('telegram_messages', 'topic_id', 'topic_id text');
    this.addColumnIfMissing('telegram_messages', 'reply_to_message_id', 'reply_to_message_id text');
    this.addColumnIfMissing('telegram_messages', 'reply_to_sender_name', 'reply_to_sender_name text');
    this.addColumnIfMissing('telegram_messages', 'reply_to_text', 'reply_to_text text');
    this.addColumnIfMissing('telegram_messages', 'sender_id', 'sender_id text');
    this.addColumnIfMissing('telegram_messages', 'attachments_json', "attachments_json text not null default '[]'");
    this.addColumnIfMissing('telegram_messages', 'reactions_json', "reactions_json text not null default '[]'");
    this.db.run('create index if not exists idx_telegram_messages_chat_sent on telegram_messages(chat_id, sent_at)');
    this.db.run('create index if not exists idx_telegram_messages_topic_sent on telegram_messages(topic_id, sent_at)');
    this.db.run('create index if not exists idx_telegram_topics_chat on telegram_topics(chat_id)');
    this.db.run('create index if not exists idx_telegram_chats_last_message on telegram_chats(last_message_at)');
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    if (!this.db) {
      return;
    }
    const hasColumn = this.rows<{ name: string }>(`pragma table_info(${table})`)
      .some((row) => row.name === column);
    if (!hasColumn) {
      this.db.run(`alter table ${table} add column ${definition}`);
    }
  }

  private rows<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    if (!this.db) {
      return [];
    }

    const [result] = this.db.exec(sql, params);
    if (!result) {
      return [];
    }

    return result.values.map((valueRow) => {
      const row: Record<string, unknown> = {};
      result.columns.forEach((column, index) => {
        row[column] = valueRow[index];
      });
      return row as T;
    });
  }

  private parseAttachments(value: string | null): TelegramMessageAttachment[] {
    if (!value) {
      return [];
    }

    try {
      const parsed = JSON.parse(value) as TelegramMessageAttachment[];
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.map((attachment) => {
        const detectedMimeType = sniffDataUrlMimeType(attachment.dataUrl);
        const mimeType = detectedMimeType ?? attachment.mimeType?.toLowerCase() ?? '';
        const originalFileName = attachment.fileName ?? '';
        const fileName =
          detectedMimeType === 'video/mp4' && /^image\.(jpe?g|png|webp|gif)$/i.test(originalFileName)
            ? 'video.mp4'
            : originalFileName;
        const type = attachmentTypeForMimeType(mimeType, fileName, attachment.type);
        return {
          ...attachment,
          type,
          fileName,
          mimeType,
          dataUrl: type === 'file' && !mimeType.startsWith('video/')
            ? null
            : dataUrlWithMimeType(attachment.dataUrl, mimeType)
        };
      });
    } catch {
      return [];
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.writeToDiskAsync();
    }, 300);
  }

  private async writeToDiskAsync(): Promise<void> {
    if (!this.db) {
      return;
    }
    try {
      await fs.promises.writeFile(this.dbPath, Buffer.from(this.db.export()));
    } catch (error) {
      console.warn('Failed to flush Telegram cache:', error);
    }
  }

  private writeToDisk(): void {
    if (!this.db) {
      return;
    }
    fs.writeFileSync(this.dbPath, Buffer.from(this.db.export()));
  }

  private parseReactions(value: string | null): TelegramMessageReaction[] {
    if (!value) {
      return [];
    }
    try {
      const parsed = JSON.parse(value) as TelegramMessageReaction[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}
