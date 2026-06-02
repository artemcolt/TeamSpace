import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadGitLabProjects } from './gitlabClient';

describe('loadGitLabProjects', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loads membership projects from every GitLab page', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url));
      const page = requestUrl.searchParams.get('page');

      return {
        ok: true,
        headers: {
          get: (name: string) => name.toLowerCase() === 'x-next-page' && page === '1' ? '2' : ''
        },
        json: async () => page === '1'
          ? [{
              id: 10,
              name: 'Workspace',
              path_with_namespace: 'example/workspace',
              web_url: 'https://gitlab.example.com/example/workspace',
              default_branch: 'main',
              last_activity_at: '2026-06-01T10:00:00.000Z',
              ssh_url_to_repo: 'git@gitlab.example.com:example/workspace.git',
              http_url_to_repo: 'https://gitlab.example.com/example/workspace.git'
            }]
          : [{
              id: 11,
              name: 'Backend',
              path_with_namespace: 'example/backend',
              web_url: 'https://gitlab.example.com/example/backend'
            }]
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(loadGitLabProjects('https://gitlab.example.com/', 'test-token')).resolves.toEqual([
      {
        id: '10',
        name: 'Workspace',
        pathWithNamespace: 'example/workspace',
        webUrl: 'https://gitlab.example.com/example/workspace',
        defaultBranch: 'main',
        lastActivityAt: '2026-06-01T10:00:00.000Z',
        sshUrlToRepo: 'git@gitlab.example.com:example/workspace.git',
        httpUrlToRepo: 'https://gitlab.example.com/example/workspace.git'
      },
      {
        id: '11',
        name: 'Backend',
        pathWithNamespace: 'example/backend',
        webUrl: 'https://gitlab.example.com/example/backend',
        defaultBranch: null,
        lastActivityAt: null,
        sshUrlToRepo: '',
        httpUrlToRepo: ''
      }
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v4/projects?membership=true&simple=true');
    expect(String(fetchMock.mock.calls[0][0])).toContain('per_page=100');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: {
        'PRIVATE-TOKEN': 'test-token',
        Accept: 'application/json'
      }
    });
  });
});
