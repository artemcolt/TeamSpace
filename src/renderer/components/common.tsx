import { useEffect, useMemo, useState } from 'react';

export function StatusPill({ label, status }: { label: string; status: ConnectionStatus }) {
  return (
    <div className="status-row">
      <span>{label}</span>
      <strong className={`status-pill ${status}`}>{status === 'connected' ? 'OK' : status}</strong>
    </div>
  );
}

export function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-line">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function ImageLightbox({
  src,
  alt,
  onClose
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={alt || 'Просмотр изображения'}>
      <button
        className="image-lightbox-backdrop"
        type="button"
        aria-label="Закрыть полноэкранный просмотр"
        onClick={onClose}
      />
      <div className="image-lightbox-panel">
        <button className="image-lightbox-close" type="button" aria-label="Закрыть изображение" onClick={onClose}>
          ×
        </button>
        <img src={src} alt={alt} />
        {alt && <div className="image-lightbox-caption">{alt}</div>}
      </div>
    </div>
  );
}

export function SelectField({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: string;
  options: RedmineOption[];
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Не выбрано</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>{option.name}</option>
        ))}
      </select>
    </label>
  );
}

export function SearchableSelectField({
  label,
  value,
  options,
  onChange,
  placeholder
}: {
  label: string;
  value: string;
  options: RedmineOption[];
  onChange: (value: string) => void;
  placeholder: string;
}) {
  const selectedOption = options.find((option) => option.id === value);
  const [query, setQuery] = useState(selectedOption?.name ?? '');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      setQuery(selectedOption?.name ?? '');
    }
  }, [open, selectedOption?.name]);

  const filteredOptions = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('ru-RU');
    const source = needle
      ? options.filter((option) => option.name.toLocaleLowerCase('ru-RU').includes(needle))
      : options;
    return source.slice(0, 60);
  }, [options, query]);

  function choose(nextValue: string) {
    onChange(nextValue);
    setOpen(false);
  }

  return (
    <div className="search-select">
      <label>
        <span>{label}</span>
        <div className="search-select-input">
          <input
            value={query}
            onFocus={(event) => {
              setOpen(true);
              event.currentTarget.select();
            }}
            onBlur={() => {
              window.setTimeout(() => setOpen(false), 120);
            }}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setOpen(false);
              }
              if (event.key === 'Enter' && filteredOptions[0]) {
                event.preventDefault();
                choose(filteredOptions[0].id);
              }
            }}
            placeholder={placeholder}
          />
          {value && (
            <button
              type="button"
              aria-label="Очистить исполнителя"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose('')}
            >
              ×
            </button>
          )}
        </div>
      </label>
      {open && (
        <div className="search-select-menu" role="listbox">
          <button
            type="button"
            className={!value ? 'selected' : ''}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => choose('')}
          >
            <strong>Не назначать</strong>
          </button>
          {filteredOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              className={option.id === value ? 'selected' : ''}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(option.id)}
            >
              <strong>{option.name}</strong>
            </button>
          ))}
          {filteredOptions.length === 0 && (
            <div className="search-select-empty">Ничего не найдено</div>
          )}
        </div>
      )}
    </div>
  );
}
