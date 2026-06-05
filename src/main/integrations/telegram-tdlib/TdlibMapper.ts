import type {
  MessageStatus,
  TelegramChat,
  TelegramChatSummary,
  TelegramMessageAttachment,
  TelegramMessageView
} from '../../domain/types';
import type { TdlibObject } from './tdlibTypes';

function tdDate(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
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

function isSupportedContentType(type: string | undefined): boolean {
  return type === 'messageText' ||
    type === 'messageDocument' ||
    type === 'messagePhoto' ||
    type === 'messageSticker' ||
    type === 'messageVideo';
}

function textFromContent(content: unknown): string {
  const object = content as { '@type'?: string; text?: { text?: string }; caption?: { text?: string } } | undefined;
  if (object?.['@type'] === 'messageText') {
    return object.text?.text ?? '';
  }
  return object?.caption?.text ?? '';
}

function attachmentsFromContent(messageId: string, content: unknown): TelegramMessageAttachment[] {
  const object = content as {
    '@type'?: string;
    document?: { file_name?: string; mime_type?: string; document?: { id?: number; size?: number } };
    photo?: unknown;
    sticker?: { sticker?: { id?: number; size?: number } };
    video?: { file_name?: string; mime_type?: string; video?: { id?: number; size?: number } };
  } | undefined;
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
  if (object?.['@type'] === 'messageSticker') {
    return [{
      id: `${messageId}:attachment`,
      type: 'sticker',
      fileName: 'sticker.webp',
      mimeType: 'image/webp',
      size: object.sticker?.sticker?.size ?? null,
      dataUrl: null
    }];
  }
  if (object?.['@type'] === 'messageVideo') {
    return [{
      id: `${messageId}:attachment`,
      type: 'file',
      fileName: object.video?.file_name || 'video.mp4',
      mimeType: object.video?.mime_type || 'video/mp4',
      size: object.video?.video?.size ?? null,
      dataUrl: null
    }];
  }
  return [];
}

function contentType(content: unknown): string | undefined {
  return (content as { '@type'?: string } | undefined)?.['@type'];
}

function isKnownEmptyContent(content: unknown): boolean {
  return contentType(content) === 'messageText';
}

function deliveryStatus(message: TdlibObject): TelegramMessageView['deliveryStatus'] | undefined {
  const sendingState = message.sending_state as { '@type'?: string } | undefined;
  if (sendingState?.['@type'] === 'messageSendingStatePending') {
    return 'sending';
  }
  if (sendingState?.['@type'] === 'messageSendingStateFailed') {
    return 'failed';
  }
  return undefined;
}

export function tdlibChatToSummary(
  chat: TdlibObject,
  local: { selected: boolean; notificationsEnabled: boolean; hasTopics?: boolean }
): TelegramChatSummary {
  const lastMessage = chat.last_message as { date?: number } | undefined;
  return {
    id: tdStringId(chat.id),
    title: typeof chat.title === 'string' ? chat.title : tdStringId(chat.id),
    type: chatType(chat.type),
    avatar: null,
    selected: local.selected,
    notificationsEnabled: local.notificationsEnabled,
    hasTopics: local.hasTopics ?? false,
    unreadCount: typeof chat.unread_count === 'number' ? chat.unread_count : 0,
    lastMessageAt: tdDate(lastMessage?.date)
  };
}

export function tdlibMessageToView(
  message: TdlibObject,
  context: { senderName: string; topicId: string | null; status: MessageStatus }
): TelegramMessageView | null {
  const chatId = tdStringId(message.chat_id);
  const messageId = `${chatId}:${tdStringId(message.id)}`;
  const sender = message.sender_id as { user_id?: number; chat_id?: number } | undefined;
  const senderId = sender?.user_id ?? sender?.chat_id;
  const sentAt = tdDate(message.date);
  if (!sentAt) {
    return null;
  }
  const content = message.content;
  if (!isSupportedContentType(contentType(content))) {
    return null;
  }
  const text = textFromContent(content);
  const attachments = attachmentsFromContent(messageId, content);
  if (!text && attachments.length === 0 && !isKnownEmptyContent(content)) {
    return null;
  }
  const status = deliveryStatus(message);
  const view: TelegramMessageView = {
    id: messageId,
    chatId,
    topicId: context.topicId,
    senderId: senderId ? String(senderId) : null,
    senderName: message.is_outgoing ? 'Вы' : context.senderName,
    senderAvatar: null,
    sentAt,
    text,
    attachments,
    reactions: [],
    status: context.status,
    createdAt: sentAt,
    updatedAt: sentAt
  };
  if (status) {
    view.deliveryStatus = status;
  }
  return view;
}
