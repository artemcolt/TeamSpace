import {
  defaultState,
  freshestSprintId,
  normalizeBaseUrl,
  redmineDefaultUrl
} from '../domain/appState';
import type {
  AddRedmineIssueCommentPayload,
  AppState,
  CreateRedmineIssuePayload,
  DeleteRedmineIssuePayload,
  RedmineIssueListResponse,
  RedmineIssueSummary,
  UpdateRedmineIssueAssigneePayload,
  UpdateRedmineIssueDetailsPayload,
  UpdateRedmineIssueJournalPayload,
  UpdateRedmineIssueSprintPayload
} from '../domain/types';
import { LocalStore } from '../storage/localStore';
import {
  addRedmineIssueComment,
  createRedmineIssue,
  deleteRedmineIssue,
  fetchRedmineJson,
  loadRedmineIssueDetails,
  loadRedmineAssignableUsers,
  loadRedmineCatalogs,
  loadRedmineMyIssues,
  loadRedmineProjectSprints,
  updateRedmineIssueAssignee,
  updateRedmineIssueDetails,
  updateRedmineIssueJournal,
  updateRedmineIssueSprint,
  updateRedmineIssueStatus
} from './redmineClient';

export class RedmineService {
  constructor(private readonly store: LocalStore) {}

  async test(payload: { baseUrl: string; apiKey?: string }): Promise<AppState> {
    const baseUrl = normalizeBaseUrl(payload.baseUrl);
    const enteredApiKey = payload.apiKey?.trim() ?? '';
    const apiKey = enteredApiKey || this.store.getSecret('redmineApiKey');
    if (!apiKey) {
      throw new Error('Введите Redmine API key.');
    }

    try {
      await fetchRedmineJson(baseUrl, apiKey, 'users/current.json');
      const catalogs = await loadRedmineCatalogs(baseUrl, apiKey);
      const defaultProjectId = this.store.getState().workspace.defaultProjectId || catalogs.projects[0]?.id || '';
      const assignableUsers = defaultProjectId
        ? await loadRedmineAssignableUsers(baseUrl, apiKey, defaultProjectId)
        : [];
      const sprints = defaultProjectId
        ? await loadRedmineProjectSprints(baseUrl, apiKey, defaultProjectId).catch(() => [])
        : [];
      if (enteredApiKey) {
        this.store.setSecret('redmineApiKey', enteredApiKey);
      }
      return this.store.setState((state) => {
        state.redmine.status = 'connected';
        state.redmine.baseUrl = baseUrl;
        state.redmine.hasApiKey = true;
        state.redmine.projects = catalogs.projects;
        state.redmine.trackers = catalogs.trackers;
        state.redmine.priorities = catalogs.priorities;
        state.redmine.statuses = catalogs.statuses;
        state.redmine.sprints = sprints;
        state.redmine.users = assignableUsers.length > 0 ? assignableUsers : catalogs.users;
        state.redmine.error = null;
        state.workspace.redmineBaseUrl = baseUrl;
        state.workspace.defaultProjectId = defaultProjectId;
        if (!state.workspace.defaultSprintId || !sprints.some((sprint) => sprint.id === state.workspace.defaultSprintId)) {
          state.workspace.defaultSprintId = freshestSprintId(sprints);
        }
      });
    } catch (error) {
      return this.store.setState((state) => {
        state.redmine.status = 'error';
        state.redmine.baseUrl = baseUrl;
        state.redmine.error = error instanceof Error ? error.message : 'Redmine недоступен.';
      });
    }
  }

  async save(payload: {
    baseUrl: string;
    apiKey?: string;
    defaultProjectId: string;
    defaultTrackerId: string;
    defaultPriorityId: string;
    defaultSprintId?: string;
    defaultAssigneeId?: string;
  }): Promise<AppState> {
    const baseUrl = normalizeBaseUrl(payload.baseUrl);
    if (payload.apiKey?.trim()) {
      this.store.setSecret('redmineApiKey', payload.apiKey.trim());
    }
    const apiKey = payload.apiKey?.trim() || this.store.getSecret('redmineApiKey');
    const assignableUsers = apiKey && payload.defaultProjectId
      ? await loadRedmineAssignableUsers(baseUrl, apiKey, payload.defaultProjectId).catch(() => [])
      : [];
    const sprints = apiKey && payload.defaultProjectId
      ? await loadRedmineProjectSprints(baseUrl, apiKey, payload.defaultProjectId).catch(() => [])
      : [];
    const defaultSprintId = payload.defaultSprintId && sprints.some((sprint) => sprint.id === payload.defaultSprintId)
      ? payload.defaultSprintId
      : freshestSprintId(sprints);
    const defaultAssigneeId = payload.defaultAssigneeId && (
      assignableUsers.length === 0 || assignableUsers.some((user) => user.id === payload.defaultAssigneeId)
    )
      ? payload.defaultAssigneeId
      : '';

    return this.store.setState((state) => {
      state.redmine.baseUrl = baseUrl;
      state.redmine.hasApiKey = Boolean(this.store.getSecret('redmineApiKey'));
      if (assignableUsers.length > 0) {
        state.redmine.users = assignableUsers;
      }
      state.redmine.sprints = sprints;
      state.workspace.redmineBaseUrl = baseUrl;
      state.workspace.defaultProjectId = payload.defaultProjectId;
      state.workspace.defaultTrackerId = payload.defaultTrackerId;
      state.workspace.defaultPriorityId = payload.defaultPriorityId;
      state.workspace.defaultSprintId = defaultSprintId;
      state.workspace.defaultAssigneeId = defaultAssigneeId;
      if (state.redmine.status !== 'connected') {
        state.redmine.status = 'disconnected';
      }
    });
  }

  async loadProjectUsers(payload: { projectId: string }): Promise<AppState> {
    const state = this.store.getState();
    const apiKey = this.store.getSecret('redmineApiKey');
    if (!apiKey) {
      return this.store.setState((draftState) => {
        draftState.redmine.status = 'error';
        draftState.redmine.hasApiKey = false;
        draftState.redmine.error = 'Redmine API key не сохранен. Откройте настройки Redmine и сохраните ключ заново.';
        draftState.redmine.users = [];
      });
    }
    if (!payload.projectId) {
      return this.store.setState((draftState) => {
        draftState.redmine.users = [];
        draftState.redmine.sprints = [];
        draftState.workspace.defaultSprintId = '';
        draftState.workspace.defaultAssigneeId = '';
      });
    }

    try {
      const [usersResult, sprintsResult] = await Promise.allSettled([
        loadRedmineAssignableUsers(state.workspace.redmineBaseUrl, apiKey, payload.projectId),
        loadRedmineProjectSprints(state.workspace.redmineBaseUrl, apiKey, payload.projectId)
      ]);
      const users = usersResult.status === 'fulfilled' ? usersResult.value : [];
      const sprints = sprintsResult.status === 'fulfilled' ? sprintsResult.value : [];
      return this.store.setState((draftState) => {
        draftState.redmine.users = users;
        draftState.redmine.sprints = sprints;
        draftState.workspace.defaultSprintId = freshestSprintId(sprints);
        if (!users.some((user) => user.id === draftState.workspace.defaultAssigneeId)) {
          draftState.workspace.defaultAssigneeId = '';
        }
        const errors = [usersResult, sprintsResult]
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => result.reason instanceof Error ? result.reason.message : 'Не удалось загрузить данные проекта.');
        draftState.redmine.error = errors.length > 0 ? errors.join(' ') : null;
      });
    } catch (error) {
      return this.store.setState((draftState) => {
        draftState.redmine.users = [];
        draftState.redmine.sprints = [];
        draftState.redmine.error =
          error instanceof Error ? error.message : 'Не удалось загрузить исполнителей и спринты проекта.';
      });
    }
  }

  async selectProject(payload: { projectId: string }): Promise<AppState> {
    const state = this.store.getState();
    const apiKey = this.store.getSecret('redmineApiKey');
    if (!apiKey) {
      return this.store.setState((draftState) => {
        draftState.redmine.status = 'error';
        draftState.redmine.hasApiKey = false;
        draftState.redmine.error = 'Redmine API key не сохранен. Откройте настройки Redmine и сохраните ключ заново.';
        draftState.redmine.users = [];
      });
    }

    if (!payload.projectId) {
      return this.store.setState((draftState) => {
        draftState.workspace.defaultProjectId = '';
        draftState.workspace.defaultSprintId = '';
        draftState.workspace.defaultAssigneeId = '';
        draftState.redmine.users = [];
        draftState.redmine.sprints = [];
      });
    }

    const [usersResult, sprintsResult] = await Promise.allSettled([
      loadRedmineAssignableUsers(state.workspace.redmineBaseUrl, apiKey, payload.projectId),
      loadRedmineProjectSprints(state.workspace.redmineBaseUrl, apiKey, payload.projectId)
    ]);
    const users = usersResult.status === 'fulfilled' ? usersResult.value : [];
    const sprints = sprintsResult.status === 'fulfilled' ? sprintsResult.value : [];

    return this.store.setState((draftState) => {
      draftState.workspace.defaultProjectId = payload.projectId;
      draftState.redmine.users = users;
      draftState.redmine.sprints = sprints;
      draftState.workspace.defaultSprintId =
        draftState.workspace.defaultSprintId && sprints.some((sprint) => sprint.id === draftState.workspace.defaultSprintId)
          ? draftState.workspace.defaultSprintId
          : freshestSprintId(sprints);
      if (!users.some((user) => user.id === draftState.workspace.defaultAssigneeId)) {
        draftState.workspace.defaultAssigneeId = '';
      }
      const errors = [usersResult, sprintsResult]
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason instanceof Error ? result.reason.message : 'Не удалось загрузить данные проекта.');
      draftState.redmine.error = errors.length > 0 ? errors.join(' ') : null;
    });
  }

  async loadMyIssues(payload: { projectId: string; sprintId: string }): Promise<RedmineIssueListResponse> {
    this.ensureMyIssuesPayload(payload);
    if (!payload.sprintId) {
      return { issues: [], source: 'redmine', syncedAt: null };
    }

    const cached = this.store.loadCachedRedmineIssues(payload);
    if (cached.issues.length > 0 || cached.syncedAt) {
      return { issues: cached.issues, source: 'cache', syncedAt: cached.syncedAt };
    }

    return this.syncMyIssues(payload);
  }

  async syncMyIssues(payload: { projectId: string; sprintId: string }): Promise<RedmineIssueListResponse> {
    this.ensureMyIssuesPayload(payload);
    if (!payload.sprintId) {
      return { issues: [], source: 'redmine', syncedAt: null };
    }

    const state = this.store.getState();
    const apiKey = this.store.getSecret('redmineApiKey');
    if (!apiKey) {
      throw new Error('Redmine API key не сохранен. Откройте настройки Redmine и сохраните ключ заново.');
    }

    try {
      const issues = await loadRedmineMyIssues(state.workspace.redmineBaseUrl, apiKey, payload);
      const syncedAt = this.store.saveRedmineIssues({ ...payload, issues });
      return { issues, source: 'redmine', syncedAt };
    } catch (error) {
      const cached = this.store.loadCachedRedmineIssues(payload);
      return {
        issues: cached.issues,
        source: cached.issues.length > 0 || cached.syncedAt ? 'cache' : 'redmine',
        syncedAt: cached.syncedAt,
        error: error instanceof Error ? error.message : 'Не удалось синхронизировать задачи Redmine.'
      };
    }
  }

  async createIssue(payload: CreateRedmineIssuePayload): Promise<RedmineIssueSummary> {
    this.ensureMyIssuesPayload(payload);
    const subject = payload.subject.trim();
    if (!subject) {
      throw new Error('Введите название задачи.');
    }

    const state = this.store.getState();
    const apiKey = this.store.getSecret('redmineApiKey');
    if (!apiKey) {
      throw new Error('Redmine API key не сохранен. Откройте настройки Redmine и сохраните ключ заново.');
    }

    const issue = await createRedmineIssue(state.workspace.redmineBaseUrl, apiKey, {
      ...payload,
      subject
    });
    const createdAt = new Date().toISOString();
    const summary: RedmineIssueSummary = {
      id: issue.id,
      subject,
      statusId: payload.statusId ?? '',
      status: payload.status ?? '',
      tracker: payload.tracker ?? state.redmine.trackers.find((tracker) => tracker.id === payload.trackerId)?.name ?? '',
      priority: payload.priority ?? state.redmine.priorities.find((priority) => priority.id === payload.priorityId)?.name ?? '',
      assignee: payload.assignee ?? state.redmine.users.find((user) => user.id === payload.assigneeId)?.name ?? '',
      dueDate: '',
      updatedOn: createdAt,
      url: new URL(`issues/${issue.id}`, normalizeBaseUrl(state.workspace.redmineBaseUrl)).toString()
    };

    if (payload.sprintId) {
      const cached = this.store.loadCachedRedmineIssues(payload);
      this.store.saveRedmineIssues({
        projectId: payload.projectId,
        sprintId: payload.sprintId,
        issues: [summary, ...cached.issues.filter((cachedIssue) => cachedIssue.id !== summary.id)],
        syncedAt: cached.syncedAt ?? createdAt
      });
    }

    return summary;
  }

  async loadIssueDetails(issueId: string): Promise<Record<string, unknown>> {
    const state = this.store.getState();
    const apiKey = this.store.getSecret('redmineApiKey');
    if (!apiKey) {
      throw new Error('Redmine API key не сохранен. Откройте настройки Redmine и сохраните ключ заново.');
    }
    if (!issueId) {
      throw new Error('Задача Redmine не выбрана.');
    }

    return loadRedmineIssueDetails(state.workspace.redmineBaseUrl, apiKey, issueId);
  }

  async updateIssueDetails(payload: UpdateRedmineIssueDetailsPayload): Promise<Record<string, unknown>> {
    const subject = payload.subject.trim();
    if (!payload.issueId) {
      throw new Error('Задача Redmine не выбрана.');
    }
    if (!subject) {
      throw new Error('Введите название задачи.');
    }

    const state = this.store.getState();
    const apiKey = this.store.getSecret('redmineApiKey');
    if (!apiKey) {
      throw new Error('Redmine API key не сохранен. Откройте настройки Redmine и сохраните ключ заново.');
    }

    await updateRedmineIssueDetails(state.workspace.redmineBaseUrl, apiKey, {
      ...payload,
      subject
    });
    return loadRedmineIssueDetails(state.workspace.redmineBaseUrl, apiKey, payload.issueId);
  }

  async updateIssueAssignee(payload: UpdateRedmineIssueAssigneePayload): Promise<Record<string, unknown>> {
    if (!payload.issueId) {
      throw new Error('Задача Redmine не выбрана.');
    }

    const state = this.store.getState();
    const apiKey = this.store.getSecret('redmineApiKey');
    if (!apiKey) {
      throw new Error('Redmine API key не сохранен. Откройте настройки Redmine и сохраните ключ заново.');
    }

    const assigneeName = payload.assignee
      ?? state.redmine.users.find((user) => user.id === payload.assigneeId)?.name
      ?? '';
    const previous = payload.projectId && payload.sprintId
      ? this.store.updateCachedRedmineIssueAssignee({
          projectId: payload.projectId,
          sprintId: payload.sprintId,
          issueId: payload.issueId,
          assignee: assigneeName
        })
      : null;

    try {
      await updateRedmineIssueAssignee(state.workspace.redmineBaseUrl, apiKey, payload);
    } catch (error) {
      if (payload.projectId && payload.sprintId && previous) {
        this.store.updateCachedRedmineIssueAssignee({
          projectId: payload.projectId,
          sprintId: payload.sprintId,
          issueId: payload.issueId,
          assignee: previous.assignee
        });
      }
      throw error;
    }

    return loadRedmineIssueDetails(state.workspace.redmineBaseUrl, apiKey, payload.issueId);
  }

  async updateIssueSprint(payload: UpdateRedmineIssueSprintPayload): Promise<Record<string, unknown>> {
    if (!payload.issueId) {
      throw new Error('Задача Redmine не выбрана.');
    }
    if (!payload.sprintId) {
      throw new Error('Спринт Redmine не выбран.');
    }

    const state = this.store.getState();
    const apiKey = this.store.getSecret('redmineApiKey');
    if (!apiKey) {
      throw new Error('Redmine API key не сохранен. Откройте настройки Redmine и сохраните ключ заново.');
    }

    await updateRedmineIssueSprint(state.workspace.redmineBaseUrl, apiKey, payload);
    const details = await loadRedmineIssueDetails(state.workspace.redmineBaseUrl, apiKey, payload.issueId);
    if (payload.projectId && payload.previousSprintId && payload.previousSprintId !== payload.sprintId) {
      const issue = this.issueSummaryFromDetails(state.workspace.redmineBaseUrl, details, payload.issueId);
      this.store.moveCachedRedmineIssue({
        projectId: payload.projectId,
        previousSprintId: payload.previousSprintId,
        sprintId: payload.sprintId,
        issue
      });
    }
    return details;
  }

  async deleteIssue(payload: DeleteRedmineIssuePayload): Promise<void> {
    if (!payload.issueId) {
      throw new Error('Задача Redmine не выбрана.');
    }

    const state = this.store.getState();
    const apiKey = this.store.getSecret('redmineApiKey');
    if (!apiKey) {
      throw new Error('Redmine API key не сохранен. Откройте настройки Redmine и сохраните ключ заново.');
    }

    await deleteRedmineIssue(state.workspace.redmineBaseUrl, apiKey, payload);
    if (payload.projectId && payload.sprintId) {
      this.store.deleteCachedRedmineIssue({
        projectId: payload.projectId,
        sprintId: payload.sprintId,
        issueId: payload.issueId
      });
    }
  }

  async addIssueComment(payload: AddRedmineIssueCommentPayload): Promise<Record<string, unknown>> {
    const notes = payload.notes.trim();
    if (!payload.issueId) {
      throw new Error('Задача Redmine не выбрана.');
    }
    if (!notes) {
      throw new Error('Введите комментарий.');
    }

    const state = this.store.getState();
    const apiKey = this.store.getSecret('redmineApiKey');
    if (!apiKey) {
      throw new Error('Redmine API key не сохранен. Откройте настройки Redmine и сохраните ключ заново.');
    }

    await addRedmineIssueComment(state.workspace.redmineBaseUrl, apiKey, {
      issueId: payload.issueId,
      notes
    });
    return loadRedmineIssueDetails(state.workspace.redmineBaseUrl, apiKey, payload.issueId);
  }

  async updateIssueJournal(payload: UpdateRedmineIssueJournalPayload): Promise<Record<string, unknown>> {
    const notes = payload.notes.trim();
    if (!payload.issueId || !payload.journalId) {
      throw new Error('Комментарий Redmine не выбран.');
    }
    if (!notes) {
      throw new Error('Введите текст комментария.');
    }

    const state = this.store.getState();
    const apiKey = this.store.getSecret('redmineApiKey');
    if (!apiKey) {
      throw new Error('Redmine API key не сохранен. Откройте настройки Redmine и сохраните ключ заново.');
    }

    try {
      await updateRedmineIssueJournal(state.workspace.redmineBaseUrl, apiKey, {
        issueId: payload.issueId,
        journalId: payload.journalId,
        notes
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('Redmine 404') || message.includes('Redmine 405')) {
        throw new Error('Этот Redmine не поддерживает редактирование комментариев через API или нет прав на комментарий.');
      }
      throw error;
    }

    return loadRedmineIssueDetails(state.workspace.redmineBaseUrl, apiKey, payload.issueId);
  }

  async updateIssueStatus(payload: {
    issueId: string;
    statusId: string;
    status?: string;
    projectId?: string;
    sprintId?: string;
  }): Promise<Record<string, unknown>> {
    const state = this.store.getState();
    const apiKey = this.store.getSecret('redmineApiKey');
    if (!apiKey) {
      throw new Error('Redmine API key не сохранен. Откройте настройки Redmine и сохраните ключ заново.');
    }
    if (!payload.issueId || !payload.statusId) {
      throw new Error('Не выбран статус задачи Redmine.');
    }

    const statusName = payload.status
      ?? state.redmine.statuses.find((status) => status.id === payload.statusId)?.name
      ?? payload.statusId;
    const previous = payload.projectId && payload.sprintId
      ? this.store.updateCachedRedmineIssueStatus({
          projectId: payload.projectId,
          sprintId: payload.sprintId,
          issueId: payload.issueId,
          statusId: payload.statusId,
          status: statusName
        })
      : null;

    try {
      await updateRedmineIssueStatus(state.workspace.redmineBaseUrl, apiKey, payload);
    } catch (error) {
      if (payload.projectId && payload.sprintId && previous) {
        this.store.updateCachedRedmineIssueStatus({
          projectId: payload.projectId,
          sprintId: payload.sprintId,
          issueId: payload.issueId,
          statusId: previous.statusId,
          status: previous.status
        });
      }
      throw error;
    }

    const fallbackDetails = {
      issue: {
        id: Number(payload.issueId) || payload.issueId,
        status: { id: Number(payload.statusId) || payload.statusId, name: statusName },
        updated_on: new Date().toISOString()
      }
    };

    const details = await loadRedmineIssueDetails(state.workspace.redmineBaseUrl, apiKey, payload.issueId)
      .catch(() => fallbackDetails);

    if (payload.projectId && payload.sprintId) {
      const issue = this.issueSummaryFromDetails(state.workspace.redmineBaseUrl, details, payload.issueId);
      this.store.updateCachedRedmineIssueStatus({
        projectId: payload.projectId,
        sprintId: payload.sprintId,
        issueId: payload.issueId,
        statusId: issue.statusId || payload.statusId,
        status: issue.status || statusName
      });
    }

    return details;
  }

  private ensureMyIssuesPayload(payload: { projectId: string; sprintId: string }): void {
    if (!payload.projectId) {
      throw new Error('Проект Redmine не выбран. Откройте настройки и выберите проект.');
    }
  }

  private issueSummaryFromDetails(baseUrl: string, details: Record<string, unknown>, issueId: string): RedmineIssueSummary {
    const issue = details.issue && typeof details.issue === 'object' && !Array.isArray(details.issue)
      ? details.issue as Record<string, unknown>
      : {};
    const named = (value: unknown) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        return typeof record.name === 'string' ? record.name : '';
      }
      return '';
    };
    const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';

    return {
      id: text(issue.id) || issueId,
      subject: text(issue.subject),
      tracker: named(issue.tracker),
      statusId: text((issue.status as { id?: unknown } | undefined)?.id),
      status: named(issue.status),
      priority: named(issue.priority),
      assignee: named(issue.assigned_to),
      dueDate: text(issue.due_date),
      updatedOn: text(issue.updated_on) || new Date().toISOString(),
      url: new URL(`issues/${text(issue.id) || issueId}`, normalizeBaseUrl(baseUrl)).toString()
    };
  }

  disconnect(): AppState {
    this.store.deleteSecret('redmineApiKey');
    return this.store.setState((state) => {
      state.redmine = defaultState().redmine;
      state.workspace.redmineBaseUrl = redmineDefaultUrl;
      state.workspace.defaultProjectId = '';
      state.workspace.defaultTrackerId = '';
      state.workspace.defaultPriorityId = '';
      state.workspace.defaultSprintId = '';
      state.workspace.defaultAssigneeId = '';
    });
  }
}
