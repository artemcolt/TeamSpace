import type { AppState, RedmineOption } from './types';

export const redmineDefaultUrl = 'https://redmine.example.com/';
export const gitlabDefaultUrl = 'https://gitlab.example.com/';
export const telegramDefaultProxyUrl = '';

export const now = () => new Date().toISOString();

export const createId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export function maskPhone(phone: string): string {
  const normalized = phone.trim();
  if (normalized.length < 6) {
    return normalized;
  }
  return `${normalized.slice(0, 3)}***${normalized.slice(-2)}`;
}

export function telegramUnreadNotificationCount(telegram: AppState['telegram']): number {
  return telegram.chats
    .filter((chat) => chat.selected && chat.notificationsEnabled !== false)
    .reduce((total, chat) => {
      const unreadCount = Number.isFinite(chat.unreadCount) ? chat.unreadCount : 0;
      return total + Math.max(0, unreadCount);
    }, 0);
}

export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim() || redmineDefaultUrl;
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

export function normalizeGitLabBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim() || gitlabDefaultUrl;
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

export function defaultState(): AppState {
  return {
    workspace: {
      redmineBaseUrl: redmineDefaultUrl,
      defaultProjectId: '',
      defaultTrackerId: '',
      defaultPriorityId: '',
      defaultSprintId: '',
      defaultAssigneeId: '',
      aiMode: 'off'
    },
    telegram: {
      status: 'disconnected',
      phoneMasked: null,
      hasApiCredentials: false,
      codeRequested: false,
      codeDelivery: null,
      selectedFolderId: null,
      folders: [],
      chats: [],
      topics: [],
      messages: [],
      error: null
    },
    redmine: {
      status: 'disconnected',
      baseUrl: redmineDefaultUrl,
      hasApiKey: false,
      projects: [],
      trackers: [],
      priorities: [],
      statuses: [],
      sprints: [],
      users: [],
      error: null
    },
    gitlab: {
      status: 'disconnected',
      baseUrl: gitlabDefaultUrl,
      hasToken: false,
      projects: [],
      selectedProjectIds: [],
      error: null
    },
    metrics: {
      createdIssues: 0,
      ignoredMessages: 0
    }
  };
}

export function freshestSprintId(sprints: RedmineOption[]): string {
  return sprints[0]?.id ?? '';
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label}: timeout after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}
