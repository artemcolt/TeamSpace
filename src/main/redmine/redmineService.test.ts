import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RedmineIssueSummary } from '../domain/types';
import type { LocalStore } from '../storage/localStore';
import { RedmineService } from './redmineService';
import {
  deleteRedmineIssue,
  loadRedmineAssignableUsers,
  loadRedmineIssueDetails,
  loadRedmineMyIssues,
  loadRedmineProjectSprints,
  updateRedmineIssueAssignee,
  updateRedmineIssueSprint,
  updateRedmineIssueStatus
} from './redmineClient';

vi.mock('./redmineClient', () => ({
  deleteRedmineIssue: vi.fn(),
  fetchRedmineJson: vi.fn(),
  loadRedmineAssignableUsers: vi.fn(),
  loadRedmineCatalogs: vi.fn(),
  loadRedmineIssueDetails: vi.fn(),
  loadRedmineMyIssues: vi.fn(),
  loadRedmineProjectSprints: vi.fn(),
  updateRedmineIssueAssignee: vi.fn(),
  updateRedmineIssueSprint: vi.fn(),
  updateRedmineIssueStatus: vi.fn()
}));

const cachedIssue: RedmineIssueSummary = {
  id: '21',
  subject: 'Cached task',
  tracker: 'Task',
  statusId: '1',
  status: 'New',
  priority: 'Normal',
  assignee: 'Иван',
  dueDate: '2026-06-02',
  updatedOn: '2026-05-28T08:30:00.000Z',
  url: 'https://redmine.example/issues/21'
};

const freshIssue: RedmineIssueSummary = {
  ...cachedIssue,
  subject: 'Fresh task',
  statusId: '2',
  status: 'In Progress'
};

function createStore(overrides: Partial<LocalStore> = {}) {
  return {
    getState: vi.fn(() => ({
      workspace: { redmineBaseUrl: 'https://redmine.example/' },
      redmine: {
        statuses: [{ id: '2', name: 'In Progress' }],
        users: [{ id: '7', name: 'Новый исполнитель' }]
      }
    })),
    getSecret: vi.fn(() => 'test-api-key'),
    loadCachedRedmineIssues: vi.fn(() => ({ issues: [], syncedAt: null })),
    saveRedmineIssues: vi.fn(() => '2026-05-28T09:00:00.000Z'),
    deleteCachedRedmineIssue: vi.fn(() => cachedIssue),
    moveCachedRedmineIssue: vi.fn(),
    updateCachedRedmineIssueStatus: vi.fn(() => cachedIssue),
    updateCachedRedmineIssueAssignee: vi.fn(() => cachedIssue),
    ...overrides
  } as unknown as LocalStore;
}

describe('RedmineService issue cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadRedmineIssueDetails).mockResolvedValue({
      issue: {
        id: 21,
        status: { id: 2, name: 'In Progress' },
        updated_on: '2026-06-01T10:00:00.000Z'
      }
    });
  });

  it('returns cached issues without requesting Redmine when cache exists', async () => {
    const store = createStore({
      loadCachedRedmineIssues: vi.fn(() => ({
        issues: [cachedIssue],
        syncedAt: '2026-05-28T08:00:00.000Z'
      }))
    });
    const service = new RedmineService(store);

    await expect(service.loadMyIssues({ projectId: '9', sprintId: 'version:42' })).resolves.toEqual({
      issues: [cachedIssue],
      source: 'cache',
      syncedAt: '2026-05-28T08:00:00.000Z'
    });
    expect(loadRedmineMyIssues).not.toHaveBeenCalled();
  });

  it('returns an empty cached sync result without blocking on Redmine', async () => {
    const store = createStore({
      loadCachedRedmineIssues: vi.fn(() => ({
        issues: [],
        syncedAt: '2026-05-28T08:00:00.000Z'
      }))
    });
    const service = new RedmineService(store);

    await expect(service.loadMyIssues({ projectId: '9', sprintId: 'version:42' })).resolves.toEqual({
      issues: [],
      source: 'cache',
      syncedAt: '2026-05-28T08:00:00.000Z'
    });
    expect(loadRedmineMyIssues).not.toHaveBeenCalled();
  });

  it('treats an empty cached sync as fallback data when Redmine sync fails', async () => {
    vi.mocked(loadRedmineMyIssues).mockRejectedValueOnce(new Error('Redmine 503: Unavailable'));
    const store = createStore({
      loadCachedRedmineIssues: vi.fn(() => ({
        issues: [],
        syncedAt: '2026-05-28T08:00:00.000Z'
      }))
    });
    const service = new RedmineService(store);

    await expect(service.syncMyIssues({ projectId: '9', sprintId: 'version:42' })).resolves.toEqual({
      issues: [],
      source: 'cache',
      syncedAt: '2026-05-28T08:00:00.000Z',
      error: 'Redmine 503: Unavailable'
    });
  });

  it('saves successful Redmine sync results into the local cache', async () => {
    vi.mocked(loadRedmineMyIssues).mockResolvedValueOnce([freshIssue]);
    const store = createStore();
    const service = new RedmineService(store);

    await expect(service.syncMyIssues({ projectId: '9', sprintId: 'version:42' })).resolves.toEqual({
      issues: [freshIssue],
      source: 'redmine',
      syncedAt: '2026-05-28T09:00:00.000Z'
    });
    expect(store.saveRedmineIssues).toHaveBeenCalledWith({
      projectId: '9',
      sprintId: 'version:42',
      issues: [freshIssue]
    });
  });

  it('selects an active project and refreshes its sprint and assignee catalogs', async () => {
    vi.mocked(loadRedmineAssignableUsers).mockResolvedValueOnce([{ id: '9', name: 'Mobile User' }]);
    vi.mocked(loadRedmineProjectSprints).mockResolvedValueOnce([{ id: '8', name: 'Mobile Sprint' }]);
    const draftState = {
      workspace: {
        redmineBaseUrl: 'https://redmine.example/',
        defaultProjectId: '1',
        defaultSprintId: '4',
        defaultAssigneeId: '7'
      },
      redmine: {
        users: [{ id: '7', name: 'Иван' }],
        sprints: [{ id: '4', name: 'Sprint 42' }],
        error: 'Old error'
      }
    };
    const store = createStore({
      setState: vi.fn((updater) => {
        updater(draftState as never);
        return draftState;
      })
    });
    const service = new RedmineService(store);

    await expect(service.selectProject({ projectId: '5' })).resolves.toBe(draftState);
    expect(loadRedmineAssignableUsers).toHaveBeenCalledWith('https://redmine.example/', 'test-api-key', '5');
    expect(loadRedmineProjectSprints).toHaveBeenCalledWith('https://redmine.example/', 'test-api-key', '5');
    expect(draftState.workspace.defaultProjectId).toBe('5');
    expect(draftState.workspace.defaultSprintId).toBe('8');
    expect(draftState.workspace.defaultAssigneeId).toBe('');
    expect(draftState.redmine.users).toEqual([{ id: '9', name: 'Mobile User' }]);
    expect(draftState.redmine.sprints).toEqual([{ id: '8', name: 'Mobile Sprint' }]);
    expect(draftState.redmine.error).toBeNull();
  });

  it('returns cached issues with error metadata when Redmine sync fails', async () => {
    vi.mocked(loadRedmineMyIssues).mockRejectedValueOnce(new Error('Redmine 503: Unavailable'));
    const store = createStore({
      loadCachedRedmineIssues: vi.fn(() => ({
        issues: [cachedIssue],
        syncedAt: '2026-05-28T08:00:00.000Z'
      }))
    });
    const service = new RedmineService(store);

    await expect(service.syncMyIssues({ projectId: '9', sprintId: 'version:42' })).resolves.toEqual({
      issues: [cachedIssue],
      source: 'cache',
      syncedAt: '2026-05-28T08:00:00.000Z',
      error: 'Redmine 503: Unavailable'
    });
  });

  it('optimistically updates local status before sending Redmine PUT', async () => {
    const store = createStore();
    const service = new RedmineService(store);

    await service.updateIssueStatus({
      projectId: '9',
      sprintId: 'version:42',
      issueId: '21',
      statusId: '2',
      status: 'In Progress'
    });

    expect(store.updateCachedRedmineIssueStatus).toHaveBeenCalledWith({
      projectId: '9',
      sprintId: 'version:42',
      issueId: '21',
      statusId: '2',
      status: 'In Progress'
    });
    expect(updateRedmineIssueStatus).toHaveBeenCalledWith('https://redmine.example/', 'test-api-key', expect.objectContaining({
      issueId: '21',
      statusId: '2'
    }));
  });

  it('keeps the cache on the actual Redmine status after a status update', async () => {
    vi.mocked(loadRedmineIssueDetails).mockResolvedValueOnce({
      issue: {
        id: 21,
        status: { id: 1, name: 'New' },
        updated_on: '2026-06-01T10:00:00.000Z'
      }
    });
    const updateCache = vi.fn(() => cachedIssue);
    const store = createStore({ updateCachedRedmineIssueStatus: updateCache });
    const service = new RedmineService(store);

    await expect(service.updateIssueStatus({
      projectId: '9',
      sprintId: 'version:42',
      issueId: '21',
      statusId: '2',
      status: 'In Progress'
    })).resolves.toMatchObject({
      issue: { status: { id: 1, name: 'New' } }
    });

    expect(updateCache).toHaveBeenNthCalledWith(2, {
      projectId: '9',
      sprintId: 'version:42',
      issueId: '21',
      statusId: '1',
      status: 'New'
    });
  });

  it('rolls back the local status when Redmine PUT fails', async () => {
    vi.mocked(updateRedmineIssueStatus).mockRejectedValueOnce(new Error('Redmine 422: invalid'));
    const updateCache = vi.fn(() => cachedIssue);
    const store = createStore({ updateCachedRedmineIssueStatus: updateCache });
    const service = new RedmineService(store);

    await expect(service.updateIssueStatus({
      projectId: '9',
      sprintId: 'version:42',
      issueId: '21',
      statusId: '2',
      status: 'In Progress'
    })).rejects.toThrow('Redmine 422: invalid');

    expect(updateCache).toHaveBeenNthCalledWith(2, {
      projectId: '9',
      sprintId: 'version:42',
      issueId: '21',
      statusId: '1',
      status: 'New'
    });
  });

  it('optimistically updates local assignee before sending Redmine PUT', async () => {
    vi.mocked(loadRedmineIssueDetails).mockResolvedValueOnce({
      issue: { id: 21, assigned_to: { id: 7, name: 'Новый исполнитель' } }
    });
    const store = createStore();
    const service = new RedmineService(store);

    await expect(service.updateIssueAssignee({
      projectId: '9',
      sprintId: 'version:42',
      issueId: '21',
      assigneeId: '7'
    })).resolves.toMatchObject({
      issue: { assigned_to: { id: 7, name: 'Новый исполнитель' } }
    });

    expect(store.updateCachedRedmineIssueAssignee).toHaveBeenCalledWith({
      projectId: '9',
      sprintId: 'version:42',
      issueId: '21',
      assignee: 'Новый исполнитель'
    });
    expect(updateRedmineIssueAssignee).toHaveBeenCalledWith('https://redmine.example/', 'test-api-key', expect.objectContaining({
      issueId: '21',
      assigneeId: '7'
    }));
  });

  it('rolls back the local assignee when Redmine PUT fails', async () => {
    vi.mocked(updateRedmineIssueAssignee).mockRejectedValueOnce(new Error('Redmine 422: invalid'));
    const updateCache = vi.fn(() => cachedIssue);
    const store = createStore({ updateCachedRedmineIssueAssignee: updateCache });
    const service = new RedmineService(store);

    await expect(service.updateIssueAssignee({
      projectId: '9',
      sprintId: 'version:42',
      issueId: '21',
      assigneeId: '7',
      assignee: 'Новый исполнитель'
    })).rejects.toThrow('Redmine 422: invalid');

    expect(updateCache).toHaveBeenNthCalledWith(2, {
      projectId: '9',
      sprintId: 'version:42',
      issueId: '21',
      assignee: 'Иван'
    });
  });

  it('moves the cached issue after changing its sprint', async () => {
    vi.mocked(loadRedmineIssueDetails).mockResolvedValueOnce({
      issue: {
        id: 21,
        subject: 'Moved task',
        tracker: { id: 2, name: 'Task' },
        status: { id: 3, name: 'Review' },
        priority: { id: 4, name: 'Normal' },
        assigned_to: { id: 7, name: 'Новый исполнитель' },
        due_date: '2026-06-02',
        updated_on: '2026-06-01T10:00:00.000Z'
      }
    });
    const store = createStore();
    const service = new RedmineService(store);

    await expect(service.updateIssueSprint({
      projectId: '9',
      previousSprintId: 'version:42',
      sprintId: 'version:43',
      issueId: '21'
    })).resolves.toMatchObject({
      issue: { id: 21, subject: 'Moved task' }
    });

    expect(updateRedmineIssueSprint).toHaveBeenCalledWith('https://redmine.example/', 'test-api-key', {
      projectId: '9',
      previousSprintId: 'version:42',
      sprintId: 'version:43',
      issueId: '21'
    });
    expect(store.moveCachedRedmineIssue).toHaveBeenCalledWith({
      projectId: '9',
      previousSprintId: 'version:42',
      sprintId: 'version:43',
      issue: expect.objectContaining({
        id: '21',
        subject: 'Moved task',
        statusId: '3',
        status: 'Review',
        assignee: 'Новый исполнитель'
      })
    });
  });

  it('deletes the Redmine issue and removes it from local cache', async () => {
    const store = createStore();
    const service = new RedmineService(store);

    await service.deleteIssue({
      projectId: '9',
      sprintId: 'version:42',
      issueId: '21'
    });

    expect(deleteRedmineIssue).toHaveBeenCalledWith('https://redmine.example/', 'test-api-key', {
      projectId: '9',
      sprintId: 'version:42',
      issueId: '21'
    });
    expect(store.deleteCachedRedmineIssue).toHaveBeenCalledWith({
      projectId: '9',
      sprintId: 'version:42',
      issueId: '21'
    });
  });
});
