import { DefaultsPanel, KatyaPanel, RedminePanel, TelegramConnectPanel } from '../onboarding/Onboarding';
import { InfoLine } from '../../components/common';
import { api } from '../../domain/bridge';
import { GitLabPanel } from './GitLabPanel';
import { MailCredentialsPanel } from './MailCredentialsPanel';

export function Settings({
  busy,
  state,
  runAction,
  onState
}: {
  busy: boolean;
  state: AppState;
  runAction: (action: () => Promise<AppState>, success?: string) => Promise<AppState | null>;
  onState: (state: AppState) => void;
}) {
  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">Settings</p>
          <h2>Интеграции и локальные данные</h2>
        </div>
      </header>

      <div className="settings-grid">
        <TelegramConnectPanel busy={busy} state={state} runAction={runAction} next={() => undefined} />
        <RedminePanel busy={busy} state={state} runAction={runAction} onState={onState} />
        <GitLabPanel busy={busy} state={state} runAction={runAction} />
        <DefaultsPanel busy={busy} state={state} runAction={runAction} />
        <KatyaPanel busy={busy} />
        <MailCredentialsPanel busy={busy} />
        <section className="panel">
          <p className="panel-label">Privacy и security</p>
          <h3>Локальные данные</h3>
          <p className="helper">
            Рабочее состояние хранится локально. Секреты Redmine, Telegram и GitLab не возвращаются в UI и лежат
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
      </div>
    </>
  );
}
