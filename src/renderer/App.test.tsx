import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { katyaAccessGroupStorageKey } from './domain/constants';

const baseState: AppState = {
  workspace: {
    redmineBaseUrl: 'https://redmine.example.com/',
    defaultProjectId: '1',
    defaultTrackerId: '2',
    defaultPriorityId: '3',
    defaultSprintId: '4',
    defaultAssigneeId: '7',
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
    status: 'connected',
    baseUrl: 'https://redmine.example.com/',
    hasApiKey: true,
    projects: [
      { id: '1', name: 'Team Space' },
      { id: '5', name: 'Mobile Team' }
    ],
    trackers: [{ id: '2', name: 'Task' }],
    priorities: [{ id: '3', name: 'Normal' }],
    statuses: [
      { id: '1', name: 'New' },
      { id: '2', name: 'In Progress' },
      { id: '3', name: 'Review' }
    ],
    sprints: [{ id: '4', name: 'Sprint 42' }],
    users: [{ id: '7', name: 'Иван' }],
    error: null
  },
  gitlab: {
    status: 'disconnected',
    baseUrl: 'https://gitlab.example.com/',
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

function connectedState(): AppState {
  return {
    ...baseState,
    gitlab: {
      ...baseState.gitlab,
      status: 'connected',
      hasToken: true,
      projects: [{
        id: '10',
        name: 'Workspace',
        pathWithNamespace: 'example/workspace',
        webUrl: 'https://gitlab.example.com/example/workspace',
        defaultBranch: 'main',
        lastActivityAt: '2026-06-01T10:00:00.000Z',
        sshUrlToRepo: 'git@gitlab.example.com:example/workspace.git',
        httpUrlToRepo: 'https://gitlab.example.com/example/workspace.git'
      }],
      selectedProjectIds: ['10']
    },
    telegram: {
      ...baseState.telegram,
      status: 'connected',
      hasApiCredentials: true,
      phoneMasked: '+10***00',
      chats: [
        {
          id: 'chat_1',
          title: 'Backend Team',
          type: 'group',
          avatar: null,
          hasTopics: false,
          selected: true,
          notificationsEnabled: true,
          lastSyncedAt: '2026-05-27T10:00:00.000Z',
          lastMessageAt: '2026-05-27T10:00:00.000Z',
          unreadCount: 1
        }
      ],
      messages: [
        {
          id: 'chat_1:10',
          chatId: 'chat_1',
          topicId: null,
          senderId: 'user_1',
          senderName: 'Анна',
          senderAvatar: null,
          sentAt: '2026-05-27T10:00:00.000Z',
          text: 'Добавить проверку обязательных полей Redmine.',
          status: 'new',
          createdAt: '2026-05-27T10:00:00.000Z',
          updatedAt: '2026-05-27T10:00:00.000Z'
        }
      ],
      folders: []
    }
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function setThreadScrollMetrics(
  thread: Element,
  metrics: { scrollHeight: number; clientHeight: number; scrollTop: number }
) {
  Object.defineProperty(thread, 'scrollHeight', {
    configurable: true,
    value: metrics.scrollHeight
  });
  Object.defineProperty(thread, 'clientHeight', {
    configurable: true,
    value: metrics.clientHeight
  });
  Object.defineProperty(thread, 'scrollTop', {
    configurable: true,
    writable: true,
    value: metrics.scrollTop
  });
}

function installThreadScrollPrototypeMetrics(metrics: {
  scrollHeight: number;
  clientHeight: number;
  initialScrollTop: number;
}) {
  let scrollTop = metrics.initialScrollTop;
  const prototype = HTMLElement.prototype;
  const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(prototype, 'scrollHeight');
  const clientHeightDescriptor = Object.getOwnPropertyDescriptor(prototype, 'clientHeight');
  const scrollTopDescriptor = Object.getOwnPropertyDescriptor(prototype, 'scrollTop');

  Object.defineProperty(prototype, 'scrollHeight', {
    configurable: true,
    get: () => metrics.scrollHeight
  });
  Object.defineProperty(prototype, 'clientHeight', {
    configurable: true,
    get: () => metrics.clientHeight
  });
  Object.defineProperty(prototype, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value) => {
      scrollTop = value;
    }
  });

  return () => {
    if (scrollHeightDescriptor) {
      Object.defineProperty(prototype, 'scrollHeight', scrollHeightDescriptor);
    } else {
      delete (prototype as unknown as Record<string, unknown>).scrollHeight;
    }
    if (clientHeightDescriptor) {
      Object.defineProperty(prototype, 'clientHeight', clientHeightDescriptor);
    } else {
      delete (prototype as unknown as Record<string, unknown>).clientHeight;
    }
    if (scrollTopDescriptor) {
      Object.defineProperty(prototype, 'scrollTop', scrollTopDescriptor);
    } else {
      delete (prototype as unknown as Record<string, unknown>).scrollTop;
    }
  };
}

function installBridge(initialState: AppState) {
  let state = initialState;
  const telegramInboxSnapshot = (): TelegramInboxSnapshot => {
    const chats = state.telegram.chats.map((chat) => ({
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
    return {
      status: state.telegram.status,
      phoneMasked: state.telegram.phoneMasked,
      chats,
      topics: state.telegram.topics,
      unread: {
        selectedUnreadCount: chats
          .filter((chat) => chat.selected)
          .reduce((total, chat) => total + Math.max(0, chat.unreadCount), 0),
        notifyingUnreadCount: chats
          .filter((chat) => chat.selected && chat.notificationsEnabled)
          .reduce((total, chat) => total + Math.max(0, chat.unreadCount), 0)
      },
      error: state.telegram.error
    };
  };
  const api = {
    getState: vi.fn(async () => state),
    deleteLocalData: vi.fn(async () => state),
    onStateChanged: vi.fn((_listener: (state: AppState) => void) => () => undefined),
    onMailStateChanged: vi.fn(() => () => undefined),
    onBrowserStateChanged: vi.fn(() => () => undefined),
    onChatGptStateChanged: vi.fn(() => () => undefined),
    getAiQueue: vi.fn(async (): Promise<AiQueueItem[]> => []),
    onAiQueueChanged: vi.fn(() => () => undefined),
    getAgentWorkPrompt: vi.fn(async () => 'agent prompt'),
    listAgentWorkReports: vi.fn(async (): Promise<AgentWorkItem[]> => []),
    openAgentWorkFolder: vi.fn(async () => ''),
    deleteAgentWorkReport: vi.fn(async () => undefined),
    selectAgentWorkingDirectory: vi.fn(async () => '/tmp/project'),
    prepareGitLabProjectWorkspace: vi.fn(async (): Promise<GitLabProjectWorkspaceResult> => ({
      projectId: '101',
      projectName: 'example/workspace',
      workingDirectory: '/tmp/team-space-projects/example/workspace',
      action: 'pulled'
    })),
    getGitLabProjectWorkspacePath: vi.fn(async (payload: { projectId: string }) =>
      payload.projectId === '202'
        ? '/tmp/team-space-projects/example/backend/service'
        : '/tmp/team-space-projects/example/workspace'
    ),
    runAgentForRedmineIssue: vi.fn(async (payload: RedmineIssueAgentRunPayload): Promise<RedmineIssueAgentRunResult> => ({
      directory: `${payload.workingDirectory}/.team-space-agent-runs/issue-123-test`,
      workingDirectory: payload.workingDirectory,
      inputFile: `${payload.workingDirectory}/.team-space-agent-runs/issue-123-test/task.json`,
      issueMarkdownFile: `${payload.workingDirectory}/.team-space-agent-runs/issue-123-test/task.md`,
      promptFile: `${payload.workingDirectory}/.team-space-agent-runs/issue-123-test/prompt.md`,
      outputFile: `${payload.workingDirectory}/.team-space-agent-runs/issue-123-test/agent-result.md`,
      rawOutputFile: `${payload.workingDirectory}/.team-space-agent-runs/issue-123-test/codex-proxy.log`
    })),
    createRedmineIssueFromAgentWork: vi.fn(async (): Promise<RedmineIssueSummary> => ({
      id: '321',
      subject: 'Agent report',
      tracker: 'Task',
      statusId: '1',
      status: 'New',
      priority: 'Normal',
      assignee: 'Иван',
      dueDate: '',
      updatedOn: '2026-06-01T10:00:00.000Z',
      url: 'https://redmine.example.com/issues/321'
    })),
    openExternal: vi.fn(async () => undefined),
    openPath: vi.fn(async () => ''),
    copyText: vi.fn(async () => undefined),
    readTextFile: vi.fn(async () => '# AI description'),
    writeTextFile: vi.fn(async () => undefined),
    showMailView: vi.fn(async () => ({
      canGoBack: false,
      loading: false,
      url: 'https://mail.example.com/',
      error: ''
    })),
    setMailBounds: vi.fn(async () => undefined),
    hideMailView: vi.fn(async () => undefined),
    goBackMailView: vi.fn(async () => undefined),
    reloadMailView: vi.fn(async () => undefined),
    getMailCredentialsStatus: vi.fn(async () => ({
      url: 'https://mail.example.com/',
      username: '',
      hasPassword: false
    })),
    saveMailCredentials: vi.fn(async (payload: { url?: string; username: string }) => ({
      url: payload.url ?? 'https://mail.example.com/',
      username: payload.username,
      hasPassword: true
    })),
    deleteMailCredentials: vi.fn(async () => ({
      url: 'https://mail.example.com/',
      username: '',
      hasPassword: false
    })),
    showBrowserView: vi.fn(async (payload: { url?: string }) => ({
      canGoBack: false,
      loading: false,
      url: payload.url ?? '',
      error: ''
    })),
    setBrowserBounds: vi.fn(async () => undefined),
    hideBrowserView: vi.fn(async () => undefined),
    goBackBrowserView: vi.fn(async () => undefined),
    reloadBrowserView: vi.fn(async () => undefined),
    showChatGptView: vi.fn(async () => ({
      canGoBack: false,
      loading: false,
      url: 'https://chatgpt.com/',
      error: ''
    })),
    setChatGptBounds: vi.fn(async () => undefined),
    hideChatGptView: vi.fn(async () => undefined),
    goBackChatGptView: vi.fn(async () => undefined),
    reloadChatGptView: vi.fn(async () => undefined),
    resetChatGptSession: vi.fn(async () => ({
      canGoBack: false,
      loading: false,
      url: 'https://chatgpt.com/',
      error: ''
    })),
    openTelemost: vi.fn(async () => undefined),
    getKatyaBaseUrl: vi.fn(async () => 'http://localhost:8077'),
    saveKatyaBaseUrl: vi.fn(async () => undefined),
    saveKatyaSettings: vi.fn(async () => undefined),
    getKatyaSession: vi.fn(async () => 'test-session'),
    saveKatyaSession: vi.fn(async () => undefined),
    listKatyaGroups: vi.fn(async (): Promise<KatyaAccessGroup[]> => [
      { id: 'group-access-1', name: 'Команда разработки' },
      { id: 'group-access-2', name: 'Дэйлики' }
    ]),
    getKatyaMe: vi.fn(async () => ({
      email: 'user@example.com',
      enabled: true,
      first_name: 'Test',
      is_admin: false,
      last_name: 'User',
      username: 'test.user'
    })),
    createKatyaMeeting: vi.fn(async (payload: { url: string; title: string; groupId?: string }) => ({
      id: 'katya_meeting_1',
      url: payload.url,
      title: payload.title,
      status: 'recording',
      group_id: payload.groupId
    })),
    stopKatyaMeeting: vi.fn(async () => ({
      id: 'katya_meeting_1',
      url: 'https://telemost.yandex.ru/j/00000000000000',
      title: 'Дэйлик',
      status: 'transcribing'
    })),
    listKatyaMeetings: vi.fn(async (): Promise<KatyaMeetingListResponse> => ({
      data: [
        {
          id: 'katya_meeting_1',
          url: 'https://telemost.yandex.ru/j/00000000000000',
          title: 'Проверка шизы 3',
          status: 'done',
          segments: [
            {
              start: 0,
              end: 1.18,
              text: 'Катюха, привет.',
              speaker: 'speaker_0'
            }
          ],
          speaker_names: { speaker_0: '' },
          duration_sec: 30,
          started_at: '2026-05-29T09:07:48.69497Z',
          created_at: '2026-05-29T09:07:39.80922Z',
          owner_username: 'fastrom',
          owner_display_name: 'Роман Косоногов',
          group_name: 'Demo'
        }
      ],
      page: 1,
      page_size: 20,
      total: 1
    })),
    getKatyaMeeting: vi.fn(async (): Promise<KatyaMeetingDetail> => ({
      id: 'katya_meeting_1',
      url: 'https://telemost.yandex.ru/j/00000000000000',
      title: 'Проверка шизы 3',
      status: 'done',
      video_url: '/media/katya_meeting_1.mp4',
      transcript: '[00:00:00] Спикер 1:Катюха, привет.',
      summary: '**Краткое резюме**\nТехническая проверка записи.',
      segments: [
        {
          start: 0,
          end: 1.18,
          text: 'Катюха, привет.',
          speaker: 'speaker_0'
        },
        {
          start: 2.18,
          end: 7.54,
          text: 'Проверяю одновременную запись.',
          speaker: 'speaker_0'
        }
      ],
      speaker_names: { speaker_0: '' },
      duration_sec: 30,
      started_at: '2026-05-29T09:07:48.69497Z'
    })),
    analyzeKatyaDailies: vi.fn(async (): Promise<KatyaDailyAnalysisAiResult> => ({
      directory: '/tmp/Team Space AI Tasks/daily-analysis-test',
      inputFile: '/tmp/Team Space AI Tasks/daily-analysis-test/meetings.json',
      promptFile: '/tmp/Team Space AI Tasks/daily-analysis-test/prompt.md',
      outputFile: '/tmp/Team Space AI Tasks/daily-analysis-test/processed.md',
      rawOutputFile: '/tmp/Team Space AI Tasks/daily-analysis-test/codex-proxy.log',
      content: '# Анализ дэйликов\n\n## Обязательства по сотрудникам\n- Спикер 1: проверить одновременную запись.',
      meetingsCount: 1,
      createdAt: '2026-05-29T12:00:00.000Z'
    })),
    listKatyaDailyAnalyses: vi.fn(async (): Promise<KatyaDailyAnalysisAiResult[]> => [
      {
        directory: '/tmp/Team Space AI Tasks/daily-analysis-saved',
        inputFile: '/tmp/Team Space AI Tasks/daily-analysis-saved/meetings.json',
        promptFile: '/tmp/Team Space AI Tasks/daily-analysis-saved/prompt.md',
        outputFile: '/tmp/Team Space AI Tasks/daily-analysis-saved/processed.md',
        rawOutputFile: '/tmp/Team Space AI Tasks/daily-analysis-saved/codex-proxy.log',
        content: '# Анализ дэйликов\n\n## Общий вывод\n- Сохраненный анализ открыт без новой генерации.',
        meetingsCount: 12,
        createdAt: '2026-05-29T13:00:00.000Z'
      }
    ]),
    saveRecording: vi.fn(async () => ({
      directory: '/tmp/Team Space Recordings',
      filePath: '/tmp/Team Space Recordings/team-space-recording-test.webm'
    })),
    openRecordingFolder: vi.fn(async () => ''),
    requestTelegramCode: vi.fn(async () => {
      state = {
        ...state,
        telegram: {
          ...state.telegram,
          phoneMasked: '+10***00',
          hasApiCredentials: true,
          codeRequested: true,
          codeDelivery: 'Telegram app'
        }
      };
      return state;
    }),
    connectTelegram: vi.fn(async () => {
      state = connectedState();
      return state;
    }),
    syncTelegram: vi.fn(async () => state),
    getTelegramInboxSnapshot: vi.fn(async () => telegramInboxSnapshot()),
    getTelegramThread: vi.fn(async (payload: TelegramThreadRequest): Promise<TelegramThreadView> => ({
      key: { chatId: payload.chatId, topicId: payload.topicId },
      messages: state.telegram.messages
        .filter((message) => message.chatId === payload.chatId)
        .filter((message) => !payload.topicId || message.topicId === payload.topicId)
        .sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime()),
      hasOlder: false,
      loading: false
    })),
    markTelegramThreadRead: vi.fn(async () => telegramInboxSnapshot()),
    loadChatMessages: vi.fn(async (payload: { chatId: string }) => {
      state = {
        ...state,
        telegram: {
          ...state.telegram,
          chats: state.telegram.chats.map((chat) =>
            chat.id === payload.chatId ? { ...chat, unreadCount: 0 } : chat
          )
        }
      };
      return state;
    }),
    loadOlderChatMessages: vi.fn(async () => state),
    sendTelegramMessage: vi.fn(async (_payload: {
      chatId: string;
      topicId?: string;
      text: string;
      file?: TelegramOutgoingFile;
      image?: TelegramOutgoingFile;
    }) => state),
    reactToTelegramMessage: vi.fn(async (payload: { messageId: string; emoticon: string }) => {
      state = {
        ...state,
        telegram: {
          ...state.telegram,
          messages: state.telegram.messages.map((message) =>
            message.id === payload.messageId
              ? {
                  ...message,
                  reactions: [{ emoticon: payload.emoticon, count: 1, mine: true, users: ['Вы'] }]
                }
              : message
          )
        }
      };
      return state;
    }),
    downloadTelegramAttachment: vi.fn(async () => ({
      filePath: '/tmp/screenshot.png',
      fileUrl: 'teamspace-file://telegram/video'
    })),
    disconnectTelegram: vi.fn(async () => state),
    selectTelegramWorkspace: vi.fn(async () => state),
    setTelegramChatNotifications: vi.fn(async (payload: { chatId: string; enabled: boolean }) => {
      state = {
        ...state,
        telegram: {
          ...state.telegram,
          chats: state.telegram.chats.map((chat) =>
            chat.id === payload.chatId ? { ...chat, notificationsEnabled: payload.enabled } : chat
          )
        }
      };
      return state;
    }),
    testGitLab: vi.fn(async () => {
      state = {
        ...state,
        gitlab: {
          ...state.gitlab,
          status: 'connected',
          hasToken: true,
          projects: [{
            id: '10',
            name: 'Workspace',
            pathWithNamespace: 'example/workspace',
            webUrl: 'https://gitlab.example.com/example/workspace',
            defaultBranch: 'main',
            lastActivityAt: '2026-06-01T10:00:00.000Z',
            sshUrlToRepo: 'git@gitlab.example.com:example/workspace.git',
            httpUrlToRepo: 'https://gitlab.example.com/example/workspace.git'
          }]
        }
      };
      return state;
    }),
    saveGitLab: vi.fn(async (payload: { selectedProjectIds: string[] }) => {
      state = {
        ...state,
        gitlab: {
          ...state.gitlab,
          selectedProjectIds: payload.selectedProjectIds
        }
      };
      return state;
    }),
    syncGitLabProjects: vi.fn(async () => state),
    disconnectGitLab: vi.fn(async () => {
      state = {
        ...state,
        gitlab: {
          ...state.gitlab,
          status: 'disconnected',
          hasToken: false,
          projects: [],
          selectedProjectIds: [],
          error: null
        }
      };
      return state;
    }),
    testRedmine: vi.fn(async () => state),
    saveRedmine: vi.fn(async () => state),
    selectRedmineProject: vi.fn(async (payload: { projectId: string }) => {
      if (payload.projectId === '5') {
        state = {
          ...state,
          workspace: {
            ...state.workspace,
            defaultProjectId: '5',
            defaultSprintId: '8',
            defaultAssigneeId: '9'
          },
          redmine: {
            ...state.redmine,
            sprints: [{ id: '8', name: 'Mobile Sprint' }],
            users: [{ id: '9', name: 'Mobile User' }]
          }
        };
      }
      return state;
    }),
    loadRedmineProjectUsers: vi.fn(async (payload: { projectId: string }) => {
      if (payload.projectId === '5') {
        state = {
          ...state,
          workspace: {
            ...state.workspace,
            defaultSprintId: '8',
            defaultAssigneeId: '9'
          },
          redmine: {
            ...state.redmine,
            sprints: [{ id: '8', name: 'Mobile Sprint' }],
            users: [{ id: '9', name: 'Mobile User' }]
          }
        };
      }
      return state;
    }),
    loadRedmineMyIssues: vi.fn(async (): Promise<RedmineIssueListResponse> => ({
      issues: [
        {
          id: '123',
          subject: 'Проверить обработку спринта',
          tracker: 'Task',
          statusId: '2',
          status: 'In Progress',
          priority: 'Normal',
          assignee: 'Иван',
          dueDate: '2026-06-02',
          updatedOn: '2026-05-28T08:30:00.000Z',
          url: 'https://redmine.example.com/issues/123'
        }
      ],
      source: 'redmine' as RedmineIssueListResponse['source'],
      syncedAt: '2026-05-28T08:30:00.000Z'
    })),
    syncRedmineMyIssues: vi.fn(async (): Promise<RedmineIssueListResponse> => ({
      issues: [
        {
          id: '123',
          subject: 'Проверить обработку спринта',
          tracker: 'Task',
          statusId: '2',
          status: 'In Progress',
          priority: 'Normal',
          assignee: 'Иван',
          dueDate: '2026-06-02',
          updatedOn: '2026-05-28T08:30:00.000Z',
          url: 'https://redmine.example.com/issues/123'
        }
      ],
      source: 'redmine' as RedmineIssueListResponse['source'],
      syncedAt: '2026-05-28T08:30:00.000Z'
    })),
    loadRedmineIssueDetails: vi.fn(async (): Promise<RedmineIssueDetails> => ({
      issue: {
        id: 123,
        subject: 'Проверить обработку спринта',
        description: '<p><strong>Полное описание</strong><br>задачи</p>',
        project: { id: 1, name: 'Team Space' },
        tracker: { id: 2, name: 'Task' },
        status: { id: 2, name: 'In Progress' },
        priority: { id: 3, name: 'Normal' },
        assigned_to: { id: 7, name: 'Иван' },
        author: { id: 8, name: 'Анна' },
        fixed_version: { id: 4, name: 'Sprint 42' },
        done_ratio: 20,
        created_on: '2026-05-27T08:30:00.000Z',
        updated_on: '2026-05-28T08:30:00.000Z',
        due_date: '2026-06-02',
        journals: [
          {
            id: 1,
            user: { id: 8, name: 'Анна' },
            notes: '<p><strong>Комментарий</strong> по задаче</p>',
            created_on: '2026-05-28T09:00:00.000Z'
          }
        ],
        custom_fields: [
          { id: 10, name: 'Стенд', value: 'dev' }
        ],
        attachments: [
          { id: 11, filename: 'trace.log' },
          {
            id: 12,
            filename: 'screenshot.png',
            content_type: 'image/png',
            previewDataUrl: 'data:image/png;base64,c2NyZWVuc2hvdA=='
          }
        ]
      }
    })),
    updateRedmineIssueDetails: vi.fn(async (payload: {
      issueId: string;
      subject: string;
      description: string;
    }): Promise<RedmineIssueDetails> => ({
      issue: {
        id: Number(payload.issueId),
        subject: payload.subject,
        description: payload.description,
        project: { id: 1, name: 'Team Space' },
        tracker: { id: 2, name: 'Task' },
        status: { id: 2, name: 'In Progress' },
        priority: { id: 3, name: 'Normal' },
        assigned_to: { id: 7, name: 'Иван' },
        updated_on: '2026-05-29T10:00:00.000Z',
        journals: []
      }
    })),
    updateRedmineIssueAssignee: vi.fn(async (payload: {
      issueId: string;
      assigneeId: string;
      assignee?: string;
    }): Promise<RedmineIssueDetails> => ({
      issue: {
        id: Number(payload.issueId),
        subject: 'Проверить обработку спринта',
        description: '<p><strong>Полное описание</strong><br>задачи</p>',
        project: { id: 1, name: 'Team Space' },
        tracker: { id: 2, name: 'Task' },
        status: { id: 2, name: 'In Progress' },
        priority: { id: 3, name: 'Normal' },
        assigned_to: payload.assigneeId ? { id: Number(payload.assigneeId), name: payload.assignee || 'Исполнитель' } : undefined,
        updated_on: '2026-05-29T10:00:00.000Z',
        journals: []
      }
    })),
    deleteRedmineIssue: vi.fn(async () => undefined),
    updateRedmineIssueSprint: vi.fn(async (payload: {
      issueId: string;
      sprintId: string;
    }): Promise<RedmineIssueDetails> => ({
      issue: {
        id: Number(payload.issueId),
        subject: 'Проверить обработку спринта',
        description: '<p><strong>Полное описание</strong><br>задачи</p>',
        project: { id: 1, name: 'Team Space' },
        tracker: { id: 2, name: 'Task' },
        status: { id: 2, name: 'In Progress' },
        priority: { id: 3, name: 'Normal' },
        assigned_to: { id: 7, name: 'Иван' },
        fixed_version: { id: Number(payload.sprintId.replace('version:', '')), name: 'Sprint 43' },
        updated_on: '2026-05-29T10:00:00.000Z',
        journals: []
      }
    })),
    addRedmineIssueComment: vi.fn(async (payload: {
      issueId: string;
      notes: string;
    }): Promise<RedmineIssueDetails> => ({
      issue: {
        id: Number(payload.issueId),
        subject: 'Проверить обработку спринта',
        description: '<p><strong>Полное описание</strong><br>задачи</p>',
        project: { id: 1, name: 'Team Space' },
        tracker: { id: 2, name: 'Task' },
        status: { id: 2, name: 'In Progress' },
        priority: { id: 3, name: 'Normal' },
        assigned_to: { id: 7, name: 'Иван' },
        updated_on: '2026-05-29T10:00:00.000Z',
        journals: [
          {
            id: 2,
            user: { id: 7, name: 'Иван' },
            notes: payload.notes,
            created_on: '2026-05-29T10:05:00.000Z'
          }
        ]
      }
    })),
    updateRedmineIssueJournal: vi.fn(async (payload: {
      issueId: string;
      journalId: string;
      notes: string;
    }): Promise<RedmineIssueDetails> => ({
      issue: {
        id: Number(payload.issueId),
        subject: 'Проверить обработку спринта',
        description: '<p><strong>Полное описание</strong><br>задачи</p>',
        project: { id: 1, name: 'Team Space' },
        tracker: { id: 2, name: 'Task' },
        status: { id: 2, name: 'In Progress' },
        priority: { id: 3, name: 'Normal' },
        assigned_to: { id: 7, name: 'Иван' },
        updated_on: '2026-05-29T10:10:00.000Z',
        journals: [
          {
            id: Number(payload.journalId),
            user: { id: 8, name: 'Анна' },
            notes: payload.notes,
            created_on: '2026-05-28T09:00:00.000Z'
          }
        ]
      }
    })),
    createRedmineIssue: vi.fn(async (payload: CreateRedmineIssuePayload): Promise<RedmineIssueSummary> => ({
      id: '124',
      subject: payload.subject,
      tracker: payload.tracker ?? 'Task',
      statusId: payload.statusId ?? '',
      status: payload.status ?? '',
      priority: payload.priority ?? 'Normal',
      assignee: payload.assignee ?? 'Иван',
      dueDate: '',
      updatedOn: '2026-05-29T10:00:00.000Z',
      url: 'https://redmine.example.com/issues/124'
    })),
    updateRedmineIssueStatus: vi.fn(async (payload: {
      issueId: string;
      statusId: string;
      status?: string;
    }): Promise<RedmineIssueDetails> => ({
      issue: {
        id: Number(payload.issueId) || payload.issueId,
        status: { id: Number(payload.statusId) || payload.statusId, name: payload.status ?? payload.statusId },
        updated_on: '2026-06-01T10:00:00.000Z'
      }
    })),
    loadLatestGeneratedDescriptions: vi.fn(async () => ({})),
    formatRedmineIssueWithAi: vi.fn(async (): Promise<RedmineIssueAiResult> => ({
      directory: '/tmp/team-space-ai',
      inputFile: '/tmp/team-space-ai/input.json',
      promptFile: '/tmp/team-space-ai/prompt.txt',
      outputFile: '/tmp/team-space-ai/output.md',
      rawOutputFile: '/tmp/team-space-ai/output.raw.txt'
    })),
    generateRedmineSprintResultsWithAi: vi.fn(async (): Promise<RedmineSprintResultsAiResult> => ({
      directory: '/tmp/team-space-ai/sprint-results',
      inputFile: '/tmp/team-space-ai/sprint-results/sprint.json',
      promptFile: '/tmp/team-space-ai/sprint-results/prompt.md',
      outputFile: '/tmp/team-space-ai/sprint-results/processed.md',
      rawOutputFile: '/tmp/team-space-ai/sprint-results/codex-proxy.raw.txt',
      content: '# Результаты спринта\n\n## Получилось\n- #1 Сделано\n\n## Не получилось\n- Нет'
    })),
    disconnectRedmine: vi.fn(async () => state),
    createRedmineIssueFromMessages: vi.fn(async (payload: { messageIds: string[] }) => {
      state = {
        ...state,
        telegram: {
          ...state.telegram,
          messages: state.telegram.messages.map((message) =>
            payload.messageIds.includes(message.id)
              ? { ...message, status: 'created', updatedAt: '2026-05-27T10:00:00.000Z' }
              : message
          )
        },
        metrics: {
          ...state.metrics,
          createdIssues: state.metrics.createdIssues + 1
        }
      };
      return state;
    })
  };

  window.teamSpace = {
    platform: 'darwin',
    versions: {
      node: '20',
      chrome: '120',
      electron: '33'
    },
    api
  };

  return api;
}

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('requests a real Telegram code before connecting', async () => {
    const api = installBridge(baseState);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: 'Telegram' });
    await user.click(screen.getByRole('button', { name: 'Telegram' }));
    await user.click(screen.getByRole('button', { name: 'Далее' }));
    await user.type(screen.getByLabelText('Номер телефона'), '+10000000000');
    await user.click(screen.getByRole('button', { name: 'Далее' }));

    expect(api.requestTelegramCode).toHaveBeenCalledWith(expect.objectContaining({
      phone: '+10000000000'
    }));
    expect(api.requestTelegramCode).not.toHaveBeenCalledWith(expect.objectContaining({
      apiId: expect.any(String),
      apiHash: expect.any(String)
    }));
    expect(await screen.findByText(/Код запрошен через Telegram/)).toBeInTheDocument();
  });

  it('connects GitLab and advances to defaults in setup', async () => {
    const api = installBridge(baseState);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'GitLab' }));
    await screen.findByRole('heading', { name: 'Исходный код проектов' });
    await user.type(screen.getByLabelText('Personal Access Token'), 'gitlab-test-token');
    await user.click(screen.getByRole('button', { name: 'Проверить и подключить GitLab' }));

    expect(api.testGitLab).toHaveBeenCalledWith({
      baseUrl: 'https://gitlab.example.com/',
      token: 'gitlab-test-token'
    });
    expect(await screen.findByRole('heading', { name: 'Проект, tracker, priority, спринт и исполнитель по умолчанию' })).toBeInTheDocument();
  });

  it('saves defaults and advances to Katya in setup', async () => {
    const api = installBridge(baseState);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Defaults' }));
    await user.click(screen.getByRole('button', { name: 'Сохранить defaults' }));

    await waitFor(() =>
      expect(api.saveRedmine).toHaveBeenCalledWith({
        baseUrl: 'https://redmine.example.com/',
        defaultProjectId: '1',
        defaultTrackerId: '2',
        defaultPriorityId: '3',
        defaultSprintId: '4',
        defaultAssigneeId: '7'
      })
    );
    expect(await screen.findByRole('heading', { name: 'Сервис записи Катя' })).toBeInTheDocument();
  });

  it('marks defaults as done when Redmine has no tracker and priority catalogs', async () => {
    const state = {
      ...baseState,
      redmine: {
        ...baseState.redmine,
        trackers: [],
        priorities: []
      },
      workspace: {
        ...baseState.workspace,
        defaultTrackerId: '',
        defaultPriorityId: ''
      }
    };
    const api = installBridge(state);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Defaults' }));
    await user.click(screen.getByRole('button', { name: 'Сохранить defaults' }));

    expect(await screen.findByRole('heading', { name: 'Сервис записи Катя' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Defaults/ })).toHaveClass('done');
    expect(api.saveRedmine).toHaveBeenCalledWith({
      baseUrl: 'https://redmine.example.com/',
      defaultProjectId: '1',
      defaultTrackerId: '',
      defaultPriorityId: '',
      defaultSprintId: '4',
      defaultAssigneeId: '7'
    });
  });

  it('shows Start Work action on the final setup review', async () => {
    const api = installBridge(connectedState());
    api.getKatyaSession.mockResolvedValue('');
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Проверка' }));

    expect(screen.getByRole('button', { name: 'Начать работу' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Перейти к сообщениям' })).not.toBeInTheDocument();
  });

  it('creates a Redmine issue from a selected Telegram message', async () => {
    const api = installBridge(connectedState());
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('heading', { name: 'Backend Team' });
    await user.click(await screen.findByText('Добавить проверку обязательных полей Redmine.'));
    await user.click(screen.getByRole('button', { name: 'Создать задачу' }));

    await waitFor(() => expect(api.createRedmineIssueFromMessages).toHaveBeenCalledWith({ messageIds: ['chat_1:10'] }));
    await expect(api.getState()).resolves.toMatchObject({
      telegram: {
        messages: [
          {
            id: 'chat_1:10',
            status: 'created'
          }
        ]
      },
      metrics: {
        createdIssues: 1
      }
    });
  });

  it('selects a Telegram message when the message bubble is clicked', async () => {
    const api = installBridge(connectedState());
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('heading', { name: 'Backend Team' });
    await user.click(await screen.findByText('Добавить проверку обязательных полей Redmine.'));
    await user.click(screen.getByRole('button', { name: 'Создать задачу' }));

    await waitFor(() =>
      expect(api.createRedmineIssueFromMessages).toHaveBeenCalledWith({ messageIds: ['chat_1:10'] })
    );
  });

  it('does not show message statuses or the status filter in Inbox', async () => {
    installBridge(connectedState());
    const { container } = render(<App />);

    await screen.findByRole('heading', { name: 'Backend Team' });

    expect(screen.queryByRole('combobox', { name: 'Все статусы' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Игнорировать' })).not.toBeInTheDocument();
    expect(screen.queryByText('Все статусы')).not.toBeInTheDocument();
    expect(container.querySelector('.message-status')).toBeNull();
  });

  it('toggles chat notifications in Inbox', async () => {
    const api = installBridge(connectedState());
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('heading', { name: 'Backend Team' });
    await user.click(screen.getByRole('button', { name: 'Отключить уведомления: Backend Team' }));

    await waitFor(() =>
      expect(api.setTelegramChatNotifications).toHaveBeenCalledWith({
        chatId: 'chat_1',
        enabled: false
      })
    );
    expect(await screen.findByRole('button', { name: 'Включить уведомления: Backend Team' })).toBeInTheDocument();
  });

  it('shows newest Telegram messages at the bottom', async () => {
    const state = connectedState();
    state.telegram.messages = [
      {
        id: 'chat_1:10',
        chatId: 'chat_1',
        topicId: null,
        senderId: 'user_1',
        senderName: 'Анна',
        senderAvatar: null,
        sentAt: '2026-05-27T10:00:00.000Z',
        text: 'Старое сообщение',
        status: 'new',
        createdAt: '2026-05-27T10:00:00.000Z',
        updatedAt: '2026-05-27T10:00:00.000Z'
      },
      {
        id: 'chat_1:11',
        chatId: 'chat_1',
        topicId: null,
        senderId: 'user_1',
        senderName: 'Анна',
        senderAvatar: null,
        sentAt: '2026-05-27T10:05:00.000Z',
        text: 'Самое новое сообщение',
        status: 'new',
        createdAt: '2026-05-27T10:05:00.000Z',
        updatedAt: '2026-05-27T10:05:00.000Z'
      }
    ];
    installBridge(state);
    render(<App />);

    await screen.findByRole('heading', { name: 'Backend Team' });
    const newest = await screen.findByText('Самое новое сообщение');
    const oldest = await screen.findByText('Старое сообщение');

    expect(oldest.compareDocumentPosition(newest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('loads Telegram thread through focused thread API when opening a chat', async () => {
    const state = connectedState();
    state.telegram.chats[0].selected = true;
    const api = installBridge(state);
    api.getTelegramThread = vi.fn(async (): Promise<TelegramThreadView> => ({
      key: { chatId: 'chat_1', topicId: null },
      messages: state.telegram.messages,
      hasOlder: false,
      loading: false
    }));
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: /Сообщения/ }));
    await user.click(screen.getAllByRole('button', { name: /Backend Team/ })[0]);

    await waitFor(() =>
      expect(api.getTelegramThread).toHaveBeenCalledWith({
        chatId: 'chat_1',
        topicId: null,
        limit: 50
      })
    );
  });

  it('marks Telegram thread read only after the bottom is viewed', async () => {
    const state = connectedState();
    const api = installBridge(state);
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { container } = render(<App />);

    try {
      await waitFor(() =>
        expect(api.getTelegramThread).toHaveBeenCalledWith({
          chatId: 'chat_1',
          topicId: null,
          limit: 50
        })
      );
      expect(api.markTelegramThreadRead).not.toHaveBeenCalled();

      const thread = container.querySelector('.telegram-thread');
      expect(thread).not.toBeNull();
      setThreadScrollMetrics(thread as Element, {
        scrollHeight: 1000,
        clientHeight: 400,
        scrollTop: 600
      });
      fireEvent.scroll(thread as Element);

      await waitFor(() =>
        expect(api.markTelegramThreadRead).toHaveBeenCalledWith({
          chatId: 'chat_1',
          topicId: null
        })
      );
    } finally {
      hasFocus.mockRestore();
    }
  });

  it('does not mark Telegram thread read from programmatic open scroll at the bottom', async () => {
    const state = connectedState();
    const api = installBridge(state);
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const restoreScrollMetrics = installThreadScrollPrototypeMetrics({
      scrollHeight: 1000,
      clientHeight: 400,
      initialScrollTop: 600
    });

    try {
      render(<App />);

      await waitFor(() =>
        expect(api.getTelegramThread).toHaveBeenCalledWith({
          chatId: 'chat_1',
          topicId: null,
          limit: 50
        })
      );
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      });

      expect(api.markTelegramThreadRead).not.toHaveBeenCalled();
    } finally {
      restoreScrollMetrics();
      hasFocus.mockRestore();
    }
  });

  it('does not repeatedly mark the same Telegram thread and newest message read', async () => {
    const state = connectedState();
    const api = installBridge(state);
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { container } = render(<App />);

    try {
      await waitFor(() => expect(api.getTelegramThread).toHaveBeenCalled());
      const thread = container.querySelector('.telegram-thread');
      expect(thread).not.toBeNull();
      setThreadScrollMetrics(thread as Element, {
        scrollHeight: 1000,
        clientHeight: 400,
        scrollTop: 600
      });

      fireEvent.scroll(thread as Element);
      await waitFor(() => expect(api.markTelegramThreadRead).toHaveBeenCalledTimes(1));
      fireEvent.scroll(thread as Element);

      expect(api.markTelegramThreadRead).toHaveBeenCalledTimes(1);
    } finally {
      hasFocus.mockRestore();
    }
  });

  it('merges returned read snapshot into Telegram counts without dropping full chat fields', async () => {
    const state = connectedState();
    state.telegram.chats[0] = {
      ...state.telegram.chats[0],
      lastMessageAt: null,
      lastSyncedAt: '2026-05-27T10:00:00.000Z',
      unreadCount: 1
    };
    state.telegram.messages = [];
    const threadMessage: TelegramMessage = {
      id: 'chat_1:10',
      chatId: 'chat_1',
      topicId: null,
      senderId: 'user_1',
      senderName: 'Анна',
      senderAvatar: null,
      sentAt: '2026-05-27T10:00:00.000Z',
      text: 'Thread-only unread message.',
      status: 'new',
      createdAt: '2026-05-27T10:00:00.000Z',
      updatedAt: '2026-05-27T10:00:00.000Z'
    };
    const api = installBridge(state);
    api.getTelegramThread.mockResolvedValue({
      key: { chatId: 'chat_1', topicId: null },
      messages: [threadMessage],
      hasOlder: false,
      loading: false
    });
    api.markTelegramThreadRead.mockResolvedValueOnce({
      status: 'connected',
      phoneMasked: '+10***00',
      chats: [{
        id: 'chat_1',
        title: 'Backend Team',
        type: 'group',
        avatar: null,
        selected: true,
        notificationsEnabled: true,
        hasTopics: false,
        unreadCount: 0,
        lastMessageAt: null
      }],
      topics: [],
      unread: {
        selectedUnreadCount: 0,
        notifyingUnreadCount: 0
      },
      error: null
    });
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { container } = render(<App />);

    try {
      expect(await screen.findByText('Thread-only unread message.')).toBeInTheDocument();
      expect(screen.getByText('1', { selector: '.unread-badge' })).toBeInTheDocument();
      const thread = container.querySelector('.telegram-thread');
      expect(thread).not.toBeNull();
      setThreadScrollMetrics(thread as Element, {
        scrollHeight: 1000,
        clientHeight: 400,
        scrollTop: 600
      });

      fireEvent.scroll(thread as Element);

      await waitFor(() => expect(api.markTelegramThreadRead).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.queryByText('1', { selector: '.unread-badge' })).not.toBeInTheDocument());
      expect(screen.getByText('13:00')).toBeInTheDocument();
    } finally {
      hasFocus.mockRestore();
    }
  });

  it('retries marking a Telegram thread read after a failed bottom-scroll attempt', async () => {
    const state = connectedState();
    const api = installBridge(state);
    api.markTelegramThreadRead
      .mockRejectedValueOnce(new Error('TDLib read failed'))
      .mockResolvedValueOnce({
        status: 'connected',
        phoneMasked: '+10***00',
        chats: [{
          id: 'chat_1',
          title: 'Backend Team',
          type: 'group',
          avatar: null,
          selected: true,
          notificationsEnabled: true,
          hasTopics: false,
          unreadCount: 0,
          lastMessageAt: '2026-05-27T10:00:00.000Z'
        }],
        topics: [],
        unread: {
          selectedUnreadCount: 0,
          notifyingUnreadCount: 0
        },
        error: null
      });
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { container } = render(<App />);

    try {
      await waitFor(() => expect(api.getTelegramThread).toHaveBeenCalled());
      const thread = container.querySelector('.telegram-thread');
      expect(thread).not.toBeNull();
      setThreadScrollMetrics(thread as Element, {
        scrollHeight: 1000,
        clientHeight: 400,
        scrollTop: 600
      });

      fireEvent.scroll(thread as Element);
      await waitFor(() => expect(api.markTelegramThreadRead).toHaveBeenCalledTimes(1));
      fireEvent.scroll(thread as Element);

      await waitFor(() => expect(api.markTelegramThreadRead).toHaveBeenCalledTimes(2));
    } finally {
      hasFocus.mockRestore();
    }
  });

  it('shows Telegram messages from the focused thread response', async () => {
    const state = connectedState();
    const threadMessage: TelegramMessage = {
      ...state.telegram.messages[0],
      id: 'chat_1:thread-only',
      text: 'Сообщение пришло из thread API.'
    };
    state.telegram.messages = [];
    const api = installBridge(state);
    api.getTelegramThread = vi.fn(async (): Promise<TelegramThreadView> => ({
      key: { chatId: 'chat_1', topicId: null },
      messages: [threadMessage],
      hasOlder: false,
      loading: false
    }));
    render(<App />);

    await screen.findByRole('heading', { name: 'Backend Team' });

    expect(await screen.findByText('Сообщение пришло из thread API.')).toBeInTheDocument();
  });

  it('refreshes the selected Telegram chat even when cached messages are already present', async () => {
    const state = connectedState();
    state.telegram.chats[0].unreadCount = 0;
    const api = installBridge(state);
    render(<App />);

    await screen.findByRole('heading', { name: 'Backend Team' });

    await waitFor(() =>
      expect(api.getTelegramThread).toHaveBeenCalledWith({
        chatId: 'chat_1',
        topicId: null,
        limit: 50
      })
    );
  });

  it('refreshes the focused Telegram thread after a realtime update adds a message', async () => {
    const state = connectedState();
    state.telegram.chats[0].unreadCount = 0;
    const api = installBridge(state);
    render(<App />);

    await waitFor(() =>
      expect(api.getTelegramThread).toHaveBeenCalledWith({
        chatId: 'chat_1',
        topicId: null,
        limit: 50
      })
    );
    api.getTelegramThread.mockClear();
    api.loadChatMessages.mockClear();

    const incomingMessage: TelegramMessage = {
      id: 'chat_1:11',
      chatId: 'chat_1',
      topicId: null,
      senderId: 'user_2',
      senderName: 'Борис',
      senderAvatar: null,
      sentAt: '2026-05-27T10:01:00.000Z',
      text: 'Новое входящее сообщение.',
      status: 'new',
      createdAt: '2026-05-27T10:01:00.000Z',
      updatedAt: '2026-05-27T10:01:00.000Z'
    };
    const realtimeState = connectedState();
    realtimeState.telegram.chats[0] = {
      ...realtimeState.telegram.chats[0],
      unreadCount: 1,
      lastMessageAt: '2026-05-27T10:01:00.000Z'
    };
    realtimeState.telegram.messages = [
      ...realtimeState.telegram.messages,
      incomingMessage
    ];
    api.getTelegramThread.mockResolvedValueOnce({
      key: { chatId: 'chat_1', topicId: null },
      messages: realtimeState.telegram.messages,
      hasOlder: false,
      loading: false
    });
    const onStateChanged = api.onStateChanged.mock.calls[0]?.[0] as ((state: AppState) => void) | undefined;
    await act(async () => {
      onStateChanged?.(realtimeState);
    });

    await waitFor(() =>
      expect(api.getTelegramThread).toHaveBeenCalledWith({
        chatId: 'chat_1',
        topicId: null,
        limit: 50
      })
    );
    expect(await screen.findByText('Новое входящее сообщение.')).toBeInTheDocument();
    expect(screen.getByText('1', { selector: '.unread-badge' })).toBeInTheDocument();
    expect(api.loadChatMessages).not.toHaveBeenCalled();
  });

  it('keeps a sent Telegram message visible after refreshing the focused thread', async () => {
    const state = connectedState();
    const api = installBridge(state);
    const user = userEvent.setup();
    const sentMessage: TelegramMessage = {
      id: 'chat_1:12',
      chatId: 'chat_1',
      topicId: null,
      senderId: null,
      senderName: 'Вы',
      senderAvatar: null,
      sentAt: '2026-05-27T10:02:00.000Z',
      text: 'Отправленное сообщение остается в треде.',
      status: 'new',
      createdAt: '2026-05-27T10:02:00.000Z',
      updatedAt: '2026-05-27T10:02:00.000Z'
    };
    const sentState: AppState = {
      ...state,
      telegram: {
        ...state.telegram,
        messages: [...state.telegram.messages, sentMessage],
        chats: state.telegram.chats.map((chat) =>
          chat.id === 'chat_1'
            ? { ...chat, lastMessageAt: sentMessage.sentAt }
            : chat
        )
      }
    };
    api.sendTelegramMessage.mockResolvedValueOnce(sentState);
    api.getTelegramThread.mockResolvedValueOnce({
      key: { chatId: 'chat_1', topicId: null },
      messages: state.telegram.messages,
      hasOlder: false,
      loading: false
    });
    api.getTelegramThread.mockResolvedValueOnce({
      key: { chatId: 'chat_1', topicId: null },
      messages: sentState.telegram.messages,
      hasOlder: false,
      loading: false
    });
    render(<App />);

    await screen.findByRole('heading', { name: 'Backend Team' });
    await user.type(screen.getByPlaceholderText('Сообщение в Backend Team'), sentMessage.text);
    await user.click(screen.getByRole('button', { name: 'Отправить' }));

    await waitFor(() => expect(api.sendTelegramMessage).toHaveBeenCalled());
    expect(await screen.findByText('Отправленное сообщение остается в треде.')).toBeInTheDocument();
    expect(screen.queryByText((content, element) =>
      Boolean(element?.closest('[data-message-id^="optimistic:"]')) && content === sentMessage.text
    )).not.toBeInTheDocument();
  });

  it('keeps the newer focused thread when an older same-thread request resolves later', async () => {
    const state = connectedState();
    const api = installBridge(state);
    const firstRequest = deferred<TelegramThreadView>();
    const newerMessage: TelegramMessage = {
      ...state.telegram.messages[0],
      id: 'chat_1:11',
      sentAt: '2026-05-27T10:01:00.000Z',
      text: 'Новое состояние треда.'
    };
    const realtimeState: AppState = {
      ...state,
      telegram: {
        ...state.telegram,
        chats: state.telegram.chats.map((chat) =>
          chat.id === 'chat_1'
            ? { ...chat, lastMessageAt: newerMessage.sentAt, unreadCount: 2 }
            : chat
        ),
        messages: [...state.telegram.messages, newerMessage]
      }
    };
    api.getTelegramThread.mockImplementationOnce(() => firstRequest.promise);
    api.getTelegramThread.mockResolvedValueOnce({
      key: { chatId: 'chat_1', topicId: null },
      messages: realtimeState.telegram.messages,
      hasOlder: false,
      loading: false
    });
    render(<App />);

    await waitFor(() => expect(api.getTelegramThread).toHaveBeenCalledTimes(1));
    const onStateChanged = api.onStateChanged.mock.calls[0]?.[0] as ((state: AppState) => void) | undefined;
    await act(async () => {
      onStateChanged?.(realtimeState);
    });
    expect(await screen.findByText('Новое состояние треда.')).toBeInTheDocument();

    await act(async () => {
      firstRequest.resolve({
        key: { chatId: 'chat_1', topicId: null },
        messages: [{
          ...state.telegram.messages[0],
          id: 'chat_1:stale',
          text: 'Устаревший ответ треда.'
        }],
        hasOlder: false,
        loading: false
      });
    });

    expect(screen.getByText('Новое состояние треда.')).toBeInTheDocument();
    expect(screen.queryByText('Устаревший ответ треда.')).not.toBeInTheDocument();
  });

  it('keeps older Telegram history visible after loading it through the compatibility API', async () => {
    const state = connectedState();
    const newestMessage: TelegramMessage = {
      ...state.telegram.messages[0],
      id: 'chat_1:20',
      sentAt: '2026-05-27T10:20:00.000Z',
      text: 'Новый край треда.'
    };
    const olderMessage: TelegramMessage = {
      ...state.telegram.messages[0],
      id: 'chat_1:10',
      sentAt: '2026-05-27T10:00:00.000Z',
      text: 'Старое сообщение из истории.'
    };
    state.telegram.messages = [newestMessage];
    const olderState: AppState = {
      ...state,
      telegram: {
        ...state.telegram,
        messages: [olderMessage, newestMessage]
      }
    };
    const api = installBridge(state);
    api.getTelegramThread.mockResolvedValue({
      key: { chatId: 'chat_1', topicId: null },
      messages: [newestMessage],
      hasOlder: true,
      loading: false
    });
    api.loadOlderChatMessages.mockResolvedValueOnce(olderState);
    const { container } = render(<App />);

    expect(await screen.findByText('Новый край треда.')).toBeInTheDocument();
    api.getTelegramThread.mockClear();

    const thread = container.querySelector('.telegram-thread');
    expect(thread).not.toBeNull();
    fireEvent.scroll(thread as Element, { target: { scrollTop: 0 } });

    await waitFor(() =>
      expect(api.loadOlderChatMessages).toHaveBeenCalledWith({
        chatId: 'chat_1',
        topicId: undefined,
        beforeMessageId: 'chat_1:20'
      })
    );
    expect(await screen.findByText('Старое сообщение из истории.')).toBeInTheDocument();
    expect(screen.getByText('Новый край треда.')).toBeInTheDocument();
    expect(api.getTelegramThread).not.toHaveBeenCalled();
  });

  it('shows AI queue as a separate tab and opens a queued task target', async () => {
    const api = installBridge(connectedState());
    api.getAiQueue.mockResolvedValueOnce([
      {
        id: 'ai-1',
        title: 'Агент по задаче #15988',
        status: 'done',
        target: { view: 'myTasks', label: 'Задача #15988', issueId: '15988' },
        context: {
          title: '#15988 - Проверить авторизацию',
          description: 'Нужно проверить разграничение прав доступа в мобильном приложении.',
          fields: [
            { label: 'Тип', value: 'Задача Redmine' },
            { label: 'Статус', value: 'Новые' },
            { label: 'Рабочая папка', value: '/tmp/project' }
          ]
        },
        resultFile: '/tmp/agent-result.md',
        sessionId: '019e83b5-c088-76b3-92fa-ee6b60900227',
        resultPreview: 'Агент проверил авторизацию и описал результат.',
        createdAt: '2026-06-01T10:00:00.000Z',
        startedAt: '2026-06-01T10:01:00.000Z',
        finishedAt: '2026-06-01T10:02:00.000Z',
        error: null
      }
    ]);
    api.readTextFile.mockResolvedValueOnce('Полный результат агента.\nПроверки прошли.');
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Очередь' }));

    expect(await screen.findByRole('heading', { name: 'Очередь задач' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Агент по задаче #15988/ }));

    expect(await screen.findByRole('heading', { name: '#15988 - Проверить авторизацию' })).toBeInTheDocument();
    expect(screen.getByText('Нужно проверить разграничение прав доступа в мобильном приложении.')).toBeInTheDocument();
    expect(screen.getByText('/tmp/project')).toBeInTheDocument();
    expect(screen.getByText('019e83b5-c088-76b3-92fa-ee6b60900227')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Открыть лог' })).not.toBeInTheDocument();
    expect(screen.getByText('Агент проверил авторизацию и описал результат.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Открыть результат' }));

    expect(api.readTextFile).toHaveBeenCalledWith('/tmp/agent-result.md');
    const resultDialog = await screen.findByRole('dialog', { name: 'Результат' });
    expect(resultDialog).toBeInTheDocument();
    expect(within(resultDialog).getByText(/Полный результат агента/)).toBeInTheDocument();
    expect(within(resultDialog).getByText(/Проверки прошли/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Закрыть' }));

    await user.click(screen.getByRole('button', { name: 'Открыть Задача #15988' }));

    expect(await screen.findByLabelText('Мои задачи Redmine')).toBeInTheDocument();
  });

  it('shows a chat image when the Telegram chat has an avatar', async () => {
    const state = connectedState();
    state.telegram.chats[0].avatar = 'data:image/jpeg;base64,Y2hhdA==';
    installBridge(state);
    const { container } = render(<App />);

    await screen.findByRole('heading', { name: 'Backend Team' });

    expect(container.querySelector('.chat-avatar img')).toHaveAttribute(
      'src',
      'data:image/jpeg;base64,Y2hhdA=='
    );
  });

  it('shows a sender image when a Telegram message has senderAvatar', async () => {
    const state = connectedState();
    state.telegram.messages[0].senderAvatar = 'data:image/jpeg;base64,c2VuZGVy';
    installBridge(state);
    const { container } = render(<App />);

    await screen.findByRole('heading', { name: 'Backend Team' });
    await waitFor(() => expect(container.querySelector('.message-avatar img')).not.toBeNull());

    expect(container.querySelector('.message-avatar img')).toHaveAttribute(
      'src',
      'data:image/jpeg;base64,c2VuZGVy'
    );
  });

  it('keeps avatar initials fallback when Telegram avatars are missing', async () => {
    installBridge(connectedState());
    const { container } = render(<App />);

    await screen.findByRole('heading', { name: 'Backend Team' });
    await screen.findByText('Добавить проверку обязательных полей Redmine.');

    expect(container.querySelector('.chat-avatar img')).toBeNull();
    expect(container.querySelector('.message-avatar img')).toBeNull();
    expect(container.querySelector('.chat-avatar')?.textContent).toBe('BT');
    expect(container.querySelector('.message-avatar')?.textContent).toBe('А');
  });

  it('downloads and plays a Telegram video attachment inline', async () => {
    const state = connectedState();
    state.telegram.messages[0] = {
      ...state.telegram.messages[0],
      text: '',
      attachments: [{
        id: 'video_1',
        type: 'file',
        fileName: 'IMG_1839.MP4',
        mimeType: 'video/mp4',
        size: 1024,
        dataUrl: null
      }]
    };
    const api = installBridge(state);
    const user = userEvent.setup();
    const { container } = render(<App />);

    await screen.findByRole('heading', { name: 'Backend Team' });
    expect(await screen.findByText('IMG_1839.MP4')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Загрузить видео' }));

    await waitFor(() =>
      expect(api.downloadTelegramAttachment).toHaveBeenCalledWith({
        messageId: 'chat_1:10',
        attachmentId: 'video_1'
      })
    );
    const video = container.querySelector('.message-video-player');
    expect(video).toBeInTheDocument();
    expect(video).toHaveAttribute('src', 'teamspace-file://telegram/video');
  });

  it('opens Telegram image attachments in fullscreen without selecting the message', async () => {
    const state = connectedState();
    state.telegram.messages[0] = {
      ...state.telegram.messages[0],
      text: '',
      attachments: [{
        id: 'image_1',
        type: 'image',
        fileName: 'screenshot.png',
        mimeType: 'image/png',
        size: 1024,
        dataUrl: 'data:image/png;base64,c2NyZWVuc2hvdA=='
      }]
    };
    installBridge(state);
    render(<App />);

    await screen.findByRole('heading', { name: 'Backend Team' });
    expect(screen.getByRole('button', { name: 'Создать задачу' })).toBeDisabled();

    await userEvent.click(await screen.findByRole('button', { name: 'Открыть изображение screenshot.png' }));

    expect(screen.getByRole('dialog', { name: 'screenshot.png' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Создать задачу' })).toBeDisabled();
  });

  it('sends a dragged image as a Telegram attachment', async () => {
    const api = installBridge(connectedState());
    const user = userEvent.setup();
    render(<App />);

    const heading = await screen.findByRole('heading', { name: 'Backend Team' });
    const chatSection = heading.closest('section');
    const file = new File(['image-bytes'], 'screenshot.png', { type: 'image/png' });

    fireEvent.dragOver(chatSection!, {
      dataTransfer: {
        files: [file],
        items: [{ kind: 'file', type: 'image/png' }],
        dropEffect: ''
      }
    });
    fireEvent.drop(chatSection!, {
      dataTransfer: {
        files: [file],
        items: [{ kind: 'file', type: 'image/png' }],
        dropEffect: ''
      }
    });

    await screen.findByText('screenshot.png');
    await user.click(screen.getByRole('button', { name: 'Отправить' }));

    await waitFor(() => expect(api.sendTelegramMessage).toHaveBeenCalled());
    const payload = api.sendTelegramMessage.mock.calls.at(-1)?.[0] as {
      chatId: string;
      text: string;
      file?: TelegramOutgoingFile;
      image?: TelegramOutgoingFile;
    };
    expect(payload.chatId).toBe('chat_1');
    expect(payload.text).toBe('');
    expect(payload.file?.name).toBe('screenshot.png');
    expect(payload.file?.mimeType).toBe('image/png');
    expect(payload.file?.data).toBeInstanceOf(ArrayBuffer);
    expect(payload.image?.name).toBe('screenshot.png');
  });

  it('sends a Telegram reply to the selected message', async () => {
    const api = installBridge(connectedState());
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('heading', { name: 'Backend Team' });
    await screen.findByText('Добавить проверку обязательных полей Redmine.');
    await user.click(screen.getByRole('button', { name: 'Ответить' }));
    await waitFor(() =>
      expect(screen.getAllByText('Добавить проверку обязательных полей Redmine.').length).toBeGreaterThan(1)
    );
    await user.type(screen.getByPlaceholderText('Сообщение в Backend Team'), 'Сделаю');
    await user.click(screen.getByRole('button', { name: 'Отправить' }));

    await waitFor(() => expect(api.sendTelegramMessage).toHaveBeenCalled());
    expect(api.sendTelegramMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'chat_1',
      replyToMessageId: 'chat_1:10',
      text: 'Сделаю'
    }));
  });

  it('adds a thumbs up reaction to a Telegram message', async () => {
    const api = installBridge(connectedState());
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('heading', { name: 'Backend Team' });
    await screen.findByText('Добавить проверку обязательных полей Redmine.');
    await user.click(screen.getByRole('button', { name: 'Поставить палец вверх' }));

    await waitFor(() =>
      expect(api.reactToTelegramMessage).toHaveBeenCalledWith({
        messageId: 'chat_1:10',
        emoticon: '👍'
      })
    );
    expect(screen.getByRole('button', { name: 'Поставить палец вверх' })).toHaveTextContent('1');
  });

  it('shows Telegram reactions from other users on a message', async () => {
    const state = connectedState();
    state.telegram.messages[0].reactions = [
      { emoticon: '🔥', count: 2, mine: false, users: ['Анна', 'Петр'] },
      { emoticon: '👍', count: 1, mine: false, users: ['Мария'] }
    ];
    installBridge(state);
    render(<App />);

    await screen.findByRole('heading', { name: 'Backend Team' });

    expect(await screen.findByLabelText('Реакции')).toHaveTextContent('🔥2');
    expect(screen.getByRole('button', { name: 'Поставить палец вверх' })).toHaveTextContent('1');
  });

  it('shows Telegram reaction authors when opening a reaction badge', async () => {
    const state = connectedState();
    state.telegram.messages[0].reactions = [
      { emoticon: '🔥', count: 2, mine: false, users: ['Анна', 'Петр'] }
    ];
    installBridge(state);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('heading', { name: 'Backend Team' });
    await user.click(await screen.findByLabelText('Реакция 🔥: 2. Анна, Петр'));

    expect(screen.getAllByText('Анна').length).toBeGreaterThan(1);
    expect(screen.getByText('Петр')).toBeInTheDocument();
  });

  it('scrolls to a replied Telegram message when clicking the quote', async () => {
    const state = connectedState();
    state.telegram.messages = [
      {
        ...state.telegram.messages[0],
        id: 'chat_1:10',
        text: 'Исходное сообщение'
      },
      {
        ...state.telegram.messages[0],
        id: 'chat_1:11',
        senderName: 'Вы',
        sentAt: '2026-05-27T10:01:00.000Z',
        text: 'Ответ',
        replyToMessageId: 'chat_1:10',
        replyToSenderName: 'Анна',
        replyToText: 'Исходное сообщение'
      }
    ];
    installBridge(state);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('heading', { name: 'Backend Team' });
    await user.click(await screen.findByRole('button', { name: 'Перейти к сообщению: Анна' }));

    const sourceMessage = screen.getAllByText('Исходное сообщение')[0].closest('.message-row');
    expect(sourceMessage).toHaveClass('reply-target-highlight');
  });

  it('shows agent work reports', async () => {
    const api = installBridge(connectedState());
    api.listAgentWorkReports.mockResolvedValueOnce([
      {
        id: '2026-06-01-agent-ui',
        title: 'Добавлена вкладка интерфейса',
        summary: 'Агент добавил новую вкладку и проверил UI.',
        directory: '/tmp/agent-ui',
        reportPath: '/tmp/agent-ui/report.md',
        createdAt: '2026-06-01T07:00:00.000Z',
        updatedAt: '2026-06-01T08:00:00.000Z',
        screenshots: [{
          filePath: '/tmp/agent-ui/screenshots/tab.png',
          fileName: 'tab.png',
          dataUrl: 'data:image/png;base64,dGFi'
        }]
      }
    ] as AgentWorkItem[]);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Агенты' }));

    await waitFor(() => expect(screen.getAllByText('Добавлена вкладка интерфейса').length).toBeGreaterThan(1));
    expect(screen.getByRole('img', { name: 'tab.png' })).toHaveAttribute('src', 'data:image/png;base64,dGFi');
    await user.click(screen.getByRole('button', { name: 'Открыть изображение tab.png' }));
    expect(screen.getByRole('dialog', { name: 'tab.png' })).toBeInTheDocument();
  });

  it('removes screenshot references from the agent Redmine description editor', async () => {
    const api = installBridge(connectedState());
    api.readTextFile.mockResolvedValueOnce([
      '# Добавлена вкладка интерфейса',
      '',
      '## Что было сделано',
      '- Добавлена вкладка интерфейса',
      '',
      '## Измененные файлы',
      '- `src/renderer/App.tsx`: добавлена вкладка',
      '- `src/renderer/styles.css`: обновлены стили',
      '',
      '## Скриншоты !setup-dzpro-source-id.png!',
      '- screenshots/setup-dzpro-source-id.png',
      '',
      'Источник отчёта: /tmp/agent-ui'
    ].join('\n'));
    api.listAgentWorkReports.mockResolvedValueOnce([
      {
        id: '2026-06-01-agent-ui',
        title: 'Добавлена вкладка интерфейса',
        summary: 'Агент добавил новую вкладку и проверил UI.',
        directory: '/tmp/agent-ui',
        reportPath: '/tmp/agent-ui/report.md',
        createdAt: '2026-06-01T07:00:00.000Z',
        updatedAt: '2026-06-01T08:00:00.000Z',
        screenshots: []
      }
    ] as AgentWorkItem[]);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Агенты' }));
    const description = await screen.findByLabelText('Описание задачи Redmine') as HTMLTextAreaElement;

    await waitFor(() => expect(description.value).toContain('Добавлена вкладка интерфейса'));
    expect(description.value).not.toContain('Скриншоты');
    expect(description.value).not.toContain('setup-dzpro-source-id.png');
    expect(description.value).not.toContain('Источник отчёта');
    expect(description.value).not.toContain('Измененные файлы');
    expect(description.value).not.toContain('src/renderer/App.tsx');
  });

  it('copies the agent prompt through the desktop bridge', async () => {
    const api = installBridge(connectedState());
    api.getAgentWorkPrompt.mockResolvedValueOnce('agent export prompt');
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Агенты' }));
    await user.click(screen.getByRole('button', { name: 'Скопировать промпт' }));

    await waitFor(() => expect(api.copyText).toHaveBeenCalledWith('agent export prompt'));
    expect(screen.getByText('Промпт скопирован.')).toBeInTheDocument();
  });

  it('deletes an agent work report after confirmation', async () => {
    const api = installBridge(connectedState());
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    api.listAgentWorkReports
      .mockResolvedValueOnce([
        {
          id: '2026-06-01-agent-ui',
          title: 'Добавлена вкладка интерфейса',
          summary: 'Агент добавил новую вкладку и проверил UI.',
          directory: '/tmp/agent-ui',
          reportPath: '/tmp/agent-ui/report.md',
          createdAt: '2026-06-01T07:00:00.000Z',
          updatedAt: '2026-06-01T08:00:00.000Z',
          screenshots: []
        }
      ] as AgentWorkItem[])
      .mockResolvedValueOnce([]);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Агенты' }));
    await screen.findByRole('heading', { name: 'Добавлена вкладка интерфейса' });
    await user.click(screen.getByRole('button', { name: 'Удалить результат Добавлена вкладка интерфейса' }));

    await waitFor(() => expect(api.deleteAgentWorkReport).toHaveBeenCalledWith({ reportId: '2026-06-01-agent-ui' }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(screen.getByText('Результат работы удалён.')).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('creates a testing task from an agent report with selected assignee', async () => {
    const state = connectedState();
    state.redmine.trackers = [{ id: '2', name: 'Task' }, { id: '8', name: 'QA' }];
    state.redmine.statuses = [...state.redmine.statuses, { id: '4', name: 'Тестирование' }];
    state.redmine.users = [{ id: '7', name: 'Иван' }, { id: '9', name: 'QA User' }];
    const api = installBridge(state);
    api.listAgentWorkReports.mockResolvedValueOnce([
      {
        id: '2026-06-01-agent-ui',
        title: 'Добавлена вкладка интерфейса',
        summary: 'Агент добавил новую вкладку и проверил UI.',
        directory: '/tmp/agent-ui',
        reportPath: '/tmp/agent-ui/report.md',
        createdAt: '2026-06-01T07:00:00.000Z',
        updatedAt: '2026-06-01T08:00:00.000Z',
        screenshots: []
      }
    ] as AgentWorkItem[]);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Агенты' }));
    await screen.findByRole('heading', { name: 'Добавлена вкладка интерфейса' });
    await user.click(screen.getByRole('button', { name: 'Тестирование' }));
    await user.click(screen.getByLabelText('Исполнитель'));
    await user.clear(screen.getByLabelText('Исполнитель'));
    await user.type(screen.getByLabelText('Исполнитель'), 'QA');
    await user.click(screen.getByRole('button', { name: 'QA User' }));
    await user.click(screen.getByRole('button', { name: 'Поставить на тестирование' }));

    await waitFor(() => expect(api.createRedmineIssueFromAgentWork).toHaveBeenCalledWith(expect.objectContaining({
      reportId: '2026-06-01-agent-ui',
      issueKind: 'testing',
      projectId: '1',
      sprintId: '4',
      trackerId: '8',
      priorityId: '3',
      assigneeId: '9',
      statusId: '4'
    })));
    expect(api.createRedmineIssueFromAgentWork).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'Тестирование: Добавлена вкладка интерфейса',
      description: expect.stringContaining('# AI description')
    }));
  });

  it('sends edited agent report title description and comment to Redmine', async () => {
    const api = installBridge(connectedState());
    api.listAgentWorkReports.mockResolvedValueOnce([
      {
        id: '2026-06-01-agent-ui',
        title: 'Добавлена вкладка интерфейса',
        summary: 'Агент добавил новую вкладку и проверил UI.',
        directory: '/tmp/agent-ui',
        reportPath: '/tmp/agent-ui/report.md',
        createdAt: '2026-06-01T07:00:00.000Z',
        updatedAt: '2026-06-01T08:00:00.000Z',
        screenshots: []
      }
    ] as AgentWorkItem[]);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Агенты' }));
    await screen.findByRole('heading', { name: 'Добавлена вкладка интерфейса' });
    await user.clear(screen.getByLabelText('Заголовок задачи Redmine'));
    await user.type(screen.getByLabelText('Заголовок задачи Redmine'), 'Новый заголовок');
    await user.clear(screen.getByLabelText('Описание задачи Redmine'));
    await user.type(screen.getByLabelText('Описание задачи Redmine'), 'Новое описание');
    await user.type(screen.getByLabelText('Комментарий задачи Redmine'), 'Комментарий для Redmine');
    await user.click(screen.getByRole('button', { name: 'Создать задачу' }));

    await waitFor(() => expect(api.createRedmineIssueFromAgentWork).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'Новый заголовок',
      description: 'Новое описание',
      comment: 'Комментарий для Redmine'
    })));
  });

  it('keeps result and testing assignees separate for agent reports', async () => {
    const state = connectedState();
    state.redmine.trackers = [{ id: '2', name: 'Task' }, { id: '8', name: 'QA' }];
    state.redmine.statuses = [...state.redmine.statuses, { id: '4', name: 'Тестирование' }];
    state.redmine.users = [{ id: '7', name: 'Иван' }, { id: '9', name: 'QA User' }];
    const api = installBridge(state);
    api.listAgentWorkReports.mockResolvedValueOnce([
      {
        id: '2026-06-01-agent-ui',
        title: 'Добавлена вкладка интерфейса',
        summary: 'Агент добавил новую вкладку и проверил UI.',
        directory: '/tmp/agent-ui',
        reportPath: '/tmp/agent-ui/report.md',
        createdAt: '2026-06-01T07:00:00.000Z',
        updatedAt: '2026-06-01T08:00:00.000Z',
        screenshots: []
      }
    ] as AgentWorkItem[]);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Агенты' }));
    await screen.findByRole('heading', { name: 'Добавлена вкладка интерфейса' });
    await user.click(screen.getByRole('button', { name: 'Тестирование' }));
    await user.click(screen.getByLabelText('Исполнитель'));
    await user.clear(screen.getByLabelText('Исполнитель'));
    await user.type(screen.getByLabelText('Исполнитель'), 'QA');
    await user.click(screen.getByRole('button', { name: 'QA User' }));
    await user.click(screen.getByRole('button', { name: 'Результат' }));
    await user.click(screen.getByRole('button', { name: 'Создать задачу' }));

    await waitFor(() => expect(api.createRedmineIssueFromAgentWork).toHaveBeenCalledWith(expect.objectContaining({
      reportId: '2026-06-01-agent-ui',
      issueKind: 'result',
      trackerId: '2',
      assigneeId: '7'
    })));
  });

  it('opens Telegram message links in the internal browser', async () => {
    const state = connectedState();
    state.telegram.messages[0].text = 'Документ https://example.com/spec';
    const api = installBridge(state);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('heading', { name: 'Backend Team' });
    await user.click(await screen.findByRole('button', { name: 'https://example.com/spec' }));

    await screen.findByRole('button', { name: 'Браузер' });
    await waitFor(() =>
      expect(api.showBrowserView).toHaveBeenCalledWith(expect.objectContaining({
        url: 'https://example.com/spec'
      }))
    );
  });

  it('opens GitLab in the embedded browser tab', async () => {
    const api = installBridge(connectedState());
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Открыть GitLab' }));

    await waitFor(() =>
      expect(api.showBrowserView).toHaveBeenCalledWith(expect.objectContaining({
        url: 'https://gitlab.example.com/'
      }))
    );
  });

  it('shows mail connection settings when the embedded mail page fails', async () => {
    const api = installBridge(connectedState());
    vi.mocked(api.showMailView).mockResolvedValueOnce({
      canGoBack: false,
      loading: false,
      url: 'https://mail.example.com/',
      error: "ERR_CONNECTION_RESET (-101) loading 'https://mail.example.com/'"
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Почта' }));
    await screen.findByRole('heading', { name: 'Почта не открылась' });

    await user.clear(screen.getByLabelText('Ссылка почты'));
    await user.type(screen.getByLabelText('Ссылка почты'), 'https://mail.gt-sot.ru/');
    await user.type(screen.getByLabelText('Логин'), 'mail-user');
    await user.type(screen.getByLabelText('Пароль'), 'mail-password');
    await user.click(screen.getByRole('button', { name: 'Сохранить и открыть почту' }));

    await waitFor(() =>
      expect(api.saveMailCredentials).toHaveBeenCalledWith({
        url: 'https://mail.gt-sot.ru/',
        username: 'mail-user',
        password: 'mail-password'
      })
    );
    await waitFor(() => expect(api.showMailView).toHaveBeenCalledTimes(2));
  });

  it('shows Telemost actions and invites Katya from a message link', async () => {
    const state = connectedState();
    state.telegram.messages[0].text = 'https://telemost.yandex.ru/j/00000000000001';
    const api = installBridge(state);
    vi.mocked(api.getKatyaSession).mockResolvedValue('callrec_session=fake-test-session');
    window.localStorage.setItem(katyaAccessGroupStorageKey, 'group-access-1');
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('heading', { name: 'Backend Team' });
    expect(await screen.findByRole('button', { name: 'Открыть встречу' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Удалить Катю' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Пригласить Катю' }));

    await waitFor(() =>
      expect(api.createKatyaMeeting).toHaveBeenCalledWith(expect.objectContaining({
        groupId: 'group-access-1',
        url: 'https://telemost.yandex.ru/j/00000000000001'
      }))
    );
  });

  it('keeps selected project and loads its sprints in settings', async () => {
    const api = installBridge(connectedState());
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('heading', { name: 'Backend Team' });
    await user.click(screen.getByRole('button', { name: 'Настройки' }));
    await user.click(screen.getByRole('button', { name: 'Defaults' }));
    await screen.findByRole('heading', { name: 'Проект, tracker, priority, спринт и исполнитель по умолчанию' });
    await user.selectOptions(screen.getByLabelText('Проект'), '5');

    await waitFor(() =>
      expect(api.loadRedmineProjectUsers).toHaveBeenCalledWith({ projectId: '5' })
    );
    await waitFor(() =>
      expect((screen.getByLabelText('Проект') as HTMLSelectElement).value).toBe('5')
    );
    await waitFor(() =>
      expect((screen.getByLabelText('Спринт') as HTMLSelectElement).value).toBe('8')
    );
    expect(screen.getByRole('option', { name: 'Mobile Sprint' })).toBeInTheDocument();
  });

  it('switches the active Redmine project from the sidebar', async () => {
    const api = installBridge(connectedState());
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('heading', { name: 'Backend Team' });
    await user.selectOptions(screen.getByLabelText('Активный проект'), '5');

    await waitFor(() =>
      expect(api.selectRedmineProject).toHaveBeenCalledWith({ projectId: '5' })
    );
    await waitFor(() =>
      expect((screen.getByLabelText('Активный проект') as HTMLSelectElement).value).toBe('5')
    );
  });

  it('shows the My Tasks tab and loads assigned Redmine issues for the selected sprint', async () => {
    const api = installBridge(connectedState());
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Мои задачи' }));

    await waitFor(() =>
      expect(api.loadRedmineMyIssues).toHaveBeenCalledWith({ projectId: '1', sprintId: '4', assigneeId: '7' })
    );
    expect(await screen.findByRole('heading', { name: '#123 - Проверить обработку спринта' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Новые' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'В работе' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'На проверке' })).toBeInTheDocument();
    expect(screen.getByText('02.06.2026')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Открыть карточку задачи #123 в приложении' }));

    await waitFor(() =>
      expect(api.loadRedmineIssueDetails).toHaveBeenCalledWith({ issueId: '123' })
    );
    expect(await screen.findByRole('complementary', { name: 'Задача #123' })).toBeInTheDocument();
    expect(screen.getByText('Полное описание')).toBeInTheDocument();
    expect(screen.queryByText(/<strong>/)).not.toBeInTheDocument();
    expect(screen.getByText('Комментарий')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'screenshot.png' })).toHaveAttribute(
      'src',
      'data:image/png;base64,c2NyZWVuc2hvdA=='
    );
    await user.click(screen.getByRole('button', { name: 'Открыть изображение screenshot.png' }));
    expect(screen.getByRole('dialog', { name: 'screenshot.png' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Закрыть изображение' }));
    expect(api.openExternal).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Редактировать комментарий #1' }));
    await user.clear(screen.getByLabelText('Комментарий'));
    await user.type(screen.getByLabelText('Комментарий'), '<p><strong>Обновленный комментарий</strong></p>');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() =>
      expect(api.updateRedmineIssueJournal).toHaveBeenCalledWith({
        issueId: '123',
        journalId: '1',
        notes: '<p><strong>Обновленный комментарий</strong></p>'
      })
    );
    expect(await screen.findByText('Обновленный комментарий')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Редактировать название задачи #123' }));
    await user.clear(screen.getByLabelText('Название'));
    await user.type(screen.getByLabelText('Название'), 'Обновленная задача');
    await user.clear(screen.getByLabelText('Описание'));
    await user.type(screen.getByLabelText('Описание'), '<p><strong>Новое описание</strong></p>');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() =>
      expect(api.updateRedmineIssueDetails).toHaveBeenCalledWith({
        issueId: '123',
        subject: 'Обновленная задача',
        description: '<p><strong>Новое описание</strong></p>'
      })
    );
    expect(await screen.findByText('Новое описание')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Новый комментарий'), '<p><strong>Готово</strong></p>');
    await user.click(screen.getByRole('button', { name: 'Добавить комментарий' }));

    await waitFor(() =>
      expect(api.addRedmineIssueComment).toHaveBeenCalledWith({
        issueId: '123',
        notes: '<p><strong>Готово</strong></p>'
      })
    );
    expect(await screen.findByText('Готово')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Redmine' }));

    expect(api.openExternal).toHaveBeenCalledWith('https://redmine.example.com/issues/123');
    vi.mocked(api.openExternal).mockClear();

    await user.click(screen.getByRole('button', { name: 'Открыть задачу #123 в приложении' }));

    expect(api.loadRedmineIssueDetails).toHaveBeenCalledWith({ issueId: '123' });

    await user.click(screen.getByRole('button', { name: 'Оформить задачу #123 через AI' }));

    await waitFor(() =>
      expect(api.formatRedmineIssueWithAi).toHaveBeenCalledWith({
        issue: {
          id: '123',
          subject: 'Обновленная задача',
          tracker: 'Task',
          statusId: '2',
          status: 'In Progress',
          priority: 'Normal',
          assignee: 'Иван',
          dueDate: '2026-06-02',
          updatedOn: '2026-05-29T10:00:00.000Z',
          url: 'https://redmine.example.com/issues/123'
        },
        projectId: '1',
        projectName: 'Team Space',
        sprintId: '4',
        sprintName: 'Sprint 42',
        columnName: 'В работе'
      })
    );
    expect(await screen.findByText(/AI-описание задачи #123 сохранено/)).toBeInTheDocument();
  });

  it('renders plain Redmine descriptions with Markdown sections and lists', async () => {
    const api = installBridge(connectedState());
    api.loadRedmineIssueDetails.mockResolvedValue({
      issue: {
        id: 123,
        subject: 'Проверить обработку спринта',
        description: [
          'Контекст:',
          '- Алексей написал сообщение: «Как дела?»',
          '- В переписке нет описания проблемы.',
          '',
          'Что нужно сделать:',
          '- Уточнить у Алексея суть обращения.',
          '- После уточнения сформулировать задачу.'
        ].join('\n'),
        project: { id: 1, name: 'Team Space' },
        tracker: { id: 2, name: 'Task' },
        status: { id: 2, name: 'In Progress' },
        priority: { id: 3, name: 'Normal' },
        assigned_to: { id: 7, name: 'Иван' },
        fixed_version: { id: 4, name: 'Sprint 42' },
        updated_on: '2026-05-28T08:30:00.000Z',
        journals: []
      }
    });
    const user = userEvent.setup();
    const { container } = render(<App />);
    const view = within(container);

    await user.click(await view.findByRole('button', { name: 'Мои задачи' }));
    await view.findByRole('heading', { name: '#123 - Проверить обработку спринта' });
    await user.click(view.getByRole('button', { name: 'Открыть карточку задачи #123 в приложении' }));
    await waitFor(() =>
      expect(api.loadRedmineIssueDetails).toHaveBeenCalledWith({ issueId: '123' })
    );

    expect(await view.findByText('Контекст:')).toBeInTheDocument();
    expect(view.getByText('Алексей написал сообщение: «Как дела?»')).toBeInTheDocument();
    expect(view.getByText('Уточнить у Алексея суть обращения.')).toBeInTheDocument();
    expect(container.querySelectorAll('.my-task-rich-text ul')).toHaveLength(2);
  });

  it('deletes an opened Redmine issue from My Tasks after confirmation', async () => {
    const api = installBridge(connectedState());
    const confirmMock = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Мои задачи' }));
    await screen.findByRole('heading', { name: '#123 - Проверить обработку спринта' });
    await user.click(screen.getByRole('button', { name: 'Открыть карточку задачи #123 в приложении' }));
    await screen.findByRole('complementary', { name: 'Задача #123' });

    await user.click(screen.getByRole('button', { name: 'Удалить задачу' }));

    await waitFor(() =>
      expect(api.deleteRedmineIssue).toHaveBeenCalledWith({
        issueId: '123',
        projectId: '1',
        sprintId: '4',
        cacheAssigneeId: '7'
      })
    );
    expect(confirmMock).toHaveBeenCalledWith('Удалить задачу #123?');
    expect(screen.queryByRole('complementary', { name: 'Задача #123' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '#123 - Проверить обработку спринта' })).not.toBeInTheDocument();
    confirmMock.mockRestore();
  });

  it('starts an agent from an opened Redmine issue with selected folder and extra prompt', async () => {
    const api = installBridge(connectedState());
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Мои задачи' }));
    await screen.findByRole('heading', { name: '#123 - Проверить обработку спринта' });
    await user.click(screen.getByRole('button', { name: 'Открыть карточку задачи #123 в приложении' }));
    await screen.findByRole('complementary', { name: 'Задача #123' });

    await user.click(screen.getByRole('button', { name: 'Запустить агента' }));
    const dialog = screen.getByRole('dialog', { name: 'Запуск агента' });
    await user.click(within(dialog).getByRole('button', { name: 'Выбрать' }));
    await user.type(within(dialog).getByLabelText('Дополнительный промпт'), 'Проверь сортировку пользователей.');
    await user.click(within(dialog).getByRole('button', { name: 'Запустить агента' }));

    await waitFor(() =>
      expect(api.runAgentForRedmineIssue).toHaveBeenCalledWith({
        workingDirectory: '/tmp/project',
        prompt: 'Проверь сортировку пользователей.',
        issue: expect.objectContaining({
          projectId: '1',
          projectName: 'Team Space',
          sprintId: '4',
          sprintName: 'Sprint 42',
          columnName: 'В работе',
          issue: expect.objectContaining({
            id: '123',
            subject: 'Проверить обработку спринта',
            tracker: 'Task',
            status: 'In Progress',
            assignee: 'Иван'
          })
        })
      })
    );
    expect(await screen.findByText(/Агент по задаче #123 запущен/)).toBeInTheDocument();
  });

  it('prepares a selected GitLab project before starting the issue agent', async () => {
    const state = connectedState();
    state.gitlab = {
      ...state.gitlab,
      status: 'connected',
      hasToken: true,
      selectedProjectIds: ['101', '202'],
      projects: [
        {
          id: '101',
          name: 'workspace',
          pathWithNamespace: 'example/workspace',
          webUrl: 'https://gitlab.example.com/example/workspace',
          defaultBranch: 'main',
          lastActivityAt: '2026-05-28T08:00:00.000Z',
          sshUrlToRepo: 'git@gitlab.example.com:example/workspace.git',
          httpUrlToRepo: 'https://gitlab.example.com/example/workspace.git'
        },
        {
          id: '202',
          name: 'eam-engine',
          pathWithNamespace: 'example/backend/service',
          webUrl: 'https://gitlab.example.com/example/backend/service',
          defaultBranch: 'master',
          lastActivityAt: '2026-05-28T09:00:00.000Z',
          sshUrlToRepo: 'git@gitlab.example.com:example/backend/service.git',
          httpUrlToRepo: 'https://gitlab.example.com/example/backend/service.git'
        }
      ]
    };
    const api = installBridge(state);
    api.prepareGitLabProjectWorkspace.mockResolvedValueOnce({
      projectId: '202',
      projectName: 'example/backend/service',
      workingDirectory: '/tmp/team-space-projects/example/backend/service',
      action: 'pulled'
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Мои задачи' }));
    await screen.findByRole('heading', { name: '#123 - Проверить обработку спринта' });
    await user.click(screen.getByRole('button', { name: 'Открыть карточку задачи #123 в приложении' }));
    await screen.findByRole('complementary', { name: 'Задача #123' });

    await user.click(screen.getByRole('button', { name: 'Запустить агента' }));
    const dialog = screen.getByRole('dialog', { name: 'Запуск агента' });
    const gitlabSourceInput = within(dialog).getByLabelText('Исходный код GitLab');
    expect(gitlabSourceInput).toHaveValue('example/workspace');
    await waitFor(() =>
      expect(within(dialog).getByLabelText('Рабочая папка')).toHaveValue('/tmp/team-space-projects/example/workspace')
    );
    await user.clear(gitlabSourceInput);
    await user.type(gitlabSourceInput, 'engine');
    await user.click(await within(dialog).findByRole('button', { name: /example\/backend\/service/ }));
    await waitFor(() =>
      expect(within(dialog).getByLabelText('Рабочая папка')).toHaveValue('/tmp/team-space-projects/example/backend/service')
    );
    await user.click(within(dialog).getByRole('button', { name: 'Запустить агента' }));

    await waitFor(() =>
      expect(api.getGitLabProjectWorkspacePath).toHaveBeenCalledWith({ projectId: '202' })
    );
    await waitFor(() =>
      expect(api.prepareGitLabProjectWorkspace).toHaveBeenCalledWith({ projectId: '202' })
    );
    await waitFor(() =>
      expect(api.runAgentForRedmineIssue).toHaveBeenCalledWith(expect.objectContaining({
        workingDirectory: '/tmp/team-space-projects/example/backend/service'
      }))
    );
  });

  it('shows Katya meeting recordings with transcript and protocol inside Meetings', async () => {
    const api = installBridge(connectedState());
    api.getKatyaSession.mockResolvedValue('test-session');
    const user = userEvent.setup();
    const { container } = render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Встречи' }));
    await user.click(screen.getByRole('tab', { name: 'Записи' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Обновить' })).not.toBeDisabled());
    expect(screen.queryByPlaceholderText('callrec_session=...')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Обновить' }));

    await waitFor(() =>
      expect(api.listKatyaMeetings).toHaveBeenCalledWith({
        baseUrl: 'http://localhost:8077',
        sessionCookie: 'test-session',
        page: 1,
        pageSize: 20
      })
    );
    await waitFor(() =>
      expect(api.getKatyaMeeting).toHaveBeenCalledWith({
        baseUrl: 'http://localhost:8077',
        sessionCookie: 'test-session',
        meetingId: 'katya_meeting_1'
      })
    );
    expect(await screen.findByRole('heading', { name: 'Проверка шизы 3' })).toBeInTheDocument();
    expect(screen.getByText('Катюха, привет.')).toBeInTheDocument();
    expect(container.querySelector('.meeting-video')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Скрыть видео' }));

    expect(container.querySelector('.meeting-video')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Видео' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Протокол' }));

    expect(await screen.findByText(/Техническая проверка записи/)).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Анализ' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Выбрать для анализа: Проверка шизы 3' }));
    await user.click(screen.getByRole('button', { name: 'Проанализировать (1)' }));
    const analysisDialog = screen.getByRole('dialog', { name: 'Настройка анализа встреч' });
    expect(within(analysisDialog).getByLabelText('Шаблон')).toHaveValue('daily');
    await user.click(within(analysisDialog).getByRole('button', { name: 'Запустить анализ' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Настройка анализа встреч' })).not.toBeInTheDocument()
    );

    await waitFor(() =>
      expect(api.analyzeKatyaDailies).toHaveBeenCalledWith({
        baseUrl: 'http://localhost:8077',
        sessionCookie: 'test-session',
        meetingIds: ['katya_meeting_1'],
        analysisPrompt: expect.stringContaining('Проанализируй встречи как дэйлики команды.')
      })
    );
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { name: 'Анализ дэйликов' }).length).toBeGreaterThan(0)
    );
    expect(screen.getAllByText('Анализ дэйликов').length).toBeGreaterThan(0);
    expect(screen.getByText(/проверить одновременную запись/)).toBeInTheDocument();
  });

  it('shows a readable Katya service error when recordings cannot be loaded', async () => {
    const api = installBridge(connectedState());
    api.getKatyaSession.mockResolvedValue('test-session');
    api.listKatyaMeetings.mockRejectedValue(new Error(
      "Error invoking remote method 'katya:list-meetings': TypeError: fetch failed"
    ));
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Встречи' }));
    await user.click(screen.getByRole('tab', { name: 'Записи' }));

    expect(await screen.findByText(/Сервис Кати недоступен/)).toBeInTheDocument();
    expect(screen.queryByText(/Error invoking remote method/)).not.toBeInTheDocument();
  });

  it('passes access group when inviting Katya from Meetings', async () => {
    const api = installBridge(connectedState());
    api.getKatyaSession.mockResolvedValue('test-session');
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Встречи' }));
    await waitFor(() =>
      expect(api.listKatyaGroups).toHaveBeenCalledWith({
        baseUrl: 'http://localhost:8077',
        sessionCookie: 'test-session'
      })
    );
    await user.selectOptions(screen.getByLabelText('Группа доступа'), 'group-access-2');
    await user.click(screen.getByRole('button', { name: 'Пригласить Катю' }));

    await waitFor(() =>
      expect(api.createKatyaMeeting).toHaveBeenCalledWith(expect.objectContaining({
        baseUrl: 'http://localhost:8077',
        groupId: 'group-access-2',
        sessionCookie: 'test-session',
        title: 'Созвон',
        url: 'https://telemost.yandex.ru/j/00000000000000'
      }))
    );
    expect(await screen.findByText('https://telemost.yandex.ru/j/00000000000000')).toBeInTheDocument();
  });

  it('saves Telemost links in Meetings and restores them from the list', async () => {
    installBridge(connectedState());
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Встречи' }));
    await user.clear(screen.getByLabelText('Название созвона'));
    await user.type(screen.getByLabelText('Название созвона'), 'Планирование релиза');
    const telemostInput = screen.getByLabelText('Ссылка Телемоста');
    await user.clear(telemostInput);
    await user.type(telemostInput, 'https://telemost.yandex.ru/j/12345678901234');
    await user.click(screen.getByRole('button', { name: 'Сохранить встречу' }));

    await screen.findByText('Планирование релиза');
    await screen.findByText('https://telemost.yandex.ru/j/12345678901234');
    expect(screen.getByText('Ссылка на встречу сохранена.')).toBeInTheDocument();

    await user.clear(telemostInput);
    await user.type(telemostInput, 'https://telemost.yandex.ru/j/00000000000000');
    await user.click(screen.getByText('https://telemost.yandex.ru/j/12345678901234'));

    expect(telemostInput).toHaveValue('https://telemost.yandex.ru/j/12345678901234');
  });

  it('passes a custom meeting analysis prompt from the setup dialog', async () => {
    const api = installBridge(connectedState());
    api.getKatyaSession.mockResolvedValue('test-session');
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Встречи' }));
    await user.click(screen.getByRole('tab', { name: 'Записи' }));
    await screen.findByRole('heading', { name: 'Проверка шизы 3' });
    await user.click(screen.getByRole('checkbox', { name: 'Выбрать для анализа: Проверка шизы 3' }));
    await user.click(screen.getByRole('button', { name: 'Проанализировать (1)' }));

    const dialog = screen.getByRole('dialog', { name: 'Настройка анализа встреч' });
    await user.clear(within(dialog).getByLabelText('Какой анализ провести'));
    await user.type(within(dialog).getByLabelText('Какой анализ провести'), 'Найди только риски по релизу.');
    expect(within(dialog).getByLabelText('Шаблон')).toHaveValue('custom');
    await user.click(within(dialog).getByRole('button', { name: 'Запустить анализ' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Настройка анализа встреч' })).not.toBeInTheDocument()
    );

    await waitFor(() =>
      expect(api.analyzeKatyaDailies).toHaveBeenCalledWith(expect.objectContaining({
        analysisPrompt: 'Найди только риски по релизу.'
      }))
    );
  });

  it('opens saved Katya daily analyses without generating a new one', async () => {
    const api = installBridge(connectedState());
    api.getKatyaSession.mockResolvedValue('test-session');
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Встречи' }));
    await user.click(screen.getByRole('tab', { name: 'Анализы' }));
    await waitFor(() => expect(api.listKatyaDailyAnalyses).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: /Анализ дэйликов/ })).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /Анализ дэйликов/ }));

    expect(api.analyzeKatyaDailies).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { name: 'Анализ дэйликов' }).length).toBeGreaterThan(0)
    );
    expect(screen.getByText(/Сохраненный анализ открыт без новой генерации/)).toBeInTheDocument();
    expect(screen.getAllByText(/12 встреч/).length).toBeGreaterThan(0);
  });

  it('saves Katya URL and session only from Settings', async () => {
    const api = installBridge(connectedState());
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Настройки' }));
    await user.click(screen.getByRole('button', { name: 'Катя' }));
    await user.clear(await screen.findByLabelText('URL сервиса Кати'));
    await user.type(screen.getByLabelText('URL сервиса Кати'), 'https://katya.example.com/');
    await user.type(screen.getByLabelText('callrec_session'), 'settings-session');
    await user.click(screen.getByRole('button', { name: 'Сохранить настройки' }));

    await waitFor(() =>
      expect(api.saveKatyaSettings).toHaveBeenCalledWith({
        baseUrl: 'https://katya.example.com/',
        sessionCookie: 'settings-session'
      })
    );
    expect(await screen.findByText('Настройки Кати сохранены.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Группа доступа')).not.toBeInTheDocument();
  });

  it('separates Telegram forum topics inside a selected chat', async () => {
    const state = connectedState();
    state.telegram.chats = state.telegram.chats.map((chat) => ({
      ...chat,
      title: 'ГТС',
      hasTopics: true
    }));
    state.telegram.topics = [
      {
        id: 'chat_1:topic:101',
        chatId: 'chat_1',
        title: 'Флуд',
        topMessageId: '101',
        unreadCount: 1,
        lastMessageAt: '2026-05-27T10:05:00.000Z'
      },
      {
        id: 'chat_1:topic:102',
        chatId: 'chat_1',
        title: 'AI',
        topMessageId: '102',
        unreadCount: 0,
        lastMessageAt: '2026-05-27T10:00:00.000Z'
      }
    ];
    state.telegram.messages = [
      {
        id: 'chat_1:201',
        chatId: 'chat_1',
        topicId: 'chat_1:topic:101',
        senderId: 'user_1',
        senderName: 'Анна',
        senderAvatar: null,
        sentAt: '2026-05-27T10:05:00.000Z',
        text: 'Сообщение из флуда',
        status: 'new',
        createdAt: '2026-05-27T10:05:00.000Z',
        updatedAt: '2026-05-27T10:05:00.000Z'
      },
      {
        id: 'chat_1:202',
        chatId: 'chat_1',
        topicId: 'chat_1:topic:102',
        senderId: 'user_1',
        senderName: 'Анна',
        senderAvatar: null,
        sentAt: '2026-05-27T10:00:00.000Z',
        text: 'Сообщение из AI',
        status: 'new',
        createdAt: '2026-05-27T10:00:00.000Z',
        updatedAt: '2026-05-27T10:00:00.000Z'
      }
    ];
    const api = installBridge(state);
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole('button', { name: /Флуд/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Сообщение из AI')).not.toBeInTheDocument());
    expect(await screen.findByText('Сообщение из флуда')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /AI/ }));

    await waitFor(() =>
      expect(api.getTelegramThread).toHaveBeenCalledWith({
        chatId: 'chat_1',
        topicId: 'chat_1:topic:102',
        limit: 50
      })
    );
    expect(await screen.findByText('Сообщение из AI')).toBeInTheDocument();
  });

  it('reloads a Telegram topic when reopening it after another topic was active', async () => {
    const state = connectedState();
    state.telegram.chats = state.telegram.chats.map((chat) => ({
      ...chat,
      title: 'ГТС',
      hasTopics: true
    }));
    state.telegram.topics = [
      {
        id: 'chat_1:topic:101',
        chatId: 'chat_1',
        title: 'Флуд',
        topMessageId: '101',
        unreadCount: 1,
        lastMessageAt: '2026-05-27T10:05:00.000Z'
      },
      {
        id: 'chat_1:topic:102',
        chatId: 'chat_1',
        title: 'AI',
        topMessageId: '102',
        unreadCount: 0,
        lastMessageAt: '2026-05-27T10:00:00.000Z'
      }
    ];
    state.telegram.messages = [
      {
        id: 'chat_1:201',
        chatId: 'chat_1',
        topicId: 'chat_1:topic:101',
        senderId: 'user_1',
        senderName: 'Анна',
        senderAvatar: null,
        sentAt: '2026-05-27T10:05:00.000Z',
        text: 'Повторно открытый флуд',
        status: 'new',
        createdAt: '2026-05-27T10:05:00.000Z',
        updatedAt: '2026-05-27T10:05:00.000Z'
      },
      {
        id: 'chat_1:202',
        chatId: 'chat_1',
        topicId: 'chat_1:topic:102',
        senderId: 'user_1',
        senderName: 'Анна',
        senderAvatar: null,
        sentAt: '2026-05-27T10:00:00.000Z',
        text: 'Активный AI топик',
        status: 'new',
        createdAt: '2026-05-27T10:00:00.000Z',
        updatedAt: '2026-05-27T10:00:00.000Z'
      }
    ];
    const api = installBridge(state);
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText('Повторно открытый флуд')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /AI/ }));
    expect(await screen.findByText('Активный AI топик')).toBeInTheDocument();

    api.getTelegramThread.mockClear();
    await user.click(screen.getByRole('button', { name: /Флуд/ }));

    await waitFor(() =>
      expect(api.getTelegramThread).toHaveBeenCalledWith({
        chatId: 'chat_1',
        topicId: 'chat_1:topic:101',
        limit: 50
      })
    );
    expect(await screen.findByText('Повторно открытый флуд')).toBeInTheDocument();
  });

  it('creates a Redmine issue from a My Tasks column', async () => {
    const api = installBridge(connectedState());
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Мои задачи' }));
    await screen.findByRole('heading', { name: '#123 - Проверить обработку спринта' });
    await user.click(screen.getByRole('button', { name: 'Добавить задачу в колонку Новые' }));
    await user.type(screen.getByLabelText('Название задачи для колонки Новые'), 'Новая карточка');
    await user.type(screen.getByLabelText('Описание задачи для колонки Новые'), 'Описание новой карточки');
    await user.click(screen.getByRole('button', { name: 'Добавить' }));

    await waitFor(() =>
      expect(api.createRedmineIssue).toHaveBeenCalledWith({
        projectId: '1',
        sprintId: '4',
        subject: 'Новая карточка',
        description: 'Описание новой карточки',
        trackerId: '2',
        tracker: 'Task',
        priorityId: '3',
        priority: 'Normal',
        assigneeId: '7',
        assignee: 'Иван',
        statusId: '1',
        status: 'New'
      })
    );
    expect(await screen.findByText('#124 - Новая карточка')).toBeInTheDocument();
  });

  it('does not treat an Assigned status as In Progress when Redmine statuses are unavailable', async () => {
    const state = connectedState();
    state.redmine = {
      ...state.redmine,
      statuses: []
    };
    const api = installBridge(state);
    api.loadRedmineMyIssues.mockResolvedValueOnce({
      issues: [
        {
          id: '15721',
          subject: 'Доработать Дозор',
          tracker: 'Task',
          statusId: '2',
          status: 'Назначено',
          priority: 'Normal',
          assignee: 'Иван',
          dueDate: '2026-05-29',
          updatedOn: '2026-05-29T08:30:00.000Z',
          url: 'https://redmine.example.com/issues/15721'
        }
      ],
      source: 'redmine',
      syncedAt: '2026-05-29T08:30:00.000Z'
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Мои задачи' }));
    await screen.findByRole('heading', { name: '#15721 - Доработать Дозор' });
    await user.click(screen.getByRole('button', { name: 'Добавить задачу в колонку В работе' }));
    await user.type(screen.getByLabelText('Название задачи для колонки В работе'), 'Новая рабочая карточка');
    await user.click(screen.getByRole('button', { name: 'Добавить' }));

    expect(await screen.findByText('В Redmine не найден статус для выбранной колонки.')).toBeInTheDocument();
    expect(api.createRedmineIssue).not.toHaveBeenCalled();
  });

  it('keeps cached My Tasks visible while background sync is running', async () => {
    const api = installBridge(connectedState());
    let resolveSync: (value: RedmineIssueListResponse) => void = () => undefined;
    api.loadRedmineMyIssues.mockResolvedValueOnce({
      issues: [
        {
          id: '123',
          subject: 'Cached task',
          tracker: 'Task',
          statusId: '1',
          status: 'New',
          priority: 'Normal',
          assignee: 'Иван',
          dueDate: '2026-06-02',
          updatedOn: '2026-05-28T08:30:00.000Z',
          url: 'https://redmine.example.com/issues/123'
        }
      ],
      source: 'cache',
      syncedAt: '2026-05-28T08:00:00.000Z'
    });
    api.syncRedmineMyIssues.mockReturnValueOnce(new Promise((resolve) => {
      resolveSync = resolve;
    }));
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Мои задачи' }));

    expect(await screen.findByText('#123 - Cached task')).toBeInTheDocument();
    expect(screen.getByText('Синхронизация...')).toBeInTheDocument();
    expect(api.syncRedmineMyIssues).toHaveBeenCalledWith({ projectId: '1', sprintId: '4', assigneeId: '7' });

    resolveSync({
      issues: [
        {
          id: '123',
          subject: 'Fresh task',
          tracker: 'Task',
          statusId: '2',
          status: 'In Progress',
          priority: 'Normal',
          assignee: 'Иван',
          dueDate: '2026-06-02',
          updatedOn: '2026-05-28T09:00:00.000Z',
          url: 'https://redmine.example.com/issues/123'
        }
      ],
      source: 'redmine',
      syncedAt: '2026-05-28T09:00:00.000Z'
    });

    expect(await screen.findByText('#123 - Fresh task')).toBeInTheDocument();
  });

  it('preserves visible My Tasks order when background sync returns reordered issues', async () => {
    const api = installBridge(connectedState());
    api.loadRedmineMyIssues.mockResolvedValueOnce({
      issues: [
        {
          id: '101',
          subject: 'First cached task',
          tracker: 'Task',
          statusId: '1',
          status: 'New',
          priority: 'Normal',
          assignee: 'Иван',
          dueDate: '2026-06-02',
          updatedOn: '2026-05-28T08:30:00.000Z',
          url: 'https://redmine.example.com/issues/101'
        },
        {
          id: '102',
          subject: 'Second cached task',
          tracker: 'Task',
          statusId: '1',
          status: 'New',
          priority: 'Normal',
          assignee: 'Иван',
          dueDate: '2026-06-02',
          updatedOn: '2026-05-28T08:00:00.000Z',
          url: 'https://redmine.example.com/issues/102'
        }
      ],
      source: 'cache',
      syncedAt: '2026-05-28T08:00:00.000Z'
    });
    api.syncRedmineMyIssues.mockResolvedValueOnce({
      issues: [
        {
          id: '102',
          subject: 'Second fresh task',
          tracker: 'Task',
          statusId: '1',
          status: 'New',
          priority: 'Normal',
          assignee: 'Иван',
          dueDate: '2026-06-02',
          updatedOn: '2026-05-28T09:30:00.000Z',
          url: 'https://redmine.example.com/issues/102'
        },
        {
          id: '101',
          subject: 'First fresh task',
          tracker: 'Task',
          statusId: '1',
          status: 'New',
          priority: 'Normal',
          assignee: 'Иван',
          dueDate: '2026-06-02',
          updatedOn: '2026-05-28T09:00:00.000Z',
          url: 'https://redmine.example.com/issues/101'
        },
        {
          id: '103',
          subject: 'New synced task',
          tracker: 'Task',
          statusId: '1',
          status: 'New',
          priority: 'Normal',
          assignee: 'Иван',
          dueDate: '2026-06-02',
          updatedOn: '2026-05-28T09:45:00.000Z',
          url: 'https://redmine.example.com/issues/103'
        }
      ],
      source: 'redmine',
      syncedAt: '2026-05-28T09:45:00.000Z'
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Мои задачи' }));

    const first = await screen.findByText('#101 - First fresh task');
    const second = screen.getByText('#102 - Second fresh task');
    const added = screen.getByText('#103 - New synced task');

    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(second.compareDocumentPosition(added) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows sync warnings without clearing cached My Tasks', async () => {
    const api = installBridge(connectedState());
    api.loadRedmineMyIssues.mockResolvedValueOnce({
      issues: [
        {
          id: '123',
          subject: 'Cached task',
          tracker: 'Task',
          statusId: '1',
          status: 'New',
          priority: 'Normal',
          assignee: 'Иван',
          dueDate: '2026-06-02',
          updatedOn: '2026-05-28T08:30:00.000Z',
          url: 'https://redmine.example.com/issues/123'
        }
      ],
      source: 'cache',
      syncedAt: '2026-05-28T08:00:00.000Z'
    });
    api.syncRedmineMyIssues.mockResolvedValueOnce({
      issues: [
        {
          id: '123',
          subject: 'Cached task',
          tracker: 'Task',
          statusId: '1',
          status: 'New',
          priority: 'Normal',
          assignee: 'Иван',
          dueDate: '2026-06-02',
          updatedOn: '2026-05-28T08:30:00.000Z',
          url: 'https://redmine.example.com/issues/123'
        }
      ],
      source: 'cache',
      syncedAt: '2026-05-28T08:00:00.000Z',
      error: 'Redmine 503: Unavailable'
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Мои задачи' }));

    expect(await screen.findByText('Redmine 503: Unavailable')).toBeInTheDocument();
    expect(screen.getByText('#123 - Cached task')).toBeInTheDocument();
  });

  it('reloads My Tasks when another sprint is selected', async () => {
    const state = connectedState();
    state.redmine.sprints = [
      { id: '4', name: 'Sprint 42' },
      { id: '6', name: 'Sprint 43' }
    ];
    const api = installBridge(state);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Мои задачи' }));
    await waitFor(() =>
      expect(api.loadRedmineMyIssues).toHaveBeenCalledWith({ projectId: '1', sprintId: '4', assigneeId: '7' })
    );

    await user.selectOptions(screen.getByLabelText('Спринт'), '6');

    await waitFor(() =>
      expect(api.loadRedmineMyIssues).toHaveBeenCalledWith({ projectId: '1', sprintId: '6', assigneeId: '7' })
    );
  });

  it('changes a Redmine issue sprint from the opened My Tasks detail panel', async () => {
    const state = connectedState();
    state.redmine.sprints = [
      { id: '4', name: 'Sprint 42' },
      { id: '6', name: 'Sprint 43' }
    ];
    const api = installBridge(state);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Мои задачи' }));
    await screen.findByRole('heading', { name: '#123 - Проверить обработку спринта' });
    await user.click(screen.getByRole('button', { name: 'Открыть карточку задачи #123 в приложении' }));
    await screen.findByRole('complementary', { name: 'Задача #123' });

    await user.click(screen.getByRole('button', { name: 'Изменить спринт задачи #123' }));
    await user.selectOptions(screen.getByLabelText('Новый спринт'), '6');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() =>
      expect(api.updateRedmineIssueSprint).toHaveBeenCalledWith({
        issueId: '123',
        sprintId: '6',
        projectId: '1',
        previousSprintId: '4',
        cacheAssigneeId: '7'
      })
    );
    expect(screen.queryByRole('complementary', { name: 'Задача #123' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '#123 - Проверить обработку спринта' })).not.toBeInTheDocument();
  });

  it('syncs sprint catalog from My Tasks toolbar', async () => {
    const api = installBridge(connectedState());
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Мои задачи' }));
    await user.click(await screen.findByRole('button', { name: 'Синхронизировать спринты' }));

    await waitFor(() =>
      expect(api.loadRedmineProjectUsers).toHaveBeenCalledWith({ projectId: '1' })
    );
  });

  it('changes a Redmine issue status when a My Tasks card is dropped into another column', async () => {
    const api = installBridge(connectedState());
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Мои задачи' }));
    const cardTitle = await screen.findByRole('heading', { name: '#123 - Проверить обработку спринта' });
    const card = cardTitle.closest('article');
    const reviewColumn = screen.getByLabelText('На проверке');
    expect(card).not.toBeNull();

    const dataTransfer = {
      data: {} as Record<string, string>,
      effectAllowed: '',
      dropEffect: '',
      setData(type: string, value: string) {
        this.data[type] = value;
      },
      getData(type: string) {
        return this.data[type] ?? '';
      }
    };

    fireEvent.dragStart(card!, { dataTransfer });
    fireEvent.dragOver(reviewColumn, { dataTransfer });
    fireEvent.drop(reviewColumn, { dataTransfer });

    await waitFor(() =>
      expect(api.updateRedmineIssueStatus).toHaveBeenCalledWith({
        issueId: '123',
        statusId: '3',
        status: 'Review',
        projectId: '1',
        sprintId: '4',
        cacheAssigneeId: '7'
      })
    );
  });

  it('changes a Redmine issue status when dropped into an empty In Progress column', async () => {
    const state = connectedState();
    state.redmine.statuses = [
      { id: '1', name: 'New' },
      { id: '7', name: 'В работе' },
      { id: '3', name: 'Review' }
    ];
    const api = installBridge(state);
    api.loadRedmineMyIssues.mockResolvedValueOnce({
      issues: [
        {
          id: '555',
          subject: 'Перенести в работу',
          tracker: 'Task',
          statusId: '1',
          status: 'New',
          priority: 'Normal',
          assignee: 'Иван',
          dueDate: '',
          updatedOn: '2026-06-01T08:30:00.000Z',
          url: 'https://redmine.example.com/issues/555'
        }
      ],
      source: 'redmine',
      syncedAt: '2026-06-01T08:30:00.000Z'
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Мои задачи' }));
    const cardTitle = await screen.findByRole('heading', { name: '#555 - Перенести в работу' });
    const card = cardTitle.closest('article');
    const inProgressColumn = screen.getByLabelText('В работе');
    expect(card).not.toBeNull();
    expect(inProgressColumn).toHaveTextContent('Нет задач');

    const dataTransfer = {
      data: {} as Record<string, string>,
      effectAllowed: '',
      dropEffect: '',
      setData(type: string, value: string) {
        this.data[type] = value;
      },
      getData(type: string) {
        return this.data[type] ?? '';
      }
    };

    fireEvent.dragStart(card!, { dataTransfer });
    fireEvent.dragOver(inProgressColumn, { dataTransfer });
    fireEvent.drop(inProgressColumn, { dataTransfer });

    await waitFor(() =>
      expect(api.updateRedmineIssueStatus).toHaveBeenCalledWith({
        issueId: '555',
        statusId: '7',
        status: 'В работе',
        projectId: '1',
        sprintId: '4',
        cacheAssigneeId: '7'
      })
    );
  });

  it('shows a warning when Redmine keeps the issue in its old status after a drop', async () => {
    const state = connectedState();
    state.redmine.statuses = [
      { id: '1', name: 'New' },
      { id: '3', name: 'В работе' },
      { id: '6', name: 'На проверке' }
    ];
    const api = installBridge(state);
    api.loadRedmineMyIssues.mockResolvedValueOnce({
      issues: [
        {
          id: '15720',
          subject: 'Некорректное разграничение прав доступа',
          tracker: 'Bug',
          statusId: '1',
          status: 'New',
          priority: 'Normal',
          assignee: 'Иван',
          dueDate: '',
          updatedOn: '2026-06-01T08:30:00.000Z',
          url: 'https://redmine.example.com/issues/15720'
        }
      ],
      source: 'redmine',
      syncedAt: '2026-06-01T08:30:00.000Z'
    });
    api.updateRedmineIssueStatus.mockResolvedValueOnce({
      issue: {
        id: 15720,
        subject: 'Некорректное разграничение прав доступа',
        status: { id: 1, name: 'New' },
        updated_on: '2026-06-01T10:00:00.000Z'
      }
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Мои задачи' }));
    const cardTitle = await screen.findByRole('heading', {
      name: '#15720 - Некорректное разграничение прав доступа'
    });
    const card = cardTitle.closest('article');
    const reviewColumn = screen.getByLabelText('На проверке');
    expect(card).not.toBeNull();

    const dataTransfer = {
      data: {} as Record<string, string>,
      effectAllowed: '',
      dropEffect: '',
      setData(type: string, value: string) {
        this.data[type] = value;
      },
      getData(type: string) {
        return this.data[type] ?? '';
      }
    };

    fireEvent.dragStart(card!, { dataTransfer });
    fireEvent.dragOver(reviewColumn, { dataTransfer });
    fireEvent.drop(reviewColumn, { dataTransfer });

    await waitFor(() =>
      expect(api.updateRedmineIssueStatus).toHaveBeenCalledWith({
        issueId: '15720',
        statusId: '6',
        status: 'На проверке',
        projectId: '1',
        sprintId: '4',
        cacheAssigneeId: '7'
      })
    );
    expect(await screen.findByText(/Redmine оставил задачу в статусе "New"/)).toBeInTheDocument();
  });

  it('places Assigned Redmine issues in the New column', async () => {
    const api = installBridge(connectedState());
    api.loadRedmineMyIssues.mockResolvedValueOnce({
      issues: [
        {
          id: '15720',
          subject: 'Некорректное разграничение прав доступа к мобильному приложению',
          tracker: 'Task',
          statusId: '4',
          status: 'Assigned',
          priority: 'Normal',
          assignee: 'Иван',
          dueDate: '2026-05-28',
          updatedOn: '2026-05-28T08:30:00.000Z',
          url: 'https://redmine.example.com/issues/15720'
        },
        {
          id: '15721',
          subject: 'Demo. Ошибка 400 при сортировке пользователей',
          tracker: 'Task',
          statusId: '5',
          status: 'Назначено',
          priority: 'Normal',
          assignee: 'Иван',
          dueDate: '2026-05-29',
          updatedOn: '2026-05-29T08:30:00.000Z',
          url: 'https://redmine.example.com/issues/15721'
        }
      ],
      source: 'redmine',
      syncedAt: '2026-05-28T08:30:00.000Z'
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Мои задачи' }));

    const newColumn = await screen.findByLabelText('Новые');
    const inProgressColumn = screen.getByLabelText('В работе');
    expect(newColumn).toHaveTextContent('#15720');
    expect(newColumn).toHaveTextContent('#15721');
    expect(inProgressColumn).not.toHaveTextContent('#15720');
    expect(inProgressColumn).not.toHaveTextContent('#15721');
  });

  it('keeps My Tasks visible when the running preload does not expose the new API yet', async () => {
    const api = installBridge(connectedState());
    (api as Record<string, unknown>).loadRedmineMyIssues = undefined;
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Мои задачи' }));

    expect(await screen.findByLabelText('Спринт')).toBeInTheDocument();
    expect(await screen.findByText(/loadRedmineMyIssues/)).toBeInTheDocument();
  });
});
