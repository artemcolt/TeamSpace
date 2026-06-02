import {
  type ClipboardEvent,
  type DragEvent,
  type WheelEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { ImageLightbox } from '../../components/common';
import { api } from '../../domain/bridge';
import { formatChatTime, formatDate, initials } from '../../domain/formatters';

const katyaDefaultBaseUrl = 'http://localhost:8077';
const defaultRecordingGroupId = '';
const katyaMeetingStoragePrefix = 'team-space:katya-meeting-id:';
const composerTextareaMaxHeight = 160;
const initialRenderedMessageLimit = 160;
const renderedMessageLimitStep = 120;

interface PendingFile {
  file: File;
  name: string;
  mimeType: string;
  previewUrl: string | null;
}

type OptimisticMessage = TelegramMessage & {
  deliveryStatus: 'sending' | 'failed';
};

export function Inbox({
  busy,
  state,
  onState,
  selectedChatId,
  selectedTopicId,
  selectedChat,
  selectedChatTopics,
  selectedMessageIds,
  selectedMessages,
  setSelectedChatId,
  setSelectedTopicId,
  setSelectedMessageIds,
  createIssueFromMessages,
  openInternalBrowser,
  runAction
}: {
  busy: boolean;
  state: AppState;
  onState: (state: AppState) => void;
  selectedChatId: string;
  selectedTopicId: string;
  selectedChat?: TelegramChat;
  selectedChatTopics: TelegramTopic[];
  selectedMessageIds: string[];
  selectedMessages: TelegramMessage[];
  setSelectedChatId: (chatId: string) => void;
  setSelectedTopicId: (topicId: string) => void;
  setSelectedMessageIds: (ids: string[]) => void;
  createIssueFromMessages: () => void;
  openInternalBrowser: (url: string) => void;
  runAction: (
    action: () => Promise<AppState>,
    success?: string,
    options?: { blockUi?: boolean }
  ) => Promise<AppState | null>;
}) {
  const [chatQuery, setChatQuery] = useState('');
  const [outgoingText, setOutgoingText] = useState('');
  const [pendingFile, setPendingFile] = useState<PendingFile | null>(null);
  const [replyingToMessageId, setReplyingToMessageId] = useState('');
  const [pendingScrollMessageId, setPendingScrollMessageId] = useState('');
  const [highlightedMessageId, setHighlightedMessageId] = useState('');
  const [draggingFile, setDraggingFile] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [pendingNotificationChatId, setPendingNotificationChatId] = useState('');
  const [pendingTelemostUrl, setPendingTelemostUrl] = useState('');
  const [telemostStatusText, setTelemostStatusText] = useState('');
  const [pendingReactionMessageId, setPendingReactionMessageId] = useState('');
  const [attachmentVideoUrls, setAttachmentVideoUrls] = useState<Record<string, string>>({});
  const [downloadingAttachmentIds, setDownloadingAttachmentIds] = useState<Record<string, boolean>>({});
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null);
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticMessage[]>([]);
  const [renderedMessageLimit, setRenderedMessageLimit] = useState(initialRenderedMessageLimit);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const topicTabsRef = useRef<HTMLDivElement | null>(null);
  const previousScrollHeight = useRef<number | null>(null);
  const pendingFileUrlRef = useRef('');
  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bottomScrollFrameRef = useRef<number | null>(null);
  const forceBottomUntilRef = useRef(0);
  const workspaceChats = useMemo(
    () => state.telegram.chats.some((chat) => chat.selected)
      ? state.telegram.chats.filter((chat) => chat.selected)
      : state.telegram.chats,
    [state.telegram.chats]
  );
  const latestMessagesByChat = useMemo(() => {
    const map = new Map<string, TelegramMessage>();
    for (const message of state.telegram.messages) {
      const previous = map.get(message.chatId);
      if (!previous || new Date(message.sentAt).getTime() > new Date(previous.sentAt).getTime()) {
        map.set(message.chatId, message);
      }
    }
    return map;
  }, [state.telegram.messages]);
  const visibleChats = useMemo(() => {
    const normalizedQuery = chatQuery.trim().toLowerCase();
    return workspaceChats
      .filter((chat) => chat.title.toLowerCase().includes(normalizedQuery))
      .sort((a, b) => {
        if ((b.unreadCount ?? 0) !== (a.unreadCount ?? 0)) {
          return (b.unreadCount ?? 0) - (a.unreadCount ?? 0);
        }
        return new Date(b.lastMessageAt ?? b.lastSyncedAt ?? 0).getTime() -
          new Date(a.lastMessageAt ?? a.lastSyncedAt ?? 0).getTime();
      });
  }, [chatQuery, workspaceChats]);
  const selectedMessageIdSet = useMemo(() => new Set(selectedMessageIds), [selectedMessageIds]);
  const selectedMessagesById = useMemo(
    () => new Map(selectedMessages.map((message) => [message.id, message])),
    [selectedMessages]
  );
  const selectedTopic = selectedChatTopics.find((topic) => topic.id === selectedTopicId);
  const displayedMessages = useMemo(() => {
    const visibleOptimisticMessages = optimisticMessages.filter((message) =>
      message.chatId === selectedChatId &&
      (!selectedTopicId || selectedTopicId === 'all' || message.topicId === selectedTopicId)
    );
    if (visibleOptimisticMessages.length === 0) {
      return selectedMessages;
    }
    const realMessageIds = new Set(selectedMessages.map((message) => message.id));
    return [...selectedMessages, ...visibleOptimisticMessages.filter((message) => !realMessageIds.has(message.id))]
      .sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime());
  }, [optimisticMessages, selectedChatId, selectedMessages, selectedTopicId]);
  const renderedMessages = useMemo(() => {
    if (displayedMessages.length <= renderedMessageLimit) {
      return displayedMessages;
    }
    return displayedMessages.slice(-renderedMessageLimit);
  }, [displayedMessages, renderedMessageLimit]);
  const hiddenLoadedMessageCount = Math.max(0, displayedMessages.length - renderedMessages.length);
  const oldestMessageId = selectedMessages[0]?.id ?? '';
  const newestMessageId = displayedMessages.at(-1)?.id ?? '';

  const resizeComposerTextarea = () => {
    const textarea = composerTextareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = 'auto';
    const nextHeight = Math.min(textarea.scrollHeight, composerTextareaMaxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > composerTextareaMaxHeight ? 'auto' : 'hidden';
  };

  function scrollThreadToBottom() {
    const thread = threadRef.current;
    if (!thread) {
      return;
    }

    thread.scrollTop = thread.scrollHeight;
  }

  function scheduleThreadScrollToBottom(frameCount = 2) {
    if (bottomScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(bottomScrollFrameRef.current);
    }

    const scrollOnFrame = (remainingFrames: number) => {
      bottomScrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollThreadToBottom();
        if (remainingFrames > 1) {
          scrollOnFrame(remainingFrames - 1);
          return;
        }
        bottomScrollFrameRef.current = null;
      });
    };

    scrollOnFrame(frameCount);
  }

  useLayoutEffect(() => {
    previousScrollHeight.current = null;
    forceBottomUntilRef.current = Date.now() + 1200;
    setRenderedMessageLimit(initialRenderedMessageLimit);
    scrollThreadToBottom();
    scheduleThreadScrollToBottom(3);
  }, [selectedChatId, selectedTopicId]);

  useLayoutEffect(() => {
    const thread = threadRef.current;
    if (!thread) {
      return;
    }

    if (previousScrollHeight.current !== null) {
      thread.scrollTop = thread.scrollHeight - previousScrollHeight.current;
      previousScrollHeight.current = null;
      return;
    }

    thread.scrollTop = thread.scrollHeight;
  }, [selectedChatId, selectedTopicId, newestMessageId, renderedMessages.length]);

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => {
      if (Date.now() <= forceBottomUntilRef.current) {
        scrollThreadToBottom();
      }
    });

    thread
      .querySelectorAll<HTMLElement>('.message-row, .message-attachment, img, video')
      .forEach((element) => observer.observe(element));

    return () => observer.disconnect();
  }, [selectedChatId, selectedTopicId, newestMessageId, renderedMessages.length]);

  useLayoutEffect(() => {
    resizeComposerTextarea();
  }, [outgoingText, pendingFile, replyingToMessageId, selectedChatId, selectedTopicId]);

  useLayoutEffect(() => {
    const topicTabs = topicTabsRef.current;
    const activeTopic = topicTabs?.querySelector('.active') as HTMLElement | null;
    if (typeof activeTopic?.scrollIntoView === 'function') {
      activeTopic.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [selectedChatId, selectedTopicId, selectedChatTopics.length]);

  useEffect(() => {
    return () => {
      if (pendingFileUrlRef.current) {
        URL.revokeObjectURL(pendingFileUrlRef.current);
      }
      if (highlightTimeoutRef.current) {
        clearTimeout(highlightTimeoutRef.current);
      }
      if (bottomScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(bottomScrollFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setReplyingToMessageId('');
    setPendingScrollMessageId('');
    setHighlightedMessageId('');
  }, [selectedChatId, selectedTopicId]);

  useLayoutEffect(() => {
    if (pendingScrollMessageId && revealMessage(pendingScrollMessageId)) {
      setPendingScrollMessageId('');
    }
  }, [pendingScrollMessageId, renderedMessages.length]);

  function scrollTopicTabs(event: WheelEvent<HTMLDivElement>) {
    const topicTabs = event.currentTarget;
    if (topicTabs.scrollWidth <= topicTabs.clientWidth) {
      return;
    }

    const scrollDelta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (!scrollDelta) {
      return;
    }

    event.preventDefault();
    topicTabs.scrollLeft += scrollDelta;
  }

  async function loadOlderMessages(): Promise<AppState | null> {
    if (busy || loadingOlder || !selectedChatId || !oldestMessageId || !threadRef.current) {
      return null;
    }

    previousScrollHeight.current = threadRef.current.scrollHeight;
    if (hiddenLoadedMessageCount > 0) {
      setRenderedMessageLimit((currentLimit) =>
        Math.min(displayedMessages.length, currentLimit + renderedMessageLimitStep)
      );
      return state;
    }

    setLoadingOlder(true);
    const nextState = await runAction(
      () =>
        api.loadOlderChatMessages({
          chatId: selectedChatId,
          topicId: selectedTopicId && selectedTopicId !== 'all' ? selectedTopicId : undefined,
          beforeMessageId: oldestMessageId
        }),
      undefined,
      { blockUi: false }
    );
    const nextVisibleCount = nextState?.telegram.messages
      .filter((message) =>
        message.chatId === selectedChatId &&
        (!selectedTopicId || selectedTopicId === 'all' || message.topicId === selectedTopicId)
      ).length;
    if (!nextState || nextVisibleCount === selectedMessages.length) {
      previousScrollHeight.current = null;
    }
    setLoadingOlder(false);
    return nextState;
  }

  async function openTopic(topicId: string) {
    setSelectedTopicId(topicId);
    setSelectedMessageIds([]);
    await runAction(
      () =>
        api.loadChatMessages({
          chatId: selectedChatId,
          topicId: topicId && topicId !== 'all' ? topicId : undefined
        }),
      undefined,
      { blockUi: false }
    );
  }

  async function toggleChatNotifications(chat: TelegramChat) {
    if (pendingNotificationChatId) {
      return;
    }

    const nextEnabled = chat.notificationsEnabled === false;
    const optimisticState: AppState = {
      ...state,
      telegram: {
        ...state.telegram,
        chats: state.telegram.chats.map((currentChat) =>
          currentChat.id === chat.id
            ? { ...currentChat, notificationsEnabled: nextEnabled }
            : currentChat
        )
      }
    };

    setPendingNotificationChatId(chat.id);
    onState(optimisticState);
    try {
      const nextState = await runAction(
        () =>
          api.setTelegramChatNotifications({
            chatId: chat.id,
            enabled: nextEnabled
          }),
        undefined,
        { blockUi: false }
      );
      if (!nextState) {
        onState(state);
      }
    } finally {
      setPendingNotificationChatId('');
    }
  }

  async function reactWithThumbsUp(message: TelegramMessage) {
    const thumbsUpReaction = message.reactions?.find((reaction) => reaction.emoticon === '👍');
    if (thumbsUpReaction?.mine || pendingReactionMessageId === message.id) {
      return;
    }

    setPendingReactionMessageId(message.id);
    try {
      await runAction(
        () =>
          api.reactToTelegramMessage({
            messageId: message.id,
            emoticon: '👍'
          }),
        undefined,
        { blockUi: false }
      );
    } finally {
      setPendingReactionMessageId('');
    }
  }

  function latestMessagePreview(message: TelegramMessage | undefined): string {
    if (!message) {
      return 'Нет загруженных сообщений';
    }

    const text = message.text.trim();
    if (text) {
      return `${message.senderName}: ${text}`;
    }
    if ((message.attachments?.length ?? 0) > 0) {
      const firstAttachment = message.attachments?.[0];
      const label = firstAttachment?.type === 'image'
        ? 'Изображение'
        : firstAttachment?.type === 'sticker'
          ? 'Стикер'
          : firstAttachment?.fileName || 'Файл';
      return `${message.senderName}: ${label}`;
    }
    return `${message.senderName}: Сообщение`;
  }

  function messagePreviewText(message: TelegramMessage | undefined): string {
    if (!message) {
      return 'Сообщение';
    }
    const text = message.text.trim();
    if (text) {
      return text.length > 120 ? `${text.slice(0, 117)}...` : text;
    }
    const attachment = message.attachments?.[0];
    if (attachment) {
      if (attachment.type === 'image') {
        return 'Изображение';
      }
      if (attachment.type === 'sticker') {
        return 'Стикер';
      }
      return attachment.fileName || 'Файл';
    }
    return 'Сообщение';
  }

  function attachmentKey(message: TelegramMessage, attachment: TelegramMessageAttachment): string {
    return `${message.id}:${attachment.id}`;
  }

  function isVideoAttachment(attachment: TelegramMessageAttachment): boolean {
    const mimeType = attachment.mimeType.toLowerCase();
    const fileName = attachment.fileName.toLowerCase();
    return (
      mimeType.startsWith('video/') ||
      fileName.endsWith('.mp4') ||
      fileName.endsWith('.mov') ||
      fileName.endsWith('.m4v') ||
      fileName.endsWith('.webm')
    );
  }

  function renderAttachmentPreview(attachment: TelegramMessageAttachment, videoUrl = '') {
    if (videoUrl && isVideoAttachment(attachment)) {
      return (
        <video
          aria-label={attachment.fileName || 'Видео'}
          className="message-video-player"
          controls
          playsInline
          preload="metadata"
          src={videoUrl}
        />
      );
    }

    if (attachment.dataUrl && isVideoAttachment(attachment)) {
      return (
        <video
          aria-label={attachment.fileName || 'Видео'}
          className="message-video-player"
          controls
          playsInline
          preload="metadata"
          src={attachment.dataUrl}
        />
      );
    }

    if (attachment.dataUrl && attachment.type === 'sticker' && attachment.mimeType.startsWith('video/')) {
      return (
        <video
          aria-label={attachment.fileName || 'Стикер'}
          autoPlay
          loop
          muted
          playsInline
          src={attachment.dataUrl}
        />
      );
    }

    if (attachment.dataUrl && (attachment.type === 'image' || attachment.type === 'sticker')) {
      const imageSrc = attachment.dataUrl;
      const alt = attachment.fileName || (attachment.type === 'sticker' ? 'Стикер' : 'Изображение');
      return (
        <button
          type="button"
          className="message-image-preview-button"
          aria-label={`Открыть изображение ${alt}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setPreviewImage({ src: imageSrc, alt });
          }}
        >
          <img src={imageSrc} alt={alt} />
        </button>
      );
    }

    return <span>{attachment.fileName || (attachment.type === 'sticker' ? 'Стикер' : 'Файл')}</span>;
  }

  function showAttachmentDownload(attachment: TelegramMessageAttachment): boolean {
    const mimeType = attachment.mimeType.toLowerCase();
    const fileName = attachment.fileName.toLowerCase();
    return !(
      attachment.type === 'image' ||
      attachment.type === 'sticker' ||
      mimeType === 'image/gif' ||
      mimeType === 'image/webp' ||
      fileName.endsWith('.gif')
    );
  }

  async function downloadAttachment(message: TelegramMessage, attachment: TelegramMessageAttachment) {
    const key = attachmentKey(message, attachment);
    if (downloadingAttachmentIds[key]) {
      return;
    }

    setDownloadingAttachmentIds((current) => ({ ...current, [key]: true }));
    try {
      const result = await api.downloadTelegramAttachment({
        messageId: message.id,
        attachmentId: attachment.id
      });
      if (result.fileUrl && isVideoAttachment(attachment)) {
        setAttachmentVideoUrls((current) => ({ ...current, [key]: result.fileUrl ?? '' }));
      }
    } finally {
      setDownloadingAttachmentIds((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  }

  function visibleMessageReactions(message: TelegramMessage): TelegramMessageReaction[] {
    return (message.reactions ?? []).filter((reaction) =>
      reaction.count > 0 && !(reaction.emoticon === '👍' && reaction.mine)
    );
  }

  function reactionUsersTitle(reaction?: TelegramMessageReaction | null): string {
    if (!reaction || reaction.count <= 0) {
      return 'Палец вверх';
    }
    const users = reaction.users ?? [];
    if (users.length > 0) {
      const extraCount = Math.max(0, reaction.count - users.length);
      return extraCount > 0
        ? `Поставили: ${users.join(', ')} и еще ${extraCount}`
        : `Поставили: ${users.join(', ')}`;
    }
    return 'Список пользователей недоступен';
  }

  function reactionUsersSummary(reaction: TelegramMessageReaction): string {
    const users = reaction.users ?? [];
    if (users.length === 0) {
      return 'Список пользователей недоступен';
    }
    const extraCount = Math.max(0, reaction.count - users.length);
    return extraCount > 0
      ? `${users.join(', ')} и еще ${extraCount}`
      : users.join(', ');
  }

  function isMessageActionTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) {
      return false;
    }
    return Boolean(target.closest(
      'button, a, input, textarea, select, summary, details, video, .message-attachment'
    ));
  }

  function toggleMessageSelection(message: TelegramMessage, selected: boolean) {
    setSelectedMessageIds(
      selected
        ? selectedMessageIds.filter((id) => id !== message.id)
        : [...selectedMessageIds, message.id]
    );
  }

  function normalizedLinkUrl(value: string): string {
    return /^https?:\/\//i.test(value) ? value : `https://${value}`;
  }

  function linkParts(text: string): Array<{ text: string; url?: string }> {
    const urlPattern = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;
    const parts: Array<{ text: string; url?: string }> = [];
    let lastIndex = 0;
    for (const match of text.matchAll(urlPattern)) {
      const rawUrl = match[0];
      const index = match.index ?? 0;
      if (index > lastIndex) {
        parts.push({ text: text.slice(lastIndex, index) });
      }
      const trailingPunctuation = rawUrl.match(/[),.;:!?]+$/)?.[0] ?? '';
      const cleanUrl = trailingPunctuation ? rawUrl.slice(0, -trailingPunctuation.length) : rawUrl;
      parts.push({ text: cleanUrl, url: normalizedLinkUrl(cleanUrl) });
      if (trailingPunctuation) {
        parts.push({ text: trailingPunctuation });
      }
      lastIndex = index + rawUrl.length;
    }
    if (lastIndex < text.length) {
      parts.push({ text: text.slice(lastIndex) });
    }
    return parts;
  }

  function messageTelemostUrls(text: string): string[] {
    return Array.from(new Set(
      linkParts(text)
        .map((part) => part.url)
        .filter((url): url is string => Boolean(url))
        .filter(isTelemostUrl)
    ));
  }

  function isTelemostUrl(url: string): boolean {
    try {
      return new URL(url).hostname.endsWith('telemost.yandex.ru');
    } catch {
      return false;
    }
  }

  function katyaMeetingStorageKey(url: string): string {
    return `${katyaMeetingStoragePrefix}${url}`;
  }

  function dailyMeetingTitle(): string {
    return `Дэйлик ${new Intl.DateTimeFormat('ru-RU').format(new Date())}`;
  }

  async function inviteKatyaToTelemost(url: string) {
    setPendingTelemostUrl(url);
    setTelemostStatusText('');
    try {
      const sessionCookie = await api.getKatyaSession();
      if (!sessionCookie.trim()) {
        setTelemostStatusText('Нет сохраненной сессии Кати.');
        return;
      }

      const meeting = await api.createKatyaMeeting({
        baseUrl: katyaDefaultBaseUrl,
        sessionCookie,
        url,
        title: dailyMeetingTitle(),
        groupId: defaultRecordingGroupId || undefined
      });
      window.localStorage.setItem(katyaMeetingStorageKey(url), meeting.id);
      setTelemostStatusText('Катя приглашена.');
    } catch (error) {
      setTelemostStatusText(error instanceof Error ? error.message : 'Не удалось пригласить Катю.');
    } finally {
      setPendingTelemostUrl('');
    }
  }

  async function removeKatyaFromTelemost(url: string) {
    setPendingTelemostUrl(url);
    setTelemostStatusText('');
    try {
      const sessionCookie = await api.getKatyaSession();
      const meetingId = window.localStorage.getItem(katyaMeetingStorageKey(url)) ?? '';
      if (!sessionCookie.trim() || !meetingId) {
        setTelemostStatusText('Нет активной Кати для удаления.');
        return;
      }

      await api.stopKatyaMeeting({
        baseUrl: katyaDefaultBaseUrl,
        sessionCookie,
        meetingId
      });
      window.localStorage.removeItem(katyaMeetingStorageKey(url));
      setTelemostStatusText('Катя удалена.');
    } catch (error) {
      setTelemostStatusText(error instanceof Error ? error.message : 'Не удалось удалить Катю.');
    } finally {
      setPendingTelemostUrl('');
    }
  }

  function renderTelemostActions(url: string) {
    const busyTelemost = pendingTelemostUrl === url;
    return (
      <div className="telemost-message-actions" key={url}>
        <button
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openInternalBrowser(url);
          }}
        >
          Открыть встречу
        </button>
        <button
          disabled={busyTelemost}
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void inviteKatyaToTelemost(url);
          }}
        >
          Пригласить Катю
        </button>
        <button
          disabled={busyTelemost}
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void removeKatyaFromTelemost(url);
          }}
        >
          Удалить Катю
        </button>
        {telemostStatusText && <span>{telemostStatusText}</span>}
      </div>
    );
  }

  function renderMessageText(text: string) {
    return linkParts(text).map((part, index) => {
      if (!part.url) {
        return <span key={`${part.text}-${index}`}>{part.text}</span>;
      }
      const url = part.url;
      return (
        <button
          className="message-link"
          key={`${url}-${index}`}
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openInternalBrowser(url);
          }}
        >
          {part.text}
        </button>
      );
    });
  }

  function replyPreview(message: TelegramMessage): { senderName: string; text: string } | null {
    if (!message.replyToMessageId) {
      return null;
    }
    const localReply = selectedMessagesById.get(message.replyToMessageId);
    return {
      senderName: message.replyToSenderName || localReply?.senderName || 'Ответ',
      text: message.replyToText || messagePreviewText(localReply)
    };
  }

  function findMessageElement(messageId: string): HTMLElement | null {
    const thread = threadRef.current;
    if (!thread) {
      return null;
    }
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return thread.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
    }
    return Array.from(thread.querySelectorAll<HTMLElement>('[data-message-id]'))
      .find((element) => element.dataset.messageId === messageId) ?? null;
  }

  function revealMessage(messageId: string): boolean {
    const messageElement = findMessageElement(messageId);
    if (!messageElement) {
      return false;
    }

    if (typeof messageElement.scrollIntoView === 'function') {
      messageElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    setHighlightedMessageId(messageId);
    if (highlightTimeoutRef.current) {
      clearTimeout(highlightTimeoutRef.current);
    }
    highlightTimeoutRef.current = setTimeout(() => setHighlightedMessageId(''), 1400);
    return true;
  }

  async function openReplyTarget(messageId: string) {
    if (revealMessage(messageId)) {
      setPendingScrollMessageId('');
      return;
    }

    const replyIndex = displayedMessages.findIndex((message) => message.id === messageId);
    if (replyIndex >= 0) {
      previousScrollHeight.current = threadRef.current?.scrollHeight ?? null;
      setPendingScrollMessageId(messageId);
      setRenderedMessageLimit((currentLimit) =>
        Math.min(displayedMessages.length, Math.max(currentLimit, displayedMessages.length - replyIndex + 20))
      );
      return;
    }

    setPendingScrollMessageId(messageId);
    await loadOlderMessages();
  }

  function replacePendingFile(nextFile: PendingFile | null) {
    if (pendingFileUrlRef.current) {
      URL.revokeObjectURL(pendingFileUrlRef.current);
      pendingFileUrlRef.current = '';
    }
    if (nextFile?.previewUrl) {
      pendingFileUrlRef.current = nextFile.previewUrl;
    }
    setPendingFile(nextFile);
  }

  function selectPendingFile(file: File | null | undefined): boolean {
    if (!file) {
      return false;
    }

    replacePendingFile({
      file,
      name: file.name || 'file',
      mimeType: fileMimeType(file),
      previewUrl: isImageFile(file) ? URL.createObjectURL(file) : null
    });
    return true;
  }

  function isImageFile(file: File): boolean {
    return file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(file.name);
  }

  function fileMimeType(file: File): string {
    if (file.type) {
      return file.type;
    }
    const extension = file.name.split('.').pop()?.toLowerCase();
    if (extension === 'jpg' || extension === 'jpeg') {
      return 'image/jpeg';
    }
    if (extension === 'webp') {
      return 'image/webp';
    }
    if (extension === 'gif') {
      return 'image/gif';
    }
    if (extension === 'bmp') {
      return 'image/bmp';
    }
    if (extension === 'tif' || extension === 'tiff') {
      return 'image/tiff';
    }
    if (extension === 'pdf') {
      return 'application/pdf';
    }
    if (extension === 'zip') {
      return 'application/zip';
    }
    if (extension === 'json') {
      return 'application/json';
    }
    if (extension === 'txt' || extension === 'log' || extension === 'md') {
      return 'text/plain';
    }
    return 'application/octet-stream';
  }

  function firstDroppedFile(files: FileList | null): File | null {
    return Array.from(files ?? []).find((file) => file.size > 0 || file.name) ?? null;
  }

  function hasFileTransfer(event: DragEvent<HTMLElement>): boolean {
    return Boolean(
      firstDroppedFile(event.dataTransfer.files) ||
      Array.from(event.dataTransfer.items ?? []).some((item) => item.kind === 'file')
    );
  }

  function handleDragOver(event: DragEvent<HTMLElement>) {
    if (!hasFileTransfer(event)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDraggingFile(true);
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    const droppedFile = firstDroppedFile(event.dataTransfer.files);
    if (!droppedFile) {
      setDraggingFile(false);
      return;
    }

    event.preventDefault();
    selectPendingFile(droppedFile);
    setDraggingFile(false);
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pastedFile = firstDroppedFile(event.clipboardData.files);
    if (!pastedFile) {
      return;
    }

    event.preventDefault();
    selectPendingFile(pastedFile);
  }

  async function submitOutgoingMessage() {
    const text = outgoingText.trim();
    const outgoingFile = pendingFile;
    if (!selectedChatId || (!text && !outgoingFile)) {
      return;
    }

    const optimisticId = `optimistic:${selectedChatId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const topicId = selectedTopicId && selectedTopicId !== 'all' ? selectedTopicId : undefined;
    const replyToMessageId = replyingToMessageId || undefined;
    const sentAt = new Date().toISOString();
    const optimisticMessage: OptimisticMessage = {
      id: optimisticId,
      chatId: selectedChatId,
      topicId: topicId ?? null,
      replyToMessageId: replyToMessageId ?? null,
      replyToSenderName: replyingToMessage?.senderName ?? null,
      replyToText: messagePreviewText(replyingToMessage),
      senderId: null,
      senderName: 'Вы',
      senderAvatar: null,
      sentAt,
      text,
      attachments: outgoingFile
        ? [{
            id: `${optimisticId}:attachment`,
            type: isImageFile(outgoingFile.file) ? 'image' : 'file',
            fileName: outgoingFile.name,
            mimeType: outgoingFile.mimeType,
            size: outgoingFile.file.size,
            dataUrl: null
          }]
        : [],
      reactions: [],
      status: 'new',
      createdAt: sentAt,
      updatedAt: sentAt,
      deliveryStatus: 'sending'
    };

    setOptimisticMessages((current) => [...current, optimisticMessage]);
    setOutgoingText('');
    setReplyingToMessageId('');
    replacePendingFile(null);
    forceBottomUntilRef.current = Date.now() + 1200;
    scheduleThreadScrollToBottom(3);

    try {
      const file = outgoingFile
        ? {
            name: outgoingFile.name,
            mimeType: outgoingFile.mimeType,
            data: await outgoingFile.file.arrayBuffer()
          }
        : undefined;
      const nextState = await api.sendTelegramMessage({
        chatId: selectedChatId,
        topicId,
        replyToMessageId,
        text,
        file,
        image: file && outgoingFile && isImageFile(outgoingFile.file) ? file : undefined
      });
      onState(nextState);
      setOptimisticMessages((current) => current.filter((message) => message.id !== optimisticId));
    } catch {
      setOptimisticMessages((current) =>
        current.map((message) =>
          message.id === optimisticId
            ? { ...message, deliveryStatus: 'failed', updatedAt: new Date().toISOString() }
            : message
        )
      );
    }
  }

  const replyingToMessage = replyingToMessageId
    ? selectedMessages.find((message) => message.id === replyingToMessageId)
    : undefined;

  return (
      <div className="inbox-layout messenger-layout">
        {previewImage && (
          <ImageLightbox
            src={previewImage.src}
            alt={previewImage.alt}
            onClose={() => setPreviewImage(null)}
          />
        )}
        <section className="chat-list messenger-chat-list">
          <input
            className="chat-search"
            value={chatQuery}
            onChange={(event) => setChatQuery(event.target.value)}
            placeholder="Search"
          />
          {visibleChats.map((chat) => {
            const latestMessage = latestMessagesByChat.get(chat.id);
            const notificationsEnabled = chat.notificationsEnabled !== false;
            return (
              <div
                key={chat.id}
                className={chat.id === selectedChatId ? 'chat-item active' : 'chat-item'}
              >
                <button
                  className="chat-button"
                  onClick={() => setSelectedChatId(chat.id)}
                >
                  <span className="chat-avatar" aria-hidden="true">
                    {chat.avatar ? <img src={chat.avatar} alt="" /> : initials(chat.title)}
                  </span>
                  <span className="chat-button-body">
                    <span className="chat-title-row">
                      <strong>{chat.title}</strong>
                      <time>{formatChatTime(chat.lastMessageAt ?? latestMessage?.sentAt ?? chat.lastSyncedAt)}</time>
                    </span>
                    <span className="chat-preview-row">
                      <span className="chat-preview">
                        {latestMessagePreview(latestMessage)}
                      </span>
                      {(chat.unreadCount ?? 0) > 0 && (
                        <em className={notificationsEnabled ? 'unread-badge' : 'unread-badge muted'}>
                          {chat.unreadCount}
                        </em>
                      )}
                    </span>
                  </span>
                </button>
                <button
                  aria-label={notificationsEnabled ? `Отключить уведомления: ${chat.title}` : `Включить уведомления: ${chat.title}`}
                  className={notificationsEnabled ? 'chat-notification-toggle active' : 'chat-notification-toggle'}
                  disabled={pendingNotificationChatId === chat.id}
                  onClick={() => void toggleChatNotifications(chat)}
                  title={notificationsEnabled ? 'Уведомления включены' : 'Уведомления выключены'}
                  type="button"
                >
                  <svg aria-hidden="true" viewBox="0 0 24 24">
                    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
                    <path d="M13.7 21a2 2 0 0 1-3.4 0" />
                    {!notificationsEnabled && <path d="m4 4 16 16" />}
                  </svg>
                </button>
              </div>
            );
          })}
          {visibleChats.length === 0 && <p className="empty-state">Чаты не найдены.</p>}
        </section>

        <section
          className={draggingFile ? 'message-list messenger-message-list dragging-file' : 'message-list messenger-message-list'}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDraggingFile(false);
            }
          }}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <div className="messenger-chat-header">
            <div>
              <h2>{selectedChat?.title ?? 'Чат не выбран'}</h2>
              <p>
                {selectedTopic ? selectedTopic.title : selectedChatTopics.length > 0 ? 'Все топики' : 'Чат'} ·{' '}
                {displayedMessages.length} сообщений
                {hiddenLoadedMessageCount > 0 ? ` · показаны последние ${renderedMessages.length}` : ''}
              </p>
            </div>
            <div className="messenger-chat-tools">
              <button
                className="primary-action"
                disabled={busy || selectedMessageIds.length === 0 || state.redmine.status !== 'connected'}
                onClick={createIssueFromMessages}
              >
                {busy ? 'Создаем...' : 'Создать задачу'}
              </button>
            </div>
          </div>

          {selectedChatTopics.length > 0 && (
            <div
              className="topic-tabs"
              aria-label="Топики"
              ref={topicTabsRef}
              onWheel={scrollTopicTabs}
            >
              <button
                type="button"
                className={selectedTopicId === 'all' ? 'active' : ''}
                onClick={() => void openTopic('all')}
              >
                Все
              </button>
              {selectedChatTopics.map((topic) => (
                <button
                  type="button"
                  key={topic.id}
                  className={topic.id === selectedTopicId ? 'active' : ''}
                  onClick={() => void openTopic(topic.id)}
                >
                  <span>{topic.title}</span>
                  {topic.unreadCount > 0 && <em>{topic.unreadCount}</em>}
                </button>
              ))}
            </div>
          )}

          {displayedMessages.length === 0 && (
            <p className="empty-state">
              Нет сообщений в выбранном чате.
            </p>
          )}

          <div
            className="telegram-thread"
            ref={threadRef}
            onScroll={(event) => {
              if (event.currentTarget.scrollTop <= 24) {
                void loadOlderMessages();
              }
            }}
          >
            {loadingOlder && <div className="history-loader">Загружаем старые сообщения...</div>}
            {hiddenLoadedMessageCount > 0 && (
              <button
                className="history-loader"
                type="button"
                onClick={() => void loadOlderMessages()}
              >
                Показать еще {Math.min(hiddenLoadedMessageCount, renderedMessageLimitStep)} сообщений
              </button>
            )}
            {renderedMessages.map((message) => {
              const selected = selectedMessageIdSet.has(message.id);
              const own = message.senderName === 'Вы';
              const deliveryStatus = 'deliveryStatus' in message
                ? message.deliveryStatus as OptimisticMessage['deliveryStatus']
                : null;
              const reply = replyPreview(message);
              const telemostUrls = messageTelemostUrls(message.text);
              const thumbsUpReaction = message.reactions?.find((reaction) => reaction.emoticon === '👍');
              const visibleReactions = visibleMessageReactions(message);
              return (
                <div
                  key={message.id}
                  data-message-id={message.id}
                  className={[
                    'message-row',
                    selected ? 'selected' : '',
                    own ? 'own-message' : '',
                    deliveryStatus ? `delivery-${deliveryStatus}` : '',
                    highlightedMessageId === message.id ? 'reply-target-highlight' : ''
                  ].join(' ')}
                  onClick={(event) => {
                    if (deliveryStatus || isMessageActionTarget(event.target)) {
                      return;
                    }
                    event.preventDefault();
                    toggleMessageSelection(message, selected);
                  }}
                  onKeyDown={(event) => {
                    if (deliveryStatus || isMessageActionTarget(event.target)) {
                      return;
                    }
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      toggleMessageSelection(message, selected);
                    }
                  }}
                  tabIndex={deliveryStatus ? -1 : 0}
                >
                  <input
                    type="checkbox"
                    aria-label={`Выбрать сообщение от ${message.senderName}: ${messagePreviewText(message)}`}
                    checked={selected}
                    disabled={Boolean(deliveryStatus)}
                    onChange={(event) =>
                      setSelectedMessageIds(
                        event.target.checked
                          ? [...selectedMessageIds, message.id]
                          : selectedMessageIds.filter((id) => id !== message.id)
                      )
                    }
                  />
                  {!own && (
                    <span className="message-avatar" aria-hidden="true">
                      {message.senderAvatar ? (
                        <img src={message.senderAvatar} alt="" />
                      ) : (
                        initials(message.senderName)
                      )}
                    </span>
                  )}
                  <div className="message-bubble">
                    <div className="message-meta">
                      <strong>{message.senderName}</strong>
                      <span>{formatDate(message.sentAt)}</span>
                      <button
                        aria-label="Поставить палец вверх"
                        className={[
                          'message-reaction-button',
                          thumbsUpReaction?.mine ? 'active' : ''
                        ].join(' ')}
                        disabled={Boolean(deliveryStatus) || pendingReactionMessageId === message.id || thumbsUpReaction?.mine}
                        title={reactionUsersTitle(thumbsUpReaction)}
                        type="button"
                        onClick={(event) => {
                          event.preventDefault();
                          void reactWithThumbsUp(message);
                        }}
                      >
                        <span aria-hidden="true">👍</span>
                        {(thumbsUpReaction?.count ?? 0) > 0 && <em>{thumbsUpReaction?.count}</em>}
                      </button>
                      <button
                        aria-label="Ответить"
                        className="message-reply-button"
                        disabled={Boolean(deliveryStatus)}
                        title="Ответить"
                        type="button"
                        onClick={(event) => {
                          event.preventDefault();
                          setReplyingToMessageId(message.id);
                        }}
                      >
                        <svg aria-hidden="true" viewBox="0 0 24 24">
                          <path d="M9 7 4 12l5 5" />
                          <path d="M5 12h8a7 7 0 0 1 7 7v1" />
                        </svg>
                      </button>
                      {deliveryStatus && (
                        <span className={`message-delivery ${deliveryStatus}`}>
                          {deliveryStatus === 'sending' ? 'Отправляется...' : 'Не отправлено'}
                        </span>
                      )}
                    </div>
                    {reply && (
                      <button
                        aria-label={`Перейти к сообщению: ${reply.senderName}`}
                        className="message-reply-preview"
                        type="button"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          if (message.replyToMessageId) {
                            void openReplyTarget(message.replyToMessageId);
                          }
                        }}
                      >
                        <strong>{reply.senderName}</strong>
                        <span>{reply.text}</span>
                      </button>
                    )}
                    {telemostUrls.map(renderTelemostActions)}
                    {(message.attachments ?? []).map((attachment) => (
                      (() => {
                        const key = attachmentKey(message, attachment);
                        const videoUrl = attachmentVideoUrls[key] ?? '';
                        const videoAttachment = isVideoAttachment(attachment);
                        const downloadingAttachment = Boolean(downloadingAttachmentIds[key]);
                        return (
                          <div
                            className={[
                              'message-attachment',
                              attachment.type === 'sticker' ? 'sticker' : '',
                              videoAttachment ? 'video' : ''
                            ].filter(Boolean).join(' ')}
                            key={attachment.id}
                          >
                            {renderAttachmentPreview(attachment, videoUrl)}
                            {showAttachmentDownload(attachment) && !videoUrl && !attachment.dataUrl && (
                              <button
                                type="button"
                                disabled={downloadingAttachment}
                                onClick={() => void downloadAttachment(message, attachment)}
                              >
                                {downloadingAttachment
                                  ? 'Загрузка...'
                                  : videoAttachment ? 'Загрузить видео' : 'Скачать'}
                              </button>
                            )}
                          </div>
                        );
                      })()
                    ))}
                    {message.text && <p>{renderMessageText(message.text)}</p>}
                    {visibleReactions.length > 0 && (
                      <div className="message-reactions" aria-label="Реакции">
                        {visibleReactions.map((reaction) => (
                          <details
                            className={reaction.mine ? 'active' : ''}
                            key={reaction.emoticon}
                            title={reactionUsersTitle(reaction)}
                          >
                            <summary aria-label={`Реакция ${reaction.emoticon}: ${reaction.count}. ${reactionUsersSummary(reaction)}`}>
                              <span aria-hidden="true">{reaction.emoticon}</span>
                              <em>{reaction.count}</em>
                            </summary>
                            <div className="message-reaction-popover">
                              {(reaction.users ?? []).length > 0 ? (
                                reaction.users?.map((user) => <span key={user}>{user}</span>)
                              ) : (
                                <span>Список пользователей недоступен</span>
                              )}
                            </div>
                          </details>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <form
            className={[
              'composer',
              pendingFile ? 'has-attachment' : '',
              draggingFile ? 'drag-active' : ''
            ].join(' ')}
            onSubmit={(event) => {
              event.preventDefault();
              void submitOutgoingMessage();
            }}
          >
            {replyingToMessage && (
              <div className="composer-reply-preview">
                <div>
                  <strong>{replyingToMessage.senderName}</strong>
                  <span>{messagePreviewText(replyingToMessage)}</span>
                </div>
                <button
                  aria-label="Убрать ответ"
                  onClick={() => setReplyingToMessageId('')}
                  type="button"
                >
                  x
                </button>
              </div>
            )}
            {pendingFile && (
              <div className="composer-attachment-preview">
                {pendingFile.previewUrl ? (
                  <img src={pendingFile.previewUrl} alt="" />
                ) : (
                  <span className="file-preview-icon" aria-hidden="true">FILE</span>
                )}
                <span>{pendingFile.name}</span>
                <button
                  aria-label="Убрать файл"
                  onClick={() => replacePendingFile(null)}
                  type="button"
                >
                  x
                </button>
              </div>
            )}
            <textarea
              ref={composerTextareaRef}
              rows={1}
              value={outgoingText}
              onChange={(event) => setOutgoingText(event.target.value)}
              onPaste={handlePaste}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey) {
                  return;
                }
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }}
              placeholder={
                selectedChat
                  ? `Сообщение в ${selectedTopic?.title ?? selectedChat.title}`
                  : 'Выберите чат'
              }
            />
            <button
              aria-label="Отправить"
              className="primary-action send-icon-button"
              disabled={!selectedChatId || (!outgoingText.trim() && !pendingFile)}
              type="submit"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M3.5 20.5 21 12 3.5 3.5 6 10.5 14 12l-8 1.5-2.5 7z" />
              </svg>
            </button>
          </form>
        </section>
      </div>
  );
}
