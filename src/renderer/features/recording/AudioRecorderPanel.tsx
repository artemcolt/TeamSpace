import { useEffect, useRef, useState } from 'react';
import { api } from '../../domain/bridge';

export type RecorderPhase = 'idle' | 'requesting' | 'recording' | 'saving';

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(restSeconds).padStart(2, '0')}`;
}

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function recordingFileName(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, '')
    .replace(/[:T]/g, '-');

  return `team-space-recording-${stamp}.webm`;
}

function mediaRecorderMimeType(hasVideo: boolean): string | undefined {
  const candidates = hasVideo
    ? [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=opus',
        'video/webm'
      ]
    : [
        'audio/webm;codecs=opus',
        'audio/webm',
        'video/webm;codecs=opus',
        'video/webm'
      ];

  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

export function useAudioRecorder() {
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [duration, setDuration] = useState(0);
  const [includeScreenVideo, setIncludeScreenVideo] = useState(true);
  const [includeSystemAudio, setIncludeSystemAudio] = useState(true);
  const [includeMicrophone, setIncludeMicrophone] = useState(true);
  const [statusText, setStatusText] = useState('');
  const [error, setError] = useState('');
  const [lastSaved, setLastSaved] = useState<RecordingSaveResult | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (phase !== 'recording') {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setDuration(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 500);

    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    return () => {
      recorderRef.current?.state === 'recording' && recorderRef.current.stop();
      stopStream(displayStreamRef.current);
      stopStream(microphoneStreamRef.current);
      void audioContextRef.current?.close();
    };
  }, []);

  function cleanupStreams() {
    stopStream(displayStreamRef.current);
    stopStream(microphoneStreamRef.current);
    displayStreamRef.current = null;
    microphoneStreamRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
  }

  async function startRecording() {
    setError('');
    setStatusText('');
    setLastSaved(null);

    if (!includeScreenVideo && !includeSystemAudio && !includeMicrophone) {
      setError('Выберите видео экрана, системный звук, микрофон или несколько источников.');
      return;
    }
    if (!window.MediaRecorder) {
      setError('MediaRecorder недоступен в этой версии Chromium/Electron.');
      return;
    }

    setPhase('requesting');

    let displayStream: MediaStream | null = null;
    let microphoneStream: MediaStream | null = null;

    try {
      if (includeScreenVideo || includeSystemAudio) {
        displayStream = await navigator.mediaDevices.getDisplayMedia({
          audio: includeSystemAudio,
          video: true
        });
        displayStreamRef.current = displayStream;
        displayStream.getVideoTracks().forEach((track) => {
          track.addEventListener('ended', () => {
            if (recorderRef.current?.state === 'recording') {
              setStatusText('Захват экрана завершен. Останавливаю запись и сохраняю файл.');
              stopRecording();
            }
          });
        });
      }

      if (includeMicrophone) {
        microphoneStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true
          },
          video: false
        });
        microphoneStreamRef.current = microphoneStream;
      }

      const audioSources = [displayStream, microphoneStream].filter(
        (stream): stream is MediaStream => Boolean(stream?.getAudioTracks().length)
      );
      const videoTracks = includeScreenVideo ? displayStream?.getVideoTracks() ?? [] : [];

      if (audioSources.length === 0 && videoTracks.length === 0) {
        throw new Error('Не удалось получить аудио или видео. На macOS может потребоваться разрешение Screen & System Audio Recording или виртуальный аудиодрайвер.');
      }

      if (includeSystemAudio && !displayStream?.getAudioTracks().length) {
        setStatusText(
          includeScreenVideo
            ? 'Системный звук недоступен для выбранного источника. Записывается видео экрана и доступный микрофон.'
            : 'Системный звук недоступен для выбранного источника. Запись идет только с микрофона.'
        );
      } else {
        const parts = [
          includeScreenVideo && videoTracks.length ? 'видео экрана' : '',
          includeSystemAudio && displayStream?.getAudioTracks().length ? 'системный звук' : '',
          includeMicrophone && microphoneStream?.getAudioTracks().length ? 'микрофон' : ''
        ].filter(Boolean);
        setStatusText(`Записывается: ${parts.join(', ')}.`);
      }

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      const destination = audioContext.createMediaStreamDestination();

      audioSources.forEach((stream) => {
        audioContext.createMediaStreamSource(stream).connect(destination);
      });

      const recordingStream = new MediaStream([
        ...videoTracks,
        ...destination.stream.getAudioTracks()
      ]);
      const hasVideo = recordingStream.getVideoTracks().length > 0;
      const mimeType = mediaRecorderMimeType(hasVideo);
      const recorder = new MediaRecorder(
        recordingStream,
        mimeType ? { mimeType } : undefined
      );

      chunksRef.current = [];
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        void saveRecording(mimeType ?? 'audio/webm');
      };

      startedAtRef.current = Date.now();
      setDuration(0);
      recorder.start(1000);
      setPhase('recording');
    } catch (startError) {
      cleanupStreams();
      setPhase('idle');
      setError(startError instanceof Error ? startError.message : 'Не удалось начать запись.');
    }
  }

  async function saveRecording(mimeType: string) {
    setPhase('saving');

    try {
      const blob = new Blob(chunksRef.current, { type: mimeType });
      if (blob.size === 0) {
        throw new Error('Запись не содержит данных.');
      }

      const result = await api.saveRecording({
        fileName: recordingFileName(),
        data: await blob.arrayBuffer()
      });

      setLastSaved(result);
      setStatusText('Запись сохранена.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Не удалось сохранить запись.');
    } finally {
      cleanupStreams();
      chunksRef.current = [];
      recorderRef.current = null;
      setPhase('idle');
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      return;
    }

    setPhase('saving');
    recorder.stop();
  }

  return {
    duration,
    error,
    includeMicrophone,
    includeScreenVideo,
    includeSystemAudio,
    lastSaved,
    phase,
    setIncludeMicrophone,
    setIncludeScreenVideo,
    setIncludeSystemAudio,
    startRecording,
    statusText,
    stopRecording
  };
}

export function AudioRecorderControls({
  recorder,
  description
}: {
  recorder: ReturnType<typeof useAudioRecorder>;
  description?: string;
}) {
  const {
    duration,
    error,
    includeMicrophone,
    includeScreenVideo,
    includeSystemAudio,
    lastSaved,
    phase,
    setIncludeMicrophone,
    setIncludeScreenVideo,
    setIncludeSystemAudio,
    startRecording,
    statusText,
    stopRecording
  } = recorder;

  return (
    <section className="panel recorder-panel">
      <p className="panel-label">Meeting recording</p>
      <h3>Запись встречи</h3>
      <p className="helper">
        {description ??
          'Запись сохраняется локально в папку Documents/Team Space Recordings. Перед стартом выберите экран или окно, где идет встреча, и включите доступ к микрофону, если нужен ваш голос.'}
      </p>

      <div className="recorder-controls">
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={includeScreenVideo}
            disabled={phase !== 'idle'}
            onChange={(event) => setIncludeScreenVideo(event.target.checked)}
          />
          <span>Видео экрана</span>
        </label>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={includeSystemAudio}
            disabled={phase !== 'idle'}
            onChange={(event) => setIncludeSystemAudio(event.target.checked)}
          />
          <span>Системный звук</span>
        </label>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={includeMicrophone}
            disabled={phase !== 'idle'}
            onChange={(event) => setIncludeMicrophone(event.target.checked)}
          />
          <span>Мой микрофон</span>
        </label>
        <div className={phase === 'recording' ? 'recording-timer active' : 'recording-timer'}>
          {phase === 'recording' ? formatDuration(duration) : '00:00'}
        </div>
      </div>

      {statusText && <p className="inline-hint">{statusText}</p>}
      {error && <p className="error-text">{error}</p>}
      {lastSaved && (
        <p className="success-text">
          Файл сохранен: {lastSaved.filePath}
        </p>
      )}

      <div className="actions">
        {phase === 'recording' ? (
          <button className="danger-action" onClick={stopRecording}>
            Остановить запись
          </button>
        ) : (
          <button className="primary-action" disabled={phase !== 'idle'} onClick={startRecording}>
            {phase === 'requesting' ? 'Ожидаю доступ...' : phase === 'saving' ? 'Сохраняю...' : 'Начать запись'}
          </button>
        )}
        <button
          className="secondary-action"
          disabled={!lastSaved || phase !== 'idle'}
          onClick={() => lastSaved && api.openRecordingFolder(lastSaved.directory)}
        >
          Открыть папку
        </button>
      </div>
    </section>
  );
}

export function AudioRecorderPanel() {
  const recorder = useAudioRecorder();

  return <AudioRecorderControls recorder={recorder} />;
}
