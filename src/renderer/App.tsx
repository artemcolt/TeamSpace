import { useEffect, useMemo, useRef, useState } from 'react';
import { StatusPill } from './components/common';
import { api } from './domain/bridge';
import { gitlabDefaultUrl } from './domain/constants';
import { Agents } from './features/agents/Agents';
import { Browser } from './features/browser/Browser';
import { Inbox } from './features/inbox/Inbox';
import { Mail } from './features/mail/Mail';
import { Meetings } from './features/meetings/Meetings';
import { MyTasks } from './features/my-tasks/MyTasks';
import { Onboarding, type OnboardingStep } from './features/onboarding/Onboarding';
import { initials, optionName } from './domain/formatters';
import appIcon from './assets/app-icon.png';

const CHATGPT_URL = 'https://chatgpt.com/';

type View = 'inbox' | 'myTasks' | 'meetings' | 'mail' | 'agents' | 'queue' | 'browser' | 'gitlab' | 'chatgpt' | 'settings';
type Toast = {
  id: number;
  kind: 'success' | 'error';
  message: string;
  avatar?: string | null;
  avatarLabel?: string;
};

type QueueFileViewer = {
  title: string;
  path: string;
  content: string;
  loading: boolean;
  error: string;
};

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [view, setView] = useState<View>('settings');
  const [step, setStep] = useState<OnboardingStep>('welcome');
  const [firstRunSetup, setFirstRunSetup] = useState(false);
  const [hasKatyaSession, setHasKatyaSession] = useState(false);
  const [selectedChatId, setSelectedChatId] = useState<string>('');
  const [selectedTopicId, setSelectedTopicId] = useState<string>('');
  const [selectedMessageIds, setSelectedMessageIds] = useState<string[]>([]);
  const [browserUrl, setBrowserUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [aiQueue, setAiQueue] = useState<AiQueueItem[]>([]);
  const [selectedAiQueueItemId, setSelectedAiQueueItemId] = useState('');
  const [queueFileViewer, setQueueFileViewer] = useState<QueueFileViewer | null>(null);
  const activeChatLoadSignals = useRef(new Map<string, string>());

  useEffect(() => {
    Promise.all([api.getState(), api.getKatyaSession()]).then(([nextState, savedKatyaSession]) => {
      const nextHasKatyaSession = Boolean(savedKatyaSession.trim());
      setState(nextState);
      setHasKatyaSession(nextHasKatyaSession);
      setFirstRunSetup(!isRequiredWorkspaceReady(nextState, nextHasKatyaSession));
      const firstSelectedChat = nextState.telegram.chats.find((chat) => chat.selected);
      setSelectedChatId(firstSelectedChat?.id ?? nextState.telegram.chats[0]?.id ?? '');
      if (isRequiredWorkspaceReady(nextState, nextHasKatyaSession)) {
        setView('inbox');
      } else {
        setView('settings');
      }
      if (nextState.telegram.status === 'connected' && nextState.telegram.hasApiCredentials) {
        api.syncTelegram().then(setState).catch(() => undefined);
      }
    });
  }, []);

  useEffect(() => api.onStateChanged(setState), []);

  useEffect(() => {
    api.getAiQueue().then(setAiQueue).catch(() => undefined);
    return api.onAiQueueChanged(setAiQueue);
  }, []);

  useEffect(() => {
    if (!state) {
      return;
    }
    if (!selectedChatId) {
      setSelectedChatId(state.telegram.chats.find((chat) => chat.selected)?.id ?? '');
    }
    const chatTopics = state.telegram.topics.filter((topic) => topic.chatId === selectedChatId);
    if (chatTopics.length === 0 && selectedTopicId) {
      setSelectedTopicId('');
    } else if (
      chatTopics.length > 0 &&
      selectedTopicId !== 'all' &&
      !chatTopics.some((topic) => topic.id === selectedTopicId)
    ) {
      setSelectedTopicId(chatTopics[0].id);
    }
  }, [selectedChatId, selectedTopicId, state]);

  const selectedChat = state?.telegram.chats.find((chat) => chat.id === selectedChatId);
  const telegramMessageIndex = useMemo(() => {
    const byChat = new Map<string, TelegramMessage[]>();
    const byTopic = new Map<string, TelegramMessage[]>();

    for (const message of state?.telegram.messages ?? []) {
      const chatMessages = byChat.get(message.chatId);
      if (chatMessages) {
        chatMessages.push(message);
      } else {
        byChat.set(message.chatId, [message]);
      }

      if (message.topicId) {
        const topicMessages = byTopic.get(message.topicId);
        if (topicMessages) {
          topicMessages.push(message);
        } else {
          byTopic.set(message.topicId, [message]);
        }
      }
    }

    const sentAtAsc = (a: TelegramMessage, b: TelegramMessage) =>
      new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime();
    byChat.forEach((messages) => messages.sort(sentAtAsc));
    byTopic.forEach((messages) => messages.sort(sentAtAsc));

    return { byChat, byTopic };
  }, [state?.telegram.messages]);
  const selectedChatTopics = useMemo(() => {
    if (!state) {
      return [];
    }
    return state.telegram.topics
      .filter((topic) => topic.chatId === selectedChatId)
      .sort((a, b) => {
        if ((b.unreadCount ?? 0) !== (a.unreadCount ?? 0)) {
          return (b.unreadCount ?? 0) - (a.unreadCount ?? 0);
        }
        return new Date(b.lastMessageAt ?? 0).getTime() - new Date(a.lastMessageAt ?? 0).getTime();
      });
  }, [selectedChatId, state]);
  useEffect(() => {
    if (!state || view !== 'inbox' || busy || !selectedChatId) {
      return;
    }

    const requestTopicId = selectedTopicId && selectedTopicId !== 'all' ? selectedTopicId : undefined;
    const requestKey = telegramChatLoadKey(selectedChatId, requestTopicId);
    const loadSignal = telegramChatLoadSignal(state.telegram, selectedChatId, requestTopicId);
    if (activeChatLoadSignals.current.get(requestKey) === loadSignal) {
      return;
    }

    activeChatLoadSignals.current.set(requestKey, loadSignal);
    void loadTelegramChatMessages(selectedChatId, requestTopicId).then((nextState) => {
      if (nextState) {
        activeChatLoadSignals.current.set(
          requestKey,
          telegramChatLoadSignal(nextState.telegram, selectedChatId, requestTopicId)
        );
      }
    });
  }, [
    busy,
    selectedChat?.lastMessageAt,
    selectedChat?.unreadCount,
    selectedChatId,
    selectedTopicId,
    state,
    view
  ]);

  const selectedMessages = useMemo(() => {
    if (!selectedChatId) {
      return [];
    }
    if (selectedTopicId && selectedTopicId !== 'all') {
      return telegramMessageIndex.byTopic.get(selectedTopicId) ?? [];
    }
    return telegramMessageIndex.byChat.get(selectedChatId) ?? [];
  }, [selectedChatId, selectedTopicId, telegramMessageIndex]);

  const katyaConfigured = hasKatyaSession;
  const readyForMainFlow = Boolean(state && isRequiredWorkspaceReady(state, katyaConfigured));
  const unreadMessagesCount = state?.telegram.chats
    .filter((chat) => chat.selected && chat.notificationsEnabled !== false)
    .reduce((total, chat) => total + Math.max(0, chat.unreadCount ?? 0), 0) ?? 0;

  function dismissToast(id: number) {
    setToasts((currentToasts) => currentToasts.filter((toast) => toast.id !== id));
  }

  function notify(
    message: string,
    kind: Toast['kind'] = 'success',
    avatar?: { src: string | null; label: string }
  ) {
    const id = Date.now() + Math.random();
    setToasts((currentToasts) => [
      ...currentToasts,
      {
        id,
        kind,
        message,
        avatar: avatar?.src,
        avatarLabel: avatar?.label
      }
    ].slice(-4));
    window.setTimeout(() => dismissToast(id), 4200);
  }

  async function runAction(
    action: () => Promise<AppState>,
    success?: string,
    options: { blockUi?: boolean } = {}
  ) {
    const blockUi = options.blockUi ?? true;
    if (blockUi) {
      setBusy(true);
    }
    try {
      const nextState = await action();
      setState(nextState);
      if (success) {
        notify(success);
      }
      return nextState;
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Операция не выполнена.', 'error');
      return null;
    } finally {
      if (blockUi) {
        setBusy(false);
      }
    }
  }

  function telegramChatLoadKey(chatId: string, topicId?: string) {
    return `${chatId}:${topicId ?? ''}`;
  }

  function telegramChatLoadSignal(telegram: AppState['telegram'], chatId: string, topicId?: string) {
    const chat = telegram.chats.find((item) => item.id === chatId);
    const topic = topicId ? telegram.topics.find((item) => item.id === topicId) : undefined;
    return [
      chat ? chat.id : '',
      topicId ? topic?.id ?? '' : ''
    ].join('|');
  }

  async function loadTelegramChatMessages(chatId: string, topicId?: string) {
    if (!chatId) {
      return null;
    }
    return runAction(
      () => api.loadChatMessages({ chatId, topicId }),
      undefined,
      { blockUi: false }
    );
  }

  async function switchProject(projectId: string) {
    const projectName = optionName(state?.redmine.projects ?? [], projectId) || 'проект';
    const nextState = await runAction(
      () => api.selectRedmineProject({ projectId }),
      `Активный проект: ${projectName}.`
    );
    if (nextState) {
      setSelectedMessageIds([]);
    }
  }

  async function createIssueFromSelectedMessages() {
    const nextState = await runAction(
      () => api.createRedmineIssueFromMessages({ messageIds: selectedMessageIds }),
      'Задача создана в Redmine.'
    );
    if (!nextState) {
      return;
    }
    setSelectedMessageIds([]);
  }

  async function openTelegramChat(chatId: string) {
    setSelectedChatId(chatId);
    const chatTopics = state?.telegram.topics.filter((topic) => topic.chatId === chatId) ?? [];
    const nextTopicId = [...chatTopics].sort((a, b) => {
      if ((b.unreadCount ?? 0) !== (a.unreadCount ?? 0)) {
        return (b.unreadCount ?? 0) - (a.unreadCount ?? 0);
      }
      return new Date(b.lastMessageAt ?? 0).getTime() - new Date(a.lastMessageAt ?? 0).getTime();
    })[0]?.id ?? '';
    setSelectedTopicId(nextTopicId);
    setSelectedMessageIds([]);
    const requestTopicId = nextTopicId || undefined;
    const requestKey = telegramChatLoadKey(chatId, requestTopicId);
    if (state) {
      activeChatLoadSignals.current.set(
        requestKey,
        telegramChatLoadSignal(state.telegram, chatId, requestTopicId)
      );
    }
    void loadTelegramChatMessages(chatId, requestTopicId).then((nextState) => {
      if (nextState) {
        activeChatLoadSignals.current.set(
          requestKey,
          telegramChatLoadSignal(nextState.telegram, chatId, requestTopicId)
        );
      }
    });
  }

  function openInternalBrowser(url: string) {
    setBrowserUrl(url);
    setView('browser');
  }

  function openAiQueueTarget(item: AiQueueItem) {
    setView(item.target.view);
  }

  async function openQueueFile(title: string, filePath: string) {
    if (!filePath) {
      return;
    }
    setQueueFileViewer({
      title,
      path: filePath,
      content: '',
      loading: true,
      error: ''
    });
    try {
      const content = await api.readTextFile(filePath);
      setQueueFileViewer({
        title,
        path: filePath,
        content,
        loading: false,
        error: ''
      });
    } catch (error) {
      setQueueFileViewer({
        title,
        path: filePath,
        content: '',
        loading: false,
        error: error instanceof Error ? error.message : 'Не удалось открыть файл.'
      });
    }
  }

  function queueItemContextFields(item: AiQueueItem): AiQueueContextField[] {
    const fields = item.context?.fields ?? [];
    const fallbackFields: AiQueueContextField[] = [
      { label: 'Раздел', value: item.target.label },
      { label: 'Создана', value: formatQueueTime(item.createdAt) },
      item.startedAt ? { label: 'Старт', value: formatQueueTime(item.startedAt) } : null,
      item.finishedAt ? { label: 'Финиш', value: formatQueueTime(item.finishedAt) } : null,
      item.resultFile ? { label: 'Результат', value: item.resultFile } : null,
      item.sessionId ? { label: 'Session ID', value: item.sessionId } : null
    ].filter((field): field is AiQueueContextField => Boolean(field));
    return [...fields, ...fallbackFields];
  }

  function aiQueueStatusText(status: AiQueueStatus) {
    if (status === 'queued') {
      return 'В очереди';
    }
    if (status === 'running') {
      return 'Выполняется';
    }
    if (status === 'done') {
      return 'Готово';
    }
    return 'Ошибка';
  }

  function formatQueueTime(value: string | null) {
    if (!value) {
      return '';
    }
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(value));
  }

  const activeAiQueue = aiQueue.filter((item) => item.status === 'queued' || item.status === 'running');
  const finishedAiQueueItems = aiQueue
    .filter((item) => item.status === 'done' || item.status === 'error')
    .slice(-12)
    .reverse();
  const visibleAiQueue = [...activeAiQueue, ...finishedAiQueueItems];
  const finishedAiQueue = aiQueue.filter((item) => item.status === 'done' || item.status === 'error').length;
  const selectedAiQueueItem = visibleAiQueue.find((item) => item.id === selectedAiQueueItemId)
    ?? visibleAiQueue[0]
    ?? null;
  const setupShellVisible = !readyForMainFlow || firstRunSetup;

  if (!state) {
    return <div className="loading">Загрузка Workspace...</div>;
  }

  if (setupShellVisible) {
    return (
      <main className="setup-shell">
        <div className="toast-stack" aria-live="polite" aria-atomic="false">
          {toasts.map((toast) => (
            <div key={toast.id} className={`toast ${toast.kind} ${toast.avatarLabel ? 'with-avatar' : ''}`}>
              {toast.avatarLabel && (
                <span className="toast-avatar" aria-hidden="true">
                  {toast.avatar ? <img src={toast.avatar} alt="" /> : initials(toast.avatarLabel)}
                </span>
              )}
              <span>{toast.message}</span>
              <button
                aria-label="Закрыть уведомление"
                onClick={() => dismissToast(toast.id)}
                type="button"
              >
                x
              </button>
            </div>
          ))}
        </div>

        <Onboarding
          busy={busy}
          state={state}
          step={step}
          setStep={setStep}
          onState={setState}
          runAction={runAction}
          firstRun
          readyForMainFlow={readyForMainFlow}
          katyaConfigured={katyaConfigured}
          onKatyaConfigChange={setHasKatyaSession}
          onFinish={() => {
            if (readyForMainFlow) {
              setFirstRunSetup(false);
              setView('inbox');
            } else {
              setFirstRunSetup(true);
              setStep('review');
            }
          }}
        />
      </main>
    );
  }

  return (
    <main className="app-shell">
      <div className="toast-stack" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind} ${toast.avatarLabel ? 'with-avatar' : ''}`}>
            {toast.avatarLabel && (
              <span className="toast-avatar" aria-hidden="true">
                {toast.avatar ? <img src={toast.avatar} alt="" /> : initials(toast.avatarLabel)}
              </span>
            )}
            <span>{toast.message}</span>
            <button
              aria-label="Закрыть уведомление"
              onClick={() => dismissToast(toast.id)}
              type="button"
            >
              x
            </button>
          </div>
        ))}
      </div>

      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src={appIcon} alt="" />
          <div>
            <h1>Workspace</h1>
            <p>Team Space</p>
          </div>
        </div>

        <label className="project-switcher">
          <span>Активный проект</span>
          <select
            value={state.workspace.defaultProjectId}
            disabled={busy || state.redmine.status !== 'connected' || state.redmine.projects.length === 0}
            onChange={(event) => {
              void switchProject(event.target.value);
            }}
          >
            <option value="">Не выбран</option>
            {state.redmine.projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </label>

        <nav className="nav-list" aria-label="Основная навигация">
          <button
            className={view === 'inbox' ? 'nav-item nav-item-primary active' : 'nav-item nav-item-primary'}
            disabled={!state.telegram.status || state.telegram.status === 'disconnected'}
            onClick={() => setView('inbox')}
          >
            <span>Сообщения</span>
            {unreadMessagesCount > 0 && (
              <span className="nav-unread-badge" aria-label={`${unreadMessagesCount} новых сообщений`}>
                {unreadMessagesCount > 99 ? '99+' : unreadMessagesCount}
              </span>
            )}
          </button>
          <button
            className={view === 'myTasks' ? 'nav-item nav-item-primary active' : 'nav-item nav-item-primary'}
            onClick={() => setView('myTasks')}
          >
            Мои задачи
          </button>
          <button
            className={view === 'agents' ? 'nav-item nav-item-primary active' : 'nav-item nav-item-primary'}
            onClick={() => setView('agents')}
          >
            Агенты
          </button>
          <button
            className={view === 'queue' ? 'nav-item nav-item-secondary active' : 'nav-item nav-item-secondary'}
            onClick={() => setView('queue')}
          >
            <span>Очередь</span>
            {activeAiQueue.length > 0 && (
              <span className="nav-unread-badge" aria-label={`${activeAiQueue.length} задач в очереди`}>
                {activeAiQueue.length > 99 ? '99+' : activeAiQueue.length}
              </span>
            )}
          </button>
          <button
            className={view === 'meetings' ? 'nav-item nav-item-secondary active' : 'nav-item nav-item-secondary'}
            onClick={() => setView('meetings')}
          >
            Встречи
          </button>
          <button
            className={view === 'mail' ? 'nav-item nav-item-secondary active' : 'nav-item nav-item-secondary'}
            onClick={() => setView('mail')}
          >
            Почта
          </button>
          <button
            aria-label="Открыть GitLab"
            className={view === 'gitlab' ? 'nav-item nav-item-secondary active' : 'nav-item nav-item-secondary'}
            onClick={() => setView('gitlab')}
          >
            GitLab
          </button>
          {browserUrl && (
            <button
              className={view === 'browser' ? 'nav-item nav-item-secondary active' : 'nav-item nav-item-secondary'}
              onClick={() => setView('browser')}
            >
              Браузер
            </button>
          )}
          <button
            className={view === 'chatgpt' ? 'nav-item nav-item-secondary active' : 'nav-item nav-item-secondary'}
            onClick={() => setView('chatgpt')}
          >
            ChatGPT
          </button>
          <button
            className={view === 'settings' ? 'nav-item nav-item-secondary active' : 'nav-item nav-item-secondary'}
            onClick={() => setView('settings')}
          >
            Настройки
          </button>
        </nav>

        <div className="sidebar-status">
          <StatusPill label="Telegram" status={state.telegram.status} />
          <StatusPill label="Redmine" status={state.redmine.status} />
          <StatusPill label="GitLab" status={state.gitlab.status} />
        </div>
      </aside>

      <section
        className={[
          'workspace',
          view === 'inbox' ? 'messenger-workspace' : '',
          view === 'meetings' ? 'meetings-workspace' : '',
          view === 'mail' ? 'mail-workspace' : '',
          view === 'agents' ? 'agents-workspace' : '',
          view === 'queue' ? 'queue-workspace' : '',
          view === 'browser' || view === 'gitlab' || view === 'chatgpt' ? 'browser-workspace' : '',
          view === 'myTasks' ? 'my-tasks-workspace' : ''
        ].join(' ')}
      >
        {view === 'settings' && (
          <Onboarding
            busy={busy}
            state={state}
            step={step}
            setStep={setStep}
            onState={setState}
            runAction={runAction}
            firstRun={false}
            readyForMainFlow={readyForMainFlow}
            katyaConfigured={katyaConfigured}
            onKatyaConfigChange={setHasKatyaSession}
            onFinish={() => {
              if (readyForMainFlow) {
                setView('inbox');
              } else {
                setStep('review');
              }
            }}
          />
        )}

        {view === 'inbox' && (
          <Inbox
            busy={busy}
            state={state}
            onState={setState}
            selectedChatId={selectedChatId}
            selectedTopicId={selectedTopicId}
            selectedChat={selectedChat}
            selectedChatTopics={selectedChatTopics}
            selectedMessageIds={selectedMessageIds}
            selectedMessages={selectedMessages}
            setSelectedChatId={openTelegramChat}
            setSelectedTopicId={setSelectedTopicId}
            setSelectedMessageIds={setSelectedMessageIds}
            createIssueFromMessages={createIssueFromSelectedMessages}
            openInternalBrowser={openInternalBrowser}
            runAction={runAction}
          />
        )}

        {view === 'meetings' && (
          <Meetings
            onOpenSettings={() => {
              setStep('katya');
              setView('settings');
            }}
          />
        )}

        {view === 'mail' && <Mail />}

        {view === 'agents' && <Agents state={state} />}

        {view === 'queue' && (
          <section className="queue-page" aria-label="Очередь задач">
            <header className="topbar">
              <div>
                <p className="eyebrow">AI</p>
                <h2>Очередь задач</h2>
              </div>
              <div className="queue-summary" aria-label="Состояние очереди">
                <span>{activeAiQueue.length} активно</span>
                <span>{finishedAiQueue} завершено</span>
              </div>
            </header>

            <div className="queue-layout">
              <div className="queue-list">
                {visibleAiQueue.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`queue-item ${item.status} ${selectedAiQueueItem?.id === item.id ? 'selected' : ''}`}
                    title={item.error || `Показать контекст: ${item.target.label}`}
                    aria-pressed={selectedAiQueueItem?.id === item.id}
                    onClick={() => setSelectedAiQueueItemId(item.id)}
                  >
                    <span className="queue-item-main">
                      <strong>{item.title}</strong>
                      <span>{item.target.label}</span>
                      {item.error && <em>{item.error}</em>}
                    </span>
                    <span className="queue-item-meta">
                      <span>{aiQueueStatusText(item.status)}</span>
                      <time>{formatQueueTime(item.finishedAt ?? item.startedAt ?? item.createdAt)}</time>
                    </span>
                  </button>
                ))}
                {visibleAiQueue.length === 0 && <p className="empty-state">Очередь пуста.</p>}
              </div>

              <aside className="queue-detail" aria-label="Контекст задачи очереди">
                {selectedAiQueueItem ? (
                  <>
                    <div className="queue-detail-header">
                      <p className="eyebrow">{aiQueueStatusText(selectedAiQueueItem.status)}</p>
                      <h3>{selectedAiQueueItem.context?.title || selectedAiQueueItem.title}</h3>
                    </div>
                    <dl className="queue-detail-fields">
                      {queueItemContextFields(selectedAiQueueItem).map((field) => (
                        <div key={`${field.label}-${field.value}`}>
                          <dt>{field.label}</dt>
                          <dd>{field.value}</dd>
                        </div>
                      ))}
                    </dl>
                    {(selectedAiQueueItem.context?.description || selectedAiQueueItem.error) && (
                      <div className="queue-detail-description">
                        {selectedAiQueueItem.context?.description && (
                          <p>{selectedAiQueueItem.context.description}</p>
                        )}
                        {selectedAiQueueItem.error && <em>{selectedAiQueueItem.error}</em>}
                      </div>
                    )}
                    {selectedAiQueueItem.resultPreview && (
                      <div className="queue-detail-result">
                        <h4>Результат</h4>
                        <pre>{selectedAiQueueItem.resultPreview}</pre>
                      </div>
                    )}
                    <div className="queue-detail-actions">
                      {selectedAiQueueItem.resultFile && (
                        <button
                          type="button"
                          className="secondary-action"
                          onClick={() => void openQueueFile('Результат', selectedAiQueueItem.resultFile || '')}
                        >
                          Открыть результат
                        </button>
                      )}
                      <button
                        type="button"
                        className="secondary-action"
                        onClick={() => openAiQueueTarget(selectedAiQueueItem)}
                      >
                        Открыть {selectedAiQueueItem.target.label}
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="empty-state">Выберите задачу в очереди.</p>
                )}
              </aside>
            </div>
          </section>
        )}

        {view === 'browser' && browserUrl && <Browser url={browserUrl} />}

        {view === 'gitlab' && <Browser url={state.gitlab.baseUrl || gitlabDefaultUrl} />}

        {view === 'chatgpt' && <Browser url={CHATGPT_URL} showToolbar={false} viewKind="chatgpt" />}

        {view === 'myTasks' && (
          <MyTasks
            state={state}
            onState={setState}
            onOpenSettings={() => setView('settings')}
            onNotify={(message, avatar) => notify(message, 'success', avatar)}
          />
        )}

      </section>
      {queueFileViewer && (
        <section className="queue-file-viewer" role="dialog" aria-modal="true" aria-label={queueFileViewer.title}>
          <header className="queue-file-viewer-header">
            <div>
              <p className="eyebrow">Очередь</p>
              <h2>{queueFileViewer.title}</h2>
            </div>
            <button
              type="button"
              className="secondary-action"
              onClick={() => setQueueFileViewer(null)}
            >
              Закрыть
            </button>
          </header>
          <div className="queue-file-viewer-path">{queueFileViewer.path}</div>
          <div className="queue-file-viewer-content">
            {queueFileViewer.loading && <p className="empty-state">Загрузка файла...</p>}
            {queueFileViewer.error && <p className="error-text">{queueFileViewer.error}</p>}
            {!queueFileViewer.loading && !queueFileViewer.error && (
              <pre>{queueFileViewer.content || 'Файл пуст.'}</pre>
            )}
          </div>
        </section>
      )}
    </main>
  );
}

function isRequiredWorkspaceReady(state: AppState, katyaConfigured: boolean) {
  const trackerReady = state.redmine.trackers.length === 0 || Boolean(state.workspace.defaultTrackerId);
  const priorityReady = state.redmine.priorities.length === 0 || Boolean(state.workspace.defaultPriorityId);
  return (
    state.telegram.status === 'connected' &&
    state.telegram.chats.some((chat) => chat.selected) &&
    state.redmine.status === 'connected' &&
    state.gitlab.status === 'connected' &&
    Boolean(state.workspace.defaultProjectId) &&
    trackerReady &&
    priorityReady &&
    Boolean(state.workspace.defaultSprintId) &&
    Boolean(state.workspace.defaultAssigneeId) &&
    katyaConfigured
  );
}
