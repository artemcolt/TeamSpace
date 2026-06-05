import { describe, expect, it, vi } from 'vitest';
import { TdlibTelegramFacade, type TelegramIpcService } from './tdlibTelegramFacade';

function legacyService(): TelegramIpcService {
  return {
    requestCode: vi.fn(),
    connect: vi.fn(),
    sync: vi.fn(),
    getInboxSnapshot: vi.fn(),
    getThread: vi.fn(),
    markThreadRead: vi.fn(),
    loadChatMessages: vi.fn(),
    loadOlderChatMessages: vi.fn(),
    sendMessage: vi.fn(),
    reactToMessage: vi.fn(),
    downloadAttachment: vi.fn(),
    disconnect: vi.fn(),
    selectWorkspace: vi.fn(),
    setChatNotifications: vi.fn()
  } as unknown as TelegramIpcService;
}

describe('TdlibTelegramFacade', () => {
  it('routes focused inbox methods to TDLib while preserving legacy compatibility methods', async () => {
    const legacy = legacyService();
    const tdlib = {
      getInboxSnapshot: vi.fn(async () => ({ status: 'connected', chats: [] })),
      getThread: vi.fn(async () => ({ key: { chatId: '42', topicId: null }, messages: [] })),
      markThreadRead: vi.fn(async () => ({ status: 'connected', chats: [] }))
    };
    const facade = new TdlibTelegramFacade(legacy, tdlib);

    await facade.getInboxSnapshot();
    await facade.getThread({ chatId: '42', topicId: null, limit: 50 });
    await facade.markThreadRead({ chatId: '42', topicId: null });
    await facade.sync();

    expect(tdlib.getInboxSnapshot).toHaveBeenCalledTimes(1);
    expect(tdlib.getThread).toHaveBeenCalledWith({ chatId: '42', topicId: null, limit: 50 });
    expect(tdlib.markThreadRead).toHaveBeenCalledWith({ chatId: '42', topicId: null });
    expect(legacy.getInboxSnapshot).not.toHaveBeenCalled();
    expect(legacy.sync).toHaveBeenCalledTimes(1);
  });
});
