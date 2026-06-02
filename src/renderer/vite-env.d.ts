/// <reference types="vite/client" />

interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MailViewState {
  canGoBack: boolean;
  loading: boolean;
  url: string;
  error: string;
}

interface BrowserViewState {
  canGoBack: boolean;
  loading: boolean;
  url: string;
  error: string;
}

interface TeamSpaceBridge {
  platform: NodeJS.Platform;
  versions: {
    node: string;
    chrome: string;
    electron: string;
  };
  api: {
    getState: () => Promise<AppState>;
    deleteLocalData: () => Promise<AppState>;
    onStateChanged: (callback: (state: AppState) => void) => () => void;
    onMailStateChanged: (callback: (state: MailViewState) => void) => () => void;
    onBrowserStateChanged: (callback: (state: BrowserViewState) => void) => () => void;
    onChatGptStateChanged: (callback: (state: BrowserViewState) => void) => () => void;
    getAiQueue: () => Promise<AiQueueItem[]>;
    onAiQueueChanged: (callback: (items: AiQueueItem[]) => void) => () => void;
    getAgentWorkPrompt: () => Promise<string>;
    listAgentWorkReports: () => Promise<AgentWorkItem[]>;
    openAgentWorkFolder: () => Promise<string>;
    deleteAgentWorkReport: (payload: { reportId: string }) => Promise<void>;
    selectAgentWorkingDirectory: () => Promise<string>;
    prepareGitLabProjectWorkspace: (payload: { projectId: string }) => Promise<GitLabProjectWorkspaceResult>;
    getGitLabProjectWorkspacePath: (payload: { projectId: string }) => Promise<string>;
    runAgentForRedmineIssue: (payload: RedmineIssueAgentRunPayload) => Promise<RedmineIssueAgentRunResult>;
    createRedmineIssueFromAgentWork: (payload: AgentWorkCreateIssuePayload) => Promise<RedmineIssueSummary>;
    openExternal: (url: string) => Promise<void>;
    openPath: (filePath: string) => Promise<string>;
    copyText: (text: string) => Promise<void>;
    readTextFile: (filePath: string) => Promise<string>;
    writeTextFile: (payload: { filePath: string; content: string }) => Promise<void>;
    showMailView: (bounds: ViewBounds) => Promise<MailViewState>;
    setMailBounds: (bounds: ViewBounds) => Promise<void>;
    hideMailView: () => Promise<void>;
    goBackMailView: () => Promise<void>;
    reloadMailView: () => Promise<void>;
    getMailCredentialsStatus: () => Promise<{ url: string; username: string; hasPassword: boolean }>;
    saveMailCredentials: (payload: { url?: string; username: string; password?: string }) => Promise<{ url: string; username: string; hasPassword: boolean }>;
    deleteMailCredentials: () => Promise<{ url: string; username: string; hasPassword: boolean }>;
    showBrowserView: (payload: { bounds: ViewBounds; url?: string }) => Promise<BrowserViewState>;
    setBrowserBounds: (bounds: ViewBounds) => Promise<void>;
    hideBrowserView: () => Promise<void>;
    goBackBrowserView: () => Promise<void>;
    reloadBrowserView: () => Promise<void>;
    showChatGptView: (bounds: ViewBounds) => Promise<BrowserViewState>;
    setChatGptBounds: (bounds: ViewBounds) => Promise<void>;
    hideChatGptView: () => Promise<void>;
    goBackChatGptView: () => Promise<void>;
    reloadChatGptView: () => Promise<void>;
    resetChatGptSession: () => Promise<BrowserViewState>;
    openTelemost: (url: string) => Promise<void>;
    getKatyaMe: (payload: { baseUrl: string; sessionCookie: string }) => Promise<KatyaUser>;
    getKatyaBaseUrl: () => Promise<string>;
    saveKatyaBaseUrl: (payload: { baseUrl: string }) => Promise<void>;
    saveKatyaSettings: (payload: { baseUrl: string; sessionCookie?: string }) => Promise<void>;
    getKatyaSession: () => Promise<string>;
    saveKatyaSession: (payload: { sessionCookie: string }) => Promise<void>;
    listKatyaGroups: (payload: { baseUrl: string; sessionCookie: string }) => Promise<KatyaAccessGroup[]>;
    createKatyaMeeting: (payload: {
      baseUrl: string;
      sessionCookie: string;
      url: string;
      title: string;
      groupId?: string;
    }) => Promise<KatyaMeeting>;
    stopKatyaMeeting: (payload: { baseUrl: string; sessionCookie: string; meetingId: string }) => Promise<KatyaMeeting>;
    listKatyaMeetings: (payload: {
      baseUrl: string;
      sessionCookie: string;
      page?: number;
      pageSize?: number;
    }) => Promise<KatyaMeetingListResponse>;
    getKatyaMeeting: (payload: {
      baseUrl: string;
      sessionCookie: string;
      meetingId: string;
    }) => Promise<KatyaMeetingDetail>;
    analyzeKatyaDailies: (payload: {
      baseUrl: string;
      sessionCookie: string;
      meetingIds?: string[];
      analysisPrompt?: string;
    }) => Promise<KatyaDailyAnalysisAiResult>;
    listKatyaDailyAnalyses: () => Promise<KatyaDailyAnalysisAiResult[]>;
    saveRecording: (payload: { fileName: string; data: ArrayBuffer }) => Promise<RecordingSaveResult>;
    openRecordingFolder: (directory: string) => Promise<string>;
    requestTelegramCode: (payload: {
      phone: string;
      proxyUrl?: string;
    }) => Promise<AppState>;
    connectTelegram: (payload: { code: string; password?: string }) => Promise<AppState>;
    syncTelegram: () => Promise<AppState>;
    loadChatMessages: (payload: { chatId: string; topicId?: string }) => Promise<AppState>;
    loadOlderChatMessages: (payload: { chatId: string; topicId?: string; beforeMessageId: string }) => Promise<AppState>;
    sendTelegramMessage: (payload: { chatId: string; topicId?: string; replyToMessageId?: string; text: string; file?: TelegramOutgoingFile; image?: TelegramOutgoingFile }) => Promise<AppState>;
    reactToTelegramMessage: (payload: { messageId: string; emoticon: string }) => Promise<AppState>;
    downloadTelegramAttachment: (payload: TelegramAttachmentDownloadPayload) => Promise<TelegramAttachmentDownloadResult>;
    disconnectTelegram: () => Promise<AppState>;
    selectTelegramWorkspace: (payload: { folderId: string | null; chatIds: string[] }) => Promise<AppState>;
    setTelegramChatNotifications: (payload: { chatId: string; enabled: boolean }) => Promise<AppState>;
    testGitLab: (payload: { baseUrl: string; token?: string }) => Promise<AppState>;
    saveGitLab: (payload: {
      baseUrl: string;
      token?: string;
      selectedProjectIds: string[];
    }) => Promise<AppState>;
    syncGitLabProjects: () => Promise<AppState>;
    disconnectGitLab: () => Promise<AppState>;
    testRedmine: (payload: { baseUrl: string; apiKey?: string }) => Promise<AppState>;
    saveRedmine: (payload: {
      baseUrl: string;
      apiKey?: string;
      defaultProjectId: string;
      defaultTrackerId: string;
      defaultPriorityId: string;
      defaultSprintId?: string;
      defaultAssigneeId?: string;
    }) => Promise<AppState>;
    loadRedmineProjectUsers: (payload: { projectId: string }) => Promise<AppState>;
    selectRedmineProject: (payload: { projectId: string }) => Promise<AppState>;
    loadRedmineMyIssues: (payload: { projectId: string; sprintId: string; assigneeId?: string }) => Promise<RedmineIssueListResponse>;
    syncRedmineMyIssues: (payload: { projectId: string; sprintId: string; assigneeId?: string }) => Promise<RedmineIssueListResponse>;
    loadRedmineIssueDetails: (payload: { issueId: string }) => Promise<RedmineIssueDetails>;
    updateRedmineIssueDetails: (payload: {
      issueId: string;
      subject: string;
      description: string;
    }) => Promise<RedmineIssueDetails>;
    updateRedmineIssueAssignee: (payload: {
      issueId: string;
      assigneeId: string;
      assignee?: string;
      projectId?: string;
      sprintId?: string;
      cacheAssigneeId?: string;
    }) => Promise<RedmineIssueDetails>;
    deleteRedmineIssue: (payload: {
      issueId: string;
      projectId?: string;
      sprintId?: string;
      cacheAssigneeId?: string;
    }) => Promise<void>;
    updateRedmineIssueSprint: (payload: {
      issueId: string;
      sprintId: string;
      projectId?: string;
      previousSprintId?: string;
      cacheAssigneeId?: string;
    }) => Promise<RedmineIssueDetails>;
    addRedmineIssueComment: (payload: { issueId: string; notes: string }) => Promise<RedmineIssueDetails>;
    updateRedmineIssueJournal: (payload: {
      issueId: string;
      journalId: string;
      notes: string;
    }) => Promise<RedmineIssueDetails>;
    createRedmineIssue: (payload: CreateRedmineIssuePayload) => Promise<RedmineIssueSummary>;
    updateRedmineIssueStatus: (payload: {
      issueId: string;
      statusId: string;
      status?: string;
      projectId?: string;
      sprintId?: string;
      cacheAssigneeId?: string;
    }) => Promise<RedmineIssueDetails>;
    formatRedmineIssueWithAi: (payload: RedmineIssueAiPayload) => Promise<RedmineIssueAiResult>;
    generateRedmineSprintResultsWithAi: (payload: RedmineSprintResultsPayload) => Promise<RedmineSprintResultsAiResult>;
    loadLatestGeneratedDescriptions: (payload: { issueIds: string[] }) => Promise<Record<string, string>>;
    disconnectRedmine: () => Promise<AppState>;
    createRedmineIssueFromMessages: (payload: { messageIds: string[] }) => Promise<AppState>;
  };
}

interface Window {
  teamSpace: TeamSpaceBridge;
}

interface RecordingSaveResult {
  directory: string;
  filePath: string;
}

interface KatyaUser {
  email: string;
  enabled: boolean;
  first_name: string;
  is_admin: boolean;
  last_name: string;
  username: string;
}

interface KatyaMeeting {
  id: string;
  url: string;
  title: string;
  status: string;
  group_id?: string;
}

interface KatyaAccessGroup {
  id: string;
  name: string;
}

interface KatyaMeetingSegment {
  start: number;
  end: number;
  text: string;
  speaker: string;
}

interface KatyaMeetingSummary extends KatyaMeeting {
  platform?: string;
  video_path?: string;
  segments?: KatyaMeetingSegment[];
  speaker_names?: Record<string, string>;
  duration_sec?: number;
  started_at?: string;
  ended_at?: string;
  transcribe_progress?: number;
  created_at?: string;
  updated_at?: string;
  owner_username?: string;
  owner_display_name?: string;
  group_id?: string;
  group_name?: string;
  video_size_bytes?: number;
}

interface KatyaMeetingDetail extends KatyaMeetingSummary {
  transcript?: string;
  summary?: string;
  video_url?: string;
}

interface KatyaMeetingListResponse {
  data: KatyaMeetingSummary[];
  page: number;
  page_size: number;
  total: number;
}

interface KatyaDailyAnalysisAiResult {
  directory: string;
  inputFile: string;
  promptFile: string;
  outputFile: string;
  rawOutputFile: string;
  content: string;
  meetingsCount: number;
  createdAt: string;
}

type MessageStatus = 'new' | 'ignored' | 'created';
type ConnectionStatus = 'disconnected' | 'connected' | 'error';
type AiQueueStatus = 'queued' | 'running' | 'done' | 'error';

interface AiQueueTarget {
  view: 'inbox' | 'myTasks' | 'meetings';
  label: string;
  issueId?: string;
}

interface AiQueueContextField {
  label: string;
  value: string;
}

interface AiQueueContext {
  title?: string;
  description?: string;
  fields: AiQueueContextField[];
}

interface AiQueueItem {
  id: string;
  title: string;
  status: AiQueueStatus;
  target: AiQueueTarget;
  context?: AiQueueContext;
  resultFile?: string | null;
  sessionId?: string | null;
  resultPreview?: string | null;
  reportDirectory?: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

interface WorkspaceSettings {
  redmineBaseUrl: string;
  defaultProjectId: string;
  defaultTrackerId: string;
  defaultPriorityId: string;
  defaultSprintId: string;
  defaultAssigneeId: string;
  aiMode: 'off' | 'local';
}

interface TelegramFolder {
  id: string;
  title: string;
  chatIds: string[];
}

interface TelegramChat {
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

interface TelegramTopic {
  id: string;
  chatId: string;
  title: string;
  topMessageId: string;
  unreadCount: number;
  lastMessageAt: string | null;
}

interface TelegramMessage {
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

interface TelegramMessageReaction {
  emoticon: string;
  count: number;
  mine: boolean;
  users?: string[];
}

interface TelegramMessageAttachment {
  id: string;
  type: 'image' | 'sticker' | 'file';
  fileName: string;
  mimeType: string;
  size: number | null;
  dataUrl: string | null;
}

interface TelegramOutgoingFile {
  name: string;
  mimeType: string;
  data: ArrayBuffer;
}

interface TelegramAttachmentDownloadPayload {
  messageId: string;
  attachmentId: string;
}

interface TelegramAttachmentDownloadResult {
  filePath: string;
  fileUrl?: string;
}

interface RedmineOption {
  id: string;
  name: string;
}

interface RedmineIssueSummary {
  id: string;
  subject: string;
  statusId: string;
  tracker: string;
  status: string;
  priority: string;
  assignee: string;
  dueDate: string;
  updatedOn: string;
  url: string;
}

interface RedmineIssueListResponse {
  issues: RedmineIssueSummary[];
  source: 'cache' | 'redmine';
  syncedAt: string | null;
  error?: string;
}

interface RedmineUploadAttachment {
  filePath: string;
  fileName?: string;
  contentType?: string;
}

interface AgentWorkScreenshot {
  filePath: string;
  fileName: string;
  dataUrl: string | null;
}

interface AgentWorkItem {
  id: string;
  title: string;
  summary: string;
  directory: string;
  reportPath: string;
  createdAt: string;
  updatedAt: string;
  screenshots: AgentWorkScreenshot[];
  redmineIssueId?: string;
  redmineUrl?: string;
  redmineTestingIssueId?: string;
  redmineTestingUrl?: string;
}

interface AgentWorkCreateIssuePayload {
  reportId: string;
  issueKind?: 'result' | 'testing';
  projectId?: string;
  sprintId?: string;
  trackerId?: string;
  priorityId?: string;
  assigneeId?: string;
  statusId?: string;
  subject?: string;
  description?: string;
  comment?: string;
}

interface RedmineIssueDetails {
  issue?: Record<string, unknown>;
}

interface RedmineIssueAiPayload {
  issue: RedmineIssueSummary;
  projectId: string;
  projectName: string;
  sprintId: string;
  sprintName: string;
  columnName: string;
}

interface RedmineIssueAiResult {
  directory: string;
  inputFile: string;
  promptFile: string;
  outputFile: string;
  rawOutputFile: string;
}

interface RedmineIssueAgentRunPayload {
  workingDirectory: string;
  prompt: string;
  issue: RedmineIssueAiPayload;
}

interface GitLabProjectWorkspaceResult {
  projectId: string;
  projectName: string;
  workingDirectory: string;
  action: 'cloned' | 'pulled';
}

interface RedmineIssueAgentRunResult {
  directory: string;
  workingDirectory: string;
  inputFile: string;
  issueMarkdownFile: string;
  promptFile: string;
  outputFile: string;
  rawOutputFile: string;
}

interface RedmineSprintResultsPayload {
  projectId: string;
  projectName: string;
  sprintId: string;
  sprintName: string;
  issues: RedmineIssueSummary[];
}

interface RedmineSprintResultsAiResult {
  directory: string;
  inputFile: string;
  promptFile: string;
  outputFile: string;
  rawOutputFile: string;
  content: string;
}

interface GitLabProject {
  id: string;
  name: string;
  pathWithNamespace: string;
  webUrl: string;
  defaultBranch: string | null;
  lastActivityAt: string | null;
  sshUrlToRepo: string;
  httpUrlToRepo: string;
}

interface CreateRedmineIssuePayload {
  projectId: string;
  sprintId: string;
  subject: string;
  description?: string;
  trackerId?: string;
  tracker?: string;
  priorityId?: string;
  priority?: string;
  assigneeId?: string;
  assignee?: string;
  statusId?: string;
  status?: string;
  attachments?: RedmineUploadAttachment[];
  inlineImageAttachments?: boolean;
}

interface AppState {
  workspace: WorkspaceSettings;
  telegram: {
    status: ConnectionStatus;
    phoneMasked: string | null;
    hasApiCredentials: boolean;
    codeRequested: boolean;
    codeDelivery: string | null;
    selectedFolderId: string | null;
    folders: TelegramFolder[];
    chats: TelegramChat[];
    topics: TelegramTopic[];
    messages: TelegramMessage[];
    error: string | null;
  };
  redmine: {
    status: ConnectionStatus;
    baseUrl: string;
    hasApiKey: boolean;
    projects: RedmineOption[];
    trackers: RedmineOption[];
    priorities: RedmineOption[];
    statuses: RedmineOption[];
    sprints: RedmineOption[];
    users: RedmineOption[];
    error: string | null;
  };
  gitlab: {
    status: ConnectionStatus;
    baseUrl: string;
    hasToken: boolean;
    projects: GitLabProject[];
    selectedProjectIds: string[];
    error: string | null;
  };
  metrics: {
    createdIssues: number;
    ignoredMessages: number;
  };
}
