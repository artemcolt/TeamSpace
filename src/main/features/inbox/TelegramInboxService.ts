import type { TelegramInboxSnapshot, TelegramThreadRequest, TelegramThreadView } from '../../domain/types';
import type { TdlibClient } from '../../integrations/telegram-tdlib/TdlibClient';
import { tdlibChatToSummary, tdlibMessageToView } from '../../integrations/telegram-tdlib/TdlibMapper';
import type { TdlibObject } from '../../integrations/telegram-tdlib/tdlibTypes';
import type { TelegramInboxRepository } from '../../storage/repositories/telegramInboxRepository';

export class TelegramInboxService {
  constructor(
    private readonly client: TdlibClient,
    private readonly repository: TelegramInboxRepository
  ) {}

  async getInboxSnapshot(): Promise<TelegramInboxSnapshot> {
    const chatList = await this.client.send<{ '@type': 'chats'; chat_ids: Array<number | string> }>({
      '@type': 'getChats',
      limit: 100
    });
    const chats = await Promise.all(chatList.chat_ids.map(async (chatId) => {
      const chat = await this.client.send<TdlibObject>({ '@type': 'getChat', chat_id: chatId });
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
    const response = await this.client.send<{
      '@type': 'messages';
      total_count: number;
      messages: TdlibObject[];
    }>({
      '@type': 'getChatHistory',
      chat_id: Number(payload.chatId),
      from_message_id: 0,
      offset: 0,
      limit: payload.limit ?? 50,
      only_local: false
    });
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
      hasOlder: response.total_count > messages.length,
      loading: false
    };
  }
}
