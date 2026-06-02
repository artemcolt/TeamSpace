import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { now } from '../domain/appState';
import type { RedmineIssueSummary } from '../domain/types';

export class LocalRedmineDatabase {
  private dbPath = '';
  private db: import('sql.js').Database | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  async initialize(dataDir: string): Promise<void> {
    this.dbPath = path.join(dataDir, 'redmine-cache.sqlite');
    const SQL = await initSqlJs({
      locateFile: (file) => require.resolve(`sql.js/dist/${file}`)
    });
    const bytes = fs.existsSync(this.dbPath) ? fs.readFileSync(this.dbPath) : undefined;
    this.db = bytes ? new SQL.Database(bytes) : new SQL.Database();
    this.migrate();
    this.flush();
  }

  loadIssues(payload: { projectId: string; sprintId: string }): { issues: RedmineIssueSummary[]; syncedAt: string | null } {
    if (!this.db || !payload.projectId || !payload.sprintId) {
      return { issues: [], syncedAt: null };
    }

    const rows = this.rows<{
      id: string;
      subject: string;
      status_id: string;
      status: string;
      tracker: string;
      priority: string;
      assignee: string;
      due_date: string;
      updated_on: string;
      url: string;
      synced_at: string;
    }>(
      `select id, subject, status_id, status, tracker, priority, assignee, due_date, updated_on, url, synced_at
       from redmine_issues
       where project_id = ? and sprint_id = ?
       order by datetime(updated_on) desc, id desc`,
      [payload.projectId, payload.sprintId]
    );

    const syncRow = this.rows<{ synced_at: string }>(
      `select synced_at
       from redmine_issue_syncs
       where project_id = ? and sprint_id = ?`,
      [payload.projectId, payload.sprintId]
    )[0];

    return {
      issues: rows.map((row) => ({
        id: row.id,
        subject: row.subject,
        statusId: row.status_id,
        status: row.status,
        tracker: row.tracker,
        priority: row.priority,
        assignee: row.assignee,
        dueDate: row.due_date,
        updatedOn: row.updated_on,
        url: row.url
      })),
      syncedAt: syncRow?.synced_at ?? rows[0]?.synced_at ?? null
    };
  }

  saveIssues(payload: { projectId: string; sprintId: string; issues: RedmineIssueSummary[]; syncedAt?: string }): string {
    if (!this.db || !payload.projectId || !payload.sprintId) {
      return payload.syncedAt ?? now();
    }

    const syncedAt = payload.syncedAt ?? now();
    this.db.run('begin');
    try {
      this.db.run('delete from redmine_issues where project_id = ? and sprint_id = ?', [
        payload.projectId,
        payload.sprintId
      ]);
      this.db.run(
        `insert into redmine_issue_syncs (project_id, sprint_id, synced_at)
         values (?, ?, ?)
         on conflict(project_id, sprint_id) do update set synced_at = excluded.synced_at`,
        [payload.projectId, payload.sprintId, syncedAt]
      );
      for (const issue of payload.issues) {
        this.db.run(
          `insert into redmine_issues
             (id, project_id, sprint_id, subject, status_id, status, tracker, priority, assignee, due_date, updated_on, url, synced_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            issue.id,
            payload.projectId,
            payload.sprintId,
            issue.subject,
            issue.statusId,
            issue.status,
            issue.tracker,
            issue.priority,
            issue.assignee,
            issue.dueDate,
            issue.updatedOn,
            issue.url,
            syncedAt
          ]
        );
      }
      this.db.run('commit');
      this.scheduleFlush();
      return syncedAt;
    } catch (error) {
      this.db.run('rollback');
      throw error;
    }
  }

  updateIssueStatus(payload: {
    projectId: string;
    sprintId: string;
    issueId: string;
    statusId: string;
    status: string;
  }): RedmineIssueSummary | null {
    if (!this.db || !payload.projectId || !payload.sprintId || !payload.issueId) {
      return null;
    }

    const previous = this.loadIssues(payload).issues.find((issue) => issue.id === payload.issueId) ?? null;
    this.db.run(
      `update redmine_issues
       set status_id = ?, status = ?
       where project_id = ? and sprint_id = ? and id = ?`,
      [payload.statusId, payload.status, payload.projectId, payload.sprintId, payload.issueId]
    );
    this.scheduleFlush();
    return previous;
  }

  updateIssueAssignee(payload: {
    projectId: string;
    sprintId: string;
    issueId: string;
    assignee: string;
  }): RedmineIssueSummary | null {
    if (!this.db || !payload.projectId || !payload.sprintId || !payload.issueId) {
      return null;
    }

    const previous = this.loadIssues(payload).issues.find((issue) => issue.id === payload.issueId) ?? null;
    this.db.run(
      `update redmine_issues
       set assignee = ?
       where project_id = ? and sprint_id = ? and id = ?`,
      [payload.assignee, payload.projectId, payload.sprintId, payload.issueId]
    );
    this.scheduleFlush();
    return previous;
  }

  deleteIssue(payload: {
    projectId: string;
    sprintId: string;
    issueId: string;
  }): RedmineIssueSummary | null {
    if (!this.db || !payload.projectId || !payload.sprintId || !payload.issueId) {
      return null;
    }

    const previous = this.loadIssues(payload).issues.find((issue) => issue.id === payload.issueId) ?? null;
    this.db.run(
      `delete from redmine_issues
       where project_id = ? and sprint_id = ? and id = ?`,
      [payload.projectId, payload.sprintId, payload.issueId]
    );
    this.scheduleFlush();
    return previous;
  }

  clear(): void {
    if (!this.db) {
      return;
    }
    this.db.run('delete from redmine_issues');
    this.db.run('delete from redmine_issue_syncs');
    this.flush();
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.writeToDisk();
  }

  private migrate(): void {
    if (!this.db) {
      return;
    }

    this.db.run(`
      create table if not exists redmine_issues (
        id text not null,
        project_id text not null,
        sprint_id text not null,
        subject text not null,
        status_id text not null,
        status text not null,
        tracker text not null,
        priority text not null,
        assignee text not null,
        due_date text not null,
        updated_on text not null,
        url text not null,
        synced_at text not null,
        primary key (id, project_id, sprint_id)
      );
    `);
    this.db.run(`
      create table if not exists redmine_issue_syncs (
        project_id text not null,
        sprint_id text not null,
        synced_at text not null,
        primary key (project_id, sprint_id)
      );
    `);
    this.db.run('create index if not exists idx_redmine_issues_project_sprint on redmine_issues(project_id, sprint_id)');
    this.db.run('create index if not exists idx_redmine_issues_status on redmine_issues(status_id)');
  }

  private rows<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    if (!this.db) {
      return [];
    }

    const [result] = this.db.exec(sql, params);
    if (!result) {
      return [];
    }

    return result.values.map((valueRow) => {
      const row: Record<string, unknown> = {};
      result.columns.forEach((column, index) => {
        row[column] = valueRow[index];
      });
      return row as T;
    });
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.writeToDiskAsync();
    }, 300);
  }

  private async writeToDiskAsync(): Promise<void> {
    if (!this.db) {
      return;
    }
    try {
      await fs.promises.writeFile(this.dbPath, Buffer.from(this.db.export()));
    } catch (error) {
      console.warn('Failed to flush Redmine cache:', error);
    }
  }

  private writeToDisk(): void {
    if (!this.db) {
      return;
    }
    fs.writeFileSync(this.dbPath, Buffer.from(this.db.export()));
  }
}
