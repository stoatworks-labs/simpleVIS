import { useCallback, useState } from 'react';

interface Props {
  onFile: (file: File) => void;
  onLoadExample: () => void;
  busy: string | null;
}

/** First-run target. Drag-and-drop works in both backends, so it is never gated. */
export function DropZone({ onFile, onLoadExample, busy }: Props) {
  const [over, setOver] = useState(false);

  const drop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      const file = [...e.dataTransfer.files].find((f) => f.name.toLowerCase().endsWith('.mvr'));
      if (file) onFile(file);
    },
    [onFile],
  );

  return (
    <div
      className={`dropzone${over ? ' dropzone--over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
    >
      <div className="dropzone__inner">
        <svg viewBox="0 0 64 64" width="56" height="56" aria-hidden="true">
          <path d="M32 6 L52 22 L44 22 L44 40 L20 40 L20 22 L12 22 Z" fill="currentColor" opacity="0.25" />
          <path d="M12 46 h40 M18 54 h28" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
        </svg>
        <h2>{busy ?? 'Drop an MVR here'}</h2>
        {!busy && (
          <>
            <p>Exported from grandMA3, Vectorworks, Capture or any MVR-capable tool.</p>
            <button className="button" onClick={onLoadExample}>Or load the example rig</button>
          </>
        )}
      </div>
    </div>
  );
}
