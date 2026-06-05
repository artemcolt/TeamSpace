export type MessageStatus = 'new' | 'ignored' | 'created';
export type ConnectionStatus = 'disconnected' | 'connected' | 'error';

export interface WorkspaceSettings {
  redmineBaseUrl: string;
  defaultProjectId: string;
  defaultTrackerId: string;
  defaultPriorityId: string;
  defaultSprintId: string;
  defaultAssigneeId: string;
  aiMode: 'off' | 'local';
}

export interface TelegramFolder {
  id: string;
  title: string;
  chatIds: string[];
}

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

export interface TelegramAttachmentDownloadPayload {
  messageId: string;
  attachmentId: string;
}

export interface TelegramAttachmentDownloadResult {
  filePath: string;
  fileUrl?: string;
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

export interface RedmineOption {
  id: string;
  name: string;
}

export interface GitLabProject {
  id: string;
  name: string;
  pathWithNamespace: string;
  webUrl: string;
  defaultBranch: string | null;
  lastActivityAt: string | null;
  sshUrlToRepo: string;
  httpUrlToRepo: string;
}

export interface RedmineIssueSummary {
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

export interface RedmineIssueListResponse {
  issues: RedmineIssueSummary[];
  source: 'cache' | 'redmine';
  syncedAt: string | null;
  error?: string;
}

export interface RedmineIssueListPayload {
  projectId: string;
  sprintId: string;
  assigneeId?: string;
}

export interface RedmineIssueAiPayload {
  issue: RedmineIssueSummary;
  projectId: string;
  projectName: string;
  sprintId: string;
  sprintName: string;
  columnName: string;
}

export interface RedmineIssueAiResult {
  directory: string;
  inputFile: string;
  promptFile: string;
  outputFile: string;
  rawOutputFile: string;
}

export interface RedmineIssueAgentRunPayload {
  workingDirectory: string;
  prompt: string;
  issue: RedmineIssueAiPayload;
}

export interface GitLabProjectWorkspaceResult {
  projectId: string;
  projectName: string;
  workingDirectory: string;
  action: 'cloned' | 'pulled';
}

export interface RedmineIssueAgentRunResult {
  directory: string;
  workingDirectory: string;
  inputFile: string;
  issueMarkdownFile: string;
  promptFile: string;
  outputFile: string;
  rawOutputFile: string;
}

export interface RedmineSprintResultsPayload {
  projectId: string;
  projectName: string;
  sprintId: string;
  sprintName: string;
  issues: RedmineIssueSummary[];
}

export interface RedmineSprintResultsAiResult {
  directory: string;
  inputFile: string;
  promptFile: string;
  outputFile: string;
  rawOutputFile: string;
  content: string;
}

export type AiQueueStatus = 'queued' | 'running' | 'done' | 'error';

export interface AiQueueTarget {
  view: 'inbox' | 'myTasks' | 'meetings';
  label: string;
  issueId?: string;
}

export interface AiQueueContextField {
  label: string;
  value: string;
}

export interface AiQueueContext {
  title?: string;
  description?: string;
  fields: AiQueueContextField[];
}

export interface AiQueueItem {
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

export interface KatyaMeeting {
  id: string;
  url: string;
  title: string;
  status: string;
  group_id?: string;
}

export interface KatyaAccessGroup {
  id: string;
  name: string;
}

export interface KatyaMeetingSegment {
  start: number;
  end: number;
  text: string;
  speaker: string;
}

export interface KatyaMeetingSummary extends KatyaMeeting {
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

export interface KatyaMeetingDetail extends KatyaMeetingSummary {
  transcript?: string;
  summary?: string;
  video_url?: string;
}

export interface KatyaMeetingListResponse {
  data: KatyaMeetingSummary[];
  page: number;
  page_size: number;
  total: number;
}

export interface KatyaDailyAnalysisPayload {
  baseUrl: string;
  sessionCookie: string;
  meetingIds?: string[];
  analysisPrompt?: string;
}

export interface KatyaDailyAnalysisAiResult {
  directory: string;
  inputFile: string;
  promptFile: string;
  outputFile: string;
  rawOutputFile: string;
  content: string;
  meetingsCount: number;
  createdAt: string;
}

export interface UpdateRedmineIssueDetailsPayload {
  issueId: string;
  subject: string;
  description: string;
}

export interface AddRedmineIssueCommentPayload {
  issueId: string;
  notes: string;
}

export interface UpdateRedmineIssueJournalPayload {
  issueId: string;
  journalId: string;
  notes: string;
}

export interface UpdateRedmineIssueAssigneePayload {
  issueId: string;
  assigneeId: string;
  assignee?: string;
  projectId?: string;
  sprintId?: string;
  cacheAssigneeId?: string;
}

export interface DeleteRedmineIssuePayload {
  issueId: string;
  projectId?: string;
  sprintId?: string;
  cacheAssigneeId?: string;
}

export interface UpdateRedmineIssueSprintPayload {
  issueId: string;
  sprintId: string;
  projectId?: string;
  previousSprintId?: string;
  cacheAssigneeId?: string;
}

export interface CreateRedmineIssuePayload {
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

export interface CreateRedmineIssueFromMessagesPayload {
  messageIds: string[];
}

export interface RedmineUploadAttachment {
  filePath: string;
  fileName?: string;
  contentType?: string;
}

export interface AgentWorkScreenshot {
  filePath: string;
  fileName: string;
  dataUrl: string | null;
}

export interface AgentWorkItem {
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

export interface AgentWorkCreateIssuePayload {
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

export interface AppState {
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

export interface SecretFile {
  redmineApiKey?: string;
  katyaSessionCookie?: string;
  katyaBaseUrl?: string;
  telegramSession?: string;
  telegramApiCredentials?: string;
  telegramProxyUrl?: string;
  gitlabToken?: string;
  gtsMailUrl?: string;
  gtsMailCookies?: string;
  gtsMailCredentials?: string;
  chatGptLastUrl?: string;
}

export interface CachedTelegramAvatar {
  dataUrl: string | null;
  fetchedAt: string | null;
  failedAt: string | null;
}

export interface TelegramCredentials {
  apiId: number;
  apiHash: string;
}

export interface PendingTelegramLogin {
  apiId: number;
  apiHash: string;
  phone: string;
  proxyUrl: string;
  phoneCodeHash: string;
}
