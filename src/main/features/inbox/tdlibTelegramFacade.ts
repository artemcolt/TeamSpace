import type {
  AppState,
  TelegramAttachmentDownloadPayload,
  TelegramAttachmentDownloadResult,
  TelegramInboxSnapshot,
  TelegramOutgoingFile,
  TelegramThreadKey,
  TelegramThreadRequest,
  TelegramThreadView
} from '../../domain/types';
import type { TelegramService } from '../../telegram/telegramService';
import type { TelegramInboxService } from './TelegramInboxService';

export type TelegramIpcService = Pick<TelegramService,
  'requestCode' |
  'connect' |
  'sync' |
  'loadChatMessages' |
  'loadOlderChatMessages' |
  'disconnect' |
  'selectWorkspace' |
  'setChatNotifications'
> & {
  getInboxSnapshot(): Promise<TelegramInboxSnapshot>;
  getThread(payload: TelegramThreadRequest): Promise<TelegramThreadView>;
  markThreadRead(payload: TelegramThreadKey): Promise<TelegramInboxSnapshot>;
  sendMessage(payload: {
    chatId: string;
    topicId?: string;
    replyToMessageId?: string;
    text: string;
    file?: TelegramOutgoingFile;
    image?: TelegramOutgoingFile;
  }): Promise<AppState>;
  reactToMessage(payload: { messageId: string; emoticon: string }): Promise<AppState>;
  downloadAttachment(payload: TelegramAttachmentDownloadPayload): Promise<TelegramAttachmentDownloadResult>;
};

type FocusedTdlibInbox = Pick<TelegramInboxService, 'getInboxSnapshot' | 'getThread' | 'markThreadRead'>;

export class TdlibTelegramFacade implements TelegramIpcService {
  constructor(
    private readonly legacy: TelegramIpcService,
    private readonly tdlibInbox: FocusedTdlibInbox
  ) {}

  requestCode(payload: { phone: string; proxyUrl?: string }): Promise<AppState> {
    return this.legacy.requestCode(payload);
  }

  connect(payload: { code: string; password?: string }): Promise<AppState> {
    return this.legacy.connect(payload);
  }

  sync(): Promise<AppState> {
    return this.legacy.sync();
  }

  getInboxSnapshot(): Promise<TelegramInboxSnapshot> {
    return this.tdlibInbox.getInboxSnapshot();
  }

  getThread(payload: TelegramThreadRequest): Promise<TelegramThreadView> {
    return this.tdlibInbox.getThread(payload);
  }

  markThreadRead(payload: TelegramThreadKey): Promise<TelegramInboxSnapshot> {
    return this.tdlibInbox.markThreadRead(payload);
  }

  loadChatMessages(payload: { chatId: string; topicId?: string }): Promise<AppState> {
    return this.legacy.loadChatMessages(payload);
  }

  loadOlderChatMessages(payload: { chatId: string; topicId?: string; beforeMessageId: string }): Promise<AppState> {
    return this.legacy.loadOlderChatMessages(payload);
  }

  sendMessage(payload: {
    chatId: string;
    topicId?: string;
    replyToMessageId?: string;
    text: string;
    file?: TelegramOutgoingFile;
    image?: TelegramOutgoingFile;
  }): Promise<AppState> {
    return this.legacy.sendMessage(payload);
  }

  reactToMessage(payload: { messageId: string; emoticon: string }): Promise<AppState> {
    return this.legacy.reactToMessage(payload);
  }

  downloadAttachment(payload: TelegramAttachmentDownloadPayload): Promise<TelegramAttachmentDownloadResult> {
    return this.legacy.downloadAttachment(payload);
  }

  disconnect(): AppState {
    return this.legacy.disconnect();
  }

  selectWorkspace(payload: { folderId: string | null; chatIds: string[] }): Promise<AppState> {
    return this.legacy.selectWorkspace(payload);
  }

  setChatNotifications(payload: { chatId: string; enabled: boolean }): AppState {
    return this.legacy.setChatNotifications(payload);
  }
}
