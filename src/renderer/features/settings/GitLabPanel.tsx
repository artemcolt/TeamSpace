import { useEffect, useMemo, useState } from 'react';
import { InfoLine, StatusPill } from '../../components/common';
import { api } from '../../domain/bridge';
import { gitlabDefaultUrl, gitlabTokenHelpUrl } from '../../domain/constants';

export function GitLabPanel({
  busy,
  state,
  runAction
}: {
  busy: boolean;
  state: AppState;
  runAction: (action: () => Promise<AppState>, success?: string) => Promise<AppState | null>;
}) {
  const [baseUrl, setBaseUrl] = useState(state.gitlab.baseUrl || gitlabDefaultUrl);
  const [token, setToken] = useState('');
  const [selectedProjectIds, setSelectedProjectIds] = useState(state.gitlab.selectedProjectIds);
  const selectedProjects = useMemo(
    () => state.gitlab.projects.filter((project) => selectedProjectIds.includes(project.id)),
    [selectedProjectIds, state.gitlab.projects]
  );

  useEffect(() => {
    setBaseUrl(state.gitlab.baseUrl || gitlabDefaultUrl);
    setSelectedProjectIds(state.gitlab.selectedProjectIds);
  }, [state.gitlab.baseUrl, state.gitlab.selectedProjectIds]);

  function toggleProject(projectId: string, checked: boolean) {
    setSelectedProjectIds((current) =>
      checked ? [...new Set([...current, projectId])] : current.filter((id) => id !== projectId)
    );
  }

  function formatActivity(value: string | null) {
    if (!value) {
      return 'нет активности';
    }
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit'
    }).format(new Date(value));
  }

  return (
    <section className="panel gitlab-panel">
      <div className="panel-title-row">
        <div>
          <p className="panel-label">GitLab source code</p>
          <h3>Исходный код проектов</h3>
        </div>
        <StatusPill label="GitLab" status={state.gitlab.status} />
      </div>
      <p className="helper">
        Подключите GitLab и выберите репозитории, которые Workspace будет считать рабочим исходным кодом.
        Нужен Personal Access Token со scope `read_api`; если дальше потребуется чтение файлов, добавьте
        `read_repository`.
        <button className="link-button" type="button" onClick={() => api.openExternal(gitlabTokenHelpUrl)}>
          Создать token
        </button>
      </p>

      <div className="form-grid">
        <label>
          <span>GitLab URL</span>
          <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={gitlabDefaultUrl} />
        </label>
        <label>
          <span>Personal Access Token</span>
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={state.gitlab.hasToken ? 'Token сохранен в защищенном хранилище' : 'glpat-...'}
          />
        </label>
      </div>

      {state.gitlab.error && <p className="error-text">{state.gitlab.error}</p>}

      <div className="actions">
        <button
          className="primary-action"
          disabled={busy || (!token.trim() && !state.gitlab.hasToken)}
          type="button"
          onClick={() => runAction(() => api.testGitLab({ baseUrl, token }), 'GitLab подключен.')}
        >
          Проверить и загрузить проекты
        </button>
        <button
          className="secondary-action"
          disabled={busy || state.gitlab.status !== 'connected'}
          type="button"
          onClick={() => runAction(api.syncGitLabProjects, 'Проекты GitLab обновлены.')}
        >
          Обновить проекты
        </button>
        <button
          className="secondary-action"
          disabled={busy}
          type="button"
          onClick={() =>
            runAction(
              () => api.saveGitLab({ baseUrl, token, selectedProjectIds }),
              'Проекты исходного кода сохранены.'
            )
          }
        >
          Сохранить выбор
        </button>
        <button
          className="danger-action"
          disabled={busy || state.gitlab.status === 'disconnected'}
          type="button"
          onClick={() => runAction(api.disconnectGitLab, 'GitLab отключен.')}
        >
          Отключить GitLab
        </button>
      </div>

      <div className="gitlab-summary">
        <InfoLine label="Доступных проектов" value={String(state.gitlab.projects.length)} />
        <InfoLine label="Выбрано репозиториев" value={String(selectedProjectIds.length)} />
      </div>

      {state.gitlab.projects.length > 0 && (
        <>
          <div className="actions compact-actions">
            <button
              className="secondary-action"
              disabled={busy}
              type="button"
              onClick={() => setSelectedProjectIds(state.gitlab.projects.map((project) => project.id))}
            >
              Выбрать все
            </button>
            <button
              className="secondary-action"
              disabled={busy}
              type="button"
              onClick={() => setSelectedProjectIds([])}
            >
              Снять все
            </button>
          </div>
          <div className="check-list gitlab-project-list">
            {state.gitlab.projects.map((project) => (
              <label key={project.id} className="check-row gitlab-project-row">
                <input
                  type="checkbox"
                  checked={selectedProjectIds.includes(project.id)}
                  onChange={(event) => toggleProject(project.id, event.target.checked)}
                />
                <span>
                  <strong>{project.pathWithNamespace}</strong>
                  <small>
                    {project.defaultBranch || 'branch не указан'} · {formatActivity(project.lastActivityAt)}
                  </small>
                </span>
                <button
                  className="link-button"
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    void api.openExternal(project.webUrl);
                  }}
                >
                  Открыть
                </button>
              </label>
            ))}
          </div>
        </>
      )}

      {selectedProjects.length > 0 && (
        <p className="inline-hint">
          Выбран исходный код: {selectedProjects.map((project) => project.pathWithNamespace).join(', ')}
        </p>
      )}
    </section>
  );
}
