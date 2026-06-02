import { useEffect, useState } from 'react';
import { InfoLine, SearchableSelectField, SelectField, StatusPill } from '../../components/common';
import { api } from '../../domain/bridge';
import { redmineHelpUrl, telegramDefaultProxyUrl } from '../../domain/constants';
import { optionName } from '../../domain/formatters';
import appIcon from '../../assets/app-icon.png';
import { Browser } from '../browser/Browser';
import { GitLabPanel } from '../settings/GitLabPanel';
import { MailCredentialsPanel } from '../settings/MailCredentialsPanel';

export type OnboardingStep = 'welcome' | 'telegram' | 'chats' | 'redmine' | 'gitlab' | 'defaults' | 'katya' | 'mail' | 'review';
type TelegramSetupStage = 'prepare' | 'credentials' | 'phone' | 'code' | 'connected';

const telegramAppsUrl = 'https://my.telegram.org/apps';

export function Onboarding({
  busy,
  state,
  step,
  setStep,
  onState,
  runAction,
  firstRun = false,
  readyForMainFlow,
  katyaConfigured,
  onKatyaConfigChange,
  onFinish
}: {
  busy: boolean;
  state: AppState;
  step: OnboardingStep;
  setStep: (step: OnboardingStep) => void;
  onState: (state: AppState) => void;
  runAction: (action: () => Promise<AppState>, success?: string) => Promise<AppState | null>;
  firstRun?: boolean;
  readyForMainFlow: boolean;
  katyaConfigured: boolean;
  onKatyaConfigChange: (hasSession: boolean) => void;
  onFinish: () => void;
}) {
  const steps: Array<{ id: OnboardingStep; label: string }> = [
    { id: 'welcome', label: 'Сценарий' },
    { id: 'telegram', label: 'Telegram' },
    { id: 'chats', label: 'Чаты' },
    { id: 'redmine', label: 'Redmine' },
    { id: 'gitlab', label: 'GitLab' },
    { id: 'defaults', label: 'Defaults' },
    { id: 'katya', label: 'Катя' },
    { id: 'mail', label: 'Почта' },
    { id: 'review', label: 'Проверка' }
  ];
  const setupStepStatus = (stepId: OnboardingStep) => {
    if (stepId === 'telegram') {
      return state.telegram.status === 'connected' ? 'Готово' : 'Не настроен';
    }
    if (stepId === 'chats') {
      return state.telegram.chats.some((chat) => chat.selected) ? 'Выбраны' : 'После Telegram';
    }
    if (stepId === 'redmine') {
      return state.redmine.status === 'connected' ? 'Готово' : 'Не настроен';
    }
    if (stepId === 'gitlab') {
      return state.gitlab.status === 'connected' ? 'Готово' : 'Не настроен';
    }
    if (stepId === 'defaults') {
      return state.workspace.defaultProjectId ? 'Готово' : 'После Redmine';
    }
    if (stepId === 'katya') {
      return katyaConfigured ? 'Готово' : 'Обязательно';
    }
    if (stepId === 'mail') {
      return 'Опционально';
    }
    if (stepId === 'review') {
      return 'Финиш';
    }
    return 'Старт';
  };
  const setupStepDone = (stepId: OnboardingStep) => {
    if (stepId === 'welcome') {
      return true;
    }
    if (stepId === 'telegram') {
      return state.telegram.status === 'connected';
    }
    if (stepId === 'chats') {
      return state.telegram.chats.some((chat) => chat.selected);
    }
    if (stepId === 'redmine') {
      return state.redmine.status === 'connected';
    }
    if (stepId === 'gitlab') {
      return state.gitlab.status === 'connected';
    }
    if (stepId === 'defaults') {
      return defaultsReady(state);
    }
    if (stepId === 'katya') {
      return katyaConfigured;
    }
    return false;
  };
  const renderedStepButtons = (
    <div className={firstRun ? 'setup-stepper' : 'stepper'}>
      {steps.map((item, index) => (
        <button
          key={item.id}
          className={[
            'step',
            step === item.id ? 'active' : '',
            setupStepDone(item.id) ? 'done' : ''
          ].join(' ')}
          onClick={() => setStep(item.id)}
          type="button"
        >
          {firstRun && <span className="setup-step-number" aria-hidden="true">{setupStepDone(item.id) ? '✓' : index + 1}</span>}
          <span>{item.label}</span>
          {firstRun && <small aria-hidden="true">{setupStepStatus(item.id)}</small>}
        </button>
      ))}
    </div>
  );
  const currentStepLabel = steps.find((item) => item.id === step)?.label ?? '';
  const content = (
    <>
      {step === 'welcome' && (
        <section className="panel hero-panel">
          <p className="panel-label">{firstRun ? 'Первичная настройка' : 'MVP'}</p>
          <h3>{firstRun ? 'Подключите рабочее пространство по шагам' : <>Telegram messages {'->'} AI {'->'} Redmine issue</>}</h3>
          <p>
            {firstRun
              ? 'Сначала добавьте Telegram, выберите чаты, затем настройте Redmine, GitLab, defaults и Катю. Почту можно подключить позже.'
              : 'Приложение помогает выбрать рабочие сообщения, оформить постановку через AI и сразу создать задачу в Redmine.'}
          </p>
          <div className="actions">
            <button className="primary-action" onClick={() => setStep('telegram')} type="button">
              Начать настройку
            </button>
            {!firstRun && (
              <button className="secondary-action" onClick={onFinish} type="button">
                Пропустить
              </button>
            )}
          </div>
        </section>
      )}

      {step === 'telegram' && (
        <TelegramConnectPanel
          busy={busy}
          state={state}
          runAction={runAction}
          next={() => setStep('chats')}
        />
      )}

      {step === 'chats' && (
        <ChatSelectionPanel
          busy={busy}
          state={state}
          runAction={runAction}
          next={() => setStep('redmine')}
        />
      )}

      {step === 'redmine' && (
        <RedminePanel
          busy={busy}
          state={state}
          runAction={runAction}
          onState={onState}
          next={() => setStep('gitlab')}
        />
      )}

      {step === 'gitlab' && (
        <GitLabPanel
          busy={busy}
          state={state}
          runAction={runAction}
          setupMode
          next={() => setStep('defaults')}
        />
      )}

      {step === 'defaults' && (
        <DefaultsPanel
          busy={busy}
          state={state}
          runAction={runAction}
          next={() => setStep('katya')}
        />
      )}

      {step === 'katya' && (
        <KatyaPanel
          busy={busy}
          onConfiguredChange={onKatyaConfigChange}
        />
      )}

      {step === 'mail' && (
        <MailCredentialsPanel busy={busy} />
      )}

      {step === 'review' && (
        <section className="panel">
          <p className="panel-label">Проверка настроек</p>
          <h3>Готовность сценария</h3>
          <div className="review-grid">
            <StatusPill label="Telegram" status={state.telegram.status} />
            <StatusPill label="Redmine" status={state.redmine.status} />
            <StatusPill label="GitLab" status={state.gitlab.status} />
            <InfoLine label="Катя" value={katyaConfigured ? 'Настроена' : 'Не настроена'} />
            <InfoLine label="Рабочие чаты" value={String(state.telegram.chats.filter((chat) => chat.selected).length)} />
            <InfoLine label="Проект" value={optionName(state.redmine.projects, state.workspace.defaultProjectId)} />
            <InfoLine label="Tracker" value={optionName(state.redmine.trackers, state.workspace.defaultTrackerId)} />
            <InfoLine label="Priority" value={optionName(state.redmine.priorities, state.workspace.defaultPriorityId)} />
            <InfoLine label="Спринт" value={optionName(state.redmine.sprints, state.workspace.defaultSprintId)} />
            <InfoLine label="Исполнитель" value={optionName(state.redmine.users, state.workspace.defaultAssigneeId)} />
          </div>
          <div className="actions">
            <button className="primary-action" disabled={!readyForMainFlow} onClick={onFinish} type="button">
              Начать работу
            </button>
            {!readyForMainFlow && <span className="selection-summary">Завершите обязательные шаги настройки.</span>}
          </div>
        </section>
      )}

    </>
  );

  if (firstRun) {
    return (
      <div className="setup-wizard">
        <header className="setup-wizard-header">
          <div className="brand">
            <img className="brand-mark" src={appIcon} alt="" />
            <div>
              <h1>Workspace</h1>
              <p>Первый запуск</p>
            </div>
          </div>
          <div className="setup-wizard-status">
            <StatusPill label="Telegram" status={state.telegram.status} />
            <StatusPill label="Redmine" status={state.redmine.status} />
            <StatusPill label="GitLab" status={state.gitlab.status} />
            <StatusPill label="Катя" status={katyaConfigured ? 'connected' : 'disconnected'} />
          </div>
        </header>

        <div className="setup-wizard-layout">
          <aside className="setup-wizard-steps" aria-label="Шаги первичной настройки">
            <p>Мастер настройки</p>
            <h2>{currentStepLabel}</h2>
            {renderedStepButtons}
          </aside>
          <section className="setup-wizard-content" aria-label={`Шаг настройки: ${currentStepLabel}`}>
            {content}
          </section>
        </div>
      </div>
    );
  }

  return (
    <>
      {renderedStepButtons}
      {content}
    </>
  );
}

export function TelegramConnectPanel({
  busy,
  state,
  runAction,
  next
}: {
  busy: boolean;
  state: AppState;
  runAction: (action: () => Promise<AppState>, success?: string) => Promise<AppState | null>;
  next: (state: AppState) => void;
}) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [proxyUrl, setProxyUrl] = useState(telegramDefaultProxyUrl);
  const [authStatus, setAuthStatus] = useState('');
  const [codeRequested, setCodeRequested] = useState(state.telegram.codeRequested);
  const [setupStage, setSetupStage] = useState<TelegramSetupStage>(() => {
    if (state.telegram.status === 'connected') {
      return 'connected';
    }
    if (state.telegram.codeRequested) {
      return 'code';
    }
    if (state.telegram.hasApiCredentials) {
      return 'phone';
    }
    return 'prepare';
  });

  const telegramSetupSteps: Array<{ id: TelegramSetupStage; label: string }> = [
    { id: 'prepare', label: 'Подготовка' },
    { id: 'credentials', label: 'Ключи' },
    { id: 'phone', label: 'Телефон' },
    { id: 'code', label: 'Код' },
    { id: 'connected', label: 'Готово' }
  ];
  const currentStepIndex = telegramSetupSteps.findIndex((item) => item.id === setupStage);
  const hasCredentialsForRequest = state.telegram.hasApiCredentials || Boolean(apiId.trim() && apiHash.trim());
  const telegramStageDone = (stage: TelegramSetupStage) => {
    if (stage === 'prepare') {
      return setupStage !== 'prepare' || state.telegram.status === 'connected';
    }
    if (stage === 'credentials') {
      return hasCredentialsForRequest || state.telegram.status === 'connected';
    }
    if (stage === 'phone') {
      return codeRequested || state.telegram.status === 'connected';
    }
    if (stage === 'code' || stage === 'connected') {
      return state.telegram.status === 'connected';
    }
    return false;
  };

  useEffect(() => {
    setCodeRequested(state.telegram.codeRequested);
    if (state.telegram.status === 'connected') {
      setSetupStage('connected');
      return;
    }
    if (state.telegram.codeRequested) {
      setSetupStage('code');
      return;
    }
    if (setupStage === 'connected') {
      setSetupStage(state.telegram.hasApiCredentials ? 'phone' : 'prepare');
    }
  }, [setupStage, state.telegram.codeRequested, state.telegram.hasApiCredentials, state.telegram.status]);

  function canOpenTelegramStage(stage: TelegramSetupStage) {
    if (stage === 'prepare' || stage === 'credentials') {
      return true;
    }
    if (stage === 'phone') {
      return Boolean(hasCredentialsForRequest);
    }
    if (stage === 'code') {
      return codeRequested;
    }
    return state.telegram.status === 'connected';
  }

  function requestCode() {
    setAuthStatus('Подключаюсь к Telegram и запрашиваю код...');
    runAction(
      () => api.requestTelegramCode({
        apiId: apiId.trim(),
        apiHash: apiHash.trim(),
        phone: phone.trim(),
        proxyUrl: proxyUrl.trim()
      })
    ).then((result) => {
      if (result?.telegram.status === 'error') {
        setAuthStatus('');
        return;
      }
      if (result) {
        setCodeRequested(true);
        setSetupStage('code');
        setAuthStatus('Код отправлен. Проверьте Telegram app или SMS.');
      }
    });
  }

  function connectTelegram() {
    setAuthStatus('Проверяю код и загружаю диалоги...');
    runAction(
      () => api.connectTelegram({ code: code.trim(), password }),
      'Telegram подключен.'
    ).then((result) => {
      setAuthStatus('');
      if (result?.telegram.status === 'connected') {
        setSetupStage('connected');
        next(result);
      }
    });
  }

  return (
    <section className="panel telegram-setup-panel">
      <p className="panel-label">Telegram configuration</p>
      <h3>Подключение Telegram</h3>
      <p className="helper">
        Настройка идет по шагам: сначала получите ключи на Telegram Apps, затем введите телефон и код входа.
        MTProxy используется только для Telegram user-client, не для загрузки сайта.
      </p>
      <div className="telegram-setup-status">
        <span className={`telegram-status-dot ${state.telegram.status}`} aria-hidden="true" />
        <span>{state.telegram.status === 'connected' ? 'Сессия активна' : 'Ожидает подключения'}</span>
        {state.telegram.phoneMasked && <strong>{state.telegram.phoneMasked}</strong>}
      </div>

      <div className="telegram-setup">
        <nav className="telegram-setup-steps" aria-label="Шаги подключения Telegram">
          {telegramSetupSteps.map((item, index) => (
            <button
              key={item.id}
              type="button"
              className={[
                'telegram-setup-step',
                setupStage === item.id ? 'active' : '',
                telegramStageDone(item.id) ? 'complete' : '',
                index < currentStepIndex ? 'past' : ''
              ].join(' ')}
              disabled={!canOpenTelegramStage(item.id)}
              onClick={() => setSetupStage(item.id)}
            >
              <span className="telegram-step-index">{telegramStageDone(item.id) ? '✓' : index + 1}</span>
              <span className="telegram-step-label">{item.label}</span>
            </button>
          ))}
        </nav>

        <div className={`telegram-setup-body ${setupStage}`}>
          {setupStage === 'prepare' && (
            <>
              <p className="inline-hint">
                MTProxy нужен для подключения Telegram user-client после ввода ключей. Страница{' '}
                <button className="inline-text-button" type="button" onClick={() => api.openExternal(telegramAppsUrl)}>
                  my.telegram.org/apps
                </button>{' '}
                открывается как обычный HTTPS-сайт, поэтому для нее нужен системный VPN или HTTP/SOCKS proxy.
              </p>
              <div className="form-grid">
                <label className="wide">
                  <span>Telegram proxy для user-client</span>
                  <input
                    value={proxyUrl}
                    onChange={(event) => setProxyUrl(event.target.value)}
                    placeholder={telegramDefaultProxyUrl}
                  />
                </label>
              </div>
              <div className="actions">
                <button className="primary-action" type="button" onClick={() => setSetupStage('credentials')}>
                  Далее
                </button>
                {state.telegram.hasApiCredentials && (
                  <button className="secondary-action" type="button" onClick={() => setSetupStage('phone')}>
                    Использовать сохраненные ключи
                  </button>
                )}
              </div>
            </>
          )}

          {setupStage === 'credentials' && (
            <>
              <p className="inline-hint">
                Создайте приложение в Telegram Apps внутри Workspace, затем перенесите сюда `api_id` и `api_hash`.
              </p>
              <div className="telegram-apps-setup">
                <div className="telegram-apps-browser">
                  <Browser url={telegramAppsUrl} showToolbar />
                </div>
                <div className="telegram-apps-fields">
                  <div className="form-grid">
                    <label className="wide">
                      <span>Telegram api_id</span>
                      <input value={apiId} onChange={(event) => setApiId(event.target.value)} placeholder="123456" />
                    </label>
                    <label className="wide">
                      <span>Telegram api_hash</span>
                      <input
                        type="password"
                        value={apiHash}
                        onChange={(event) => setApiHash(event.target.value)}
                        placeholder={state.telegram.hasApiCredentials ? 'Сохранен в защищенном хранилище' : 'api_hash'}
                      />
                    </label>
                  </div>
                  <div className="actions">
                    <button
                      className="primary-action"
                      disabled={!hasCredentialsForRequest}
                      type="button"
                      onClick={() => setSetupStage('phone')}
                    >
                      Далее
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}

          {setupStage === 'phone' && (
            <>
              <p className="inline-hint">
                Введите телефон аккаунта Telegram. Код придет в Telegram app, SMS или другим способом,
                который вернет Telegram.
              </p>
              <div className="form-grid">
                <label className="wide">
                  <span>Номер телефона</span>
                  <input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+7..." />
                </label>
              </div>
              <div className="actions">
                <button className="secondary-action" type="button" onClick={() => setSetupStage('credentials')}>
                  Назад к ключам
                </button>
                <button
                  className="primary-action"
                  disabled={busy || !phone.trim() || !hasCredentialsForRequest}
                  type="button"
                  onClick={requestCode}
                >
                  {busy ? 'Запрашиваю...' : 'Далее'}
                </button>
              </div>
            </>
          )}

          {setupStage === 'code' && (
            <>
              <p className="inline-hint">
                Код запрошен через Telegram{state.telegram.codeDelivery ? ` (${state.telegram.codeDelivery})` : ''}.
                Введите полученный код. Если Telegram запросит cloud password, заполните поле 2FA.
              </p>
              <div className="form-grid">
                <label>
                  <span>Код подтверждения</span>
                  <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="12345" />
                </label>
                <label>
                  <span>2FA пароль</span>
                  <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
                </label>
              </div>
              <div className="actions">
                <button className="secondary-action" type="button" onClick={() => setSetupStage('phone')}>
                  Изменить телефон
                </button>
                <button
                  className="primary-action"
                  disabled={busy || !code.trim()}
                  type="button"
                  onClick={connectTelegram}
                >
                  {busy ? 'Проверяю...' : 'Далее'}
                </button>
              </div>
            </>
          )}

          {setupStage === 'connected' && (
            <>
              <div className="telegram-connected-summary">
                <div>
                  <strong>Telegram подключен</strong>
                  <span>
                    {state.telegram.phoneMasked
                      ? `Сохраненная сессия: ${state.telegram.phoneMasked}`
                      : 'Сессия сохранена в защищенном хранилище'}
                  </span>
                </div>
                <span className="telegram-connected-mark">OK</span>
              </div>
              <p className="inline-hint">
                Telegram подключен. Можно обновить диалоги, перейти к выбору рабочих чатов или отключить сессию.
              </p>
              <div className="actions">
                <button
                  className="secondary-action"
                  disabled={busy || state.telegram.status !== 'connected'}
                  type="button"
                  onClick={() => runAction(api.syncTelegram, 'Telegram-сообщения обновлены.')}
                >
                  Синхронизировать
                </button>
                <button className="primary-action" disabled={busy} type="button" onClick={() => next(state)}>
                  Далее: рабочие чаты
                </button>
                <button
                  className="danger-action"
                  disabled={busy || state.telegram.status === 'disconnected'}
                  type="button"
                  onClick={() => runAction(api.disconnectTelegram, 'Telegram отключен.')}
                >
                  Отключить Telegram
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {authStatus && <p className="inline-hint">{authStatus}</p>}
      {state.telegram.error && <p className="error-text">{state.telegram.error}</p>}
    </section>
  );
}

export function ChatSelectionPanel({
  busy,
  state,
  runAction,
  next
}: {
  busy: boolean;
  state: AppState;
  runAction: (action: () => Promise<AppState>, success?: string) => Promise<AppState | null>;
  next?: () => void;
}) {
  const [folderId, setFolderId] = useState(state.telegram.selectedFolderId);
  const [chatIds, setChatIds] = useState(state.telegram.chats.filter((chat) => chat.selected).map((chat) => chat.id));

  useEffect(() => {
    setFolderId(state.telegram.selectedFolderId);
    setChatIds(state.telegram.chats.filter((chat) => chat.selected).map((chat) => chat.id));
  }, [state.telegram.chats, state.telegram.selectedFolderId]);

  function applyFolder(nextFolderId: string) {
    setFolderId(nextFolderId);
    const folder = state.telegram.folders.find((item) => item.id === nextFolderId);
    if (folder) {
      setChatIds(folder.chatIds);
    }
  }

  return (
    <section className="panel chat-selection-panel">
      <p className="panel-label">Рабочие чаты</p>
      <h3>Папка Telegram или ручной выбор</h3>
      <p className="helper">
        Если папки не появились после входа, обновите данные из Telegram. Папки с пустым набором
        доступных диалогов не показываются.
      </p>
      <div className="form-grid">
        <label>
          <span>Папка</span>
          <select value={folderId ?? ''} onChange={(event) => applyFolder(event.target.value)}>
            <option value="">Ручной выбор</option>
            {state.telegram.folders.map((folder) => (
              <option key={folder.id} value={folder.id}>{folder.title}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="actions compact-actions">
        <button
          className="secondary-action"
          disabled={busy || state.telegram.status !== 'connected'}
          onClick={() => runAction(api.syncTelegram, 'Telegram-папки и чаты обновлены.')}
        >
          Обновить из Telegram
        </button>
        <button className="secondary-action" disabled={busy} onClick={() => setChatIds(state.telegram.chats.map((chat) => chat.id))}>
          Выбрать все
        </button>
        <button className="secondary-action" disabled={busy} onClick={() => setChatIds([])}>
          Снять все
        </button>
      </div>
      <div className="check-list">
        {state.telegram.chats.map((chat) => (
          <label key={chat.id} className="check-row">
            <input
              type="checkbox"
              checked={chatIds.includes(chat.id)}
              onChange={(event) => {
                setFolderId(null);
                setChatIds((current) =>
                  event.target.checked ? [...current, chat.id] : current.filter((id) => id !== chat.id)
                );
              }}
            />
            <span>{chat.title}</span>
            <small>{chat.type}</small>
          </label>
        ))}
      </div>
      <div className="actions sticky-actions">
        <span className="selection-summary">Выбрано: {chatIds.length}</span>
        <button
          className="primary-action"
          disabled={busy || chatIds.length === 0}
          onClick={() =>
            runAction(
              () => api.selectTelegramWorkspace({ folderId, chatIds }),
              'Рабочие чаты сохранены.'
            ).then((result) => {
              if (result) {
                next?.();
              }
            })
          }
        >
          Применить
        </button>
      </div>
    </section>
  );
}

export function RedminePanel({
  busy,
  state,
  runAction,
  onState,
  next
}: {
  busy: boolean;
  state: AppState;
  runAction: (action: () => Promise<AppState>, success?: string) => Promise<AppState | null>;
  onState: (state: AppState) => void;
  next?: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState(state.redmine.baseUrl || 'https://redmine.example.com/');
  const [apiKey, setApiKey] = useState('');

  return (
    <section className="panel">
      <p className="panel-label">Redmine configuration</p>
      <h3>Подключение Redmine</h3>
      <p className="helper">
        Откройте страницу аккаунта Redmine и скопируйте значение из поля API-ключ.
        <button className="link-button" onClick={() => api.openExternal(redmineHelpUrl)}>
          {redmineHelpUrl}
        </button>
      </p>
      <div className="form-grid">
        <label>
          <span>Redmine URL</span>
          <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
        </label>
        <label>
          <span>API key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={state.redmine.hasApiKey ? 'Ключ сохранен в защищенном хранилище' : 'Введите API key'}
          />
        </label>
      </div>
      {state.redmine.error && <p className="error-text">{state.redmine.error}</p>}
      <div className="actions">
        <button
          className="primary-action"
          disabled={busy || (!apiKey && !state.redmine.hasApiKey)}
          onClick={() =>
            runAction(() => api.testRedmine({ baseUrl, apiKey })).then((nextState) => {
              if (nextState) {
                onState(nextState);
                if (nextState.redmine.status === 'connected') {
                  next?.();
                }
              }
            })
          }
        >
          Проверить и сохранить ключ
        </button>
      </div>
    </section>
  );
}

export function DefaultsPanel({
  busy,
  state,
  runAction,
  next
}: {
  busy: boolean;
  state: AppState;
  runAction: (action: () => Promise<AppState>, success?: string) => Promise<AppState | null>;
  next?: () => void;
}) {
  const [projectId, setProjectId] = useState(state.workspace.defaultProjectId);
  const [trackerId, setTrackerId] = useState(state.workspace.defaultTrackerId);
  const [priorityId, setPriorityId] = useState(state.workspace.defaultPriorityId);
  const [sprintId, setSprintId] = useState(state.workspace.defaultSprintId);
  const [assigneeId, setAssigneeId] = useState(state.workspace.defaultAssigneeId);
  const [baseUrl] = useState(state.redmine.baseUrl);

  return (
    <section className="panel">
      <p className="panel-label">Defaults</p>
      <h3>Проект, tracker, priority, спринт и исполнитель по умолчанию</h3>
      <div className="form-grid">
        <SelectField
          label="Проект"
          value={projectId}
          options={state.redmine.projects}
          onChange={(nextProjectId) => {
            setProjectId(nextProjectId);
            setSprintId('');
            setAssigneeId('');
            runAction(() => api.loadRedmineProjectUsers({ projectId: nextProjectId })).then((nextState) => {
              if (nextState) {
                setSprintId(nextState.workspace.defaultSprintId);
                setAssigneeId(nextState.workspace.defaultAssigneeId);
              }
            });
          }}
        />
        <SelectField label="Tracker" value={trackerId} options={state.redmine.trackers} onChange={setTrackerId} />
        <SelectField label="Priority" value={priorityId} options={state.redmine.priorities} onChange={setPriorityId} />
        <SelectField label="Спринт" value={sprintId} options={state.redmine.sprints} onChange={setSprintId} />
        <SearchableSelectField
          label="Исполнитель"
          value={assigneeId}
          options={state.redmine.users}
          onChange={setAssigneeId}
          placeholder="Найти исполнителя"
        />
      </div>
      {state.redmine.sprints.length === 0 && (
        <p className="inline-hint">
          Спринты не загружены. Для Redmine используется список Agile Sprints или версий выбранного проекта.
          {projectId && (
            <>
              {' '}
              <button
                className="link-button"
                disabled={busy}
                onClick={() => {
                  runAction(() => api.loadRedmineProjectUsers({ projectId })).then((nextState) => {
                    if (nextState) {
                      setSprintId(nextState.workspace.defaultSprintId);
                      setAssigneeId(nextState.workspace.defaultAssigneeId);
                    }
                  });
                }}
              >
                Обновить
              </button>
            </>
          )}
        </p>
      )}
      {state.redmine.error && <p className="error-text">{state.redmine.error}</p>}
      <div className="actions">
        <button
          className="primary-action"
          disabled={busy}
          onClick={() =>
            runAction(
              () =>
                api.saveRedmine({
                  baseUrl,
                  defaultProjectId: projectId,
                  defaultTrackerId: trackerId,
                  defaultPriorityId: priorityId,
                  defaultSprintId: sprintId,
                  defaultAssigneeId: assigneeId
                }),
              'Defaults сохранены.'
            ).then((nextState) => {
              if (nextState) {
                next?.();
              }
            })
          }
        >
          Сохранить defaults
        </button>
      </div>
    </section>
  );
}

function defaultsReady(state: AppState) {
  const trackerReady = state.redmine.trackers.length === 0 || Boolean(state.workspace.defaultTrackerId);
  const priorityReady = state.redmine.priorities.length === 0 || Boolean(state.workspace.defaultPriorityId);
  return Boolean(
    state.workspace.defaultProjectId &&
    trackerReady &&
    priorityReady &&
    state.workspace.defaultSprintId &&
    state.workspace.defaultAssigneeId
  );
}

export function KatyaPanel({
  busy,
  onConfiguredChange
}: {
  busy: boolean;
  onConfiguredChange?: (hasSession: boolean) => void;
}) {
  const [sessionCookie, setSessionCookie] = useState('');
  const [statusText, setStatusText] = useState('');
  const [hasSavedSession, setHasSavedSession] = useState(false);

  useEffect(() => {
    api.getKatyaSession()
      .then((savedSessionCookie) => {
        setHasSavedSession(Boolean(savedSessionCookie));
      })
      .catch(() => undefined);
  }, []);

  async function saveSession() {
    const trimmedSession = sessionCookie.trim();
    if (!trimmedSession) {
      setStatusText('Укажите callrec_session.');
      return;
    }

    setStatusText('Сохраняю сессию Кати...');
    try {
      await api.saveKatyaSession({ sessionCookie: trimmedSession });
      setSessionCookie('');
      setHasSavedSession(true);
      onConfiguredChange?.(true);
      setStatusText('Сессия Кати сохранена.');
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : 'Не удалось сохранить сессию Кати.');
    }
  }

  return (
    <section className="panel">
      <p className="panel-label">Meeting recordings</p>
      <h3>Сервис записи Катя</h3>
      <p className="helper">
        Сохраните `callrec_session` один раз. Вкладка встреч будет использовать его для списка записей,
        транскрипций и протоколов. Группа доступа указывается отдельно при приглашении Кати в конкретный созвон.
      </p>
      <div className="form-grid">
        <label className="wide">
          <span>callrec_session</span>
          <input
            type="password"
            value={sessionCookie}
            onChange={(event) => setSessionCookie(event.target.value)}
            placeholder={hasSavedSession ? 'Сессия сохранена в защищенном хранилище' : 'callrec_session=...'}
          />
        </label>
      </div>
      {statusText && <p className="inline-hint">{statusText}</p>}
      <div className="actions">
        <button
          className="primary-action"
          disabled={busy || !sessionCookie.trim()}
          onClick={saveSession}
          type="button"
        >
          Сохранить сессию
        </button>
        {hasSavedSession && <span className="selection-summary">Сессия сохранена</span>}
      </div>
    </section>
  );
}

export function LocalDataPanel({
  busy,
  state,
  runAction
}: {
  busy: boolean;
  state: AppState;
  runAction: (action: () => Promise<AppState>, success?: string) => Promise<AppState | null>;
}) {
  return (
    <section className="panel">
      <p className="panel-label">Privacy и security</p>
      <h3>Локальные данные</h3>
      <p className="helper">
        Рабочее состояние хранится локально. Секреты Redmine и Telegram не возвращаются в UI и лежат
        отдельно в зашифрованном Electron safeStorage-хранилище.
      </p>
      <div className="metric-grid">
        <InfoLine label="Создано задач" value={String(state.metrics.createdIssues)} />
      </div>
      <div className="actions">
        <button
          className="danger-action"
          disabled={busy}
          onClick={() => runAction(api.deleteLocalData, 'Локальные данные удалены.')}
        >
          Удалить локальные данные
        </button>
      </div>
    </section>
  );
}
