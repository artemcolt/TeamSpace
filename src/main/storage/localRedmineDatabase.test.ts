import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalRedmineDatabase } from './localRedmineDatabase';

const tempDirs: string[] = [];

describe('LocalRedmineDatabase', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists Redmine issues by project and sprint and updates cached fields locally', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-space-redmine-cache-'));
    tempDirs.push(dataDir);
    const db = new LocalRedmineDatabase();
    await db.initialize(dataDir);

    const syncedAt = db.saveIssues({
      projectId: '9',
      sprintId: 'version:42',
      syncedAt: '2026-05-28T09:00:00.000Z',
      issues: [
        {
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
        }
      ]
    });

    expect(syncedAt).toBe('2026-05-28T09:00:00.000Z');
    expect(db.loadIssues({ projectId: '9', sprintId: 'version:42' })).toMatchObject({
      syncedAt: '2026-05-28T09:00:00.000Z',
      issues: [{ id: '21', statusId: '1', status: 'New' }]
    });
    expect(db.loadIssues({ projectId: '9', sprintId: 'version:43' }).issues).toEqual([]);

    const previous = db.updateIssueStatus({
      projectId: '9',
      sprintId: 'version:42',
      issueId: '21',
      statusId: '2',
      status: 'In Progress'
    });

    expect(previous).toMatchObject({ id: '21', statusId: '1', status: 'New' });
    expect(db.loadIssues({ projectId: '9', sprintId: 'version:42' }).issues[0]).toMatchObject({
      id: '21',
      statusId: '2',
      status: 'In Progress'
    });

    const previousAssignee = db.updateIssueAssignee({
      projectId: '9',
      sprintId: 'version:42',
      issueId: '21',
      assignee: 'Новый исполнитель'
    });

    expect(previousAssignee).toMatchObject({ id: '21', assignee: 'Иван' });
    expect(db.loadIssues({ projectId: '9', sprintId: 'version:42' }).issues[0]).toMatchObject({
      id: '21',
      assignee: 'Новый исполнитель'
    });

    const deleted = db.deleteIssue({
      projectId: '9',
      sprintId: 'version:42',
      issueId: '21'
    });

    expect(deleted).toMatchObject({ id: '21', assignee: 'Новый исполнитель' });
    expect(db.loadIssues({ projectId: '9', sprintId: 'version:42' }).issues).toEqual([]);
  });

  it('replaces stale Redmine issues with the latest sync result', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-space-redmine-cache-'));
    tempDirs.push(dataDir);
    const db = new LocalRedmineDatabase();
    await db.initialize(dataDir);

    db.saveIssues({
      projectId: '9',
      sprintId: 'version:42',
      syncedAt: '2026-05-28T08:00:00.000Z',
      issues: [
        {
          id: '15662',
          subject: 'Stale task',
          tracker: 'Task',
          statusId: '1',
          status: 'New',
          priority: 'Normal',
          assignee: 'Иван',
          dueDate: '2026-05-21',
          updatedOn: '2026-05-21T08:30:00.000Z',
          url: 'https://redmine.example/issues/15662'
        }
      ]
    });

    db.saveIssues({
      projectId: '9',
      sprintId: 'version:42',
      syncedAt: '2026-05-28T09:00:00.000Z',
      issues: [
        {
          id: '15920',
          subject: 'Fresh task',
          tracker: 'Task',
          statusId: '1',
          status: 'New',
          priority: 'Normal',
          assignee: 'Иван',
          dueDate: '2026-06-02',
          updatedOn: '2026-05-28T09:00:00.000Z',
          url: 'https://redmine.example/issues/15920'
        }
      ]
    });

    expect(db.loadIssues({ projectId: '9', sprintId: 'version:42' })).toMatchObject({
      syncedAt: '2026-05-28T09:00:00.000Z',
      issues: [{ id: '15920', subject: 'Fresh task' }]
    });
    expect(db.loadIssues({ projectId: '9', sprintId: 'version:42' }).issues.map((issue) => issue.id)).not.toContain(
      '15662'
    );
  });

  it('keeps Redmine issue caches separate by assignee', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-space-redmine-cache-'));
    tempDirs.push(dataDir);
    const db = new LocalRedmineDatabase();
    await db.initialize(dataDir);

    db.saveIssues({
      projectId: '9',
      sprintId: 'version:42',
      assigneeId: '7',
      issues: [
        {
          id: '21',
          subject: 'Artem task',
          tracker: 'Task',
          statusId: '1',
          status: 'New',
          priority: 'Normal',
          assignee: 'Артем',
          dueDate: '',
          updatedOn: '2026-05-28T08:30:00.000Z',
          url: 'https://redmine.example/issues/21'
        }
      ]
    });
    db.saveIssues({
      projectId: '9',
      sprintId: 'version:42',
      assigneeId: '9',
      issues: [
        {
          id: '22',
          subject: 'Other task',
          tracker: 'Task',
          statusId: '1',
          status: 'New',
          priority: 'Normal',
          assignee: 'Иван',
          dueDate: '',
          updatedOn: '2026-05-28T08:30:00.000Z',
          url: 'https://redmine.example/issues/22'
        }
      ]
    });

    expect(db.loadIssues({ projectId: '9', sprintId: 'version:42', assigneeId: '7' }).issues).toMatchObject([
      { id: '21', assignee: 'Артем' }
    ]);
    expect(db.loadIssues({ projectId: '9', sprintId: 'version:42', assigneeId: '9' }).issues).toMatchObject([
      { id: '22', assignee: 'Иван' }
    ]);
  });

  it('keeps sync metadata when the latest Redmine sync returns no issues', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-space-redmine-cache-'));
    tempDirs.push(dataDir);
    const db = new LocalRedmineDatabase();
    await db.initialize(dataDir);

    db.saveIssues({
      projectId: '9',
      sprintId: 'version:42',
      syncedAt: '2026-05-28T08:00:00.000Z',
      issues: [
        {
          id: '15662',
          subject: 'Stale task',
          tracker: 'Task',
          statusId: '1',
          status: 'New',
          priority: 'Normal',
          assignee: 'Иван',
          dueDate: '2026-05-21',
          updatedOn: '2026-05-21T08:30:00.000Z',
          url: 'https://redmine.example/issues/15662'
        }
      ]
    });

    db.saveIssues({
      projectId: '9',
      sprintId: 'version:42',
      syncedAt: '2026-05-28T09:00:00.000Z',
      issues: []
    });

    expect(db.loadIssues({ projectId: '9', sprintId: 'version:42' })).toEqual({
      syncedAt: '2026-05-28T09:00:00.000Z',
      issues: []
    });
  });
});
