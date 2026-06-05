import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { InMemoryTelegramInboxRepository, SqlTelegramInboxRepository } from './telegramInboxRepository';

async function createSqlRepository(): Promise<SqlTelegramInboxRepository> {
  const SQL = await initSqlJs({
    locateFile: (file) => require.resolve(`sql.js/dist/${file}`)
  });
  const repository = new SqlTelegramInboxRepository(new SQL.Database());
  repository.initialize();
  return repository;
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

    expect(repository.messageStatus('10:99')).toBe('created');
    expect(repository.messageStatus('10:100')).toBe('new');
  });

  it('persists selected chats in insertion order', async () => {
    const repository = await createSqlRepository();

    repository.selectWorkspaceChats(['20', '10', '30']);

    expect(repository.selectedChatIds()).toEqual(['20', '10', '30']);
  });

  it('uses notification default true and stores false overrides', async () => {
    const repository = await createSqlRepository();
    repository.selectWorkspaceChats(['10', '20']);
    repository.setChatNotifications('20', false);

    expect(repository.chatLocalState('10')).toEqual({ selected: true, notificationsEnabled: true });
    expect(repository.chatLocalState('20')).toEqual({ selected: true, notificationsEnabled: false });
  });

  it('upserts workflow status for a message', async () => {
    const repository = await createSqlRepository();

    repository.setMessageStatus({ messageId: '10:99', chatId: '10', topicId: null, status: 'created' });
    repository.setMessageStatus({ messageId: '10:99', chatId: '10', topicId: null, status: 'ignored' });

    expect(repository.messageStatus('10:99')).toBe('ignored');
    expect(repository.messageStatus('10:100')).toBe('new');
  });
});
