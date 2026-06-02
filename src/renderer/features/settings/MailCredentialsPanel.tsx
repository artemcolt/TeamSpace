import { useEffect, useState } from 'react';
import { api } from '../../domain/bridge';

export function MailCredentialsPanel({ busy }: { busy: boolean }) {
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [hasPassword, setHasPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

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

  async function saveCredentials() {
    setSaving(true);
    setMessage('');
    setError('');
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
      setMessage('Данные почты сохранены.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Не удалось сохранить данные почты.');
    } finally {
      setSaving(false);
    }
  }

  async function deleteCredentials() {
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const status = await api.deleteMailCredentials();
      setUrl(status.url);
      setUsername(status.username);
      setPassword('');
      setHasPassword(status.hasPassword);
      setMessage('Данные почты удалены.');
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Не удалось удалить данные почты.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel">
      <p className="panel-label">Mail</p>
      <h3>Автозаполнение почты</h3>
      <p className="helper">
        Cookies почты сохраняются отдельно, но если сервер завершает сессию, сохраненные здесь данные будут
        подставлены в форму входа. Пароль хранится только в системном защищенном хранилище.
      </p>
      <label className="field">
        <span>Ссылка почты</span>
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://mail.example.com/"
        />
      </label>
      <label className="field">
        <span>Логин</span>
        <input
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          placeholder="Имя пользователя"
        />
      </label>
      <label className="field">
        <span>Пароль</span>
        <input
          autoComplete="current-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder={hasPassword ? 'Пароль сохранен' : 'Пароль'}
        />
      </label>
      {message && <p className="success-text">{message}</p>}
      {error && <p className="error-text">{error}</p>}
      <div className="actions">
        <button
          className="primary-action"
          disabled={busy || saving || !url.trim() || !username.trim() || (!password && !hasPassword)}
          onClick={() => void saveCredentials()}
        >
          {saving ? 'Сохраняем...' : 'Сохранить'}
        </button>
        <button
          className="secondary-action"
          disabled={busy || saving || !hasPassword}
          onClick={() => void deleteCredentials()}
        >
          Удалить данные
        </button>
      </div>
    </section>
  );
}
