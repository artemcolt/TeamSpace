import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeBaseUrl } from '../domain/appState';
import type {
  AddRedmineIssueCommentPayload,
  CreateRedmineIssuePayload,
  DeleteRedmineIssuePayload,
  RedmineUploadAttachment,
  RedmineIssueSummary,
  RedmineOption,
  UpdateRedmineIssueAssigneePayload,
  UpdateRedmineIssueDetailsPayload,
  UpdateRedmineIssueJournalPayload,
  UpdateRedmineIssueSprintPayload
} from '../domain/types';

const MAX_REDMINE_IMAGE_PREVIEW_BYTES = 6 * 1024 * 1024;

function mimeTypeForFileName(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === '.png') {
    return 'image/png';
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    return 'image/jpeg';
  }
  if (extension === '.webp') {
    return 'image/webp';
  }
  if (extension === '.gif') {
    return 'image/gif';
  }
  if (extension === '.md' || extension === '.txt') {
    return 'text/plain';
  }
  if (extension === '.json') {
    return 'application/json';
  }
  return 'application/octet-stream';
}

export async function fetchRedmineJson<T>(baseUrl: string, apiKey: string, endpoint: string): Promise<T> {
  const url = new URL(endpoint, normalizeBaseUrl(baseUrl));
  const response = await fetch(url, {
    headers: {
      'X-Redmine-API-Key': apiKey,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Redmine ${response.status}: ${text || response.statusText}`);
  }

  return (await response.json()) as T;
}

async function fetchRedmineBinary(
  baseUrl: string,
  apiKey: string,
  contentUrl: string
): Promise<{ buffer: Buffer; contentType: string }> {
  const url = new URL(contentUrl, normalizeBaseUrl(baseUrl));
  const response = await fetch(url, {
    headers: {
      'X-Redmine-API-Key': apiKey,
      Accept: '*/*'
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Redmine ${response.status}: ${text || response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || ''
  };
}

export async function postRedmineJson<T>(
  baseUrl: string,
  apiKey: string,
  endpoint: string,
  body: unknown
): Promise<T> {
  const url = new URL(endpoint, normalizeBaseUrl(baseUrl));
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Redmine-API-Key': apiKey,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Redmine ${response.status}: ${text || response.statusText}`);
  }

  return (await response.json()) as T;
}

async function uploadRedmineFile(
  baseUrl: string,
  apiKey: string,
  attachment: RedmineUploadAttachment
): Promise<{ token: string; filename: string; content_type: string }> {
  const fileName = attachment.fileName || path.basename(attachment.filePath);
  const contentType = attachment.contentType || mimeTypeForFileName(fileName);
  const file = await readFile(attachment.filePath);
  const url = new URL('uploads.json', normalizeBaseUrl(baseUrl));
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Redmine-API-Key': apiKey,
      Accept: 'application/json',
      'Content-Type': 'application/octet-stream'
    },
    body: file
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Redmine ${response.status}: ${text || response.statusText}`);
  }

  const payload = await response.json() as { upload?: { token?: string } };
  const token = payload.upload?.token;
  if (!token) {
    throw new Error('Redmine не вернул token для вложения.');
  }

  return {
    token,
    filename: fileName,
    content_type: contentType
  };
}

function isImageFileName(fileName: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(fileName);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inlineImageMarkup(fileName: string): string {
  return `!${fileName}!`;
}

function descriptionIncludesInlineImage(description: string, fileName: string): boolean {
  return (
    description.includes(inlineImageMarkup(fileName)) ||
    description.includes(`![](${fileName})`) ||
    description.includes(`![](attachment:${fileName})`)
  );
}

function inlineRedmineImageAttachments(
  description: string,
  uploads: Array<{ filename: string; content_type: string }> = []
): string {
  const imageUploads = uploads.filter((upload) =>
    upload.content_type.toLowerCase().startsWith('image/') || isImageFileName(upload.filename)
  );
  if (imageUploads.length === 0) {
    return description;
  }

  let nextDescription = description;
  let replacedAny = false;
  for (const upload of imageUploads) {
    const fileNamePattern = escapeRegExp(upload.filename);
    const replacement = inlineImageMarkup(upload.filename);
    const attachmentLinkPattern = new RegExp(`attachment:(?:"${fileNamePattern}"|${fileNamePattern})`, 'g');
    const markdownAttachmentPattern = new RegExp(`!\\[[^\\]]*\\]\\(attachment:${fileNamePattern}\\)`, 'g');
    const markdownFilePattern = new RegExp(`!\\[[^\\]]*\\]\\(${fileNamePattern}\\)`, 'g');
    const previousDescription = nextDescription;
    nextDescription = nextDescription
      .replace(markdownAttachmentPattern, replacement)
      .replace(markdownFilePattern, replacement)
      .replace(attachmentLinkPattern, replacement);
    replacedAny = replacedAny || previousDescription !== nextDescription;
  }

  const imagesMissingFromDescription = imageUploads.filter((upload) =>
    !descriptionIncludesInlineImage(nextDescription, upload.filename)
  );
  if (replacedAny || imagesMissingFromDescription.length === 0) {
    return nextDescription;
  }

  return [
    nextDescription.trimEnd(),
    '',
    '## Скриншоты',
    ...imagesMissingFromDescription.map((upload) => inlineImageMarkup(upload.filename))
  ].join('\n');
}

export async function putRedmineJson<T>(
  baseUrl: string,
  apiKey: string,
  endpoint: string,
  body: unknown
): Promise<T | null> {
  const url = new URL(endpoint, normalizeBaseUrl(baseUrl));
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'X-Redmine-API-Key': apiKey,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Redmine ${response.status}: ${text || response.statusText}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) as T : null;
}

export async function deleteRedmineJson(
  baseUrl: string,
  apiKey: string,
  endpoint: string
): Promise<void> {
  const url = new URL(endpoint, normalizeBaseUrl(baseUrl));
  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      'X-Redmine-API-Key': apiKey,
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Redmine ${response.status}: ${text || response.statusText}`);
  }
}

async function fetchRedminePages<T>(
  baseUrl: string,
  apiKey: string,
  endpoint: string,
  key: string | string[]
): Promise<T[]> {
  const items: T[] = [];
  let offset = 0;
  const limit = 100;
  const keys = Array.isArray(key) ? key : [key];

  while (true) {
    const separator = endpoint.includes('?') ? '&' : '?';
    const pageEndpoint = `${endpoint}${separator}limit=${limit}&offset=${offset}`;

    const response = await fetchRedmineJson<Record<string, unknown>>(baseUrl, apiKey, pageEndpoint);
    const pageItems = (keys
      .map((responseKey) => response[responseKey] as T[] | undefined)
      .find((value) => Array.isArray(value)) ?? []);
    items.push(...pageItems);

    const total = typeof response.total_count === 'number' ? response.total_count : pageItems.length;
    const pageOffset = typeof response.offset === 'number' ? response.offset : offset;
    const pageLimit = typeof response.limit === 'number' ? response.limit : pageItems.length || limit;
    offset = pageOffset + pageLimit;
    if (offset >= total || pageItems.length === 0) {
      break;
    }
  }

  return items;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function isImageAttachment(attachment: Record<string, unknown>): boolean {
  const contentType = stringValue(attachment.content_type).toLowerCase();
  const filename = stringValue(attachment.filename).toLowerCase();
  return contentType.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(filename);
}

function attachmentFileSize(attachment: Record<string, unknown>): number | null {
  const size = Number(attachment.filesize ?? attachment.size);
  return Number.isFinite(size) && size >= 0 ? size : null;
}

async function enrichIssueAttachmentPreviews(
  baseUrl: string,
  apiKey: string,
  response: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const issue = asRecord(response.issue);
  if (!issue || !Array.isArray(issue.attachments)) {
    return response;
  }

  const attachments = await Promise.all(issue.attachments.map(async (rawAttachment) => {
    const attachment = asRecord(rawAttachment);
    if (!attachment) {
      return rawAttachment;
    }

    const contentUrl = stringValue(attachment.content_url);
    const fileSize = attachmentFileSize(attachment);
    if (
      !contentUrl ||
      !isImageAttachment(attachment) ||
      (fileSize !== null && fileSize > MAX_REDMINE_IMAGE_PREVIEW_BYTES)
    ) {
      return attachment;
    }

    try {
      const file = await fetchRedmineBinary(baseUrl, apiKey, contentUrl);
      const contentType = file.contentType || stringValue(attachment.content_type).toLowerCase() || 'image/png';
      if (!contentType.startsWith('image/') || file.buffer.byteLength > MAX_REDMINE_IMAGE_PREVIEW_BYTES) {
        return attachment;
      }
      return {
        ...attachment,
        content_type: contentType,
        previewDataUrl: `data:${contentType};base64,${file.buffer.toString('base64')}`
      };
    } catch {
      return attachment;
    }
  }));

  return {
    ...response,
    issue: {
      ...issue,
      attachments
    }
  };
}

function sprintOptionId(type: 'agile' | 'easy' | 'version', id: number): string {
  return `${type}:${id}`;
}

export function parseSprintOptionId(value: string): { type: 'agile' | 'easy' | 'version'; id: number } | null {
  const [type, rawId] = value.includes(':') ? value.split(':', 2) : ['version', value];
  const id = Number(rawId);
  if ((type === 'agile' || type === 'easy' || type === 'version') && Number.isFinite(id)) {
    return { type, id };
  }
  return null;
}

interface RedmineIssueResponseItem {
  id: number;
  subject: string;
  tracker?: { id: number; name: string };
  status?: { id: number; name: string };
  priority?: { id: number; name: string };
  assigned_to?: { id: number; name: string };
  due_date?: string;
  updated_on?: string;
  easy_sprint?: { id: number | string; name?: string };
  agile_sprint?: { id: number | string; name?: string };
  agile_data?: { agile_sprint_id?: number | string };
}

export async function loadRedmineMyIssues(
  baseUrl: string,
  apiKey: string,
  payload: { projectId: string; sprintId: string }
): Promise<RedmineIssueSummary[]> {
  const sprint = parseSprintOptionId(payload.sprintId);
  if (!payload.projectId || !sprint) {
    return [];
  }

  const projectFilter = `project_id=${encodeURIComponent(payload.projectId)}&assigned_to_id=me&status_id=open`;
  let issues: RedmineIssueResponseItem[];
  if (sprint.type === 'version') {
    issues = await fetchRedminePages<RedmineIssueResponseItem>(
      baseUrl,
      apiKey,
      `issues.json?${projectFilter}&fixed_version_id=${encodeURIComponent(String(sprint.id))}`,
      'issues'
    );
  } else {
    const sprintFilter = sprint.type === 'easy'
      ? `&easy_sprint_id=${encodeURIComponent(String(sprint.id))}`
      : `&agile_sprint_id=${encodeURIComponent(String(sprint.id))}`;
    issues = await fetchRedminePages<RedmineIssueResponseItem>(
      baseUrl,
      apiKey,
      `issues.json?${projectFilter}${sprintFilter}`,
      'issues'
    );
    issues = issues.filter((issue) => issueMatchesSprint(issue, sprint));
  }

  return issues.map((issue) => toIssueSummary(baseUrl, issue));
}

export async function loadRedmineIssueDetails(
  baseUrl: string,
  apiKey: string,
  issueId: string
): Promise<Record<string, unknown>> {
  const encodedIssueId = encodeURIComponent(issueId);
  try {
    const response = await fetchRedmineJson<Record<string, unknown>>(
      baseUrl,
      apiKey,
      `issues/${encodedIssueId}.json?include=journals,attachments,relations,children`
    );
    return enrichIssueAttachmentPreviews(baseUrl, apiKey, response);
  } catch {
    const response = await fetchRedmineJson<Record<string, unknown>>(baseUrl, apiKey, `issues/${encodedIssueId}.json`);
    return enrichIssueAttachmentPreviews(baseUrl, apiKey, response);
  }
}

export async function updateRedmineIssueDetails(
  baseUrl: string,
  apiKey: string,
  payload: UpdateRedmineIssueDetailsPayload
): Promise<void> {
  await putRedmineJson(
    baseUrl,
    apiKey,
    `issues/${encodeURIComponent(payload.issueId)}.json`,
    {
      issue: {
        subject: payload.subject,
        description: payload.description
      }
    }
  );
}

export async function updateRedmineIssueAssignee(
  baseUrl: string,
  apiKey: string,
  payload: UpdateRedmineIssueAssigneePayload
): Promise<void> {
  await putRedmineJson(
    baseUrl,
    apiKey,
    `issues/${encodeURIComponent(payload.issueId)}.json`,
    {
      issue: {
        assigned_to_id: payload.assigneeId ? Number(payload.assigneeId) : null
      }
    }
  );
}

export async function deleteRedmineIssue(
  baseUrl: string,
  apiKey: string,
  payload: DeleteRedmineIssuePayload
): Promise<void> {
  await deleteRedmineJson(
    baseUrl,
    apiKey,
    `issues/${encodeURIComponent(payload.issueId)}.json`
  );
}

export async function addRedmineIssueComment(
  baseUrl: string,
  apiKey: string,
  payload: AddRedmineIssueCommentPayload
): Promise<void> {
  await putRedmineJson(
    baseUrl,
    apiKey,
    `issues/${encodeURIComponent(payload.issueId)}.json`,
    {
      issue: {
        notes: payload.notes
      }
    }
  );
}

export async function updateRedmineIssueJournal(
  baseUrl: string,
  apiKey: string,
  payload: UpdateRedmineIssueJournalPayload
): Promise<void> {
  await putRedmineJson(
    baseUrl,
    apiKey,
    `journals/${encodeURIComponent(payload.journalId)}.json`,
    {
      journal: {
        notes: payload.notes
      }
    }
  );
}

function issueMatchesSprint(
  issue: RedmineIssueResponseItem,
  sprint: { type: 'agile' | 'easy' | 'version'; id: number }
): boolean {
  if (sprint.type === 'easy') {
    return String(issue.easy_sprint?.id ?? '') === String(sprint.id);
  }
  if (sprint.type === 'agile') {
    return (
      String(issue.agile_data?.agile_sprint_id ?? '') === String(sprint.id) ||
      String(issue.agile_sprint?.id ?? '') === String(sprint.id)
    );
  }
  return false;
}

function toIssueSummary(baseUrl: string, issue: RedmineIssueResponseItem): RedmineIssueSummary {
  return {
    id: String(issue.id),
    subject: issue.subject,
    statusId: issue.status?.id ? String(issue.status.id) : '',
    tracker: issue.tracker?.name ?? '',
    status: issue.status?.name ?? '',
    priority: issue.priority?.name ?? '',
    assignee: issue.assigned_to?.name ?? '',
    dueDate: issue.due_date ?? '',
    updatedOn: issue.updated_on ?? '',
    url: new URL(`issues/${issue.id}`, normalizeBaseUrl(baseUrl)).toString()
  };
}

export async function loadRedmineCatalogs(baseUrl: string, apiKey: string) {
  const projectsResponse = await fetchRedmineJson<{ projects: Array<{ id: number; name: string }> }>(
    baseUrl,
    apiKey,
    'projects.json?limit=100'
  );

  let trackers: RedmineOption[] = [];
  let priorities: RedmineOption[] = [];
  let statuses: RedmineOption[] = [];
  let users: RedmineOption[] = [];

  try {
    const response = await fetchRedmineJson<{ trackers: Array<{ id: number; name: string }> }>(
      baseUrl,
      apiKey,
      'trackers.json'
    );
    trackers = response.trackers.map((item) => ({ id: String(item.id), name: item.name }));
  } catch {
    trackers = [];
  }

  try {
    const response = await fetchRedmineJson<{
      issue_priorities: Array<{ id: number; name: string }>;
    }>(baseUrl, apiKey, 'enumerations/issue_priorities.json');
    priorities = response.issue_priorities.map((item) => ({ id: String(item.id), name: item.name }));
  } catch {
    priorities = [];
  }

  try {
    const response = await fetchRedmineJson<{ issue_statuses: Array<{ id: number; name: string }> }>(
      baseUrl,
      apiKey,
      'issue_statuses.json'
    );
    statuses = response.issue_statuses.map((item) => ({ id: String(item.id), name: item.name }));
  } catch {
    statuses = [];
  }

  try {
    const response = await fetchRedmineJson<{
      users: Array<{ id: number; firstname: string; lastname: string; login: string }>;
    }>(baseUrl, apiKey, 'users.json?status=1&limit=100');
    users = response.users.map((user) => ({
      id: String(user.id),
      name: `${user.firstname} ${user.lastname}`.trim() || user.login
    }));
  } catch {
    users = [];
  }

  return {
    projects: projectsResponse.projects.map((item) => ({ id: String(item.id), name: item.name })),
    trackers,
    priorities,
    statuses,
    users
  };
}

export async function updateRedmineIssueStatus(
  baseUrl: string,
  apiKey: string,
  payload: { issueId: string; statusId: string }
): Promise<void> {
  await putRedmineJson(
    baseUrl,
    apiKey,
    `issues/${encodeURIComponent(payload.issueId)}.json`,
    {
      issue: {
        status_id: Number(payload.statusId)
      }
    }
  );
}

export async function updateRedmineIssueSprint(
  baseUrl: string,
  apiKey: string,
  payload: UpdateRedmineIssueSprintPayload
): Promise<void> {
  const sprint = parseSprintOptionId(payload.sprintId);
  if (!sprint) {
    throw new Error('Спринт Redmine не выбран.');
  }

  await putRedmineJson(
    baseUrl,
    apiKey,
    `issues/${encodeURIComponent(payload.issueId)}.json`,
    {
      issue: {
        fixed_version_id: sprint.type === 'version' ? sprint.id : undefined,
        easy_sprint_id: sprint.type === 'easy' ? sprint.id : undefined,
        agile_data_attributes: sprint.type === 'agile'
          ? { agile_sprint_id: sprint.id }
          : undefined
      }
    }
  );
}

export async function createRedmineIssue(
  baseUrl: string,
  apiKey: string,
  payload: CreateRedmineIssuePayload
): Promise<{ id: string }> {
  const sprint = payload.sprintId ? parseSprintOptionId(payload.sprintId) : null;
  const uploads = payload.attachments && payload.attachments.length > 0
    ? await Promise.all(payload.attachments.map((attachment) => uploadRedmineFile(baseUrl, apiKey, attachment)))
    : undefined;
  const baseDescription = payload.description || payload.subject;
  const description = payload.inlineImageAttachments === false
    ? baseDescription
    : inlineRedmineImageAttachments(baseDescription, uploads);
  const response = await postRedmineJson<{ issue: { id: number } }>(
    baseUrl,
    apiKey,
    'issues.json',
    {
      issue: {
        project_id: Number(payload.projectId),
        tracker_id: payload.trackerId ? Number(payload.trackerId) : undefined,
        priority_id: payload.priorityId ? Number(payload.priorityId) : undefined,
        status_id: payload.statusId ? Number(payload.statusId) : undefined,
        fixed_version_id: sprint?.type === 'version' ? sprint.id : undefined,
        easy_sprint_id: sprint?.type === 'easy' ? sprint.id : undefined,
        assigned_to_id: payload.assigneeId ? Number(payload.assigneeId) : undefined,
        subject: payload.subject,
        description,
        uploads
      }
    }
  );

  const issueId = String(response.issue.id);
  if (sprint?.type === 'agile') {
    await putRedmineJson(
      baseUrl,
      apiKey,
      `issues/${issueId}.json`,
      {
        issue: {
          agile_data_attributes: {
            agile_sprint_id: sprint.id
          }
        }
      }
    );
  }

  return { id: issueId };
}

export async function loadRedmineAssignableUsers(
  baseUrl: string,
  apiKey: string,
  projectId: string
): Promise<RedmineOption[]> {
  if (!projectId) {
    return [];
  }

  const users = new Map<string, RedmineOption>();
  let offset = 0;
  const limit = 100;

  while (true) {
    const response = await fetchRedmineJson<{
      memberships: Array<{
        user?: { id: number; name: string };
        group?: { id: number; name: string };
      }>;
      total_count?: number;
      offset?: number;
      limit?: number;
    }>(baseUrl, apiKey, `projects/${encodeURIComponent(projectId)}/memberships.json?limit=${limit}&offset=${offset}`);

    for (const membership of response.memberships) {
      if (membership.user) {
        users.set(String(membership.user.id), {
          id: String(membership.user.id),
          name: membership.user.name
        });
      }
    }

    const total = response.total_count ?? response.memberships.length;
    offset += response.limit ?? limit;
    if (offset >= total || response.memberships.length === 0) {
      break;
    }
  }

  return [...users.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

export async function loadRedmineProjectSprints(
  baseUrl: string,
  apiKey: string,
  projectId: string
): Promise<RedmineOption[]> {
  if (!projectId) {
    return [];
  }

  let agileError: unknown = null;
  const agileSprints = await loadRedmineProjectAgileSprints(baseUrl, apiKey, projectId).catch((error) => {
    agileError = error;
    return [];
  });
  if (agileSprints.length > 0) {
    return agileSprints;
  }

  const directEasySprints = await loadRedmineProjectEasySprints(baseUrl, apiKey, projectId).catch(() => []);
  if (directEasySprints.length > 0) {
    return directEasySprints;
  }

  const issueEasySprints = await loadRedmineProjectEasySprintsFromIssues(baseUrl, apiKey, projectId).catch(() => []);
  if (issueEasySprints.length > 0) {
    return issueEasySprints;
  }

  const versions = await fetchRedminePages<{
    id: number;
    name: string;
    status?: string;
    due_date?: string;
    updated_on?: string;
    created_on?: string;
  }>(baseUrl, apiKey, `projects/${encodeURIComponent(projectId)}/versions.json`, 'versions');

  const versionOptions = versions
    .filter((version) => !version.status || version.status === 'open')
    .sort((a, b) => {
      const aDate = Date.parse(a.due_date || a.updated_on || a.created_on || '');
      const bDate = Date.parse(b.due_date || b.updated_on || b.created_on || '');
      if (Number.isFinite(aDate) && Number.isFinite(bDate) && aDate !== bDate) {
        return bDate - aDate;
      }
      return b.id - a.id;
    })
    .map((version) => ({ id: sprintOptionId('version', version.id), name: version.name }));

  if (versionOptions.length === 0 && agileError instanceof Error && !agileError.message.includes('Redmine 404')) {
    throw agileError;
  }

  return versionOptions;
}

async function loadRedmineProjectEasySprintsFromIssues(
  baseUrl: string,
  apiKey: string,
  projectId: string
): Promise<RedmineOption[]> {
  const issues = await fetchRedminePages<{
    easy_sprint?: {
      id: number;
      name: string;
      due_date?: string;
    };
  }>(baseUrl, apiKey, `issues.json?project_id=${encodeURIComponent(projectId)}&status_id=*`, 'issues');
  const sprints = new Map<string, { id: number; name: string; dueDate?: string }>();

  for (const issue of issues) {
    const sprint = issue.easy_sprint;
    if (!sprint?.id || !sprint.name) {
      continue;
    }
    sprints.set(String(sprint.id), {
      id: sprint.id,
      name: sprint.name,
      dueDate: sprint.due_date
    });
  }

  return [...sprints.values()]
    .sort((a, b) => {
      const aDate = Date.parse(a.dueDate || '');
      const bDate = Date.parse(b.dueDate || '');
      if (Number.isFinite(aDate) && Number.isFinite(bDate) && aDate !== bDate) {
        return bDate - aDate;
      }
      return b.id - a.id;
    })
    .map((sprint) => ({ id: sprintOptionId('easy', sprint.id), name: sprint.name }));
}

async function loadRedmineProjectEasySprints(
  baseUrl: string,
  apiKey: string,
  projectId: string
): Promise<RedmineOption[]> {
  const sprints = await fetchRedminePages<{
    id: number;
    name: string;
    due_date?: string;
    end_date?: string;
    start_date?: string;
  }>(baseUrl, apiKey, `projects/${encodeURIComponent(projectId)}/easy_sprints.json`, ['easy_sprints', 'sprints']);

  return sprints
    .sort((a, b) => {
      const aDate = Date.parse(a.due_date || a.end_date || a.start_date || '');
      const bDate = Date.parse(b.due_date || b.end_date || b.start_date || '');
      if (Number.isFinite(aDate) && Number.isFinite(bDate) && aDate !== bDate) {
        return bDate - aDate;
      }
      return b.id - a.id;
    })
    .map((sprint) => ({ id: sprintOptionId('easy', sprint.id), name: sprint.name }));
}

async function loadRedmineProjectAgileSprints(
  baseUrl: string,
  apiKey: string,
  projectId: string
): Promise<RedmineOption[]> {
  const sprints = await fetchRedminePages<{
    id: number;
    name: string;
    status?: string;
    start_date?: string;
    end_date?: string;
    updated_on?: string;
    created_on?: string;
  }>(baseUrl, apiKey, `projects/${encodeURIComponent(projectId)}/agile_sprints.json`, ['agile_sprints', 'sprints']);

  return sprints
    .filter((sprint) => sprint.status !== 'closed')
    .sort((a, b) => {
      const aDate = Date.parse(a.end_date || a.start_date || a.updated_on || a.created_on || '');
      const bDate = Date.parse(b.end_date || b.start_date || b.updated_on || b.created_on || '');
      if (Number.isFinite(aDate) && Number.isFinite(bDate) && aDate !== bDate) {
        return bDate - aDate;
      }
      return b.id - a.id;
    })
    .map((sprint) => ({ id: sprintOptionId('agile', sprint.id), name: sprint.name }));
}
