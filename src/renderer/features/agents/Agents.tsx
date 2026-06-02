import { useEffect, useMemo, useRef, useState } from 'react';
import { ImageLightbox, SearchableSelectField, SelectField } from '../../components/common';
import { optionName } from '../../domain/formatters';
import { api } from '../../domain/bridge';

type AgentIssueKind = 'result' | 'testing';
type AgentIssueForm = {
  trackerId: string;
  statusId: string;
  assigneeId: string;
};
type AgentIssueDraft = {
  subject: string;
  description: string;
  comment: string;
};

const newStatusNeedles = ['нов', 'new'];
const testingNeedles = ['тест', 'test', 'qa', 'провер'];

function optionByNeedles(options: RedmineOption[], needles: string[]): string {
  return options.find((option) => {
    const normalized = option.name.toLocaleLowerCase('ru-RU');
    return needles.some((needle) => normalized.includes(needle));
  })?.id ?? '';
}

function statusOptionsFromIssues(issues: RedmineIssueSummary[]): RedmineOption[] {
  const statuses = new Map<string, RedmineOption>();
  for (const issue of issues) {
    if (issue.statusId && issue.status) {
      statuses.set(issue.statusId, { id: issue.statusId, name: issue.status });
    }
  }
  return [...statuses.values()].sort((first, second) => first.name.localeCompare(second.name, 'ru'));
}

function mergeOptions(primary: RedmineOption[], secondary: RedmineOption[]): RedmineOption[] {
  const options = new Map<string, RedmineOption>();
  for (const option of [...primary, ...secondary]) {
    options.set(option.id, option);
  }
  return [...options.values()];
}

function isScreenshotReferenceLine(line: string): boolean {
  return (
    /!\[[^\]]*]\([^)]*\.(?:png|jpe?g|webp|gif|bmp|svg)(?:\?[^)]*)?\)/i.test(line) ||
    /![^!\s]+\.(?:png|jpe?g|webp|gif|bmp|svg)!/i.test(line) ||
    /attachment:(?:"[^"]+\.(?:png|jpe?g|webp|gif|bmp|svg)"|[^\s)]+\.(?:png|jpe?g|webp|gif|bmp|svg))/i.test(line)
  );
}

function redmineDescriptionFromAgentReport(reportMarkdown: string): string {
  let skipSection = false;
  const cleaned = reportMarkdown
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      const normalized = trimmed.toLocaleLowerCase('ru-RU');
      const headingMatch = normalized.match(/^#{1,6}\s+(.+)$/);
      if (headingMatch) {
        skipSection = (
          headingMatch[1].includes('скриншот') ||
          headingMatch[1].includes('вложен') ||
          headingMatch[1].includes('измененн') ||
          headingMatch[1].includes('изменённ') ||
          headingMatch[1].includes('файл')
        );
        return !skipSection;
      }
      if (skipSection) {
        return false;
      }
      return !(
        normalized.includes('windows-коп') ||
        normalized.includes('windows коп') ||
        normalized.includes('свежей установки') ||
        normalized.includes('состоянии свеж') ||
        normalized.includes('источник отчёта') ||
        normalized.includes('источник отчета') ||
        normalized.includes('скриншоты должны') ||
        normalized.includes('в screenshots/') ||
        normalized.includes('screenshots/') ||
        normalized.includes('вложения:') ||
        isScreenshotReferenceLine(trimmed)
      );
    })
    .join('\n')
    .trim();
  return readableRedmineDescription(cleaned);
}

function readableRedmineDescription(description: string): string {
  return description
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (
        !trimmed ||
        trimmed.startsWith('#') ||
        trimmed.startsWith('- ') ||
        trimmed.includes('\n') ||
        (trimmed.match(/,\s/g) ?? []).length < 2
      ) {
        return trimmed;
      }

      const parts = trimmed
        .split(/,\s+/)
        .map((part) => part.trim().replace(/[.;]\s*$/, ''))
        .filter(Boolean);
      return parts.length > 1 ? parts.map((part) => `- ${part}`).join('\n') : trimmed;
    })
    .filter(Boolean)
    .join('\n\n');
}

function draftKey(reportId: string, issueKind: AgentIssueKind) {
  return `${reportId}:${issueKind}`;
}

function defaultDraft(report: AgentWorkItem, issueKind: AgentIssueKind, reportMarkdown: string): AgentIssueDraft {
  const cleanedReportMarkdown = redmineDescriptionFromAgentReport(reportMarkdown);
  const description = [
    ...(issueKind === 'testing' ? [
      '## Задача на тестирование',
      '',
      'Проверить результат работы агента по отчёту ниже. Скриншоты приложены к задаче.',
      ''
    ] : []),
    cleanedReportMarkdown || report.summary || report.title
  ].join('\n').trim();

  return {
    subject: issueKind === 'testing' ? `Тестирование: ${report.title}` : report.title,
    description,
    comment: ''
  };
}

function AutoGrowTextarea({
  ariaLabel,
  rows,
  placeholder,
  value,
  onChange
}: {
  ariaLabel: string;
  rows: number;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={textareaRef}
      aria-label={ariaLabel}
      rows={rows}
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function Agents({ state }: { state: AppState }) {
  const [reports, setReports] = useState<AgentWorkItem[]>([]);
  const [issueStatusOptions, setIssueStatusOptions] = useState<RedmineOption[]>([]);
  const [reportMarkdownById, setReportMarkdownById] = useState<Record<string, string>>({});
  const [issueDrafts, setIssueDrafts] = useState<Record<string, AgentIssueDraft>>({});
  const [prompt, setPrompt] = useState('');
  const [selectedReportId, setSelectedReportId] = useState('');
  const [loading, setLoading] = useState(false);
  const [creatingReportId, setCreatingReportId] = useState('');
  const [deletingReportId, setDeletingReportId] = useState('');
  const [issueKind, setIssueKind] = useState<AgentIssueKind>('result');
  const [resultIssue, setResultIssue] = useState<AgentIssueForm>({
    trackerId: state.workspace.defaultTrackerId,
    statusId: '',
    assigneeId: state.workspace.defaultAssigneeId
  });
  const [testingIssue, setTestingIssue] = useState<AgentIssueForm>({
    trackerId: state.workspace.defaultTrackerId,
    statusId: '',
    assigneeId: state.workspace.defaultAssigneeId
  });
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const statusOptions = useMemo(
    () => mergeOptions(state.redmine.statuses, issueStatusOptions),
    [issueStatusOptions, state.redmine.statuses]
  );
  const newStatusId = useMemo(() => optionByNeedles(statusOptions, newStatusNeedles), [statusOptions]);
  const testingTrackerId = useMemo(() => optionByNeedles(state.redmine.trackers, testingNeedles), [state.redmine.trackers]);
  const testingStatusId = useMemo(() => optionByNeedles(statusOptions, testingNeedles), [statusOptions]);

  const selectedReport = useMemo(
    () => reports.find((report) => report.id === selectedReportId) ?? reports[0] ?? null,
    [reports, selectedReportId]
  );

  const selectedIssueId = selectedReport
    ? issueKind === 'testing' ? selectedReport.redmineTestingIssueId : selectedReport.redmineIssueId
    : '';
  const activeIssue = issueKind === 'testing' ? testingIssue : resultIssue;
  const activeDraftKey = selectedReport ? draftKey(selectedReport.id, issueKind) : '';
  const activeReportMarkdown = selectedReport ? reportMarkdownById[selectedReport.id] ?? '' : '';
  const activeDraft = selectedReport
    ? issueDrafts[activeDraftKey] ?? defaultDraft(selectedReport, issueKind, activeReportMarkdown)
    : null;

  useEffect(() => {
    void refreshReports();
    api.getAgentWorkPrompt().then(setPrompt).catch(() => undefined);
  }, []);

  useEffect(() => {
    const projectId = state.workspace.defaultProjectId;
    const sprintId = state.workspace.defaultSprintId;
    if (!projectId || !sprintId) {
      setIssueStatusOptions([]);
      return;
    }

    let cancelled = false;
    api.loadRedmineMyIssues({ projectId, sprintId })
      .then((response) => {
        if (!cancelled) {
          setIssueStatusOptions(statusOptionsFromIssues(response.issues));
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [state.workspace.defaultProjectId, state.workspace.defaultSprintId]);

  useEffect(() => {
    if (!selectedReportId && reports.length > 0) {
      setSelectedReportId(reports[0].id);
    }
  }, [reports, selectedReportId]);

  useEffect(() => {
    if (!selectedReport || reportMarkdownById[selectedReport.id] !== undefined) {
      return;
    }

    let cancelled = false;
    api.readTextFile(selectedReport.reportPath)
      .then((content) => {
        if (!cancelled) {
          setReportMarkdownById((current) => ({ ...current, [selectedReport.id]: content }));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setReportMarkdownById((current) => ({ ...current, [selectedReport.id]: '' }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [reportMarkdownById, selectedReport]);

  useEffect(() => {
    if (!selectedReport) {
      return;
    }

    setIssueDrafts((current) => {
      const existing = current[activeDraftKey];
      const nextDefault = defaultDraft(selectedReport, issueKind, activeReportMarkdown);
      if (!existing) {
        return {
          ...current,
          [activeDraftKey]: nextDefault
        };
      }

      const emptyReportDefault = defaultDraft(selectedReport, issueKind, '');
      const canRefreshFromLoadedReport = Boolean(activeReportMarkdown)
        && existing.subject === emptyReportDefault.subject
        && existing.description === emptyReportDefault.description
        && existing.comment === emptyReportDefault.comment;
      if (!canRefreshFromLoadedReport) {
        return current;
      }

      return {
        ...current,
        [activeDraftKey]: nextDefault
      };
    });
  }, [activeDraftKey, activeReportMarkdown, issueKind, selectedReport]);

  useEffect(() => {
    setResultIssue((current) => ({
      ...current,
      trackerId: current.trackerId || state.workspace.defaultTrackerId,
      statusId: current.statusId || newStatusId,
      assigneeId: current.assigneeId || state.workspace.defaultAssigneeId
    }));
    setTestingIssue((current) => ({
      ...current,
      trackerId: current.trackerId || testingTrackerId || state.workspace.defaultTrackerId,
      statusId: current.statusId || testingStatusId,
      assigneeId: current.assigneeId || state.workspace.defaultAssigneeId
    }));
  }, [newStatusId, state.workspace.defaultAssigneeId, state.workspace.defaultTrackerId, testingStatusId, testingTrackerId]);

  function chooseIssueKind(nextIssueKind: AgentIssueKind) {
    setIssueKind(nextIssueKind);
    if (nextIssueKind === 'testing') {
      setTestingIssue((current) => ({
        ...current,
        trackerId: current.trackerId === state.workspace.defaultTrackerId
          ? testingTrackerId || current.trackerId
          : current.trackerId || testingTrackerId || state.workspace.defaultTrackerId,
        statusId: current.statusId || testingStatusId
      }));
    }
  }

  function updateActiveIssue(patch: Partial<AgentIssueForm>) {
    if (issueKind === 'testing') {
      setTestingIssue((current) => ({ ...current, ...patch }));
      return;
    }
    setResultIssue((current) => ({ ...current, ...patch }));
  }

  function updateActiveDraft(patch: Partial<AgentIssueDraft>) {
    if (!selectedReport || !activeDraft) {
      return;
    }

    setIssueDrafts((current) => ({
      ...current,
      [activeDraftKey]: { ...activeDraft, ...patch }
    }));
  }

  function resetActiveDraft() {
    if (!selectedReport) {
      return;
    }

    setIssueDrafts((current) => ({
      ...current,
      [activeDraftKey]: defaultDraft(selectedReport, issueKind, activeReportMarkdown)
    }));
  }

  async function refreshReports() {
    setLoading(true);
    setError('');
    try {
      setReports(await api.listAgentWorkReports());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить отчёты агентов.');
    } finally {
      setLoading(false);
    }
  }

  async function copyPrompt() {
    setMessage('');
    setError('');
    try {
      await api.copyText(prompt || await api.getAgentWorkPrompt());
      setMessage('Промпт скопирован.');
    } catch {
      setError('Не удалось скопировать промпт.');
    }
  }

  async function createIssue(report: AgentWorkItem) {
    setCreatingReportId(report.id);
    setMessage('');
    setError('');
    try {
      const issuePayload: AgentWorkCreateIssuePayload = {
        reportId: report.id,
        issueKind,
        projectId: state.workspace.defaultProjectId,
        sprintId: state.workspace.defaultSprintId,
        trackerId: activeIssue.trackerId,
        priorityId: state.workspace.defaultPriorityId,
        assigneeId: activeIssue.assigneeId,
        statusId: activeIssue.statusId || undefined,
        subject: activeDraft?.subject.trim(),
        description: activeDraft?.description
      };
      if (activeDraft?.comment.trim()) {
        issuePayload.comment = activeDraft.comment.trim();
      }
      const issue = await api.createRedmineIssueFromAgentWork(issuePayload);
      setMessage(`Создана задача Redmine #${issue.id}.`);
      await refreshReports();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Не удалось создать задачу Redmine.');
    } finally {
      setCreatingReportId('');
    }
  }

  async function deleteReport(report: AgentWorkItem) {
    if (!window.confirm(`Удалить результат "${report.title}"?`)) {
      return;
    }

    setDeletingReportId(report.id);
    setMessage('');
    setError('');
    try {
      await api.deleteAgentWorkReport({ reportId: report.id });
      setReports((current) => current.filter((item) => item.id !== report.id));
      setSelectedReportId('');
      setIssueDrafts((current) => Object.fromEntries(
        Object.entries(current).filter(([key]) => !key.startsWith(`${report.id}:`))
      ));
      setReportMarkdownById((current) => {
        const next = { ...current };
        delete next[report.id];
        return next;
      });
      setMessage('Результат работы удалён.');
      await refreshReports();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Не удалось удалить результат работы.');
    } finally {
      setDeletingReportId('');
    }
  }

  const defaultTarget = [
    optionName(state.redmine.projects, state.workspace.defaultProjectId),
    optionName(state.redmine.sprints, state.workspace.defaultSprintId),
    optionName(state.redmine.trackers, state.workspace.defaultTrackerId)
  ].filter(Boolean).join(' / ');

  return (
    <section className="agents-view">
      <header className="topbar">
        <div>
          <p className="eyebrow">Agents</p>
          <h2>Результаты работы агентов</h2>
          <p>{defaultTarget || 'Настрой Redmine defaults перед созданием задач.'}</p>
        </div>
        <div className="actions">
          <button className="secondary-action" type="button" onClick={() => void api.openAgentWorkFolder()}>
            Открыть папку
          </button>
          <button className="secondary-action" type="button" disabled={loading} onClick={() => void refreshReports()}>
            Обновить
          </button>
          <button className="primary-action" type="button" onClick={() => void copyPrompt()}>
            Скопировать промпт
          </button>
        </div>
      </header>

      {message && <p className="success-text">{message}</p>}
      {error && <p className="error-text">{error}</p>}

      <div className="agents-layout">
        <aside className="agents-list">
          {reports.length === 0 && (
            <div className="empty-state">
              Отчётов пока нет. Скопируй промпт, отправь его агенту и обнови список.
            </div>
          )}
          {reports.map((report) => (
            <button
              key={report.id}
              type="button"
              className={selectedReport?.id === report.id ? 'agent-report-item active' : 'agent-report-item'}
              onClick={() => setSelectedReportId(report.id)}
            >
              <strong>{report.title}</strong>
              <span>{new Date(report.updatedAt).toLocaleString('ru-RU')}</span>
              <em>{report.screenshots.length} скриншотов</em>
            </button>
          ))}
        </aside>

        <section className="agent-report-detail">
          {!selectedReport ? (
            <div className="empty-state">Выбери отчёт агента.</div>
          ) : (
            <>
              <div className="agent-report-header">
                <div>
                  <h3>{selectedReport.title}</h3>
                </div>
                <div className="actions">
                  <button
                    className="danger-action"
                    type="button"
                    aria-label={`Удалить результат ${selectedReport.title}`}
                    title="Удалить результат"
                    disabled={deletingReportId === selectedReport.id || creatingReportId === selectedReport.id}
                    onClick={() => void deleteReport(selectedReport)}
                  >
                    {deletingReportId === selectedReport.id ? (
                      <span className="delete-progress">Удаляем...</span>
                    ) : (
                      <svg aria-hidden="true" viewBox="0 0 24 24">
                        <path d="M3 6h18" />
                        <path d="M8 6V4h8v2" />
                        <path d="M6 6l1 15h10l1-15" />
                        <path d="M10 11v6" />
                        <path d="M14 11v6" />
                      </svg>
                    )}
                  </button>
                  <button
                    className="primary-action"
                    type="button"
                    disabled={
                      creatingReportId === selectedReport.id ||
                      !state.workspace.defaultProjectId ||
                      !activeIssue.trackerId ||
                      !activeDraft?.subject.trim() ||
                      Boolean(selectedIssueId)
                    }
                    onClick={() => void createIssue(selectedReport)}
                  >
                    {selectedIssueId
                      ? `Redmine #${selectedIssueId}`
                      : creatingReportId === selectedReport.id
                        ? 'Создаём...'
                        : issueKind === 'testing' ? 'Поставить на тестирование' : 'Создать задачу'}
                  </button>
                </div>
              </div>

              <div className="agent-issue-controls">
                <div className="agent-kind-row">
                  <div className="agent-kind-toggle" role="group" aria-label="Тип Redmine-задачи">
                    <button
                      type="button"
                      className={issueKind === 'result' ? 'active' : ''}
                      onClick={() => chooseIssueKind('result')}
                    >
                      Результат
                    </button>
                    <button
                      type="button"
                      className={issueKind === 'testing' ? 'active' : ''}
                      onClick={() => chooseIssueKind('testing')}
                    >
                      Тестирование
                    </button>
                  </div>
                </div>
                <div className="form-grid">
                  <SearchableSelectField
                    label="Исполнитель"
                    value={activeIssue.assigneeId}
                    options={state.redmine.users}
                    onChange={(assigneeId) => updateActiveIssue({ assigneeId })}
                    placeholder="Найти исполнителя"
                  />
                  <SelectField
                    label="Tracker"
                    value={activeIssue.trackerId}
                    options={state.redmine.trackers}
                    onChange={(trackerId) => updateActiveIssue({ trackerId })}
                  />
                  <SelectField
                    label="Статус"
                    value={activeIssue.statusId}
                    options={statusOptions}
                    onChange={(statusId) => updateActiveIssue({ statusId })}
                  />
                </div>
              </div>

              {activeDraft && (
                <div className="agent-redmine-editor">
                  <div className="agent-redmine-editor-header">
                    <div>
                      <h4>Редактор Redmine</h4>
                      <span>Проверь, что уйдёт в заголовок, описание и комментарий.</span>
                    </div>
                    <button className="secondary-action" type="button" onClick={resetActiveDraft}>
                      Сбросить
                    </button>
                  </div>
                  <label>
                    <span>Заголовок</span>
                    <input
                      aria-label="Заголовок задачи Redmine"
                      value={activeDraft.subject}
                      onChange={(event) => updateActiveDraft({ subject: event.target.value })}
                    />
                  </label>
                  <label>
                    <span>Описание</span>
                    <AutoGrowTextarea
                      ariaLabel="Описание задачи Redmine"
                      rows={6}
                      value={activeDraft.description}
                      onChange={(description) => updateActiveDraft({ description })}
                    />
                  </label>
                  <label>
                    <span>Комментарий</span>
                    <AutoGrowTextarea
                      ariaLabel="Комментарий задачи Redmine"
                      rows={4}
                      placeholder="Если оставить пустым, комментарий не добавится."
                      value={activeDraft.comment}
                      onChange={(comment) => updateActiveDraft({ comment })}
                    />
                  </label>
                </div>
              )}

              <div className="agent-report-meta">
                <span>{selectedReport.reportPath}</span>
              </div>

              {selectedReport.screenshots.length > 0 && (
                <div className="agent-screenshot-grid">
                  {selectedReport.screenshots.map((screenshot) => (
                    <figure key={screenshot.filePath}>
                      {screenshot.dataUrl ? (
                        <button
                          className="image-preview-button"
                          type="button"
                          aria-label={`Открыть изображение ${screenshot.fileName}`}
                          onClick={() => setPreviewImage({ src: screenshot.dataUrl || '', alt: screenshot.fileName })}
                        >
                          <img src={screenshot.dataUrl} alt={screenshot.fileName} />
                        </button>
                      ) : (
                        <div className="agent-screenshot-placeholder">{screenshot.fileName}</div>
                      )}
                      <figcaption>{screenshot.fileName}</figcaption>
                    </figure>
                  ))}
                </div>
              )}
              {previewImage && (
                <ImageLightbox
                  src={previewImage.src}
                  alt={previewImage.alt}
                  onClose={() => setPreviewImage(null)}
                />
              )}
            </>
          )}
        </section>
      </div>
    </section>
  );
}
