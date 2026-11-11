import { useEffect, useId, useRef, useState } from 'react';
import { AnimatedDialog } from './AnimatedDialog';

interface PlayerScreenDialogProps {
  onCreate: () => Promise<string | null>;
  onClose: () => void;
  error: string | null;
}

export function PlayerScreenDialog({ onCreate, onClose, error }: PlayerScreenDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const requestRef = useRef<Promise<string | null> | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const origin = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (origin instanceof HTMLElement && origin.isConnected) origin.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    let active = true;
    const request = requestRef.current ??= onCreate();
    void request.then((url) => {
      if (active) { setLink(url); setLoading(false); }
    }).catch(() => {
      if (active) { setLink(null); setLoading(false); }
    });
    return () => { active = false; };
  }, [onCreate, revision]);

  return <AnimatedDialog ref={dialogRef} className="dialog" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="dialog__header">
      <h2 id={titleId}>Player screen</h2>
      <button type="button" className="icon-button" aria-label="Close player screen controls" onClick={onClose}><span aria-hidden="true">×</span></button>
    </div>
    <div className="dialog__body">
      <p id={descriptionId}>Read-only. Updates every 5 seconds.</p>
      {loading ? <p role="status"><span className="spinner spinner--small" aria-hidden="true" /> Preparing link…</p> : !link ? <div className="inline-alert inline-alert--error" role="alert">{error || 'Unable to create player screen.'}</div> : null}
      {copyError ? <div className="inline-alert inline-alert--error" role="alert">{copyError}</div> : null}
      <div className="dialog__actions">
        {link ? <>
          <button type="button" className="button button--secondary" onClick={async () => {
            setCopyError(null);
            try { await navigator.clipboard.writeText(link); setCopied(true); }
            catch { setCopyError('Unable to copy. Open the screen and copy its address.'); }
          }}>{copied ? 'Copied' : 'Copy link'}</button>
          <a className="button button--primary" href={link} target="_blank" rel="noopener noreferrer">Open screen</a>
        </> : !loading ? <button type="button" className="button button--primary" onClick={() => {
          requestRef.current = null; setLoading(true); setCopied(false); setCopyError(null); setRevision((value) => value + 1);
        }}>Retry</button> : null}
      </div>
    </div>
  </AnimatedDialog>;
}
