import type {
  TelegramInboxSnapshot,
  TelegramThreadKey,
  TelegramThreadRequest,
  TelegramThreadView
} from '../domain/telegram';

export type {
  TelegramChatSummary,
  TelegramInboxSnapshot,
  TelegramMessageView,
  TelegramSendMessagePayload,
  TelegramSendResult,
  TelegramThreadKey,
  TelegramThreadPageRequest,
  TelegramThreadRequest,
  TelegramThreadView,
  TelegramTopicSummary,
  TelegramUnreadSummary
} from '../domain/telegram';

export interface TeamSpaceBridge {
  api: {
    getTelegramInboxSnapshot: () => Promise<TelegramInboxSnapshot>;
    getTelegramThread: (payload: TelegramThreadRequest) => Promise<TelegramThreadView>;
    markTelegramThreadRead: (payload: TelegramThreadKey) => Promise<TelegramInboxSnapshot>;
  };
}
