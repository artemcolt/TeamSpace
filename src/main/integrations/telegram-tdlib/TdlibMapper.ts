import type {
  MessageStatus,
  TelegramChat,
  TelegramChatSummary,
  TelegramMessageAttachment,
  TelegramMessageView
} from '../../domain/types';
import type { TdlibObject } from './tdlibTypes';

function tdDate(value: unknown): string {
  const seconds = typeof value === 'number' ? value : 0;
  return new Date(seconds * 1000).toISOString();
}

function tdStringId(value: unknown): string {
  return typeof value === 'number' || typeof value === 'string' ? String(value) : '';
}

function chatType(type: unknown): TelegramChat['type'] {
  const object = type as { '@type'?: string; is_channel?: boolean } | undefined;
  if (object?.['@type'] === 'chatTypePrivate') {
    return 'private';
  }
  if (object?.['@type'] === 'chatTypeSupergroup') {
    return object.is_channel ? 'channel' : 'group';
  }
  return 'group';
}

function textFromContent(content: unknown): string {
  const object = content as { '@type'?: string; text?: { text?: string }; caption?: { text?: string } } | undefined;
  return object?.text?.text ?? object?.caption?.text ?? '';
}

function attachmentsFromContent(messageId: string, content: unknown): TelegramMessageAttachment[] {
  const object = content as { '@type'?: string; document?: { file_name?: string; mime_type?: string; document?: { id?: number; size?: number } }; photo?: unknown } | undefined;
  if (object?.['@type'] === 'messageDocument') {
    return [{
      id: `${messageId}:attachment`,
      type: 'file',
      fileName: object.document?.file_name || 'file',
      mimeType: object.document?.mime_type || 'application/octet-stream',
      size: object.document?.document?.size ?? null,
      dataUrl: null
    }];
  }
  if (object?.['@type'] === 'messagePhoto') {
    return [{
      id: `${messageId}:attachment`,
      type: 'image',
      fileName: 'image.jpg',
      mimeType: 'image/jpeg',
      size: null,
      dataUrl: null
    }];
  }
  return [];
}

export function tdlibChatToSummary(
  chat: TdlibObject,
  local: { selected: boolean; notificationsEnabled: boolean }
): TelegramChatSummary {
  const lastMessage = chat.last_message as { date?: number } | undefined;
  return {
    id: tdStringId(chat.id),
    title: typeof chat.title === 'string' ? chat.title : tdStringId(chat.id),
    type: chatType(chat.type),
    avatar: null,
    selected: local.selected,
    notificationsEnabled: local.notificationsEnabled,
    hasTopics: (chat.type as { '@type'?: string } | undefined)?.['@type'] === 'chatTypeSupergroup',
    unreadCount: typeof chat.unread_count === 'number' ? chat.unread_count : 0,
    lastMessageAt: lastMessage?.date ? tdDate(lastMessage.date) : null
  };
}

export function tdlibMessageToView(
  message: TdlibObject,
  context: { senderName: string; topicId: string | null; status: MessageStatus }
): TelegramMessageView {
  const chatId = tdStringId(message.chat_id);
  const messageId = `${chatId}:${tdStringId(message.id)}`;
  const sender = message.sender_id as { user_id?: number; chat_id?: number } | undefined;
  const senderId = sender?.user_id ?? sender?.chat_id;
  const sentAt = tdDate(message.date);
  const content = message.content;
  return {
    id: messageId,
    chatId,
    topicId: context.topicId,
    senderId: senderId ? String(senderId) : null,
    senderName: message.is_outgoing ? 'Вы' : context.senderName,
    senderAvatar: null,
    sentAt,
    text: textFromContent(content),
    attachments: attachmentsFromContent(messageId, content),
    reactions: [],
    status: context.status,
    createdAt: sentAt,
    updatedAt: sentAt,
    deliveryStatus: message.sending_state ? 'sending' : 'sent'
  };
}
