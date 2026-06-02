import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRedmineIssue,
  deleteRedmineIssue,
  loadRedmineIssueDetails,
  loadRedmineMyIssues,
  loadRedmineProjectSprints,
  updateRedmineIssueAssignee,
  updateRedmineIssueSprint
} from './redmineClient';

describe('loadRedmineProjectSprints', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loads every versions page and returns only assignable open versions', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url));
      if (requestUrl.pathname.endsWith('/agile_sprints.json')) {
        return {
          ok: true,
          json: async () => ({ agile_sprints: [], total_count: 0, limit: 100, offset: 0 })
        };
      }
      if (requestUrl.pathname.endsWith('/issues.json')) {
        return {
          ok: true,
          json: async () => ({ issues: [], total_count: 0, limit: 100, offset: 0 })
        };
      }

      const offset = requestUrl.searchParams.get('offset');

      return {
        ok: true,
        json: async () => offset === '0'
          ? {
              versions: [
                { id: 1, name: 'Closed sprint', status: 'closed' },
                { id: 2, name: 'Locked sprint', status: 'locked' }
              ],
              total_count: 3,
              limit: 2,
              offset: 0
            }
          : {
              versions: [
                { id: 3, name: 'Open sprint', status: 'open', due_date: '2026-05-28' }
              ],
              total_count: 3,
              limit: 2,
              offset: 2
            }
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(loadRedmineProjectSprints('https://redmine.example/', 'test-api-key', '9')).resolves.toEqual([
      { id: 'version:3', name: 'Open sprint' }
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/projects/9/agile_sprints.json?limit=100&offset=0');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/projects/9/easy_sprints.json?limit=100&offset=0');
    expect(String(fetchMock.mock.calls[2][0])).toContain('/issues.json?project_id=9&status_id=*');
    expect(String(fetchMock.mock.calls[3][0])).toContain('/projects/9/versions.json?limit=100&offset=0');
    expect(String(fetchMock.mock.calls[4][0])).toContain('/projects/9/versions.json?limit=100&offset=2');
  });

  it('prefers Redmine Agile sprints when the plugin endpoint is available', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        agile_sprints: [
          { id: 7, name: 'Closed agile sprint', status: 'closed' },
          { id: 8, name: 'Demo Sprint 8', status: 'open', end_date: '2026-05-28' }
        ],
        total_count: 2,
        limit: 100,
        offset: 0
      })
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(loadRedmineProjectSprints('https://redmine.example/', 'test-api-key', '9')).resolves.toEqual([
      { id: 'agile:8', name: 'Demo Sprint 8' }
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses Easy Redmine sprint data from project issues when sprint endpoints are unavailable', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url));
      if (requestUrl.pathname.endsWith('/agile_sprints.json')) {
        return {
          ok: false,
          text: async () => 'Not Found',
          status: 404,
          statusText: 'Not Found'
        };
      }
      return {
        ok: true,
        json: async () => ({
          issues: [
            { id: 1, easy_sprint: { id: 185, name: 'НСИ Планер 64', due_date: '2025-11-28' } },
            { id: 2, easy_sprint: { id: 180, name: 'НСИ Планер 63', due_date: '2025-11-01' } },
            { id: 3, easy_sprint: { id: 185, name: 'НСИ Планер 64', due_date: '2025-11-28' } }
          ],
          total_count: 3,
          limit: 100,
          offset: 0
        })
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(loadRedmineProjectSprints('https://redmine.example/', 'test-api-key', '9')).resolves.toEqual([
      { id: 'easy:185', name: 'НСИ Планер 64' },
      { id: 'easy:180', name: 'НСИ Планер 63' }
    ]);
  });
});

describe('loadRedmineMyIssues', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loads version sprint issues with fixed_version_id', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        issues: [
          {
            id: 21,
            subject: 'Version task',
            tracker: { id: 1, name: 'Task' },
            status: { id: 2, name: 'New' },
            priority: { id: 3, name: 'Normal' },
            assigned_to: { id: 4, name: 'Current User' },
            due_date: '2026-06-02',
            updated_on: '2026-05-28T08:30:00Z'
          }
        ],
        total_count: 1,
        limit: 100,
        offset: 0
      })
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(
      loadRedmineMyIssues('https://redmine.example/', 'test-api-key', { projectId: '9', sprintId: 'version:42' })
    ).resolves.toEqual([
      {
        id: '21',
        subject: 'Version task',
        tracker: 'Task',
        statusId: '2',
        status: 'New',
        priority: 'Normal',
        assignee: 'Current User',
        dueDate: '2026-06-02',
        updatedOn: '2026-05-28T08:30:00Z',
        url: 'https://redmine.example/issues/21'
      }
    ]);
    const requestedUrl = String(fetchMock.mock.calls[0][0]);
    expect(requestedUrl).toContain('/issues.json?project_id=9&assigned_to_id=me&status_id=open');
    expect(requestedUrl).toContain('fixed_version_id=42');
  });

  it('filters Easy sprint issues locally by easy_sprint id', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        issues: [
          { id: 31, subject: 'Matching Easy task', easy_sprint: { id: 185 }, updated_on: '2026-05-28T08:30:00Z' },
          { id: 32, subject: 'Other Easy task', easy_sprint: { id: 180 }, updated_on: '2026-05-28T08:30:00Z' }
        ],
        total_count: 2,
        limit: 100,
        offset: 0
      })
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(
      loadRedmineMyIssues('https://redmine.example/', 'test-api-key', { projectId: '9', sprintId: 'easy:185' })
    ).resolves.toMatchObject([
      {
        id: '31',
        subject: 'Matching Easy task'
      }
    ]);
    const requestedUrl = String(fetchMock.mock.calls[0][0]);
    expect(requestedUrl).toContain('/issues.json?project_id=9&assigned_to_id=me&status_id=open');
    expect(requestedUrl).toContain('easy_sprint_id=185');
  });

  it('returns an empty issue list for an empty Redmine response', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ issues: [], total_count: 0, limit: 100, offset: 0 })
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(
      loadRedmineMyIssues('https://redmine.example/', 'test-api-key', { projectId: '9', sprintId: 'agile:7' })
    ).resolves.toEqual([]);
    expect(String(fetchMock.mock.calls[0][0])).toContain('agile_sprint_id=7');
  });

  it('propagates Redmine errors to the caller', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      text: async () => 'Forbidden',
      status: 403,
      statusText: 'Forbidden'
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(
      loadRedmineMyIssues('https://redmine.example/', 'test-api-key', { projectId: '9', sprintId: 'version:42' })
    ).rejects.toThrow('Redmine 403: Forbidden');
  });
});

describe('updateRedmineIssueAssignee', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends assigned_to_id to Redmine', async () => {
    let requestBody: unknown = null;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        text: async () => ''
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await updateRedmineIssueAssignee('https://redmine.example/', 'test-api-key', {
      issueId: '21',
      assigneeId: '7'
    });

    expect(String(fetchMock.mock.calls[0][0])).toBe('https://redmine.example/issues/21.json');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PUT' });
    expect(requestBody).toEqual({ issue: { assigned_to_id: 7 } });
  });
});

describe('updateRedmineIssueSprint', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends fixed_version_id for a Redmine version sprint', async () => {
    let requestBody: unknown = null;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        text: async () => ''
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await updateRedmineIssueSprint('https://redmine.example/', 'test-api-key', {
      issueId: '21',
      sprintId: 'version:43'
    });

    expect(String(fetchMock.mock.calls[0][0])).toBe('https://redmine.example/issues/21.json');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PUT' });
    expect(requestBody).toEqual({ issue: { fixed_version_id: 43 } });
  });

  it('sends agile sprint attributes for a Redmine Agile sprint', async () => {
    let requestBody: unknown = null;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        text: async () => ''
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await updateRedmineIssueSprint('https://redmine.example/', 'test-api-key', {
      issueId: '21',
      sprintId: 'agile:8'
    });

    expect(requestBody).toEqual({
      issue: {
        agile_data_attributes: {
          agile_sprint_id: 8
        }
      }
    });
  });
});

describe('deleteRedmineIssue', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends DELETE to the Redmine issue endpoint', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await deleteRedmineIssue('https://redmine.example/', 'test-api-key', {
      issueId: '21'
    });

    expect(String(fetchMock.mock.calls[0][0])).toBe('https://redmine.example/issues/21.json');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'DELETE' });
  });
});

describe('loadRedmineIssueDetails', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('adds data URL previews for image attachments', async () => {
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url));
      if (requestUrl.pathname.endsWith('/issues/123.json')) {
        return {
          ok: true,
          json: async () => ({
            issue: {
              id: 123,
              attachments: [
                {
                  id: 11,
                  filename: 'screenshot.png',
                  content_type: 'image/png',
                  filesize: imageBytes.byteLength,
                  content_url: 'https://redmine.example/attachments/download/11/screenshot.png'
                },
                {
                  id: 12,
                  filename: 'trace.log',
                  content_type: 'text/plain',
                  filesize: 16,
                  content_url: 'https://redmine.example/attachments/download/12/trace.log'
                }
              ]
            }
          })
        };
      }
      return {
        ok: true,
        headers: { get: () => 'image/png' },
        arrayBuffer: async () => imageBytes.buffer
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const result = await loadRedmineIssueDetails('https://redmine.example/', 'test-api-key', '123');
    const attachments = (result.issue as { attachments: Array<Record<string, unknown>> }).attachments;

    expect(attachments[0]).toMatchObject({
      filename: 'screenshot.png',
      previewDataUrl: `data:image/png;base64,${Buffer.from(imageBytes).toString('base64')}`
    });
    expect(attachments[1]).toMatchObject({ filename: 'trace.log' });
    expect(attachments[1].previewDataUrl).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('createRedmineIssue', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders image attachment references inline in the issue description', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-space-redmine-upload-'));
    const imagePath = path.join(tempDir, 'Image20260528104707_1.png');
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    try {
      let issueRequestBody: unknown = null;
      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const requestUrl = new URL(String(url));
        if (requestUrl.pathname.endsWith('/uploads.json')) {
          return {
            ok: true,
            json: async () => ({ upload: { token: 'upload-token' } })
          };
        }
        if (requestUrl.pathname.endsWith('/issues.json')) {
          issueRequestBody = JSON.parse(String(init?.body));
          return {
            ok: true,
            json: async () => ({ issue: { id: 123 } })
          };
        }
        throw new Error(`Unexpected request: ${requestUrl.toString()}`);
      });
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

      await expect(createRedmineIssue('https://redmine.example/', 'test-api-key', {
        projectId: '9',
        sprintId: '',
        subject: 'Map location',
        description: 'attachment:"Image20260528104707_1.png"',
        attachments: [{
          filePath: imagePath,
          fileName: 'Image20260528104707_1.png',
          contentType: 'image/png'
        }]
      })).resolves.toEqual({ id: '123' });

      expect(issueRequestBody).toMatchObject({
        issue: {
          description: '!Image20260528104707_1.png!',
          uploads: [{
            token: 'upload-token',
            filename: 'Image20260528104707_1.png',
            content_type: 'image/png'
          }]
        }
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('adds image attachments to the description when they are not referenced', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-space-redmine-upload-'));
    const imagePath = path.join(tempDir, 'screenshot.png');
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    try {
      let issueRequestBody: unknown = null;
      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const requestUrl = new URL(String(url));
        if (requestUrl.pathname.endsWith('/uploads.json')) {
          return {
            ok: true,
            json: async () => ({ upload: { token: 'upload-token' } })
          };
        }
        if (requestUrl.pathname.endsWith('/issues.json')) {
          issueRequestBody = JSON.parse(String(init?.body));
          return {
            ok: true,
            json: async () => ({ issue: { id: 124 } })
          };
        }
        throw new Error(`Unexpected request: ${requestUrl.toString()}`);
      });
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

      await createRedmineIssue('https://redmine.example/', 'test-api-key', {
        projectId: '9',
        sprintId: '',
        subject: 'Map location',
        description: 'Проверить карту.',
        attachments: [{
          filePath: imagePath,
          fileName: 'screenshot.png',
          contentType: 'image/png'
        }]
      });

      expect(issueRequestBody).toMatchObject({
        issue: {
          description: 'Проверить карту.\n\n## Скриншоты\n!screenshot.png!'
        }
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('can keep image attachments out of the issue description', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-space-redmine-upload-'));
    const imagePath = path.join(tempDir, 'screenshot.png');
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    try {
      let issueRequestBody: unknown = null;
      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const requestUrl = new URL(String(url));
        if (requestUrl.pathname.endsWith('/uploads.json')) {
          return {
            ok: true,
            json: async () => ({ upload: { token: 'upload-token' } })
          };
        }
        if (requestUrl.pathname.endsWith('/issues.json')) {
          issueRequestBody = JSON.parse(String(init?.body));
          return {
            ok: true,
            json: async () => ({ issue: { id: 125 } })
          };
        }
        throw new Error(`Unexpected request: ${requestUrl.toString()}`);
      });
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

      await createRedmineIssue('https://redmine.example/', 'test-api-key', {
        projectId: '9',
        sprintId: '',
        subject: 'Map location',
        description: 'Проверить карту.',
        inlineImageAttachments: false,
        attachments: [{
          filePath: imagePath,
          fileName: 'screenshot.png',
          contentType: 'image/png'
        }]
      });

      expect(issueRequestBody).toMatchObject({
        issue: {
          description: 'Проверить карту.',
          uploads: [{
            token: 'upload-token',
            filename: 'screenshot.png',
            content_type: 'image/png'
          }]
        }
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
