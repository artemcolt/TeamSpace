# Telegram TDLib Inbox Design

Date: 2026-06-05

## Goal

Replace the fragile embedded Telegram implementation with a TDLib-based working inbox for Team Space.

The product target is not a full Telegram clone. The Telegram surface must support the work-oriented inbox flow:

- selected work chats and topics;
- fast local opening of chat threads;
- correct unread and notification behavior;
- replies, reactions, text messages, images, documents, and lazy downloads;
- stable message selection for Redmine workflows;
- preserved app-specific state across Telegram updates and app restarts.

## Current Problems

The current Telegram layer is centered around `src/main/telegram/telegramService.ts`, which combines authorization, GramJS client lifecycle, dialog sync, realtime handlers, message mapping, media preview downloads, reactions, file download, forum topic heuristics, unread mutation, and global `AppState` mutation.

This creates several risks:

- Telegram state is reconstructed through repeated `getDialogs` and `getMessages` calls instead of relying on a complete Telegram client state engine.
- Messages are stored as part of the global app state, then mirrored into SQLite, which makes cache behavior dependent on the most recent renderer-facing state.
- The local message cache can delete messages that are not present in the current `AppState.messages` snapshot.
- Unread counts are partially derived from Telegram and partially mutated locally.
- Opening or loading messages can mark chats as read too early.
- Media previews are downloaded during sync, which makes synchronization slower and heavier.
- Renderer code derives thread state from a global messages array, which encourages race conditions and repeated loads.

## Chosen Approach

Use TDLib as the Telegram client engine.

TDLib is the source of truth for Telegram protocol behavior, local Telegram cache, update consistency, unread counters, files, message send states, reconnect, and session lifecycle. Team Space stores only app-specific inbox state and exposes a focused working-inbox model to the renderer.

Official references:

- https://core.telegram.org/tdlib/getting-started
- https://github.com/tdlib/td
- https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1set_tdlib_parameters.html
- https://core.telegram.org/tdlib/docs/td__json__client_8h.html

## Target Architecture

```text
src/main/integrations/telegram-tdlib/
  TdlibClient.ts
  TdlibAuthService.ts
  TdlibUpdateLoop.ts
  TdlibCommandAdapter.ts
  TdlibMapper.ts
  TdlibMediaService.ts
  TdlibLifecycle.ts
  TdlibBinaryResolver.ts

src/main/features/inbox/
  TelegramInboxService.ts
  TelegramInboxSelectors.ts
  TelegramInboxCommands.ts

src/main/storage/repositories/
  telegramInboxRepository.ts

src/shared/domain/telegram.ts
src/shared/contracts/telegramIpc.ts
src/renderer/features/inbox/
```

### TDLib Integration Layer

`TdlibClient` is a thin wrapper around `td_json`. It owns:

- native library loading;
- TDLib client id creation;
- `send`;
- `receive`;
- request correlation through `@extra`;
- start and stop;
- TDLib log verbosity setup.

`TdlibAuthService` owns the TDLib authorization state machine:

- `authorizationStateWaitTdlibParameters`;
- phone number;
- code;
- password;
- ready;
- logging out;
- closed.

During `setTdlibParameters`, Team Space must configure:

- `database_directory`;
- `files_directory`;
- `database_encryption_key`;
- `use_file_database: true`;
- `use_chat_info_database: true`;
- `use_message_database: true`;
- production DC unless explicitly configured otherwise;
- app API id and API hash from existing settings or environment.

`TdlibUpdateLoop` continuously receives TDLib updates and emits main-process domain events. Renderer code must not poll TDLib directly.

`TdlibCommandAdapter` exposes app-level Telegram operations:

- load chat list;
- open chat or topic;
- load older messages;
- send text;
- send file or image;
- react to a message;
- mark thread read;
- download file;
- disconnect or log out.

`TdlibMapper` converts TDLib objects into Team Space domain models. It is the only place where TDLib object shapes are interpreted by application code.

`TdlibMediaService` handles file download, local file URLs, cache paths, and conversion into renderer-safe media references.

`TdlibBinaryResolver` resolves the native `libtdjson` path for development and Electron packaging. This avoids spreading platform-specific file paths across the app.

### Inbox Feature Layer

`TelegramInboxService` is the main app-facing Telegram feature service. It combines TDLib data with app-specific state loaded from `telegramInboxRepository`:

- selected work chats;
- notification settings;
- message workflow status;
- Redmine links;
- thread view models;
- optimistic sending state;
- UI-ready unread summaries.

`TelegramInboxCommands` handles user actions from IPC:

- select workspace chats;
- toggle notifications;
- open thread;
- load older messages;
- send message;
- send attachment;
- react;
- mark read after actual viewing;
- download attachment.

`TelegramInboxSelectors` builds stable renderer snapshots:

- chat list summary;
- topic list summary;
- selected thread slice;
- unread summary;
- message selection metadata for Redmine.

`telegramInboxRepository` lives in storage and persists only Team Space data. The feature layer depends on it through an interface so TDLib behavior can be tested with an in-memory repository.

## Storage Model

TDLib stores Telegram data:

- Telegram session;
- chats;
- users;
- groups, supergroups, and channels;
- message cache;
- file cache;
- unread counters;
- message send states;
- update consistency state.

Team Space stores app-specific data only:

```text
telegram_workspace_chats
  chat_id
  selected
  selected_at

telegram_notification_settings
  chat_id
  enabled

telegram_message_workflow_status
  message_id
  chat_id
  topic_id
  status
  updated_at

telegram_message_redmine_links
  message_id
  issue_id
  created_at

telegram_inbox_preferences
  key
  value_json
```

The previous `telegram_messages` cache must not remain the source of truth for Telegram history. During migration it may be read for preserving workflow status, but the new TDLib path must not depend on it for current messages.

`AppState.telegram` should become a light snapshot:

```ts
telegram: {
  status: TelegramStatus;
  phoneMasked: string | null;
  hasApiCredentials: boolean;
  selectedFolderId: string | null;
  chatsSummary: TelegramChatSummary[];
  topicsSummary: TelegramTopicSummary[];
  unreadSummary: TelegramUnreadSummary;
  error: string | null;
}
```

Thread messages should be loaded through a focused API, not from a global `AppState.telegram.messages` array.

## Renderer Contract

Keep existing IPC names during early migration as compatibility adapters, then move toward focused inbox commands:

```ts
getTelegramInboxSnapshot(): Promise<TelegramInboxSnapshot>
getTelegramThread(payload: TelegramThreadRequest): Promise<TelegramThreadView>
loadOlderTelegramMessages(payload: TelegramThreadPageRequest): Promise<TelegramThreadView>
sendTelegramMessage(payload: TelegramSendMessagePayload): Promise<TelegramSendResult>
reactToTelegramMessage(payload: TelegramReactionPayload): Promise<TelegramThreadView>
downloadTelegramAttachment(payload: TelegramDownloadPayload): Promise<TelegramDownloadResult>
markTelegramThreadRead(payload: TelegramThreadKey): Promise<TelegramInboxSnapshot>
selectTelegramWorkspace(payload: TelegramWorkspaceSelection): Promise<TelegramInboxSnapshot>
setTelegramChatNotifications(payload: TelegramNotificationSetting): Promise<TelegramInboxSnapshot>
```

Renderer state should keep only the active thread slice and transient UI state. The global app shell should not build message indexes from all Telegram messages.

## Read And Unread Behavior

TDLib owns Telegram unread counters. Team Space must not manually increment or decrement Telegram unread as the source of truth.

Opening a thread loads messages but does not automatically mark the thread as read. A read action is sent only when all conditions are true:

- the inbox view is active;
- the target chat or topic is selected;
- the thread viewport has shown the latest unread message or is at the bottom;
- the app window is focused.

Team Space workflow status is independent of Telegram read state. A message can be marked `created` for Redmine even if Telegram read state changes later.

## Topics And Forums

TDLib forum and thread data replaces the current manual `replyTo` and synthetic top-message heuristics.

Team Space uses a stable thread key:

```ts
type TelegramThreadKey = {
  chatId: string;
  topicId: string | null;
};
```

Topic ids must be mapped through `TdlibMapper` and persisted only as app references. The migration must explicitly handle differences between current GramJS-derived ids and TDLib chat/topic ids.

## Sending

The renderer creates an optimistic message with a client request id. TDLib performs the real send and emits message updates. The optimistic item is replaced when TDLib reports the real message id and state.

Supported first-scope send operations:

- text;
- reply;
- image;
- document;
- reaction.

Failed sends remain visible with retry or remove actions.

## Attachments

Do not store base64 previews in Team Space SQLite.

TDLib stores file metadata and file cache. Team Space requests file download lazily when the renderer needs to show or open media.

The renderer receives a safe local URL, such as `teamspace-file://telegram/...`, or a file path wrapped by the existing local file protocol.

## Migration Plan

### Phase 1: TDLib Infrastructure Beside GramJS

Add the TDLib integration module without deleting the existing GramJS service. The initial implementation should be macOS development capable, with `TdlibBinaryResolver` already shaped for packaging.

Keep old IPC method names as compatibility adapters until each renderer call site has moved to the focused thread API.

### Phase 2: App-Specific Repository

Refactor `LocalTelegramDatabase` or add a new repository so Team Space stores only app-specific inbox data.

Preserve selected chats and notification settings from existing state. Preserve message workflow status where old cached message ids can be mapped safely.

### Phase 3: Thread API

Introduce `getTelegramInboxSnapshot` and `getTelegramThread`. Move `Inbox` away from `state.telegram.messages` and into a thread view model.

`AppShell` should stop building `telegramMessageIndex` from a global message array.

### Phase 4: TDLib Commands

Switch auth, chat loading, thread loading, sending, reactions, downloads, and read behavior to TDLib-backed commands.

### Phase 5: Remove GramJS

After TDLib covers the accepted behavior, remove:

- `telegram` package dependency;
- `StringSession`;
- GramJS-specific mappers;
- manual update handlers;
- manual background sync;
- base64 preview sync;
- global Telegram message history in app state.

### Phase 6: Packaging

Package `libtdjson` for Electron. Start with macOS development integration, then add Windows and Linux packaging if the product needs them.

## Testing Strategy

### Unit Tests

`TdlibMapper`:

- chats, users, groups, supergroups, and channels;
- forum topics;
- text messages;
- replies;
- files and images;
- reactions;
- outgoing, pending, failed, and sent states.

`TelegramInboxService`:

- selected chats survive TDLib updates;
- notification settings filter unread notification count;
- `new`, `ignored`, and `created` workflow states survive message refreshes;
- Redmine links survive thread reload;
- topic threads are separated from all-chat threads.

`telegramInboxRepository`:

- stores only app-specific state;
- migrates selected chats and notification settings;
- does not delete workflow status when Telegram message cache changes.

### Integration Tests

Use a fake `TdlibClient` that can:

- emit scripted authorization states;
- accept requests;
- return chats, topics, messages, files;
- emit message updates;
- simulate reconnect bursts;
- simulate send success and failure.

Covered flows:

- phone, code, and password login;
- startup after app restart;
- incoming message update;
- muted or unselected chat notification filtering;
- delayed read until actual viewing;
- optimistic send replacement;
- file download;
- TDLib errors mapped to user-facing errors.

### UI Tests

The inbox tests should target the thread model, not a global messages array.

Required scenarios:

- dense Telegram-like adjacent panes without large outer cards;
- switching chats does not trigger unnecessary full sync;
- loading older messages preserves scroll position;
- incoming messages do not steal scroll when reading history;
- incoming messages auto-scroll only when the user is already at the bottom;
- reply, reaction, and file send work in a selected topic.

## Acceptance Criteria

The TDLib inbox is ready when:

- Team Space authorizes Telegram through TDLib;
- app restart preserves session and selected work chats;
- selected chats open quickly from TDLib local cache;
- new messages arrive without manual refresh;
- unread counts match the official Telegram client for selected work chats;
- read receipts are not sent before actual viewing;
- text, reply, image/file, and reaction sending works;
- attachments download lazily;
- Redmine issue creation from selected Telegram messages still works;
- old GramJS implementation is removed or disabled behind an explicit feature flag.

## Risks

- Native TDLib binary packaging in Electron.
- Different id formats between GramJS and TDLib.
- Topic/thread model migration for forum chats.
- Larger app size due to TDLib binary and cache.
- Database encryption key handling: a wrong or lost key can make TDLib cache inaccessible.
- TDLib wrapper choice may be unreliable; direct `td_json` binding may be needed.

## Non-Goals

- Full Telegram client parity.
- Secret chats.
- Calls.
- Stories.
- Advanced admin tools.
- Global Telegram search across all chats.
- Multi-account support in the first migration.
