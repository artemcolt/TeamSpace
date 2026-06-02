import { useEffect, useMemo, useState } from 'react';
import { api } from '../../domain/bridge';
import { katyaAccessGroupStorageKey, katyaDefaultBaseUrl } from '../../domain/constants';

const defaultTelemostUrl = 'https://telemost.yandex.ru/j/00000000000000';
const katyaMeetingStorageKey = 'team-space:katya-meeting-id';
const katyaMeetingsPageSize = 20;

type MeetingsMode = 'call' | 'recordings' | 'analyses';
type MeetingDetailTab = 'transcript' | 'protocol';
type AnalysisTemplateId = 'daily' | 'actions' | 'risks' | 'people' | 'custom';

const analysisPromptTemplates: Array<{ id: AnalysisTemplateId; title: string; prompt: string }> = [
  {
    id: 'daily',
    title: 'Дэйлик',
    prompt: [
      'Проанализируй встречи как дэйлики команды.',
      'Сделай краткий общий вывод, что было сделано, что делаем дальше, какие решения приняты, какие риски и блокеры есть.',
      'Отдельно перечисли обязательства по каждому сотруднику.',
      'В конце добавь источники: название и дату встреч.'
    ].join('\n')
  },
  {
    id: 'actions',
    title: 'Решения и задачи',
    prompt: [
      'Вытащи только решения, поручения и следующие действия.',
      'Для каждого пункта укажи владельца, срок, контекст и источник, если они есть.',
      'Если владелец или срок не названы, явно напиши "не указан".',
      'Сгруппируй результат по разделам: Решения, Поручения, Открытые вопросы.'
    ].join('\n')
  },
  {
    id: 'risks',
    title: 'Риски',
    prompt: [
      'Найди риски, блокеры, зависимости, неясности и места, где команда расходится в понимании.',
      'Для каждого риска укажи влияние, вероятного владельца и что нужно уточнить или сделать дальше.',
      'Не добавляй обычные задачи, если в них нет риска или блокера.'
    ].join('\n')
  },
  {
    id: 'people',
    title: 'По сотрудникам',
    prompt: [
      'Сделай анализ по людям.',
      'Для каждого сотрудника или спикера перечисли: что сделал, что планирует, что обещал, какие вопросы или блокеры у него есть.',
      'Если имя не раскрыто, используй обозначение спикера и пометь неопределенность.'
    ].join('\n')
  },
  {
    id: 'custom',
    title: 'Свой промпт',
    prompt: ''
  }
];

function normalizeTelemostUrl(value: string): string {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return defaultTelemostUrl;
  }

  if (/^https?:\/\//i.test(trimmedValue)) {
    return trimmedValue;
  }

  return `https://${trimmedValue}`;
}

function isTelemostUrl(value: string): boolean {
  try {
    return new URL(normalizeTelemostUrl(value)).hostname.endsWith('telemost.yandex.ru');
  } catch {
    return false;
  }
}

function dailyTitle(): string {
  return `Дэйлик ${new Intl.DateTimeFormat('ru-RU').format(new Date())}`;
}

function formatDateTime(value?: string): string {
  if (!value) {
    return 'Дата не указана';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function formatListTime(value?: string): string {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return new Intl.DateTimeFormat('ru-RU', sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit' }
  ).format(date);
}

function formatListDate(value?: string): string {
  if (!value) {
    return 'Дата не указана';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function formatDuration(seconds?: number): string {
  if (!Number.isFinite(seconds) || !seconds) {
    return '00:00';
  }
  const roundedSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(roundedSeconds / 3600);
  const minutes = Math.floor((roundedSeconds % 3600) / 60);
  const restSeconds = roundedSeconds % 60;
  const parts = hours > 0
    ? [hours, minutes, restSeconds]
    : [minutes, restSeconds];
  return parts.map((part) => String(part).padStart(2, '0')).join(':');
}

function formatTranscriptTime(seconds: number): string {
  return formatDuration(seconds);
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    done: 'Готово',
    recording: 'Запись',
    transcribing: 'Транскрибация',
    summarizing: 'Протокол',
    failed: 'Ошибка',
    stopped: 'Остановлена'
  };
  return labels[status] ?? status;
}

function speakerLabel(meeting: KatyaMeetingDetail | KatyaMeetingSummary, speaker: string): string {
  const name = meeting.speaker_names?.[speaker]?.trim();
  if (name) {
    return name;
  }
  const match = speaker.match(/(\d+)$/);
  return match ? `Спикер ${Number(match[1]) + 1}` : 'Спикер';
}

function mediaUrl(value?: string): string {
  if (!value) {
    return '';
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  return new URL(value, katyaDefaultBaseUrl).toString();
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMarkdownInline(value: string) {
  let html = escapeHtml(value);
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');
  return html;
}

function markdownToHtml(value: string) {
  const lines = value.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let paragraph: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let codeBlock: string[] | null = null;

  function closeParagraph() {
    if (paragraph.length === 0) {
      return;
    }
    html.push(`<p>${renderMarkdownInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  }

  function closeList() {
    if (!listType) {
      return;
    }
    html.push(`</${listType}>`);
    listType = null;
  }

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (codeBlock) {
      if (trimmedLine.startsWith('```')) {
        html.push(`<pre><code>${escapeHtml(codeBlock.join('\n'))}</code></pre>`);
        codeBlock = null;
      } else {
        codeBlock.push(line);
      }
      continue;
    }

    if (trimmedLine.startsWith('```')) {
      closeParagraph();
      closeList();
      codeBlock = [];
      continue;
    }
    if (!trimmedLine) {
      closeParagraph();
      closeList();
      continue;
    }

    const heading = trimmedLine.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeParagraph();
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderMarkdownInline(heading[2])}</h${level}>`);
      continue;
    }

    const unorderedListItem = trimmedLine.match(/^[-*]\s+(.+)$/);
    if (unorderedListItem) {
      closeParagraph();
      if (listType !== 'ul') {
        closeList();
        listType = 'ul';
        html.push('<ul>');
      }
      html.push(`<li>${renderMarkdownInline(unorderedListItem[1])}</li>`);
      continue;
    }

    const orderedListItem = trimmedLine.match(/^\d+\.\s+(.+)$/);
    if (orderedListItem) {
      closeParagraph();
      if (listType !== 'ol') {
        closeList();
        listType = 'ol';
        html.push('<ol>');
      }
      html.push(`<li>${renderMarkdownInline(orderedListItem[1])}</li>`);
      continue;
    }

    const quote = trimmedLine.match(/^>\s?(.+)$/);
    if (quote) {
      closeParagraph();
      closeList();
      html.push(`<blockquote>${renderMarkdownInline(quote[1])}</blockquote>`);
      continue;
    }

    closeList();
    paragraph.push(trimmedLine);
  }

  if (codeBlock) {
    html.push(`<pre><code>${escapeHtml(codeBlock.join('\n'))}</code></pre>`);
  }
  closeParagraph();
  closeList();
  return html.join('\n');
}

function MeetingMarkdown({ value }: { value: string }) {
  return (
    <div
      className="meeting-summary"
      dangerouslySetInnerHTML={{ __html: markdownToHtml(value || 'Протокол пока не сформирован.') }}
    />
  );
}

export function Meetings({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [mode, setMode] = useState<MeetingsMode>('call');
  const [address, setAddress] = useState(defaultTelemostUrl);
  const [katyaSessionCookie, setKatyaSessionCookie] = useState('');
  const [katyaMeetingId, setKatyaMeetingId] = useState(() =>
    window.localStorage.getItem(katyaMeetingStorageKey) ?? ''
  );
  const [accessGroupId, setAccessGroupId] = useState(() =>
    window.localStorage.getItem(katyaAccessGroupStorageKey) ?? ''
  );
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState('Готово к дейлику.');

  const [meetings, setMeetings] = useState<KatyaMeetingSummary[]>([]);
  const [meetingsPage, setMeetingsPage] = useState(1);
  const [meetingsTotal, setMeetingsTotal] = useState(0);
  const [selectedMeetingId, setSelectedMeetingId] = useState('');
  const [selectedMeeting, setSelectedMeeting] = useState<KatyaMeetingDetail | null>(null);
  const [listBusy, setListBusy] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [recordingsLoaded, setRecordingsLoaded] = useState(false);
  const [recordingsError, setRecordingsError] = useState('');
  const [detailTab, setDetailTab] = useState<MeetingDetailTab>('transcript');
  const [videoCollapsed, setVideoCollapsed] = useState(false);
  const [selectedAnalysisMeetingIds, setSelectedAnalysisMeetingIds] = useState<string[]>([]);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [savedAnalysesBusy, setSavedAnalysesBusy] = useState(false);
  const [savedAnalysesLoaded, setSavedAnalysesLoaded] = useState(false);
  const [savedAnalyses, setSavedAnalyses] = useState<KatyaDailyAnalysisAiResult[]>([]);
  const [analysisResult, setAnalysisResult] = useState<KatyaDailyAnalysisAiResult | null>(null);
  const [analysisDialogOpen, setAnalysisDialogOpen] = useState(false);
  const [analysisTemplateId, setAnalysisTemplateId] = useState<AnalysisTemplateId>('daily');
  const [analysisPrompt, setAnalysisPrompt] = useState(analysisPromptTemplates[0].prompt);

  const hasSession = katyaSessionCookie.trim().length > 0;
  const totalPages = Math.max(1, Math.ceil(meetingsTotal / katyaMeetingsPageSize));
  const selectedSummary = useMemo(
    () => meetings.find((meeting) => meeting.id === selectedMeetingId) ?? null,
    [meetings, selectedMeetingId]
  );
  const detail = selectedMeeting ?? selectedSummary;
  const selectedAnalysisMeetingIdsSet = useMemo(
    () => new Set(selectedAnalysisMeetingIds),
    [selectedAnalysisMeetingIds]
  );
  const allVisibleMeetingsSelected = meetings.length > 0 && meetings.every((meeting) =>
    selectedAnalysisMeetingIdsSet.has(meeting.id)
  );
  const sortedSavedAnalyses = useMemo(
    () => [...savedAnalyses].sort((first, second) =>
      new Date(second.createdAt || 0).getTime() - new Date(first.createdAt || 0).getTime()
    ),
    [savedAnalyses]
  );

  useEffect(() => {
    api.getKatyaSession()
      .then((savedSessionCookie) => {
        if (savedSessionCookie) {
          setKatyaSessionCookie(savedSessionCookie);
          setRecordingsLoaded(false);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (mode === 'recordings' && hasSession && !recordingsLoaded && !listBusy) {
      void loadMeetings(1);
    }
  }, [hasSession, listBusy, mode, recordingsLoaded]);

  useEffect(() => {
    if (mode === 'analyses' && !savedAnalysesLoaded && !savedAnalysesBusy) {
      void loadSavedAnalyses(false);
    }
  }, [mode, savedAnalysesBusy, savedAnalysesLoaded]);

  useEffect(() => {
    setVideoCollapsed(false);
  }, [selectedMeetingId]);

  async function openTelemost() {
    const nextUrl = normalizeTelemostUrl(address);
    setAddress(nextUrl);

    if (!isTelemostUrl(nextUrl)) {
      setStatusText('Укажите ссылку telemost.yandex.ru.');
      return;
    }

    setStatusText('Открываю Телемост.');
    await api.openTelemost(nextUrl);
  }

  async function inviteKatya() {
    const nextUrl = normalizeTelemostUrl(address);
    const trimmedAccessGroupId = accessGroupId.trim();
    setAddress(nextUrl);

    if (!isTelemostUrl(nextUrl)) {
      setStatusText('Укажите ссылку telemost.yandex.ru.');
      return;
    }
    if (!trimmedAccessGroupId) {
      setStatusText('Укажите группу доступа для Кати.');
      return;
    }
    if (!katyaSessionCookie.trim()) {
      setStatusText('Нет сохраненной сессии Кати. Откройте настройки и сохраните callrec_session.');
      return;
    }

    window.localStorage.setItem(katyaAccessGroupStorageKey, trimmedAccessGroupId);
    setBusy(true);
    setStatusText('Приглашаю Катю.');
    try {
      const meeting = await api.createKatyaMeeting({
        baseUrl: katyaDefaultBaseUrl,
        sessionCookie: katyaSessionCookie,
        url: nextUrl,
        title: dailyTitle(),
        groupId: trimmedAccessGroupId
      });
      setKatyaMeetingId(meeting.id);
      window.localStorage.setItem(katyaMeetingStorageKey, meeting.id);
      setStatusText('Катя приглашена на созвон.');
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : 'Не удалось пригласить Катю.');
    } finally {
      setBusy(false);
    }
  }

  async function removeKatya() {
    if (!katyaMeetingId || !katyaSessionCookie.trim()) {
      setStatusText('Нет активной Кати для удаления.');
      return;
    }

    setBusy(true);
    setStatusText('Удаляю Катю со встречи.');
    try {
      await api.stopKatyaMeeting({
        baseUrl: katyaDefaultBaseUrl,
        sessionCookie: katyaSessionCookie,
        meetingId: katyaMeetingId
      });
      setKatyaMeetingId('');
      window.localStorage.removeItem(katyaMeetingStorageKey);
      setStatusText('Катя удалена со встречи.');
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : 'Не удалось удалить Катю.');
    } finally {
      setBusy(false);
    }
  }

  async function loadMeetings(page = meetingsPage) {
    if (!hasSession) {
      setRecordingsError('Укажите и сохраните callrec_session для сервиса записи.');
      return;
    }

    setListBusy(true);
    setRecordingsLoaded(true);
    setRecordingsError('');
    try {
      const response = await api.listKatyaMeetings({
        baseUrl: katyaDefaultBaseUrl,
        sessionCookie: katyaSessionCookie,
        page,
        pageSize: katyaMeetingsPageSize
      });
      setMeetings(response.data);
      setMeetingsPage(response.page);
      setMeetingsTotal(response.total);
      const nextSelectedId = response.data.some((meeting) => meeting.id === selectedMeetingId)
        ? selectedMeetingId
        : response.data[0]?.id ?? '';
      const visibleMeetingIds = new Set(response.data.map((meeting) => meeting.id));
      setSelectedAnalysisMeetingIds((currentIds) => currentIds.filter((id) => visibleMeetingIds.has(id)));
      setSelectedMeetingId(nextSelectedId);
      if (nextSelectedId) {
        await loadMeetingDetail(nextSelectedId);
      } else {
        setSelectedMeeting(null);
      }
    } catch (error) {
      setRecordingsError(error instanceof Error ? error.message : 'Не удалось загрузить встречи.');
    } finally {
      setListBusy(false);
    }
  }

  async function loadMeetingDetail(meetingId: string) {
    if (!meetingId || !hasSession) {
      return;
    }

    setDetailBusy(true);
    setRecordingsError('');
    try {
      const meeting = await api.getKatyaMeeting({
        baseUrl: katyaDefaultBaseUrl,
        sessionCookie: katyaSessionCookie,
        meetingId
      });
      setSelectedMeeting(meeting);
      setSelectedMeetingId(meeting.id);
    } catch (error) {
      setSelectedMeeting(null);
      setRecordingsError(error instanceof Error ? error.message : 'Не удалось открыть встречу.');
    } finally {
      setDetailBusy(false);
    }
  }

  function toggleAnalysisMeeting(meetingId: string, selected: boolean) {
    setSelectedAnalysisMeetingIds((currentIds) => {
      if (selected) {
        return currentIds.includes(meetingId) ? currentIds : [...currentIds, meetingId];
      }
      return currentIds.filter((id) => id !== meetingId);
    });
  }

  function toggleVisibleAnalysisMeetings(selected: boolean) {
    const visibleMeetingIds = meetings.map((meeting) => meeting.id);
    if (selected) {
      setSelectedAnalysisMeetingIds((currentIds) => Array.from(new Set([...currentIds, ...visibleMeetingIds])));
      return;
    }
    setSelectedAnalysisMeetingIds((currentIds) => currentIds.filter((id) => !visibleMeetingIds.includes(id)));
  }

  function openAnalysisDialog() {
    if (!hasSession) {
      setRecordingsError('Укажите и сохраните callrec_session для сервиса записи.');
      return;
    }
    if (selectedAnalysisMeetingIds.length === 0) {
      setRecordingsError('Выберите записи для анализа.');
      return;
    }
    if (analysisBusy) {
      return;
    }

    setRecordingsError('');
    setAnalysisDialogOpen(true);
  }

  function selectAnalysisTemplate(templateId: AnalysisTemplateId) {
    setAnalysisTemplateId(templateId);
    const template = analysisPromptTemplates.find((item) => item.id === templateId);
    if (template && templateId !== 'custom') {
      setAnalysisPrompt(template.prompt);
    }
    if (templateId === 'custom') {
      setAnalysisPrompt('');
    }
  }

  async function analyzeDailies() {
    if (!hasSession) {
      setRecordingsError('Укажите и сохраните callrec_session для сервиса записи.');
      return;
    }
    if (selectedAnalysisMeetingIds.length === 0) {
      setRecordingsError('Выберите записи для анализа.');
      return;
    }
    if (analysisBusy) {
      return;
    }

    setAnalysisBusy(true);
    setAnalysisDialogOpen(false);
    setRecordingsError('');
    try {
      const result = await api.analyzeKatyaDailies({
        baseUrl: katyaDefaultBaseUrl,
        sessionCookie: katyaSessionCookie,
        meetingIds: selectedAnalysisMeetingIds,
        analysisPrompt: analysisPrompt.trim()
      });
      setAnalysisResult(result);
      setSavedAnalysesLoaded(true);
      setSavedAnalyses((currentAnalyses) => [
        result,
        ...currentAnalyses.filter((analysis) => analysis.outputFile !== result.outputFile)
      ]);
      setMode('analyses');
    } catch (error) {
      setRecordingsError(error instanceof Error ? error.message : 'Не удалось проанализировать дэйлики.');
    } finally {
      setAnalysisBusy(false);
    }
  }

  async function loadSavedAnalyses(openLatest: boolean) {
    if (savedAnalysesBusy) {
      return;
    }

    setSavedAnalysesBusy(true);
    if (openLatest) {
      setRecordingsError('');
    }
    try {
      const analyses = await api.listKatyaDailyAnalyses();
      setSavedAnalyses(analyses);
      setSavedAnalysesLoaded(true);
      if (analyses.length === 0) {
        if (openLatest) {
          setRecordingsError('Сохраненных анализов дэйликов пока нет.');
        }
        return;
      }
      if (openLatest) {
        setAnalysisResult(analyses[0]);
        setMode('analyses');
      }
    } catch (error) {
      if (openLatest) {
        setRecordingsError(error instanceof Error ? error.message : 'Не удалось открыть сохраненные анализы.');
      }
    } finally {
      setSavedAnalysesBusy(false);
    }
  }

  function openSavedAnalysis(analysis: KatyaDailyAnalysisAiResult) {
    setAnalysisResult(analysis);
    setMode('analyses');
    setRecordingsError('');
  }

  async function openAnalysisFile() {
    if (!analysisResult?.outputFile) {
      return;
    }

    setRecordingsError('');
    try {
      const openError = await api.openPath(analysisResult.outputFile);
      if (openError) {
        setRecordingsError(openError);
      }
    } catch (error) {
      setRecordingsError(error instanceof Error ? error.message : 'Не удалось открыть файл анализа.');
    }
  }

  return (
    <div className="meetings-layout">
      {analysisDialogOpen && (
        <div className="my-task-agent-launcher" role="dialog" aria-modal="true" aria-label="Настройка анализа встреч">
          <div className="my-task-agent-launcher-panel meeting-analysis-dialog">
            <div className="my-task-agent-launcher-header">
              <div>
                <h3>Настроить анализ</h3>
                <p>Материалы выбранных встреч будут добавлены в prompt автоматически.</p>
              </div>
              <button
                type="button"
                className="my-task-detail-close-button"
                aria-label="Закрыть настройку анализа"
                disabled={analysisBusy}
                onClick={() => setAnalysisDialogOpen(false)}
              >
                ×
              </button>
            </div>

            <label>
              <span>Шаблон</span>
              <select
                value={analysisTemplateId}
                onChange={(event) => selectAnalysisTemplate(event.target.value as AnalysisTemplateId)}
                disabled={analysisBusy}
              >
                {analysisPromptTemplates.map((template) => (
                  <option key={template.id} value={template.id}>{template.title}</option>
                ))}
              </select>
            </label>

            <label>
              <span>Какой анализ провести</span>
              <textarea
                rows={9}
                value={analysisPrompt}
                onChange={(event) => {
                  setAnalysisTemplateId('custom');
                  setAnalysisPrompt(event.target.value);
                }}
                disabled={analysisBusy}
                placeholder="Напишите, что нужно найти в выбранных встречах"
              />
            </label>

            {recordingsError && <p className="error-text">{recordingsError}</p>}
            <div className="my-task-detail-form-actions">
              <button
                type="button"
                className="secondary-action"
                disabled={analysisBusy}
                onClick={() => setAnalysisDialogOpen(false)}
              >
                Закрыть
              </button>
              <button
                type="button"
                className="primary-action"
                disabled={analysisBusy || !analysisPrompt.trim()}
                onClick={() => void analyzeDailies()}
              >
                {analysisBusy ? 'Анализ...' : 'Запустить анализ'}
              </button>
            </div>
          </div>
        </div>
      )}
      <header className="topbar">
        <div>
          <p className="eyebrow">Meetings</p>
          <h2>Встречи</h2>
        </div>
        <div className="meeting-topbar-actions">
          <span className={hasSession ? 'meeting-session-state ready' : 'meeting-session-state'}>
            {hasSession ? 'Сессия Кати сохранена' : 'Сессия Кати не настроена'}
          </span>
          <div className="meeting-mode-tabs" role="tablist" aria-label="Разделы встреч">
            <button
              className={mode === 'call' ? 'active' : ''}
              onClick={() => setMode('call')}
              role="tab"
              type="button"
              aria-selected={mode === 'call'}
            >
              Созвон
            </button>
            <button
              className={mode === 'recordings' ? 'active' : ''}
              onClick={() => setMode('recordings')}
              role="tab"
              type="button"
              aria-selected={mode === 'recordings'}
            >
              Записи
            </button>
            <button
              className={mode === 'analyses' ? 'active' : ''}
              onClick={() => setMode('analyses')}
              role="tab"
              type="button"
              aria-selected={mode === 'analyses'}
            >
              Анализы
            </button>
          </div>
        </div>
      </header>

      {mode === 'call' ? (
        <section className="panel simple-meeting-panel">
          <label className="simple-meeting-address">
            <span>Ссылка Телемоста</span>
            <input
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void openTelemost();
                }
              }}
              placeholder={defaultTelemostUrl}
            />
          </label>

          <label className="simple-meeting-address">
            <span>Группа доступа</span>
            <input
              value={accessGroupId}
              onChange={(event) => {
                const nextAccessGroupId = event.target.value;
                setAccessGroupId(nextAccessGroupId);
                window.localStorage.setItem(katyaAccessGroupStorageKey, nextAccessGroupId.trim());
              }}
              placeholder="ID группы в Кате"
            />
          </label>

          <div className="simple-meeting-actions">
            <button className="secondary-action" disabled={busy} onClick={openTelemost} type="button">
              Открыть Телемост
            </button>
            <button className="secondary-action" disabled={busy} onClick={onOpenSettings} type="button">
              Настроить Катю
            </button>
            <button className="primary-action" disabled={busy} onClick={inviteKatya} type="button">
              Пригласить Катю
            </button>
            <button className="danger-action" disabled={busy} onClick={removeKatya} type="button">
              Удалить Катю
            </button>
          </div>

          <p className="inline-hint">{statusText}</p>
        </section>
      ) : mode === 'analyses' ? (
        <div className="meeting-recordings-view">
          {recordingsError && <p className="inline-hint meeting-error">{recordingsError}</p>}

          <div className="meeting-recordings-content">
            <aside className="panel meeting-recordings-list" aria-label="Список анализов дэйликов">
              <div className="meeting-recordings-list-head">
                <div>
                  <h3>Анализы дэйликов</h3>
                  <p>{sortedSavedAnalyses.length > 0 ? `${sortedSavedAnalyses.length} анализов` : 'AI-анализ встреч'}</p>
                </div>
                <div className="meeting-recordings-list-actions">
                  {savedAnalysesBusy && <span>Загрузка...</span>}
                  <button
                    className="secondary-action"
                    disabled={savedAnalysesBusy}
                    onClick={() => void loadSavedAnalyses(false)}
                    type="button"
                  >
                    Обновить
                  </button>
                </div>
              </div>

              <div className="meeting-recording-items">
                {sortedSavedAnalyses.length === 0 && !savedAnalysesBusy ? (
                  <div className="meeting-recordings-empty">
                    <p className="empty-state">Анализов дэйликов пока нет.</p>
                  </div>
                ) : sortedSavedAnalyses.map((analysis) => (
                  <button
                    className={analysis.outputFile === analysisResult?.outputFile
                      ? 'meeting-recording-item analysis active'
                      : 'meeting-recording-item analysis'}
                    key={analysis.outputFile}
                    onClick={() => openSavedAnalysis(analysis)}
                    type="button"
                  >
                    <span className="meeting-recording-body">
                      <span className="meeting-recording-title-row">
                        <strong>Анализ дэйликов</strong>
                        <time>{formatListTime(analysis.createdAt)}</time>
                      </span>
                      <span className="meeting-recording-preview-row">
                        <span className="meeting-recording-preview">
                          {formatListDate(analysis.createdAt)}
                          {analysis.meetingsCount > 0 ? ` · ${analysis.meetingsCount} встреч` : ''}
                        </span>
                        <span className="meeting-status analysis">Анализ</span>
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </aside>

            <section className="panel meeting-analysis-full" aria-label="Анализ дэйликов">
              {analysisResult ? (
                <>
                  <div className="meeting-detail-head meeting-analysis-full-head">
                    <div>
                      <p className="eyebrow">AI-анализ</p>
                      <h3>Анализ дэйликов</h3>
                      <p>{analysisResult.meetingsCount} встреч · Markdown</p>
                    </div>
                    <div className="meeting-detail-actions">
                      <button
                        className="secondary-action"
                        onClick={() => void openAnalysisFile()}
                        type="button"
                      >
                        Открыть файлом
                      </button>
                    </div>
                  </div>
                  <div className="meeting-analysis-path">{analysisResult.outputFile}</div>
                  <MeetingMarkdown value={analysisResult.content} />
                </>
              ) : (
                <div className="meeting-detail-empty">
                  <h3>Выберите анализ</h3>
                  <p className="empty-state">Здесь появится сохраненный анализ дэйликов.</p>
                </div>
              )}
            </section>
          </div>
        </div>
      ) : (
        <div className="meeting-recordings-view">
          {recordingsError && <p className="inline-hint meeting-error">{recordingsError}</p>}

          <div className="meeting-recordings-content">
            <aside className="panel meeting-recordings-list" aria-label="Список записей встреч">
              <div className="meeting-recordings-list-head">
                <div>
                  <h3>Записи</h3>
                  <p>{meetingsTotal > 0 ? `${meetingsTotal} встреч` : 'Сервис записи'}</p>
                </div>
                <div className="meeting-recordings-list-actions">
                  {listBusy && <span>Загрузка...</span>}
                  {analysisBusy && <span>AI анализирует...</span>}
                  <button
                    className="secondary-action"
                    disabled={analysisBusy || !hasSession || selectedAnalysisMeetingIds.length === 0}
                    onClick={openAnalysisDialog}
                    type="button"
                  >
                    {analysisBusy ? 'Анализ...' : `Проанализировать (${selectedAnalysisMeetingIds.length})`}
                  </button>
                  <button
                    className="secondary-action"
                    disabled={listBusy || !hasSession}
                    onClick={() => {
                      void loadMeetings(1);
                    }}
                    type="button"
                  >
                    Обновить
                  </button>
                </div>
              </div>
              {meetings.length > 0 && (
                <label className="meeting-select-all">
                  <input
                    checked={allVisibleMeetingsSelected}
                    onChange={(event) => toggleVisibleAnalysisMeetings(event.target.checked)}
                    type="checkbox"
                  />
                  <span>Выбрать все на странице</span>
                </label>
              )}

              <div className="meeting-recording-items">
                {meetings.length === 0 && !listBusy ? (
                  <div className="meeting-recordings-empty">
                    <p className="empty-state">Записей пока нет или сессия не сохранена.</p>
                    {!hasSession && (
                      <button className="secondary-action" onClick={onOpenSettings} type="button">
                        Открыть настройки
                      </button>
                    )}
                  </div>
                ) : meetings.map((meeting) => (
                  <article
                    className={meeting.id === selectedMeetingId
                      ? 'meeting-recording-selectable active'
                      : 'meeting-recording-selectable'}
                    key={meeting.id}
                  >
                    <label className="meeting-recording-check">
                      <input
                        aria-label={`Выбрать для анализа: ${meeting.title || 'Без названия'}`}
                        checked={selectedAnalysisMeetingIdsSet.has(meeting.id)}
                        onChange={(event) => toggleAnalysisMeeting(meeting.id, event.target.checked)}
                        type="checkbox"
                      />
                    </label>
                    <button
                      className={meeting.id === selectedMeetingId ? 'meeting-recording-item active' : 'meeting-recording-item'}
                      onClick={() => loadMeetingDetail(meeting.id)}
                      type="button"
                    >
                      <span className="meeting-recording-body">
                        <span className="meeting-recording-title-row">
                          <strong>{meeting.title || 'Без названия'}</strong>
                          <time>{formatListTime(meeting.started_at ?? meeting.created_at)}</time>
                        </span>
                        <span className="meeting-recording-preview-row">
                          <span className="meeting-recording-preview">
                            {meeting.owner_display_name || meeting.owner_username || 'Автор не указан'}
                            {meeting.group_name ? `: ${meeting.group_name}` : ''}
                            {' · '}
                            {formatListDate(meeting.started_at ?? meeting.created_at)}
                            {' · '}
                            {formatDuration(meeting.duration_sec)}
                          </span>
                          <span className={`meeting-status ${meeting.status}`}>{statusLabel(meeting.status)}</span>
                        </span>
                      </span>
                    </button>
                  </article>
                ))}
              </div>

              <div className="meeting-pagination">
                <button
                  className="secondary-action"
                  disabled={listBusy || meetingsPage <= 1}
                  onClick={() => loadMeetings(meetingsPage - 1)}
                  type="button"
                >
                  Назад
                </button>
                <span>{meetingsPage} / {totalPages}</span>
                <button
                  className="secondary-action"
                  disabled={listBusy || meetingsPage >= totalPages}
                  onClick={() => loadMeetings(meetingsPage + 1)}
                  type="button"
                >
                  Дальше
                </button>
              </div>
            </aside>

            <section className="panel meeting-recording-detail" aria-label="Транскрипция встречи">
              {!detail ? (
                <div className="meeting-detail-empty">
                  <h3>Выберите запись</h3>
                  <p className="empty-state">Здесь появится видео, протокол и транскрипция выбранной встречи.</p>
                </div>
              ) : (
                <>
                  <div className="meeting-detail-head">
                    {detail ? (
                      <div>
                        <p className="eyebrow">{statusLabel(detail.status)}</p>
                        <h3>{detail.title || 'Без названия'}</h3>
                        <p>
                          {formatDateTime(detail.started_at ?? detail.created_at)}
                          {' · '}
                          {formatDuration(detail.duration_sec)}
                        </p>
                      </div>
                    ) : null}
                  </div>

                  {detail && (detail as KatyaMeetingDetail).video_url && !videoCollapsed && (
                    <div className="meeting-video-frame">
                      <video
                        className="meeting-video"
                        controls
                        preload="metadata"
                        src={mediaUrl((detail as KatyaMeetingDetail).video_url)}
                      />
                      <button
                        type="button"
                        className="meeting-video-collapse"
                        aria-label="Скрыть видео"
                        title="Скрыть видео"
                        onClick={() => setVideoCollapsed(true)}
                      >
                        ×
                      </button>
                    </div>
                  )}

                  <div className="meeting-detail-tabs" role="tablist" aria-label="Материалы встречи">
                    {detail && (
                      <>
                        <button
                          className={detailTab === 'transcript' ? 'active' : ''}
                          onClick={() => setDetailTab('transcript')}
                          role="tab"
                          type="button"
                          aria-selected={detailTab === 'transcript'}
                        >
                          Транскрипция
                        </button>
                        <button
                          className={detailTab === 'protocol' ? 'active' : ''}
                          onClick={() => setDetailTab('protocol')}
                          role="tab"
                          type="button"
                          aria-selected={detailTab === 'protocol'}
                        >
                          Протокол
                        </button>
                      </>
                    )}
                  </div>

                  {detailBusy ? (
                    <p className="empty-state">Загрузка встречи...</p>
                  ) : !detail ? (
                    <p className="empty-state">Выберите запись для просмотра материалов.</p>
                  ) : detailTab === 'transcript' ? (
                    <div className="meeting-transcript">
                      {detail.segments && detail.segments.length > 0 ? (
                        detail.segments.map((segment, index) => (
                          <article className="meeting-transcript-row" key={`${segment.start}-${index}`}>
                            <time>{formatTranscriptTime(segment.start)}</time>
                            <div>
                              <strong>{speakerLabel(detail, segment.speaker)}</strong>
                              <p>{segment.text}</p>
                            </div>
                          </article>
                        ))
                      ) : (
                        <pre>{(detail as KatyaMeetingDetail).transcript || 'Транскрипция пока не готова.'}</pre>
                      )}
                    </div>
                  ) : (
                    <MeetingMarkdown value={(detail as KatyaMeetingDetail).summary ?? ''} />
                  )}
                </>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
