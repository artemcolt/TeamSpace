import type { TelegramSendMessagePayload } from '../../domain/types';
import type { TdlibClient } from './TdlibClient';

function parseFiniteId(value: string, label: string): number {
  const id = Number(value);
  if (!Number.isFinite(id)) {
    throw new Error(`Некорректный Telegram ${label}.`);
  }
  return id;
}

function parseMessageId(messageId: string): { chatId: number; messageId: number } {
  const parts = messageId.split(':');
  if (parts.length < 2) {
    throw new Error('Некорректный Telegram message id.');
  }
  return {
    chatId: parseFiniteId(parts.slice(0, -1).join(':'), 'chat id'),
    messageId: parseFiniteId(parts.at(-1) ?? '', 'message id')
  };
}

function replyTarget(payload: TelegramSendMessagePayload) {
  const messageId = payload.replyToMessageId
    ? parseMessageId(payload.replyToMessageId).messageId
    : payload.topicId
      ? parseFiniteId(payload.topicId, 'topic id')
      : null;
  return messageId
    ? { '@type': 'inputMessageReplyToMessage', message_id: messageId }
    : undefined;
}

export class TdlibCommandAdapter {
  constructor(private readonly client: TdlibClient) {}

  async sendMessage(payload: TelegramSendMessagePayload) {
    const text = payload.text.trim();
    if (!text) {
      throw new Error('Введите текст сообщения.');
    }

    return this.client.send({
      '@type': 'sendMessage',
      chat_id: parseFiniteId(payload.chatId, 'chat id'),
      reply_to: replyTarget(payload),
      input_message_content: {
        '@type': 'inputMessageText',
        text: { '@type': 'formattedText', text, entities: [] },
        clear_draft: true
      }
    });
  }

  async reactToMessage(payload: { messageId: string; emoticon: string }) {
    const emoticon = payload.emoticon.trim();
    if (!emoticon) {
      throw new Error('Укажите реакцию Telegram.');
    }
    const ids = parseMessageId(payload.messageId);
    return this.client.send({
      '@type': 'addMessageReaction',
      chat_id: ids.chatId,
      message_id: ids.messageId,
      reaction_type: { '@type': 'reactionTypeEmoji', emoji: emoticon },
      is_big: false,
      update_recent_reactions: true
    });
  }
}
