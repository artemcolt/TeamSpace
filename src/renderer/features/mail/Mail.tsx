import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../domain/bridge';

type MailState = {
  canGoBack: boolean;
  loading: boolean;
  url: string;
  error: string;
};

function readBounds(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height
  };
}

export function Mail() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [mailState, setMailState] = useState<MailState>({
    canGoBack: false,
    loading: true,
    url: '',
    error: ''
  });
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [hasPassword, setHasPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [settingsMessage, setSettingsMessage] = useState('');

  const syncBounds = useCallback(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    void api.setMailBounds(readBounds(host));
  }, []);

  useEffect(() => api.onMailStateChanged(setMailState), []);

  useEffect(() => {
    let cancelled = false;
    api.getMailCredentialsStatus()
      .then((status) => {
        if (cancelled) {
          return;
        }
        setUrl(status.url);
        setUsername(status.username);
        setHasPassword(status.hasPassword);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!mailState.error) {
      return;
    }
    if (mailState.url) {
      setUrl(mailState.url);
    }
    void api.hideMailView();
  }, [mailState.error, mailState.url]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return undefined;
    }

    let animationFrame = window.requestAnimationFrame(() => {
      api.showMailView(readBounds(host)).then(setMailState).catch((error: unknown) => {
        setMailState({
          canGoBack: false,
          loading: false,
          url,
          error: error instanceof Error ? error.message : 'Не удалось открыть почту.'
        });
      });
    });

    const resizeObserver = new ResizeObserver(() => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(syncBounds);
    });
    resizeObserver.observe(host);
    window.addEventListener('resize', syncBounds);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      window.removeEventListener('resize', syncBounds);
      void api.hideMailView();
    };
  }, [syncBounds]);

  async function saveAndReloadMail() {
    const host = hostRef.current;
    setSaving(true);
    setSettingsError('');
    setSettingsMessage('');
    try {
      const status = await api.saveMailCredentials({
        url,
        username,
        password: password || undefined
      });
      setUrl(status.url);
      setUsername(status.username);
      setPassword('');
      setHasPassword(status.hasPassword);
      setSettingsMessage('Настройки почты сохранены.');
      setMailState({
        canGoBack: false,
        loading: true,
        url: status.url,
        error: ''
      });
      if (host) {
        const nextState = await api.showMailView(readBounds(host));
        setMailState(nextState);
      }
    } catch (saveError) {
      setSettingsError(saveError instanceof Error ? saveError.message : 'Не удалось сохранить настройки почты.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mail-layout">
      {mailState.error && (
        <section className="mail-fallback">
          <p className="panel-label">Mail</p>
          <h2>Почта не открылась</h2>
          <p className="mail-fallback-error">{mailState.error}</p>
          <div className="form-grid mail-settings-grid">
            <label className="wide">
              <span>Ссылка почты</span>
              <input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://mail.example.com/"
              />
            </label>
            <label>
              <span>Логин</span>
              <input
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="Имя пользователя"
              />
            </label>
            <label>
              <span>Пароль</span>
              <input
                autoComplete="current-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={hasPassword ? 'Пароль сохранен' : 'Пароль'}
              />
            </label>
          </div>
          {settingsMessage && <p className="success-text">{settingsMessage}</p>}
          {settingsError && <p className="error-text">{settingsError}</p>}
          <div className="actions">
            <button
              className="primary-action"
              disabled={saving || !url.trim() || !username.trim() || (!password && !hasPassword)}
              onClick={() => void saveAndReloadMail()}
              type="button"
            >
              {saving ? 'Сохраняем...' : 'Сохранить и открыть почту'}
            </button>
            <button
              className="secondary-action"
              disabled={!url.trim()}
              onClick={() => void api.openExternal(url)}
              type="button"
            >
              Открыть во внешнем браузере
            </button>
          </div>
        </section>
      )}
      {mailState.loading && !mailState.error && <div className="mail-loading">Загрузка почты...</div>}
      <div ref={hostRef} className={mailState.error ? 'mail-view-host hidden' : 'mail-view-host'} />
    </div>
  );
}
