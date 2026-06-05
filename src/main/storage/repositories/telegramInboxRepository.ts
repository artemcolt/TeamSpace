import type { MessageStatus } from '../../domain/types';

function isMessageStatus(status: unknown): status is MessageStatus {
  return status === 'new' || status === 'ignored' || status === 'created';
}

function messageStatusOrDefault(status: unknown): MessageStatus {
  return isMessageStatus(status) ? status : 'new';
}

export interface TelegramChatLocalState {
  selected: boolean;
  notificationsEnabled: boolean;
}

export interface TelegramMessageStatusRecord {
  messageId: string;
  chatId: string;
  topicId: string | null;
  status: MessageStatus;
}

export interface TelegramInboxRepository {
  selectedChatIds(): string[];
  selectWorkspaceChats(chatIds: string[]): void;
  chatLocalState(chatId: string): TelegramChatLocalState;
  setChatNotifications(chatId: string, enabled: boolean): void;
  messageStatus(messageId: string): MessageStatus;
  setMessageStatus(record: TelegramMessageStatusRecord): void;
}

export class InMemoryTelegramInboxRepository implements TelegramInboxRepository {
  private readonly selected = new Set<string>();
  private readonly notificationSettings = new Map<string, boolean>();
  private readonly statuses = new Map<string, MessageStatus>();

  selectedChatIds(): string[] {
    return [...this.selected];
  }

  selectWorkspaceChats(chatIds: string[]): void {
    this.selected.clear();
    for (const chatId of chatIds) {
      this.selected.add(chatId);
    }
  }

  chatLocalState(chatId: string): TelegramChatLocalState {
    return {
      selected: this.selected.has(chatId),
      notificationsEnabled: this.notificationSettings.get(chatId) ?? true
    };
  }

  setChatNotifications(chatId: string, enabled: boolean): void {
    this.notificationSettings.set(chatId, enabled);
  }

  messageStatus(messageId: string): MessageStatus {
    return this.statuses.get(messageId) ?? 'new';
  }

  setMessageStatus(record: TelegramMessageStatusRecord): void {
    this.statuses.set(record.messageId, messageStatusOrDefault(record.status));
  }
}

export class SqlTelegramInboxRepository implements TelegramInboxRepository {
  constructor(private readonly db: {
    run(sql: string, params?: unknown[]): void;
    exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
  }) {}

  initialize(): void {
    this.db.run('create table if not exists telegram_workspace_chats (chat_id text primary key, selected integer not null, selected_at text not null)');
    this.db.run('create table if not exists telegram_notification_settings (chat_id text primary key, enabled integer not null)');
    this.db.run("create table if not exists telegram_message_workflow_status (message_id text primary key, chat_id text not null, topic_id text, status text not null check(status in ('new', 'ignored', 'created')), updated_at text not null)");
  }

  selectedChatIds(): string[] {
    return this.rows<{ chat_id: string }>('select chat_id from telegram_workspace_chats where selected = 1 order by selected_at asc')
      .map((row) => row.chat_id);
  }

  selectWorkspaceChats(chatIds: string[]): void {
    this.db.run('delete from telegram_workspace_chats');
    const selectedAt = Date.now();
    [...new Set(chatIds)].forEach((chatId, index) => {
      this.db.run('insert into telegram_workspace_chats (chat_id, selected, selected_at) values (?, 1, ?)', [
        chatId,
        new Date(selectedAt + index).toISOString()
      ]);
    });
  }

  chatLocalState(chatId: string): TelegramChatLocalState {
    return {
      selected: this.rows<{ selected: number }>('select selected from telegram_workspace_chats where chat_id = ?', [chatId]).at(0)?.selected === 1,
      notificationsEnabled: this.rows<{ enabled: number }>('select enabled from telegram_notification_settings where chat_id = ?', [chatId]).at(0)?.enabled !== 0
    };
  }

  setChatNotifications(chatId: string, enabled: boolean): void {
    this.db.run(
      'insert into telegram_notification_settings (chat_id, enabled) values (?, ?) on conflict(chat_id) do update set enabled = excluded.enabled',
      [chatId, enabled ? 1 : 0]
    );
  }

  messageStatus(messageId: string): MessageStatus {
    const status = this.rows<{ status: unknown }>(
      'select status from telegram_message_workflow_status where message_id = ?',
      [messageId]
    ).at(0)?.status;
    return messageStatusOrDefault(status);
  }

  setMessageStatus(record: TelegramMessageStatusRecord): void {
    const status = messageStatusOrDefault(record.status);
    this.db.run(
      `insert into telegram_message_workflow_status (message_id, chat_id, topic_id, status, updated_at)
       values (?, ?, ?, ?, ?)
       on conflict(message_id) do update set
         chat_id = excluded.chat_id,
         topic_id = excluded.topic_id,
         status = excluded.status,
         updated_at = excluded.updated_at`,
      [record.messageId, record.chatId, record.topicId, status, new Date().toISOString()]
    );
  }

  private rows<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    const [result] = this.db.exec(sql, params);
    if (!result) {
      return [];
    }
    return result.values.map((values) => Object.fromEntries(result.columns.map((column, index) => [column, values[index]])) as T);
  }
}
