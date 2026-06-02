import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../domain/bridge';

function readBounds(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height
  };
}

type BrowserProps = {
  url: string;
  showToolbar?: boolean;
  viewKind?: 'browser' | 'chatgpt';
};

export function Browser({ url, showToolbar = true, viewKind = 'browser' }: BrowserProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [browserState, setBrowserState] = useState<BrowserViewState>({
    canGoBack: false,
    loading: true,
    url,
    error: ''
  });

  const syncBounds = useCallback(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    if (viewKind === 'chatgpt') {
      void api.setChatGptBounds(readBounds(host));
      return;
    }
    void api.setBrowserBounds(readBounds(host));
  }, [viewKind]);

  useEffect(() => {
    if (viewKind === 'chatgpt') {
      return api.onChatGptStateChanged(setBrowserState);
    }
    return api.onBrowserStateChanged(setBrowserState);
  }, [viewKind]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return undefined;
    }

    let animationFrame = window.requestAnimationFrame(() => {
      const showView = viewKind === 'chatgpt'
        ? api.showChatGptView(readBounds(host))
        : api.showBrowserView({ bounds: readBounds(host), url });

      showView
        .then(setBrowserState)
        .catch((error: unknown) => {
          setBrowserState({
            canGoBack: false,
            loading: false,
            url,
            error: error instanceof Error ? error.message : 'Не удалось открыть страницу.'
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
      if (viewKind === 'chatgpt') {
        void api.hideChatGptView();
        return;
      }
      void api.hideBrowserView();
    };
  }, [syncBounds, url, viewKind]);

  function goBack() {
    if (viewKind === 'chatgpt') {
      void api.goBackChatGptView();
      return;
    }
    void api.goBackBrowserView();
  }

  function reload() {
    if (viewKind === 'chatgpt') {
      void api.reloadChatGptView();
      return;
    }
    void api.reloadBrowserView();
  }

  function resetChatGptSession() {
    void api.resetChatGptSession().then(setBrowserState);
  }

  return (
    <div className="browser-layout">
      {showToolbar && (
        <div className="browser-toolbar">
          <button
            aria-label="Назад"
            disabled={!browserState.canGoBack}
            onClick={goBack}
            type="button"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <button
            aria-label="Обновить"
            onClick={reload}
            type="button"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M20 12a8 8 0 1 1-2.3-5.7" />
              <path d="M20 4v6h-6" />
            </svg>
          </button>
          <span>{browserState.url || url}</span>
        </div>
      )}
      {browserState.error && (
        <div className="browser-error">
          <span>{browserState.error}</span>
          <button type="button" onClick={() => void api.openExternal(browserState.url || url)}>
            Открыть во внешнем браузере
          </button>
          {viewKind === 'chatgpt' && (
            <>
              <button type="button" onClick={() => void api.openExternal('https://chatgpt.com/auth/login')}>
                Открыть ChatGPT в браузере
              </button>
              <button type="button" onClick={resetChatGptSession}>
                Сбросить сессию
              </button>
            </>
          )}
        </div>
      )}
      {browserState.loading && <div className="browser-loading">Загрузка...</div>}
      <div ref={hostRef} className="browser-view-host" />
    </div>
  );
}
