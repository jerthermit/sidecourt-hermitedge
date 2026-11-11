import { useEffect, useId, useRef, useState } from 'react';
import { AnimatedDialog } from './AnimatedDialog';
import type { ClubSettings, Session } from '../types/models';
import { CLUB_CONFIGURATION_MAX_BYTES, downloadClubConfiguration, parseClubConfiguration } from '../lib/clubConfiguration';

interface SessionDialogProps {
  settings: ClubSettings;
  session: Session;
  busy: boolean;
  hasActiveMatch: boolean;
  error: string | null;
  publicAccess: boolean;
  onClose: () => void;
  onSaveSettings: (settings: ClubSettings) => Promise<boolean>;
  onStart: (name: string, includePreviousRoster?: boolean) => Promise<boolean>;
  onEnd: () => Promise<boolean>;
  onReset: () => Promise<boolean>;
}

export function SessionDialog({
  settings, session, busy, hasActiveMatch, error, publicAccess,
  onClose, onSaveSettings, onStart, onEnd, onReset,
}: SessionDialogProps) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<ClubSettings>({ ...settings,
    courtNames: settings.courtNames ?? Array.from({ length: settings.courtCount }, (_, index) => `Court ${index + 1}`),
    rotationMode: settings.rotationMode ?? 'open', avoidRepeatPartners: settings.avoidRepeatPartners ?? true,
  });
  const [name, setName] = useState('');
  const [includePreviousRoster, setIncludePreviousRoster] = useState(false);
  const [confirmation, setConfirmation] = useState<'close' | 'reset' | null>(null);
  const [notice, setNotice] = useState('');
  const [configurationError, setConfigurationError] = useState<string | null>(null);
  const configurationInput = useRef<HTMLInputElement>(null);
  const [readingConfiguration, setReadingConfiguration] = useState(false);
  const configurationRevision = useRef(0);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const clubLocked = busy || hasActiveMatch || readingConfiguration;

  useEffect(() => {
    const dialog = dialogRef.current;
    const origin = document.activeElement;
    dialog?.showModal();
    return () => {
      configurationRevision.current += 1;
      dialog?.close();
      if (origin instanceof HTMLElement && origin.isConnected) origin.focus({ preventScroll: true });
    };
  }, []);

  return (
    <AnimatedDialog ref={dialogRef} className="dialog dialog--session" aria-labelledby={id}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
      <div className="dialog__header">
        <h2 id={id}>Session & club</h2>
        <button type="button" className="icon-button" aria-label="Close session settings" disabled={busy} onClick={onClose}><span aria-hidden="true">×</span></button>
      </div>
      <div className="dialog__body dialog__body--scroll session-dialog">
        {error ? <div className="inline-alert inline-alert--error" role="alert">{error}</div> : null}
        {notice ? <div className="inline-alert inline-alert--success" role="status">{notice}</div> : null}
        <section className="session-section">
          <div className="session-section__heading"><h3>{session.name}</h3><span>{session.endedAt === null ? 'Open' : 'Closed'}</span></div>
          {session.endedAt === null ? (
            <button type="button" className="button button--secondary" disabled={clubLocked} title={hasActiveMatch ? 'End active matches first' : undefined} onClick={() => setConfirmation('close')}>Close session</button>
          ) : (
            <form className="session-inline-form" onSubmit={async (event) => {
              event.preventDefault();
              if (await onStart(name.trim(), includePreviousRoster)) { setName(''); setNotice('Session opened'); }
            }}>
              <label className="form-field"><span>New session</span><input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="Tuesday social" disabled={busy} /></label>
              <label className="checkbox-field"><input type="checkbox" checked={includePreviousRoster} disabled={busy} onChange={(event) => setIncludePreviousRoster(event.target.checked)} /><span>Use previous roster</span></label>
              <button type="submit" className="button button--primary" disabled={busy || !name.trim()}>Open session</button>
            </form>
          )}
        </section>

        <section className="session-section">
          <div className="session-section__heading"><h3>Club</h3>
            <div className="session-button-row">
              <button type="button" className="button button--ghost button--small" disabled={busy} onClick={() => {
                setConfigurationError(null);
                try { downloadClubConfiguration(settings); } catch (failure) { setConfigurationError(failure instanceof Error ? failure.message : 'Unable to export configuration.'); }
              }}>Export settings</button>
              <button type="button" className="button button--secondary button--small" disabled={busy || hasActiveMatch || readingConfiguration} onClick={() => configurationInput.current?.click()}>{readingConfiguration ? 'Reading…' : 'Import settings'}</button>
            </div>
          </div>
          <input ref={configurationInput} type="file" accept=".json,application/json" hidden aria-label="Club settings file" disabled={busy || hasActiveMatch || readingConfiguration} onChange={async (event) => {
            const input = event.currentTarget;
            const file = input.files?.[0];
            if (!file) return;
            const revision = ++configurationRevision.current;
            setConfigurationError(null); setNotice(''); setReadingConfiguration(true);
            try {
              if (file.size > CLUB_CONFIGURATION_MAX_BYTES) throw new Error('Configuration exceeds 32 KiB.');
              const loaded = parseClubConfiguration(await file.text());
              if (configurationRevision.current === revision) { setDraft(loaded); setNotice('Review changes before saving.'); }
            } catch (failure) {
              if (configurationRevision.current === revision) setConfigurationError(failure instanceof Error ? failure.message : 'Unable to read configuration.');
            } finally {
              if (configurationRevision.current === revision) setReadingConfiguration(false);
              input.value = '';
            }
          }} />
          {configurationError ? <p className="field-error" role="alert">{configurationError}</p> : null}
          <form className="session-settings" onSubmit={async (event) => {
            event.preventDefault();
            setNotice('');
            if (await onSaveSettings(draft)) setNotice('Club saved');
          }}>
            <label className="form-field session-settings__wide"><span>Venue name</span><input required maxLength={80} value={draft.venueName} onChange={(event) => setDraft({ ...draft, venueName: event.target.value })} disabled={clubLocked} /></label>
            <label className="form-field"><span>Number of courts</span><select value={draft.courtCount} disabled={clubLocked} onChange={(event) => { const count = Number(event.target.value); setDraft({ ...draft, courtCount: count, courtNames: Array.from({ length: count }, (_, index) => draft.courtNames?.[index] ?? `Court ${index + 1}`) }); }}>{Array.from({ length: 16 }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count}</option>)}</select></label>
            <label className="form-field"><span>Format</span><select value={draft.gameMode} disabled={clubLocked} onChange={(event) => setDraft({ ...draft, gameMode: event.target.value as ClubSettings['gameMode'] })}><option value="doubles">Doubles</option><option value="singles">Singles</option></select></label>
            <label className="form-field session-settings__wide"><span>Time zone</span><input required list="club-timezones" value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })} disabled={clubLocked} /></label>
            <datalist id="club-timezones">{['Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Perth', 'Australia/Adelaide', 'Australia/Darwin', 'Australia/Hobart'].map((zone) => <option key={zone} value={zone} />)}</datalist>
            <fieldset className="court-name-fields session-settings__wide"><legend>Court names</legend>{draft.courtNames?.map((courtName, index) => <label className="form-field" key={index}><span>Court {index + 1}</span><input required maxLength={40} value={courtName} disabled={clubLocked} onChange={(event) => setDraft({ ...draft, courtNames: draft.courtNames?.map((value, position) => position === index ? event.target.value : value) })} /></label>)}</fieldset>
            <label className="form-field session-settings__wide"><span>Rotation</span><select value={draft.rotationMode} disabled={clubLocked} onChange={(event) => setDraft({ ...draft, rotationMode: event.target.value as ClubSettings['rotationMode'] })}><option value="open">Open rotation</option><option value="skill-banded">Skill-banded rotation</option></select></label>
            <label className="checkbox-field session-settings__wide"><input type="checkbox" checked={draft.avoidRepeatPartners} disabled={clubLocked} onChange={(event) => setDraft({ ...draft, avoidRepeatPartners: event.target.checked })} /><span>Vary partners</span></label>
            <button type="submit" className="button button--primary" disabled={busy || hasActiveMatch || readingConfiguration || !dirty}>Save club</button>
            {hasActiveMatch ? <span className="session-muted">End active matches to edit.</span> : null}
          </form>
        </section>

        {publicAccess ? <section className="session-section session-section--inline"><h3>Fresh board</h3><button type="button" className="button button--ghost" disabled={busy} onClick={() => setConfirmation('reset')}>Reset my board</button></section> : null}
        {confirmation ? (
          <div className="session-confirm" role="alert">
            <p>{confirmation === 'close' ? 'Close this session? The roster and records are kept.' : 'Reset your board? Your session records will be removed.'}</p>
            <div className="session-button-row">
              <button type="button" className="button button--secondary" disabled={busy} onClick={() => setConfirmation(null)}>Cancel</button>
              <button type="button" className="button button--danger" disabled={busy} onClick={async () => {
                const success = await (confirmation === 'close' ? onEnd() : onReset());
                if (success) onClose();
              }}>{confirmation === 'close' ? 'Close session' : 'Reset board'}</button>
            </div>
          </div>
        ) : null}
      </div>
    </AnimatedDialog>
  );
}
