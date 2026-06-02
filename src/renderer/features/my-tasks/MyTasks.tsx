import { type DragEvent, useEffect, useRef, useState } from 'react';
import { ImageLightbox, SearchableSelectField, SelectField } from '../../components/common';
import { api } from '../../domain/bridge';
import { optionName } from '../../domain/formatters';

const taskColumns = [
  { id: 'new', title: 'Новые', statusNeedles: ['нов', 'new'] },
  { id: 'inProgress', title: 'В работе', statusNeedles: ['работ', 'progress', 'work', 'doing', 'started'] },
  { id: 'review', title: 'На проверке', statusNeedles: ['провер', 'review', 'test'] }
] as const;

type TaskColumnId = typeof taskColumns[number]['id'];
type GeneratedDescriptionViewer = {
  path: string;
  issueId: string;
  content: string;
  draftContent: string;
  parts: GeneratedDescriptionParts | null;
  loading: boolean;
  savingFile: boolean;
  applyingToRedmine: boolean;
  error: string;
  message: string;
};

type SprintResultsViewer = {
  content: string;
  rows: SprintResultRow[];
  outputFile: string;
  loading: boolean;
  error: string;
};

type SprintResultRow = {
  text: string;
  status: 'success' | 'failure' | 'neutral';
};

type AgentLauncherDialog = {
  workingDirectory: string;
  gitlabProjectId: string;
  prompt: string;
  running: boolean;
  error: string;
  sourceStatus: string;
  resultDirectory: string;
};

const allowedRichTextTags = new Set([
  'A',
  'B',
  'BLOCKQUOTE',
  'BR',
  'CODE',
  'DEL',
  'DIV',
  'EM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HR',
  'I',
  'IMG',
  'INS',
  'LI',
  'OL',
  'P',
  'PRE',
  'S',
  'SPAN',
  'STRONG',
  'TABLE',
  'TBODY',
  'TD',
  'TH',
  'THEAD',
  'TR',
  'U',
  'UL'
]);

const removedRichTextTags = new Set(['IFRAME', 'OBJECT', 'SCRIPT', 'STYLE']);
const generatedDescriptionsStorageKey = 'team-space.generated-redmine-descriptions.v1';
const appliedGeneratedCommentStorageKey = 'team-space.generated-redmine-comment-journals.v1';
const generatedCommentMarkerPrefix = 'team-space-ai-redmine-comment';

function gitLabProjectLabel(project: GitLabProject) {
  return project.pathWithNamespace || project.name || project.id;
}

function GitLabProjectSearchField({
  value,
  projects,
  disabled,
  onChange
}: {
  value: string;
  projects: GitLabProject[];
  disabled: boolean;
  onChange: (projectId: string) => void;
}) {
  const selectedProject = projects.find((project) => project.id === value);
  const selectedLabel = selectedProject ? gitLabProjectLabel(selectedProject) : '';
  const [query, setQuery] = useState(selectedLabel);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      setQuery(selectedLabel);
    }
  }, [open, selectedLabel]);

  const filteredProjects = (() => {
    const needle = query.trim().toLocaleLowerCase('ru-RU');
    const source = needle
      ? projects.filter((project) =>
          [
            project.pathWithNamespace,
            project.name,
            project.defaultBranch ?? '',
            project.webUrl
          ].some((valuePart) => valuePart.toLocaleLowerCase('ru-RU').includes(needle))
        )
      : projects;
    return source.slice(0, 80);
  })();

  function choose(projectId: string) {
    onChange(projectId);
    setOpen(false);
  }

  return (
    <div className="search-select gitlab-source-search">
      <label>
        <span>Исходный код GitLab</span>
        <div className="search-select-input">
          <input
            value={query}
            disabled={disabled}
            onFocus={(event) => {
              setOpen(true);
              event.currentTarget.select();
            }}
            onBlur={() => {
              window.setTimeout(() => setOpen(false), 120);
            }}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setOpen(false);
              }
              if (event.key === 'Enter' && filteredProjects[0]) {
                event.preventDefault();
                choose(filteredProjects[0].id);
              }
            }}
            placeholder={projects.length > 0 ? 'Найти репозиторий' : 'GitLab-проекты не выбраны'}
          />
          {value && !disabled && (
            <button
              type="button"
              aria-label="Выбрать папку вручную"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose('')}
            >
              ×
            </button>
          )}
        </div>
      </label>
      {open && !disabled && (
        <div className="search-select-menu" role="listbox">
          <button
            type="button"
            className={!value ? 'selected' : ''}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => choose('')}
          >
            <strong>Выбрать папку вручную</strong>
          </button>
          {filteredProjects.map((project) => (
            <button
              key={project.id}
              type="button"
              className={project.id === value ? 'selected' : ''}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(project.id)}
            >
              <strong>{gitLabProjectLabel(project)}</strong>
              <small>{project.defaultBranch || 'branch не указан'}</small>
            </button>
          ))}
          {filteredProjects.length === 0 && (
            <div className="search-select-empty">Ничего не найдено</div>
          )}
        </div>
      )}
    </div>
  );
}

function preferredSprintId(state: AppState) {
  const sprints = Array.isArray(state.redmine.sprints) ? state.redmine.sprints : [];
  const defaultSprintId = state.workspace.defaultSprintId;
  if (defaultSprintId && sprints.some((sprint) => sprint.id === defaultSprintId)) {
    return defaultSprintId;
  }
  return sprints[0]?.id ?? '';
}

function formatIssueDate(value: string) {
  if (!value) {
    return '';
  }
  try {
    return new Intl.DateTimeFormat('ru-RU').format(new Date(value));
  } catch {
    return '';
  }
}

function mergeSyncedIssuesPreservingOrder(
  currentIssues: RedmineIssueSummary[],
  syncedIssues: RedmineIssueSummary[]
) {
  if (currentIssues.length === 0) {
    return syncedIssues;
  }

  const syncedById = new Map(syncedIssues.map((issue) => [issue.id, issue]));
  const currentIds = new Set(currentIssues.map((issue) => issue.id));
  const updatedCurrentIssues = currentIssues
    .map((issue) => syncedById.get(issue.id))
    .filter((issue): issue is RedmineIssueSummary => Boolean(issue));
  const addedIssues = syncedIssues.filter((issue) => !currentIds.has(issue.id));
  return [...updatedCurrentIssues, ...addedIssues];
}

function normalizeSprintResultLine(value: string, section: SprintResultRow['status']): SprintResultRow | null {
  const text = value
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^\s+/, '');
  if (!text.trim()) {
    return null;
  }

  if (/^получилось\b/i.test(text)) {
    return { text, status: 'success' };
  }
  if (/^не получилось\b/i.test(text)) {
    return { text, status: 'failure' };
  }
  if (section === 'success') {
    return { text: `Получилось ${text}`, status: 'success' };
  }
  if (section === 'failure') {
    return { text: `Не получилось ${text}`, status: 'failure' };
  }
  return { text, status: 'neutral' };
}

function parseSprintResultRows(value: string): SprintResultRow[] {
  const rows: SprintResultRow[] = [];
  let section: SprintResultRow['status'] = 'neutral';

  value.split(/\r?\n/).forEach((rawLine) => {
    if (!rawLine.trim()) {
      return;
    }

    const heading = rawLine.replace(/^#+\s*/, '').trim();
    if (/^результаты спринта$/i.test(heading) || /^короткий вывод\b/i.test(heading)) {
      return;
    }
    if (/^получилось$/i.test(heading)) {
      section = 'success';
      return;
    }
    if (/^не получилось$/i.test(heading)) {
      section = 'failure';
      return;
    }

    const row = normalizeSprintResultLine(rawLine, section);
    if (row) {
      rows.push(row);
    }
  });

  return rows;
}

function loadGeneratedDescriptions(): Record<string, string> {
  try {
    const rawValue = window.localStorage.getItem(generatedDescriptionsStorageKey);
    const parsedValue = rawValue ? JSON.parse(rawValue) : null;
    if (!parsedValue || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsedValue)
        .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string')
    );
  } catch {
    return {};
  }
}

function saveGeneratedDescriptions(value: Record<string, string>) {
  try {
    window.localStorage.setItem(generatedDescriptionsStorageKey, JSON.stringify(value));
  } catch {
    // The link is still useful in memory even if browser storage is unavailable.
  }
}

function loadAppliedGeneratedCommentJournals(): Record<string, string> {
  try {
    const rawValue = window.localStorage.getItem(appliedGeneratedCommentStorageKey);
    const parsedValue = rawValue ? JSON.parse(rawValue) : null;
    if (!parsedValue || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsedValue)
        .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string')
    );
  } catch {
    return {};
  }
}

function saveAppliedGeneratedCommentJournal(issueId: string, journalId: string) {
  if (!issueId || !journalId) {
    return;
  }
  try {
    const current = loadAppliedGeneratedCommentJournals();
    window.localStorage.setItem(appliedGeneratedCommentStorageKey, JSON.stringify({
      ...current,
      [issueId]: journalId
    }));
  } catch {
    // Reapplying still works by marker/text matching if local storage is unavailable.
  }
}

function issueIdFromGeneratedDescriptionPath(value: string) {
  return value.match(/(?:^|\/)issue-(\d+)-/)?.[1] ?? '';
}

function formatSyncDate(value: string | null) {
  if (!value) {
    return '';
  }
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(value));
  } catch {
    return '';
  }
}

function formatIssueDateTime(value: unknown) {
  if (typeof value !== 'string' || !value) {
    return '';
  }
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function namedValue(value: unknown) {
  const record = asRecord(value);
  return stringValue(record?.name) || stringValue(value);
}

function namedId(value: unknown) {
  const record = asRecord(value);
  return stringValue(record?.id);
}

function issueDetail(details: RedmineIssueDetails | null) {
  return asRecord(details?.issue);
}

function detailText(details: RedmineIssueDetails | null, key: string) {
  return stringValue(issueDetail(details)?.[key]);
}

function detailNamedText(details: RedmineIssueDetails | null, key: string) {
  return namedValue(issueDetail(details)?.[key]);
}

function detailArray(details: RedmineIssueDetails | null, key: string) {
  const value = issueDetail(details)?.[key];
  return Array.isArray(value) ? value : [];
}

function redmineAttachmentName(attachment: Record<string, unknown>) {
  return stringValue(attachment.filename) || stringValue(attachment.content_url) || 'Файл';
}

function isRedmineImageAttachment(attachment: Record<string, unknown>) {
  const contentType = stringValue(attachment.content_type).toLowerCase();
  const filename = redmineAttachmentName(attachment).toLowerCase();
  return contentType.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(filename);
}

function redmineAttachmentUrl(attachment: Record<string, unknown>) {
  const url = stringValue(attachment.content_url);
  if (!url) {
    return '';
  }
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}

function isSafeRichTextUrl(value: string) {
  if (!value.startsWith('http://') && !value.startsWith('https://') && !value.startsWith('mailto:')) {
    return false;
  }
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function sanitizeRichText(value: string) {
  const parser = new DOMParser();
  const document = parser.parseFromString(`<div>${value}</div>`, 'text/html');
  const root = document.body.firstElementChild ?? document.body;

  function sanitizeNode(node: Node) {
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const element = node as HTMLElement;
    const tagName = element.tagName.toUpperCase();
    if (removedRichTextTags.has(tagName)) {
      element.remove();
      return;
    }
    if (!allowedRichTextTags.has(tagName)) {
      for (const child of Array.from(element.childNodes)) {
        sanitizeNode(child);
      }
      element.replaceWith(...Array.from(element.childNodes));
      return;
    }

    const href = tagName === 'A' ? element.getAttribute('href') ?? '' : '';
    for (const attribute of Array.from(element.attributes)) {
      element.removeAttribute(attribute.name);
    }

    if (tagName === 'A') {
      if (isSafeRichTextUrl(href)) {
        element.setAttribute('href', href);
        element.setAttribute('target', '_blank');
        element.setAttribute('rel', 'noreferrer');
      }
    }

    if (tagName === 'IMG') {
      element.remove();
      return;
    }

    for (const child of Array.from(element.childNodes)) {
      sanitizeNode(child);
    }
  }

  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === Node.COMMENT_NODE) {
      child.remove();
      continue;
    }
    sanitizeNode(child);
  }

  return root.innerHTML;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMarkdownInline(value: string) {
  let html = escapeHtml(value);
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');
  return html;
}

function markdownToHtml(value: string) {
  const lines = value.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let paragraph: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let codeBlock: string[] | null = null;

  function closeParagraph() {
    if (paragraph.length === 0) {
      return;
    }
    html.push(`<p>${renderMarkdownInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  }

  function closeList() {
    if (!listType) {
      return;
    }
    html.push(`</${listType}>`);
    listType = null;
  }

  for (const line of lines) {
    const trimmedLine = line.trim();

    if (codeBlock) {
      if (trimmedLine.startsWith('```')) {
        html.push(`<pre><code>${escapeHtml(codeBlock.join('\n'))}</code></pre>`);
        codeBlock = null;
      } else {
        codeBlock.push(line);
      }
      continue;
    }

    if (trimmedLine.startsWith('```')) {
      closeParagraph();
      closeList();
      codeBlock = [];
      continue;
    }

    if (!trimmedLine) {
      closeParagraph();
      closeList();
      continue;
    }

    const heading = trimmedLine.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeParagraph();
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderMarkdownInline(heading[2])}</h${level}>`);
      continue;
    }

    const unorderedListItem = trimmedLine.match(/^[-*]\s+(.+)$/);
    if (unorderedListItem) {
      closeParagraph();
      if (listType !== 'ul') {
        closeList();
        listType = 'ul';
        html.push('<ul>');
      }
      html.push(`<li>${renderMarkdownInline(unorderedListItem[1])}</li>`);
      continue;
    }

    const orderedListItem = trimmedLine.match(/^\d+\.\s+(.+)$/);
    if (orderedListItem) {
      closeParagraph();
      if (listType !== 'ol') {
        closeList();
        listType = 'ol';
        html.push('<ol>');
      }
      html.push(`<li>${renderMarkdownInline(orderedListItem[1])}</li>`);
      continue;
    }

    const quote = trimmedLine.match(/^>\s?(.+)$/);
    if (quote) {
      closeParagraph();
      closeList();
      html.push(`<blockquote>${renderMarkdownInline(quote[1])}</blockquote>`);
      continue;
    }

    closeList();
    paragraph.push(trimmedLine);
  }

  if (codeBlock) {
    html.push(`<pre><code>${escapeHtml(codeBlock.join('\n'))}</code></pre>`);
  }
  closeParagraph();
  closeList();

  return sanitizeRichText(html.join('\n'));
}

function MarkdownPreview({ value }: { value: string }) {
  return (
    <div
      className="markdown-preview"
      dangerouslySetInnerHTML={{ __html: markdownToHtml(value) }}
    />
  );
}

function AutoResizeTextarea({
  ariaLabel,
  value,
  onChange
}: {
  ariaLabel: string;
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
      rows={1}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function plainTextFromMarkdown(value: string) {
  return value
    .replace(/^#+\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .trim();
}

type GeneratedDescriptionParts = {
  hasKnownSection: boolean;
  subject: string;
  descriptionMarkdown: string;
  resultMarkdown: string;
};

function generatedSectionKey(value: string): 'title' | 'description' | 'result' | null {
  const normalized = value.toLocaleLowerCase('ru-RU');
  if (normalized.includes('заголов')) {
    return 'title';
  }
  if (normalized.includes('описан') || normalized.includes('постанов')) {
    return 'description';
  }
  if (normalized.includes('результ') || normalized.includes('комментар')) {
    return 'result';
  }
  return null;
}

function parseGeneratedDescriptionDocument(value: string, fallbackSubject: string): GeneratedDescriptionParts {
  const sections: Record<'title' | 'description' | 'result', string[]> = {
    title: [],
    description: [],
    result: []
  };
  let currentSection: keyof typeof sections | null = null;
  let hasKnownSection = false;

  for (const line of value.replace(/\r\n/g, '\n').split('\n')) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const sectionKey = generatedSectionKey(heading[2]);
      if (sectionKey) {
        currentSection = sectionKey;
        hasKnownSection = true;
        continue;
      }
      currentSection = null;
    }

    if (currentSection) {
      sections[currentSection].push(line);
    }
  }

  const title = plainTextFromMarkdown(sections.title.join('\n').replace(/^\n+|\n+$/g, '')).split('\n')[0] || fallbackSubject;
  const descriptionMarkdown = hasKnownSection
    ? sections.description.join('\n').replace(/^\n+|\n+$/g, '')
    : value.trim();
  const resultMarkdown = sections.result.join('\n').replace(/^\n+|\n+$/g, '');

  return {
    hasKnownSection,
    subject: title,
    descriptionMarkdown,
    resultMarkdown
  };
}

function buildGeneratedDescriptionDocument(issueId: string, parts: Omit<GeneratedDescriptionParts, 'hasKnownSection'>) {
  return [
    `# Redmine #${issueId}`.trim(),
    '',
    '## Заголовок',
    parts.subject,
    '',
    '## Описание',
    parts.descriptionMarkdown,
    '',
    '## Результат работ',
    parts.resultMarkdown
  ].join('\n') + '\n';
}

function generatedCommentMarker(issueId: string) {
  return `${generatedCommentMarkerPrefix}:${issueId}`;
}

function markGeneratedComment(issueId: string, notes: string) {
  return `${notes}\n<!-- ${generatedCommentMarker(issueId)} -->`;
}

function stripHtmlComments(value: string) {
  return value.replace(/<!--[\s\S]*?-->/g, '');
}

function normalizedRichText(value: string) {
  const parser = new DOMParser();
  const document = parser.parseFromString(`<div>${stripHtmlComments(value)}</div>`, 'text/html');
  return (document.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function findGeneratedCommentJournalId(
  details: RedmineIssueDetails | null,
  issueId: string,
  previousNotes: string,
  nextNotes: string
) {
  const storedJournalId = loadAppliedGeneratedCommentJournals()[issueId];
  const journals = detailArray(details, 'journals')
    .map((journal) => asRecord(journal))
    .filter((journal): journal is Record<string, unknown> => Boolean(journal));

  if (storedJournalId && journals.some((journal) => stringValue(journal.id) === storedJournalId)) {
    return storedJournalId;
  }

  const marker = generatedCommentMarker(issueId);
  const markedJournal = journals.find((journal) => stringValue(journal.notes).includes(marker));
  if (markedJournal) {
    return stringValue(markedJournal.id);
  }

  const previousText = normalizedRichText(previousNotes);
  const nextText = normalizedRichText(nextNotes);
  const matchingJournal = [...journals].reverse().find((journal) => {
    const journalText = normalizedRichText(stringValue(journal.notes));
    return journalText && (journalText === previousText || journalText === nextText);
  });

  return matchingJournal ? stringValue(matchingJournal.id) : storedJournalId || '';
}

function RichText({ value, emptyText }: { value: string; emptyText: string }) {
  if (!value.trim()) {
    return <p className="my-task-detail-description">{emptyText}</p>;
  }

  const hasHtmlTags = /<\/?[a-z][\s\S]*>/i.test(value);
  return (
    <div
      className="my-task-rich-text"
      dangerouslySetInnerHTML={{ __html: hasHtmlTags ? sanitizeRichText(value) : markdownToHtml(value) }}
    />
  );
}

function PencilIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

function columnForStatus(status: string): TaskColumnId {
  const normalized = status.toLocaleLowerCase('ru-RU');
  return taskColumns.find((column) =>
    column.statusNeedles.some((needle) => normalized.includes(needle))
  )?.id ?? 'new';
}

function statusForColumn(columnId: TaskColumnId, statuses: RedmineOption[], issues: RedmineIssueSummary[]) {
  const column = taskColumns.find((item) => item.id === columnId);
  if (!column) {
    return null;
  }

  const fromCatalog = statuses.find((status) => {
    const normalized = status.name.toLocaleLowerCase('ru-RU');
    return column.statusNeedles.some((needle) => normalized.includes(needle));
  });
  if (fromCatalog) {
    return fromCatalog;
  }

  const fromIssues = issues.find((issue) => issue.statusId && columnForStatus(issue.status) === columnId);
  return fromIssues ? { id: fromIssues.statusId, name: fromIssues.status } : null;
}

export function MyTasks({
  state,
  onState,
  onOpenSettings,
  onNotify
}: {
  state: AppState;
  onState: (state: AppState) => void;
  onOpenSettings: () => void;
  onNotify: (message: string, avatar?: { src: string | null; label: string }) => void;
}) {
  const [selectedSprintId, setSelectedSprintId] = useState(() => preferredSprintId(state));
  const [issues, setIssues] = useState<RedmineIssueSummary[]>([]);
  const [loadingIssues, setLoadingIssues] = useState(false);
  const [syncingIssues, setSyncingIssues] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [refreshingSprints, setRefreshingSprints] = useState(false);
  const [error, setError] = useState('');
  const [draggingIssueId, setDraggingIssueId] = useState('');
  const [addingColumnId, setAddingColumnId] = useState<TaskColumnId | ''>('');
  const [newIssueTitle, setNewIssueTitle] = useState('');
  const [newIssueDescription, setNewIssueDescription] = useState('');
  const [creatingIssueForColumn, setCreatingIssueForColumn] = useState<TaskColumnId | ''>('');
  const [formattingIssueIds, setFormattingIssueIds] = useState<Record<string, boolean>>({});
  const [generatedDescriptions, setGeneratedDescriptions] = useState<Record<string, string>>(loadGeneratedDescriptions);
  const [lastAiResult, setLastAiResult] = useState<{ issueId: string; outputFile: string } | null>(null);
  const [generatedDescriptionViewer, setGeneratedDescriptionViewer] = useState<GeneratedDescriptionViewer | null>(null);
  const [sprintResultsViewer, setSprintResultsViewer] = useState<SprintResultsViewer | null>(null);
  const [generatingSprintResults, setGeneratingSprintResults] = useState(false);
  const [sendingSprintResults, setSendingSprintResults] = useState(false);
  const [selectedSprintResultsRecipientId, setSelectedSprintResultsRecipientId] = useState('');
  const [aiMessage, setAiMessage] = useState('');
  const [selectedIssue, setSelectedIssue] = useState<RedmineIssueSummary | null>(null);
  const [selectedIssueDetails, setSelectedIssueDetails] = useState<RedmineIssueDetails | null>(null);
  const [loadingIssueDetails, setLoadingIssueDetails] = useState(false);
  const [issueDetailsError, setIssueDetailsError] = useState('');
  const [editingIssueDetails, setEditingIssueDetails] = useState(false);
  const [editIssueFocus, setEditIssueFocus] = useState<'subject' | 'description'>('description');
  const [editIssueSubject, setEditIssueSubject] = useState('');
  const [editIssueDescription, setEditIssueDescription] = useState('');
  const [savingIssueDetails, setSavingIssueDetails] = useState(false);
  const [editingIssueAssignee, setEditingIssueAssignee] = useState(false);
  const [editIssueAssigneeId, setEditIssueAssigneeId] = useState('');
  const [savingIssueAssignee, setSavingIssueAssignee] = useState(false);
  const [editingIssueSprint, setEditingIssueSprint] = useState(false);
  const [editIssueSprintId, setEditIssueSprintId] = useState('');
  const [savingIssueSprint, setSavingIssueSprint] = useState(false);
  const [deletingIssue, setDeletingIssue] = useState(false);
  const [agentLauncher, setAgentLauncher] = useState<AgentLauncherDialog | null>(null);
  const [newIssueComment, setNewIssueComment] = useState('');
  const [savingIssueComment, setSavingIssueComment] = useState(false);
  const [editingJournalId, setEditingJournalId] = useState('');
  const [editJournalNotes, setEditJournalNotes] = useState('');
  const [savingJournalId, setSavingJournalId] = useState('');
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null);
  const requestId = useRef(0);
  const detailsRequestId = useRef(0);
  const generatedDescriptionRequestId = useRef(0);
  const editIssueSubjectRef = useRef<HTMLInputElement | null>(null);
  const editIssueDescriptionRef = useRef<HTMLTextAreaElement | null>(null);
  const editJournalNotesRef = useRef<HTMLTextAreaElement | null>(null);

  const projects = Array.isArray(state.redmine.projects) ? state.redmine.projects : [];
  const sprints = Array.isArray(state.redmine.sprints) ? state.redmine.sprints : [];
  const statuses = Array.isArray(state.redmine.statuses) ? state.redmine.statuses : [];
  const assignableUsers = Array.isArray(state.redmine.users) ? state.redmine.users : [];
  const gitlabSourceProjects = (
    state.gitlab.selectedProjectIds.length > 0
      ? state.gitlab.projects.filter((sourceProject) => state.gitlab.selectedProjectIds.includes(sourceProject.id))
      : state.gitlab.projects
  );
  const projectId = state.workspace.defaultProjectId;
  const defaultAssigneeId = state.workspace.defaultAssigneeId;
  const projectName = optionName(projects, projectId);
  const sprintName = optionName(sprints, selectedSprintId);
  const redmineReady = state.redmine.status === 'connected' && state.redmine.hasApiKey;
  const issuesByColumn = taskColumns.reduce<Record<TaskColumnId, RedmineIssueSummary[]>>(
    (groups, column) => {
      groups[column.id] = [];
      return groups;
    },
    {} as Record<TaskColumnId, RedmineIssueSummary[]>
  );

  for (const issue of issues) {
    issuesByColumn[columnForStatus(issue.status)].push(issue);
  }
  const issueIdsKey = issues.map((issue) => issue.id).join('|');

  function currentSelectedIssueAssigneeId() {
    const assignedTo = issueDetail(selectedIssueDetails)?.assigned_to;
    const detailAssigneeId = namedId(assignedTo);
    if (detailAssigneeId) {
      return detailAssigneeId;
    }
    if (!selectedIssue?.assignee) {
      return '';
    }
    return assignableUsers.find((user) => user.name === selectedIssue.assignee)?.id ?? '';
  }

  function currentSelectedIssueSprintId() {
    const detail = issueDetail(selectedIssueDetails);
    const fixedVersionId = namedId(detail?.fixed_version);
    if (fixedVersionId) {
      const versionSprintId = `version:${fixedVersionId}`;
      if (sprints.some((sprint) => sprint.id === versionSprintId)) {
        return versionSprintId;
      }
    }
    const easySprintId = namedId(detail?.easy_sprint);
    if (easySprintId) {
      const sprintId = `easy:${easySprintId}`;
      if (sprints.some((sprint) => sprint.id === sprintId)) {
        return sprintId;
      }
    }
    const agileSprintId = namedId(detail?.agile_sprint) || stringValue(asRecord(detail?.agile_data)?.agile_sprint_id);
    if (agileSprintId) {
      const sprintId = `agile:${agileSprintId}`;
      if (sprints.some((sprint) => sprint.id === sprintId)) {
        return sprintId;
      }
    }
    return selectedSprintId;
  }

  useEffect(() => {
    if (!selectedIssue) {
      return;
    }
    setEditIssueSubject(detailText(selectedIssueDetails, 'subject') || selectedIssue.subject);
    setEditIssueDescription(detailText(selectedIssueDetails, 'description'));
  }, [selectedIssue, selectedIssueDetails]);

  useEffect(() => {
    if (!selectedIssue || editingIssueAssignee) {
      return;
    }
    setEditIssueAssigneeId(currentSelectedIssueAssigneeId());
  }, [assignableUsers, editingIssueAssignee, selectedIssue, selectedIssueDetails]);

  useEffect(() => {
    if (!selectedIssue || editingIssueSprint) {
      return;
    }
    setEditIssueSprintId(currentSelectedIssueSprintId());
  }, [editingIssueSprint, selectedIssue, selectedIssueDetails, selectedSprintId, sprints]);

  useEffect(() => {
    if (!editingIssueDetails) {
      return;
    }
    window.setTimeout(() => {
      if (editIssueFocus === 'subject') {
        editIssueSubjectRef.current?.focus();
        editIssueSubjectRef.current?.select();
        return;
      }
      editIssueDescriptionRef.current?.focus();
    }, 0);
  }, [editIssueFocus, editingIssueDetails]);

  useEffect(() => {
    if (!editingJournalId) {
      return;
    }
    window.setTimeout(() => {
      editJournalNotesRef.current?.focus();
    }, 0);
  }, [editingJournalId]);

  useEffect(() => {
    if (!generatedDescriptionViewer && !sprintResultsViewer) {
      return undefined;
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setGeneratedDescriptionViewer(null);
        setSprintResultsViewer(null);
      }
    }

    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [generatedDescriptionViewer, sprintResultsViewer]);

  useEffect(() => {
    setSelectedSprintId((current) => {
      if (current && sprints.some((sprint) => sprint.id === current)) {
        return current;
      }
      return preferredSprintId(state);
    });
  }, [sprints, state]);

  useEffect(() => {
    const match = aiMessage.match(/^AI-описание задачи #(.+?) сохранено: (.+)$/s);
    if (!match) {
      return;
    }

    const [, issueId, outputFile] = match;
    setLastAiResult({ issueId, outputFile });
    setGeneratedDescriptions((current) => {
      if (current[issueId] === outputFile) {
        return current;
      }
      const next = { ...current, [issueId]: outputFile };
      saveGeneratedDescriptions(next);
      return next;
    });
  }, [aiMessage]);

  useEffect(() => {
    if (!redmineReady || !projectId || !selectedSprintId || sprints.length === 0) {
      setIssues([]);
      setLastSyncedAt(null);
      setLoadingIssues(false);
      setSyncingIssues(false);
      return;
    }

    const nextRequestId = requestId.current + 1;
    requestId.current = nextRequestId;
    setLoadingIssues(true);
    setSyncingIssues(false);
    setError('');

    async function loadIssues() {
      try {
        const response = await api.loadRedmineMyIssues({ projectId, sprintId: selectedSprintId, assigneeId: defaultAssigneeId });
        if (requestId.current === nextRequestId) {
          setIssues(response.issues);
          setLastSyncedAt(response.syncedAt);
          setError(response.error ?? '');
          setLoadingIssues(false);
        }
        if (response.source !== 'cache' || requestId.current !== nextRequestId) {
          return;
        }

        setSyncingIssues(true);
        try {
          const syncedResponse = await api.syncRedmineMyIssues({ projectId, sprintId: selectedSprintId, assigneeId: defaultAssigneeId });
          if (requestId.current === nextRequestId) {
            setIssues((currentIssues) =>
              mergeSyncedIssuesPreservingOrder(currentIssues, syncedResponse.issues)
            );
            setLastSyncedAt(syncedResponse.syncedAt);
            setError(syncedResponse.error ?? '');
          }
        } catch (syncError) {
          if (requestId.current === nextRequestId) {
            setError(syncError instanceof Error ? syncError.message : 'Не удалось синхронизировать задачи Redmine.');
          }
        }
      } catch (loadError) {
        if (requestId.current === nextRequestId) {
          setIssues([]);
          setLastSyncedAt(null);
          setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить задачи Redmine.');
        }
      } finally {
        if (requestId.current === nextRequestId) {
          setLoadingIssues(false);
          setSyncingIssues(false);
        }
      }
    }

    void loadIssues();
  }, [defaultAssigneeId, projectId, redmineReady, selectedSprintId, sprints.length]);

  useEffect(() => {
    const issueIds = issueIdsKey.split('|').filter(Boolean);
    if (issueIds.length === 0) {
      return;
    }

    let cancelled = false;
    api.loadLatestGeneratedDescriptions({ issueIds })
      .then((descriptions) => {
        if (cancelled || Object.keys(descriptions).length === 0) {
          return;
        }
        setGeneratedDescriptions((current) => {
          const next = { ...current, ...descriptions };
          if (JSON.stringify(next) === JSON.stringify(current)) {
            return current;
          }
          saveGeneratedDescriptions(next);
          return next;
        });
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [issueIdsKey]);

  async function refreshIssues() {
    if (!projectId || !selectedSprintId || loadingIssues || syncingIssues) {
      return;
    }

    setSyncingIssues(true);
    setError('');
    setAiMessage('');
    try {
      const response = await api.syncRedmineMyIssues({ projectId, sprintId: selectedSprintId, assigneeId: defaultAssigneeId });
      setIssues((currentIssues) => mergeSyncedIssuesPreservingOrder(currentIssues, response.issues));
      setLastSyncedAt(response.syncedAt);
      setError(response.error ?? '');
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : 'Не удалось синхронизировать задачи Redmine.');
    } finally {
      setSyncingIssues(false);
    }
  }

  async function generateSprintResults() {
    if (!projectId || !selectedSprintId || generatingSprintResults) {
      return;
    }
    if (issues.length === 0) {
      setError('В выбранном спринте нет задач для анализа.');
      return;
    }

    setGeneratingSprintResults(true);
    setError('');
    setAiMessage('AI готовит результаты спринта. Обычно это занимает 1-5 минут.');
    setSprintResultsViewer({
      content: '',
      rows: [],
      outputFile: '',
      loading: true,
      error: ''
    });
    setSelectedSprintResultsRecipientId('');

    try {
      const result = await api.generateRedmineSprintResultsWithAi({
        projectId,
        projectName,
        sprintId: selectedSprintId,
        sprintName,
        issues
      });
      setSprintResultsViewer({
        content: result.content,
        rows: parseSprintResultRows(result.content),
        outputFile: result.outputFile,
        loading: false,
        error: ''
      });
      setAiMessage(`Результаты спринта сохранены: ${result.outputFile}`);
    } catch (sprintResultsError) {
      const message = sprintResultsError instanceof Error
        ? sprintResultsError.message
        : 'Не удалось подготовить результаты спринта.';
      setSprintResultsViewer({
        content: '',
        rows: [],
        outputFile: '',
        loading: false,
        error: message
      });
      setError(message);
      setAiMessage('');
    } finally {
      setGeneratingSprintResults(false);
    }
  }

  async function sendSprintResultsToTelegram(rows: SprintResultRow[], recipientChatId: string) {
    if (sendingSprintResults) {
      return;
    }
    const text = rows.map((row) => row.text).filter((rowText) => rowText.trim()).join('\n');
    const recipientChat = state.telegram.chats.find((chat) =>
      chat.id === recipientChatId && chat.selected && chat.type === 'private'
    );
    if (!text) {
      setError('Нет строк для отправки в Telegram.');
      return;
    }
    if (!recipientChatId) {
      setError('Сначала выберите одного получателя Telegram.');
      return;
    }
    if (!recipientChat) {
      setError('Выбранный получатель недоступен. Проверьте личные Telegram-чаты в настройках.');
      return;
    }
    if (state.telegram.status !== 'connected') {
      setError('Telegram не подключен.');
      return;
    }

    setSendingSprintResults(true);
    setError('');
    setAiMessage(`Отправляю результаты спринта в Telegram: ${recipientChat.title}.`);
    try {
      const nextState = await api.sendTelegramMessage({
        chatId: recipientChat.id,
        text
      });
      onState(nextState);
      setSprintResultsViewer(null);
      setAiMessage('');
      onNotify(`Отправлено в Telegram пользователю ${recipientChat.title}`, {
        src: recipientChat.avatar,
        label: recipientChat.title
      });
    } catch (sendError) {
      const message = sendError instanceof Error
        ? sendError.message
        : 'Не удалось отправить результаты спринта в Telegram.';
      setError(message);
      setAiMessage('');
    } finally {
      setSendingSprintResults(false);
    }
  }

  async function refreshSprints() {
    if (!projectId || refreshingSprints) {
      return;
    }
    setRefreshingSprints(true);
    setError('');
    setAiMessage('');
    try {
      const nextState = await api.loadRedmineProjectUsers({ projectId });
      onState(nextState);
      setSelectedSprintId(preferredSprintId(nextState));
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Не удалось обновить спринты Redmine.');
    } finally {
      setRefreshingSprints(false);
    }
  }

  async function moveIssue(issueId: string, columnId: TaskColumnId) {
    const issue = issues.find((item) => item.id === issueId);
    const nextStatus = statusForColumn(columnId, statuses, issues);
    if (!issue || !nextStatus || issue.statusId === nextStatus.id) {
      return;
    }

    const previousIssues = issues;
    setError('');
    setAiMessage('');
    setIssues((currentIssues) =>
      currentIssues.map((item) =>
        item.id === issueId ? { ...item, statusId: nextStatus.id, status: nextStatus.name } : item
      )
    );

    try {
      const details = await api.updateRedmineIssueStatus({
        issueId,
        statusId: nextStatus.id,
        status: nextStatus.name,
        projectId,
        sprintId: selectedSprintId,
        cacheAssigneeId: defaultAssigneeId
      });
      const actualStatusId = namedId(issueDetail(details)?.status);
      const actualStatusName = detailNamedText(details, 'status');
      const confirmedStatusId = actualStatusId || nextStatus.id;
      const confirmedStatusName = actualStatusName || nextStatus.name;
      const confirmedIssue = {
        ...issue,
        statusId: confirmedStatusId,
        status: confirmedStatusName,
        updatedOn: detailText(details, 'updated_on') || issue.updatedOn
      };
      setIssues((currentIssues) =>
        currentIssues.map((item) => item.id === issueId ? confirmedIssue : item)
      );
      if (selectedIssue?.id === issueId) {
        setSelectedIssue(confirmedIssue);
        setSelectedIssueDetails(details);
      }
      if (actualStatusId && actualStatusId !== nextStatus.id) {
        setError(`Redmine оставил задачу в статусе "${confirmedStatusName}". Проверьте workflow переходов для этого трекера.`);
      }
    } catch (moveError) {
      setIssues(previousIssues);
      setError(moveError instanceof Error ? moveError.message : 'Не удалось изменить статус задачи Redmine.');
    }
  }

  function dropIssue(event: DragEvent, columnId: TaskColumnId) {
    event.preventDefault();
    event.stopPropagation();
    const issueId = event.dataTransfer.getData('text/plain') || draggingIssueId;
    setDraggingIssueId('');
    void moveIssue(issueId, columnId);
  }

  function openNewIssueForm(columnId: TaskColumnId) {
    setAddingColumnId(columnId);
    setNewIssueTitle('');
    setNewIssueDescription('');
    setError('');
    setAiMessage('');
  }

  async function createIssueInColumn(columnId: TaskColumnId) {
    const subject = newIssueTitle.trim();
    if (!subject || creatingIssueForColumn) {
      return;
    }

    const nextStatus = statusForColumn(columnId, statuses, issues);
    if (!nextStatus) {
      setError('В Redmine не найден статус для выбранной колонки.');
      return;
    }

    setCreatingIssueForColumn(columnId);
    setError('');
    setAiMessage('');
    try {
      const createdIssue = await api.createRedmineIssue({
        projectId,
        sprintId: selectedSprintId,
        subject,
        description: newIssueDescription.trim(),
        trackerId: state.workspace.defaultTrackerId,
        tracker: optionName(state.redmine.trackers, state.workspace.defaultTrackerId),
        priorityId: state.workspace.defaultPriorityId,
        priority: optionName(state.redmine.priorities, state.workspace.defaultPriorityId),
        assigneeId: state.workspace.defaultAssigneeId,
        assignee: optionName(state.redmine.users, state.workspace.defaultAssigneeId),
        statusId: nextStatus.id,
        status: nextStatus.name
      });
      setIssues((currentIssues) => [createdIssue, ...currentIssues.filter((issue) => issue.id !== createdIssue.id)]);
      setAddingColumnId('');
      setNewIssueTitle('');
      setNewIssueDescription('');
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Не удалось создать задачу Redmine.');
    } finally {
      setCreatingIssueForColumn('');
    }
  }

  async function formatIssueWithAi(issue: RedmineIssueSummary, columnTitle: string) {
    setError('');
    setAiMessage(`AI оформляет задачу #${issue.id}. Обычно это занимает 1-5 минут.`);
    setLastAiResult(null);
    setFormattingIssueIds((current) => ({ ...current, [issue.id]: true }));
    try {
      const result = await api.formatRedmineIssueWithAi({
        issue,
        projectId,
        projectName,
        sprintId: selectedSprintId,
        sprintName,
        columnName: columnTitle
      });
      setGeneratedDescriptions((current) => {
        const next = { ...current, [issue.id]: result.outputFile };
        saveGeneratedDescriptions(next);
        return next;
      });
      setLastAiResult({ issueId: issue.id, outputFile: result.outputFile });
      setAiMessage(`AI-описание задачи #${issue.id} сохранено: ${result.outputFile}`);
    } catch (formatError) {
      setError(formatError instanceof Error ? formatError.message : 'Не удалось оформить задачу через AI.');
    } finally {
      setFormattingIssueIds((current) => {
        const next = { ...current };
        delete next[issue.id];
        return next;
      });
    }
  }

  async function openGeneratedDescription(filePath: string, issueId = issueIdFromGeneratedDescriptionPath(filePath)) {
    if (!filePath) {
      return;
    }

    const nextRequestId = generatedDescriptionRequestId.current + 1;
    generatedDescriptionRequestId.current = nextRequestId;
    setError('');
    setGeneratedDescriptionViewer({
      path: filePath,
      issueId,
      content: '',
      draftContent: '',
      parts: null,
      loading: true,
      savingFile: false,
      applyingToRedmine: false,
      message: '',
      error: ''
    });
    try {
      const content = await api.readTextFile(filePath);
      if (generatedDescriptionRequestId.current === nextRequestId) {
        setGeneratedDescriptionViewer({
          path: filePath,
          issueId,
          content,
          draftContent: content,
          parts: null,
          loading: false,
          savingFile: false,
          applyingToRedmine: false,
          message: '',
          error: ''
        });
      }
    } catch (openError) {
      if (generatedDescriptionRequestId.current === nextRequestId) {
        setGeneratedDescriptionViewer({
          path: filePath,
          issueId,
          content: '',
          draftContent: '',
          parts: null,
          loading: false,
          savingFile: false,
          applyingToRedmine: false,
          message: '',
          error: openError instanceof Error ? openError.message : 'Не удалось открыть AI-описание.'
        });
      }
    }
  }

  async function saveGeneratedDescriptionFile() {
    if (!generatedDescriptionViewer || generatedDescriptionViewer.savingFile) {
      return;
    }

    const { path: filePath, draftContent } = generatedDescriptionViewer;
    setGeneratedDescriptionViewer((current) => current
      ? { ...current, savingFile: true, error: '', message: '' }
      : current);
    try {
      await api.writeTextFile({ filePath, content: draftContent });
      setGeneratedDescriptionViewer((current) => current
        ? {
            ...current,
            content: draftContent,
            savingFile: false,
            message: 'Файл сохранен.'
          }
        : current);
    } catch (saveError) {
      setGeneratedDescriptionViewer((current) => current
        ? {
            ...current,
            savingFile: false,
            error: saveError instanceof Error ? saveError.message : 'Не удалось сохранить файл.'
          }
        : current);
    }
  }

  async function applyGeneratedDescriptionToRedmine() {
    if (!generatedDescriptionViewer || generatedDescriptionViewer.applyingToRedmine) {
      return;
    }

    const issueId = generatedDescriptionViewer.issueId;
    const issue = issues.find((item) => item.id === issueId) ?? (selectedIssue?.id === issueId ? selectedIssue : null);
    if (!issueId || !issue) {
      setGeneratedDescriptionViewer((current) => current
        ? { ...current, error: 'Не удалось определить задачу Redmine для этого описания.' }
        : current);
      return;
    }

    const fallbackSubject = selectedIssue?.id === issueId
      ? detailText(selectedIssueDetails, 'subject') || selectedIssue.subject
      : issue.subject;
    const parsedDocument = generatedDescriptionViewer.parts
      ?? parseGeneratedDescriptionDocument(generatedDescriptionViewer.draftContent, fallbackSubject);
    const previousParsedDocument = parseGeneratedDescriptionDocument(
      generatedDescriptionViewer.content,
      fallbackSubject
    );
    const subject = parsedDocument.subject;
    const description = markdownToHtml(parsedDocument.descriptionMarkdown);
    const resultNotes = parsedDocument.resultMarkdown
      ? markdownToHtml(parsedDocument.resultMarkdown)
      : '';
    const previousResultNotes = previousParsedDocument.resultMarkdown
      ? markdownToHtml(previousParsedDocument.resultMarkdown)
      : '';

    setGeneratedDescriptionViewer((current) => current
      ? { ...current, applyingToRedmine: true, error: '', message: '' }
      : current);
    try {
      await api.writeTextFile({
        filePath: generatedDescriptionViewer.path,
        content: generatedDescriptionViewer.draftContent
      });
      const details = await api.updateRedmineIssueDetails({
        issueId,
        subject,
        description
      });
      let nextDetails = details;
      if (resultNotes) {
        const journalId = findGeneratedCommentJournalId(
          selectedIssue?.id === issueId ? selectedIssueDetails : null,
          issueId,
          previousResultNotes,
          resultNotes
        );
        const markedResultNotes = markGeneratedComment(issueId, resultNotes);
        nextDetails = journalId
          ? await api.updateRedmineIssueJournal({ issueId, journalId, notes: markedResultNotes })
          : await api.addRedmineIssueComment({ issueId, notes: markedResultNotes });
        const nextJournalId = findGeneratedCommentJournalId(nextDetails, issueId, markedResultNotes, markedResultNotes);
        if (nextJournalId) {
          saveAppliedGeneratedCommentJournal(issueId, nextJournalId);
        }
      }
      const updatedOn = detailText(nextDetails, 'updated_on') || new Date().toISOString();
      setIssues((currentIssues) =>
        currentIssues.map((currentIssue) =>
          currentIssue.id === issueId ? { ...currentIssue, subject, updatedOn } : currentIssue
        )
      );
      if (selectedIssue?.id === issueId) {
        setSelectedIssue({ ...selectedIssue, subject, updatedOn });
        setSelectedIssueDetails(nextDetails);
        setEditingIssueDetails(false);
      }
      setGeneratedDescriptionViewer((current) => current
        ? {
            ...current,
            content: current.draftContent,
            applyingToRedmine: false,
            message: resultNotes
              ? 'Заголовок, описание и результат работ применены в Redmine.'
              : 'Заголовок и описание применены в Redmine. Результат работ пустой, комментарий не добавлен.'
          }
        : current);
    } catch (applyError) {
      setGeneratedDescriptionViewer((current) => current
        ? {
            ...current,
            applyingToRedmine: false,
            error: applyError instanceof Error ? applyError.message : 'Не удалось применить описание в Redmine.'
          }
        : current);
    }
  }

  async function openGeneratedDescriptionInSystem(filePath: string) {
    if (!filePath) {
      return;
    }

    setError('');
    try {
      const openError = await api.openPath(filePath);
      if (openError) {
        setError(openError);
      }
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : 'Не удалось открыть файл.');
    }
  }

  async function openIssue(issue: RedmineIssueSummary) {
    const nextRequestId = detailsRequestId.current + 1;
    detailsRequestId.current = nextRequestId;
    setSelectedIssue(issue);
    setSelectedIssueDetails(null);
    setIssueDetailsError('');
    setEditingIssueDetails(false);
    setNewIssueComment('');
    setEditingJournalId('');
    setEditJournalNotes('');
    setLoadingIssueDetails(true);
    try {
      const details = await api.loadRedmineIssueDetails({ issueId: issue.id });
      if (detailsRequestId.current === nextRequestId) {
        setSelectedIssueDetails(details);
      }
    } catch (detailsError) {
      if (detailsRequestId.current === nextRequestId) {
        setIssueDetailsError(detailsError instanceof Error ? detailsError.message : 'Не удалось загрузить задачу.');
      }
    } finally {
      if (detailsRequestId.current === nextRequestId) {
        setLoadingIssueDetails(false);
      }
    }
  }

  function closeIssue() {
    detailsRequestId.current += 1;
    setSelectedIssue(null);
    setSelectedIssueDetails(null);
    setLoadingIssueDetails(false);
    setIssueDetailsError('');
    setEditingIssueDetails(false);
    setEditingIssueAssignee(false);
    setEditIssueAssigneeId('');
    setEditingIssueSprint(false);
    setEditIssueSprintId('');
    setNewIssueComment('');
    setSavingIssueDetails(false);
    setSavingIssueAssignee(false);
    setSavingIssueSprint(false);
    setDeletingIssue(false);
    setAgentLauncher(null);
    setSavingIssueComment(false);
    setEditingJournalId('');
    setEditJournalNotes('');
    setSavingJournalId('');
  }

  function startEditingIssueDetails(focus: 'subject' | 'description') {
    setEditIssueFocus(focus);
    setEditingIssueDetails(true);
  }

  async function saveIssueDetails() {
    const subject = editIssueSubject.trim();
    if (!selectedIssue || !subject || savingIssueDetails) {
      return;
    }

    setSavingIssueDetails(true);
    setIssueDetailsError('');
    try {
      const details = await api.updateRedmineIssueDetails({
        issueId: selectedIssue.id,
        subject,
        description: editIssueDescription
      });
      const updatedOn = detailText(details, 'updated_on') || new Date().toISOString();
      const nextIssue = {
        ...selectedIssue,
        subject,
        updatedOn
      };
      setSelectedIssue(nextIssue);
      setIssues((currentIssues) =>
        currentIssues.map((issue) => issue.id === selectedIssue.id ? nextIssue : issue)
      );
      setSelectedIssueDetails(details);
      setEditingIssueDetails(false);
    } catch (saveError) {
      setIssueDetailsError(saveError instanceof Error ? saveError.message : 'Не удалось сохранить задачу.');
    } finally {
      setSavingIssueDetails(false);
    }
  }

  function startEditingIssueAssignee() {
    setEditIssueAssigneeId(currentSelectedIssueAssigneeId());
    setEditingIssueAssignee(true);
  }

  async function saveIssueAssignee() {
    if (!selectedIssue || savingIssueAssignee) {
      return;
    }

    const assignee = optionName(assignableUsers, editIssueAssigneeId);
    setSavingIssueAssignee(true);
    setIssueDetailsError('');
    try {
      const details = await api.updateRedmineIssueAssignee({
        issueId: selectedIssue.id,
        assigneeId: editIssueAssigneeId,
        assignee,
        projectId,
        sprintId: selectedSprintId,
        cacheAssigneeId: defaultAssigneeId
      });
      const updatedOn = detailText(details, 'updated_on') || new Date().toISOString();
      const nextAssignee = detailNamedText(details, 'assigned_to') || assignee;
      const nextIssue = {
        ...selectedIssue,
        assignee: nextAssignee,
        updatedOn
      };
      setSelectedIssue(nextIssue);
      setIssues((currentIssues) =>
        currentIssues.map((issue) => issue.id === selectedIssue.id ? nextIssue : issue)
      );
      setSelectedIssueDetails(details);
      setEditingIssueAssignee(false);
    } catch (saveError) {
      setIssueDetailsError(saveError instanceof Error ? saveError.message : 'Не удалось изменить исполнителя.');
    } finally {
      setSavingIssueAssignee(false);
    }
  }

  function startEditingIssueSprint() {
    setEditIssueSprintId(currentSelectedIssueSprintId());
    setEditingIssueSprint(true);
  }

  async function saveIssueSprint() {
    if (!selectedIssue || !editIssueSprintId || savingIssueSprint) {
      return;
    }

    const issueId = selectedIssue.id;
    setSavingIssueSprint(true);
    setIssueDetailsError('');
    try {
      const details = await api.updateRedmineIssueSprint({
        issueId,
        sprintId: editIssueSprintId,
        projectId,
        previousSprintId: selectedSprintId,
        cacheAssigneeId: defaultAssigneeId
      });
      if (editIssueSprintId !== selectedSprintId) {
        setIssues((currentIssues) => currentIssues.filter((issue) => issue.id !== issueId));
        closeIssue();
        return;
      }
      setSelectedIssueDetails(details);
      setEditingIssueSprint(false);
    } catch (saveError) {
      setIssueDetailsError(saveError instanceof Error ? saveError.message : 'Не удалось изменить спринт.');
    } finally {
      setSavingIssueSprint(false);
    }
  }

  function selectedIssueAgentPayload(): RedmineIssueAiPayload | null {
    if (!selectedIssue) {
      return null;
    }
    const detail = issueDetail(selectedIssueDetails);
    const detailStatus = asRecord(detail?.status);
    const detailSprintId = currentSelectedIssueSprintId();
    const status = namedValue(detail?.status) || selectedIssue.status;
    const issue: RedmineIssueSummary = {
      ...selectedIssue,
      subject: detailText(selectedIssueDetails, 'subject') || selectedIssue.subject,
      tracker: detailNamedText(selectedIssueDetails, 'tracker') || selectedIssue.tracker,
      statusId: stringValue(detailStatus?.id) || selectedIssue.statusId,
      status,
      priority: detailNamedText(selectedIssueDetails, 'priority') || selectedIssue.priority,
      assignee: detailNamedText(selectedIssueDetails, 'assigned_to') || selectedIssue.assignee,
      dueDate: detailText(selectedIssueDetails, 'due_date') || selectedIssue.dueDate,
      updatedOn: detailText(selectedIssueDetails, 'updated_on') || selectedIssue.updatedOn,
      url: selectedIssue.url
    };
    const column = taskColumns.find((item) => item.id === columnForStatus(status));
    return {
      issue,
      projectId,
      projectName,
      sprintId: detailSprintId,
      sprintName: optionName(sprints, detailSprintId) || sprintName,
      columnName: column?.title ?? 'Новые'
    };
  }

  function openAgentLauncher() {
    const gitlabProjectId = gitlabSourceProjects[0]?.id ?? '';
    setAgentLauncher({
      workingDirectory: '',
      gitlabProjectId,
      prompt: '',
      running: false,
      error: '',
      sourceStatus: '',
      resultDirectory: ''
    });
    if (gitlabProjectId) {
      void fillGitLabWorkingDirectory(gitlabProjectId);
    }
  }

  async function fillGitLabWorkingDirectory(projectId: string) {
    try {
      const workingDirectory = await api.getGitLabProjectWorkspacePath({ projectId });
      setAgentLauncher((current) => current?.gitlabProjectId === projectId
        ? { ...current, workingDirectory, error: '' }
        : current);
    } catch (error) {
      setAgentLauncher((current) => current?.gitlabProjectId === projectId
        ? {
            ...current,
            error: error instanceof Error ? error.message : 'Не удалось определить рабочую папку проекта.'
          }
        : current);
    }
  }

  async function selectAgentWorkingDirectory() {
    if (!agentLauncher?.running) {
      const directory = await api.selectAgentWorkingDirectory();
      if (directory) {
        setAgentLauncher((current) => current
          ? { ...current, gitlabProjectId: '', workingDirectory: directory, error: '', sourceStatus: '' }
          : current);
      }
    }
  }

  async function runIssueAgent() {
    if (!agentLauncher || agentLauncher.running) {
      return;
    }
    const issuePayload = selectedIssueAgentPayload();
    if (!issuePayload) {
      setAgentLauncher((current) => current ? { ...current, error: 'Задача Redmine не выбрана.' } : current);
      return;
    }
    if (!agentLauncher.gitlabProjectId && !agentLauncher.workingDirectory.trim()) {
      setAgentLauncher((current) => current ? { ...current, error: 'Выберите рабочую папку агента.' } : current);
      return;
    }

    setAgentLauncher((current) => current
      ? {
          ...current,
          running: true,
          error: '',
          sourceStatus: current.gitlabProjectId ? 'Готовлю исходный код GitLab...' : '',
          resultDirectory: ''
        }
      : current);
    try {
      let workingDirectory = agentLauncher.workingDirectory.trim();
      if (agentLauncher.gitlabProjectId) {
        const workspace = await api.prepareGitLabProjectWorkspace({ projectId: agentLauncher.gitlabProjectId });
        workingDirectory = workspace.workingDirectory;
        setAgentLauncher((current) => current
          ? {
              ...current,
              workingDirectory,
              sourceStatus: workspace.action === 'cloned'
                ? `Репозиторий склонирован: ${workspace.projectName}.`
                : `Репозиторий обновлен: ${workspace.projectName}.`
            }
          : current);
      }
      const result = await api.runAgentForRedmineIssue({
        workingDirectory,
        prompt: agentLauncher.prompt,
        issue: issuePayload
      });
      setAgentLauncher((current) => current
        ? { ...current, running: false, sourceStatus: '', resultDirectory: result.directory }
        : current);
      setAiMessage(`Агент по задаче #${issuePayload.issue.id} запущен. Контекст: ${result.directory}`);
    } catch (runError) {
      setAgentLauncher((current) => current
        ? {
            ...current,
            running: false,
            error: runError instanceof Error ? runError.message : 'Не удалось запустить агента.'
          }
        : current);
    }
  }

  async function deleteIssue() {
    if (!selectedIssue || deletingIssue) {
      return;
    }
    if (!window.confirm(`Удалить задачу #${selectedIssue.id}?`)) {
      return;
    }

    const issueId = selectedIssue.id;
    setDeletingIssue(true);
    setIssueDetailsError('');
    try {
      await api.deleteRedmineIssue({
        issueId,
        projectId,
        sprintId: selectedSprintId,
        cacheAssigneeId: defaultAssigneeId
      });
      setIssues((currentIssues) => currentIssues.filter((issue) => issue.id !== issueId));
      closeIssue();
    } catch (deleteError) {
      setIssueDetailsError(deleteError instanceof Error ? deleteError.message : 'Не удалось удалить задачу.');
      setDeletingIssue(false);
    }
  }

  async function addIssueComment() {
    const notes = newIssueComment.trim();
    if (!selectedIssue || !notes || savingIssueComment) {
      return;
    }

    setSavingIssueComment(true);
    setIssueDetailsError('');
    try {
      const details = await api.addRedmineIssueComment({
        issueId: selectedIssue.id,
        notes
      });
      setSelectedIssueDetails(details);
      setNewIssueComment('');
    } catch (commentError) {
      setIssueDetailsError(commentError instanceof Error ? commentError.message : 'Не удалось добавить комментарий.');
    } finally {
      setSavingIssueComment(false);
    }
  }

  function startEditingJournal(journal: Record<string, unknown>) {
    setEditingJournalId(stringValue(journal.id));
    setEditJournalNotes(stringValue(journal.notes));
  }

  async function saveIssueJournal(journalId: string) {
    const notes = editJournalNotes.trim();
    if (!selectedIssue || !journalId || !notes || savingJournalId) {
      return;
    }

    setSavingJournalId(journalId);
    setIssueDetailsError('');
    try {
      const details = await api.updateRedmineIssueJournal({
        issueId: selectedIssue.id,
        journalId,
        notes
      });
      setSelectedIssueDetails(details);
      setEditingJournalId('');
      setEditJournalNotes('');
    } catch (journalError) {
      setIssueDetailsError(journalError instanceof Error ? journalError.message : 'Не удалось сохранить комментарий.');
    } finally {
      setSavingJournalId('');
    }
  }

  function renderSprintResultsViewer() {
    if (!sprintResultsViewer) {
      return null;
    }
    const resultRows = sprintResultsViewer.rows;
    const selectedTelegramPeople = state.telegram.chats.filter((chat) => chat.selected && chat.type === 'private');
    const recipientOptions = selectedTelegramPeople.map((chat) => ({ id: chat.id, name: chat.title }));
    const recipientAvailable = selectedTelegramPeople.some((chat) => chat.id === selectedSprintResultsRecipientId);

    function removeSprintResultRow(rowIndex: number) {
      const nextRows = resultRows.filter((_row, index) => index !== rowIndex);
      setSprintResultsViewer((currentViewer) =>
        currentViewer
          ? {
              ...currentViewer,
              rows: nextRows,
              content: nextRows.map((row) => row.text).join('\n')
            }
          : currentViewer
      );
    }

    function updateSprintResultRow(rowIndex: number, nextText: string) {
      const nextRows = resultRows.map((row, index) =>
        index === rowIndex ? { ...row, text: nextText } : row
      );
      setSprintResultsViewer((currentViewer) =>
        currentViewer
          ? {
              ...currentViewer,
              rows: nextRows,
              content: nextRows.map((row) => row.text).join('\n')
            }
          : currentViewer
      );
    }

    function changeSprintResultsRecipient(nextRecipientId: string) {
      setSelectedSprintResultsRecipientId(nextRecipientId);
    }

    return (
      <div className="sprint-results-viewer" role="dialog" aria-modal="true" aria-label="Результаты спринта">
        <div
          className="generated-description-backdrop"
          onClick={() => setSprintResultsViewer(null)}
        />
        <section className="sprint-results-panel">
          <header className="generated-description-header sprint-results-header">
            <div className="sprint-results-title">
              <span>AI-анализ</span>
              <h2>Результаты спринта</h2>
            </div>
            <button
              type="button"
              className="my-task-detail-close-button"
              aria-label="Закрыть результаты спринта"
              onClick={() => setSprintResultsViewer(null)}
            >
              ×
            </button>
            <div className="sprint-results-actions">
              <div className="sprint-results-recipient">
                <SearchableSelectField
                  label="Получатель"
                  value={recipientAvailable ? selectedSprintResultsRecipientId : ''}
                  options={recipientOptions}
                  onChange={changeSprintResultsRecipient}
                  placeholder={
                    selectedTelegramPeople.length > 0
                      ? 'Начните вводить имя'
                      : 'Нет выбранных людей'
                  }
                />
              </div>
              <button
                type="button"
                className="primary-action"
                disabled={
                  sprintResultsViewer.loading ||
                  Boolean(sprintResultsViewer.error) ||
                  resultRows.length === 0 ||
                  !recipientAvailable ||
                  state.telegram.status !== 'connected' ||
                  sendingSprintResults
                }
                onClick={() => void sendSprintResultsToTelegram(resultRows, selectedSprintResultsRecipientId)}
              >
                {sendingSprintResults ? 'Отправка...' : 'Отправить в Telegram'}
              </button>
            </div>
          </header>
          {sprintResultsViewer.outputFile && (
            <div className="generated-description-path">{sprintResultsViewer.outputFile}</div>
          )}
          <div className="sprint-results-content">
            {sprintResultsViewer.loading && <p className="empty-state">AI готовит результаты спринта...</p>}
            {sprintResultsViewer.error && <p className="error-text">{sprintResultsViewer.error}</p>}
            {!sprintResultsViewer.loading && !sprintResultsViewer.error && resultRows.length > 0 && (
              <div className="sprint-results-list">
                {resultRows.map((row, index) => (
                  <div
                    // eslint-disable-next-line react/no-array-index-key
                    key={`${row.status}-${index}`}
                    className={`sprint-results-item ${row.status === 'success' ? 'success' : ''} ${
                      row.status === 'failure' ? 'failure' : ''
                    }`}
                  >
                    <textarea
                      value={row.text}
                      className="sprint-results-textarea"
                      aria-label={`Текст результата ${index + 1}`}
                      autoCorrect="off"
                      spellCheck={false}
                      rows={Math.max(1, row.text.split('\n').length)}
                      onChange={(event) => updateSprintResultRow(index, event.target.value)}
                    />
                    <button
                      type="button"
                      className="sprint-results-delete"
                      aria-label={`Удалить строку результата ${index + 1}`}
                      title="Удалить строку"
                      onClick={() => removeSprintResultRow(index)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            {!sprintResultsViewer.loading && !sprintResultsViewer.error && resultRows.length === 0 && (
              <MarkdownPreview value={sprintResultsViewer.content} />
            )}
          </div>
        </section>
      </div>
    );
  }

  function renderGeneratedDescriptionViewer() {
    if (!generatedDescriptionViewer) {
      return null;
    }
    const issue = issues.find((item) => item.id === generatedDescriptionViewer.issueId)
      ?? (selectedIssue?.id === generatedDescriptionViewer.issueId ? selectedIssue : null);
    const fallbackSubject = selectedIssue?.id === generatedDescriptionViewer.issueId
      ? detailText(selectedIssueDetails, 'subject') || selectedIssue.subject
      : issue?.subject || '';
    const parsedDocument = generatedDescriptionViewer.parts
      ?? parseGeneratedDescriptionDocument(generatedDescriptionViewer.draftContent, fallbackSubject);
    const updateGeneratedDescriptionPart = (
      nextPart: Partial<Omit<GeneratedDescriptionParts, 'hasKnownSection'>>
    ) => {
      setGeneratedDescriptionViewer((current) => {
        if (!current) {
          return current;
        }
        const currentParts = current.parts ?? parseGeneratedDescriptionDocument(current.draftContent, fallbackSubject);
        const nextParts = {
          hasKnownSection: true,
          subject: nextPart.subject ?? currentParts.subject,
          descriptionMarkdown: nextPart.descriptionMarkdown ?? currentParts.descriptionMarkdown,
          resultMarkdown: nextPart.resultMarkdown ?? currentParts.resultMarkdown
        };
        const nextContent = buildGeneratedDescriptionDocument(current.issueId, {
          subject: nextParts.subject,
          descriptionMarkdown: nextParts.descriptionMarkdown,
          resultMarkdown: nextParts.resultMarkdown
        });
        return { ...current, draftContent: nextContent, parts: nextParts, message: '' };
      });
    };

    return (
      <div className="generated-description-viewer" role="dialog" aria-modal="true" aria-label="AI-описание задачи">
        <div
          className="generated-description-backdrop"
          onClick={() => setGeneratedDescriptionViewer(null)}
        />
        <section className="generated-description-panel">
          <header className="generated-description-header">
            <div>
              <span>AI-описание</span>
              <h2>Редактор Redmine</h2>
            </div>
            <button
              type="button"
              className="my-task-detail-close-button"
              aria-label="Закрыть просмотрщик"
              onClick={() => setGeneratedDescriptionViewer(null)}
            >
              ×
            </button>
          </header>
          <div className="generated-description-path">{generatedDescriptionViewer.path}</div>
          <div className="generated-description-actions">
            <button
              type="button"
              className="secondary-action"
              disabled={generatedDescriptionViewer.loading}
              onClick={() => void openGeneratedDescriptionInSystem(generatedDescriptionViewer.path)}
            >
              Открыть файлом
            </button>
            <button
              type="button"
              className="secondary-action"
              disabled={generatedDescriptionViewer.loading || generatedDescriptionViewer.savingFile}
              onClick={() => void saveGeneratedDescriptionFile()}
            >
              {generatedDescriptionViewer.savingFile ? 'Сохраняем...' : 'Сохранить файл'}
            </button>
            <button
              type="button"
              className="primary-action"
              disabled={
                generatedDescriptionViewer.loading ||
                generatedDescriptionViewer.applyingToRedmine ||
                !generatedDescriptionViewer.issueId ||
                !generatedDescriptionViewer.draftContent.trim()
              }
              onClick={() => void applyGeneratedDescriptionToRedmine()}
            >
              {generatedDescriptionViewer.applyingToRedmine ? 'Применяем...' : 'Применить все в Redmine'}
            </button>
          </div>
          <div className="generated-description-content">
            {generatedDescriptionViewer.loading && <p className="empty-state">Загрузка описания...</p>}
            {generatedDescriptionViewer.error && <p className="error-text">{generatedDescriptionViewer.error}</p>}
            {generatedDescriptionViewer.message && <p className="success-text">{generatedDescriptionViewer.message}</p>}
            {!generatedDescriptionViewer.loading && !generatedDescriptionViewer.error && (
              <div className="generated-description-editor">
                {!parsedDocument.hasKnownSection && (
                  <section className="generated-description-warning">
                    <h3>Старый формат документа</h3>
                    <p className="inline-hint">
                      Файл открыт как описание задачи. После изменения любого блока он сохранится в формате с отдельными
                      секциями для заголовка, описания и комментария.
                    </p>
                  </section>
                )}
                <section className="generated-description-block">
                  <div className="generated-description-block-header">
                    <h3>Блок заголовка</h3>
                    <span>Будет записан в заголовок задачи Redmine</span>
                  </div>
                  <label>
                    <span>Заголовок задачи</span>
                    <input
                      aria-label="Заголовок задачи Redmine"
                      value={parsedDocument.subject}
                      onChange={(event) => updateGeneratedDescriptionPart({ subject: event.target.value })}
                    />
                  </label>
                </section>
                <section className="generated-description-block">
                  <div className="generated-description-block-header">
                    <h3>Блок описания</h3>
                    <span>
                      Будет записан в описание задачи Redmine. Markdown можно редактировать, предпросмотр ниже.
                    </span>
                  </div>
                  <label>
                    <span>Описание задачи</span>
                    <AutoResizeTextarea
                      ariaLabel="Описание задачи Redmine в Markdown"
                      value={parsedDocument.descriptionMarkdown}
                      onChange={(value) => updateGeneratedDescriptionPart({ descriptionMarkdown: value })}
                    />
                  </label>
                  <div className="generated-description-preview">
                    <span>Предпросмотр описания</span>
                    <MarkdownPreview value={parsedDocument.descriptionMarkdown || 'Описание пустое.'} />
                  </div>
                </section>
                <section className="generated-description-block">
                  <div className="generated-description-block-header">
                    <h3>Блок комментария</h3>
                    <span>
                      Будет добавлен как комментарий / результат работ. Если оставить пустым, комментарий не добавится.
                    </span>
                  </div>
                  <label>
                    <span>Комментарий / результат работ</span>
                    <AutoResizeTextarea
                      ariaLabel="Комментарий или результат работ в Markdown"
                      value={parsedDocument.resultMarkdown}
                      onChange={(value) => updateGeneratedDescriptionPart({ resultMarkdown: value })}
                    />
                  </label>
                  <div className="generated-description-preview">
                    <span>Предпросмотр комментария</span>
                    <MarkdownPreview value={parsedDocument.resultMarkdown || 'Комментарий не будет добавлен.'} />
                  </div>
                </section>
              </div>
            )}
          </div>
        </section>
      </div>
    );
  }

  function renderIssueDetailPanel() {
    if (!selectedIssue) {
      return null;
    }

    const detail = issueDetail(selectedIssueDetails);
    const description = detailText(selectedIssueDetails, 'description');
    const journals = detailArray(selectedIssueDetails, 'journals')
      .map((journal) => asRecord(journal))
      .filter((journal): journal is Record<string, unknown> => Boolean(journal))
      .filter((journal) => stringValue(journal.notes));
    const customFields = detailArray(selectedIssueDetails, 'custom_fields')
      .map((field) => asRecord(field))
      .filter((field): field is Record<string, unknown> => Boolean(field))
      .filter((field) => stringValue(field.value) || Array.isArray(field.value));
    const attachments = detailArray(selectedIssueDetails, 'attachments')
      .map((attachment) => asRecord(attachment))
      .filter((attachment): attachment is Record<string, unknown> => Boolean(attachment));
    const generatedDescriptionPath = generatedDescriptions[selectedIssue.id];
    const detailsTitle = stringValue(detail?.subject) || selectedIssue.subject;
    const assigneeName = detailNamedText(selectedIssueDetails, 'assigned_to') || selectedIssue.assignee || 'Не назначен';
    const sprintDisplayName =
      detailNamedText(selectedIssueDetails, 'fixed_version') ||
      detailNamedText(selectedIssueDetails, 'easy_sprint') ||
      detailNamedText(selectedIssueDetails, 'agile_sprint') ||
      optionName(sprints, currentSelectedIssueSprintId()) ||
      sprintName;
    const detailsMeta = [
      ['Проект', detailNamedText(selectedIssueDetails, 'project') || projectName],
      ['Трекер', detailNamedText(selectedIssueDetails, 'tracker') || selectedIssue.tracker],
      ['Статус', detailNamedText(selectedIssueDetails, 'status') || selectedIssue.status],
      ['Приоритет', detailNamedText(selectedIssueDetails, 'priority') || selectedIssue.priority],
      ['Исполнитель', assigneeName],
      ['Автор', detailNamedText(selectedIssueDetails, 'author')],
      ['Спринт', sprintDisplayName],
      ['Готовность', detailText(selectedIssueDetails, 'done_ratio') ? `${detailText(selectedIssueDetails, 'done_ratio')}%` : ''],
      ['Создана', formatIssueDateTime(detail?.created_on)],
      ['Обновлена', formatIssueDateTime(detail?.updated_on || selectedIssue.updatedOn)],
      ['Срок', detailText(selectedIssueDetails, 'due_date') || selectedIssue.dueDate]
    ].filter((item) => item[1]);

    return (
      <aside className="my-task-detail-panel" aria-label={`Задача #${selectedIssue.id}`}>
        <div className="my-task-detail-header">
          <div>
            <span>#{selectedIssue.id}</span>
            <div className="my-task-detail-title-row">
              {editingIssueDetails ? (
                <input
                  ref={editIssueSubjectRef}
                  className="my-task-detail-title-input"
                  aria-label="Название"
                  value={editIssueSubject}
                  onChange={(event) => setEditIssueSubject(event.target.value)}
                />
              ) : (
                <h2>{detailsTitle}</h2>
              )}
              <button
                type="button"
                className="my-task-edit-icon-button"
                aria-label={`Редактировать название задачи #${selectedIssue.id}`}
                disabled={savingIssueDetails}
                onClick={() => startEditingIssueDetails('subject')}
              >
                <PencilIcon />
              </button>
            </div>
          </div>
          <button
            type="button"
            className="my-task-detail-close-button"
            aria-label="Закрыть задачу"
            onClick={closeIssue}
          >
            ×
          </button>
        </div>

        {loadingIssueDetails && <p className="empty-state">Загрузка задачи...</p>}
        {issueDetailsError && <p className="error-text">{issueDetailsError}</p>}
        {agentLauncher && (
          <div className="my-task-agent-launcher" role="dialog" aria-modal="true" aria-label="Запуск агента">
            <div className="my-task-agent-launcher-panel">
              <div className="my-task-agent-launcher-header">
                <div>
                  <h3>Запустить агента</h3>
                  <p>Контекст задачи #{selectedIssue.id} будет добавлен в prompt автоматически.</p>
                </div>
                <button
                  type="button"
                  className="my-task-detail-close-button"
                  aria-label="Закрыть запуск агента"
                  disabled={agentLauncher.running}
                  onClick={() => setAgentLauncher(null)}
                >
                  ×
                </button>
              </div>
              <GitLabProjectSearchField
                value={agentLauncher.gitlabProjectId}
                projects={gitlabSourceProjects}
                disabled={agentLauncher.running || gitlabSourceProjects.length === 0}
                onChange={(projectId) => {
                  setAgentLauncher((current) => {
                    if (!current) {
                      return current;
                    }
                    return {
                      ...current,
                      gitlabProjectId: projectId,
                      workingDirectory: projectId ? '' : current.workingDirectory,
                      error: '',
                      sourceStatus: ''
                    };
                  });
                  if (projectId) {
                    void fillGitLabWorkingDirectory(projectId);
                  }
                }}
              />
              <label>
                <span>Рабочая папка</span>
                <div className="my-task-agent-directory-row">
                  <input
                    value={agentLauncher.workingDirectory}
                    onChange={(event) =>
                      setAgentLauncher((current) => current
                        ? {
                            ...current,
                            gitlabProjectId: '',
                            workingDirectory: event.target.value,
                            error: '',
                            sourceStatus: ''
                          }
                        : current)
                    }
                    disabled={agentLauncher.running || Boolean(agentLauncher.gitlabProjectId)}
                    placeholder="/Users/.../project"
                  />
                  <button
                    type="button"
                    className="secondary-action"
                    disabled={agentLauncher.running}
                    onClick={() => void selectAgentWorkingDirectory()}
                  >
                    Выбрать
                  </button>
                </div>
              </label>
              <label>
                <span>Дополнительный промпт</span>
                <textarea
                  rows={6}
                  value={agentLauncher.prompt}
                  onChange={(event) =>
                    setAgentLauncher((current) => current ? { ...current, prompt: event.target.value } : current)
                  }
                  disabled={agentLauncher.running}
                  placeholder="Что агенту нужно учесть дополнительно"
                />
              </label>
              {agentLauncher.sourceStatus && <p className="inline-hint">{agentLauncher.sourceStatus}</p>}
              {agentLauncher.error && <p className="error-text">{agentLauncher.error}</p>}
              {agentLauncher.resultDirectory && (
                <p className="success-text">Агент поставлен в очередь. Контекст: {agentLauncher.resultDirectory}</p>
              )}
              <div className="my-task-detail-form-actions">
                <button
                  type="button"
                  className="secondary-action"
                  disabled={agentLauncher.running}
                  onClick={() => setAgentLauncher(null)}
                >
                  Закрыть
                </button>
                <button
                  type="button"
                  className="primary-action"
                  disabled={
                    agentLauncher.running ||
                    (!agentLauncher.gitlabProjectId && !agentLauncher.workingDirectory.trim())
                  }
                  onClick={() => void runIssueAgent()}
                >
                  {agentLauncher.running ? 'Запускаем...' : 'Запустить агента'}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="my-task-detail-content">
          <section className="my-task-detail-section">
            <h3>Сводка</h3>
            <dl className="my-task-detail-meta">
              {detailsMeta.map(([label, value]) => {
                if (label === 'Исполнитель') {
                  return (
                    <div key={label} className="my-task-detail-assignee-card">
                      <dt>
                        <span>{label}</span>
                        <button
                          type="button"
                          className="my-task-edit-icon-button"
                          aria-label={`Изменить исполнителя задачи #${selectedIssue.id}`}
                          disabled={savingIssueAssignee}
                          onClick={startEditingIssueAssignee}
                        >
                          <PencilIcon />
                        </button>
                      </dt>
                      <dd>
                        {editingIssueAssignee ? (
                          <form
                            className="my-task-assignee-edit"
                            onSubmit={(event) => {
                              event.preventDefault();
                              void saveIssueAssignee();
                            }}
                          >
                            <SearchableSelectField
                              label="Новый исполнитель"
                              value={editIssueAssigneeId}
                              options={assignableUsers}
                              onChange={setEditIssueAssigneeId}
                              placeholder={
                                assignableUsers.length > 0
                                  ? 'Начните вводить имя'
                                  : 'Нет исполнителей проекта'
                              }
                            />
                            <div className="my-task-detail-form-actions">
                              <button
                                type="button"
                                className="secondary-action"
                                disabled={savingIssueAssignee}
                                onClick={() => {
                                  setEditIssueAssigneeId(currentSelectedIssueAssigneeId());
                                  setEditingIssueAssignee(false);
                                }}
                              >
                                Отмена
                              </button>
                              <button
                                type="submit"
                                className="primary-action"
                                disabled={savingIssueAssignee}
                              >
                                {savingIssueAssignee ? 'Сохраняем...' : 'Сохранить'}
                              </button>
                            </div>
                          </form>
                        ) : (
                          value
                        )}
                      </dd>
                    </div>
                  );
                }
                if (label === 'Спринт') {
                  return (
                    <div key={label} className="my-task-detail-sprint-card">
                      <dt>
                        <span>{label}</span>
                        <button
                          type="button"
                          className="my-task-edit-icon-button"
                          aria-label={`Изменить спринт задачи #${selectedIssue.id}`}
                          disabled={savingIssueSprint}
                          onClick={startEditingIssueSprint}
                        >
                          <PencilIcon />
                        </button>
                      </dt>
                      <dd>
                        {editingIssueSprint ? (
                          <form
                            className="my-task-sprint-edit"
                            onSubmit={(event) => {
                              event.preventDefault();
                              void saveIssueSprint();
                            }}
                          >
                            <SelectField
                              label="Новый спринт"
                              value={editIssueSprintId}
                              options={sprints}
                              onChange={setEditIssueSprintId}
                            />
                            <div className="my-task-detail-form-actions">
                              <button
                                type="button"
                                className="secondary-action"
                                disabled={savingIssueSprint}
                                onClick={() => {
                                  setEditIssueSprintId(currentSelectedIssueSprintId());
                                  setEditingIssueSprint(false);
                                }}
                              >
                                Отмена
                              </button>
                              <button
                                type="submit"
                                className="primary-action"
                                disabled={!editIssueSprintId || savingIssueSprint}
                              >
                                {savingIssueSprint ? 'Сохраняем...' : 'Сохранить'}
                              </button>
                            </div>
                          </form>
                        ) : (
                          value
                        )}
                      </dd>
                    </div>
                  );
                }

                return (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                );
              })}
            </dl>
          </section>

          {generatedDescriptionPath && (
            <section className="my-task-detail-section my-task-generated-description">
              <h3>AI-описание</h3>
              <button
                type="button"
                className="secondary-action"
                onClick={() => void openGeneratedDescription(generatedDescriptionPath, selectedIssue.id)}
              >
                Открыть последнее описание
              </button>
              <span>{generatedDescriptionPath}</span>
            </section>
          )}

          <section className="my-task-detail-section">
            <div className="my-task-detail-section-title">
              <h3>Описание</h3>
              <button
                type="button"
                className="my-task-edit-icon-button"
                aria-label={`Редактировать описание задачи #${selectedIssue.id}`}
                disabled={savingIssueDetails}
                onClick={() => startEditingIssueDetails('description')}
              >
                <PencilIcon />
              </button>
            </div>
            {editingIssueDetails ? (
              <form
                className="my-task-detail-edit"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveIssueDetails();
                }}
              >
                <label>
                  <span>Описание</span>
                  <textarea
                    ref={editIssueDescriptionRef}
                    rows={10}
                    value={editIssueDescription}
                    onChange={(event) => setEditIssueDescription(event.target.value)}
                  />
                </label>
                <div className="my-task-detail-form-actions">
                  <button
                    type="button"
                    className="secondary-action"
                    disabled={savingIssueDetails}
                    onClick={() => setEditingIssueDetails(false)}
                  >
                    Отмена
                  </button>
                  <button
                    type="submit"
                    className="primary-action"
                    disabled={!editIssueSubject.trim() || savingIssueDetails}
                  >
                    {savingIssueDetails ? 'Сохраняем...' : 'Сохранить'}
                  </button>
                </div>
              </form>
            ) : (
              <RichText value={description} emptyText="Описание отсутствует." />
            )}
          </section>

          {customFields.length > 0 && (
            <section className="my-task-detail-section">
              <h3>Поля</h3>
              <dl className="my-task-detail-meta">
                {customFields.map((field) => {
                  const value = Array.isArray(field.value)
                    ? field.value.map(stringValue).filter(Boolean).join(', ')
                    : stringValue(field.value);
                  return (
                    <div key={`${stringValue(field.id)}-${stringValue(field.name)}`}>
                      <dt>{stringValue(field.name)}</dt>
                      <dd>{value}</dd>
                    </div>
                  );
                })}
              </dl>
            </section>
          )}

          <section className="my-task-detail-section">
            <h3>Комментарии</h3>
            {journals.length > 0 ? (
              <div className="my-task-detail-comments">
                {journals.map((journal) => (
                  <article
                    key={stringValue(journal.id) || `${stringValue(journal.created_on)}-${stringValue(journal.notes).slice(0, 12)}`}
                  >
                    <div>
                      <strong>{namedValue(journal.user) || 'Пользователь'}</strong>
                      <span className="my-task-comment-tools">
                        <time>{formatIssueDateTime(journal.created_on)}</time>
                        {stringValue(journal.id) && (
                          <button
                            type="button"
                            className="my-task-edit-icon-button"
                            aria-label={`Редактировать комментарий #${stringValue(journal.id)}`}
                            disabled={Boolean(savingJournalId)}
                            onClick={() => startEditingJournal(journal)}
                          >
                            <PencilIcon />
                          </button>
                        )}
                      </span>
                    </div>
                    {editingJournalId === stringValue(journal.id) ? (
                      <form
                        className="my-task-detail-comment-edit"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void saveIssueJournal(stringValue(journal.id));
                        }}
                      >
                        <label>
                          <span>Комментарий</span>
                          <textarea
                            ref={editJournalNotesRef}
                            rows={5}
                            value={editJournalNotes}
                            onChange={(event) => setEditJournalNotes(event.target.value)}
                          />
                        </label>
                        <div className="my-task-detail-form-actions">
                          <button
                            type="button"
                            className="secondary-action"
                            disabled={savingJournalId === stringValue(journal.id)}
                            onClick={() => {
                              setEditingJournalId('');
                              setEditJournalNotes('');
                            }}
                          >
                            Отмена
                          </button>
                          <button
                            type="submit"
                            className="primary-action"
                            disabled={!editJournalNotes.trim() || savingJournalId === stringValue(journal.id)}
                          >
                            {savingJournalId === stringValue(journal.id) ? 'Сохраняем...' : 'Сохранить'}
                          </button>
                        </div>
                      </form>
                    ) : (
                      <RichText value={stringValue(journal.notes)} emptyText="" />
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <p className="empty-state">Комментариев нет.</p>
            )}
          </section>

          {attachments.length > 0 && (
            <section className="my-task-detail-section">
              <h3>Файлы</h3>
              <div className="my-task-detail-files">
                {attachments.map((attachment) => {
                  const name = redmineAttachmentName(attachment);
                  const previewDataUrl = stringValue(attachment.previewDataUrl);
                  const contentUrl = redmineAttachmentUrl(attachment);
                  const imageAttachment = isRedmineImageAttachment(attachment);
                  return (
                    <figure
                      className={imageAttachment ? 'image' : ''}
                      key={stringValue(attachment.id) || name}
                    >
                      {imageAttachment && previewDataUrl && (
                        <button
                          className="image-preview-button"
                          type="button"
                          aria-label={`Открыть изображение ${name}`}
                          onClick={() => setPreviewImage({ src: previewDataUrl, alt: name })}
                        >
                          <img src={previewDataUrl} alt={name} loading="lazy" />
                        </button>
                      )}
                      <figcaption>
                        {contentUrl ? (
                          <a href={contentUrl} target="_blank" rel="noreferrer">
                            {name}
                          </a>
                        ) : (
                          <span>{name}</span>
                        )}
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
            </section>
          )}

          <form
            className="my-task-detail-comment-form"
            onSubmit={(event) => {
              event.preventDefault();
              void addIssueComment();
            }}
          >
            <label>
              <span>Новый комментарий</span>
              <textarea
                rows={4}
                value={newIssueComment}
                onChange={(event) => setNewIssueComment(event.target.value)}
              />
            </label>
            <div className="my-task-detail-form-actions">
              <button
                type="submit"
                className="primary-action"
                disabled={!newIssueComment.trim() || savingIssueComment}
              >
                {savingIssueComment ? 'Добавляем...' : 'Добавить комментарий'}
              </button>
            </div>
          </form>

          <div className="my-task-detail-actions">
            <button
              type="button"
              className="primary-action"
              disabled={loadingIssueDetails}
              onClick={openAgentLauncher}
            >
              Запустить агента
            </button>
            <button
              type="button"
              className="danger-action"
              disabled={deletingIssue}
              onClick={() => void deleteIssue()}
            >
              {deletingIssue ? 'Удаляем...' : 'Удалить задачу'}
            </button>
            {selectedIssue.url && (
              <button type="button" className="secondary-action" onClick={() => api.openExternal(selectedIssue.url)}>
                Redmine
              </button>
            )}
          </div>
        </div>
      </aside>
    );
  }

  if (!redmineReady) {
    return (
      <section className="my-tasks-view">
        <div className="panel hero-panel">
          <h3>Redmine не подключен</h3>
          <p className="empty-state">
            Подключите Redmine и сохраните API key в настройках, чтобы увидеть задачи текущего пользователя.
          </p>
          <div className="actions">
            <button className="primary-action" onClick={onOpenSettings}>
              Открыть настройки
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={selectedIssue ? 'my-tasks-view detail-open' : 'my-tasks-view'}>
      <div className="my-tasks-toolbar">
        <SelectField
          label="Спринт"
          value={selectedSprintId}
          options={sprints}
          onChange={setSelectedSprintId}
        />
        <button
          type="button"
          aria-label="Синхронизировать спринты"
          title="Синхронизировать спринты"
          className="secondary-action my-tasks-sprint-sync"
          disabled={refreshingSprints || !projectId}
          onClick={refreshSprints}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M20 12a8 8 0 1 1-2.34-5.66" />
            <path d="M20 4v6h-6" />
          </svg>
        </button>
        <div className="my-tasks-context">
          <span>Проект</span>
          <strong>{projectName}</strong>
        </div>
        <button
          type="button"
          className="secondary-action my-tasks-sprint-results"
          disabled={generatingSprintResults || loadingIssues || syncingIssues || !projectId || !selectedSprintId || issues.length === 0}
          onClick={() => void generateSprintResults()}
        >
          {generatingSprintResults ? 'AI...' : 'Результаты спринта'}
        </button>
        <div className="my-tasks-sync-state" role="status">
          {syncingIssues ? 'Синхронизация...' : lastSyncedAt ? `Обновлено ${formatSyncDate(lastSyncedAt)}` : ''}
        </div>
        <button
          aria-label="Обновить задачи"
          className="secondary-action my-tasks-refresh"
          disabled={loadingIssues || syncingIssues || !projectId || !selectedSprintId}
          onClick={refreshIssues}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M20 12a8 8 0 1 1-2.34-5.66" />
            <path d="M20 4v6h-6" />
          </svg>
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}
      {aiMessage && (
        <div className="success-text my-tasks-ai-message" role="status">
          <span>{aiMessage}</span>
          {lastAiResult && (
            <button
              type="button"
              className="secondary-action"
              onClick={() => void openGeneratedDescription(lastAiResult.outputFile, lastAiResult.issueId)}
            >
              Открыть описание
            </button>
          )}
        </div>
      )}

      {sprints.length === 0 && (
        <div className="panel hero-panel">
          <h3>Спринты не загружены</h3>
          <p className="empty-state">
            Спринты не загружены. Для Redmine используется список Agile Sprints, Easy Sprints или версий выбранного
            проекта.
          </p>
          <div className="actions">
            <button className="primary-action" disabled={refreshingSprints || !projectId} onClick={refreshSprints}>
              {refreshingSprints ? 'Обновляем...' : 'Обновить'}
            </button>
          </div>
        </div>
      )}

      {sprints.length > 0 && !selectedSprintId && (
        <div className="panel hero-panel">
          <h3>Спринт не выбран</h3>
          <p className="empty-state">Выберите спринт, чтобы загрузить ваши задачи.</p>
        </div>
      )}

      {sprints.length > 0 && selectedSprintId && (
        <div className="my-tasks-panel">
          {loadingIssues && issues.length === 0 && <p className="empty-state">Загрузка задач...</p>}

          {(!loadingIssues || issues.length > 0) && (
            <div className="my-tasks-board" aria-label="Мои задачи Redmine">
              {taskColumns.map((column) => (
                <section
                  className={draggingIssueId ? 'my-tasks-column drop-ready' : 'my-tasks-column'}
                  key={column.id}
                  aria-label={column.title}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                  }}
                  onDrop={(event) => dropIssue(event, column.id)}
                >
                  <div className="my-tasks-column-header">
                    <div className="my-tasks-column-heading">
                      <h3>{column.title}</h3>
                      <span>{issuesByColumn[column.id].length}</span>
                    </div>
                    <button
                      type="button"
                      className="my-tasks-add-button"
                      aria-label={`Добавить задачу в колонку ${column.title}`}
                      disabled={creatingIssueForColumn !== '' || !projectId || !selectedSprintId}
                      onClick={() => openNewIssueForm(column.id)}
                    >
                      +
                    </button>
                  </div>

                  <div
                    className="my-tasks-column-list"
                    onDragEnter={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                    }}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                    }}
                    onDrop={(event) => dropIssue(event, column.id)}
                  >
                    {addingColumnId === column.id && (
                      <form
                        className="my-tasks-quick-add"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void createIssueInColumn(column.id);
                        }}
                      >
                        <input
                          aria-label={`Название задачи для колонки ${column.title}`}
                          autoFocus
                          placeholder="Название задачи"
                          value={newIssueTitle}
                          onChange={(event) => setNewIssueTitle(event.target.value)}
                        />
                        <textarea
                          aria-label={`Описание задачи для колонки ${column.title}`}
                          placeholder="Описание"
                          rows={3}
                          value={newIssueDescription}
                          onChange={(event) => setNewIssueDescription(event.target.value)}
                        />
                        <div className="my-tasks-quick-add-actions">
                          <button
                            type="button"
                            className="secondary-action"
                            disabled={creatingIssueForColumn === column.id}
                            onClick={() => setAddingColumnId('')}
                          >
                            Отмена
                          </button>
                          <button
                            type="submit"
                            className="primary-action"
                            disabled={!newIssueTitle.trim() || creatingIssueForColumn === column.id}
                          >
                            {creatingIssueForColumn === column.id ? 'Создаем...' : 'Добавить'}
                          </button>
                        </div>
                      </form>
                    )}
                    {issuesByColumn[column.id].map((issue) => {
                      const issueDate = formatIssueDate(issue.dueDate || issue.updatedOn);
                      const formattingIssue = Boolean(formattingIssueIds[issue.id]);
                      const generatedDescriptionPath = generatedDescriptions[issue.id];
                      return (
                        <article
                          className={draggingIssueId === issue.id ? 'my-task-card dragging' : 'my-task-card'}
                          draggable
                          key={issue.id}
                          role="button"
                          tabIndex={0}
                          aria-label={`Открыть карточку задачи #${issue.id} в приложении`}
                          onClick={() => void openIssue(issue)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              void openIssue(issue);
                            }
                          }}
                          onDragStart={(event) => {
                            setDraggingIssueId(issue.id);
                            event.dataTransfer.effectAllowed = 'move';
                            event.dataTransfer.setData('text/plain', issue.id);
                          }}
                          onDragEnd={() => setDraggingIssueId('')}
                        >
                          <div className="my-task-card-top">
                            <h4>#{issue.id} - {issue.subject}</h4>
                          </div>
                          <p>{issue.priority || 'Без приоритета'}</p>
                          {generatedDescriptionPath && (
                            <button
                              type="button"
                              className="my-task-generated-link"
                              onClick={(event) => {
                                event.stopPropagation();
                                void openGeneratedDescription(generatedDescriptionPath, issue.id);
                              }}
                            >
                              Последнее AI-описание
                            </button>
                          )}
                          <div className="my-task-card-footer">
                            <time>{issueDate}</time>
                            <div className="my-task-card-actions">
                              <button
                                type="button"
                                className="my-task-ai-button"
                                aria-label={
                                  formattingIssue
                                    ? `AI оформляет задачу #${issue.id}`
                                    : `Оформить задачу #${issue.id} через AI`
                                }
                                title={
                                  formattingIssue
                                    ? 'AI оформляет задачу. Обычно это занимает 1-5 минут.'
                                    : 'Оформить задачу через AI'
                                }
                                disabled={formattingIssue}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void formatIssueWithAi(issue, column.title);
                                }}
                              >
                                {formattingIssue ? 'AI...' : 'AI'}
                              </button>
                              <button
                                type="button"
                                aria-label={`Открыть задачу #${issue.id} в приложении`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void openIssue(issue);
                                }}
                              >
                                <svg aria-hidden="true" viewBox="0 0 24 24">
                                  <path d="M14 5h5v5" />
                                  <path d="M19 5l-9 9" />
                                  <path d="M12 7H6v11h11v-6" />
                                </svg>
                              </button>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                    {issuesByColumn[column.id].length === 0 && addingColumnId !== column.id && (
                      <p className="my-tasks-column-empty">Нет задач</p>
                    )}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      )}

      {renderIssueDetailPanel()}
      {renderSprintResultsViewer()}
      {renderGeneratedDescriptionViewer()}
      {previewImage && (
        <ImageLightbox
          src={previewImage.src}
          alt={previewImage.alt}
          onClose={() => setPreviewImage(null)}
        />
      )}
    </section>
  );
}
