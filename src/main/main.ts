import { app, BrowserView, BrowserWindow, desktopCapturer, ipcMain, net, Notification, protocol, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerIpcHandlers } from './ipc/registerIpcHandlers';
import { GitLabService } from './gitlab/gitlabService';
import { RedmineService } from './redmine/redmineService';
import { store } from './storage/localStore';
import { TelegramService, type TelegramNewMessageEvent } from './telegram/telegramService';
import { telegramUnreadNotificationCount } from './domain/appState';
import type { AppState } from './domain/types';

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const MAIL_URL = 'https://mail.example.com/';
const MAIL_HOSTNAME = 'mail.example.com';
const CHATGPT_URL = 'https://chatgpt.com/';
const CHATGPT_LOGIN_URL = 'https://chatgpt.com/auth/login';
const CHATGPT_PERSISTABLE_HOSTS = new Set([
  'chatgpt.com',
  'chat.openai.com',
  'auth.openai.com'
]);
const GOOGLE_AUTH_HOSTS = new Set([
  'accounts.google.com',
  'accounts.youtube.com'
]);
const APP_NAME = 'Workspace';
const USER_DATA_DIRECTORY_NAME = 'team-space-desktop';
const BROWSER_PROXY_ENV_KEY = 'TEAM_SPACE_BROWSER_PROXY_URL';
const BROWSER_PROXY_USERNAME_ENV_KEY = 'TEAM_SPACE_BROWSER_PROXY_USERNAME';
const BROWSER_PROXY_PASSWORD_ENV_KEY = 'TEAM_SPACE_BROWSER_PROXY_PASSWORD';

app.setName(APP_NAME);
app.setPath('userData', path.join(app.getPath('appData'), USER_DATA_DIRECTORY_NAME));
loadLocalEnv();

function loadLocalEnv(): void {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) {
      continue;
    }
    const separatorIndex = trimmedLine.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    let value = trimmedLine.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

function appIconPath(): string {
  const fileName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const devIcon = path.join(process.cwd(), 'build', fileName);
  if (isDev || fs.existsSync(devIcon)) {
    return devIcon;
  }
  return path.join(process.resourcesPath, fileName);
}

protocol.registerSchemesAsPrivileged([{
  scheme: 'teamspace-file',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true
  }
}]);

type ViewBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type StoredMailCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
  sameSite?: Electron.Cookie['sameSite'];
};

type StoredMailCredentials = {
  username: string;
  password: string;
};

let mainWindow: BrowserWindow | null = null;
let mailView: BrowserView | null = null;
let browserView: BrowserView | null = null;
let chatGptView: BrowserView | null = null;
let mailVisible = false;
let browserVisible = false;
let chatGptVisible = false;
let mailError = '';
let browserError = '';
let chatGptError = '';
let mailCookiesConfigured = false;

function mailSession(): Electron.Session {
  return session.fromPartition('persist:gts-mail');
}

function chatGptSession(): Electron.Session {
  return session.fromPartition('persist:chatgpt');
}

function isMailUrl(url: string): boolean {
  if (url === 'about:blank') {
    return true;
  }

  try {
    return new URL(url).hostname === MAIL_HOSTNAME;
  } catch {
    return false;
  }
}

function normalizeBounds(bounds: ViewBounds): ViewBounds {
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height))
  };
}

function serializeMailCookie(cookie: Electron.Cookie): StoredMailCookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.hostOnly ? undefined : cookie.domain,
    path: cookie.path || '/',
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    expirationDate: cookie.expirationDate,
    sameSite: cookie.sameSite
  };
}

function cookieSetDetails(cookie: StoredMailCookie): Electron.CookiesSetDetails {
  return {
    url: MAIL_URL,
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || '/',
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    expirationDate: cookie.expirationDate,
    sameSite: cookie.sameSite
  };
}

function readMailCredentials(): StoredMailCredentials | null {
  const rawCredentials = store.getSecret('gtsMailCredentials');
  if (!rawCredentials) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawCredentials) as Partial<StoredMailCredentials>;
    const username = typeof parsed.username === 'string' ? parsed.username : '';
    const password = typeof parsed.password === 'string' ? parsed.password : '';
    return username && password ? { username, password } : null;
  } catch {
    return null;
  }
}

function mailCredentialsStatus(): { username: string; hasPassword: boolean } {
  const credentials = readMailCredentials();
  return {
    username: credentials?.username ?? '',
    hasPassword: Boolean(credentials?.password)
  };
}

function saveMailCredentials(payload: { username: string; password?: string }): { username: string; hasPassword: boolean } {
  const username = payload.username.trim();
  const password = payload.password ?? '';
  const currentCredentials = readMailCredentials();
  const nextPassword = password || currentCredentials?.password || '';
  if (!username || !nextPassword) {
    throw new Error('Введите логин и пароль почты.');
  }

  store.setSecret('gtsMailCredentials', JSON.stringify({ username, password: nextPassword }));
  return mailCredentialsStatus();
}

function deleteMailCredentials(): { username: string; hasPassword: boolean } {
  store.deleteSecret('gtsMailCredentials');
  return mailCredentialsStatus();
}

async function autofillMailLogin(): Promise<void> {
  const credentials = readMailCredentials();
  if (!credentials || !mailView || mailView.webContents.isDestroyed()) {
    return;
  }

  const script = `
    (() => {
      const username = ${JSON.stringify(credentials.username)};
      const password = ${JSON.stringify(credentials.password)};
      const setValue = (input, value) => {
        if (!input || input.value === value) return;
        const prototype = Object.getPrototypeOf(input);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
        if (descriptor?.set) {
          descriptor.set.call(input, value);
        } else {
          input.value = value;
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const visible = (input) => {
        const rect = input.getBoundingClientRect();
        const style = window.getComputedStyle(input);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const inputs = Array.from(document.querySelectorAll('input')).filter(visible);
      const passwordInput = inputs.find((input) => input.type === 'password');
      const usernameInput =
        document.querySelector('input[name="_user"], input[name="user"], input[name="username"], input[name="login"], input[type="email"]') ||
        inputs.find((input) => input !== passwordInput && ['text', 'email', ''].includes(input.type));
      setValue(usernameInput, username);
      setValue(passwordInput, password);
      const rememberInput = inputs.find((input) =>
        input.type === 'checkbox' &&
        /remember|save|keep|session|stay/i.test([input.name, input.id, input.autocomplete].filter(Boolean).join(' '))
      );
      if (rememberInput && !rememberInput.checked) {
        rememberInput.click();
      }
      return Boolean(usernameInput && passwordInput);
    })();
  `;

  await mailView.webContents.executeJavaScript(script, true).catch(() => undefined);
}

async function persistMailCookies(): Promise<void> {
  try {
    const cookies = await mailSession().cookies.get({ url: MAIL_URL });
    store.setSecret('gtsMailCookies', JSON.stringify(cookies.map(serializeMailCookie)));
    await mailSession().cookies.flushStore();
  } catch {
    // Cookie persistence is a convenience; the mail view can still work without it.
  }
}

async function restoreMailCookies(): Promise<void> {
  const rawCookies = store.getSecret('gtsMailCookies');
  if (!rawCookies) {
    return;
  }

  let cookies: StoredMailCookie[] = [];
  try {
    const parsed = JSON.parse(rawCookies);
    cookies = Array.isArray(parsed) ? parsed : [];
  } catch {
    return;
  }

  const now = Date.now() / 1000;
  const cookieStore = mailSession().cookies;
  for (const cookie of cookies) {
    if (!cookie.name || (cookie.expirationDate && cookie.expirationDate <= now)) {
      continue;
    }
    await cookieStore.set(cookieSetDetails(cookie)).catch(() => undefined);
  }
  await cookieStore.flushStore().catch(() => undefined);
}

function configureMailCookies(): void {
  if (mailCookiesConfigured) {
    return;
  }

  mailCookiesConfigured = true;
  mailSession().cookies.on('changed', (_event, cookie, _cause, removed) => {
    if (!cookie.domain?.includes(MAIL_HOSTNAME) && !cookie.domain?.includes('example.com')) {
      return;
    }

    if (removed) {
      void persistMailCookies();
      return;
    }

    void persistMailCookies();
  });
}

function sendMailState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('mail:state-changed', {
    canGoBack: mailView?.webContents.navigationHistory.canGoBack() ?? false,
    loading: mailView?.webContents.isLoading() ?? false,
    error: mailError
  });
}

function sendBrowserState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('browser:state-changed', {
    canGoBack: browserView?.webContents.navigationHistory.canGoBack() ?? false,
    loading: browserView?.webContents.isLoading() ?? false,
    url: browserView?.webContents.getURL() ?? '',
    error: browserError
  });
}

function sendChatGptState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('chatgpt:state-changed', {
    canGoBack: chatGptView?.webContents.navigationHistory.canGoBack() ?? false,
    loading: chatGptView?.webContents.isLoading() ?? false,
    url: chatGptView?.webContents.getURL() ?? '',
    error: chatGptError
  });
}

function isBrowserUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function chromeLikeUserAgent(): string {
  const platformToken = process.platform === 'win32'
    ? 'Windows NT 10.0; Win64; x64'
    : process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
}

function isChatGptPersistableUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return (
      (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') &&
      CHATGPT_PERSISTABLE_HOSTS.has(parsedUrl.hostname)
    );
  } catch {
    return false;
  }
}

function isGoogleAuthUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return (
      (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') &&
      GOOGLE_AUTH_HOSTS.has(parsedUrl.hostname)
    );
  } catch {
    return false;
  }
}

function readChatGptStartUrl(): string {
  const lastUrl = store.getSecret('chatGptLastUrl');
  return lastUrl && isChatGptPersistableUrl(lastUrl) ? lastUrl : CHATGPT_URL;
}

function persistChatGptUrl(url: string): void {
  if (!isChatGptPersistableUrl(url)) {
    return;
  }

  try {
    store.setSecret('chatGptLastUrl', url);
  } catch {
    // Last URL persistence is optional; cookies and local storage remain in the persistent partition.
  }
}

function loadChatGptUrl(view: BrowserView, url: string): void {
  void view.webContents.loadURL(url, { userAgent: chromeLikeUserAgent() });
}

function openGoogleAuthExternally(): void {
  chatGptError = 'Google блокирует вход во встроенных окнах. Откройте ChatGPT во внешнем браузере, войдите там и задайте пароль в Settings -> Account. Затем вернитесь сюда и войдите по email и паролю.';
  sendChatGptState();
  void shell.openExternal(CHATGPT_LOGIN_URL);
}

function createBrowserView(): BrowserView {
  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:team-browser',
      sandbox: true
    }
  });
  configureBrowserProxy(view.webContents.session);

  view.webContents.setWindowOpenHandler(({ url }) => {
    if (isBrowserUrl(url)) {
      void view.webContents.loadURL(url);
    }
    return { action: 'deny' };
  });
  view.webContents.on('will-navigate', (event, url) => {
    if (isBrowserUrl(url)) {
      return;
    }
    event.preventDefault();
  });
  view.webContents.on('did-start-loading', () => {
    browserError = '';
    sendBrowserState();
  });
  view.webContents.on('did-stop-loading', sendBrowserState);
  view.webContents.on('did-navigate', sendBrowserState);
  view.webContents.on('did-navigate-in-page', sendBrowserState);
  view.webContents.on('did-fail-load', (_event, _errorCode, errorDescription, validatedURL) => {
    if (validatedURL === 'about:blank') {
      return;
    }
    browserError = errorDescription || 'Не удалось загрузить страницу.';
    sendBrowserState();
  });
  view.webContents.on('login', (event, _details, authInfo, callback) => {
    const username = process.env[BROWSER_PROXY_USERNAME_ENV_KEY]?.trim();
    const password = process.env[BROWSER_PROXY_PASSWORD_ENV_KEY]?.trim();
    if (!authInfo.isProxy || !username || !password) {
      return;
    }

    event.preventDefault();
    callback(username, password);
  });

  return view;
}

function configureBrowserProxy(browserSession: Electron.Session): void {
  const proxyRules = process.env[BROWSER_PROXY_ENV_KEY]?.trim();
  if (!proxyRules) {
    return;
  }

  void browserSession.setProxy({
    proxyRules,
    proxyBypassRules: '<local>'
  }).then(() => browserSession.closeAllConnections()).catch((error: unknown) => {
    browserError = error instanceof Error ? error.message : 'Не удалось применить proxy для встроенного браузера.';
  });
}

function warmUpBrowserView(): void {
  if (!browserView || browserView.webContents.isDestroyed()) {
    browserView = createBrowserView();
  }
}

function showBrowserView(bounds: ViewBounds, url?: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  warmUpBrowserView();
  const view = browserView;
  if (!view) {
    return;
  }

  hideMailView();
  hideChatGptView();
  if (!mainWindow.getBrowserViews().includes(view)) {
    mainWindow.addBrowserView(view);
  }

  browserVisible = true;
  view.setBounds(normalizeBounds(bounds));
  if (url && isBrowserUrl(url) && view.webContents.getURL() !== url) {
    void view.webContents.loadURL(url);
  }
  sendBrowserState();
}

function hideBrowserView(): void {
  if (mainWindow && browserView && mainWindow.getBrowserViews().includes(browserView)) {
    mainWindow.removeBrowserView(browserView);
  }
  browserVisible = false;
}

function createChatGptView(): BrowserView {
  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:chatgpt',
      sandbox: true
    }
  });
  view.webContents.setUserAgent(chromeLikeUserAgent());

  view.webContents.setWindowOpenHandler(({ url }) => {
    if (isGoogleAuthUrl(url)) {
      openGoogleAuthExternally();
      return { action: 'deny' };
    }
    if (isBrowserUrl(url)) {
      loadChatGptUrl(view, url);
    }
    return { action: 'deny' };
  });
  view.webContents.on('will-navigate', (event, url) => {
    if (isGoogleAuthUrl(url)) {
      event.preventDefault();
      openGoogleAuthExternally();
      return;
    }
    if (isBrowserUrl(url)) {
      return;
    }
    event.preventDefault();
  });
  view.webContents.on('will-redirect', (event, url) => {
    if (isGoogleAuthUrl(url)) {
      event.preventDefault();
      openGoogleAuthExternally();
      return;
    }
    if (isBrowserUrl(url)) {
      return;
    }
    event.preventDefault();
  });
  view.webContents.on('did-start-loading', () => {
    chatGptError = '';
    sendChatGptState();
  });
  view.webContents.on('did-stop-loading', sendChatGptState);
  view.webContents.on('did-navigate', (_event, url) => {
    persistChatGptUrl(url);
    if (url.includes('auth.openai.com') && url.includes('error')) {
      chatGptError = 'Сессия входа ChatGPT устарела. Сбросьте встроенную сессию и начните вход заново.';
    }
    sendChatGptState();
  });
  view.webContents.on('did-navigate-in-page', (_event, url) => {
    persistChatGptUrl(url);
    if (url.includes('auth.openai.com') && url.includes('error')) {
      chatGptError = 'Сессия входа ChatGPT устарела. Сбросьте встроенную сессию и начните вход заново.';
    }
    sendChatGptState();
  });
  view.webContents.on('did-fail-load', (_event, _errorCode, errorDescription, validatedURL) => {
    if (validatedURL === 'about:blank') {
      return;
    }
    chatGptError = errorDescription || 'Не удалось загрузить ChatGPT.';
    sendChatGptState();
  });
  loadChatGptUrl(view, readChatGptStartUrl());

  return view;
}

function warmUpChatGptView(): void {
  if (!chatGptView || chatGptView.webContents.isDestroyed()) {
    chatGptView = createChatGptView();
  }
}

function showChatGptView(bounds: ViewBounds): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  warmUpChatGptView();
  const view = chatGptView;
  if (!view) {
    return;
  }

  hideMailView();
  hideBrowserView();
  if (!mainWindow.getBrowserViews().includes(view)) {
    mainWindow.addBrowserView(view);
  }

  chatGptVisible = true;
  view.setBounds(normalizeBounds(bounds));
  if (!view.webContents.getURL() || view.webContents.getURL() === 'about:blank') {
    loadChatGptUrl(view, readChatGptStartUrl());
  }
  sendChatGptState();
}

function hideChatGptView(): void {
  if (mainWindow && chatGptView && mainWindow.getBrowserViews().includes(chatGptView)) {
    mainWindow.removeBrowserView(chatGptView);
  }

  chatGptVisible = false;
  const currentUrl = chatGptView?.webContents.getURL();
  if (currentUrl) {
    persistChatGptUrl(currentUrl);
  }
}

async function resetChatGptSession(): Promise<void> {
  const wasVisible = chatGptVisible;
  const currentBounds = chatGptView?.getBounds();

  if (mainWindow && chatGptView && mainWindow.getBrowserViews().includes(chatGptView)) {
    mainWindow.removeBrowserView(chatGptView);
  }
  if (chatGptView && !chatGptView.webContents.isDestroyed()) {
    chatGptView.webContents.close({ waitForBeforeUnload: false });
  }
  chatGptView = null;
  chatGptVisible = false;
  chatGptError = '';

  store.deleteSecret('chatGptLastUrl');
  await chatGptSession().clearStorageData();
  await chatGptSession().clearCache();

  warmUpChatGptView();
  if (wasVisible && currentBounds) {
    showChatGptView(currentBounds);
  } else {
    sendChatGptState();
  }
}

function createMailView(): BrowserView {
  configureMailCookies();
  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:gts-mail',
      sandbox: true
    }
  });

  view.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  view.webContents.on('will-navigate', (event, url) => {
    if (isMailUrl(url)) {
      return;
    }

    event.preventDefault();
    shell.openExternal(url);
  });
  view.webContents.on('did-start-loading', () => {
    mailError = '';
    sendMailState();
  });
  view.webContents.on('dom-ready', () => {
    void autofillMailLogin();
  });
  view.webContents.on('did-finish-load', () => {
    void autofillMailLogin();
  });
  view.webContents.on('did-stop-loading', sendMailState);
  view.webContents.on('did-navigate', sendMailState);
  view.webContents.on('did-navigate-in-page', sendMailState);
  view.webContents.on('did-fail-load', (_event, _errorCode, errorDescription, validatedURL) => {
    if (validatedURL === 'about:blank') {
      return;
    }

    mailError = errorDescription || 'Не удалось загрузить почту.';
    sendMailState();
  });
  restoreMailCookies()
    .then(() => view.webContents.loadURL(MAIL_URL))
    .catch((error: unknown) => {
    mailError = error instanceof Error ? error.message : 'Не удалось загрузить почту.';
    sendMailState();
  });

  return view;
}

function warmUpMailView(): void {
  if (!mailView || mailView.webContents.isDestroyed()) {
    mailView = createMailView();
  }
}

function showMailView(bounds: ViewBounds): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  warmUpMailView();
  const view = mailView;
  if (!view) {
    return;
  }

  if (!mainWindow.getBrowserViews().includes(view)) {
    mainWindow.addBrowserView(view);
  }

  hideBrowserView();
  hideChatGptView();
  mailVisible = true;
  view.setBounds(normalizeBounds(bounds));
  sendMailState();
}

function hideMailView(): void {
  if (mainWindow && mailView && mainWindow.getBrowserViews().includes(mailView)) {
    mainWindow.removeBrowserView(mailView);
  }

  mailVisible = false;
  void persistMailCookies();
}

function registerMailViewIpc(): void {
  ipcMain.handle('mail:show', (_event, bounds: ViewBounds) => {
    showMailView(bounds);
    return {
      canGoBack: mailView?.webContents.navigationHistory.canGoBack() ?? false,
      loading: mailView?.webContents.isLoading() ?? false,
      error: mailError
    };
  });

  ipcMain.handle('mail:set-bounds', (_event, bounds: ViewBounds) => {
    if (mailVisible && mailView) {
      mailView.setBounds(normalizeBounds(bounds));
    }
  });

  ipcMain.handle('mail:hide', () => hideMailView());

  ipcMain.handle('mail:go-back', () => {
    if (mailView?.webContents.navigationHistory.canGoBack()) {
      mailView.webContents.navigationHistory.goBack();
    }
    sendMailState();
  });

  ipcMain.handle('mail:reload', () => {
    mailView?.webContents.reload();
    sendMailState();
  });

  ipcMain.handle('mail:get-credentials-status', () => mailCredentialsStatus());

  ipcMain.handle('mail:save-credentials', (_event, payload: { username: string; password?: string }) => {
    const result = saveMailCredentials(payload);
    void autofillMailLogin();
    return result;
  });

  ipcMain.handle('mail:delete-credentials', () => deleteMailCredentials());
}

function registerBrowserViewIpc(): void {
  ipcMain.handle('browser:show', (_event, payload: { bounds: ViewBounds; url?: string }) => {
    showBrowserView(payload.bounds, payload.url);
    return {
      canGoBack: browserView?.webContents.navigationHistory.canGoBack() ?? false,
      loading: browserView?.webContents.isLoading() ?? false,
      url: browserView?.webContents.getURL() ?? '',
      error: browserError
    };
  });

  ipcMain.handle('browser:set-bounds', (_event, bounds: ViewBounds) => {
    if (browserVisible && browserView) {
      browserView.setBounds(normalizeBounds(bounds));
    }
  });

  ipcMain.handle('browser:hide', () => hideBrowserView());

  ipcMain.handle('browser:go-back', () => {
    if (browserView?.webContents.navigationHistory.canGoBack()) {
      browserView.webContents.navigationHistory.goBack();
    }
    sendBrowserState();
  });

  ipcMain.handle('browser:reload', () => {
    browserView?.webContents.reload();
    sendBrowserState();
  });
}

function registerChatGptViewIpc(): void {
  ipcMain.handle('chatgpt:show', (_event, bounds: ViewBounds) => {
    showChatGptView(bounds);
    return {
      canGoBack: chatGptView?.webContents.navigationHistory.canGoBack() ?? false,
      loading: chatGptView?.webContents.isLoading() ?? false,
      url: chatGptView?.webContents.getURL() ?? '',
      error: chatGptError
    };
  });

  ipcMain.handle('chatgpt:set-bounds', (_event, bounds: ViewBounds) => {
    if (chatGptVisible && chatGptView) {
      chatGptView.setBounds(normalizeBounds(bounds));
    }
  });

  ipcMain.handle('chatgpt:hide', () => hideChatGptView());

  ipcMain.handle('chatgpt:go-back', () => {
    if (chatGptView?.webContents.navigationHistory.canGoBack()) {
      chatGptView.webContents.navigationHistory.goBack();
    }
    sendChatGptState();
  });

  ipcMain.handle('chatgpt:reload', () => {
    chatGptView?.webContents.reload();
    sendChatGptState();
  });

  ipcMain.handle('chatgpt:reset-session', async () => {
    await resetChatGptSession();
    return {
      canGoBack: chatGptView?.webContents.navigationHistory.canGoBack() ?? false,
      loading: chatGptView?.webContents.isLoading() ?? false,
      url: chatGptView?.webContents.getURL() ?? '',
      error: chatGptError
    };
  });
}

function configureDisplayMedia(): void {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission !== 'media') {
      callback(false);
      return;
    }

    const requestingUrl = details.requestingUrl || webContents.getURL();
    try {
      const { hostname, protocol } = new URL(requestingUrl);
      callback(
        protocol === 'file:' ||
        hostname === '127.0.0.1' ||
        hostname === 'localhost' ||
        hostname.endsWith('telemost.yandex.ru') ||
        hostname.endsWith('yandex.ru')
      );
    } catch {
      callback(false);
    }
  });

  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).then((sources) => {
        const firstScreen = sources[0];
        if (!firstScreen) {
          callback({});
          return;
        }

        callback({
          video: firstScreen,
          audio: process.platform === 'win32' ? 'loopback' : undefined
        });
      }).catch(() => callback({}));
    },
    { useSystemPicker: true }
  );
}

function configureLocalFileProtocol(): void {
  protocol.handle('teamspace-file', (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'telegram') {
        return new Response('Not found', { status: 404 });
      }

      const encodedPath = url.pathname.replace(/^\/+/, '');
      const filePath = Buffer.from(encodedPath, 'base64url').toString('utf8');
      const allowedDirectory = path.resolve(app.getPath('downloads'), 'Team Space Telegram Files');
      const resolvedFilePath = path.resolve(filePath);
      if (resolvedFilePath !== allowedDirectory && !resolvedFilePath.startsWith(`${allowedDirectory}${path.sep}`)) {
        return new Response('Forbidden', { status: 403 });
      }

      return net.fetch(pathToFileURL(resolvedFilePath).toString());
    } catch {
      return new Response('Bad request', { status: 400 });
    }
  });
}

function createMainWindow(): void {
  const icon = appIconPath();
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(icon);
  }

  const window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: APP_NAME,
    icon,
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow = window;

  window.on('closed', () => {
    if (mainWindow === window) {
      const currentChatGptUrl = chatGptView?.webContents.getURL();
      if (currentChatGptUrl) {
        persistChatGptUrl(currentChatGptUrl);
      }
      void persistMailCookies();
      mainWindow = null;
      mailView = null;
      browserView = null;
      chatGptView = null;
      mailVisible = false;
      browserVisible = false;
      chatGptVisible = false;
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    window.loadURL(process.env.VITE_DEV_SERVER_URL);
    return;
  }

  window.loadFile(path.join(__dirname, '../dist/renderer/index.html'));
}

function sendStateChanged(state: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('app:state-changed', state);
  }
}

function updateAppBadge(state: AppState): void {
  const unreadCount = telegramUnreadNotificationCount(state.telegram);

  try {
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setBadge(unreadCount > 0 ? String(unreadCount) : '');
      return;
    }

    app.setBadgeCount(unreadCount);
  } catch (error) {
    console.warn('Failed to update app badge:', error);
  }
}

function focusMainWindow(): void {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) {
    createMainWindow();
    return;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
}

function truncateNotificationText(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function showTelegramNotification(event: TelegramNewMessageEvent): void {
  if (!Notification.isSupported()) {
    return;
  }

  const title = event.chat.type === 'private'
    ? event.message.senderName
    : `${event.chat.title}: ${event.message.senderName}`;
  const notification = new Notification({
    title,
    body: truncateNotificationText(event.message.text || ((event.message.attachments?.length ?? 0) > 0 ? 'Вложение' : ''))
  });
  notification.on('click', focusMainWindow);
  notification.show();
}

app.whenReady().then(async () => {
  await store.initialize();
  store.onStateChanged(updateAppBadge);
  updateAppBadge(store.getState());
  configureDisplayMedia();
  configureLocalFileProtocol();
  registerMailViewIpc();
  registerBrowserViewIpc();
  registerChatGptViewIpc();

  const telegram = new TelegramService(store, {
    onStateChanged: sendStateChanged,
    onNewMessage: showTelegramNotification
  });
  const redmine = new RedmineService(store);
  const gitlab = new GitLabService(store);
  registerIpcHandlers(store, telegram, redmine, gitlab);

  createMainWindow();
  warmUpMailView();
  warmUpBrowserView();
  warmUpChatGptView();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
      warmUpMailView();
      warmUpBrowserView();
      warmUpChatGptView();
    }
  });
});

app.on('before-quit', () => {
  void persistMailCookies();
  store.flush();
  hideChatGptView();
  app.setBadgeCount(0);
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setBadge('');
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
