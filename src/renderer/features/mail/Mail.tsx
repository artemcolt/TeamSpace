import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../domain/bridge';

type MailState = {
  canGoBack: boolean;
  loading: boolean;
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
    error: ''
  });

  const syncBounds = useCallback(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    void api.setMailBounds(readBounds(host));
  }, []);

  useEffect(() => api.onMailStateChanged(setMailState), []);

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

  return (
    <div className="mail-layout">
      {mailState.error && <div className="mail-error">{mailState.error}</div>}
      {mailState.loading && <div className="mail-loading">Загрузка почты...</div>}
      <div ref={hostRef} className="mail-view-host" />
    </div>
  );
}
