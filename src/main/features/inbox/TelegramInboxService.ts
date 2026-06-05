import type {
  TelegramAttachmentDownloadResult,
  TelegramInboxSnapshot,
  TelegramSendMessagePayload,
  TelegramSendResult,
  TelegramThreadKey,
  TelegramThreadRequest,
  TelegramThreadView
} from '../../domain/types';
import { TdlibCommandAdapter } from '../../integrations/telegram-tdlib/TdlibCommandAdapter';
import type { TdlibClient } from '../../integrations/telegram-tdlib/TdlibClient';
import { tdlibChatToSummary, tdlibMessageToView } from '../../integrations/telegram-tdlib/TdlibMapper';
import { TdlibMediaService } from '../../integrations/telegram-tdlib/TdlibMediaService';
import type { TdlibObject } from '../../integrations/telegram-tdlib/tdlibTypes';
import type { TelegramInboxRepository } from '../../storage/repositories/telegramInboxRepository';
import { randomUUID } from 'crypto';

type TdlibMessagesResponse = {
  '@type': 'messages';
  total_count: number;
  messages: TdlibObject[];
};

function clampHistoryLimit(limit: number | undefined): number {
  return Math.min(100, Math.max(1, Math.trunc(limit ?? 50)));
}

export class TelegramInboxService {
  private readonly commandAdapter: TdlibCommandAdapter;
  private readonly mediaService: TdlibMediaService;

  constructor(
    private readonly client: TdlibClient,
    private readonly repository: TelegramInboxRepository,
    commandAdapter?: TdlibCommandAdapter,
    mediaService?: TdlibMediaService
  ) {
    this.commandAdapter = commandAdapter ?? new TdlibCommandAdapter(client);
    this.mediaService = mediaService ?? new TdlibMediaService(client);
  }

  async getInboxSnapshot(): Promise<TelegramInboxSnapshot> {
    const chatList = await this.client.send<{ '@type': 'chats'; chat_ids: Array<number | string> }>({
      '@type': 'getChats',
      limit: 100
    });
    const chatIds = this.mergeChatIds(chatList.chat_ids, this.repository.selectedChatIds());
    const chats = await Promise.all(chatIds.map(async (chatId) => {
      const chat = await this.client.send<TdlibObject>({ '@type': 'getChat', chat_id: Number(chatId) });
      return tdlibChatToSummary(chat, this.repository.chatLocalState(String(chatId)));
    }));
    const selectedUnreadCount = chats
      .filter((chat) => chat.selected)
      .reduce((total, chat) => total + Math.max(0, chat.unreadCount), 0);
    const notifyingUnreadCount = chats
      .filter((chat) => chat.selected && chat.notificationsEnabled)
      .reduce((total, chat) => total + Math.max(0, chat.unreadCount), 0);

    return {
      status: 'connected',
      phoneMasked: null,
      chats,
      topics: [],
      unread: { selectedUnreadCount, notifyingUnreadCount },
      error: null
    };
  }

  async getThread(payload: TelegramThreadRequest): Promise<TelegramThreadView> {
    const response = await this.loadHistory(payload);
    const messages = response.messages
      .map((message) => tdlibMessageToView(message, {
        senderName: 'Unknown',
        topicId: payload.topicId,
        status: this.repository.messageStatus(`${payload.chatId}:${String(message.id)}`)
      }))
      .filter((message): message is NonNullable<typeof message> => Boolean(message))
      .sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime());

    return {
      key: { chatId: payload.chatId, topicId: payload.topicId },
      messages,
      hasOlder: response.total_count > response.messages.length,
      loading: false
    };
  }

  async markThreadRead(payload: TelegramThreadKey): Promise<TelegramInboxSnapshot> {
    const history = await this.loadHistory({ ...payload, limit: 100 });
    const messageIds = history.messages
      .map((message) => Number(message.id))
      .filter((messageId) => Number.isFinite(messageId));
    if (messageIds.length > 0) {
      await this.client.send({
        '@type': 'viewMessages',
        chat_id: Number(payload.chatId),
        message_ids: messageIds,
        force_read: true
      });
    }
    return this.getInboxSnapshot();
  }

  async sendMessage(payload: TelegramSendMessagePayload): Promise<TelegramSendResult> {
    const clientRequestId = payload.clientRequestId ?? randomUUID();
    await this.commandAdapter.sendMessage(payload);
    const thread = await this.getThread({
      chatId: payload.chatId,
      topicId: payload.topicId,
      limit: 50
    });
    return { clientRequestId, thread };
  }

  async reactToMessage(payload: { messageId: string; emoticon: string }): Promise<TelegramInboxSnapshot> {
    await this.commandAdapter.reactToMessage(payload);
    return this.getInboxSnapshot();
  }

  async downloadFile(payload: { fileId: number; priority?: number }): Promise<TelegramAttachmentDownloadResult> {
    return this.mediaService.downloadFile(payload);
  }

  private mergeChatIds(tdlibChatIds: Array<number | string>, selectedChatIds: string[]): Array<number | string> {
    const seen = new Set<string>();
    const merged: Array<number | string> = [];
    for (const chatId of [...tdlibChatIds, ...selectedChatIds]) {
      const key = String(chatId);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(chatId);
      }
    }
    return merged;
  }

  private loadHistory(payload: TelegramThreadRequest): Promise<TdlibMessagesResponse> {
    const limit = clampHistoryLimit(payload.limit);
    if (payload.topicId !== null) {
      return this.client.send<TdlibMessagesResponse>({
        '@type': 'getMessageThreadHistory',
        chat_id: Number(payload.chatId),
        // First migration scope treats topicId as the TDLib thread root message id.
        message_id: Number(payload.topicId),
        from_message_id: 0,
        offset: 0,
        limit
      });
    }
    return this.client.send<TdlibMessagesResponse>({
      '@type': 'getChatHistory',
      chat_id: Number(payload.chatId),
      from_message_id: 0,
      offset: 0,
      limit,
      only_local: false
    });
  }
}
