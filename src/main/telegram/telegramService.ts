import { TelegramClient, Api } from 'telegram';
import { CustomFile } from 'telegram/client/uploads';
import { NewMessage, Raw, type NewMessageEvent } from 'telegram/events';
import { DeletedMessage, type DeletedMessageEvent } from 'telegram/events/DeletedMessage';
import { StringSession } from 'telegram/sessions';
import type { ProxyInterface } from 'telegram/network/connection/TCPMTProxy';
import { getPeerId } from 'telegram/Utils';
import type { EntityLike } from 'telegram/define';
import { app } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  defaultState,
  maskPhone,
  now,
  telegramDefaultProxyUrl,
  withTimeout
} from '../domain/appState';
import type {
  AppState,
  PendingTelegramLogin,
  TelegramChat,
  TelegramCredentials,
  TelegramFolder,
  TelegramAttachmentDownloadPayload,
  TelegramAttachmentDownloadResult,
  TelegramInboxSnapshot,
  TelegramMessageAttachment,
  TelegramMessageReaction,
  TelegramOutgoingFile,
  TelegramMessage,
  TelegramThreadKey,
  TelegramThreadRequest,
  TelegramThreadView,
  TelegramTopic
} from '../domain/types';
import { LocalStore } from '../storage/localStore';

const MAX_IMAGE_PREVIEW_BYTES = 8 * 1024 * 1024;
const MAX_STICKER_PREVIEW_BYTES = 4 * 1024 * 1024;
const MAX_OUTGOING_FILE_BYTES = 100 * 1024 * 1024;
const TELEGRAM_DIALOG_SYNC_LIMIT = 300;
const TELEGRAM_RECENT_MESSAGE_SYNC_CHAT_LIMIT = 24;
const TELEGRAM_BACKGROUND_SYNC_INTERVAL_MS = 30 * 1000;
const TELEGRAM_BACKGROUND_SYNC_DEBOUNCE_MS = 1500;
const missingTelegramCredentialsMessage =
  'Telegram api_id/api_hash не настроены. Заполните TELEGRAM_API_ID и TELEGRAM_API_HASH в .env.';
const TELEGRAM_API_ID_ENV_KEY = 'TELEGRAM_API_ID';
const TELEGRAM_API_HASH_ENV_KEY = 'TELEGRAM_API_HASH';

function localTelegramFileUrl(filePath: string): string {
  return `teamspace-file://telegram/${Buffer.from(filePath, 'utf8').toString('base64url')}`;
}

export interface TelegramNewMessageEvent {
  state: AppState;
  chat: TelegramChat;
  message: TelegramMessage;
}

export interface TelegramServiceEvents {
  onStateChanged?: (state: AppState) => void;
  onNewMessage?: (event: TelegramNewMessageEvent) => void;
}

function assertProxyPort(port: number): number {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Telegram proxy требует корректный port.');
  }
  return port;
}

function parseMtProxyUrl(url: URL): ProxyInterface {
  const secret = url.searchParams.get('secret') || url.password;
  if (!url.hostname) {
    throw new Error('MTProxy требует server.');
  }
  if (!secret) {
    throw new Error('MTProxy требует secret.');
  }
  return {
    ip: url.hostname,
    port: assertProxyPort(Number(url.port)),
    secret,
    MTProxy: true,
    timeout: 10
  };
}

function parseTelegramProxyDeepLink(url: URL): ProxyInterface {
  const server = url.searchParams.get('server')?.trim() ?? '';
  const port = url.searchParams.get('port')?.trim() ?? '';
  const secret = url.searchParams.get('secret')?.trim() ?? '';
  if (!server) {
    throw new Error('Telegram proxy link требует server.');
  }
  if (!secret) {
    throw new Error('Telegram proxy link требует secret.');
  }
  return {
    ip: server,
    port: assertProxyPort(Number(port)),
    secret,
    MTProxy: true,
    timeout: 10
  };
}

export function parseTelegramProxy(proxyUrl: string): ProxyInterface | undefined {
  const trimmed = proxyUrl.trim();
  if (!trimmed) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      'Telegram proxy должен быть mtproxy://, https://t.me/proxy?... или socks5://, socks5h://, socks4://.'
    );
  }

  if (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    (url.hostname === 't.me' || url.hostname === 'telegram.me') &&
    url.pathname === '/proxy'
  ) {
    return parseTelegramProxyDeepLink(url);
  }

  if (url.protocol === 'mtproxy:') {
    return parseMtProxyUrl(url);
  }

  if (url.protocol !== 'socks5:' && url.protocol !== 'socks5h:' && url.protocol !== 'socks4:') {
    throw new Error(
      'Telegram proxy должен быть mtproxy://, https://t.me/proxy?... или socks5://, socks5h://, socks4://.'
    );
  }

  return {
    ip: url.hostname,
    port: assertProxyPort(Number(url.port)),
    socksType: url.protocol === 'socks4:' ? 4 : 5,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    timeout: 10
  };
}

export class TelegramService {
  private telegramClient: TelegramClient | null = null;
  private pendingTelegramLogin: PendingTelegramLogin | null = null;
  private clientKey: string | null = null;
  private clientPromise: Promise<TelegramClient> | null = null;
  private realtimeClient: TelegramClient | null = null;
  private realtimeNewMessageEvent: NewMessage | null = null;
  private realtimeNewMessageHandler: ((event: NewMessageEvent) => void) | null = null;
  private realtimeDeletedMessageEvent: DeletedMessage | null = null;
  private realtimeDeletedMessageHandler: ((event: DeletedMessageEvent) => void) | null = null;
  private realtimeRawEvent: Raw | null = null;
  private realtimeRawHandler: ((update: Api.TypeUpdate) => void) | null = null;
  private backgroundSyncClient: TelegramClient | null = null;
  private backgroundSyncTimer: ReturnType<typeof setInterval> | null = null;
  private backgroundSyncTimeout: ReturnType<typeof setTimeout> | null = null;
  private backgroundSyncPromise: Promise<void> | null = null;

  constructor(
    private readonly store: LocalStore,
    private readonly events: TelegramServiceEvents = {}
  ) {}

  async requestCode(payload: { apiId?: string; apiHash?: string; phone: string; proxyUrl?: string }): Promise<AppState> {
    const savedCredentials = this.readCredentials();
    const apiId = Number(process.env[TELEGRAM_API_ID_ENV_KEY]?.trim() || payload.apiId || savedCredentials?.apiId);
    const apiHash = process.env[TELEGRAM_API_HASH_ENV_KEY]?.trim() || payload.apiHash?.trim() || savedCredentials?.apiHash || '';
    const phone = payload.phone.trim();
    const proxyUrl = payload.proxyUrl?.trim() || telegramDefaultProxyUrl;

    if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash || !phone) {
      throw new Error('Заполните TELEGRAM_API_ID, TELEGRAM_API_HASH в .env и введите номер телефона.');
    }

    try {
      const client = await this.getClient({ apiId, apiHash }, proxyUrl);
      const result = await withTimeout(
        client.sendCode({ apiId, apiHash }, phone),
        20000,
        'Telegram send code'
      );
      this.pendingTelegramLogin = {
        apiId,
        apiHash,
        phone,
        proxyUrl,
        phoneCodeHash: result.phoneCodeHash
      };
      this.store.setSecret('telegramApiCredentials', JSON.stringify({ apiId, apiHash }));
      if (proxyUrl) {
        this.store.setSecret('telegramProxyUrl', proxyUrl);
      } else {
        this.store.deleteSecret('telegramProxyUrl');
      }
      return this.store.setState((state) => {
        state.telegram.status = 'disconnected';
        state.telegram.phoneMasked = maskPhone(phone);
        state.telegram.hasApiCredentials = true;
        state.telegram.codeRequested = true;
        state.telegram.codeDelivery = result.isCodeViaApp ? 'Telegram app' : 'SMS';
        state.telegram.error = null;
      });
    } catch (error) {
      return this.store.setState((state) => {
        state.telegram.status = 'error';
        state.telegram.error =
          error instanceof Error ? error.message : 'Не удалось запросить Telegram-код.';
      });
    }
  }

  async connect(payload: { code: string; password?: string }): Promise<AppState> {
    if (!this.pendingTelegramLogin || !this.telegramClient) {
      throw new Error('Сначала запросите Telegram-код.');
    }

    try {
      await this.telegramClient.invoke(
        new Api.auth.SignIn({
          phoneNumber: this.pendingTelegramLogin.phone,
          phoneCodeHash: this.pendingTelegramLogin.phoneCodeHash,
          phoneCode: payload.code.trim()
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (!message.includes('SESSION_PASSWORD_NEEDED')) {
        return this.store.setState((state) => {
          state.telegram.status = 'error';
          state.telegram.error = message || 'Telegram не принял код подтверждения.';
        });
      }
      if (!payload.password) {
        return this.store.setState((state) => {
          state.telegram.status = 'error';
          state.telegram.error = 'Для этого Telegram-аккаунта нужен 2FA-пароль.';
        });
      }
      await this.telegramClient.signInWithPassword(
        { apiId: this.pendingTelegramLogin.apiId, apiHash: this.pendingTelegramLogin.apiHash },
        {
          password: async () => payload.password ?? '',
          onError: async (err) => {
            throw err;
          }
        }
      );
    }

    this.store.setSecret('telegramSession', this.serializeSession(this.telegramClient));
    const workspace = await this.loadWorkspace(this.telegramClient, this.store.getState().telegram);
    const phoneMasked = maskPhone(this.pendingTelegramLogin.phone);
    this.pendingTelegramLogin = null;

    const nextState = this.store.setState((state) => {
      state.telegram = {
        ...state.telegram,
        ...workspace,
        status: 'connected',
        phoneMasked,
        hasApiCredentials: true,
        codeRequested: false,
        codeDelivery: null,
        error: null
      };
    });
    this.startRealtimeUpdates(this.telegramClient);
    return nextState;
  }

  async sync(): Promise<AppState> {
    const client = await this.getStoredClient();
    const nextState = await this.syncWorkspaceState(client);
    this.startRealtimeUpdates(client);
    return nextState;
  }

  async getInboxSnapshot(): Promise<TelegramInboxSnapshot> {
    const telegram = this.store.getState().telegram;
    const chats = telegram.chats.map((chat) => ({
      id: chat.id,
      title: chat.title,
      type: chat.type,
      avatar: chat.avatar,
      selected: chat.selected,
      notificationsEnabled: chat.notificationsEnabled !== false,
      hasTopics: chat.hasTopics,
      unreadCount: chat.unreadCount ?? 0,
      lastMessageAt: chat.lastMessageAt
    }));
    const selectedUnreadCount = chats
      .filter((chat) => chat.selected)
      .reduce((total, chat) => total + Math.max(0, chat.unreadCount), 0);
    const notifyingUnreadCount = chats
      .filter((chat) => chat.selected && chat.notificationsEnabled)
      .reduce((total, chat) => total + Math.max(0, chat.unreadCount), 0);
    return {
      status: telegram.status,
      phoneMasked: telegram.phoneMasked,
      chats,
      topics: telegram.topics,
      unread: { selectedUnreadCount, notifyingUnreadCount },
      error: telegram.error
    };
  }

  async getThread(payload: TelegramThreadRequest): Promise<TelegramThreadView> {
    const state = await this.loadChatMessages({ chatId: payload.chatId, topicId: payload.topicId ?? undefined });
    const messages = state.telegram.messages
      .filter((message) => message.chatId === payload.chatId)
      .filter((message) => !payload.topicId || message.topicId === payload.topicId)
      .sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime());
    return {
      key: { chatId: payload.chatId, topicId: payload.topicId },
      messages,
      hasOlder: messages.length >= (payload.limit ?? 50),
      loading: false
    };
  }

  async markThreadRead(payload: TelegramThreadKey): Promise<TelegramInboxSnapshot> {
    await this.loadChatMessages({ chatId: payload.chatId, topicId: payload.topicId ?? undefined });
    return this.getInboxSnapshot();
  }

  async loadChatMessages(payload: { chatId: string; topicId?: string }): Promise<AppState> {
    const client = await this.getStoredClient();
    const { chatId } = payload;
    const dialog = await this.findDialog(client, chatId);
    if (!dialog?.entity) {
      throw new Error('Telegram-чат не найден.');
    }
    const existingTelegram = this.store.getState().telegram;
    const topic = this.topicForRequest(existingTelegram.topics, chatId, payload.topicId);
    const messages = await this.loadMessagesForDialog(
      client,
      chatId,
      dialog.entity,
      existingTelegram,
      0,
      topic
    );
    await withTimeout(client.markAsRead(dialog.entity), 20000, 'Telegram mark chat read');
    this.store.setSecret('telegramSession', this.serializeSession(client));
    return this.store.setState((state) => {
      state.telegram.messages = this.mergeLoadedMessages(
        state.telegram.messages,
        messages,
        { chatId, topicId: topic?.id }
      );
      state.telegram.chats = state.telegram.chats.map((chat) =>
        chat.id === chatId
          ? {
              ...chat,
              lastSyncedAt: now(),
              lastMessageAt: this.lastMessageAt(state.telegram.messages, chat.id),
              unreadCount: 0
            }
          : chat
      );
      if (topic) {
        state.telegram.topics = state.telegram.topics.map((item) =>
          item.id === topic.id
            ? {
                ...item,
                unreadCount: 0,
                lastMessageAt: this.lastTopicMessageAt(state.telegram.messages, item.id)
              }
            : item
        );
      }
      state.telegram.status = 'connected';
      state.telegram.error = null;
    });
  }

  async loadOlderChatMessages(payload: { chatId: string; topicId?: string; beforeMessageId: string }): Promise<AppState> {
    const offsetId = this.messageNumericId(payload.beforeMessageId);
    if (!offsetId) {
      return this.store.getState();
    }

    const client = await this.getStoredClient();
    const topic = this.topicForRequest(this.store.getState().telegram.topics, payload.chatId, payload.topicId);
    const messages = await this.loadMessagesForChat(
      client,
      payload.chatId,
      this.store.getState().telegram,
      offsetId,
      topic?.id
    );
    this.store.setSecret('telegramSession', this.serializeSession(client));
    return this.store.setState((state) => {
      state.telegram.messages = this.mergeLoadedMessages(
        state.telegram.messages,
        messages,
        { chatId: payload.chatId, topicId: topic?.id },
        offsetId
      );
      state.telegram.chats = state.telegram.chats.map((chat) =>
        chat.id === payload.chatId
          ? {
              ...chat,
              lastSyncedAt: now(),
              lastMessageAt: this.lastMessageAt(state.telegram.messages, chat.id)
            }
          : chat
      );
      if (topic) {
        state.telegram.topics = state.telegram.topics.map((item) =>
          item.id === topic.id
            ? {
                ...item,
                lastMessageAt: this.lastTopicMessageAt(state.telegram.messages, item.id)
              }
            : item
        );
      }
      state.telegram.status = 'connected';
      state.telegram.error = null;
    });
  }

  async sendMessage(payload: {
    chatId: string;
    topicId?: string;
    replyToMessageId?: string;
    text: string;
    file?: TelegramOutgoingFile;
    image?: TelegramOutgoingFile;
  }): Promise<AppState> {
    const text = payload.text.trim();
    const outgoingFile = this.normalizeOutgoingFile(payload.file ?? payload.image);
    if (!text && !outgoingFile) {
      throw new Error('Введите текст сообщения или добавьте файл.');
    }

    const client = await this.getStoredClient();
    const dialog = await this.findDialog(client, payload.chatId);
    if (!dialog?.entity) {
      throw new Error('Telegram-чат не найден.');
    }

    const existingTelegram = this.store.getState().telegram;
    const topic = this.topicForRequest(existingTelegram.topics, payload.chatId, payload.topicId);
    const topMessageId = topic ? this.topicMessageIds(topic)[0] ?? 0 : 0;
    const replyToMessageId = this.replyToMessageIdForSend(payload.chatId, payload.replyToMessageId);
    const replyToNumericId = replyToMessageId ? this.messageNumericId(replyToMessageId) : 0;
    const replyTo = replyToNumericId || topMessageId || undefined;
    let outgoingFileMessage: TelegramMessage | null = null;

    if (outgoingFile) {
      const file = new CustomFile(outgoingFile.name, outgoingFile.buffer.byteLength, '', outgoingFile.buffer);
      const sentMessage = await withTimeout(
        client.sendFile(dialog.entity, {
          file,
          caption: text,
          forceDocument: !this.isImageMimeType(outgoingFile.mimeType),
          replyTo,
          topMsgId: topMessageId || undefined
        }),
        60000,
        'Telegram send file'
      );
      outgoingFileMessage = this.outgoingFileFallbackMessage(
        payload.chatId,
        topic?.id ?? null,
        sentMessage,
        text,
        outgoingFile,
        replyToMessageId,
        existingTelegram.messages
      );
    } else {
      await withTimeout(
        client.sendMessage(dialog.entity, {
          message: text,
          replyTo,
          topMsgId: topMessageId || undefined
        }),
        20000,
        'Telegram send message'
      );
    }

    const messages = await this.loadMessagesForChat(
      client,
      payload.chatId,
      this.store.getState().telegram,
      0,
      topic?.id
    );
    const messagesToMerge = outgoingFileMessage ? [...messages, outgoingFileMessage] : messages;
    this.store.setSecret('telegramSession', this.serializeSession(client));
    return this.store.setState((state) => {
      state.telegram.messages = this.mergeMessages(state.telegram.messages, messagesToMerge);
      state.telegram.chats = state.telegram.chats.map((chat) =>
        chat.id === payload.chatId
          ? {
              ...chat,
              lastSyncedAt: now(),
              lastMessageAt: this.lastMessageAt(state.telegram.messages, chat.id),
              unreadCount: 0
            }
          : chat
      );
      state.telegram.status = 'connected';
      state.telegram.error = null;
    });
  }

  async reactToMessage(payload: { messageId: string; emoticon: string }): Promise<AppState> {
    const emoticon = payload.emoticon.trim();
    const chatId = this.chatIdFromMessageId(payload.messageId);
    const msgId = this.messageNumericId(payload.messageId);
    if (!chatId || !msgId || !emoticon) {
      throw new Error('Сообщение Telegram для реакции не найдено.');
    }

    const client = await this.getStoredClient();
    const dialog = await this.findDialog(client, chatId);
    if (!dialog?.entity) {
      throw new Error('Telegram-чат не найден.');
    }

    await withTimeout(
      client.invoke(new Api.messages.SendReaction({
        peer: dialog.entity,
        msgId,
        reaction: [new Api.ReactionEmoji({ emoticon })],
        addToRecent: true
      })),
      20000,
      'Telegram send reaction'
    );
    this.store.setSecret('telegramSession', this.serializeSession(client));

    return this.store.setState((state) => {
      state.telegram.messages = state.telegram.messages.map((message) =>
        message.id === payload.messageId
          ? {
              ...message,
              reactions: this.applyOwnReaction(message.reactions ?? [], emoticon),
              updatedAt: now()
            }
          : message
      );
      state.telegram.status = 'connected';
      state.telegram.error = null;
    });
  }

  async downloadAttachment(
    payload: TelegramAttachmentDownloadPayload
  ): Promise<TelegramAttachmentDownloadResult> {
    const numericMessageId = this.messageNumericId(payload.messageId);
    const chatId = this.chatIdFromMessageId(payload.messageId);
    if (!chatId || !numericMessageId) {
      throw new Error('Не удалось определить сообщение Telegram для скачивания.');
    }

    const client = await this.getStoredClient();
    const dialog = await this.findDialog(client, chatId);
    if (!dialog?.entity) {
      throw new Error('Telegram-чат не найден.');
    }

    const messages = await client.getMessages(dialog.entity, { ids: numericMessageId });
    const message = (messages as Api.Message[])[0];
    if (!message || !this.messageHasAttachment(message)) {
      throw new Error('Вложение Telegram не найдено.');
    }

    const stateMessage = this.store.getState().telegram.messages.find((item) => item.id === payload.messageId);
    const attachment = stateMessage?.attachments?.find((item) => item.id === payload.attachmentId);
    const fileName = this.safeFileName(attachment?.fileName || this.messageFileName(message));
    const directory = path.join(app.getPath('downloads'), 'Team Space Telegram Files');
    const filePath = path.join(directory, this.uniqueDownloadName(fileName, numericMessageId));

    await mkdir(directory, { recursive: true });
    const result = await withTimeout(
      client.downloadMedia(message, { outputFile: filePath }),
      120000,
      'Telegram download attachment'
    );
    if (Buffer.isBuffer(result)) {
      await writeFile(filePath, result);
    }

    return {
      filePath,
      fileUrl: localTelegramFileUrl(filePath)
    };
  }

  disconnect(): AppState {
    this.pendingTelegramLogin = null;
    this.stopRealtimeUpdates();
    this.stopBackgroundSync();
    this.telegramClient?.disconnect();
    this.telegramClient = null;
    this.clientKey = null;
    this.clientPromise = null;
    this.store.deleteSecret('telegramSession');
    this.store.deleteSecret('telegramApiCredentials');
    this.store.deleteSecret('telegramProxyUrl');
    return this.store.setState((state) => {
      state.telegram = defaultState().telegram;
    });
  }

  async selectWorkspace(payload: { folderId: string | null; chatIds: string[] }): Promise<AppState> {
    this.store.setState((state) => {
      state.telegram.selectedFolderId = payload.folderId;
      state.telegram.chats = state.telegram.chats.map((chat) => ({
        ...chat,
        selected: payload.chatIds.includes(chat.id)
      }));
    });

    if (this.telegramClient) {
      const workspace = await this.loadWorkspace(this.telegramClient, this.store.getState().telegram);
      return this.store.setState((state) => {
        state.telegram = {
          ...state.telegram,
          ...workspace,
          selectedFolderId: payload.folderId
        };
      });
    }

    return this.store.getState();
  }

  setChatNotifications(payload: { chatId: string; enabled: boolean }): AppState {
    return this.store.setState((state) => {
      state.telegram.chats = state.telegram.chats.map((chat) =>
        chat.id === payload.chatId
          ? {
              ...chat,
              notificationsEnabled: payload.enabled
            }
          : chat
      );
    });
  }

  private async syncWorkspaceState(client: TelegramClient): Promise<AppState> {
    const workspace = await this.loadWorkspace(client, this.store.getState().telegram);
    this.store.setSecret('telegramSession', this.serializeSession(client));
    return this.store.setState((state) => {
      state.telegram = {
        ...state.telegram,
        ...workspace,
        status: 'connected',
        error: null
      };
    });
  }

  private readCredentials(): TelegramCredentials | null {
    const raw = this.store.getSecret('telegramApiCredentials');
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as TelegramCredentials;
      if (!parsed.apiId || !parsed.apiHash) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private async getClient(credentials: TelegramCredentials, proxyUrl = ''): Promise<TelegramClient> {
    const nextClientKey = `${credentials.apiId}:${credentials.apiHash}:${proxyUrl}`;
    if (this.telegramClient?.connected && this.clientKey === nextClientKey) {
      return this.telegramClient;
    }
    if (this.clientPromise && this.clientKey === nextClientKey) {
      return this.clientPromise;
    }

    this.stopRealtimeUpdates();
    if (this.telegramClient?.connected) {
      await this.telegramClient.disconnect().catch(() => undefined);
    }

    const session = this.store.getSecret('telegramSession') ?? '';
    let stringSession: StringSession;
    try {
      stringSession = new StringSession(session);
    } catch {
      if (session) {
        this.store.deleteSecret('telegramSession');
      }
      stringSession = new StringSession('');
    }
    this.clientKey = nextClientKey;
    const nextClient = new TelegramClient(stringSession, credentials.apiId, credentials.apiHash, {
      connectionRetries: 2,
      retryDelay: 750,
      proxy: parseTelegramProxy(proxyUrl)
    });
    this.telegramClient = nextClient;
    const connectionPromise = withTimeout(nextClient.connect(), 15000, 'Telegram connect')
      .then(() => nextClient)
      .finally(() => {
        if (this.clientPromise === connectionPromise) {
          this.clientPromise = null;
        }
      });
    this.clientPromise = connectionPromise;
    return this.clientPromise;
  }

  private async getStoredClient(): Promise<TelegramClient> {
    const credentials = this.readCredentials();
    if (!credentials) {
      this.stopRealtimeUpdates();
      this.stopBackgroundSync();
      void this.telegramClient?.disconnect().catch(() => undefined);
      this.telegramClient = null;
      this.clientKey = null;
      this.clientPromise = null;
      this.store.setState((state) => {
        state.telegram.status = 'error';
        state.telegram.hasApiCredentials = false;
        state.telegram.error = missingTelegramCredentialsMessage;
      });
      throw new Error(missingTelegramCredentialsMessage);
    }
    const client = await this.getClient(credentials, this.store.getSecret('telegramProxyUrl') ?? telegramDefaultProxyUrl);
    this.startRealtimeUpdates(client);
    return client;
  }

  private serializeSession(client: TelegramClient): string {
    return (client.session as StringSession).save();
  }

  private entityType(entity: unknown): TelegramChat['type'] {
    const className = (entity as { className?: string }).className;
    if (className === 'User') {
      return 'private';
    }
    if (className === 'Channel') {
      return (entity as { megagroup?: boolean }).megagroup ? 'group' : 'channel';
    }
    return 'group';
  }

  private entityHasTopics(entity: unknown): boolean {
    return Boolean((entity as { forum?: boolean }).forum);
  }

  private entityDisplayName(entity: unknown): string {
    const sender = entity as
      | { firstName?: string; lastName?: string; username?: string; title?: string }
      | undefined;
    if (!sender) {
      return 'Unknown';
    }
    return [sender.firstName, sender.lastName].filter(Boolean).join(' ') || sender.title || sender.username || 'Unknown';
  }

  private senderName(message: Api.Message, sender?: EntityLike | null): string {
    return this.entityDisplayName(sender ?? message.sender);
  }

  private photoDataUrl(photo: unknown): string | null {
    if (!Buffer.isBuffer(photo) || photo.length === 0) {
      return null;
    }
    return `data:image/jpeg;base64,${photo.toString('base64')}`;
  }

  private entityId(entity: unknown): string | null {
    if (!entity) {
      return null;
    }

    try {
      return String(getPeerId(entity as EntityLike));
    } catch {
      const entityId = (entity as { id?: unknown }).id;
      if (entityId && typeof (entityId as { toString?: unknown }).toString === 'function') {
        return String(entityId);
      }
      if (typeof entity === 'string' || typeof entity === 'number' || typeof entity === 'bigint') {
        return String(entity);
      }
      if (typeof (entity as { toString?: unknown }).toString === 'function') {
        const stringValue = String(entity);
        return stringValue === '[object Object]' ? null : stringValue;
      }
      return null;
    }
  }

  private async avatarForEntity(
    client: TelegramClient,
    entity: EntityLike | undefined,
    key: string | null,
    cache: Map<string, string | null>
  ): Promise<string | null> {
    const cacheKey = key ?? this.entityId(entity);

    if (!cacheKey) {
      return null;
    }
    if (cache.has(cacheKey)) {
      return cache.get(cacheKey) ?? null;
    }

    const storedAvatar = this.store.getTelegramAvatar(cacheKey);
    if (storedAvatar?.dataUrl) {
      cache.set(cacheKey, storedAvatar.dataUrl);
      return storedAvatar.dataUrl;
    }

    if (!entity) {
      return null;
    }

    try {
      const photo = await client.downloadProfilePhoto(entity, { isBig: false });
      const avatar = this.photoDataUrl(photo);
      cache.set(cacheKey, avatar);
      this.store.saveTelegramAvatar(cacheKey, avatar);
      return avatar;
    } catch {
      cache.set(cacheKey, null);
      this.store.saveTelegramAvatar(cacheKey, null);
      return null;
    }
  }

  private async resolveMessageSender(
    client: TelegramClient,
    message: Api.Message
  ): Promise<{ senderId: string | null; sender: EntityLike | undefined }> {
    let sender = message.sender as EntityLike | undefined;
    let rawSenderId = (message as unknown as { senderId?: unknown }).senderId;

    if (!rawSenderId) {
      rawSenderId = (message as unknown as { peerId?: unknown }).peerId;
    }

    if (!sender && typeof message.getSender === 'function') {
      try {
        sender = await message.getSender();
      } catch {
        sender = undefined;
      }
    }

    if (!sender && rawSenderId) {
      try {
        sender = await client.getEntity(rawSenderId as EntityLike);
      } catch {
        sender = undefined;
      }
    }

    return {
      senderId: this.entityId(sender) ?? this.entityId(rawSenderId),
      sender
    };
  }

  private textValue(value: unknown): string {
    if (!value) {
      return '';
    }
    if (typeof value === 'string') {
      return value;
    }
    return (value as { text?: string }).text ?? '';
  }

  private normalizeOutgoingFile(
    file: TelegramOutgoingFile | undefined
  ): { name: string; mimeType: string; buffer: Buffer } | null {
    if (!file) {
      return null;
    }

    const name = this.safeFileName(file.name.trim() || this.defaultFileName(file.mimeType));
    const mimeType = this.normalizeMimeType(file.mimeType, name);
    const buffer = Buffer.from(file.data);
    if (buffer.byteLength === 0) {
      throw new Error('Файл пустой.');
    }
    if (buffer.byteLength > MAX_OUTGOING_FILE_BYTES) {
      throw new Error('Файл больше 100 МБ. Уменьшите файл и попробуйте снова.');
    }

    return {
      name,
      mimeType,
      buffer
    };
  }

  private normalizeMimeType(mimeType: string, fileName: string): string {
    const normalizedMimeType = mimeType.trim().toLowerCase();
    if (normalizedMimeType) {
      return normalizedMimeType;
    }

    const extension = fileName.split('.').pop()?.toLowerCase();
    if (extension === 'jpg' || extension === 'jpeg') {
      return 'image/jpeg';
    }
    if (extension === 'webp') {
      return 'image/webp';
    }
    if (extension === 'webm') {
      return 'video/webm';
    }
    if (extension === 'mp4' || extension === 'm4v') {
      return 'video/mp4';
    }
    if (extension === 'mov') {
      return 'video/quicktime';
    }
    if (extension === 'gif') {
      return 'image/gif';
    }
    if (extension === 'bmp') {
      return 'image/bmp';
    }
    if (extension === 'tif' || extension === 'tiff') {
      return 'image/tiff';
    }
    if (extension === 'png') {
      return 'image/png';
    }
    if (extension === 'pdf') {
      return 'application/pdf';
    }
    if (extension === 'zip') {
      return 'application/zip';
    }
    if (extension === 'json') {
      return 'application/json';
    }
    if (extension === 'txt' || extension === 'log' || extension === 'md') {
      return 'text/plain';
    }
    return 'application/octet-stream';
  }

  private isImageMimeType(mimeType: string): boolean {
    return mimeType.toLowerCase().startsWith('image/');
  }

  private isStickerMimeType(mimeType: string, fileName = ''): boolean {
    const normalizedMimeType = mimeType.toLowerCase();
    const normalizedFileName = fileName.toLowerCase();
    return (
      normalizedMimeType === 'video/webm' ||
      normalizedMimeType === 'image/webp' ||
      normalizedFileName.includes('sticker')
    );
  }

  private attachmentTypeForMimeType(mimeType: string, fileName: string): TelegramMessageAttachment['type'] {
    if (this.isImageMimeType(mimeType)) {
      return this.isStickerMimeType(mimeType, fileName) ? 'sticker' : 'image';
    }
    return this.isStickerMimeType(mimeType, fileName) ? 'sticker' : 'file';
  }

  private sniffMimeType(buffer: Buffer): string | null {
    if (buffer.length >= 8 && buffer.toString('ascii', 4, 8) === 'ftyp') {
      return 'video/mp4';
    }
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return 'image/jpeg';
    }
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return 'image/png';
    }
    if (buffer.length >= 6 && buffer.toString('ascii', 0, 3) === 'GIF') {
      return 'image/gif';
    }
    if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
      return 'image/webp';
    }
    return null;
  }

  private dataUrlForAttachment(file: { mimeType: string; buffer: Buffer }): string | null {
    if (!this.isImageMimeType(file.mimeType) || file.buffer.byteLength > MAX_IMAGE_PREVIEW_BYTES) {
      return null;
    }
    return `data:${file.mimeType};base64,${file.buffer.toString('base64')}`;
  }

  private outgoingFileFallbackMessage(
    chatId: string,
    topicId: string | null,
    message: Api.Message,
    text: string,
    file: { name: string; mimeType: string; buffer: Buffer },
    replyToMessageId: string | null,
    existingMessages: TelegramMessage[]
  ): TelegramMessage | null {
    if (!message.id) {
      return null;
    }

    const timestamp = message.date
      ? new Date(Number(message.date) * 1000).toISOString()
      : now();
    return {
      id: `${chatId}:${message.id}`,
      chatId,
      topicId,
      replyToMessageId,
      replyToSenderName: replyToMessageId
        ? existingMessages.find((item) => item.id === replyToMessageId)?.senderName ?? null
        : null,
      replyToText: replyToMessageId
        ? this.replyPreviewText(existingMessages.find((item) => item.id === replyToMessageId) ?? null)
        : null,
      senderId: null,
      senderName: 'Вы',
      senderAvatar: null,
      sentAt: timestamp,
      text,
      attachments: [{
        id: `${chatId}:${message.id}:attachment`,
        type: this.isImageMimeType(file.mimeType) ? 'image' : 'file',
        fileName: file.name,
        mimeType: file.mimeType,
        size: file.buffer.byteLength,
        dataUrl: this.dataUrlForAttachment(file)
      }],
      reactions: [],
      status: 'new',
      createdAt: timestamp,
      updatedAt: timestamp
    };
  }

  private defaultFileName(mimeType: string): string {
    if (mimeType === 'image/jpeg') {
      return 'image.jpg';
    }
    if (mimeType === 'image/webp') {
      return 'image.webp';
    }
    if (mimeType === 'application/pdf') {
      return 'file.pdf';
    }
    if (mimeType === 'image/png') {
      return 'image.png';
    }
    if (mimeType === 'video/mp4') {
      return 'video.mp4';
    }
    if (mimeType === 'video/webm') {
      return 'video.webm';
    }
    if (mimeType === 'video/quicktime') {
      return 'video.mov';
    }
    return 'file.bin';
  }

  private safeFileName(value: string): string {
    return value
      .trim()
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
      .replace(/\s+/g, ' ')
      .slice(0, 160) || 'file';
  }

  private uniqueDownloadName(fileName: string, messageId: number): string {
    const extensionIndex = fileName.lastIndexOf('.');
    if (extensionIndex <= 0) {
      return `${fileName}-${messageId}`;
    }
    return `${fileName.slice(0, extensionIndex)}-${messageId}${fileName.slice(extensionIndex)}`;
  }

  private peerIds(peers: unknown[] | undefined): string[] {
    return (peers ?? [])
      .map((peer) => {
        try {
          return getPeerId(peer as EntityLike);
        } catch {
          return null;
        }
      })
      .filter((id): id is string => Boolean(id));
  }

  private extractFilters(response: unknown): Array<Api.DialogFilter | Api.DialogFilterChatlist> {
    const filters = Array.isArray(response)
      ? response
      : (response as { filters?: unknown[] } | undefined)?.filters ?? [];

    return filters.filter(
      (filter): filter is Api.DialogFilter | Api.DialogFilterChatlist =>
        (filter as { className?: string }).className === 'DialogFilter' ||
        (filter as { className?: string }).className === 'DialogFilterChatlist'
    );
  }

  private chatIdsForFilter(
    filter: Api.DialogFilter | Api.DialogFilterChatlist,
    chats: TelegramChat[]
  ): string[] {
    const includeIds = new Set([
      ...this.peerIds(filter.pinnedPeers as unknown[]),
      ...this.peerIds(filter.includePeers as unknown[])
    ]);
    const excludeIds = new Set(
      'excludePeers' in filter ? this.peerIds(filter.excludePeers as unknown[]) : []
    );

    if (filter.className === 'DialogFilter') {
      for (const chat of chats) {
        if (filter.groups && chat.type === 'group') {
          includeIds.add(chat.id);
        }
        if (filter.broadcasts && chat.type === 'channel') {
          includeIds.add(chat.id);
        }
        if ((filter.contacts || filter.nonContacts) && chat.type === 'private') {
          includeIds.add(chat.id);
        }
      }
    }

    return [...includeIds].filter((id) => chats.some((chat) => chat.id === id) && !excludeIds.has(id));
  }

  private mergeMessageStatus(
    existingMessages: TelegramMessage[],
    nextMessage: TelegramMessage
  ): TelegramMessage {
    const existing = existingMessages.find((message) => message.id === nextMessage.id);
    return existing ? this.mergeExistingMessageStatus(existing, nextMessage) : nextMessage;
  }

  private mergeExistingMessageStatus(
    existing: TelegramMessage,
    nextMessage: TelegramMessage
  ): TelegramMessage {
    return {
      ...nextMessage,
      topicId: nextMessage.topicId ?? existing.topicId ?? null,
      replyToMessageId: nextMessage.replyToMessageId ?? existing.replyToMessageId ?? null,
      replyToSenderName: nextMessage.replyToSenderName ?? existing.replyToSenderName ?? null,
      replyToText: nextMessage.replyToText ?? existing.replyToText ?? null,
      senderId: nextMessage.senderId ?? existing.senderId ?? null,
      senderAvatar: nextMessage.senderAvatar ?? existing.senderAvatar ?? null,
      attachments: this.mergeAttachments(existing.attachments ?? [], nextMessage.attachments ?? []),
      status: existing.status,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt
    };
  }

  private lastMessageAtByChat(messages: TelegramMessage[]): Map<string, string> {
    const latestByChat = new Map<string, { sentAt: string; timestamp: number }>();
    for (const message of messages) {
      const timestamp = new Date(message.sentAt).getTime();
      const previous = latestByChat.get(message.chatId);
      if (!previous || timestamp > previous.timestamp) {
        latestByChat.set(message.chatId, { sentAt: message.sentAt, timestamp });
      }
    }
    return new Map([...latestByChat].map(([chatId, latest]) => [chatId, latest.sentAt]));
  }

  private lastMessageAtByTopic(messages: TelegramMessage[]): Map<string, string> {
    const latestByTopic = new Map<string, { sentAt: string; timestamp: number }>();
    for (const message of messages) {
      if (!message.topicId) {
        continue;
      }
      const timestamp = new Date(message.sentAt).getTime();
      const previous = latestByTopic.get(message.topicId);
      if (!previous || timestamp > previous.timestamp) {
        latestByTopic.set(message.topicId, { sentAt: message.sentAt, timestamp });
      }
    }
    return new Map([...latestByTopic].map(([topicId, latest]) => [topicId, latest.sentAt]));
  }

  private mergeAttachments(
    existingAttachments: TelegramMessageAttachment[],
    nextAttachments: TelegramMessageAttachment[]
  ): TelegramMessageAttachment[] {
    if (nextAttachments.length === 0) {
      return existingAttachments;
    }
    if (existingAttachments.length === 0) {
      return nextAttachments;
    }

    return existingAttachments.map((existingAttachment) => {
      const nextAttachment = nextAttachments.find((item) => item.id === existingAttachment.id);
      if (!nextAttachment) {
        return existingAttachment;
      }
      return {
        ...existingAttachment,
        type: nextAttachment.type,
        mimeType: nextAttachment.mimeType || existingAttachment.mimeType,
        fileName: nextAttachment.fileName || existingAttachment.fileName,
        size: nextAttachment.size ?? existingAttachment.size,
        dataUrl: existingAttachment.dataUrl ?? nextAttachment.dataUrl
      };
    });
  }

  private reactionsForMessage(
    message: unknown,
    usersByReaction = new Map<string, string[]>()
  ): TelegramMessageReaction[] {
    const results = ((message as {
      reactions?: { results?: Array<{ reaction?: unknown; count?: number; chosenOrder?: number }> };
    }).reactions?.results ?? []);

    return results
      .map((result): TelegramMessageReaction | null => {
        const emoticon = this.reactionEmoticon(result.reaction);
        if (!emoticon) {
          return null;
        }
        return {
          emoticon,
          count: Math.max(0, result.count ?? 0),
          mine: result.chosenOrder !== undefined,
          users: usersByReaction.get(emoticon) ?? []
        };
      })
      .filter((reaction): reaction is TelegramMessageReaction => Boolean(reaction));
  }

  private reactionEmoticon(reaction: unknown): string | null {
    const value = reaction as { className?: string; emoticon?: string } | null;
    return value?.className === 'ReactionEmoji' && value.emoticon ? value.emoticon : null;
  }

  private async reactionUsersForMessage(
    client: TelegramClient,
    entity: EntityLike,
    message: Api.Message
  ): Promise<Map<string, string[]>> {
    const reactions = this.reactionsForMessage(message);
    if (!message.id || reactions.length === 0) {
      return new Map();
    }

    const reactionState = (message as { reactions?: { canSeeList?: boolean } }).reactions;
    if (reactionState?.canSeeList === false) {
      return new Map();
    }

    const usersByReaction = new Map<string, string[]>();
    for (const reaction of reactions) {
      const names = await this.reactionUsersForEmoticon(client, entity, message.id, reaction.emoticon);
      if (names.length > 0) {
        usersByReaction.set(reaction.emoticon, names);
      }
    }
    return usersByReaction;
  }

  private async reactionUsersForEmoticon(
    client: TelegramClient,
    entity: EntityLike,
    messageId: number,
    emoticon: string
  ): Promise<string[]> {
    try {
      const response = await withTimeout(
        client.invoke(new Api.messages.GetMessageReactionsList({
          peer: entity,
          id: messageId,
          reaction: new Api.ReactionEmoji({ emoticon }),
          limit: 20
        })),
        10000,
        'Telegram load reaction users'
      );
      const entities = new Map<string, string>();
      for (const user of response.users ?? []) {
        const id = this.entityId(user);
        if (id) {
          entities.set(id, this.entityDisplayName(user));
        }
      }
      for (const chat of response.chats ?? []) {
        const id = this.entityId(chat);
        if (id) {
          entities.set(id, this.entityDisplayName(chat));
        }
      }

      const names: string[] = [];
      for (const item of response.reactions ?? []) {
        const reaction = this.reactionEmoticon((item as { reaction?: unknown }).reaction);
        if (reaction !== emoticon) {
          continue;
        }
        const peerId = this.entityId((item as { peerId?: unknown }).peerId);
        const name = peerId ? entities.get(peerId) : null;
        const displayName = name || ((item as { my?: boolean }).my ? 'Вы' : null);
        if (displayName && !names.includes(displayName)) {
          names.push(displayName);
        }
      }
      return names;
    } catch {
      return [];
    }
  }

  private applyOwnReaction(
    reactions: TelegramMessageReaction[],
    emoticon: string
  ): TelegramMessageReaction[] {
    const existing = reactions.find((reaction) => reaction.emoticon === emoticon);
    if (existing) {
      return reactions.map((reaction) =>
        reaction.emoticon === emoticon
          ? {
              ...reaction,
              count: reaction.mine ? reaction.count : reaction.count + 1,
              mine: true,
              users: reaction.users?.includes('Вы') ? reaction.users : ['Вы', ...(reaction.users ?? [])]
            }
          : reaction
      );
    }
    return [...reactions, { emoticon, count: 1, mine: true, users: ['Вы'] }];
  }

  private mergeMessages(
    existingMessages: TelegramMessage[],
    incomingMessages: TelegramMessage[]
  ): TelegramMessage[] {
    const messagesById = new Map(existingMessages.map((message) => [message.id, message]));
    for (const incomingMessage of incomingMessages) {
      const existingMessage = messagesById.get(incomingMessage.id);
      messagesById.set(
        incomingMessage.id,
        existingMessage
          ? this.mergeExistingMessageStatus(existingMessage, incomingMessage)
          : incomingMessage
      );
    }
    return [...messagesById.values()].sort(
      (a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime()
    );
  }

  private mergeLoadedMessages(
    existingMessages: TelegramMessage[],
    incomingMessages: TelegramMessage[],
    scope: { chatId: string; topicId?: string },
    offsetId = 0
  ): TelegramMessage[] {
    const mergedMessages = this.mergeMessages(existingMessages, incomingMessages);
    if (offsetId > 0) {
      return mergedMessages;
    }

    const incomingIds = new Set(incomingMessages.map((message) => message.id));
    const incomingNumericIds = incomingMessages
      .map((message) => this.messageNumericId(message.id))
      .filter((id) => id > 0);
    const oldestLoadedId = incomingNumericIds.length > 0 ? Math.min(...incomingNumericIds) : null;

    return mergedMessages.filter((message) => {
      if (!this.messageMatchesScope(message, scope)) {
        return true;
      }
      if (incomingIds.has(message.id)) {
        return true;
      }
      if (oldestLoadedId === null) {
        return false;
      }
      const numericId = this.messageNumericId(message.id);
      return numericId > 0 && numericId < oldestLoadedId;
    });
  }

  private messageMatchesScope(
    message: TelegramMessage,
    scope: { chatId: string; topicId?: string }
  ): boolean {
    return message.chatId === scope.chatId && (
      scope.topicId === undefined || message.topicId === scope.topicId
    );
  }

  private lastMessageAt(messages: TelegramMessage[], chatId: string): string | null {
    let latestMessageAt: string | null = null;
    let latestTimestamp = Number.NEGATIVE_INFINITY;
    for (const message of messages) {
      if (message.chatId !== chatId) {
        continue;
      }
      const timestamp = new Date(message.sentAt).getTime();
      if (timestamp > latestTimestamp) {
        latestTimestamp = timestamp;
        latestMessageAt = message.sentAt;
      }
    }
    return latestMessageAt;
  }

  private lastTopicMessageAt(messages: TelegramMessage[], topicId: string): string | null {
    let latestMessageAt: string | null = null;
    let latestTimestamp = Number.NEGATIVE_INFINITY;
    for (const message of messages) {
      if (message.topicId !== topicId) {
        continue;
      }
      const timestamp = new Date(message.sentAt).getTime();
      if (timestamp > latestTimestamp) {
        latestTimestamp = timestamp;
        latestMessageAt = message.sentAt;
      }
    }
    return latestMessageAt;
  }

  private topicSyntheticId(chatId: string, topicId: number | string): string {
    return `${chatId}:topic:${topicId}`;
  }

  private topicNumericId(topicId: string): string {
    return topicId.split(':topic:').at(-1) ?? topicId;
  }

  private topicMessageIds(topic: TelegramTopic): number[] {
    return [this.topicNumericId(topic.id), topic.topMessageId]
      .map((value) => Number(value))
      .filter((value, index, values) => Number.isFinite(value) && value > 0 && values.indexOf(value) === index);
  }

  private topicForRequest(topics: TelegramTopic[], chatId: string, topicId?: string): TelegramTopic | null {
    if (!topicId) {
      return null;
    }
    return topics.find((topic) => topic.chatId === chatId && topic.id === topicId) ?? null;
  }

  private topicIdForMessage(
    chatId: string,
    message: Api.Message,
    topics: TelegramTopic[],
    forcedTopicId?: string
  ): string | null {
    if (forcedTopicId) {
      return forcedTopicId;
    }

    const messageId = String(message.id);
    const replyTo = (message as unknown as {
      replyTo?: {
        forumTopic?: boolean;
        replyToMsgId?: number;
        replyToTopId?: number;
      };
    }).replyTo;
    const rawTopicMessageId = replyTo?.replyToTopId ?? (replyTo?.forumTopic ? replyTo.replyToMsgId : undefined);
    const topicMessageId = rawTopicMessageId ? String(rawTopicMessageId) : '';
    const chatTopics = topics.filter((topic) => topic.chatId === chatId);
    return chatTopics.find((topic) =>
      topic.topMessageId === topicMessageId ||
      topic.topMessageId === messageId ||
      this.topicNumericId(topic.id) === topicMessageId
    )?.id ?? null;
  }

  private replyToMessageIdForSend(chatId: string, replyToMessageId?: string): string | null {
    if (!replyToMessageId) {
      return null;
    }
    if (!replyToMessageId.startsWith(`${chatId}:`)) {
      return null;
    }
    return this.messageNumericId(replyToMessageId) > 0 ? replyToMessageId : null;
  }

  private replyToMessageIdForMessage(
    chatId: string,
    message: Api.Message,
    topics: TelegramTopic[],
    topicId: string | null
  ): string | null {
    const replyTo = (message as unknown as {
      replyTo?: {
        forumTopic?: boolean;
        replyToMsgId?: number;
        replyToTopId?: number;
      };
    }).replyTo;
    const replyToMsgId = replyTo?.replyToMsgId;
    if (!replyToMsgId) {
      return null;
    }

    const topic = topicId ? topics.find((item) => item.id === topicId) : null;
    const topicMessageIds = topic ? new Set(this.topicMessageIds(topic)) : new Set<number>();
    if (replyTo.forumTopic && topicMessageIds.has(replyToMsgId)) {
      return null;
    }
    if (replyTo.replyToTopId && replyTo.replyToTopId === replyToMsgId) {
      return null;
    }

    return `${chatId}:${replyToMsgId}`;
  }

  private replyQuoteText(message: Api.Message): string | null {
    const quoteText = (message as unknown as { replyTo?: { quoteText?: string } }).replyTo?.quoteText?.trim();
    return quoteText || null;
  }

  private replyPreviewText(message: TelegramMessage | null): string | null {
    if (!message) {
      return null;
    }
    const text = message.text.trim();
    if (text) {
      return text.length > 140 ? `${text.slice(0, 137)}...` : text;
    }
    const attachment = message.attachments?.[0];
    if (attachment) {
      return attachment.type === 'image' ? 'Изображение' : attachment.fileName || 'Файл';
    }
    return null;
  }

  private enrichReplyPreviews(messages: TelegramMessage[], contextMessages: TelegramMessage[]): TelegramMessage[] {
    const messagesById = new Map(contextMessages.map((message) => [message.id, message]));
    return messages.map((message) => {
      if (!message.replyToMessageId) {
        return message;
      }
      const replyMessage = messagesById.get(message.replyToMessageId);
      return {
        ...message,
        replyToSenderName: message.replyToSenderName ?? replyMessage?.senderName ?? null,
        replyToText: message.replyToText ?? this.replyPreviewText(replyMessage ?? null)
      };
    });
  }

  private toTopic(chatId: string, topic: Api.TypeForumTopic): TelegramTopic | null {
    if (topic.className !== 'ForumTopic') {
      return null;
    }

    return {
      id: this.topicSyntheticId(chatId, topic.id),
      chatId,
      title: topic.title,
      topMessageId: String(topic.topMessage || topic.id),
      unreadCount: topic.unreadCount ?? 0,
      lastMessageAt: null
    };
  }

  private async loadForumTopicsForDialog(
    client: TelegramClient,
    chatId: string,
    entity: EntityLike
  ): Promise<TelegramTopic[]> {
    if (!this.entityHasTopics(entity)) {
      return [];
    }

    const response = await client.invoke(new Api.channels.GetForumTopics({
      channel: entity,
      offsetDate: 0,
      offsetId: 0,
      offsetTopic: 0,
      limit: 100
    }));
    return response.topics
      .map((topic) => this.toTopic(chatId, topic))
      .filter((topic): topic is TelegramTopic => Boolean(topic));
  }

  private async findDialog(client: TelegramClient, chatId: string) {
    const dialogs = await client.getDialogs({ limit: 200 });
    return dialogs.find((dialog) => String(dialog.id) === chatId);
  }

  private startRealtimeUpdates(client: TelegramClient): void {
    if (
      this.realtimeClient === client &&
      this.realtimeNewMessageHandler &&
      this.realtimeNewMessageEvent &&
      this.realtimeDeletedMessageHandler &&
      this.realtimeDeletedMessageEvent &&
      this.realtimeRawHandler &&
      this.realtimeRawEvent
    ) {
      return;
    }

    this.stopRealtimeUpdates();
    const realtimeNewMessageEvent = new NewMessage({});
    const realtimeNewMessageHandler = (event: NewMessageEvent) => {
      void this.handleIncomingMessage(client, event).catch((error) => {
        console.warn('Failed to handle Telegram update:', error);
      });
    };
    const realtimeDeletedMessageEvent = new DeletedMessage({});
    const realtimeDeletedMessageHandler = (event: DeletedMessageEvent) => {
      this.handleDeletedMessages(event);
    };
    const realtimeRawEvent = new Raw({
      types: [
        Api.UpdateMessageReactions,
        Api.UpdateReadHistoryInbox,
        Api.UpdateReadHistoryOutbox,
        Api.UpdateReadChannelInbox,
        Api.UpdateReadChannelOutbox,
        Api.UpdateDialogUnreadMark,
        Api.UpdateEditMessage,
        Api.UpdateEditChannelMessage,
        Api.UpdateDialogPinned,
        Api.UpdatePinnedDialogs,
        Api.UpdateDialogFilter,
        Api.UpdateDialogFilterOrder,
        Api.UpdateDialogFilters
      ]
    });
    const realtimeRawHandler = (update: Api.TypeUpdate) => {
      void this.handleMessageReactionsUpdate(update).catch((error) => {
        console.warn('Failed to handle Telegram reaction update:', error);
      });
      this.scheduleBackgroundSync(client);
    };

    client.addEventHandler(realtimeNewMessageHandler, realtimeNewMessageEvent);
    client.addEventHandler(realtimeDeletedMessageHandler, realtimeDeletedMessageEvent);
    client.addEventHandler(realtimeRawHandler, realtimeRawEvent);
    this.realtimeClient = client;
    this.realtimeNewMessageEvent = realtimeNewMessageEvent;
    this.realtimeNewMessageHandler = realtimeNewMessageHandler;
    this.realtimeDeletedMessageEvent = realtimeDeletedMessageEvent;
    this.realtimeDeletedMessageHandler = realtimeDeletedMessageHandler;
    this.realtimeRawEvent = realtimeRawEvent;
    this.realtimeRawHandler = realtimeRawHandler;
    this.startBackgroundSync(client);
  }

  private stopRealtimeUpdates(): void {
    if (this.realtimeClient && this.realtimeNewMessageHandler && this.realtimeNewMessageEvent) {
      this.realtimeClient.removeEventHandler(this.realtimeNewMessageHandler, this.realtimeNewMessageEvent);
    }
    if (this.realtimeClient && this.realtimeDeletedMessageHandler && this.realtimeDeletedMessageEvent) {
      this.realtimeClient.removeEventHandler(this.realtimeDeletedMessageHandler, this.realtimeDeletedMessageEvent);
    }
    if (this.realtimeClient && this.realtimeRawHandler && this.realtimeRawEvent) {
      this.realtimeClient.removeEventHandler(this.realtimeRawHandler, this.realtimeRawEvent);
    }
    this.realtimeClient = null;
    this.realtimeNewMessageEvent = null;
    this.realtimeNewMessageHandler = null;
    this.realtimeDeletedMessageEvent = null;
    this.realtimeDeletedMessageHandler = null;
    this.realtimeRawEvent = null;
    this.realtimeRawHandler = null;
    this.stopBackgroundSync();
  }

  private startBackgroundSync(client: TelegramClient): void {
    if (this.backgroundSyncClient === client && this.backgroundSyncTimer) {
      return;
    }

    this.stopBackgroundSync();
    this.backgroundSyncClient = client;
    this.backgroundSyncTimer = setInterval(() => {
      this.scheduleBackgroundSync(client, 0);
    }, TELEGRAM_BACKGROUND_SYNC_INTERVAL_MS);
    this.scheduleBackgroundSync(client);
  }

  private stopBackgroundSync(): void {
    if (this.backgroundSyncTimer) {
      clearInterval(this.backgroundSyncTimer);
      this.backgroundSyncTimer = null;
    }
    if (this.backgroundSyncTimeout) {
      clearTimeout(this.backgroundSyncTimeout);
      this.backgroundSyncTimeout = null;
    }
    this.backgroundSyncClient = null;
  }

  private scheduleBackgroundSync(
    client: TelegramClient,
    delayMs = TELEGRAM_BACKGROUND_SYNC_DEBOUNCE_MS
  ): void {
    if (this.backgroundSyncClient !== client || !client.connected) {
      return;
    }
    if (this.backgroundSyncTimeout) {
      clearTimeout(this.backgroundSyncTimeout);
    }
    this.backgroundSyncTimeout = setTimeout(() => {
      this.backgroundSyncTimeout = null;
      void this.runBackgroundSync(client).catch((error) => {
        console.warn('Failed to sync Telegram workspace:', error);
      });
    }, delayMs);
  }

  private async runBackgroundSync(client: TelegramClient): Promise<void> {
    if (this.backgroundSyncPromise) {
      return this.backgroundSyncPromise;
    }

    this.backgroundSyncPromise = (async () => {
      if (this.backgroundSyncClient !== client || !client.connected) {
        return;
      }
      const nextState = await this.syncWorkspaceState(client);
      this.events.onStateChanged?.(nextState);
    })().finally(() => {
      this.backgroundSyncPromise = null;
    });

    return this.backgroundSyncPromise;
  }

  private chatIdForMessage(message: Api.Message): string | null {
    return this.entityId((message as unknown as { peerId?: unknown }).peerId);
  }

  private handleDeletedMessages(event: DeletedMessageEvent): void {
    const deletedIds = new Set(event.deletedIds.map((id) => Number(id)).filter((id) => id > 0));
    if (deletedIds.size === 0) {
      return;
    }

    const peerChatId = this.entityId(event.peer);
    const currentMessages = this.store.getState().telegram.messages;
    const removedMessages = currentMessages.filter((message) => {
      if (peerChatId && message.chatId !== peerChatId) {
        return false;
      }
      return deletedIds.has(this.messageNumericId(message.id));
    });
    if (removedMessages.length === 0) {
      return;
    }

    const nextState = this.store.setState((state) => {
      const removedMessageIds = new Set(removedMessages.map((message) => message.id));
      const affectedChatIds = new Set(removedMessages.map((message) => message.chatId));
      const affectedTopicIds = new Set(
        removedMessages
          .map((message) => message.topicId)
          .filter((topicId): topicId is string => Boolean(topicId))
      );

      state.telegram.messages = state.telegram.messages.filter((message) => !removedMessageIds.has(message.id));
      state.telegram.chats = state.telegram.chats.map((chat) =>
        affectedChatIds.has(chat.id)
          ? { ...chat, lastMessageAt: this.lastMessageAt(state.telegram.messages, chat.id) }
          : chat
      );
      state.telegram.topics = state.telegram.topics.map((topic) =>
        affectedTopicIds.has(topic.id)
          ? { ...topic, lastMessageAt: this.lastTopicMessageAt(state.telegram.messages, topic.id) }
          : topic
      );
    });

    this.events.onStateChanged?.(nextState);
  }

  private async handleMessageReactionsUpdate(update: Api.TypeUpdate): Promise<void> {
    if (!(update instanceof Api.UpdateMessageReactions)) {
      return;
    }

    const chatId = this.entityId(update.peer);
    if (!chatId || !update.msgId) {
      return;
    }

    const messageId = `${chatId}:${update.msgId}`;
    if (!this.store.getState().telegram.messages.some((message) => message.id === messageId)) {
      return;
    }

    let reactions = this.reactionsForMessage(update);
    const client = this.realtimeClient ?? this.telegramClient;
    if (client && reactions.length > 0) {
      const dialog = await this.findDialog(client, chatId).catch(() => null);
      if (dialog?.entity) {
        const usersByReaction = new Map<string, string[]>();
        for (const reaction of reactions) {
          const names = await this.reactionUsersForEmoticon(client, dialog.entity, update.msgId, reaction.emoticon);
          if (names.length > 0) {
            usersByReaction.set(reaction.emoticon, names);
          }
        }
        reactions = this.reactionsForMessage(update, usersByReaction);
      }
    }
    const nextState = this.store.setState((state) => {
      state.telegram.messages = state.telegram.messages.map((message) => {
        if (message.id !== messageId) {
          return message;
        }
        return {
          ...message,
          reactions,
          updatedAt: now()
        };
      });
    });

    this.events.onStateChanged?.(nextState);
  }

  private async chatFromLiveMessage(
    client: TelegramClient,
    chatId: string,
    avatarCache: Map<string, string | null>
  ): Promise<TelegramChat | null> {
    const existingChat = this.store.getState().telegram.chats.find((chat) => chat.id === chatId);
    if (existingChat) {
      return existingChat;
    }

    const dialog = await this.findDialog(client, chatId);
    if (!dialog?.entity) {
      return null;
    }

    return {
      id: chatId,
      title: dialog.title || chatId,
      type: this.entityType(dialog.entity),
      avatar: await this.avatarForEntity(client, dialog.entity, chatId, avatarCache),
      hasTopics: this.entityHasTopics(dialog.entity),
      selected: false,
      notificationsEnabled: true,
      lastSyncedAt: null,
      lastMessageAt: null,
      unreadCount: 0
    };
  }

  private async handleIncomingMessage(client: TelegramClient, event: NewMessageEvent): Promise<void> {
    const incomingMessage = event.message;
    const text = incomingMessage.message?.trim();
    if (!incomingMessage.id || (!text && !this.messageHasAttachment(incomingMessage))) {
      return;
    }
    const outgoing = Boolean(incomingMessage.out);

    const chatId = this.chatIdForMessage(incomingMessage);
    if (!chatId) {
      return;
    }

    const currentState = this.store.getState();
    const messageId = `${chatId}:${incomingMessage.id}`;
    if (currentState.telegram.messages.some((message) => message.id === messageId)) {
      return;
    }

    const avatarCache = new Map<string, string | null>();
    const chat = await this.chatFromLiveMessage(client, chatId, avatarCache);
    if (!chat) {
      return;
    }
    const topicId = this.topicIdForMessage(chatId, incomingMessage, currentState.telegram.topics);

    const message = await this.toMessage(
      client,
      chatId,
      ((incomingMessage as unknown as { peerId?: EntityLike }).peerId ?? chatId) as EntityLike,
      incomingMessage,
      now(),
      currentState.telegram.messages,
      avatarCache,
      currentState.telegram.topics,
      topicId ?? undefined
    );
    if (!message) {
      return;
    }

    let nextChat: TelegramChat = chat;
    const nextState = this.store.setState((state) => {
      state.telegram.messages = this.mergeMessages(state.telegram.messages, [message]);
      const existingChat = state.telegram.chats.find((item) => item.id === chatId);
      nextChat = {
        ...(existingChat ?? chat),
        avatar: existingChat?.avatar ?? chat.avatar,
        lastSyncedAt: now(),
        lastMessageAt: message.sentAt,
        unreadCount: outgoing
          ? existingChat?.unreadCount ?? chat.unreadCount ?? 0
          : (existingChat?.unreadCount ?? chat.unreadCount ?? 0) + 1
      };

      if (existingChat) {
        state.telegram.chats = state.telegram.chats.map((item) => (item.id === chatId ? nextChat : item));
      } else {
        state.telegram.chats = [nextChat, ...state.telegram.chats];
      }
      if (message.topicId) {
        const existingTopic = state.telegram.topics.find((topic) => topic.id === message.topicId);
        if (existingTopic) {
          state.telegram.topics = state.telegram.topics.map((topic) =>
            topic.id === message.topicId
              ? {
                  ...topic,
                  lastMessageAt: message.sentAt,
                  unreadCount: outgoing ? topic.unreadCount ?? 0 : (topic.unreadCount ?? 0) + 1
                }
              : topic
          );
        }
      }
      state.telegram.status = 'connected';
      state.telegram.error = null;
    });

    this.events.onStateChanged?.(nextState);
    this.scheduleBackgroundSync(client);
    if (!outgoing && nextChat.selected && nextChat.notificationsEnabled !== false) {
      this.events.onNewMessage?.({ state: nextState, chat: nextChat, message });
    }
  }

  private attachmentMimeType(message: Api.Message): string | null {
    const media = (message as unknown as {
      media?: {
        className?: string;
        document?: { mimeType?: string };
        webPage?: { document?: { mimeType?: string } };
        webpage?: { document?: { mimeType?: string } };
      };
    }).media;
    const mimeType =
      message.file?.mimeType?.toLowerCase() ??
      message.document?.mimeType?.toLowerCase() ??
      media?.document?.mimeType?.toLowerCase() ??
      media?.webPage?.document?.mimeType?.toLowerCase() ??
      media?.webpage?.document?.mimeType?.toLowerCase() ??
      '';
    if (mimeType.startsWith('image/')) {
      return mimeType;
    }

    if (mimeType) {
      return mimeType;
    }
    if (message.file || message.document || media?.className === 'MessageMediaDocument') {
      return this.normalizeMimeType('', message.file?.name ?? '');
    }
    if (message.photo || media?.className === 'MessageMediaPhoto') {
      return 'image/jpeg';
    }
    return null;
  }

  private messageHasAttachment(message: Api.Message): boolean {
    return Boolean(this.attachmentMimeType(message));
  }

  private messageFileName(message: Api.Message, mimeType = this.attachmentMimeType(message) ?? 'application/octet-stream'): string {
    const fileName = message.file?.name;
    return this.safeFileName(fileName && fileName.trim() ? fileName : this.defaultFileName(mimeType));
  }

  private messageFileSize(message: Api.Message): number | null {
    const rawSize = message.file?.size;
    if (typeof rawSize === 'number') {
      return rawSize;
    }
    if (rawSize && typeof (rawSize as { toString?: unknown }).toString === 'function') {
      const size = Number(rawSize.toString());
      return Number.isFinite(size) ? size : null;
    }
    return null;
  }

  private async attachmentsForMessage(
    client: TelegramClient,
    messageId: string,
    message: Api.Message
  ): Promise<TelegramMessageAttachment[]> {
    const [metadata] = this.attachmentMetadataForMessage(messageId, message);
    if (!metadata) {
      return [];
    }

    const { mimeType, fileName, type: attachmentType, size: fileSize } = metadata;
    const supportsInlinePreview =
      attachmentType === 'image' || attachmentType === 'sticker' || mimeType.startsWith('video/');
    const maxPreviewBytes = attachmentType === 'sticker' ? MAX_STICKER_PREVIEW_BYTES : MAX_IMAGE_PREVIEW_BYTES;

    if (
      !supportsInlinePreview ||
      (fileSize !== null && fileSize > maxPreviewBytes)
    ) {
      return [metadata];
    }

    let dataUrl: string | null = null;
    let resolvedMimeType = mimeType;
    let resolvedFileName = fileName;
    let resolvedAttachmentType: TelegramMessageAttachment['type'] = attachmentType;
    try {
      const media = await withTimeout(
        client.downloadMedia(message, {}),
        30000,
        'Telegram download attachment preview'
      );
      if (Buffer.isBuffer(media) && media.byteLength > 0) {
        resolvedMimeType = this.sniffMimeType(media) ?? mimeType;
        if (resolvedMimeType !== mimeType && /^image\.(jpe?g|png|webp|gif)$/i.test(resolvedFileName)) {
          resolvedFileName = this.defaultFileName(resolvedMimeType);
        }
        resolvedAttachmentType = this.attachmentTypeForMimeType(resolvedMimeType, resolvedFileName);
        const resolvedMaxPreviewBytes =
          resolvedAttachmentType === 'sticker' ? MAX_STICKER_PREVIEW_BYTES : MAX_IMAGE_PREVIEW_BYTES;
        if (
          (resolvedAttachmentType === 'image' || resolvedAttachmentType === 'sticker') &&
          media.byteLength <= resolvedMaxPreviewBytes
        ) {
          dataUrl = `data:${resolvedMimeType};base64,${media.toString('base64')}`;
        }
        if (
          resolvedAttachmentType === 'file' &&
          resolvedMimeType.startsWith('video/') &&
          media.byteLength <= MAX_IMAGE_PREVIEW_BYTES
        ) {
          dataUrl = `data:${resolvedMimeType};base64,${media.toString('base64')}`;
        }
      }
    } catch (error) {
      console.warn('Failed to download Telegram attachment preview:', error);
    }

    return [{
      id: `${messageId}:attachment`,
      type: resolvedAttachmentType,
      fileName: resolvedFileName,
      mimeType: resolvedMimeType,
      size: fileSize,
      dataUrl
    }];
  }

  private attachmentMetadataForMessage(
    messageId: string,
    message: Api.Message
  ): TelegramMessageAttachment[] {
    const mimeType = this.attachmentMimeType(message);
    if (!mimeType) {
      return [];
    }

    const fileSize = this.messageFileSize(message);
    const fileName = this.messageFileName(message, mimeType);
    const attachmentType = this.attachmentTypeForMimeType(mimeType, fileName);
    return [{
      id: `${messageId}:attachment`,
      type: attachmentType,
      fileName,
      mimeType,
      size: fileSize,
      dataUrl: null
    }];
  }

  private async toMessage(
    client: TelegramClient,
    chatId: string,
    entity: EntityLike,
    message: Api.Message,
    loadedAt: string,
    existingMessages: TelegramMessage[],
    avatarCache: Map<string, string | null>,
    topics: TelegramTopic[],
    forcedTopicId?: string,
    options: { downloadAttachmentPreview?: boolean } = {}
  ): Promise<TelegramMessage | null> {
    if (!message.id) {
      return null;
    }
    const id = `${chatId}:${message.id}`;
    const text = message.message?.trim() ?? '';
    const existingMessage = existingMessages.find((existing) => existing.id === id);
    const existingAttachments = existingMessage?.attachments ?? [];
    const attachmentsNeedPreview = existingAttachments.some((attachment) =>
      (
        attachment.type === 'image' ||
        attachment.type === 'sticker' ||
        attachment.mimeType.toLowerCase().startsWith('video/')
      ) && !attachment.dataUrl
    );
    const attachments = existingAttachments.length > 0 && !attachmentsNeedPreview
      ? existingAttachments
      : options.downloadAttachmentPreview === false
        ? this.attachmentMetadataForMessage(id, message)
        : await this.attachmentsForMessage(client, id, message);
    if (!text && attachments.length === 0) {
      return null;
    }
    const sender = message.out
      ? { senderId: null, sender: undefined as EntityLike | undefined }
      : await this.resolveMessageSender(client, message);
    const senderName = message.out ? 'Вы' : this.senderName(message, sender.sender);
    const topicId = this.topicIdForMessage(chatId, message, topics, forcedTopicId);
    const replyToMessageId = this.replyToMessageIdForMessage(chatId, message, topics, topicId);
    const replyMessage = replyToMessageId
      ? existingMessages.find((existing) => existing.id === replyToMessageId) ?? null
      : null;
    const usersByReaction = await this.reactionUsersForMessage(client, entity, message);

    return this.mergeMessageStatus(existingMessages, {
      id,
      chatId,
      topicId,
      replyToMessageId,
      replyToSenderName: replyMessage?.senderName ?? null,
      replyToText: this.replyPreviewText(replyMessage) ?? this.replyQuoteText(message),
      senderId: sender.senderId,
      senderName,
      senderAvatar: message.out
        ? null
        : await this.avatarForEntity(client, sender.sender, sender.senderId, avatarCache),
      sentAt: new Date(Number(message.date) * 1000).toISOString(),
      text,
      attachments,
      reactions: this.reactionsForMessage(message, usersByReaction),
      status: 'new',
      createdAt: loadedAt,
      updatedAt: loadedAt
    });
  }

  private async loadMessagesForChat(
    client: TelegramClient,
    chatId: string,
    existingState: AppState['telegram'],
    offsetId = 0,
    topicId?: string
  ): Promise<TelegramMessage[]> {
    const dialog = await this.findDialog(client, chatId);
    if (!dialog?.entity) {
      throw new Error('Telegram-чат не найден.');
    }
    const topic = this.topicForRequest(existingState.topics, chatId, topicId);
    return this.loadMessagesForDialog(client, chatId, dialog.entity, existingState, offsetId, topic);
  }

  private async loadMessagesForDialog(
    client: TelegramClient,
    chatId: string,
    entity: EntityLike,
    existingState: AppState['telegram'],
    offsetId = 0,
    topic?: TelegramTopic | null
  ): Promise<TelegramMessage[]> {
    const loadedAt = now();
    const { messages: chatMessages, forceTopicId } = await this.loadRawMessagesForDialog(client, entity, offsetId, topic);
    const avatarCache = new Map<string, string | null>();
    const messages = await Promise.all(
      chatMessages.map((message) =>
        this.toMessage(
          client,
          chatId,
          entity,
          message,
          loadedAt,
          existingState.messages,
          avatarCache,
          existingState.topics,
          forceTopicId
        )
      )
    );
    const validMessages = messages
      .filter((message): message is TelegramMessage => Boolean(message))
      .filter((message) => !topic || message.topicId === topic.id);
    return this.enrichReplyPreviews(validMessages, [...existingState.messages, ...validMessages]);
  }

  private async loadDialogTopMessage(
    client: TelegramClient,
    chatId: string,
    entity: EntityLike,
    message: Api.Message | undefined,
    existingState: AppState['telegram'],
    topics: TelegramTopic[],
    avatarCache: Map<string, string | null>,
    loadedAt: string
  ): Promise<TelegramMessage | null> {
    if (!message?.id || (!message.message?.trim() && !this.messageHasAttachment(message))) {
      return null;
    }

    return this.toMessage(
      client,
      chatId,
      entity,
      message,
      loadedAt,
      existingState.messages,
      avatarCache,
      topics,
      undefined,
      { downloadAttachmentPreview: false }
    );
  }

  private async loadRawMessagesForDialog(
    client: TelegramClient,
    entity: EntityLike,
    offsetId: number,
    topic?: TelegramTopic | null
  ): Promise<{ messages: Api.Message[]; forceTopicId?: string }> {
    if (!topic) {
      return { messages: await client.getMessages(entity, { limit: 50, offsetId }) };
    }

    for (const replyTo of this.topicMessageIds(topic)) {
      try {
        return {
          messages: await client.getMessages(entity, { limit: 50, offsetId, replyTo }),
          forceTopicId: topic.id
        };
      } catch (error) {
        if (!this.isTopicIdInvalid(error)) {
          throw error;
        }
      }
    }

    return { messages: await client.getMessages(entity, { limit: 120, offsetId }) };
  }

  private isTopicIdInvalid(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const errorMessage = (error as { errorMessage?: unknown } | null)?.errorMessage;
    return message.includes('TOPIC_ID_INVALID') || errorMessage === 'TOPIC_ID_INVALID';
  }

  private messageNumericId(messageId: string): number {
    return Number(messageId.split(':').at(-1) ?? 0);
  }

  private chatIdFromMessageId(messageId: string): string {
    return messageId.split(':').slice(0, -1).join(':');
  }

  private async loadWorkspace(
    client: TelegramClient,
    existingState: AppState['telegram']
  ): Promise<Pick<
    AppState['telegram'],
    'folders' | 'chats' | 'topics' | 'messages' | 'selectedFolderId'
  >> {
    const loadedAt = now();
    const dialogs = await client.getDialogs({ limit: TELEGRAM_DIALOG_SYNC_LIMIT });
    const dialogsByChatId = new Map(dialogs.map((dialog) => [String(dialog.id), dialog]));
    const existingChatsById = new Map(existingState.chats.map((chat) => [chat.id, chat]));
    const avatarCache = new Map<string, string | null>();
    const loadedChats: TelegramChat[] = await Promise.all(dialogs.map(async (dialog) => {
      const id = String(dialog.id);
      const previous = existingChatsById.get(id);
      const unreadCount = Number.isFinite(dialog.unreadCount) ? dialog.unreadCount : previous?.unreadCount ?? 0;
      const dialogLastMessageAt = dialog.message?.date
        ? new Date(Number(dialog.message.date) * 1000).toISOString()
        : previous?.lastMessageAt ?? null;
      return {
        id,
        title: dialog.title || id,
        type: this.entityType(dialog.entity),
        avatar: await this.avatarForEntity(client, dialog.entity, id, avatarCache) ?? previous?.avatar ?? null,
        hasTopics: this.entityHasTopics(dialog.entity),
        selected: previous?.selected ?? false,
        notificationsEnabled: previous?.notificationsEnabled ?? true,
        lastSyncedAt: previous?.lastSyncedAt ?? null,
        lastMessageAt: dialogLastMessageAt,
        unreadCount
      };
    }));
    const loadedChatIds = new Set(loadedChats.map((chat) => chat.id));
    const preservedSelectedChats = existingState.chats.filter((chat) => chat.selected && !loadedChatIds.has(chat.id));
    const chats = [...loadedChats, ...preservedSelectedChats];

    const loadedTopics: TelegramTopic[] = [];
    for (const chat of loadedChats.filter((chat) => chat.hasTopics)) {
      const dialog = dialogs.find((item) => String(item.id) === chat.id);
      if (!dialog?.entity) {
        continue;
      }
      try {
        loadedTopics.push(...await this.loadForumTopicsForDialog(client, chat.id, dialog.entity));
      } catch (error) {
        console.warn('Failed to load Telegram topics:', error);
        loadedTopics.push(...existingState.topics.filter((topic) => topic.chatId === chat.id));
      }
    }
    const topicChatIdsWithTopics = new Set(loadedChats.filter((chat) => chat.hasTopics).map((chat) => chat.id));
    const topics = [
      ...loadedTopics,
      ...existingState.topics.filter((topic) => !topicChatIdsWithTopics.has(topic.chatId))
    ];

    let folders: TelegramFolder[] = [];
    try {
      const filters = await client.invoke(new Api.messages.GetDialogFilters());
      folders = this.extractFilters(filters)
        .map((folder) => {
          return {
            id: String(folder.id),
            title: this.textValue(folder.title) || `Folder ${folder.id}`,
            chatIds: this.chatIdsForFilter(folder, chats)
          };
        })
        .filter((folder) => folder.title && folder.chatIds.length > 0);
    } catch (error) {
      console.warn('Failed to load Telegram folders:', error);
      folders = [];
    }

    const selectedChats = chats.filter((chat) => chat.selected);
    const fullMessageChatIds = new Set<string>();
    for (const chat of selectedChats.filter((chat) => (chat.unreadCount ?? 0) > 0)) {
      fullMessageChatIds.add(chat.id);
    }
    for (const chat of selectedChats.slice(0, TELEGRAM_RECENT_MESSAGE_SYNC_CHAT_LIMIT)) {
      fullMessageChatIds.add(chat.id);
    }
    let mergedMessages = existingState.messages;

    for (const chat of selectedChats) {
      const dialog = dialogsByChatId.get(chat.id);
      if (!dialog?.entity) {
        continue;
      }

      if (!fullMessageChatIds.has(chat.id)) {
        const topMessage = await this.loadDialogTopMessage(
          client,
          chat.id,
          dialog.entity,
          dialog.message,
          { ...existingState, topics },
          topics,
          avatarCache,
          loadedAt
        );
        if (topMessage) {
          mergedMessages = this.mergeLoadedMessages(mergedMessages, [topMessage], { chatId: chat.id });
        }
        continue;
      }

      const loadedMessages = await this.loadMessagesForDialog(
        client,
        chat.id,
        dialog.entity,
        { ...existingState, messages: mergedMessages, topics }
      );
      mergedMessages = this.mergeLoadedMessages(mergedMessages, loadedMessages, { chatId: chat.id });
    }

    for (const chat of selectedChats) {
      if (this.lastMessageAt(mergedMessages, chat.id)) {
        continue;
      }
      const dialog = dialogsByChatId.get(chat.id);
      if (!dialog?.entity) {
        continue;
      }
      const topMessage = await this.loadDialogTopMessage(
        client,
        chat.id,
        dialog.entity,
        dialog.message,
        { ...existingState, topics },
        topics,
        avatarCache,
        loadedAt
      );
      if (topMessage) {
        mergedMessages = this.mergeLoadedMessages(mergedMessages, [topMessage], { chatId: chat.id });
      }
    }

    const cachedLastMessageAtByChat = this.lastMessageAtByChat(mergedMessages);
    const chatLastMessageAt = new Map<string, string | null>();
    for (const chat of chats) {
      const cachedLastMessageAt = cachedLastMessageAtByChat.get(chat.id);
      if (cachedLastMessageAt) {
        chatLastMessageAt.set(chat.id, cachedLastMessageAt);
        continue;
      }
      const dialog = dialogsByChatId.get(chat.id);
      chatLastMessageAt.set(
        chat.id,
        dialog?.message?.date
          ? new Date(Number(dialog.message.date) * 1000).toISOString()
          : chat.lastMessageAt
      );
    }

    const cachedLastMessageAtByTopic = this.lastMessageAtByTopic(mergedMessages);
    const topicLastMessageAt = new Map<string, string | null>();
    for (const topic of topics) {
      topicLastMessageAt.set(topic.id, cachedLastMessageAtByTopic.get(topic.id) ?? null);
    }

    for (const topic of topics) {
      if (topicLastMessageAt.get(topic.id)) {
        continue;
      }
      const dialog = dialogsByChatId.get(topic.chatId);
      const topMessage = dialog?.message;
      if (!topMessage) {
        continue;
      }
      const topicId = this.topicIdForMessage(topic.chatId, topMessage, topics);
      if (topicId === topic.id && topMessage.date) {
        topicLastMessageAt.set(topic.id, new Date(Number(topMessage.date) * 1000).toISOString());
      }
    }

    return {
      folders,
      chats: chats.map((chat) => ({
        ...chat,
        lastSyncedAt: loadedAt,
        lastMessageAt: chatLastMessageAt.get(chat.id) ?? null,
        unreadCount: chat.unreadCount ?? 0
      })),
      topics: topics.map((topic) => ({
        ...topic,
        lastMessageAt: topicLastMessageAt.get(topic.id) ?? null
      })),
      messages: mergedMessages,
      selectedFolderId: existingState.selectedFolderId
    };
  }

}
