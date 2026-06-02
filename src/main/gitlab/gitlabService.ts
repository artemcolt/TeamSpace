import { normalizeGitLabBaseUrl } from '../domain/appState';
import type { AppState } from '../domain/types';
import { LocalStore } from '../storage/localStore';
import { loadGitLabCurrentUser, loadGitLabProjects } from './gitlabClient';

export class GitLabService {
  constructor(private readonly store: LocalStore) {}

  async test(payload: { baseUrl: string; token?: string }): Promise<AppState> {
    const baseUrl = normalizeGitLabBaseUrl(payload.baseUrl);
    const enteredToken = payload.token?.trim() ?? '';
    const token = enteredToken || this.store.getSecret('gitlabToken');
    if (!token) {
      throw new Error('Введите GitLab token.');
    }

    try {
      await loadGitLabCurrentUser(baseUrl, token);
      const projects = await loadGitLabProjects(baseUrl, token);
      if (enteredToken) {
        this.store.setSecret('gitlabToken', enteredToken);
      }
      return this.store.setState((state) => {
        state.gitlab.status = 'connected';
        state.gitlab.baseUrl = baseUrl;
        state.gitlab.hasToken = true;
        state.gitlab.projects = projects;
        state.gitlab.selectedProjectIds = state.gitlab.selectedProjectIds.filter((projectId) =>
          projects.some((project) => project.id === projectId)
        );
        state.gitlab.error = null;
      });
    } catch (error) {
      return this.store.setState((state) => {
        state.gitlab.status = 'error';
        state.gitlab.baseUrl = baseUrl;
        state.gitlab.error = error instanceof Error ? error.message : 'GitLab недоступен.';
      });
    }
  }

  async save(payload: { baseUrl: string; token?: string; selectedProjectIds: string[] }): Promise<AppState> {
    const baseUrl = normalizeGitLabBaseUrl(payload.baseUrl);
    if (payload.token?.trim()) {
      this.store.setSecret('gitlabToken', payload.token.trim());
    }

    return this.store.setState((state) => {
      state.gitlab.baseUrl = baseUrl;
      state.gitlab.hasToken = Boolean(this.store.getSecret('gitlabToken'));
      state.gitlab.selectedProjectIds = payload.selectedProjectIds.filter((projectId) =>
        state.gitlab.projects.some((project) => project.id === projectId)
      );
      if (state.gitlab.status !== 'connected') {
        state.gitlab.status = state.gitlab.hasToken ? 'connected' : 'disconnected';
      }
    });
  }

  async syncProjects(): Promise<AppState> {
    const state = this.store.getState();
    const token = this.store.getSecret('gitlabToken');
    if (!token) {
      throw new Error('GitLab token не сохранен. Откройте настройки GitLab и сохраните token заново.');
    }

    const projects = await loadGitLabProjects(state.gitlab.baseUrl, token);
    return this.store.setState((draftState) => {
      draftState.gitlab.status = 'connected';
      draftState.gitlab.projects = projects;
      draftState.gitlab.selectedProjectIds = draftState.gitlab.selectedProjectIds.filter((projectId) =>
        projects.some((project) => project.id === projectId)
      );
      draftState.gitlab.error = null;
    });
  }

  async disconnect(): Promise<AppState> {
    this.store.deleteSecret('gitlabToken');
    return this.store.setState((state) => {
      state.gitlab.status = 'disconnected';
      state.gitlab.hasToken = false;
      state.gitlab.projects = [];
      state.gitlab.selectedProjectIds = [];
      state.gitlab.error = null;
    });
  }
}
