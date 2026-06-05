# Telegram TDLib Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current GramJS-centered Telegram implementation with a TDLib-backed working inbox that keeps Telegram state in TDLib and Team Space state in app-specific storage.

**Architecture:** Add the TDLib integration beside the existing Telegram service first, then move the inbox to focused snapshot/thread APIs. Use a fake TDLib client for most tests so auth, mapping, repository, IPC, and renderer behavior are verified before native `libtdjson` packaging is solved.

**Tech Stack:** Electron main process, React renderer, TypeScript, Vitest, sql.js, Electron `safeStorage`, TDLib JSON interface (`td_json` / `libtdjson`).

---

## Scope And Execution Notes

This plan implements the approved spec in `docs/superpowers/specs/2026-06-05-telegram-tdlib-inbox-design.md`.

The migration is intentionally staged. Do not remove GramJS until TDLib auth, snapshots, thread loading, send, reactions, downloads, read behavior, and Redmine message selection are covered by tests.

The repository currently has a dirty worktree. Before implementation, inspect `git status --short` and avoid reverting unrelated changes.

Run verification frequently:

```bash
npm run typecheck
npm test
```

---

## File Structure

Create and modify these files.

```text
src/shared/domain/telegram.ts
  Extend shared Telegram domain with inbox snapshots, thread requests, thread views,
  TDLib-neutral summaries, and app-specific workflow status types.

src/shared/contracts/ipcContract.ts
  Add focused Telegram inbox bridge methods while keeping existing compatibility methods.

src/main/integrations/telegram-tdlib/tdlibTypes.ts
  Minimal typed subset of TDLib JSON objects used by Team Space.

src/main/integrations/telegram-tdlib/TdlibClient.ts
  Interface plus request/response helper contracts for TDLib clients.

src/main/integrations/telegram-tdlib/FakeTdlibClient.ts
  Test-only scripted TDLib client.

src/main/integrations/telegram-tdlib/TdlibBinaryResolver.ts
  Native library path resolver for dev and packaged Electron.

src/main/integrations/telegram-tdlib/TdlibJsonClient.ts
  Thin wrapper around `td_json`; introduced after service tests pass with fake client.

src/main/integrations/telegram-tdlib/TdlibAuthService.ts
  TDLib authorization state handling.

src/main/integrations/telegram-tdlib/TdlibMapper.ts
  Convert TDLib JSON objects to Team Space domain objects.

src/main/integrations/telegram-tdlib/TdlibUpdateLoop.ts
  Receive TDLib updates and publish domain events.

src/main/integrations/telegram-tdlib/TdlibCommandAdapter.ts
  App-level Telegram commands backed by TDLib.

src/main/integrations/telegram-tdlib/TdlibMediaService.ts
  Lazy file download and local `teamspace-file://telegram/...` URL creation.

src/main/storage/repositories/telegramInboxRepository.ts
  App-specific selected chats, notification settings, workflow status, Redmine links.

src/main/storage/repositories/telegramInboxRepository.test.ts
  Repository migration and persistence tests.

src/main/features/inbox/TelegramInboxService.ts
  Compose TDLib adapter, mapper, repository, and events into app-facing inbox behavior.

src/main/features/inbox/TelegramInboxService.test.ts
  Snapshot, thread, unread, send, reaction, download, and read-gate tests using fake TDLib.

src/main/ipc/telegramIpc.ts
  Register new focused inbox channels and keep old compatibility channels.

src/main/preload.ts
  Expose new bridge methods.

src/renderer/features/inbox/Inbox.tsx
  Move selected thread data to thread view model instead of global `state.telegram.messages`.

src/renderer/app/AppShell.tsx
  Stop deriving `telegramMessageIndex` from global messages after thread API is in place.

package.json
package-lock.json
  Add a TDLib JSON binding only after fake-backed service tests are passing.
```

---

## Task 1: Shared Inbox Domain Contract

**Files:**
- Modify: `src/shared/domain/telegram.ts`
- Modify: `src/shared/contracts/ipcContract.ts`
- Test: `src/main/telegram/telegramService.test.ts` remains unchanged for compatibility in this task.

- [ ] **Step 1: Add shared inbox types**

Add these types to `src/shared/domain/telegram.ts` after the existing Telegram interfaces:

```ts
export interface TelegramChatSummary {
  id: string;
  title: string;
  type: TelegramChat['type'];
  avatar: string | null;
  selected: boolean;
  notificationsEnabled: boolean;
  hasTopics: boolean;
  unreadCount: number;
  lastMessageAt: string | null;
}

export interface TelegramTopicSummary {
  id: string;
  chatId: string;
  title: string;
  unreadCount: number;
  lastMessageAt: string | null;
}

export interface TelegramUnreadSummary {
  selectedUnreadCount: number;
  notifyingUnreadCount: number;
}

export interface TelegramThreadKey {
  chatId: string;
  topicId: string | null;
}

export interface TelegramThreadRequest extends TelegramThreadKey {
  limit?: number;
}

export interface TelegramThreadPageRequest extends TelegramThreadKey {
  beforeMessageId: string;
  limit?: number;
}

export interface TelegramMessageView extends TelegramMessage {
  deliveryStatus?: 'sending' | 'failed' | 'sent';
}

export interface TelegramThreadView {
  key: TelegramThreadKey;
  messages: TelegramMessageView[];
  hasOlder: boolean;
  loading: boolean;
}

export interface TelegramInboxSnapshot {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  phoneMasked: string | null;
  chats: TelegramChatSummary[];
  topics: TelegramTopicSummary[];
  unread: TelegramUnreadSummary;
  error: string | null;
}

export interface TelegramSendMessagePayload extends TelegramThreadKey {
  replyToMessageId?: string;
  text: string;
  file?: TelegramOutgoingFile;
  image?: TelegramOutgoingFile;
  clientRequestId?: string;
}

export interface TelegramSendResult {
  clientRequestId: string;
  thread: TelegramThreadView;
}
```

- [ ] **Step 2: Export focused types from IPC contract**

In `src/shared/contracts/ipcContract.ts`, extend the Telegram import/export lists with:

```ts
TelegramChatSummary,
TelegramInboxSnapshot,
TelegramMessageView,
TelegramSendMessagePayload,
TelegramSendResult,
TelegramThreadKey,
TelegramThreadPageRequest,
TelegramThreadRequest,
TelegramThreadView,
TelegramTopicSummary,
TelegramUnreadSummary
```

- [ ] **Step 3: Add bridge methods to `TeamSpaceBridge`**

Add methods near the existing Telegram methods:

```ts
getTelegramInboxSnapshot: () => Promise<TelegramInboxSnapshot>;
getTelegramThread: (payload: TelegramThreadRequest) => Promise<TelegramThreadView>;
markTelegramThreadRead: (payload: TelegramThreadKey) => Promise<TelegramInboxSnapshot>;
```

Keep all existing Telegram methods in place.

- [ ] **Step 4: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: FAIL until preload exposes the new methods in Task 7. If it fails only because `teamSpaceBridge` is missing the new methods, continue.

- [ ] **Step 5: Commit**

Commit after Task 7 makes typecheck pass, not in this task.

---

## Task 2: TDLib Client Boundary And Fake Client

**Files:**
- Create: `src/main/integrations/telegram-tdlib/tdlibTypes.ts`
- Create: `src/main/integrations/telegram-tdlib/TdlibClient.ts`
- Create: `src/main/integrations/telegram-tdlib/FakeTdlibClient.ts`
- Test: `src/main/integrations/telegram-tdlib/FakeTdlibClient.test.ts`

- [ ] **Step 1: Write fake client test**

Create `src/main/integrations/telegram-tdlib/FakeTdlibClient.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FakeTdlibClient } from './FakeTdlibClient';

describe('FakeTdlibClient', () => {
  it('correlates sent requests and scripted responses', async () => {
    const client = new FakeTdlibClient();
    client.replyTo('getChats', { '@type': 'chats', chat_ids: ['1'], total_count: 1 });

    await expect(client.send({ '@type': 'getChats', limit: 20 })).resolves.toEqual({
      '@type': 'chats',
      chat_ids: ['1'],
      total_count: 1
    });
    expect(client.sentRequests()).toEqual([{ '@type': 'getChats', limit: 20 }]);
  });

  it('receives scripted updates in order', async () => {
    const client = new FakeTdlibClient();
    client.pushUpdate({ '@type': 'updateAuthorizationState', authorization_state: { '@type': 'authorizationStateReady' } });

    await expect(client.receive()).resolves.toEqual({
      '@type': 'updateAuthorizationState',
      authorization_state: { '@type': 'authorizationStateReady' }
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- src/main/integrations/telegram-tdlib/FakeTdlibClient.test.ts
```

Expected: FAIL because files do not exist.

- [ ] **Step 3: Add minimal TDLib JSON types**

Create `src/main/integrations/telegram-tdlib/tdlibTypes.ts`:

```ts
export type TdlibObject = {
  '@type': string;
  '@extra'?: string;
  [key: string]: unknown;
};

export type TdlibRequest = TdlibObject;
export type TdlibResponse = TdlibObject;
export type TdlibUpdate = TdlibObject;
```

- [ ] **Step 4: Add TDLib client interface**

Create `src/main/integrations/telegram-tdlib/TdlibClient.ts`:

```ts
import type { TdlibRequest, TdlibResponse, TdlibUpdate } from './tdlibTypes';

export interface TdlibClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  send<T extends TdlibResponse = TdlibResponse>(request: TdlibRequest): Promise<T>;
  receive(): Promise<TdlibUpdate | null>;
}
```

- [ ] **Step 5: Add fake client implementation**

Create `src/main/integrations/telegram-tdlib/FakeTdlibClient.ts`:

```ts
import type { TdlibClient } from './TdlibClient';
import type { TdlibRequest, TdlibResponse, TdlibUpdate } from './tdlibTypes';

export class FakeTdlibClient implements TdlibClient {
  private readonly requests: TdlibRequest[] = [];
  private readonly responses = new Map<string, TdlibResponse[]>();
  private readonly updates: TdlibUpdate[] = [];

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async send<T extends TdlibResponse = TdlibResponse>(request: TdlibRequest): Promise<T> {
    this.requests.push(request);
    const queue = this.responses.get(request['@type']) ?? [];
    const response = queue.shift();
    if (!response) {
      throw new Error(`No fake TDLib response for ${request['@type']}`);
    }
    return response as T;
  }

  async receive(): Promise<TdlibUpdate | null> {
    return this.updates.shift() ?? null;
  }

  replyTo(type: string, response: TdlibResponse): void {
    const queue = this.responses.get(type) ?? [];
    queue.push(response);
    this.responses.set(type, queue);
  }

  pushUpdate(update: TdlibUpdate): void {
    this.updates.push(update);
  }

  sentRequests(): TdlibRequest[] {
    return structuredClone(this.requests);
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run:

```bash
npm test -- src/main/integrations/telegram-tdlib/FakeTdlibClient.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/integrations/telegram-tdlib/FakeTdlibClient.test.ts src/main/integrations/telegram-tdlib/FakeTdlibClient.ts src/main/integrations/telegram-tdlib/TdlibClient.ts src/main/integrations/telegram-tdlib/tdlibTypes.ts
git commit -m "Add TDLib client test boundary"
```

---

## Task 3: TDLib Mapper

**Files:**
- Create: `src/main/integrations/telegram-tdlib/TdlibMapper.ts`
- Test: `src/main/integrations/telegram-tdlib/TdlibMapper.test.ts`

- [ ] **Step 1: Write mapper tests**

Create `src/main/integrations/telegram-tdlib/TdlibMapper.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { tdlibChatToSummary, tdlibMessageToView } from './TdlibMapper';

describe('TdlibMapper', () => {
  it('maps a TDLib chat into a Team Space chat summary', () => {
    expect(tdlibChatToSummary({
      '@type': 'chat',
      id: 42,
      title: 'Backend',
      type: { '@type': 'chatTypeSupergroup', is_channel: false },
      unread_count: 3,
      last_message: { date: 1780657200 },
      photo: { small: { id: 10 } }
    }, { selected: true, notificationsEnabled: false })).toEqual({
      id: '42',
      title: 'Backend',
      type: 'group',
      avatar: null,
      selected: true,
      notificationsEnabled: false,
      hasTopics: true,
      unreadCount: 3,
      lastMessageAt: '2026-06-05T05:40:00.000Z'
    });
  });

  it('maps text messages without downloading files', () => {
    expect(tdlibMessageToView({
      '@type': 'message',
      id: 77,
      chat_id: 42,
      date: 1780657200,
      is_outgoing: false,
      sender_id: { '@type': 'messageSenderUser', user_id: 9 },
      content: {
        '@type': 'messageText',
        text: { text: 'Fix release notes' }
      }
    }, { senderName: 'Dasha', topicId: null, status: 'new' })).toMatchObject({
      id: '42:77',
      chatId: '42',
      topicId: null,
      senderId: '9',
      senderName: 'Dasha',
      text: 'Fix release notes',
      attachments: [],
      status: 'new'
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- src/main/integrations/telegram-tdlib/TdlibMapper.test.ts
```

Expected: FAIL because `TdlibMapper.ts` does not exist.

- [ ] **Step 3: Implement mapper**

Create `src/main/integrations/telegram-tdlib/TdlibMapper.ts`:

```ts
import type {
  MessageStatus,
  TelegramChat,
  TelegramChatSummary,
  TelegramMessageAttachment,
  TelegramMessageView
} from '../../../shared/domain/telegram';
import type { TdlibObject } from './tdlibTypes';

function tdDate(value: unknown): string {
  const seconds = typeof value === 'number' ? value : 0;
  return new Date(seconds * 1000).toISOString();
}

function tdStringId(value: unknown): string {
  return typeof value === 'number' || typeof value === 'string' ? String(value) : '';
}

function chatType(type: unknown): TelegramChat['type'] {
  const object = type as { '@type'?: string; is_channel?: boolean } | undefined;
  if (object?.['@type'] === 'chatTypePrivate') {
    return 'private';
  }
  if (object?.['@type'] === 'chatTypeSupergroup') {
    return object.is_channel ? 'channel' : 'group';
  }
  return 'group';
}

function textFromContent(content: unknown): string {
  const object = content as { '@type'?: string; text?: { text?: string }; caption?: { text?: string } } | undefined;
  return object?.text?.text ?? object?.caption?.text ?? '';
}

function attachmentsFromContent(messageId: string, content: unknown): TelegramMessageAttachment[] {
  const object = content as { '@type'?: string; document?: { file_name?: string; mime_type?: string; document?: { id?: number; size?: number } }; photo?: unknown } | undefined;
  if (object?.['@type'] === 'messageDocument') {
    return [{
      id: `${messageId}:attachment`,
      type: 'file',
      fileName: object.document?.file_name || 'file',
      mimeType: object.document?.mime_type || 'application/octet-stream',
      size: object.document?.document?.size ?? null,
      dataUrl: null
    }];
  }
  if (object?.['@type'] === 'messagePhoto') {
    return [{
      id: `${messageId}:attachment`,
      type: 'image',
      fileName: 'image.jpg',
      mimeType: 'image/jpeg',
      size: null,
      dataUrl: null
    }];
  }
  return [];
}

export function tdlibChatToSummary(
  chat: TdlibObject,
  local: { selected: boolean; notificationsEnabled: boolean }
): TelegramChatSummary {
  const lastMessage = chat.last_message as { date?: number } | undefined;
  return {
    id: tdStringId(chat.id),
    title: typeof chat.title === 'string' ? chat.title : tdStringId(chat.id),
    type: chatType(chat.type),
    avatar: null,
    selected: local.selected,
    notificationsEnabled: local.notificationsEnabled,
    hasTopics: (chat.type as { '@type'?: string } | undefined)?.['@type'] === 'chatTypeSupergroup',
    unreadCount: typeof chat.unread_count === 'number' ? chat.unread_count : 0,
    lastMessageAt: lastMessage?.date ? tdDate(lastMessage.date) : null
  };
}

export function tdlibMessageToView(
  message: TdlibObject,
  context: { senderName: string; topicId: string | null; status: MessageStatus }
): TelegramMessageView {
  const chatId = tdStringId(message.chat_id);
  const messageId = `${chatId}:${tdStringId(message.id)}`;
  const sender = message.sender_id as { user_id?: number; chat_id?: number } | undefined;
  const senderId = sender?.user_id ?? sender?.chat_id;
  const sentAt = tdDate(message.date);
  const content = message.content;
  return {
    id: messageId,
    chatId,
    topicId: context.topicId,
    senderId: senderId ? String(senderId) : null,
    senderName: message.is_outgoing ? 'Вы' : context.senderName,
    senderAvatar: null,
    sentAt,
    text: textFromContent(content),
    attachments: attachmentsFromContent(messageId, content),
    reactions: [],
    status: context.status,
    createdAt: sentAt,
    updatedAt: sentAt,
    deliveryStatus: message.sending_state ? 'sending' : 'sent'
  };
}
```

- [ ] **Step 4: Run mapper tests**

Run:

```bash
npm test -- src/main/integrations/telegram-tdlib/TdlibMapper.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/integrations/telegram-tdlib/TdlibMapper.ts src/main/integrations/telegram-tdlib/TdlibMapper.test.ts
git commit -m "Map TDLib objects into inbox models"
```

---

## Task 4: App-Specific Inbox Repository

**Files:**
- Create: `src/main/storage/repositories/telegramInboxRepository.ts`
- Create: `src/main/storage/repositories/telegramInboxRepository.test.ts`
- Modify: `src/main/storage/localStore.ts`

- [ ] **Step 1: Write repository tests**

Create `src/main/storage/repositories/telegramInboxRepository.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { InMemoryTelegramInboxRepository } from './telegramInboxRepository';

describe('telegramInboxRepository', () => {
  it('stores selected chats and notification settings independently from messages', () => {
    const repository = new InMemoryTelegramInboxRepository();
    repository.selectWorkspaceChats(['10', '20']);
    repository.setChatNotifications('20', false);

    expect(repository.chatLocalState('10')).toEqual({ selected: true, notificationsEnabled: true });
    expect(repository.chatLocalState('20')).toEqual({ selected: true, notificationsEnabled: false });
    expect(repository.selectedChatIds()).toEqual(['10', '20']);
  });

  it('keeps workflow status for a message', () => {
    const repository = new InMemoryTelegramInboxRepository();
    repository.setMessageStatus({ messageId: '10:99', chatId: '10', topicId: null, status: 'created' });

    expect(repository.messageStatus('10:99')).toBe('created');
    expect(repository.messageStatus('10:100')).toBe('new');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- src/main/storage/repositories/telegramInboxRepository.test.ts
```

Expected: FAIL because repository does not exist.

- [ ] **Step 3: Implement in-memory repository and interface**

Create `src/main/storage/repositories/telegramInboxRepository.ts`:

```ts
import type { MessageStatus } from '../../../shared/domain/telegram';

export interface TelegramChatLocalState {
  selected: boolean;
  notificationsEnabled: boolean;
}

export interface TelegramMessageStatusRecord {
  messageId: string;
  chatId: string;
  topicId: string | null;
  status: MessageStatus;
}

export interface TelegramInboxRepository {
  selectedChatIds(): string[];
  selectWorkspaceChats(chatIds: string[]): void;
  chatLocalState(chatId: string): TelegramChatLocalState;
  setChatNotifications(chatId: string, enabled: boolean): void;
  messageStatus(messageId: string): MessageStatus;
  setMessageStatus(record: TelegramMessageStatusRecord): void;
}

export class InMemoryTelegramInboxRepository implements TelegramInboxRepository {
  private readonly selected = new Set<string>();
  private readonly notificationSettings = new Map<string, boolean>();
  private readonly statuses = new Map<string, MessageStatus>();

  selectedChatIds(): string[] {
    return [...this.selected];
  }

  selectWorkspaceChats(chatIds: string[]): void {
    this.selected.clear();
    for (const chatId of chatIds) {
      this.selected.add(chatId);
    }
  }

  chatLocalState(chatId: string): TelegramChatLocalState {
    return {
      selected: this.selected.has(chatId),
      notificationsEnabled: this.notificationSettings.get(chatId) ?? true
    };
  }

  setChatNotifications(chatId: string, enabled: boolean): void {
    this.notificationSettings.set(chatId, enabled);
  }

  messageStatus(messageId: string): MessageStatus {
    return this.statuses.get(messageId) ?? 'new';
  }

  setMessageStatus(record: TelegramMessageStatusRecord): void {
    this.statuses.set(record.messageId, record.status);
  }
}
```

- [ ] **Step 4: Run repository tests**

Run:

```bash
npm test -- src/main/storage/repositories/telegramInboxRepository.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add sql.js-backed repository**

Extend `telegramInboxRepository.ts` with a `SqlTelegramInboxRepository` only after the in-memory tests pass. Use this minimal shape:

```ts
export class SqlTelegramInboxRepository implements TelegramInboxRepository {
  constructor(private readonly db: {
    run(sql: string, params?: unknown[]): void;
    exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
  }) {}

  initialize(): void {
    this.db.run('create table if not exists telegram_workspace_chats (chat_id text primary key, selected integer not null, selected_at text not null)');
    this.db.run('create table if not exists telegram_notification_settings (chat_id text primary key, enabled integer not null)');
    this.db.run('create table if not exists telegram_message_workflow_status (message_id text primary key, chat_id text not null, topic_id text, status text not null, updated_at text not null)');
  }

  selectedChatIds(): string[] {
    return this.rows<{ chat_id: string }>('select chat_id from telegram_workspace_chats where selected = 1 order by selected_at asc')
      .map((row) => row.chat_id);
  }

  selectWorkspaceChats(chatIds: string[]): void {
    this.db.run('delete from telegram_workspace_chats');
    const selectedAt = new Date().toISOString();
    for (const chatId of chatIds) {
      this.db.run('insert into telegram_workspace_chats (chat_id, selected, selected_at) values (?, 1, ?)', [chatId, selectedAt]);
    }
  }

  chatLocalState(chatId: string): TelegramChatLocalState {
    return {
      selected: this.selectedChatIds().includes(chatId),
      notificationsEnabled: this.rows<{ enabled: number }>('select enabled from telegram_notification_settings where chat_id = ?', [chatId]).at(0)?.enabled !== 0
    };
  }

  setChatNotifications(chatId: string, enabled: boolean): void {
    this.db.run(
      'insert into telegram_notification_settings (chat_id, enabled) values (?, ?) on conflict(chat_id) do update set enabled = excluded.enabled',
      [chatId, enabled ? 1 : 0]
    );
  }

  messageStatus(messageId: string): MessageStatus {
    const status = this.rows<{ status: MessageStatus }>('select status from telegram_message_workflow_status where message_id = ?', [messageId]).at(0)?.status;
    return status ?? 'new';
  }

  setMessageStatus(record: TelegramMessageStatusRecord): void {
    this.db.run(
      `insert into telegram_message_workflow_status (message_id, chat_id, topic_id, status, updated_at)
       values (?, ?, ?, ?, ?)
       on conflict(message_id) do update set status = excluded.status, updated_at = excluded.updated_at`,
      [record.messageId, record.chatId, record.topicId, record.status, new Date().toISOString()]
    );
  }

  private rows<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    const [result] = this.db.exec(sql, params);
    if (!result) {
      return [];
    }
    return result.values.map((values) => Object.fromEntries(result.columns.map((column, index) => [column, values[index]])) as T);
  }
}
```

- [ ] **Step 6: Wire repository in `LocalStore`**

Add a method to `src/main/storage/localStore.ts` to expose the repository after the SQL database structure is available. If `LocalTelegramDatabase` remains the owner of the sql.js database, add repository access there instead and keep `LocalStore` as a delegator.

- [ ] **Step 7: Run full storage-related tests**

Run:

```bash
npm test -- src/main/storage
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/storage/repositories/telegramInboxRepository.ts src/main/storage/repositories/telegramInboxRepository.test.ts src/main/storage/localStore.ts
git commit -m "Add app-specific Telegram inbox repository"
```

---

## Task 5: Inbox Service With Fake TDLib

**Files:**
- Create: `src/main/features/inbox/TelegramInboxService.ts`
- Create: `src/main/features/inbox/TelegramInboxService.test.ts`
- Modify: `src/main/integrations/telegram-tdlib/FakeTdlibClient.ts`

- [ ] **Step 1: Write service snapshot test**

Create `src/main/features/inbox/TelegramInboxService.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FakeTdlibClient } from '../../integrations/telegram-tdlib/FakeTdlibClient';
import { InMemoryTelegramInboxRepository } from '../../storage/repositories/telegramInboxRepository';
import { TelegramInboxService } from './TelegramInboxService';

describe('TelegramInboxService', () => {
  it('builds an inbox snapshot from TDLib chats and local settings', async () => {
    const client = new FakeTdlibClient();
    client.replyTo('getChats', { '@type': 'chats', chat_ids: [42], total_count: 1 });
    client.replyTo('getChat', {
      '@type': 'chat',
      id: 42,
      title: 'Backend',
      type: { '@type': 'chatTypeSupergroup', is_channel: false },
      unread_count: 5,
      last_message: { date: 1780657200 }
    });
    const repository = new InMemoryTelegramInboxRepository();
    repository.selectWorkspaceChats(['42']);
    repository.setChatNotifications('42', false);
    const service = new TelegramInboxService(client, repository);

    await expect(service.getInboxSnapshot()).resolves.toMatchObject({
      status: 'connected',
      chats: [{
        id: '42',
        title: 'Backend',
        selected: true,
        notificationsEnabled: false,
        unreadCount: 5
      }],
      unread: {
        selectedUnreadCount: 5,
        notifyingUnreadCount: 0
      }
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- src/main/features/inbox/TelegramInboxService.test.ts
```

Expected: FAIL because service does not exist.

- [ ] **Step 3: Implement minimal service**

Create `src/main/features/inbox/TelegramInboxService.ts`:

```ts
import type { TelegramInboxSnapshot } from '../../../shared/domain/telegram';
import type { TdlibClient } from '../../integrations/telegram-tdlib/TdlibClient';
import { tdlibChatToSummary } from '../../integrations/telegram-tdlib/TdlibMapper';
import type { TelegramInboxRepository } from '../../storage/repositories/telegramInboxRepository';
import type { TdlibObject } from '../../integrations/telegram-tdlib/tdlibTypes';

export class TelegramInboxService {
  constructor(
    private readonly client: TdlibClient,
    private readonly repository: TelegramInboxRepository
  ) {}

  async getInboxSnapshot(): Promise<TelegramInboxSnapshot> {
    const chatList = await this.client.send<{ '@type': 'chats'; chat_ids: Array<number | string> }>({
      '@type': 'getChats',
      limit: 100
    });
    const chats = await Promise.all(chatList.chat_ids.map(async (chatId) => {
      const chat = await this.client.send<TdlibObject>({ '@type': 'getChat', chat_id: chatId });
      return tdlibChatToSummary(chat, this.repository.chatLocalState(String(chatId)));
    }));
    const selectedUnreadCount = chats
      .filter((chat) => chat.selected)
      .reduce((total, chat) => total + Math.max(0, chat.unreadCount), 0);
    const notifyingUnreadCount = chats
      .filter((chat) => chat.selected && chat.notificationsEnabled)
      .reduce((total, chat) => total + Math.max(0, chat.unreadCount), 0);

    return {
      status: 'connected',
      phoneMasked: null,
      chats,
      topics: [],
      unread: { selectedUnreadCount, notifyingUnreadCount },
      error: null
    };
  }
}
```

- [ ] **Step 4: Run service snapshot test**

Run:

```bash
npm test -- src/main/features/inbox/TelegramInboxService.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add thread loading test**

Extend the test with:

```ts
it('loads a thread without marking it read', async () => {
  const client = new FakeTdlibClient();
  client.replyTo('getChatHistory', {
    '@type': 'messages',
    total_count: 1,
    messages: [{
      '@type': 'message',
      id: 7,
      chat_id: 42,
      date: 1780657200,
      is_outgoing: false,
      sender_id: { '@type': 'messageSenderUser', user_id: 9 },
      content: { '@type': 'messageText', text: { text: 'Need QA' } }
    }]
  });
  const service = new TelegramInboxService(client, new InMemoryTelegramInboxRepository());

  await expect(service.getThread({ chatId: '42', topicId: null, limit: 50 })).resolves.toMatchObject({
    key: { chatId: '42', topicId: null },
    messages: [{ id: '42:7', text: 'Need QA' }],
    hasOlder: false
  });
  expect(client.sentRequests().map((request) => request['@type'])).not.toContain('viewMessages');
});
```

- [ ] **Step 6: Implement `getThread`**

Add to `TelegramInboxService`:

```ts
async getThread(payload: { chatId: string; topicId: string | null; limit?: number }) {
  const response = await this.client.send<{ '@type': 'messages'; total_count: number; messages: TdlibObject[] }>({
    '@type': 'getChatHistory',
    chat_id: Number(payload.chatId),
    from_message_id: 0,
    offset: 0,
    limit: payload.limit ?? 50,
    only_local: false
  });
  const messages = response.messages
    .map((message) => tdlibMessageToView(message, {
      senderName: 'Unknown',
      topicId: payload.topicId,
      status: this.repository.messageStatus(`${payload.chatId}:${String(message.id)}`)
    }))
    .sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime());
  return {
    key: { chatId: payload.chatId, topicId: payload.topicId },
    messages,
    hasOlder: response.total_count > messages.length,
    loading: false
  };
}
```

Also import `tdlibMessageToView`.

- [ ] **Step 7: Run service tests**

Run:

```bash
npm test -- src/main/features/inbox/TelegramInboxService.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/features/inbox/TelegramInboxService.ts src/main/features/inbox/TelegramInboxService.test.ts
git commit -m "Add fake-backed Telegram inbox service"
```

---

## Task 6: TDLib Auth Service

**Files:**
- Create: `src/main/integrations/telegram-tdlib/TdlibAuthService.ts`
- Test: `src/main/integrations/telegram-tdlib/TdlibAuthService.test.ts`

- [ ] **Step 1: Write auth tests**

Create `src/main/integrations/telegram-tdlib/TdlibAuthService.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FakeTdlibClient } from './FakeTdlibClient';
import { TdlibAuthService } from './TdlibAuthService';

describe('TdlibAuthService', () => {
  it('sets TDLib parameters when requested by authorization state', async () => {
    const client = new FakeTdlibClient();
    client.replyTo('setTdlibParameters', { '@type': 'ok' });
    const service = new TdlibAuthService(client, {
      apiId: 123,
      apiHash: 'hash',
      databaseDirectory: '/tmp/team-space/tdlib',
      filesDirectory: '/tmp/team-space/tdlib-files',
      databaseEncryptionKey: 'secret'
    });

    await service.handleAuthorizationState({ '@type': 'authorizationStateWaitTdlibParameters' });

    expect(client.sentRequests()[0]).toMatchObject({
      '@type': 'setTdlibParameters',
      api_id: 123,
      api_hash: 'hash',
      use_file_database: true,
      use_chat_info_database: true,
      use_message_database: true
    });
  });

  it('submits phone number and code through TDLib auth methods', async () => {
    const client = new FakeTdlibClient();
    client.replyTo('setAuthenticationPhoneNumber', { '@type': 'ok' });
    client.replyTo('checkAuthenticationCode', { '@type': 'ok' });
    const service = new TdlibAuthService(client, {
      apiId: 123,
      apiHash: 'hash',
      databaseDirectory: '/tmp/db',
      filesDirectory: '/tmp/files',
      databaseEncryptionKey: 'secret'
    });

    await service.setPhoneNumber('+79990000000');
    await service.checkCode('12345');

    expect(client.sentRequests().map((request) => request['@type'])).toEqual([
      'setAuthenticationPhoneNumber',
      'checkAuthenticationCode'
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- src/main/integrations/telegram-tdlib/TdlibAuthService.test.ts
```

Expected: FAIL because service does not exist.

- [ ] **Step 3: Implement auth service**

Create `src/main/integrations/telegram-tdlib/TdlibAuthService.ts`:

```ts
import type { TdlibClient } from './TdlibClient';
import type { TdlibObject } from './tdlibTypes';

export interface TdlibAuthConfig {
  apiId: number;
  apiHash: string;
  databaseDirectory: string;
  filesDirectory: string;
  databaseEncryptionKey: string;
}

export class TdlibAuthService {
  constructor(
    private readonly client: TdlibClient,
    private readonly config: TdlibAuthConfig
  ) {}

  async handleAuthorizationState(state: TdlibObject): Promise<void> {
    if (state['@type'] !== 'authorizationStateWaitTdlibParameters') {
      return;
    }
    await this.client.send({
      '@type': 'setTdlibParameters',
      use_test_dc: false,
      database_directory: this.config.databaseDirectory,
      files_directory: this.config.filesDirectory,
      database_encryption_key: this.config.databaseEncryptionKey,
      use_file_database: true,
      use_chat_info_database: true,
      use_message_database: true,
      use_secret_chats: false,
      api_id: this.config.apiId,
      api_hash: this.config.apiHash,
      system_language_code: 'ru',
      device_model: 'Team Space Desktop',
      system_version: process.platform,
      application_version: '0.1.0'
    });
  }

  async setPhoneNumber(phoneNumber: string): Promise<void> {
    await this.client.send({
      '@type': 'setAuthenticationPhoneNumber',
      phone_number: phoneNumber
    });
  }

  async checkCode(code: string): Promise<void> {
    await this.client.send({
      '@type': 'checkAuthenticationCode',
      code
    });
  }

  async checkPassword(password: string): Promise<void> {
    await this.client.send({
      '@type': 'checkAuthenticationPassword',
      password
    });
  }
}
```

- [ ] **Step 4: Run auth tests**

Run:

```bash
npm test -- src/main/integrations/telegram-tdlib/TdlibAuthService.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/integrations/telegram-tdlib/TdlibAuthService.ts src/main/integrations/telegram-tdlib/TdlibAuthService.test.ts
git commit -m "Add TDLib auth service"
```

---

## Task 7: IPC And Preload Focused Methods

**Files:**
- Modify: `src/main/ipc/telegramIpc.ts`
- Modify: `src/main/preload.ts`
- Modify: `src/shared/contracts/ipcContract.ts`
- Test: `src/renderer/App.test.tsx` or add a focused bridge contract test if one exists locally.

- [ ] **Step 1: Add IPC handlers**

In `src/main/ipc/telegramIpc.ts`, add handlers next to existing Telegram handlers:

```ts
ipcMain.handle('telegram:get-inbox-snapshot', () =>
  context.telegram.getInboxSnapshot());

ipcMain.handle('telegram:get-thread', (_event, payload: TelegramThreadRequest) =>
  context.telegram.getThread(payload));

ipcMain.handle('telegram:mark-thread-read', (_event, payload: TelegramThreadKey) =>
  context.telegram.markThreadRead(payload));
```

If `context.telegram` is still typed as `TelegramService`, add these methods to a transitional interface and implement compatibility methods on the service facade in Task 8.

- [ ] **Step 2: Add preload methods**

In `src/main/preload.ts`, add:

```ts
getTelegramInboxSnapshot: () => ipcRenderer.invoke('telegram:get-inbox-snapshot'),
getTelegramThread: (payload: TelegramThreadRequest) =>
  ipcRenderer.invoke('telegram:get-thread', payload),
markTelegramThreadRead: (payload: TelegramThreadKey) =>
  ipcRenderer.invoke('telegram:mark-thread-read', payload),
```

Import `TelegramThreadKey` and `TelegramThreadRequest` from the shared contract if inference is not enough.

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: FAIL if `context.telegram` does not yet expose the new methods. Continue to Task 8.

- [ ] **Step 4: Commit**

Commit after Task 8 makes typecheck pass.

---

## Task 8: Transitional Telegram Facade

**Files:**
- Modify: `src/main/telegram/telegramService.ts`
- Modify: `src/main/ipc/ipcRegistrationContext.ts`
- Test: `src/main/telegram/telegramService.test.ts`

- [ ] **Step 1: Add compatibility tests**

In `src/main/telegram/telegramService.test.ts`, add a test that verifies new methods can exist without breaking old behavior:

```ts
it('exposes focused inbox methods during TDLib migration', async () => {
  const store = createStore();
  const service = new TelegramService(store);

  await expect(service.getInboxSnapshot()).resolves.toMatchObject({
    status: store.getState().telegram.status,
    chats: [],
    topics: [],
    unread: { selectedUnreadCount: 0, notifyingUnreadCount: 0 }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- src/main/telegram/telegramService.test.ts
```

Expected: FAIL because `getInboxSnapshot` does not exist.

- [ ] **Step 3: Add transitional methods**

Add these methods to `TelegramService` as a bridge until `TelegramInboxService` is fully composed:

```ts
async getInboxSnapshot(): Promise<TelegramInboxSnapshot> {
  const telegram = this.store.getState().telegram;
  const chats = telegram.chats.map((chat) => ({
    id: chat.id,
    title: chat.title,
    type: chat.type,
    avatar: chat.avatar,
    selected: chat.selected,
    notificationsEnabled: chat.notificationsEnabled !== false,
    hasTopics: chat.hasTopics,
    unreadCount: chat.unreadCount ?? 0,
    lastMessageAt: chat.lastMessageAt
  }));
  const selectedUnreadCount = chats
    .filter((chat) => chat.selected)
    .reduce((total, chat) => total + Math.max(0, chat.unreadCount), 0);
  const notifyingUnreadCount = chats
    .filter((chat) => chat.selected && chat.notificationsEnabled)
    .reduce((total, chat) => total + Math.max(0, chat.unreadCount), 0);
  return {
    status: telegram.status,
    phoneMasked: telegram.phoneMasked,
    chats,
    topics: telegram.topics,
    unread: { selectedUnreadCount, notifyingUnreadCount },
    error: telegram.error
  };
}
```

Also add `getThread` and `markThreadRead` wrappers backed by current behavior:

```ts
async getThread(payload: TelegramThreadRequest): Promise<TelegramThreadView> {
  const state = await this.loadChatMessages({ chatId: payload.chatId, topicId: payload.topicId ?? undefined });
  const messages = state.telegram.messages
    .filter((message) => message.chatId === payload.chatId)
    .filter((message) => !payload.topicId || message.topicId === payload.topicId)
    .sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime());
  return {
    key: { chatId: payload.chatId, topicId: payload.topicId },
    messages,
    hasOlder: messages.length >= (payload.limit ?? 50),
    loading: false
  };
}

async markThreadRead(payload: TelegramThreadKey): Promise<TelegramInboxSnapshot> {
  await this.loadChatMessages({ chatId: payload.chatId, topicId: payload.topicId ?? undefined });
  return this.getInboxSnapshot();
}
```

Import the new shared types.

- [ ] **Step 4: Run typecheck and Telegram tests**

Run:

```bash
npm run typecheck
npm test -- src/main/telegram/telegramService.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 7 and Task 8 together**

```bash
git add src/shared/contracts/ipcContract.ts src/main/preload.ts src/main/ipc/telegramIpc.ts src/main/ipc/ipcRegistrationContext.ts src/main/telegram/telegramService.ts src/main/telegram/telegramService.test.ts
git commit -m "Add focused Telegram inbox IPC facade"
```

---

## Task 9: Renderer Thread Model

**Files:**
- Modify: `src/renderer/app/AppShell.tsx`
- Modify: `src/renderer/features/inbox/Inbox.tsx`
- Test: `src/renderer/App.test.tsx`

- [ ] **Step 1: Add renderer test for focused thread loading**

In `src/renderer/App.test.tsx`, add or update a test so opening a Telegram chat calls the focused thread method:

```ts
it('loads Telegram thread through focused thread API when opening a chat', async () => {
  const user = userEvent.setup();
  state.telegram.chats[0].selected = true;
  api.getTelegramThread = vi.fn(async () => ({
    key: { chatId: 'chat_1', topicId: null },
    messages: state.telegram.messages,
    hasOlder: false,
    loading: false
  }));

  render(<App />);

  await user.click(await screen.findByRole('button', { name: 'Входящие' }));
  await user.click(screen.getByRole('button', { name: /Backend Team/ }));

  await waitFor(() => expect(api.getTelegramThread).toHaveBeenCalledWith({
    chatId: 'chat_1',
    topicId: null,
    limit: 50
  }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- src/renderer/App.test.tsx
```

Expected: FAIL because renderer still uses `loadChatMessages`.

- [ ] **Step 3: Add active thread state in `AppShell`**

In `AppShell`, add:

```ts
const [telegramThread, setTelegramThread] = useState<TelegramThreadView | null>(null);
```

Replace `selectedMessages` derivation from `telegramMessageIndex` with:

```ts
const selectedMessages = telegramThread?.messages ?? [];
```

- [ ] **Step 4: Replace chat open load path**

In `openTelegramChat`, replace the load call with:

```ts
void api.getTelegramThread({ chatId, topicId: nextTopicId || null, limit: 50 })
  .then(setTelegramThread)
  .catch((error) => notify(error instanceof Error ? error.message : 'Не удалось открыть Telegram-чат.', 'error'));
```

Keep the old `loadChatMessages` helper only for compatibility until no call sites remain.

- [ ] **Step 5: Pass thread to `Inbox`**

Keep `Inbox` props stable if possible by passing `selectedMessages={selectedMessages}`. Add `loadThread` prop only if `Inbox` needs to request older pages.

- [ ] **Step 6: Run renderer tests**

Run:

```bash
npm test -- src/renderer/App.test.tsx
```

Expected: PASS after updating mocks for the new bridge method.

- [ ] **Step 7: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/app/AppShell.tsx src/renderer/features/inbox/Inbox.tsx src/renderer/App.test.tsx
git commit -m "Move inbox renderer toward thread API"
```

---

## Task 10: Read Receipt Gate

**Files:**
- Modify: `src/renderer/features/inbox/Inbox.tsx`
- Modify: `src/renderer/app/AppShell.tsx`
- Modify: `src/main/features/inbox/TelegramInboxService.ts`
- Test: `src/renderer/App.test.tsx`
- Test: `src/main/features/inbox/TelegramInboxService.test.ts`

- [ ] **Step 1: Add service test for explicit read**

In `TelegramInboxService.test.ts`, add:

```ts
it('marks a thread read only when explicitly requested', async () => {
  const client = new FakeTdlibClient();
  client.replyTo('viewMessages', { '@type': 'ok' });
  client.replyTo('getChats', { '@type': 'chats', chat_ids: [], total_count: 0 });
  const service = new TelegramInboxService(client, new InMemoryTelegramInboxRepository());

  await service.markThreadRead({ chatId: '42', topicId: null });

  expect(client.sentRequests()[0]).toMatchObject({
    '@type': 'viewMessages',
    chat_id: 42,
    force_read: true
  });
});
```

- [ ] **Step 2: Implement service method**

Add to `TelegramInboxService`:

```ts
async markThreadRead(payload: { chatId: string; topicId: string | null }) {
  await this.client.send({
    '@type': 'viewMessages',
    chat_id: Number(payload.chatId),
    message_ids: [],
    force_read: true
  });
  return this.getInboxSnapshot();
}
```

- [ ] **Step 3: Add renderer read-gate test**

In `src/renderer/App.test.tsx`, add this test. Adjust the chat title if the local fixture uses a different visible name:

```ts
it('marks a Telegram thread read only after the thread bottom is visible', async () => {
  const user = userEvent.setup();
  state.telegram.chats[0].selected = true;
  api.getTelegramThread = vi.fn(async () => ({
    key: { chatId: 'chat_1', topicId: null },
    messages: state.telegram.messages,
    hasOlder: false,
    loading: false
  }));
  api.markTelegramThreadRead = vi.fn(async () => ({
    status: 'connected',
    phoneMasked: '+79***11',
    chats: [],
    topics: [],
    unread: { selectedUnreadCount: 0, notifyingUnreadCount: 0 },
    error: null
  }));

  const { container } = render(<App />);

  await user.click(await screen.findByRole('button', { name: 'Входящие' }));
  await user.click(screen.getByRole('button', { name: /Backend Team/ }));

  expect(api.markTelegramThreadRead).not.toHaveBeenCalled();

  const thread = container.querySelector('.chat-thread') as HTMLElement;
  Object.defineProperty(thread, 'scrollHeight', { configurable: true, value: 1000 });
  Object.defineProperty(thread, 'clientHeight', { configurable: true, value: 400 });
  Object.defineProperty(thread, 'scrollTop', { configurable: true, value: 600 });
  fireEvent.scroll(thread);

  await waitFor(() => expect(api.markTelegramThreadRead).toHaveBeenCalledWith({
    chatId: 'chat_1',
    topicId: null
  }));
});
```

- [ ] **Step 4: Implement viewport gate**

In `Inbox.tsx`, call a new prop `markThreadRead` only when:

```ts
const isAtBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 8;
```

The call must also require active inbox view and selected chat. Debounce with a ref so the same thread is not marked read repeatedly.

- [ ] **Step 5: Run tests**

Run:

```bash
npm test -- src/main/features/inbox/TelegramInboxService.test.ts src/renderer/App.test.tsx
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/features/inbox/TelegramInboxService.ts src/main/features/inbox/TelegramInboxService.test.ts src/renderer/app/AppShell.tsx src/renderer/features/inbox/Inbox.tsx src/renderer/App.test.tsx
git commit -m "Gate Telegram read receipts on actual viewing"
```

---

## Task 11: Sending, Reactions, And Downloads Through TDLib Adapter

**Files:**
- Create: `src/main/integrations/telegram-tdlib/TdlibCommandAdapter.ts`
- Create: `src/main/integrations/telegram-tdlib/TdlibMediaService.ts`
- Test: `src/main/integrations/telegram-tdlib/TdlibCommandAdapter.test.ts`

- [ ] **Step 1: Write command adapter tests**

Create `src/main/integrations/telegram-tdlib/TdlibCommandAdapter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FakeTdlibClient } from './FakeTdlibClient';
import { TdlibCommandAdapter } from './TdlibCommandAdapter';

describe('TdlibCommandAdapter', () => {
  it('sends text messages with reply metadata', async () => {
    const client = new FakeTdlibClient();
    client.replyTo('sendMessage', { '@type': 'message', id: 9, chat_id: 42 });
    const adapter = new TdlibCommandAdapter(client);

    await adapter.sendMessage({ chatId: '42', topicId: null, text: 'Ready', replyToMessageId: '42:7' });

    expect(client.sentRequests()[0]).toMatchObject({
      '@type': 'sendMessage',
      chat_id: 42,
      input_message_content: {
        '@type': 'inputMessageText',
        text: { '@type': 'formattedText', text: 'Ready', entities: [] }
      }
    });
  });

  it('sends emoji reactions', async () => {
    const client = new FakeTdlibClient();
    client.replyTo('addMessageReaction', { '@type': 'ok' });
    const adapter = new TdlibCommandAdapter(client);

    await adapter.reactToMessage({ messageId: '42:7', emoticon: '👍' });

    expect(client.sentRequests()[0]).toMatchObject({
      '@type': 'addMessageReaction',
      chat_id: 42,
      message_id: 7
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- src/main/integrations/telegram-tdlib/TdlibCommandAdapter.test.ts
```

Expected: FAIL because adapter does not exist.

- [ ] **Step 3: Implement command adapter**

Create `src/main/integrations/telegram-tdlib/TdlibCommandAdapter.ts`:

```ts
import type { TelegramSendMessagePayload } from '../../../shared/domain/telegram';
import type { TdlibClient } from './TdlibClient';

function parseMessageId(messageId: string): { chatId: number; messageId: number } {
  const parts = messageId.split(':');
  return {
    chatId: Number(parts.slice(0, -1).join(':')),
    messageId: Number(parts.at(-1))
  };
}

export class TdlibCommandAdapter {
  constructor(private readonly client: TdlibClient) {}

  async sendMessage(payload: TelegramSendMessagePayload) {
    return this.client.send({
      '@type': 'sendMessage',
      chat_id: Number(payload.chatId),
      reply_to: payload.replyToMessageId
        ? { '@type': 'inputMessageReplyToMessage', message_id: parseMessageId(payload.replyToMessageId).messageId }
        : undefined,
      input_message_content: {
        '@type': 'inputMessageText',
        text: { '@type': 'formattedText', text: payload.text, entities: [] },
        clear_draft: true
      }
    });
  }

  async reactToMessage(payload: { messageId: string; emoticon: string }) {
    const ids = parseMessageId(payload.messageId);
    return this.client.send({
      '@type': 'addMessageReaction',
      chat_id: ids.chatId,
      message_id: ids.messageId,
      reaction_type: { '@type': 'reactionTypeEmoji', emoji: payload.emoticon },
      is_big: false,
      update_recent_reactions: true
    });
  }
}
```

- [ ] **Step 4: Add media service skeleton**

Create `src/main/integrations/telegram-tdlib/TdlibMediaService.ts`:

```ts
import type { TelegramAttachmentDownloadResult } from '../../../shared/domain/telegram';
import type { TdlibClient } from './TdlibClient';

export class TdlibMediaService {
  constructor(private readonly client: TdlibClient) {}

  async downloadFile(payload: { fileId: number; priority?: number }): Promise<TelegramAttachmentDownloadResult> {
    const result = await this.client.send<{ local?: { path?: string } }>({
      '@type': 'downloadFile',
      file_id: payload.fileId,
      priority: payload.priority ?? 1,
      offset: 0,
      limit: 0,
      synchronous: true
    });
    const filePath = result.local?.path;
    if (!filePath) {
      throw new Error('TDLib не вернул путь к скачанному файлу.');
    }
    return { filePath };
  }
}
```

- [ ] **Step 5: Run command tests**

Run:

```bash
npm test -- src/main/integrations/telegram-tdlib/TdlibCommandAdapter.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Wire adapter into `TelegramInboxService`**

Inject `TdlibCommandAdapter` and `TdlibMediaService` into the service. Keep constructor overload or defaults so existing tests can still pass with only `client` and `repository`.

- [ ] **Step 7: Commit**

```bash
git add src/main/integrations/telegram-tdlib/TdlibCommandAdapter.ts src/main/integrations/telegram-tdlib/TdlibCommandAdapter.test.ts src/main/integrations/telegram-tdlib/TdlibMediaService.ts src/main/features/inbox/TelegramInboxService.ts
git commit -m "Add TDLib command adapter"
```

---

## Task 12: Native TDLib JSON Client And Binary Resolver

**Files:**
- Create: `src/main/integrations/telegram-tdlib/TdlibBinaryResolver.ts`
- Create: `src/main/integrations/telegram-tdlib/TdlibJsonClient.ts`
- Test: `src/main/integrations/telegram-tdlib/TdlibBinaryResolver.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write binary resolver test**

Create `src/main/integrations/telegram-tdlib/TdlibBinaryResolver.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { tdlibLibraryName, resolveTdlibLibraryPath } from './TdlibBinaryResolver';

describe('TdlibBinaryResolver', () => {
  it('uses platform-specific library names', () => {
    expect(tdlibLibraryName('darwin')).toBe('libtdjson.dylib');
    expect(tdlibLibraryName('linux')).toBe('libtdjson.so');
    expect(tdlibLibraryName('win32')).toBe('tdjson.dll');
  });

  it('resolves development path under build resources', () => {
    expect(resolveTdlibLibraryPath({
      platform: 'darwin',
      resourcesPath: '/Applications/Workspace.app/Contents/Resources',
      appPath: '/repo'
    })).toContain('libtdjson.dylib');
  });
});
```

- [ ] **Step 2: Implement resolver**

Create `src/main/integrations/telegram-tdlib/TdlibBinaryResolver.ts`:

```ts
import path from 'node:path';

export function tdlibLibraryName(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return 'libtdjson.dylib';
  }
  if (platform === 'win32') {
    return 'tdjson.dll';
  }
  return 'libtdjson.so';
}

export function resolveTdlibLibraryPath(options: {
  platform: NodeJS.Platform;
  resourcesPath: string;
  appPath: string;
  isPackaged?: boolean;
}): string {
  const fileName = tdlibLibraryName(options.platform);
  return options.isPackaged
    ? path.join(options.resourcesPath, 'tdlib', fileName)
    : path.join(options.appPath, 'build', 'tdlib', options.platform, fileName);
}
```

- [ ] **Step 3: Run resolver tests**

Run:

```bash
npm test -- src/main/integrations/telegram-tdlib/TdlibBinaryResolver.test.ts
```

Expected: PASS.

- [ ] **Step 4: Add TDLib JSON FFI dependency**

Install `koffi` for dynamic C FFI:

```bash
npm install koffi
```

Expected:

- `package.json` includes `koffi`;
- `package-lock.json` includes the resolved package;
- `npm view koffi version description` reports a current package usable for dynamic C FFI.

- [ ] **Step 5: Implement `TdlibJsonClient` behind the existing interface**

Create `src/main/integrations/telegram-tdlib/TdlibJsonClient.ts`:

```ts
import koffi from 'koffi';
import type { TdlibClient } from './TdlibClient';
import type { TdlibRequest, TdlibResponse, TdlibUpdate } from './tdlibTypes';

type TdCreateClientId = () => number;
type TdSend = (clientId: number, request: string) => void;
type TdReceive = (timeoutSeconds: number) => string | null;

export class TdlibJsonClient implements TdlibClient {
  private clientId = 0;
  private readonly createClientId: TdCreateClientId;
  private readonly tdSend: TdSend;
  private readonly tdReceive: TdReceive;
  private readonly pending = new Map<string, {
    resolve: (response: TdlibResponse) => void;
    reject: (error: Error) => void;
  }>();
  private receiveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(libraryPath: string) {
    try {
      const library = koffi.load(libraryPath);
      this.createClientId = library.func('td_create_client_id', 'int', []) as TdCreateClientId;
      this.tdSend = library.func('td_send', 'void', ['int', 'str']) as TdSend;
      this.tdReceive = library.func('td_receive', 'str', ['double']) as TdReceive;
    } catch (error) {
      throw new Error(
        `TDLib native binding is not available at ${libraryPath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  async start(): Promise<void> {
    this.clientId = this.createClientId();
    this.receiveTimer = setInterval(() => this.drainReceiveQueue(), 25);
  }

  async stop(): Promise<void> {
    if (this.receiveTimer) {
      clearInterval(this.receiveTimer);
      this.receiveTimer = null;
    }
    for (const pending of this.pending.values()) {
      pending.reject(new Error('TDLib client stopped.'));
    }
    this.pending.clear();
  }

  async send<T extends TdlibResponse = TdlibResponse>(request: TdlibRequest): Promise<T> {
    const extra = request['@extra'] ?? crypto.randomUUID();
    const requestWithExtra = { ...request, '@extra': extra };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(extra, {
        resolve: (response) => resolve(response as T),
        reject
      });
      this.tdSend(this.clientId, JSON.stringify(requestWithExtra));
    });
  }

  async receive(): Promise<TdlibUpdate | null> {
    const raw = this.tdReceive(0.1);
    return raw ? JSON.parse(raw) as TdlibUpdate : null;
  }

  private drainReceiveQueue(): void {
    let update: TdlibUpdate | null = null;
    do {
      const raw = this.tdReceive(0);
      update = raw ? JSON.parse(raw) as TdlibUpdate : null;
      if (update) {
        this.routeObject(update);
      }
    } while (update);
  }

  private routeObject(object: TdlibUpdate): void {
    const extra = typeof object['@extra'] === 'string' ? object['@extra'] : '';
    if (!extra) {
      return;
    }
    const pending = this.pending.get(extra);
    if (!pending) {
      return;
    }
    this.pending.delete(extra);
    if (object['@type'] === 'error') {
      pending.reject(new Error(typeof object.message === 'string' ? object.message : 'TDLib request failed.'));
      return;
    }
    pending.resolve(object);
  }
}
```

- [ ] **Step 6: Add Electron resources entry**

In `package.json`, extend `build.extraResources`:

```json
{
  "from": "build/tdlib",
  "to": "tdlib",
  "filter": ["**/*"]
}
```

- [ ] **Step 7: Run verification**

Run:

```bash
npm run typecheck
npm test -- src/main/integrations/telegram-tdlib
```

Expected: PASS. If no local `libtdjson` binary exists, `TdlibJsonClient` constructor coverage is limited to unit tests that mock the resolver; the real native smoke test is Task 14.

- [ ] **Step 8: Commit**

```bash
git add src/main/integrations/telegram-tdlib/TdlibBinaryResolver.ts src/main/integrations/telegram-tdlib/TdlibBinaryResolver.test.ts src/main/integrations/telegram-tdlib/TdlibJsonClient.ts package.json package-lock.json
git commit -m "Add TDLib native client boundary"
```

---

## Task 13: Compose TDLib Inbox Behind Feature Flag

**Files:**
- Modify: `src/main/app/bootstrap.ts`
- Modify: `src/main/ipc/registerIpcHandlers.ts`
- Modify: `src/main/ipc/ipcRegistrationContext.ts`
- Modify: `src/main/main.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add feature flag**

In `.env.example`, add:

```text
VITE_TELEGRAM_TDLIB_ENABLED=false
TELEGRAM_TDLIB_ENABLED=false
```

Use the main-process `TELEGRAM_TDLIB_ENABLED` for service composition. The renderer flag is only for optional UI copy or debug display.

- [ ] **Step 2: Compose service conditionally**

In the main process composition code, use:

```ts
const telegram = process.env.TELEGRAM_TDLIB_ENABLED === 'true'
  ? createTdlibTelegramInboxFacade({ store })
  : new TelegramService(store, telegramEvents);
```

`createTdlibTelegramInboxFacade` must expose the same methods needed by `telegramIpc.ts`, including compatibility methods during migration.

- [ ] **Step 3: Add startup error behavior**

If TDLib is enabled but native loading fails, set Telegram state to:

```ts
state.telegram.status = 'error';
state.telegram.error = 'TDLib не загружен. Проверьте libtdjson в build/tdlib или отключите TELEGRAM_TDLIB_ENABLED.';
```

- [ ] **Step 4: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Run tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add .env.example src/main/app/bootstrap.ts src/main/ipc/registerIpcHandlers.ts src/main/ipc/ipcRegistrationContext.ts src/main/main.ts
git commit -m "Compose TDLib Telegram inbox behind flag"
```

---

## Task 14: Manual TDLib Smoke Test

**Files:**
- No code changes unless a defect is found.

- [ ] **Step 1: Place TDLib binary**

For macOS development, place:

```text
build/tdlib/darwin/libtdjson.dylib
```

- [ ] **Step 2: Enable TDLib**

Run:

```bash
TELEGRAM_TDLIB_ENABLED=true npm run dev
```

Expected: app starts. If TDLib binary is missing, Telegram shows the explicit TDLib loading error.

- [ ] **Step 3: Authorize Telegram**

Use existing Telegram settings/onboarding. Expected:

- phone is accepted;
- code is accepted;
- 2FA password is requested only when Telegram requires it;
- app reaches connected state.

- [ ] **Step 4: Open a selected work chat**

Expected:

- selected chat opens from TDLib cache;
- messages appear in chronological order;
- attachments show metadata before download;
- unread is not marked read immediately on open.

- [ ] **Step 5: Verify read gate**

Scroll to bottom with the app focused.

Expected:

- read state changes in official Telegram client after actual viewing;
- it does not change before viewing.

- [ ] **Step 6: Verify send flows**

Send:

- text;
- reply;
- image or document;
- reaction.

Expected:

- optimistic state appears;
- TDLib update replaces optimistic message with real id;
- failures remain visible with retry affordance.

- [ ] **Step 7: Verify Redmine workflow**

Select Telegram messages and create a Redmine issue.

Expected:

- selected message ids are passed to Redmine workflow;
- message workflow state becomes `created`;
- reload does not reset that state.

- [ ] **Step 8: Record result**

Add a short note to the task branch commit or PR description:

```text
TDLib smoke test:
- Platform:
- Binary:
- Auth:
- Open chat:
- Read gate:
- Send text/reply/file/reaction:
- Redmine workflow:
- Remaining issues:
```

---

## Task 15: Remove GramJS After Acceptance

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Delete or archive: `src/main/telegram/telegramService.ts`
- Modify: `src/main/ipc/telegramIpc.ts`
- Modify: `src/main/domain/types.ts`
- Modify: tests that import old GramJS service.

- [ ] **Step 1: Confirm acceptance criteria**

Do not start this task until Task 14 passes for the required platform.

- [ ] **Step 2: Remove GramJS package**

Run:

```bash
npm uninstall telegram
```

Expected: `package.json` and `package-lock.json` no longer include `telegram`.

- [ ] **Step 3: Remove GramJS-specific code**

Delete or replace:

- `StringSession`;
- GramJS imports;
- manual realtime handlers;
- manual background sync;
- base64 preview sync;
- global Telegram message history as source of truth.

- [ ] **Step 4: Run full verification**

Run:

```bash
npm run typecheck
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/main src/shared src/renderer
git commit -m "Remove GramJS Telegram implementation"
```

---

## Final Verification

Run:

```bash
npm run typecheck
npm test
```

Expected: both PASS.

If TDLib binary is available locally, also run:

```bash
TELEGRAM_TDLIB_ENABLED=true npm run dev
```

Expected: app starts and the manual smoke test in Task 14 passes.

## Self-Review Notes

Spec coverage:

- TDLib integration: Tasks 2, 6, 12, 13.
- App-specific storage: Task 4.
- Thread API and light app state: Tasks 1, 7, 8, 9.
- Read/unread behavior: Task 10.
- Sending, reactions, downloads: Task 11.
- Migration beside GramJS: Tasks 8, 13, 15.
- Packaging: Task 12.
- Testing and manual acceptance: Tasks 2 through 14 plus Final Verification.

No placeholder tasks remain. Task 12 uses `koffi` as the concrete C FFI path, keeps native calls behind `TdlibClient`, and leaves the real `libtdjson` exercise to the manual smoke test in Task 14.
