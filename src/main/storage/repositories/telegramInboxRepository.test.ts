import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { InMemoryTelegramInboxRepository, SqlTelegramInboxRepository } from './telegramInboxRepository';

type SqlDatabase = ConstructorParameters<typeof SqlTelegramInboxRepository>[0];

async function createSqlRepository(): Promise<{ repository: SqlTelegramInboxRepository; db: SqlDatabase }> {
  const SQL = await initSqlJs({
    locateFile: (file) => require.resolve(`sql.js/dist/${file}`)
  });
  const db = new SQL.Database();
  const repository = new SqlTelegramInboxRepository(db);
  repository.initialize();
  return { repository, db };
}

describe('telegramInboxRepository', () => {
  it('stores selected chats and notification settings independently from messages', () => {
    const repository = new InMemoryTelegramInboxRepository();
    repository.selectWorkspaceChats(['10', '20']);
    repository.setChatNotifications('20', false);

    expect(repository.chatLocalState('10')).toEqual({ selected: true, notificationsEnabled: true });
    expect(repository.chatLocalState('20')).toEqual({ selected: true, notificationsEnabled: false });
    expect(repository.selectedChatIds()).toEqual(['10', '20']);
  });

  it('keeps workflow status for a message', () => {
    const repository = new InMemoryTelegramInboxRepository();
    repository.setMessageStatus({ messageId: '10:99', chatId: '10', topicId: null, status: 'created' });
    repository.setMessageStatus({ messageId: '10:100', chatId: '10', topicId: null, status: 'invalid' as never });

    expect(repository.messageStatus('10:99')).toBe('created');
    expect(repository.messageStatus('10:100')).toBe('new');
    expect(repository.messageStatus('10:101')).toBe('new');
  });

  it('persists selected chats in insertion order', async () => {
    const { repository } = await createSqlRepository();

    repository.selectWorkspaceChats(['20', '10', '30']);

    expect(repository.selectedChatIds()).toEqual(['20', '10', '30']);
  });

  it('uses notification default true and stores false overrides', async () => {
    const { repository } = await createSqlRepository();
    repository.selectWorkspaceChats(['10', '20']);
    repository.setChatNotifications('20', false);

    expect(repository.chatLocalState('10')).toEqual({ selected: true, notificationsEnabled: true });
    expect(repository.chatLocalState('20')).toEqual({ selected: true, notificationsEnabled: false });
  });

  it('upserts workflow status for a message', async () => {
    const { repository } = await createSqlRepository();

    repository.setMessageStatus({ messageId: '10:99', chatId: '10', topicId: null, status: 'created' });
    repository.setMessageStatus({ messageId: '10:99', chatId: '10', topicId: null, status: 'ignored' });

    expect(repository.messageStatus('10:99')).toBe('ignored');
    expect(repository.messageStatus('10:100')).toBe('new');
  });

  it('rejects invalid workflow status values at the SQL boundary', async () => {
    const { db } = await createSqlRepository();

    expect(() => db.run(
      `insert into telegram_message_workflow_status (message_id, chat_id, topic_id, status, updated_at)
       values (?, ?, ?, ?, ?)`,
      ['10:99', '10', null, 'invalid', '2026-06-05T12:00:00.000Z']
    )).toThrow();
  });

  it('normalizes malformed stored workflow status values to new', () => {
    const repository = new SqlTelegramInboxRepository({
      run: () => undefined,
      exec: () => [{ columns: ['status'], values: [['invalid']] }]
    });

    expect(repository.messageStatus('10:99')).toBe('new');
  });

  it('updates workflow message metadata on status upsert', async () => {
    const { repository, db } = await createSqlRepository();

    repository.setMessageStatus({ messageId: '10:99', chatId: 'wrong-chat', topicId: null, status: 'created' });
    repository.setMessageStatus({ messageId: '10:99', chatId: '10', topicId: 'topic-1', status: 'ignored' });

    const [result] = db.exec('select chat_id, topic_id from telegram_message_workflow_status where message_id = ?', ['10:99']);

    expect(result.values).toEqual([['10', 'topic-1']]);
  });

  it('reads chat local state without scanning all selected chat ids', () => {
    const executedSql: string[] = [];
    const repository = new SqlTelegramInboxRepository({
      run: () => undefined,
      exec: (sql) => {
        executedSql.push(sql);
        if (sql.includes('telegram_workspace_chats')) {
          return [{ columns: ['selected'], values: [[1]] }];
        }
        return [];
      }
    });

    expect(repository.chatLocalState('10')).toEqual({ selected: true, notificationsEnabled: true });
    expect(executedSql).not.toContain('select chat_id from telegram_workspace_chats where selected = 1 order by selected_at asc');
  });
});
