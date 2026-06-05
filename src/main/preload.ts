import { contextBridge, ipcRenderer } from 'electron';
import type { TelegramThreadKey, TelegramThreadRequest } from './domain/types';

contextBridge.exposeInMainWorld('teamSpace', {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron
  },
  api: {
    getState: () => ipcRenderer.invoke('app:get-state'),
    deleteLocalData: () => ipcRenderer.invoke('app:delete-local-data'),
    onStateChanged: (callback: (state: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
      ipcRenderer.on('app:state-changed', listener);
      return () => ipcRenderer.removeListener('app:state-changed', listener);
    },
    onMailStateChanged: (callback: (state: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
      ipcRenderer.on('mail:state-changed', listener);
      return () => ipcRenderer.removeListener('mail:state-changed', listener);
    },
    onBrowserStateChanged: (callback: (state: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
      ipcRenderer.on('browser:state-changed', listener);
      return () => ipcRenderer.removeListener('browser:state-changed', listener);
    },
    onChatGptStateChanged: (callback: (state: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
      ipcRenderer.on('chatgpt:state-changed', listener);
      return () => ipcRenderer.removeListener('chatgpt:state-changed', listener);
    },
    getAiQueue: () => ipcRenderer.invoke('ai-queue:list'),
    onAiQueueChanged: (callback: (items: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, items: unknown) => callback(items);
      ipcRenderer.on('ai-queue:changed', listener);
      return () => ipcRenderer.removeListener('ai-queue:changed', listener);
    },
    getAgentWorkPrompt: () => ipcRenderer.invoke('agent-work:get-prompt'),
    listAgentWorkReports: () => ipcRenderer.invoke('agent-work:list'),
    openAgentWorkFolder: () => ipcRenderer.invoke('agent-work:open-folder'),
    deleteAgentWorkReport: (payload: { reportId: string }) => ipcRenderer.invoke('agent-work:delete', payload),
    selectAgentWorkingDirectory: () => ipcRenderer.invoke('agent-work:select-directory'),
    prepareGitLabProjectWorkspace: (payload: { projectId: string }) =>
      ipcRenderer.invoke('agent-work:prepare-gitlab-project', payload),
    getGitLabProjectWorkspacePath: (payload: { projectId: string }) =>
      ipcRenderer.invoke('agent-work:get-gitlab-project-workspace-path', payload),
    runAgentForRedmineIssue: (payload: {
      workingDirectory: string;
      prompt: string;
      issue: {
        issue: {
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
        };
        projectId: string;
        projectName: string;
        sprintId: string;
        sprintName: string;
        columnName: string;
      };
    }) => ipcRenderer.invoke('agent-work:run-redmine-issue', payload),
    createRedmineIssueFromAgentWork: (payload: {
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
    }) => ipcRenderer.invoke('agent-work:create-redmine-issue', payload),
    openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
    openPath: (filePath: string) => ipcRenderer.invoke('shell:open-path', filePath),
    copyText: (text: string) => ipcRenderer.invoke('clipboard:write-text', text),
    readTextFile: (filePath: string) => ipcRenderer.invoke('file:read-text', filePath),
    writeTextFile: (payload: { filePath: string; content: string }) =>
      ipcRenderer.invoke('file:write-text', payload),
    showMailView: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke('mail:show', bounds),
    setMailBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke('mail:set-bounds', bounds),
    hideMailView: () => ipcRenderer.invoke('mail:hide'),
    goBackMailView: () => ipcRenderer.invoke('mail:go-back'),
    reloadMailView: () => ipcRenderer.invoke('mail:reload'),
    getMailCredentialsStatus: () => ipcRenderer.invoke('mail:get-credentials-status'),
    saveMailCredentials: (payload: { url?: string; username: string; password?: string }) =>
      ipcRenderer.invoke('mail:save-credentials', payload),
    deleteMailCredentials: () => ipcRenderer.invoke('mail:delete-credentials'),
    showBrowserView: (payload: { bounds: { x: number; y: number; width: number; height: number }; url?: string }) =>
      ipcRenderer.invoke('browser:show', payload),
    setBrowserBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke('browser:set-bounds', bounds),
    hideBrowserView: () => ipcRenderer.invoke('browser:hide'),
    goBackBrowserView: () => ipcRenderer.invoke('browser:go-back'),
    reloadBrowserView: () => ipcRenderer.invoke('browser:reload'),
    showChatGptView: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke('chatgpt:show', bounds),
    setChatGptBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke('chatgpt:set-bounds', bounds),
    hideChatGptView: () => ipcRenderer.invoke('chatgpt:hide'),
    goBackChatGptView: () => ipcRenderer.invoke('chatgpt:go-back'),
    reloadChatGptView: () => ipcRenderer.invoke('chatgpt:reload'),
    resetChatGptSession: () => ipcRenderer.invoke('chatgpt:reset-session'),
    openTelemost: (url: string) => ipcRenderer.invoke('telemost:open', url),
    getKatyaMe: (payload: { baseUrl: string; sessionCookie: string }) =>
      ipcRenderer.invoke('katya:me', payload),
    getKatyaBaseUrl: () => ipcRenderer.invoke('katya:get-base-url'),
    saveKatyaBaseUrl: (payload: { baseUrl: string }) =>
      ipcRenderer.invoke('katya:save-base-url', payload),
    saveKatyaSettings: (payload: { baseUrl: string; sessionCookie?: string }) =>
      ipcRenderer.invoke('katya:save-settings', payload),
    getKatyaSession: () => ipcRenderer.invoke('katya:get-session'),
    saveKatyaSession: (payload: { sessionCookie: string }) =>
      ipcRenderer.invoke('katya:save-session', payload),
    listKatyaGroups: (payload: { baseUrl: string; sessionCookie: string }) =>
      ipcRenderer.invoke('katya:list-groups', payload),
    createKatyaMeeting: (payload: {
      baseUrl: string;
      sessionCookie: string;
      url: string;
      title: string;
      groupId?: string;
    }) => ipcRenderer.invoke('katya:create-meeting', payload),
    stopKatyaMeeting: (payload: { baseUrl: string; sessionCookie: string; meetingId: string }) =>
      ipcRenderer.invoke('katya:stop-meeting', payload),
    listKatyaMeetings: (payload: { baseUrl: string; sessionCookie: string; page?: number; pageSize?: number }) =>
      ipcRenderer.invoke('katya:list-meetings', payload),
    getKatyaMeeting: (payload: { baseUrl: string; sessionCookie: string; meetingId: string }) =>
      ipcRenderer.invoke('katya:get-meeting', payload),
    analyzeKatyaDailies: (payload: {
      baseUrl: string;
      sessionCookie: string;
      meetingIds?: string[];
      analysisPrompt?: string;
    }) =>
      ipcRenderer.invoke('katya:analyze-dailies', payload),
    listKatyaDailyAnalyses: () => ipcRenderer.invoke('katya:list-daily-analyses'),
    saveRecording: (payload: { fileName: string; data: ArrayBuffer }) =>
      ipcRenderer.invoke('recording:save', payload),
    openRecordingFolder: (directory: string) => ipcRenderer.invoke('recording:open-folder', directory),
    requestTelegramCode: (payload: { phone: string; proxyUrl?: string }) =>
      ipcRenderer.invoke('telegram:request-code', payload),
    connectTelegram: (payload: { code: string; password?: string }) =>
      ipcRenderer.invoke('telegram:connect', payload),
    syncTelegram: () => ipcRenderer.invoke('telegram:sync'),
    getTelegramInboxSnapshot: () => ipcRenderer.invoke('telegram:get-inbox-snapshot'),
    getTelegramThread: (payload: TelegramThreadRequest) =>
      ipcRenderer.invoke('telegram:get-thread', payload),
    markTelegramThreadRead: (payload: TelegramThreadKey) =>
      ipcRenderer.invoke('telegram:mark-thread-read', payload),
    loadChatMessages: (payload: { chatId: string; topicId?: string }) =>
      ipcRenderer.invoke('telegram:load-chat-messages', payload),
    loadOlderChatMessages: (payload: { chatId: string; topicId?: string; beforeMessageId: string }) =>
      ipcRenderer.invoke('telegram:load-older-chat-messages', payload),
    sendTelegramMessage: (payload: {
      chatId: string;
      topicId?: string;
      replyToMessageId?: string;
      text: string;
      file?: { name: string; mimeType: string; data: ArrayBuffer };
      image?: { name: string; mimeType: string; data: ArrayBuffer };
    }) =>
      ipcRenderer.invoke('telegram:send-message', payload),
    reactToTelegramMessage: (payload: { messageId: string; emoticon: string }) =>
      ipcRenderer.invoke('telegram:react-to-message', payload),
    downloadTelegramAttachment: (payload: { messageId: string; attachmentId: string }) =>
      ipcRenderer.invoke('telegram:download-attachment', payload),
    disconnectTelegram: () => ipcRenderer.invoke('telegram:disconnect'),
    selectTelegramWorkspace: (payload: { folderId: string | null; chatIds: string[] }) =>
      ipcRenderer.invoke('telegram:select-workspace', payload),
    setTelegramChatNotifications: (payload: { chatId: string; enabled: boolean }) =>
      ipcRenderer.invoke('telegram:set-chat-notifications', payload),
    testGitLab: (payload: { baseUrl: string; token?: string }) =>
      ipcRenderer.invoke('gitlab:test', payload),
    saveGitLab: (payload: { baseUrl: string; token?: string; selectedProjectIds: string[] }) =>
      ipcRenderer.invoke('gitlab:save', payload),
    syncGitLabProjects: () => ipcRenderer.invoke('gitlab:sync-projects'),
    disconnectGitLab: () => ipcRenderer.invoke('gitlab:disconnect'),
    testRedmine: (payload: { baseUrl: string; apiKey?: string }) =>
      ipcRenderer.invoke('redmine:test', payload),
    saveRedmine: (payload: {
      baseUrl: string;
      apiKey?: string;
      defaultProjectId: string;
      defaultTrackerId: string;
      defaultPriorityId: string;
      defaultSprintId?: string;
      defaultAssigneeId?: string;
    }) => ipcRenderer.invoke('redmine:save', payload),
    loadRedmineProjectUsers: (payload: { projectId: string }) =>
      ipcRenderer.invoke('redmine:load-project-users', payload),
    selectRedmineProject: (payload: { projectId: string }) =>
      ipcRenderer.invoke('redmine:select-project', payload),
    loadRedmineMyIssues: (payload: { projectId: string; sprintId: string; assigneeId?: string }) =>
      ipcRenderer.invoke('redmine:load-my-issues', payload),
    syncRedmineMyIssues: (payload: { projectId: string; sprintId: string; assigneeId?: string }) =>
      ipcRenderer.invoke('redmine:sync-my-issues', payload),
    loadRedmineIssueDetails: (payload: { issueId: string }) =>
      ipcRenderer.invoke('redmine:load-issue-details', payload),
    updateRedmineIssueDetails: (payload: { issueId: string; subject: string; description: string }) =>
      ipcRenderer.invoke('redmine:update-issue-details', payload),
    updateRedmineIssueAssignee: (payload: {
      issueId: string;
      assigneeId: string;
      assignee?: string;
      projectId?: string;
      sprintId?: string;
      cacheAssigneeId?: string;
    }) => ipcRenderer.invoke('redmine:update-issue-assignee', payload),
    deleteRedmineIssue: (payload: {
      issueId: string;
      projectId?: string;
      sprintId?: string;
      cacheAssigneeId?: string;
    }) => ipcRenderer.invoke('redmine:delete-issue', payload),
    updateRedmineIssueSprint: (payload: {
      issueId: string;
      sprintId: string;
      projectId?: string;
      previousSprintId?: string;
      cacheAssigneeId?: string;
    }) => ipcRenderer.invoke('redmine:update-issue-sprint', payload),
    addRedmineIssueComment: (payload: { issueId: string; notes: string }) =>
      ipcRenderer.invoke('redmine:add-issue-comment', payload),
    updateRedmineIssueJournal: (payload: { issueId: string; journalId: string; notes: string }) =>
      ipcRenderer.invoke('redmine:update-issue-journal', payload),
    createRedmineIssue: (payload: {
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
    }) => ipcRenderer.invoke('redmine:create-issue', payload),
    updateRedmineIssueStatus: (payload: {
      issueId: string;
      statusId: string;
      status?: string;
      projectId?: string;
      sprintId?: string;
      cacheAssigneeId?: string;
    }) =>
      ipcRenderer.invoke('redmine:update-issue-status', payload),
    formatRedmineIssueWithAi: (payload: {
      issue: {
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
      };
      projectId: string;
      projectName: string;
      sprintId: string;
      sprintName: string;
      columnName: string;
    }) => ipcRenderer.invoke('redmine:format-issue-ai', payload),
    generateRedmineSprintResultsWithAi: (payload: {
      projectId: string;
      projectName: string;
      sprintId: string;
      sprintName: string;
      issues: Array<{
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
      }>;
    }) => ipcRenderer.invoke('redmine:sprint-results-ai', payload),
    loadLatestGeneratedDescriptions: (payload: { issueIds: string[] }) =>
      ipcRenderer.invoke('redmine:latest-generated-descriptions', payload),
    disconnectRedmine: () => ipcRenderer.invoke('redmine:disconnect'),
    createRedmineIssueFromMessages: (payload: { messageIds: string[] }) =>
      ipcRenderer.invoke('redmine:create-issue-from-messages-ai', payload)
  }
});
