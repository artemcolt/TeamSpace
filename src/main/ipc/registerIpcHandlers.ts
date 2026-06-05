import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  AppState,
  AgentWorkCreateIssuePayload,
  AgentWorkItem,
  AgentWorkScreenshot,
  AiQueueContext,
  AiQueueItem,
  AiQueueStatus,
  AiQueueTarget,
  CreateRedmineIssueFromMessagesPayload,
  CreateRedmineIssuePayload,
  DeleteRedmineIssuePayload,
  GitLabProjectWorkspaceResult,
  KatyaDailyAnalysisAiResult,
  KatyaDailyAnalysisPayload,
  KatyaAccessGroup,
  KatyaMeetingDetail,
  KatyaMeetingListResponse,
  KatyaMeetingSummary,
  RedmineIssueAiPayload,
  RedmineIssueAiResult,
  RedmineIssueAgentRunPayload,
  RedmineIssueAgentRunResult,
  RedmineOption,
  RedmineIssueSummary,
  RedmineSprintResultsAiResult,
  RedmineSprintResultsPayload,
  UpdateRedmineIssueAssigneePayload,
  UpdateRedmineIssueSprintPayload,
  TelegramAttachmentDownloadPayload,
  TelegramChat,
  TelegramMessage,
  TelegramOutgoingFile,
  TelegramThreadKey,
  TelegramThreadRequest,
  TelegramTopic
} from '../domain/types';
import { RedmineService } from '../redmine/redmineService';
import { markdownToRedmineHtml } from '../redmine/redmineMarkup';
import { LocalStore } from '../storage/localStore';
import { TelegramService } from '../telegram/telegramService';
import { GitLabService } from '../gitlab/gitlabService';

const CODEX_PROXY_TIMEOUT_MS = 5 * 60 * 1000;
const CODEX_AGENT_TIMEOUT_MS = 30 * 60 * 1000;
const CODEX_PROXY_MAX_BUFFER = 10 * 1024 * 1024;
const GIT_WORKSPACE_TIMEOUT_MS = 5 * 60 * 1000;
const AI_QUEUE_HISTORY_LIMIT = 100;
const AGENT_WORK_ROOT = path.join(os.homedir(), 'Desktop', 'team-space', 'agent-results');
const AGENT_PROJECTS_ROOT = path.join(os.homedir(), 'Desktop', 'team-space', 'projects');
const AGENT_SCREENSHOT_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;
type CodexRunResult = {
  sessionId: string | null;
};

let aiQueueSequence = 0;
let aiQueueTail: Promise<unknown> = Promise.resolve();
const aiQueueItems: AiQueueItem[] = [];
let aiQueueHistoryLoaded = false;
let aiQueueHistorySaveTail: Promise<unknown> = Promise.resolve();

function aiQueueHistoryFile(): string {
  return path.join(app.getPath('userData'), 'ai-queue-history.json');
}

function cloneAiQueueContext(context: AiQueueContext | undefined): AiQueueContext | undefined {
  return context
    ? { ...context, fields: context.fields.map((field) => ({ ...field })) }
    : undefined;
}

function aiQueueSnapshot(): AiQueueItem[] {
  return aiQueueItems.map((item) => ({
    ...item,
    target: { ...item.target },
    context: cloneAiQueueContext(item.context)
  }));
}

function persistAiQueueHistory(): void {
  const snapshot = aiQueueSnapshot();
  aiQueueHistorySaveTail = aiQueueHistorySaveTail
    .catch(() => undefined)
    .then(async () => {
      await mkdir(path.dirname(aiQueueHistoryFile()), { recursive: true });
      await writeFile(aiQueueHistoryFile(), JSON.stringify({ items: snapshot }, null, 2), 'utf8');
    })
    .catch(() => undefined);
}

function publishAiQueue(): void {
  const snapshot = aiQueueSnapshot();
  persistAiQueueHistory();
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.isDestroyed()) {
      window.webContents.send('ai-queue:changed', snapshot);
    }
  });
}

function trimAiQueueHistory(): void {
  const active = aiQueueItems.filter((item) => item.status === 'queued' || item.status === 'running');
  const finished = aiQueueItems
    .filter((item) => item.status !== 'queued' && item.status !== 'running')
    .slice(-AI_QUEUE_HISTORY_LIMIT);
  aiQueueItems.splice(0, aiQueueItems.length, ...active, ...finished);
}

function validAiQueueStatus(value: unknown): AiQueueStatus {
  return value === 'queued' || value === 'running' || value === 'done' || value === 'error'
    ? value
    : 'error';
}

function aiQueueTargetFromRecord(record: Record<string, unknown>): AiQueueTarget {
  const target = asRecord(record.target);
  const view = target?.view === 'inbox' || target?.view === 'myTasks' || target?.view === 'meetings'
    ? target.view
    : 'myTasks';
  return {
    view,
    label: textValue(target?.label) || 'Workspace',
    issueId: textValue(target?.issueId) || undefined
  };
}

function aiQueueContextFromRecord(record: Record<string, unknown>): AiQueueContext | undefined {
  const context = asRecord(record.context);
  if (!context) {
    return undefined;
  }
  const fields = Array.isArray(context.fields)
    ? context.fields.map((field) => {
      const fieldRecord = asRecord(field);
      return {
        label: textValue(fieldRecord?.label),
        value: textValue(fieldRecord?.value)
      };
    }).filter((field) => field.label && field.value)
    : [];
  return {
    title: textValue(context.title) || undefined,
    description: textValue(context.description) || undefined,
    fields
  };
}

async function loadAiQueueHistory(): Promise<void> {
  if (aiQueueHistoryLoaded) {
    return;
  }
  aiQueueHistoryLoaded = true;
  const parsed = await readJsonFile(aiQueueHistoryFile());
  const items = Array.isArray(parsed?.items) ? parsed.items : Array.isArray(parsed) ? parsed : [];
  const loadedItems = items.map((value): AiQueueItem | null => {
    const record = asRecord(value);
    if (!record) {
      return null;
    }
    const status = validAiQueueStatus(record.status);
    const interrupted = status === 'queued' || status === 'running';
    return {
      id: textValue(record.id) || `ai-restored-${Date.now()}-${++aiQueueSequence}`,
      title: textValue(record.title) || 'AI-задача',
      status: interrupted ? 'error' : status,
      target: aiQueueTargetFromRecord(record),
      context: aiQueueContextFromRecord(record),
      resultFile: textValue(record.resultFile) || null,
      sessionId: textValue(record.sessionId) || null,
      resultPreview: textValue(record.resultPreview) || null,
      reportDirectory: textValue(record.reportDirectory) || null,
      createdAt: textValue(record.createdAt) || new Date().toISOString(),
      startedAt: textValue(record.startedAt) || null,
      finishedAt: textValue(record.finishedAt) || (interrupted ? new Date().toISOString() : null),
      error: interrupted
        ? 'Выполнение было прервано при закрытии приложения.'
        : textValue(record.error) || null
    };
  }).filter((item): item is AiQueueItem => Boolean(item));
  aiQueueItems.splice(0, aiQueueItems.length, ...loadedItems);
  trimAiQueueHistory();
  persistAiQueueHistory();
}

async function readResultPreview(filePath: string): Promise<string | null> {
  if (!filePath) {
    return null;
  }
  const content = await readFile(filePath, 'utf8').catch(() => '');
  const compact = content.trim();
  if (!compact) {
    return null;
  }
  return compact.length > 2000 ? `${compact.slice(0, 1999).trim()}...` : compact;
}

async function applyAiQueueResult(item: AiQueueItem, result: unknown): Promise<void> {
  const record = asRecord(result);
  if (!record) {
    return;
  }
  const resultFile = textValue(record.reportPath) || textValue(record.outputFile);
  const reportDirectory = textValue(record.reportDirectory) || textValue(record.directory);
  const sessionId = textValue(record.sessionId);
  item.resultFile = resultFile || item.resultFile || null;
  item.sessionId = sessionId || item.sessionId || null;
  item.reportDirectory = reportDirectory || item.reportDirectory || null;
  item.resultPreview = await readResultPreview(item.resultFile || '');
}

async function enqueueAiTask<T>(
  title: string,
  target: AiQueueTarget,
  task: () => Promise<T>,
  context?: AiQueueContext
): Promise<T> {
  await loadAiQueueHistory();
  const item: AiQueueItem = {
    id: `ai-${Date.now()}-${++aiQueueSequence}`,
    title,
    status: 'queued',
    target,
    context: cloneAiQueueContext(context),
    resultFile: null,
    sessionId: null,
    resultPreview: null,
    reportDirectory: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    error: null
  };
  aiQueueItems.push(item);
  trimAiQueueHistory();
  publishAiQueue();

  const runTask = async () => {
    item.status = 'running';
    item.startedAt = new Date().toISOString();
    publishAiQueue();
    try {
      const result = await task();
      item.status = 'done';
      item.finishedAt = new Date().toISOString();
      await applyAiQueueResult(item, result);
      publishAiQueue();
      return result;
    } catch (error) {
      item.status = 'error';
      item.finishedAt = new Date().toISOString();
      item.sessionId = textValue((error as { sessionId?: unknown }).sessionId) || item.sessionId || null;
      item.error = error instanceof Error ? error.message : 'AI-задача завершилась с ошибкой.';
      publishAiQueue();
      throw error;
    } finally {
      trimAiQueueHistory();
      publishAiQueue();
    }
  };

  const scheduled = aiQueueTail.then(runTask, runTask);
  aiQueueTail = scheduled.catch(() => undefined);
  return scheduled;
}

function normalizeKatyaCookie(value: string): string {
  const trimmedValue = value.trim();
  return trimmedValue.startsWith('callrec_session=')
    ? trimmedValue
    : `callrec_session=${trimmedValue}`;
}

function normalizeKatyaBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '') || 'http://localhost:8077';
}

function savedKatyaBaseUrl(store: LocalStore): string {
  return normalizeKatyaBaseUrl(store.getSecret('katyaBaseUrl') ?? process.env.KATYA_BASE_URL ?? '');
}

function normalizeKatyaGroups(payload: unknown): KatyaAccessGroup[] {
  const rawGroups = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : [];

  return rawGroups
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const record = item as Record<string, unknown>;
      const rawId = record.id ?? record.group_id ?? record.uuid;
      const rawName = record.name ?? record.title ?? record.display_name ?? record.group_name;
      const id = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : '';
      const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : id;
      return id ? { id, name } : null;
    })
    .filter((item): item is KatyaAccessGroup => Boolean(item));
}

async function requestKatyaJson<T>(
  baseUrl: string,
  sessionCookie: string,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${normalizeKatyaBaseUrl(baseUrl)}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Cookie: normalizeKatyaCookie(sessionCookie),
      ...init.headers
    }
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    const message = typeof payload === 'object' && payload && 'error' in payload
      ? String(payload.error)
      : response.statusText;
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}

function safePathSegment(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80) || 'task';
}

function gitLabProjectDirectory(pathWithNamespace: string): string {
  const segments = pathWithNamespace
    .split('/')
    .map((segment) => safePathSegment(segment))
    .filter(Boolean);
  return path.join(AGENT_PROJECTS_ROOT, ...(segments.length > 0 ? segments : ['project']));
}

async function prepareGitLabProjectWorkspace(
  store: LocalStore,
  payload: { projectId: string }
): Promise<GitLabProjectWorkspaceResult> {
  const state = store.getState();
  const project = state.gitlab.projects.find((item) => item.id === payload.projectId);
  if (!project) {
    throw new Error('Выберите GitLab-проект из списка доступных репозиториев.');
  }

  const workingDirectory = gitLabProjectDirectory(project.pathWithNamespace || project.name || project.id);
  const directoryStat = await stat(workingDirectory).catch(() => null);
  if (directoryStat && !directoryStat.isDirectory()) {
    throw new Error(`Путь проекта уже занят файлом: ${workingDirectory}`);
  }

  if (directoryStat?.isDirectory()) {
    const gitDirectoryStat = await stat(path.join(workingDirectory, '.git')).catch(() => null);
    if (!gitDirectoryStat?.isDirectory()) {
      throw new Error(`Папка проекта уже существует, но это не git-репозиторий: ${workingDirectory}`);
    }
    await runCommandWithInput('git', ['pull', '--ff-only'], workingDirectory, '', GIT_WORKSPACE_TIMEOUT_MS);
    return {
      projectId: project.id,
      projectName: project.pathWithNamespace || project.name,
      workingDirectory,
      action: 'pulled'
    };
  }

  const cloneUrl = project.sshUrlToRepo || project.httpUrlToRepo;
  if (!cloneUrl) {
    throw new Error('У GitLab-проекта нет URL для клонирования.');
  }

  await mkdir(path.dirname(workingDirectory), { recursive: true });
  await runCommandWithInput(
    'git',
    ['clone', '--', cloneUrl, workingDirectory],
    AGENT_PROJECTS_ROOT,
    '',
    GIT_WORKSPACE_TIMEOUT_MS
  );

  return {
    projectId: project.id,
    projectName: project.pathWithNamespace || project.name,
    workingDirectory,
    action: 'cloned'
  };
}

function gitLabProjectWorkspacePath(store: LocalStore, payload: { projectId: string }): string {
  const project = store.getState().gitlab.projects.find((item) => item.id === payload.projectId);
  return project ? gitLabProjectDirectory(project.pathWithNamespace || project.name || project.id) : '';
}

function agentWorkPrompt(): string {
  return [
    'После завершения работы над проектом выгрузи результат в локальную папку для Team Space.',
    '',
    `Корневая папка: ${AGENT_WORK_ROOT}`,
    '',
    'Создай новую подпапку с именем в формате YYYY-MM-DD-HHMM-короткий-slug.',
    'Внутри подпапки обязательно создай:',
    '1. task.json',
    '2. report.md',
    '3. screenshots/ для скриншотов и визуальных доказательств',
    '',
    'Формат task.json:',
    '{',
    '  "title": "Короткое название выполненной работы",',
    '  "summary": "1-3 предложения с итогом",',
    '  "createdAt": "ISO дата",',
    '  "redmine": { "projectId": "", "trackerId": "", "priorityId": "", "assigneeId": "" }',
    '}',
    '',
    'Формат report.md:',
    '# <Название работы>',
    '',
    '## Что было сделано',
    '- ...',
    '',
    'Важно для раздела "Что было сделано": пиши только содержательный результат для постановки задачи в Redmine.',
    'Оформляй изменения пунктами списка: один пункт = одно изменение. Не пиши длинное перечисление через запятые в одном предложении.',
    'Не добавляй служебные/операционные фразы про состояние локальной копии, Windows-копии, чистую установку, выгрузку в папку, путь к источнику отчета, измененные файлы, вложения или скриншоты.',
    'Скриншоты должны лежать только файлами в screenshots/. Не добавляй в report.md раздел "Скриншоты", markdown-картинки, !file.png! или список вложений.',
    '',
    '## Проверка',
    '- Команды, тесты, ручная проверка',
    '',
    '## Риски и заметки',
    '- ...',
    '',
    'Если работа меняет интерфейс, обязательно положи скриншоты в screenshots/. Не помещай секреты, токены, cookies, пароли и персональные данные.',
    '',
    'Перед сохранением report.md перечитай текст как будущую задачу Redmine: убери любые строки, которые не должны видеть тестировщик или исполнитель задачи.'
  ].join('\n');
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

function isImageFile(filePath: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(filePath);
}

function mimeTypeForFileName(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === '.png') {
    return 'image/png';
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    return 'image/jpeg';
  }
  if (extension === '.gif') {
    return 'image/gif';
  }
  if (extension === '.webp') {
    return 'image/webp';
  }
  return 'application/octet-stream';
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    return asRecord(parsed);
  } catch {
    return null;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function firstMarkdownHeading(markdown: string): string {
  return markdown.split(/\r?\n/).find((line) => line.startsWith('# '))?.replace(/^#\s+/, '').trim() ?? '';
}

function firstMarkdownParagraph(markdown: string): string {
  return markdown
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .find((block) => block && !block.startsWith('#'))?.replace(/\s+/g, ' ') ?? '';
}

async function findReportMarkdown(directory: string): Promise<string> {
  const preferred = ['report.md', 'result.md', 'README.md'];
  for (const fileName of preferred) {
    const candidate = path.join(directory, fileName);
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const markdown = entries.find((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'));
  return markdown ? path.join(directory, markdown.name) : '';
}

async function findImageFiles(directory: string, depth = 0): Promise<string[]> {
  if (depth > 3) {
    return [];
  }

  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findImageFiles(filePath, depth + 1));
      continue;
    }
    if (entry.isFile() && isImageFile(entry.name)) {
      files.push(filePath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

async function screenshotPreview(filePath: string): Promise<AgentWorkScreenshot> {
  const stats = await stat(filePath).catch(() => null);
  let dataUrl: string | null = null;
  if (stats && stats.size <= AGENT_SCREENSHOT_PREVIEW_MAX_BYTES) {
    const file = await readFile(filePath).catch(() => null);
    if (file) {
      dataUrl = `data:${mimeTypeForFileName(filePath)};base64,${file.toString('base64')}`;
    }
  }

  return {
    filePath,
    fileName: path.basename(filePath),
    dataUrl
  };
}

async function loadAgentWorkItem(directory: string): Promise<AgentWorkItem | null> {
  const stats = await stat(directory).catch(() => null);
  if (!stats?.isDirectory()) {
    return null;
  }

  const reportPath = await findReportMarkdown(directory);
  if (!reportPath) {
    return null;
  }

  const metadata = await readJsonFile(path.join(directory, 'task.json'));
  const report = await readFile(reportPath, 'utf8').catch(() => '');
  const screenshotPaths = await findImageFiles(directory);
  const screenshots = await Promise.all(screenshotPaths.map(screenshotPreview));
  const redmine = asRecord(metadata?.redmine);

  return {
    id: path.basename(directory),
    title: textValue(metadata?.title) || firstMarkdownHeading(report) || path.basename(directory),
    summary: textValue(metadata?.summary) || firstMarkdownParagraph(report),
    directory,
    reportPath,
    createdAt: textValue(metadata?.createdAt) || stats.birthtime.toISOString(),
    updatedAt: stats.mtime.toISOString(),
    screenshots,
    redmineIssueId: textValue(redmine?.issueId) || undefined,
    redmineUrl: textValue(redmine?.url) || undefined,
    redmineTestingIssueId: textValue(redmine?.testingIssueId) || undefined,
    redmineTestingUrl: textValue(redmine?.testingUrl) || undefined
  };
}

async function listAgentWorkReports(): Promise<AgentWorkItem[]> {
  await mkdir(AGENT_WORK_ROOT, { recursive: true });
  const entries = await readdir(AGENT_WORK_ROOT, { withFileTypes: true }).catch(() => []);
  const items = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => loadAgentWorkItem(path.join(AGENT_WORK_ROOT, entry.name))));
  return items
    .filter((item): item is AgentWorkItem => Boolean(item))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

async function findAgentWorkReport(reportId: string): Promise<AgentWorkItem> {
  const reports = await listAgentWorkReports();
  const report = reports.find((item) => item.id === reportId);
  if (!report) {
    throw new Error('Отчёт агента не найден.');
  }
  return report;
}

async function deleteAgentWorkReport(reportId: string): Promise<void> {
  const report = await findAgentWorkReport(reportId);
  await rm(report.directory, { recursive: true, force: true });
}

async function createRedmineIssueFromAgentWork(
  store: LocalStore,
  redmine: RedmineService,
  payload: AgentWorkCreateIssuePayload
): Promise<RedmineIssueSummary> {
  const report = await findAgentWorkReport(payload.reportId);
  const state = store.getState();
  const metadata = await readJsonFile(path.join(report.directory, 'task.json'));
  const metadataRedmine = asRecord(metadata?.redmine);
  const reportMarkdown = await readFile(report.reportPath, 'utf8');
  const issueKind = payload.issueKind === 'testing' ? 'testing' : 'result';
  const cleanedReportMarkdown = redmineDescriptionFromAgentReport(reportMarkdown);
  const description = [
    ...(issueKind === 'testing' ? [
      '## Задача на тестирование',
      '',
      'Проверить результат работы агента по отчёту ниже. Скриншоты приложены к задаче.',
      ''
    ] : []),
    cleanedReportMarkdown || report.title
  ].join('\n').trim();
  const subject = textValue(payload.subject)
    || (issueKind === 'testing' ? `Тестирование: ${report.title}` : report.title);
  const issueDescription = markdownToRedmineHtml(textValue(payload.description) || description);
  const comment = markdownToRedmineHtml(textValue(payload.comment));

  const issue = await redmine.createIssue({
    projectId: payload.projectId || textValue(metadataRedmine?.projectId) || state.workspace.defaultProjectId,
    sprintId: payload.sprintId || textValue(metadataRedmine?.sprintId) || state.workspace.defaultSprintId,
    trackerId: payload.trackerId || textValue(metadataRedmine?.trackerId) || state.workspace.defaultTrackerId,
    priorityId: payload.priorityId || textValue(metadataRedmine?.priorityId) || state.workspace.defaultPriorityId,
    assigneeId: payload.assigneeId || textValue(metadataRedmine?.assigneeId) || state.workspace.defaultAssigneeId,
    statusId: payload.statusId || textValue(metadataRedmine?.statusId),
    subject,
    description: issueDescription,
    inlineImageAttachments: false,
    attachments: report.screenshots.map((screenshot) => ({
      filePath: screenshot.filePath,
      fileName: screenshot.fileName,
      contentType: mimeTypeForFileName(screenshot.fileName)
    }))
  });

  if (comment) {
    await redmine.addIssueComment({ issueId: issue.id, notes: comment });
  }

  const nextMetadata = {
    ...(metadata ?? {}),
    redmine: {
      ...(metadataRedmine ?? {}),
      ...(issueKind === 'testing' ? {
        testingIssueId: issue.id,
        testingUrl: issue.url,
        testingCreatedAt: new Date().toISOString()
      } : {
        issueId: issue.id,
        url: issue.url,
        createdAt: new Date().toISOString()
      })
    }
  };
  await writeFile(path.join(report.directory, 'task.json'), JSON.stringify(nextMetadata, null, 2));
  return issue;
}

function issueDetailRecord(details: Record<string, unknown> | null): Record<string, unknown> | null {
  return asRecord(details?.issue);
}

function namedText(value: unknown): string {
  return textValue(asRecord(value)?.name);
}

function compactContextText(value: unknown, maxLength = 900): string {
  const text = textValue(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1).trim()}...`;
}

function contextFields(fields: Array<[string, string | undefined | null]>): AiQueueContext['fields'] {
  return fields
    .map(([label, value]) => ({ label, value: textValue(value) }))
    .filter((field) => field.value);
}

function redmineIssueQueueContext(
  payload: RedmineIssueAiPayload,
  details: Record<string, unknown> | null,
  extraFields: Array<[string, string | undefined | null]> = []
): AiQueueContext {
  const detailIssue = issueDetailRecord(details);
  const actualStatus = namedText(detailIssue?.status) || payload.issue.status;
  const actualAssignee = namedText(detailIssue?.assigned_to) || payload.issue.assignee;
  const description = compactContextText(detailIssue?.description);
  return {
    title: `#${payload.issue.id} - ${payload.issue.subject}`,
    description: description || 'Описание задачи не загружено или отсутствует.',
    fields: contextFields([
      ['Тип', 'Задача Redmine'],
      ['Проект', payload.projectName || payload.projectId],
      ['Спринт', payload.sprintName || payload.sprintId],
      ['Колонка', payload.columnName],
      ['Трекер', payload.issue.tracker],
      ['Статус', actualStatus],
      ['Приоритет', payload.issue.priority],
      ['Исполнитель', actualAssignee],
      ['Срок', payload.issue.dueDate],
      ['Обновлено', payload.issue.updatedOn],
      ['URL', payload.issue.url],
      ...extraFields
    ])
  };
}

function buildIssueMarkdown(payload: RedmineIssueAiPayload, details: Record<string, unknown> | null): string {
  const detailIssue = issueDetailRecord(details);
  const description = textValue(detailIssue?.description);
  const journals = Array.isArray(detailIssue?.journals) ? detailIssue.journals : [];
  const notes = journals
    .map((journal) => {
      const record = asRecord(journal);
      if (!record) {
        return '';
      }
      const user = textValue(asRecord(record.user)?.name);
      const createdOn = textValue(record.created_on);
      const note = textValue(record.notes);
      if (!note) {
        return '';
      }
      return `- ${createdOn}${user ? `, ${user}` : ''}: ${note}`;
    })
    .filter(Boolean)
    .slice(-10);

  return [
    `# #${payload.issue.id} - ${payload.issue.subject}`,
    '',
    `- Проект: ${payload.projectName || payload.projectId || 'Не указан'}`,
    `- Спринт: ${payload.sprintName || payload.sprintId || 'Не указан'}`,
    `- Колонка: ${payload.columnName || 'Не указана'}`,
    `- Трекер: ${payload.issue.tracker || 'Не указан'}`,
    `- Статус: ${payload.issue.status || 'Не указан'}`,
    `- Приоритет: ${payload.issue.priority || 'Не указан'}`,
    `- Исполнитель: ${payload.issue.assignee || 'Не указан'}`,
    `- Срок: ${payload.issue.dueDate || 'Не указан'}`,
    `- Обновлено: ${payload.issue.updatedOn || 'Не указано'}`,
    `- URL: ${payload.issue.url || 'Не указан'}`,
    '',
    '## Описание из Redmine',
    description || 'Описание не загружено или отсутствует.',
    '',
    '## Последние комментарии',
    notes.length > 0 ? notes.join('\n') : 'Комментарии не загружены или отсутствуют.'
  ].join('\n');
}

function buildIssuePrompt(issueMarkdown: string): string {
  return [
    'Ты готовишь редактируемый документ для обновления задачи Redmine.',
    'На входе ниже сырые данные задачи. Сформируй на русском аккуратную заготовку в Markdown.',
    'Сгенерируй три отдельные редактируемые части: заголовок, описание и результат работ/комментарий. Не смешивай их.',
    'Документ затем будет применен к Redmine: заголовок попадет в subject, описание — в description, результат работ — в комментарий.',
    'Верни только готовый Markdown без служебных пояснений.',
    '',
    'Структура результата строго такая:',
    '# Redmine #<номер задачи>',
    '## Заголовок',
    '<короткий точный заголовок задачи без номера>',
    '',
    '## Описание',
    '<постановка задачи для Redmine: контекст, что нужно сделать, критерии приемки, вопросы/риски и технические заметки>',
    '',
    '## Результат работ',
    '<что написать в результате работ/комментарии после выполнения или проверки>',
    '',
    'Если в исходных данных чего-то нет, явно отметь это в релевантном разделе.',
    '',
    '<task>',
    issueMarkdown,
    '</task>'
  ].join('\n');
}

function buildIssueAgentPrompt(issueMarkdown: string, userPrompt: string, workingDirectory: string): string {
  const extraPrompt = userPrompt.trim() || 'Дополнительных указаний нет.';
  return [
    'Ты работаешь как coding agent в локальной рабочей папке проекта.',
    `Рабочая папка: ${workingDirectory}`,
    '',
    'Нужно выполнить задачу Redmine ниже. Используй все сведения из задачи: заголовок, метаданные, описание и последние комментарии.',
    'Перед изменениями изучи проект в рабочей папке, придерживайся существующих паттернов и после работы проверь изменения доступными тестами или сборкой.',
    'Если задача не требует правок в коде, явно зафиксируй это в результате и объясни, какая проверка выполнена.',
    '',
    'Дополнительный промпт пользователя:',
    extraPrompt,
    '',
    '<redmine_task>',
    issueMarkdown,
    '</redmine_task>'
  ].join('\n');
}

function buildSprintResultsMarkdown(payload: RedmineSprintResultsPayload): string {
  const issues = [...payload.issues].sort((a, b) => Number(a.id) - Number(b.id));
  return [
    `# Спринт: ${payload.sprintName || payload.sprintId || 'Не указан'}`,
    '',
    `- Проект: ${payload.projectName || payload.projectId || 'Не указан'}`,
    `- Всего задач: ${issues.length}`,
    '',
    '## Задачи',
    issues.length > 0
      ? issues.map((issue) => [
          `- #${issue.id} ${issue.subject}`,
          `  - Статус: ${issue.status || 'Не указан'}`,
          `  - Приоритет: ${issue.priority || 'Не указан'}`,
          `  - Исполнитель: ${issue.assignee || 'Не назначен'}`,
          issue.dueDate ? `  - Срок: ${issue.dueDate}` : null,
          issue.updatedOn ? `  - Обновлена: ${issue.updatedOn}` : null,
          issue.url ? `  - URL: ${issue.url}` : null
        ].filter((line): line is string => line !== null).join('\n')).join('\n')
      : 'Задач нет.'
  ].join('\n');
}

function buildSprintResultsPrompt(sprintMarkdown: string): string {
  return [
    'Ты готовишь краткие итоги Redmine-спринта на русском языке.',
    'На входе список задач спринта со статусами. Для каждой задачи напиши короткий результат одной строкой.',
    'К "Получилось" относи задачи, которые выглядят завершенными, проверенными или готовыми к сдаче.',
    'К "Не получилось" относи новые, незавершенные, зависшие, рисковые или требующие работы задачи.',
    'Если по статусу нельзя уверенно понять результат, помести задачу в "Не получилось" и кратко напиши причину.',
    'Верни только простой текст без Markdown, заголовков, списков, номеров строк и служебных пояснений.',
    '',
    'Структура результата строго такая:',
    'Получилось <что именно удалось сделать по задаче>',
    'Получилось <что именно удалось сделать по задаче>',
    'Не получилось <что осталось неготовым или почему задача не закрыта>',
    '',
    'Требования к формулировкам:',
    '- Одна задача = одна строка.',
    '- Каждая строка обязательно начинается ровно с "Получилось" или "Не получилось".',
    '- Не добавляй точку в конец строки автоматически.',
    '- Не добавляй номера Redmine в текст, если без них смысл понятен.',
    '- Пиши как результат работы, например: "Получилось реализовать backend для публичной страницы расписания заявок с модулем eam-calendar"',
    '',
    '<sprint>',
    sprintMarkdown,
    '</sprint>'
  ].join('\n');
}

function katyaSpeakerLabel(meeting: KatyaMeetingDetail, speaker: string): string {
  const name = meeting.speaker_names?.[speaker]?.trim();
  if (name) {
    return name;
  }
  const match = speaker.match(/(\d+)$/);
  return match ? `Спикер ${Number(match[1]) + 1}` : speaker || 'Спикер';
}

function formatKatyaDate(value?: string): string {
  if (!value) {
    return 'Дата не указана';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString('ru-RU');
}

function formatKatyaDuration(seconds?: number): string {
  if (!Number.isFinite(seconds) || !seconds) {
    return '00:00';
  }
  const roundedSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(roundedSeconds / 3600);
  const minutes = Math.floor((roundedSeconds % 3600) / 60);
  const restSeconds = roundedSeconds % 60;
  return (hours > 0 ? [hours, minutes, restSeconds] : [minutes, restSeconds])
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

function buildKatyaMeetingMarkdown(meeting: KatyaMeetingDetail & { detail_error?: string }): string {
  const transcriptFromSegments = meeting.segments?.length
    ? meeting.segments.map((segment) => [
        `[${formatKatyaDuration(segment.start)}]`,
        katyaSpeakerLabel(meeting, segment.speaker),
        segment.text
      ].join(' ')).join('\n')
    : '';
  const transcript = meeting.transcript?.trim() || transcriptFromSegments;

  return [
    `# ${meeting.title || 'Без названия'}`,
    '',
    `- ID: ${meeting.id}`,
    `- Статус: ${meeting.status || 'Не указан'}`,
    `- Группа: ${meeting.group_name || meeting.group_id || 'Не указана'}`,
    `- Автор: ${meeting.owner_display_name || meeting.owner_username || 'Не указан'}`,
    `- Дата: ${formatKatyaDate(meeting.started_at ?? meeting.created_at)}`,
    `- Длительность: ${formatKatyaDuration(meeting.duration_sec)}`,
    meeting.detail_error ? `- Ошибка загрузки деталей: ${meeting.detail_error}` : null,
    '',
    '## Протокол',
    meeting.summary?.trim() || 'Протокол отсутствует.',
    '',
    '## Транскрипция',
    transcript || 'Транскрипция отсутствует.'
  ].filter((line): line is string => line !== null).join('\n');
}

function buildKatyaMeetingsMarkdown(meetings: Array<KatyaMeetingDetail & { detail_error?: string }>): string {
  return meetings
    .sort((first, second) =>
      new Date(first.started_at ?? first.created_at ?? 0).getTime() -
      new Date(second.started_at ?? second.created_at ?? 0).getTime()
    )
    .map(buildKatyaMeetingMarkdown)
    .join('\n\n---\n\n');
}

function buildKatyaDailyAnalysisPrompt(meetingsMarkdown: string, analysisPrompt?: string): string {
  const userAnalysisPrompt = analysisPrompt?.trim() || [
    'Сделай вывод именно о проведенных дэйликах: что обсуждали, что уже сделали, что делают дальше, какие результаты и решения появились.',
    'Структура результата:',
    '# Анализ дэйликов',
    '',
    '## Общий вывод',
    '- <краткий вывод по дэйликам>',
    '',
    '## Проведенные дэйлики',
    '- <дата и название встречи>: <главная тема и результат>',
    '',
    '## Что было сделано',
    '- <человек или спикер>: <сделанное>',
    '',
    '## Что делаем дальше',
    '- <человек или спикер>: <следующее действие>',
    '',
    '## Результаты и решения',
    '- <решение или результат>',
    '',
    '## Обязательства по сотрудникам',
    '### <Имя сотрудника или спикер>',
    '- <обязательство или поручение, с контекстом и сроком если он есть>',
    '',
    '## Риски и блокеры',
    '- <риск, блокер или неясность>',
    '',
    '## Пояснения терминов',
    '- <термин>: <простое объяснение, если в анализе использованы сокращения или жаргон>',
    '',
    '## Источники',
    '- <название встречи и дата, на которые опирался анализ>'
  ].join('\n');

  return [
    'Ты анализируешь записи рабочих встреч на русском языке.',
    'На входе все доступные транскрипции и протоколы из сервиса записи. Среди них могут быть дэйлики и другие встречи.',
    'Выделяй людей. Если в источниках есть имя, фамилия или устойчивый спикер, указывай его. Если имя не раскрыто, используй обозначение спикера и явно помечай неопределенность.',
    'Расшифровывай жаргон, англицизмы и рабочие сокращения при первом упоминании. Например: "синк" пиши как "синхронизация/короткая сверка статусов"; "прогнать" — "проверить или протестировать"; "бек" — "backend".',
    'Если термин нельзя уверенно расшифровать по контексту, оставь исходное слово и добавь пояснение в скобках: "(значение из контекста неясно)".',
    'Не придумывай факты. Если поручение, владелец или срок неясны, так и напиши.',
    'Верни только Markdown без служебных пояснений.',
    '',
    'Пользовательская инструкция анализа:',
    userAnalysisPrompt,
    '',
    '<meetings>',
    meetingsMarkdown,
    '</meetings>'
  ].join('\n');
}

function dailyAnalysisTasksDirectory(): string {
  return path.join(app.getPath('documents'), 'Team Space AI Tasks');
}

async function loadKatyaMeetingSummaries(payload: KatyaDailyAnalysisPayload): Promise<KatyaMeetingSummary[]> {
  const pageSize = 100;
  const meetings: KatyaMeetingSummary[] = [];
  let page = 1;
  let total = 0;

  do {
    const response = await requestKatyaJson<KatyaMeetingListResponse>(
      payload.baseUrl,
      payload.sessionCookie,
      `/api/v1/meetings?page=${page}&page_size=${pageSize}`
    );
    meetings.push(...response.data);
    total = response.total;
    page += 1;
    if (response.data.length === 0) {
      break;
    }
  } while (meetings.length < total);

  return meetings;
}

async function loadKatyaMeetingDetails(
  payload: KatyaDailyAnalysisPayload,
  summaries: KatyaMeetingSummary[]
): Promise<Array<KatyaMeetingDetail & { detail_error?: string }>> {
  const details: Array<KatyaMeetingDetail & { detail_error?: string }> = [];
  const chunkSize = 4;

  for (let index = 0; index < summaries.length; index += chunkSize) {
    const chunk = summaries.slice(index, index + chunkSize);
    const chunkDetails = await Promise.all(chunk.map(async (meeting) => {
      try {
        return await requestKatyaJson<KatyaMeetingDetail>(
          payload.baseUrl,
          payload.sessionCookie,
          `/api/v1/meetings/${encodeURIComponent(meeting.id)}`
        );
      } catch (error) {
        return {
          ...meeting,
          detail_error: error instanceof Error ? error.message : 'Не удалось загрузить детали встречи.'
        };
      }
    }));
    details.push(...chunkDetails);
  }

  return details;
}

async function generateKatyaDailyAnalysis(
  payload: KatyaDailyAnalysisPayload
): Promise<KatyaDailyAnalysisAiResult> {
  const capturedAt = new Date().toISOString();
  const selectedMeetingIds = Array.from(new Set((payload.meetingIds ?? []).map((id) => id.trim()).filter(Boolean)));
  const summaries = selectedMeetingIds.length > 0
    ? selectedMeetingIds.map((id) => ({
        id,
        url: '',
        title: id,
        status: ''
      }))
    : await loadKatyaMeetingSummaries(payload);
  if (summaries.length === 0) {
    throw new Error('Нет записей встреч для анализа.');
  }

  const meetings = await loadKatyaMeetingDetails(payload, summaries);
  const meetingsMarkdown = buildKatyaMeetingsMarkdown(meetings);
  if (!meetingsMarkdown.trim()) {
    throw new Error('Не удалось собрать материалы встреч для анализа.');
  }

  const timestamp = capturedAt.replace(/[:.]/g, '-');
  const tasksDirectory = dailyAnalysisTasksDirectory();
  const taskDirectory = path.join(tasksDirectory, `daily-analysis-${timestamp}`);
  const inputFile = path.join(taskDirectory, 'meetings.json');
  const taskMarkdownFile = path.join(taskDirectory, 'meetings.md');
  const promptFile = path.join(taskDirectory, 'prompt.md');
  const outputFile = path.join(taskDirectory, 'processed.md');
  const rawOutputFile = path.join(taskDirectory, 'codex-proxy.log');

  await mkdir(taskDirectory, { recursive: true });

  const prompt = buildKatyaDailyAnalysisPrompt(meetingsMarkdown, payload.analysisPrompt);
  await writeFile(inputFile, JSON.stringify({ capturedAt, meetings, analysisPrompt: payload.analysisPrompt ?? '' }, null, 2), 'utf8');
  await writeFile(taskMarkdownFile, meetingsMarkdown, 'utf8');
  await writeFile(promptFile, prompt, 'utf8');

  await enqueueAiTask(
    'AI-анализ дэйликов',
    { view: 'meetings', label: 'Встречи' },
    async () => {
      const run = await runCodexProxy(taskDirectory, prompt, outputFile, rawOutputFile);
      return { directory: taskDirectory, outputFile, rawOutputFile, sessionId: run.sessionId };
    },
    {
      title: 'AI-анализ встреч',
      description: compactContextText(payload.analysisPrompt) || 'Анализ выбранных записей встреч по стандартному шаблону.',
      fields: contextFields([
        ['Тип', 'Анализ встреч'],
        ['Записей', String(meetings.length)],
        ['Папка результата', taskDirectory]
      ])
    }
  );

  const content = await readFile(outputFile, 'utf8').catch(() => '');
  if (!content.trim()) {
    throw new Error('codex-proxy не вернул анализ дэйликов.');
  }

  return {
    directory: taskDirectory,
    inputFile,
    promptFile,
    outputFile,
    rawOutputFile,
    content,
    meetingsCount: meetings.length,
    createdAt: capturedAt
  };
}

async function listKatyaDailyAnalyses(): Promise<KatyaDailyAnalysisAiResult[]> {
  const tasksDirectory = dailyAnalysisTasksDirectory();
  const entries = await readdir(tasksDirectory, { withFileTypes: true }).catch(() => []);
  const analyses = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('daily-analysis-'))
    .map(async (entry) => {
      const taskDirectory = path.join(tasksDirectory, entry.name);
      const inputFile = path.join(taskDirectory, 'meetings.json');
      const promptFile = path.join(taskDirectory, 'prompt.md');
      const outputFile = path.join(taskDirectory, 'processed.md');
      const rawOutputFile = path.join(taskDirectory, 'codex-proxy.log');
      const outputStat = await stat(outputFile).catch(() => null);
      if (!outputStat?.isFile()) {
        return null;
      }

      const content = await readFile(outputFile, 'utf8').catch(() => '');
      if (!content.trim()) {
        return null;
      }

      const input = await readFile(inputFile, 'utf8')
        .then((value) => JSON.parse(value) as { capturedAt?: string; meetings?: unknown[] })
        .catch(() => null);

      return {
        directory: taskDirectory,
        inputFile,
        promptFile,
        outputFile,
        rawOutputFile,
        content,
        meetingsCount: Array.isArray(input?.meetings) ? input.meetings.length : 0,
        createdAt: input?.capturedAt || outputStat.mtime.toISOString()
      };
    }));

  return analyses
    .filter((analysis): analysis is KatyaDailyAnalysisAiResult => analysis !== null)
    .sort((first, second) => new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime());
}

function optionName(options: RedmineOption[], id: string): string {
  return options.find((option) => option.id === id)?.name ?? '';
}

function telegramIssueFallbackTitle(messages: TelegramMessage[]): string {
  const firstText = [...messages]
    .sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime())[0]?.text.trim() ?? '';
  if (!firstText) {
    return 'Новая задача из Telegram';
  }
  return firstText.length > 80 ? `${firstText.slice(0, 77)}...` : firstText;
}

function buildTelegramMessagesMarkdown(
  messages: TelegramMessage[],
  chats: TelegramChat[],
  topics: TelegramTopic[]
): string {
  return [...messages]
    .sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime())
    .map((message) => {
      const chatTitle = chats.find((chat) => chat.id === message.chatId)?.title ?? message.chatId;
      const topicTitle = topics.find((topic) => topic.id === message.topicId)?.title;
      return [
        'Источник: Telegram',
        `Чат: ${chatTitle}`,
        topicTitle ? `Топик: ${topicTitle}` : null,
        `Автор: ${message.senderName}`,
        `Дата: ${new Date(message.sentAt).toLocaleString('ru-RU')}`,
        (message.attachments?.length ?? 0) > 0
          ? `Вложения: ${message.attachments?.map((attachment) => attachment.fileName || attachment.type).join(', ')}`
          : null,
        '',
        message.text
      ].filter((line): line is string => line !== null).join('\n');
    })
    .join('\n\n---\n\n');
}

function buildNewIssuePrompt(sourceMarkdown: string, state: AppState): string {
  return [
    'Ты создаешь новую задачу Redmine по выбранным сообщениям Telegram.',
    'На входе ниже сырая переписка и настройки Redmine. Сформируй на русском короткий заголовок и полноценную постановку задачи.',
    'Не добавляй служебные пояснения и не выдумывай факты, которых нет в переписке. Если данных не хватает, добавь вопросы/риски в описание.',
    'Если внутри Telegram-сообщения есть переносы строк, считай каждую строку отдельным смысловым пунктом и сохрани эту структуру в описании.',
    'Описание должно быть структурированным: каждый смысловой блок начинается с новой строки, между блоками пустая строка, каждый пункт списка с новой строки.',
    'Не возвращай описание одним абзацем. Не используй HTML.',
    'Верни только готовый Markdown строго такой структуры:',
    '# Redmine task',
    '## Заголовок',
    '<короткий точный заголовок без номера задачи>',
    '',
    '## Описание',
    'Контекст:',
    '- <факт 1: что произошло>',
    '- <факт 2: почему нужна задача>',
    '- <факт 3: важный контекст из переписки, если есть>',
    '',
    'Что нужно сделать:',
    '- <действие 1>',
    '- <действие 2>',
    '',
    'Критерии приемки:',
    '- <проверяемый результат 1>',
    '- <проверяемый результат 2>',
    '',
    'Вопросы/риски:',
    '- <вопрос или риск, если есть>',
    '',
    'Исходные сообщения:',
    '- <дата, автор: цитата или краткое содержание>',
    '',
    '<redmine>',
    `Проект: ${optionName(state.redmine.projects, state.workspace.defaultProjectId) || state.workspace.defaultProjectId || 'Не указан'}`,
    `Трекер: ${optionName(state.redmine.trackers, state.workspace.defaultTrackerId) || state.workspace.defaultTrackerId || 'Не указан'}`,
    `Приоритет: ${optionName(state.redmine.priorities, state.workspace.defaultPriorityId) || state.workspace.defaultPriorityId || 'Не указан'}`,
    `Спринт: ${optionName(state.redmine.sprints, state.workspace.defaultSprintId) || state.workspace.defaultSprintId || 'Не указан'}`,
    `Исполнитель: ${optionName(state.redmine.users, state.workspace.defaultAssigneeId) || state.workspace.defaultAssigneeId || 'Не указан'}`,
    '</redmine>',
    '',
    '<telegram>',
    sourceMarkdown,
    '</telegram>'
  ].join('\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitContextFacts(value: string): string[] {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?…])\s+(?=[А-ЯЁA-Z])/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatContextSection(value: string): string {
  return value.replace(
    /(^|\n\n)Контекст:\n([\s\S]*?)(?=\n\n(?:Что нужно сделать|Критерии приемки|Вопросы\/риски|Исходные сообщения):|$)/,
    (_match, prefix: string, body: string) => {
      const lines = body
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      if (lines.length === 0) {
        return `${prefix}Контекст:\n- Не указан.`;
      }
      if (lines.some((line) => /^[-*]\s+/.test(line))) {
        return `${prefix}Контекст:\n${lines.join('\n')}`;
      }

      const facts = splitContextFacts(lines.join(' '));
      return `${prefix}Контекст:\n${facts.map((fact) => `- ${fact}`).join('\n')}`;
    }
  );
}

function normalizeGeneratedNewIssueDescription(value: string): string {
  const sectionLabels = [
    'Контекст',
    'Что нужно сделать',
    'Критерии приемки',
    'Вопросы/риски',
    'Исходные сообщения'
  ];

  let normalized = value
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  for (const label of sectionLabels) {
    normalized = normalized.replace(
      new RegExp(`\\s*${escapeRegExp(label)}:\\s*`, 'g'),
      (_match, offset: number) => `${offset === 0 ? '' : '\n\n'}${label}:\n`
    );
  }

  normalized = normalized
    .replace(/[ \t]+-[ \t]+/g, '\n- ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();

  return formatContextSection(normalized);
}

function plainTextFromMarkdown(value: string): string {
  return value
    .replace(/^#+\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .trim();
}

function generatedNewIssueSectionKey(value: string): 'title' | 'description' | null {
  const normalized = value.toLocaleLowerCase('ru-RU');
  if (normalized.includes('заголов')) {
    return 'title';
  }
  if (normalized.includes('описан') || normalized.includes('постанов')) {
    return 'description';
  }
  return null;
}

function parseGeneratedNewIssueDocument(
  value: string,
  fallbackSubject: string
): { subject: string; description: string } {
  const sections: Record<'title' | 'description', string[]> = {
    title: [],
    description: []
  };
  let currentSection: keyof typeof sections | null = null;
  let hasKnownSection = false;

  for (const line of value.replace(/\r\n/g, '\n').split('\n')) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const sectionKey = generatedNewIssueSectionKey(heading[2]);
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

  const subject = plainTextFromMarkdown(sections.title.join('\n').replace(/^\n+|\n+$/g, ''))
    .split('\n')[0]
    || fallbackSubject;
  const description = hasKnownSection
    ? sections.description.join('\n').replace(/^\n+|\n+$/g, '')
    : value.trim();

  return {
    subject,
    description: normalizeGeneratedNewIssueDescription(description || subject)
  };
}

function commandOutput(value: unknown): string {
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }
  return typeof value === 'string' ? value : '';
}

function extractCodexSessionId(output: string): string | null {
  const match = output.match(/\bsession id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
  return match?.[1] ?? null;
}

function codexRunResult(stdout: string, stderr: string): CodexRunResult {
  return {
    sessionId: extractCodexSessionId(`${stdout}\n${stderr}`)
  };
}

function isMissingCommandError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT'
  );
}

function runCommandWithInput(
  command: string,
  args: string[],
  cwd: string,
  input: string,
  timeoutMs = CODEX_PROXY_TIMEOUT_MS
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let bufferExceeded = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    function appendOutput(target: 'stdout' | 'stderr', chunk: Buffer) {
      if (bufferExceeded) {
        return;
      }
      if (target === 'stdout') {
        stdout += chunk.toString('utf8');
      } else {
        stderr += chunk.toString('utf8');
      }
      if (stdout.length + stderr.length > CODEX_PROXY_MAX_BUFFER) {
        bufferExceeded = true;
        child.kill('SIGTERM');
      }
    }

    child.stdout.on('data', (chunk: Buffer) => appendOutput('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => appendOutput('stderr', chunk));
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 && !timedOut && !bufferExceeded) {
        resolve({ stdout, stderr });
        return;
      }

      const reason = timedOut
        ? `Command timed out after ${timeoutMs / 1000} seconds.`
        : bufferExceeded
          ? `Command output exceeded ${CODEX_PROXY_MAX_BUFFER} bytes.`
          : `Command failed with exit code ${code ?? 'unknown'}${signal ? ` and signal ${signal}` : ''}.`;
      const error = new Error(reason) as Error & {
        code?: string | number | null;
        signal?: NodeJS.Signals | null;
        stdout?: string;
        stderr?: string;
      };
      error.code = timedOut ? 'ETIMEDOUT' : code;
      error.signal = signal;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });

    child.stdin.end(input);
  });
}

async function runCodexProxy(
  taskDirectory: string,
  prompt: string,
  outputFile: string,
  rawOutputFile: string,
  options: { cwd?: string; sandbox?: 'read-only' | 'workspace-write'; timeoutMs?: number } = {}
): Promise<CodexRunResult> {
  const commands = [
    process.env.CODEX_PROXY_PATH,
    'codex-proxy',
    path.join(os.homedir(), '.local/bin/codex-proxy'),
    '/opt/homebrew/bin/codex-proxy',
    '/usr/local/bin/codex-proxy'
  ].filter((command): command is string => Boolean(command));
  let lastError: unknown = null;

  for (const command of commands) {
    try {
      const result = await runCommandWithInput(
        command,
        [
          'exec',
          '--skip-git-repo-check',
          '--sandbox',
          options.sandbox ?? 'read-only',
          '--color',
          'never',
          '--output-last-message',
          outputFile,
          '-'
        ],
        options.cwd ?? taskDirectory,
        prompt,
        options.timeoutMs
      );
      return codexRunResult(result.stdout, result.stderr);
    } catch (error) {
      lastError = error;
      const stdout = commandOutput((error as { stdout?: unknown }).stdout);
      const stderr = commandOutput((error as { stderr?: unknown }).stderr);
      const sessionId = codexRunResult(stdout, stderr).sessionId;
      if (isMissingCommandError(error)) {
        continue;
      }
      if (sessionId && error instanceof Error) {
        (error as Error & { sessionId?: string }).sessionId = sessionId;
      }
      throw error;
    }
  }

  throw new Error(
    lastError instanceof Error
      ? `codex-proxy не найден или не запустился: ${lastError.message}`
      : 'codex-proxy не найден.'
  );
}

async function formatRedmineIssueWithAi(
  redmine: RedmineService,
  payload: RedmineIssueAiPayload
): Promise<RedmineIssueAiResult> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tasksDirectory = path.join(app.getPath('documents'), 'Team Space AI Tasks');
  const taskDirectory = path.join(
    tasksDirectory,
    `issue-${safePathSegment(payload.issue.id)}-${timestamp}`
  );
  const inputFile = path.join(taskDirectory, 'task.json');
  const taskMarkdownFile = path.join(taskDirectory, 'task.md');
  const promptFile = path.join(taskDirectory, 'prompt.md');
  const outputFile = path.join(taskDirectory, 'processed.md');
  const rawOutputFile = path.join(taskDirectory, 'codex-proxy.log');

  await mkdir(taskDirectory, { recursive: true });

  let details: Record<string, unknown> | null = null;
  let detailsError: string | null = null;
  try {
    details = await redmine.loadIssueDetails(payload.issue.id);
  } catch (error) {
    detailsError = error instanceof Error ? error.message : 'Не удалось загрузить полную задачу Redmine.';
  }

  const issueMarkdown = buildIssueMarkdown(payload, details);
  const prompt = buildIssuePrompt(issueMarkdown);
  await writeFile(
    inputFile,
    JSON.stringify({ capturedAt: new Date().toISOString(), payload, details, detailsError }, null, 2),
    'utf8'
  );
  await writeFile(taskMarkdownFile, issueMarkdown, 'utf8');
  await writeFile(promptFile, prompt, 'utf8');

  await enqueueAiTask(
    `AI-описание задачи #${payload.issue.id}`,
    { view: 'myTasks', label: `Задача #${payload.issue.id}`, issueId: payload.issue.id },
    async () => {
      const run = await runCodexProxy(taskDirectory, prompt, outputFile, rawOutputFile);
      return { directory: taskDirectory, outputFile, rawOutputFile, sessionId: run.sessionId };
    },
    redmineIssueQueueContext(payload, details, [
      ['AI-задача', 'Оформление описания Redmine'],
      ['Папка результата', taskDirectory]
    ])
  );

  const processed = await readFile(outputFile, 'utf8').catch(() => '');
  if (!processed.trim()) {
    throw new Error('codex-proxy не вернул обработанное описание задачи.');
  }

  return {
    directory: taskDirectory,
    inputFile,
    promptFile,
    outputFile,
    rawOutputFile
  };
}

async function saveAgentRunReport(payload: {
  runDirectory: string;
  workingDirectory: string;
  outputFile: string;
  rawOutputFile: string;
  issue: RedmineIssueAiPayload;
  prompt: string;
  sessionId: string | null;
}): Promise<{ reportDirectory: string; reportPath: string; outputFile: string; sessionId: string | null }> {
  const reportMarkdown = await readFile(payload.outputFile, 'utf8').catch(() => '');
  const reportId = path.basename(payload.runDirectory);
  const reportDirectory = path.join(AGENT_WORK_ROOT, reportId);
  const reportPath = path.join(reportDirectory, 'agent-result.md');
  const title = `#${payload.issue.issue.id} - ${payload.issue.issue.subject}`;

  await mkdir(reportDirectory, { recursive: true });
  await writeFile(reportPath, reportMarkdown || 'Агент не вернул текстовый результат.', 'utf8');
  await writeFile(path.join(reportDirectory, 'task.json'), JSON.stringify({
    title,
    summary: firstMarkdownParagraph(reportMarkdown),
    createdAt: new Date().toISOString(),
    sessionId: payload.sessionId,
    sourceRunDirectory: payload.runDirectory,
    workingDirectory: payload.workingDirectory,
    prompt: payload.prompt,
    redmine: {
      issueId: payload.issue.issue.id,
      url: payload.issue.issue.url,
      projectId: payload.issue.projectId,
      projectName: payload.issue.projectName,
      sprintId: payload.issue.sprintId,
      sprintName: payload.issue.sprintName,
      statusId: payload.issue.issue.statusId,
      status: payload.issue.issue.status,
      priority: payload.issue.issue.priority,
      assignee: payload.issue.issue.assignee
    }
  }, null, 2), 'utf8');

  return {
    reportDirectory,
    reportPath,
    outputFile: reportPath,
    sessionId: payload.sessionId
  };
}

async function runAgentForRedmineIssue(
  redmine: RedmineService,
  payload: RedmineIssueAgentRunPayload
): Promise<RedmineIssueAgentRunResult> {
  const workingDirectory = payload.workingDirectory.trim();
  if (!workingDirectory) {
    throw new Error('Выберите рабочую папку агента.');
  }
  const directoryStat = await stat(workingDirectory).catch(() => null);
  if (!directoryStat?.isDirectory()) {
    throw new Error('Выбранная рабочая папка недоступна.');
  }
  if (!payload.issue?.issue?.id) {
    throw new Error('Задача Redmine не выбрана.');
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDirectory = path.join(
    workingDirectory,
    '.team-space-agent-runs',
    `issue-${safePathSegment(payload.issue.issue.id)}-${timestamp}`
  );
  const inputFile = path.join(runDirectory, 'task.json');
  const issueMarkdownFile = path.join(runDirectory, 'task.md');
  const promptFile = path.join(runDirectory, 'prompt.md');
  const outputFile = path.join(runDirectory, 'agent-result.md');
  const rawOutputFile = path.join(runDirectory, 'codex-proxy.log');

  await mkdir(runDirectory, { recursive: true });

  let details: Record<string, unknown> | null = null;
  let detailsError: string | null = null;
  try {
    details = await redmine.loadIssueDetails(payload.issue.issue.id);
  } catch (error) {
    detailsError = error instanceof Error ? error.message : 'Не удалось загрузить полную задачу Redmine.';
  }

  const issueMarkdown = buildIssueMarkdown(payload.issue, details);
  const prompt = buildIssueAgentPrompt(issueMarkdown, payload.prompt, workingDirectory);
  await writeFile(
    inputFile,
    JSON.stringify({
      capturedAt: new Date().toISOString(),
      workingDirectory,
      payload,
      details,
      detailsError
    }, null, 2),
    'utf8'
  );
  await writeFile(issueMarkdownFile, issueMarkdown, 'utf8');
  await writeFile(promptFile, prompt, 'utf8');

  void enqueueAiTask(
    `Агент по задаче #${payload.issue.issue.id}`,
    { view: 'myTasks', label: `Задача #${payload.issue.issue.id}`, issueId: payload.issue.issue.id },
    async () => {
      const run = await runCodexProxy(runDirectory, prompt, outputFile, rawOutputFile, {
        cwd: workingDirectory,
        sandbox: 'workspace-write',
        timeoutMs: CODEX_AGENT_TIMEOUT_MS
      });
      return saveAgentRunReport({
        runDirectory,
        workingDirectory,
        outputFile,
        rawOutputFile,
        issue: payload.issue,
        prompt: payload.prompt,
        sessionId: run.sessionId
      });
    },
    redmineIssueQueueContext(payload.issue, details, [
      ['AI-задача', 'Coding agent'],
      ['Рабочая папка', workingDirectory],
      ['Папка результата', runDirectory],
      ['Дополнительный промпт', compactContextText(payload.prompt, 300)]
    ])
  ).catch(() => undefined);

  return {
    directory: runDirectory,
    workingDirectory,
    inputFile,
    issueMarkdownFile,
    promptFile,
    outputFile,
    rawOutputFile
  };
}

async function generateSprintResultsWithAi(
  payload: RedmineSprintResultsPayload
): Promise<RedmineSprintResultsAiResult> {
  if (!payload.projectId) {
    throw new Error('Проект Redmine не выбран.');
  }
  if (!payload.sprintId) {
    throw new Error('Спринт не выбран.');
  }
  if (payload.issues.length === 0) {
    throw new Error('В выбранном спринте нет задач для анализа.');
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tasksDirectory = path.join(app.getPath('documents'), 'Team Space AI Tasks');
  const taskDirectory = path.join(
    tasksDirectory,
    `sprint-results-${safePathSegment(payload.sprintId)}-${timestamp}`
  );
  const inputFile = path.join(taskDirectory, 'sprint.json');
  const sprintMarkdownFile = path.join(taskDirectory, 'sprint.md');
  const promptFile = path.join(taskDirectory, 'prompt.md');
  const outputFile = path.join(taskDirectory, 'processed.md');
  const rawOutputFile = path.join(taskDirectory, 'codex-proxy.log');

  await mkdir(taskDirectory, { recursive: true });

  const sprintMarkdown = buildSprintResultsMarkdown(payload);
  const prompt = buildSprintResultsPrompt(sprintMarkdown);
  await writeFile(inputFile, JSON.stringify({ capturedAt: new Date().toISOString(), payload }, null, 2), 'utf8');
  await writeFile(sprintMarkdownFile, sprintMarkdown, 'utf8');
  await writeFile(promptFile, prompt, 'utf8');

  await enqueueAiTask(
    `Результаты спринта: ${payload.sprintName || payload.sprintId}`,
    { view: 'myTasks', label: payload.sprintName || 'Мои задачи' },
    async () => {
      const run = await runCodexProxy(taskDirectory, prompt, outputFile, rawOutputFile);
      return { directory: taskDirectory, outputFile, rawOutputFile, sessionId: run.sessionId };
    },
    {
      title: `Спринт: ${payload.sprintName || payload.sprintId}`,
      description: payload.issues.slice(0, 8).map((issue) =>
        `#${issue.id} ${issue.subject} - ${issue.status || 'без статуса'}`
      ).join('\n') || 'Задач в спринте нет.',
      fields: contextFields([
        ['Тип', 'Итоги спринта'],
        ['Проект', payload.projectName || payload.projectId],
        ['Спринт', payload.sprintName || payload.sprintId],
        ['Задач', String(payload.issues.length)],
        ['Папка результата', taskDirectory]
      ])
    }
  );

  const content = await readFile(outputFile, 'utf8').catch(() => '');
  if (!content.trim()) {
    throw new Error('codex-proxy не вернул результаты спринта.');
  }

  return {
    directory: taskDirectory,
    inputFile,
    promptFile,
    outputFile,
    rawOutputFile,
    content
  };
}

async function createRedmineIssueFromMessagesWithAi(
  store: LocalStore,
  redmine: RedmineService,
  payload: CreateRedmineIssueFromMessagesPayload
): Promise<AppState> {
  const state = store.getState();
  const messageIds = new Set(payload.messageIds);
  const messages = state.telegram.messages.filter((message) => messageIds.has(message.id));
  if (messages.length === 0) {
    throw new Error('Выберите хотя бы одно сообщение.');
  }
  if (!state.workspace.defaultProjectId) {
    throw new Error('Проект Redmine не выбран. Откройте настройки и выберите проект.');
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tasksDirectory = path.join(app.getPath('documents'), 'Team Space AI Tasks');
  const taskDirectory = path.join(tasksDirectory, `telegram-issue-${timestamp}`);
  const inputFile = path.join(taskDirectory, 'messages.json');
  const taskMarkdownFile = path.join(taskDirectory, 'messages.md');
  const promptFile = path.join(taskDirectory, 'prompt.md');
  const outputFile = path.join(taskDirectory, 'processed.md');
  const rawOutputFile = path.join(taskDirectory, 'codex-proxy.log');

  await mkdir(taskDirectory, { recursive: true });

  const sourceMarkdown = buildTelegramMessagesMarkdown(messages, state.telegram.chats, state.telegram.topics);
  const prompt = buildNewIssuePrompt(sourceMarkdown, state);
  await writeFile(
    inputFile,
    JSON.stringify({
      capturedAt: new Date().toISOString(),
      payload,
      workspace: state.workspace,
      redmine: {
        project: optionName(state.redmine.projects, state.workspace.defaultProjectId),
        tracker: optionName(state.redmine.trackers, state.workspace.defaultTrackerId),
        priority: optionName(state.redmine.priorities, state.workspace.defaultPriorityId),
        sprint: optionName(state.redmine.sprints, state.workspace.defaultSprintId),
        assignee: optionName(state.redmine.users, state.workspace.defaultAssigneeId)
      },
      messages
    }, null, 2),
    'utf8'
  );
  await writeFile(taskMarkdownFile, sourceMarkdown, 'utf8');
  await writeFile(promptFile, prompt, 'utf8');

  await enqueueAiTask(
    'Задача из Telegram',
    { view: 'inbox', label: 'Сообщения' },
    async () => {
      const run = await runCodexProxy(taskDirectory, prompt, outputFile, rawOutputFile);
      return { directory: taskDirectory, outputFile, rawOutputFile, sessionId: run.sessionId };
    },
    {
      title: 'Задача из Telegram',
      description: messages.slice(0, 5).map((message) =>
        `${message.senderName || 'Автор'}: ${compactContextText(message.text, 220)}`
      ).join('\n'),
      fields: contextFields([
        ['Тип', 'Постановка задачи из сообщений'],
        ['Сообщений', String(messages.length)],
        ['Проект', optionName(state.redmine.projects, state.workspace.defaultProjectId)],
        ['Спринт', optionName(state.redmine.sprints, state.workspace.defaultSprintId)],
        ['Исполнитель', optionName(state.redmine.users, state.workspace.defaultAssigneeId)],
        ['Папка результата', taskDirectory]
      ])
    }
  );

  const processed = await readFile(outputFile, 'utf8').catch(() => '');
  if (!processed.trim()) {
    throw new Error('codex-proxy не вернул постановку задачи.');
  }

  const generatedIssue = parseGeneratedNewIssueDocument(processed, telegramIssueFallbackTitle(messages));
  await redmine.createIssue({
    projectId: state.workspace.defaultProjectId,
    sprintId: state.workspace.defaultSprintId,
    trackerId: state.workspace.defaultTrackerId,
    priorityId: state.workspace.defaultPriorityId,
    assigneeId: state.workspace.defaultAssigneeId,
    subject: generatedIssue.subject,
    description: generatedIssue.description
  });

  return store.setState((draftState) => {
    draftState.telegram.messages = draftState.telegram.messages.map((message) =>
      messageIds.has(message.id)
        ? { ...message, status: 'created', updatedAt: new Date().toISOString() }
        : message
    );
    draftState.metrics.createdIssues += 1;
  });
}

async function findLatestGeneratedIssueDescriptions(issueIds: string[]): Promise<Record<string, string>> {
  const uniqueIssueIds = Array.from(new Set(issueIds.map((issueId) => issueId.trim()).filter(Boolean)));
  if (uniqueIssueIds.length === 0) {
    return {};
  }

  const tasksDirectory = path.join(app.getPath('documents'), 'Team Space AI Tasks');
  const entries = await readdir(tasksDirectory, { withFileTypes: true }).catch(() => []);
  const latestByIssue = new Map<string, { outputFile: string; mtimeMs: number }>();

  await Promise.all(uniqueIssueIds.map(async (issueId) => {
    const directoryPrefix = `issue-${safePathSegment(issueId)}-`;
    const matchingDirectories = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith(directoryPrefix));

    for (const directory of matchingDirectories) {
      const outputFile = path.join(tasksDirectory, directory.name, 'processed.md');
      const fileStat = await stat(outputFile).catch(() => null);
      if (!fileStat?.isFile()) {
        continue;
      }

      const current = latestByIssue.get(issueId);
      if (!current || fileStat.mtimeMs > current.mtimeMs) {
        latestByIssue.set(issueId, { outputFile, mtimeMs: fileStat.mtimeMs });
      }
    }
  }));

  return Object.fromEntries(
    Array.from(latestByIssue.entries()).map(([issueId, value]) => [issueId, value.outputFile])
  );
}

export function registerIpcHandlers(
  store: LocalStore,
  telegram: TelegramService,
  redmine: RedmineService,
  gitlab: GitLabService
): void {
  ipcMain.handle('app:get-state', () => store.getState());

  ipcMain.handle('app:delete-local-data', () => store.deleteAll());

  ipcMain.handle('ai-queue:list', async () => {
    await loadAiQueueHistory();
    return aiQueueSnapshot();
  });
  ipcMain.handle('agent-work:get-prompt', () => agentWorkPrompt());
  ipcMain.handle('agent-work:list', () => listAgentWorkReports());
  ipcMain.handle('agent-work:open-folder', async () => {
    await mkdir(AGENT_WORK_ROOT, { recursive: true });
    return shell.openPath(AGENT_WORK_ROOT);
  });
  ipcMain.handle('agent-work:delete', (_event, payload: { reportId: string }) =>
    deleteAgentWorkReport(payload.reportId));
  ipcMain.handle('agent-work:create-redmine-issue', (_event, payload: AgentWorkCreateIssuePayload) =>
    createRedmineIssueFromAgentWork(store, redmine, payload));
  ipcMain.handle('agent-work:select-directory', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Выберите рабочую папку агента',
      properties: ['openDirectory']
    });
    return result.canceled ? '' : result.filePaths[0] ?? '';
  });
  ipcMain.handle('agent-work:prepare-gitlab-project', (_event, payload: { projectId: string }) =>
    prepareGitLabProjectWorkspace(store, payload));
  ipcMain.handle('agent-work:get-gitlab-project-workspace-path', (_event, payload: { projectId: string }) =>
    gitLabProjectWorkspacePath(store, payload));
  ipcMain.handle('agent-work:run-redmine-issue', (_event, payload: RedmineIssueAgentRunPayload) =>
    runAgentForRedmineIssue(redmine, payload));

  ipcMain.handle('shell:open-external', (_event, url: string) => shell.openExternal(url));
  ipcMain.handle('shell:open-path', (_event, filePath: string) => shell.openPath(filePath));
  ipcMain.handle('clipboard:write-text', (_event, text: string) => {
    clipboard.writeText(text);
  });
  ipcMain.handle('file:read-text', (_event, filePath: string) => readFile(filePath, 'utf8'));
  ipcMain.handle('file:write-text', async (_event, payload: { filePath: string; content: string }) => {
    await writeFile(payload.filePath, payload.content, 'utf8');
  });

  ipcMain.handle('telemost:open', async (_event, url: string) => shell.openExternal(url));

  ipcMain.handle('katya:me', (_event, payload: { baseUrl: string; sessionCookie: string }) =>
    requestKatyaJson(payload.baseUrl, payload.sessionCookie, '/auth/me'));

  ipcMain.handle('katya:get-base-url', () => savedKatyaBaseUrl(store));

  ipcMain.handle('katya:save-base-url', (_event, payload: { baseUrl: string }) => {
    store.setSecret('katyaBaseUrl', normalizeKatyaBaseUrl(payload.baseUrl));
  });

  ipcMain.handle('katya:save-settings', (_event, payload: { baseUrl: string; sessionCookie?: string }) => {
    store.setSecret('katyaBaseUrl', normalizeKatyaBaseUrl(payload.baseUrl));
    if (payload.sessionCookie?.trim()) {
      store.setSecret('katyaSessionCookie', payload.sessionCookie);
    }
  });

  ipcMain.handle('katya:get-session', () => store.getSecret('katyaSessionCookie') ?? '');

  ipcMain.handle('katya:save-session', (_event, payload: { sessionCookie: string }) => {
    store.setSecret('katyaSessionCookie', payload.sessionCookie);
  });

  ipcMain.handle('katya:list-groups', async (_event, payload: { baseUrl: string; sessionCookie: string }) =>
    normalizeKatyaGroups(await requestKatyaJson(payload.baseUrl, payload.sessionCookie, '/api/v1/groups')));

  ipcMain.handle('katya:create-meeting', (_event, payload: {
    baseUrl: string;
    sessionCookie: string;
    url: string;
    title: string;
    groupId?: string;
  }) =>
    requestKatyaJson(payload.baseUrl, payload.sessionCookie, '/api/v1/meetings', {
      method: 'POST',
      body: JSON.stringify({
        url: payload.url,
        title: payload.title,
        group_id: payload.groupId || undefined
      })
    }));

  ipcMain.handle('katya:stop-meeting', (_event, payload: {
    baseUrl: string;
    sessionCookie: string;
    meetingId: string;
  }) =>
    requestKatyaJson(payload.baseUrl, payload.sessionCookie, `/api/v1/meetings/${payload.meetingId}/stop`, {
      method: 'POST'
    }));

  ipcMain.handle('katya:list-meetings', (_event, payload: {
    baseUrl: string;
    sessionCookie: string;
    page?: number;
    pageSize?: number;
  }) => {
    const page = Math.max(1, Math.trunc(payload.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.trunc(payload.pageSize ?? 20)));
    return requestKatyaJson(
      payload.baseUrl,
      payload.sessionCookie,
      `/api/v1/meetings?page=${page}&page_size=${pageSize}`
    );
  });

  ipcMain.handle('katya:get-meeting', (_event, payload: {
    baseUrl: string;
    sessionCookie: string;
    meetingId: string;
  }) =>
    requestKatyaJson(
      payload.baseUrl,
      payload.sessionCookie,
      `/api/v1/meetings/${encodeURIComponent(payload.meetingId)}`
    ));

  ipcMain.handle('katya:analyze-dailies', (_event, payload: KatyaDailyAnalysisPayload) =>
    generateKatyaDailyAnalysis(payload));

  ipcMain.handle('katya:list-daily-analyses', () => listKatyaDailyAnalyses());

  ipcMain.handle('recording:save', async (_event, payload: { fileName: string; data: ArrayBuffer }) => {
    const recordingsDirectory = path.join(app.getPath('documents'), 'Team Space Recordings');
    const safeFileName = payload.fileName.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-');
    const filePath = path.join(recordingsDirectory, safeFileName);

    await mkdir(recordingsDirectory, { recursive: true });
    await writeFile(filePath, Buffer.from(payload.data));

    return {
      directory: recordingsDirectory,
      filePath
    };
  });

  ipcMain.handle('recording:open-folder', (_event, directory: string) => shell.openPath(directory));

  ipcMain.handle('telegram:request-code', (_event, payload: {
    phone: string;
    proxyUrl?: string;
  }) => telegram.requestCode(payload));

  ipcMain.handle('telegram:connect', (_event, payload: { code: string; password?: string }) =>
    telegram.connect(payload));

  ipcMain.handle('telegram:sync', () => telegram.sync());

  ipcMain.handle('telegram:get-inbox-snapshot', () =>
    telegram.getInboxSnapshot());

  ipcMain.handle('telegram:get-thread', (_event, payload: TelegramThreadRequest) =>
    telegram.getThread(payload));

  ipcMain.handle('telegram:mark-thread-read', (_event, payload: TelegramThreadKey) =>
    telegram.markThreadRead(payload));

  ipcMain.handle('telegram:load-chat-messages', (_event, payload: { chatId: string; topicId?: string }) =>
    telegram.loadChatMessages(payload));

  ipcMain.handle(
    'telegram:load-older-chat-messages',
    (_event, payload: { chatId: string; topicId?: string; beforeMessageId: string }) =>
      telegram.loadOlderChatMessages(payload)
  );

  ipcMain.handle('telegram:send-message', (_event, payload: {
    chatId: string;
    topicId?: string;
    replyToMessageId?: string;
    text: string;
    file?: TelegramOutgoingFile;
    image?: TelegramOutgoingFile;
  }) =>
    telegram.sendMessage(payload));

  ipcMain.handle('telegram:react-to-message', (_event, payload: { messageId: string; emoticon: string }) =>
    telegram.reactToMessage(payload));

  ipcMain.handle('telegram:download-attachment', async (_event, payload: TelegramAttachmentDownloadPayload) => {
    const result = await telegram.downloadAttachment(payload);
    shell.showItemInFolder(result.filePath);
    return result;
  });

  ipcMain.handle('telegram:disconnect', () => telegram.disconnect());

  ipcMain.handle('telegram:select-workspace', (_event, payload: { folderId: string | null; chatIds: string[] }) =>
    telegram.selectWorkspace(payload));

  ipcMain.handle('telegram:set-chat-notifications', (_event, payload: { chatId: string; enabled: boolean }) =>
    telegram.setChatNotifications(payload));

  ipcMain.handle('gitlab:test', (_event, payload: { baseUrl: string; token?: string }) =>
    gitlab.test(payload));

  ipcMain.handle('gitlab:save', (_event, payload: {
    baseUrl: string;
    token?: string;
    selectedProjectIds: string[];
  }) => gitlab.save(payload));

  ipcMain.handle('gitlab:sync-projects', () => gitlab.syncProjects());

  ipcMain.handle('gitlab:disconnect', () => gitlab.disconnect());

  ipcMain.handle('redmine:test', (_event, payload: { baseUrl: string; apiKey?: string }) =>
    redmine.test(payload));

  ipcMain.handle(
    'redmine:save',
    (_event, payload: {
      baseUrl: string;
      apiKey?: string;
      defaultProjectId: string;
      defaultTrackerId: string;
      defaultPriorityId: string;
      defaultSprintId?: string;
      defaultAssigneeId?: string;
    }) => redmine.save(payload)
  );

  ipcMain.handle('redmine:load-project-users', (_event, payload: { projectId: string }) =>
    redmine.loadProjectUsers(payload));

  ipcMain.handle('redmine:select-project', (_event, payload: { projectId: string }) =>
    redmine.selectProject(payload));

  ipcMain.handle('redmine:load-my-issues', (_event, payload: { projectId: string; sprintId: string; assigneeId?: string }) =>
    redmine.loadMyIssues(payload));

  ipcMain.handle('redmine:sync-my-issues', (_event, payload: { projectId: string; sprintId: string; assigneeId?: string }) =>
    redmine.syncMyIssues(payload));

  ipcMain.handle('redmine:load-issue-details', (_event, payload: { issueId: string }) =>
    redmine.loadIssueDetails(payload.issueId));

  ipcMain.handle('redmine:update-issue-details', (_event, payload: {
    issueId: string;
    subject: string;
    description: string;
  }) =>
    redmine.updateIssueDetails(payload));

  ipcMain.handle('redmine:update-issue-assignee', (_event, payload: UpdateRedmineIssueAssigneePayload) =>
    redmine.updateIssueAssignee(payload));

  ipcMain.handle('redmine:update-issue-sprint', (_event, payload: UpdateRedmineIssueSprintPayload) =>
    redmine.updateIssueSprint(payload));

  ipcMain.handle('redmine:delete-issue', (_event, payload: DeleteRedmineIssuePayload) =>
    redmine.deleteIssue(payload));

  ipcMain.handle('redmine:add-issue-comment', (_event, payload: { issueId: string; notes: string }) =>
    redmine.addIssueComment(payload));

  ipcMain.handle('redmine:update-issue-journal', (_event, payload: {
    issueId: string;
    journalId: string;
    notes: string;
  }) =>
    redmine.updateIssueJournal(payload));

  ipcMain.handle('redmine:create-issue', (_event, payload: CreateRedmineIssuePayload) =>
    redmine.createIssue(payload));

  ipcMain.handle('redmine:update-issue-status', (_event, payload: {
    issueId: string;
    statusId: string;
    status?: string;
    projectId?: string;
    sprintId?: string;
    cacheAssigneeId?: string;
  }) =>
    redmine.updateIssueStatus(payload));

  ipcMain.handle('redmine:format-issue-ai', (_event, payload: RedmineIssueAiPayload) =>
    formatRedmineIssueWithAi(redmine, payload));
  ipcMain.handle('redmine:sprint-results-ai', (_event, payload: RedmineSprintResultsPayload) =>
    generateSprintResultsWithAi(payload));
  ipcMain.handle('redmine:latest-generated-descriptions', (_event, payload: { issueIds: string[] }) =>
    findLatestGeneratedIssueDescriptions(payload.issueIds));
  ipcMain.handle('redmine:create-issue-from-messages-ai', (_event, payload: CreateRedmineIssueFromMessagesPayload) =>
    createRedmineIssueFromMessagesWithAi(store, redmine, payload));

  ipcMain.handle('redmine:disconnect', () => redmine.disconnect());
}
