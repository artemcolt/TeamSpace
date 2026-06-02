import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { defaultState, redmineDefaultUrl } from '../domain/appState';
import type { AppState, CachedTelegramAvatar, RedmineIssueSummary, SecretFile } from '../domain/types';
import { LocalRedmineDatabase } from './localRedmineDatabase';
import { LocalTelegramDatabase } from './localTelegramDatabase';

type StateChangeListener = (state: AppState) => void;

function hasTelegramEnvCredentials(): boolean {
  const apiId = Number(process.env.TELEGRAM_API_ID?.trim());
  const apiHash = process.env.TELEGRAM_API_HASH?.trim();
  return Number.isInteger(apiId) && apiId > 0 && Boolean(apiHash);
}

export class LocalStore {
  private statePath = '';
  private secretsPath = '';
  private telegramDb = new LocalTelegramDatabase();
  private redmineDb = new LocalRedmineDatabase();
  private state: AppState = defaultState();
  private readonly stateChangeListeners = new Set<StateChangeListener>();

  async initialize(): Promise<void> {
    const dataDir = app.getPath('userData');
    fs.mkdirSync(dataDir, { recursive: true });
    this.statePath = path.join(dataDir, 'state.json');
    this.secretsPath = path.join(dataDir, 'secrets.json');
    this.state = this.readState();
    await this.telegramDb.initialize(dataDir);
    await this.redmineDb.initialize(dataDir);
    if (
      this.state.telegram.chats.length > 0 ||
      this.state.telegram.topics.length > 0 ||
      this.state.telegram.messages.length > 0
    ) {
      this.telegramDb.save(this.state.telegram);
    }
    const telegramCache = this.telegramDb.load();
    this.state.telegram.chats = telegramCache.chats;
    this.state.telegram.topics = telegramCache.topics;
    this.state.telegram.messages = telegramCache.messages;
    this.state.redmine.hasApiKey = Boolean(this.getSecret('redmineApiKey'));
    this.state.telegram.hasApiCredentials = hasTelegramEnvCredentials() || Boolean(this.getSecret('telegramApiCredentials'));
    this.state.gitlab.hasToken = Boolean(this.getSecret('gitlabToken'));
    const hasTelegramSession = Boolean(this.getSecret('telegramSession'));
    let stateNeedsWrite = false;
    if (this.state.redmine.status === 'connected' && !this.state.redmine.hasApiKey) {
      this.state.redmine.status = 'error';
      this.state.redmine.error = 'Redmine API key не сохранен. Откройте настройки Redmine и сохраните ключ заново.';
      stateNeedsWrite = true;
    }
    if (this.state.telegram.status === 'connected' && !this.state.telegram.hasApiCredentials) {
      this.state.telegram.status = 'error';
      this.state.telegram.error = 'Telegram api_id/api_hash не настроены. Заполните TELEGRAM_API_ID и TELEGRAM_API_HASH в .env.';
      stateNeedsWrite = true;
    }
    if (this.state.gitlab.status === 'connected' && !this.state.gitlab.hasToken) {
      this.state.gitlab.status = 'error';
      this.state.gitlab.error = 'GitLab token не сохранен. Откройте настройки GitLab и сохраните token заново.';
      stateNeedsWrite = true;
    }
    if (this.state.telegram.status === 'connected' && this.state.telegram.hasApiCredentials && !hasTelegramSession) {
      this.state.telegram.status = 'disconnected';
      this.state.telegram.error = null;
      stateNeedsWrite = true;
    }
    if (stateNeedsWrite) {
      this.writeState();
    }
  }

  getState(): AppState {
    return structuredClone(this.state);
  }

  onStateChanged(listener: StateChangeListener): () => void {
    this.stateChangeListeners.add(listener);
    return () => {
      this.stateChangeListeners.delete(listener);
    };
  }

  setState(updater: (state: AppState) => void): AppState {
    const previousTelegramChats = this.state.telegram.chats;
    const previousTelegramTopics = this.state.telegram.topics;
    const previousTelegramMessages = this.state.telegram.messages;
    updater(this.state);
    this.writeState();
    if (
      previousTelegramChats !== this.state.telegram.chats ||
      previousTelegramTopics !== this.state.telegram.topics ||
      previousTelegramMessages !== this.state.telegram.messages
    ) {
      this.telegramDb.save(this.state.telegram);
    }
    const nextState = this.getState();
    this.notifyStateChanged(nextState);
    return nextState;
  }

  flush(): void {
    this.writeState();
    this.telegramDb.flush();
    this.redmineDb.flush();
  }

  getTelegramAvatar(key: string): CachedTelegramAvatar | null {
    return this.telegramDb.getAvatar(key);
  }

  saveTelegramAvatar(key: string, dataUrl: string | null): void {
    this.telegramDb.saveAvatar(key, dataUrl);
  }

  loadCachedRedmineIssues(payload: { projectId: string; sprintId: string; assigneeId?: string }): {
    issues: RedmineIssueSummary[];
    syncedAt: string | null;
  } {
    return this.redmineDb.loadIssues(payload);
  }

  saveRedmineIssues(payload: {
    projectId: string;
    sprintId: string;
    assigneeId?: string;
    issues: RedmineIssueSummary[];
    syncedAt?: string;
  }): string {
    return this.redmineDb.saveIssues(payload);
  }

  updateCachedRedmineIssueStatus(payload: {
    projectId: string;
    sprintId: string;
    assigneeId?: string;
    issueId: string;
    statusId: string;
    status: string;
  }): RedmineIssueSummary | null {
    return this.redmineDb.updateIssueStatus(payload);
  }

  updateCachedRedmineIssueAssignee(payload: {
    projectId: string;
    sprintId: string;
    assigneeId?: string;
    issueId: string;
    assignee: string;
  }): RedmineIssueSummary | null {
    return this.redmineDb.updateIssueAssignee(payload);
  }

  deleteCachedRedmineIssue(payload: {
    projectId: string;
    sprintId: string;
    assigneeId?: string;
    issueId: string;
  }): RedmineIssueSummary | null {
    return this.redmineDb.deleteIssue(payload);
  }

  moveCachedRedmineIssue(payload: {
    projectId: string;
    previousSprintId: string;
    sprintId: string;
    assigneeId?: string;
    issue: RedmineIssueSummary;
  }): void {
    const previousCache = this.redmineDb.loadIssues({
      projectId: payload.projectId,
      sprintId: payload.previousSprintId,
      assigneeId: payload.assigneeId
    });
    const nextCache = this.redmineDb.loadIssues({
      projectId: payload.projectId,
      sprintId: payload.sprintId,
      assigneeId: payload.assigneeId
    });

    this.redmineDb.saveIssues({
      projectId: payload.projectId,
      sprintId: payload.previousSprintId,
      assigneeId: payload.assigneeId,
      issues: previousCache.issues.filter((issue) => issue.id !== payload.issue.id),
      syncedAt: previousCache.syncedAt ?? undefined
    });
    this.redmineDb.saveIssues({
      projectId: payload.projectId,
      sprintId: payload.sprintId,
      assigneeId: payload.assigneeId,
      issues: [payload.issue, ...nextCache.issues.filter((issue) => issue.id !== payload.issue.id)],
      syncedAt: nextCache.syncedAt ?? previousCache.syncedAt ?? undefined
    });
  }

  setSecret(key: keyof SecretFile, value: string): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Системное защищенное хранилище недоступно. Секрет не сохранен.');
    }

    const secrets = this.readSecrets();
    const encrypted = safeStorage.encryptString(value).toString('base64');
    secrets[key] = encrypted;
    this.writeSecrets(secrets);
    if (key === 'redmineApiKey') {
      this.state.redmine.hasApiKey = true;
      this.writeState();
    }
    if (key === 'telegramApiCredentials') {
      this.state.telegram.hasApiCredentials = true;
      this.writeState();
    }
    if (key === 'gitlabToken') {
      this.state.gitlab.hasToken = true;
      this.writeState();
    }
  }

  getSecret(key: keyof SecretFile): string | null {
    const encrypted = this.readSecrets()[key];
    if (!encrypted) {
      return null;
    }

    try {
      const buffer = Buffer.from(encrypted, 'base64');
      if (!safeStorage.isEncryptionAvailable()) {
        return null;
      }
      return safeStorage.decryptString(buffer);
    } catch {
      return null;
    }
  }

  deleteSecret(key: keyof SecretFile): void {
    const secrets = this.readSecrets();
    delete secrets[key];
    this.writeSecrets(secrets);
    if (key === 'redmineApiKey') {
      this.state.redmine.hasApiKey = false;
      this.writeState();
    }
    if (key === 'telegramApiCredentials') {
      this.state.telegram.hasApiCredentials = false;
      this.writeState();
    }
    if (key === 'gitlabToken') {
      this.state.gitlab.hasToken = false;
      this.writeState();
    }
  }

  deleteAll(): AppState {
    this.state = defaultState();
    this.writeState();
    this.writeSecrets({});
    this.telegramDb.clear();
    this.redmineDb.clear();
    const nextState = this.getState();
    this.notifyStateChanged(nextState);
    return nextState;
  }

  private notifyStateChanged(state: AppState): void {
    for (const listener of this.stateChangeListeners) {
      listener(state);
    }
  }

  private readState(): AppState {
    if (!fs.existsSync(this.statePath)) {
      return defaultState();
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as Partial<AppState> & {
        drafts?: unknown;
        metrics?: Partial<AppState['metrics']> & { savedDrafts?: unknown };
      };
      const { drafts: _legacyDrafts, metrics: parsedMetrics, ...parsedState } = parsed;
      const { savedDrafts: _legacySavedDrafts, ...compatibleMetrics } = parsedMetrics ?? {};
      const metrics = {
        ...defaultState().metrics,
        ...compatibleMetrics
      };

      return {
        ...defaultState(),
        ...parsedState,
        workspace: { ...defaultState().workspace, ...parsedState.workspace },
        telegram: {
          ...defaultState().telegram,
          ...parsedState.telegram,
          chats: (parsedState.telegram?.chats ?? []).map((chat) => ({
            ...chat,
            avatar: chat.avatar ?? null,
            hasTopics: chat.hasTopics ?? false,
            notificationsEnabled: chat.notificationsEnabled ?? true
          })),
          topics: parsedState.telegram?.topics ?? [],
          messages: (parsedState.telegram?.messages ?? []).map((message) => {
            const legacyStatus = message.status as string | undefined;
            return {
              ...message,
              topicId: message.topicId ?? null,
              replyToMessageId: message.replyToMessageId ?? null,
              replyToSenderName: message.replyToSenderName ?? null,
              replyToText: message.replyToText ?? null,
              senderId: message.senderId ?? null,
              senderAvatar: message.senderAvatar ?? null,
              attachments: message.attachments ?? [],
              reactions: message.reactions ?? [],
              status: legacyStatus === 'drafted' ? 'new' : message.status
            };
          })
        },
        redmine: { ...defaultState().redmine, ...parsedState.redmine },
        gitlab: { ...defaultState().gitlab, ...parsedState.gitlab },
        metrics
      };
    } catch {
      return defaultState();
    }
  }

  private writeState(): void {
    const stateForDisk: AppState = {
      ...this.state,
      telegram: {
        ...this.state.telegram,
        chats: [],
        topics: [],
        messages: []
      }
    };
    fs.writeFileSync(this.statePath, JSON.stringify(stateForDisk, null, 2));
  }

  private readSecrets(): SecretFile {
    if (!fs.existsSync(this.secretsPath)) {
      return {};
    }

    try {
      return JSON.parse(fs.readFileSync(this.secretsPath, 'utf8')) as SecretFile;
    } catch {
      return {};
    }
  }

  private writeSecrets(secrets: SecretFile): void {
    fs.writeFileSync(this.secretsPath, JSON.stringify(secrets, null, 2));
  }
}

export const store = new LocalStore();
