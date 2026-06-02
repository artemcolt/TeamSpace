import { normalizeGitLabBaseUrl } from '../domain/appState';
import type { GitLabProject } from '../domain/types';

type GitLabProjectResponse = {
  id: number;
  name: string;
  path_with_namespace: string;
  web_url: string;
  default_branch?: string | null;
  last_activity_at?: string | null;
  ssh_url_to_repo?: string;
  http_url_to_repo?: string;
};

function gitLabUrl(baseUrl: string, endpoint: string): URL {
  return new URL(endpoint.replace(/^\//, ''), normalizeGitLabBaseUrl(baseUrl));
}

export async function fetchGitLabJson<T>(baseUrl: string, token: string, endpoint: string): Promise<T> {
  const response = await fetch(gitLabUrl(baseUrl, endpoint), {
    headers: {
      'PRIVATE-TOKEN': token,
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitLab ${response.status}: ${text || response.statusText}`);
  }

  return (await response.json()) as T;
}

export async function loadGitLabCurrentUser(baseUrl: string, token: string): Promise<{ id: number; username: string }> {
  return fetchGitLabJson(baseUrl, token, '/api/v4/user');
}

export async function loadGitLabProjects(baseUrl: string, token: string): Promise<GitLabProject[]> {
  const projects: GitLabProjectResponse[] = [];
  let page = 1;

  while (page > 0) {
    const url = gitLabUrl(baseUrl, '/api/v4/projects');
    url.searchParams.set('membership', 'true');
    url.searchParams.set('simple', 'true');
    url.searchParams.set('order_by', 'last_activity_at');
    url.searchParams.set('sort', 'desc');
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));

    const response = await fetch(url, {
      headers: {
        'PRIVATE-TOKEN': token,
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitLab ${response.status}: ${text || response.statusText}`);
    }

    projects.push(...await response.json() as GitLabProjectResponse[]);
    const nextPage = Number(response.headers.get('x-next-page') || 0);
    page = Number.isFinite(nextPage) ? nextPage : 0;
  }

  return projects.map((project) => ({
    id: String(project.id),
    name: project.name,
    pathWithNamespace: project.path_with_namespace,
    webUrl: project.web_url,
    defaultBranch: project.default_branch ?? null,
    lastActivityAt: project.last_activity_at ?? null,
    sshUrlToRepo: project.ssh_url_to_repo ?? '',
    httpUrlToRepo: project.http_url_to_repo ?? ''
  }));
}
