export type MessageStatus = 'new' | 'ignored' | 'created';

export interface TelegramChat {
  id: string;
  title: string;
  type: 'private' | 'group' | 'channel';
  avatar: string | null;
  hasTopics: boolean;
  selected: boolean;
  notificationsEnabled: boolean;
  lastSyncedAt: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
}

export interface TelegramTopic {
  id: string;
  chatId: string;
  title: string;
  topMessageId: string;
  unreadCount: number;
  lastMessageAt: string | null;
}

export interface TelegramMessageAttachment {
  id: string;
  type: 'image' | 'sticker' | 'file';
  fileName: string;
  mimeType: string;
  size: number | null;
  dataUrl: string | null;
}

export interface TelegramOutgoingFile {
  name: string;
  mimeType: string;
  data: ArrayBuffer;
}

export interface TelegramMessageReaction {
  emoticon: string;
  count: number;
  mine: boolean;
  users?: string[];
}

export interface TelegramMessage {
  id: string;
  chatId: string;
  topicId: string | null;
  replyToMessageId?: string | null;
  replyToSenderName?: string | null;
  replyToText?: string | null;
  senderId: string | null;
  senderName: string;
  senderAvatar: string | null;
  sentAt: string;
  text: string;
  attachments?: TelegramMessageAttachment[];
  reactions?: TelegramMessageReaction[];
  status: MessageStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TelegramChatSummary {
  id: string;
  title: string;
  type: TelegramChat['type'];
  avatar: string | null;
  selected: boolean;
  notificationsEnabled: boolean;
  hasTopics: boolean;
  unreadCount: number;
  lastMessageAt: string | null;
}

export interface TelegramTopicSummary {
  id: string;
  chatId: string;
  title: string;
  unreadCount: number;
  lastMessageAt: string | null;
}

export interface TelegramUnreadSummary {
  selectedUnreadCount: number;
  notifyingUnreadCount: number;
}

export interface TelegramThreadKey {
  chatId: string;
  topicId: string | null;
}

export interface TelegramThreadRequest extends TelegramThreadKey {
  limit?: number;
}

export interface TelegramThreadPageRequest extends TelegramThreadKey {
  beforeMessageId: string;
  limit?: number;
}

export interface TelegramMessageView extends TelegramMessage {
  deliveryStatus?: 'sending' | 'failed' | 'sent';
}

export interface TelegramThreadView {
  key: TelegramThreadKey;
  messages: TelegramMessageView[];
  hasOlder: boolean;
  loading: boolean;
}

export interface TelegramInboxSnapshot {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  phoneMasked: string | null;
  chats: TelegramChatSummary[];
  topics: TelegramTopicSummary[];
  unread: TelegramUnreadSummary;
  error: string | null;
}

export interface TelegramSendMessagePayload extends TelegramThreadKey {
  replyToMessageId?: string;
  text: string;
  file?: TelegramOutgoingFile;
  image?: TelegramOutgoingFile;
  clientRequestId?: string;
}

export interface TelegramSendResult {
  clientRequestId: string;
  thread: TelegramThreadView;
}
