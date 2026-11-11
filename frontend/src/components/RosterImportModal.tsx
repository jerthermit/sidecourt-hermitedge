import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AnimatedDialog } from './AnimatedDialog';
import { getRosterCsvHeaders, inferRosterColumnMapping, parseRosterCsv, validateRosterColumnMapping } from '../lib/rosterCsv';
import type { RosterColumnMapping, RosterField } from '../lib/rosterCsv';
import type { RosterImportOptions, RosterImportPreview, RosterImportResult, RosterImportRow } from '../types/models';
import './rosterImport.css';

interface RosterImportModalProps {
  returnFocusTo: HTMLElement | null;
  preview: RosterImportPreview | null;
  result: Pick<RosterImportResult, 'added' | 'skipped' | 'updated' | 'enrolled'> | null;
  isSaving: boolean;
  error: string | null;
  onPreview: (source: string, rows: RosterImportRow[]) => Promise<boolean>;
  onImport: (source: string, rows: RosterImportRow[], options?: RosterImportOptions) => Promise<boolean>;
  onClear: () => void;
  onClose: () => void;
  mapping?: RosterColumnMapping;
  onSaveMapping?: (mapping: RosterColumnMapping) => Promise<boolean>;
}

const COLUMN_FIELDS: Array<{ field: RosterField; label: string; required?: boolean }> = [
  { field: 'externalId', label: 'Player ID', required: true },
  { field: 'name', label: 'Player name', required: true },
  { field: 'skillLevel', label: 'Level' },
  { field: 'skillRating', label: 'Local rating' },
  { field: 'playStyle', label: 'Style' },
];

function ProfileChanges({ row }: { row: RosterImportPreview['rows'][number] }) {
  if (!row.current) return null;
  const fields = [['name', 'Name'], ['skillLevel', 'Level'], ['skillRating', 'Local rating'], ['playStyle', 'Style']] as const;
  const value = (item: string | number | null) => item === null ? 'Unknown' : typeof item === 'number' ? item.toFixed(1) : item;
  return <>{fields.filter(([field]) => row.current![field] !== row[field]).map(([field, label]) =>
    <small key={field}>{label}: {value(row.current![field])} → {value(row[field])}</small>)}</>;
}

export function RosterImportModal({ returnFocusTo, preview, result, isSaving, error, onPreview, onImport, onClear, onClose, mapping, onSaveMapping }: RosterImportModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sourceRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const sourceId = useId();
  const csvId = useId();
  const [source, setSource] = useState('Club roster');
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<RosterImportRow[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [selectedColumns, setSelectedColumns] = useState<RosterColumnMapping | null>(null);
  const [savingColumns, setSavingColumns] = useState(false);
  const [columnsSaved, setColumnsSaved] = useState(false);
  const [applyProfileChanges, setApplyProfileChanges] = useState(false);
  const busy = isSaving || reading || savingColumns;
  const columns = useMemo(() => {
    try {
      const headers = getRosterCsvHeaders(csv);
      let defaults: RosterColumnMapping;
      try {
        validateRosterColumnMapping(headers, mapping ?? {});
        defaults = { ...mapping };
      } catch {
        // Saved venue columns only apply to a compatible file, never by position.
        try { defaults = inferRosterColumnMapping(headers); }
        catch { defaults = {}; }
      }
      return { headers, mapping: selectedColumns ?? defaults };
    } catch {
      // Incomplete pasted CSV is validated on Preview, not on every keystroke.
      return { headers: [], mapping: selectedColumns ?? {} };
    }
  }, [csv, mapping, selectedColumns]);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    sourceRef.current?.focus();
    return () => {
      dialog?.close();
      if (returnFocusTo?.isConnected) returnFocusTo.focus({ preventScroll: true });
    };
  }, [returnFocusTo]);

  const resetPreview = () => { onClear(); setRows([]); setLocalError(null); setApplyProfileChanges(false); };

  const resetColumns = () => { setSelectedColumns(null); setColumnsSaved(false); };

  const changeColumn = (field: RosterField, header: string) => {
    const next = { ...columns.mapping };
    if (header) next[field] = header;
    else delete next[field];
    setSelectedColumns(next);
    setColumnsSaved(false);
    resetPreview();
  };

  const saveColumns = async () => {
    if (!onSaveMapping) return;
    setLocalError(null);
    try {
      validateRosterColumnMapping(columns.headers, columns.mapping);
      setSavingColumns(true);
      if (await onSaveMapping({ ...columns.mapping })) setColumnsSaved(true);
    } catch (failure) {
      setLocalError(failure instanceof Error ? failure.message : 'Couldn’t save columns. Try again.');
    } finally { setSavingColumns(false); }
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    resetPreview();
    resetColumns();
    setCsv('');
    setFileName(null);
    if (file.size > 524_288) { setLocalError('Use a CSV smaller than 512 KB.'); return; }
    setReading(true);
    try { setCsv(await file.text()); setFileName(file.name); }
    catch { setLocalError('Couldn’t read that file. Choose it again or paste the CSV.'); }
    finally { setReading(false); }
  };

  const handlePreview = async (event: React.FormEvent) => {
    event.preventDefault();
    setLocalError(null);
    try {
      const parsed = parseRosterCsv(csv, columns.mapping);
      if (new TextEncoder().encode(JSON.stringify({ source: source.trim(), rows: parsed })).length > 524_288) {
        throw new Error('Roster too large. Import a smaller batch.');
      }
      setRows(parsed);
      await onPreview(source.trim(), parsed);
    } catch (failure) { setLocalError(failure instanceof Error ? failure.message : 'Check the CSV and try again.'); }
  };

  const displayedError = localError ?? error;
  const conflicts = preview?.rows.filter((row) => row.status === 'conflict') ?? [];
  const reviewableChanges = conflicts.length > 0 && preview?.revision !== undefined
    && conflicts.every((row) => row.canUpdate && row.current);
  const joining = (preview?.newCount ?? 0) + (preview?.enrollCount ?? 0);
  const imported = result ? result.added + (result.enrolled ?? 0) : 0;
  const summary = preview ? [joining > 0 ? `${joining} joining` : '',
    preview.existingCount > 0 ? `${preview.existingCount} matching ${preview.existingCount === 1 ? 'profile' : 'profiles'}` : '',
    conflicts.length > 0 ? `${conflicts.length} ${reviewableChanges ? conflicts.length === 1 ? 'change' : 'changes' : conflicts.length === 1 ? 'conflict' : 'conflicts'}` : '',
  ].filter(Boolean).join(' · ') : '';
  const needsColumnMapping = !columns.mapping.externalId || !columns.mapping.name;
  const title = result ? 'Roster imported' : preview ? 'Preview roster' : 'Import roster CSV';

  return (
    <AnimatedDialog ref={dialogRef} className="dialog roster-import" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
      <div className="dialog__header">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-button" aria-label="Close roster import" onClick={onClose} disabled={busy}><span aria-hidden="true">×</span></button>
      </div>
      <div className="dialog__body dialog__body--scroll">
        {result ? (
          <div className="import-complete" role="status">
            <strong>{imported || result.updated || 0}</strong><h3>{imported ? `${imported === 1 ? 'player' : 'players'} added` : result.updated ? `${result.updated === 1 ? 'player' : 'players'} updated` : 'players added'}</h3>
            {imported > 0 ? <p>Awaiting check-in.</p> : null}
            {(result.updated ?? 0) > 0 && imported > 0 ? <p>{result.updated} {result.updated === 1 ? 'profile updated' : 'profiles updated'}.</p> : null}
            {result.skipped > 0 ? <p>{result.skipped} already on the roster.</p> : null}
            <button type="button" className="button button--primary" onClick={onClose}>View roster</button>
          </div>
        ) : (
          <form className="form-stack" onSubmit={handlePreview}>
            {displayedError ? <div className="inline-alert inline-alert--error" role="alert">{displayedError}</div> : null}
            {!preview ? (
              <>
                <p className="field__help import-boundary">Use a club or booking-platform CSV. Bookings and official ratings stay at their source.</p>
                <div className="field">
                  <label htmlFor={sourceId}>Roster source</label>
                  <input ref={sourceRef} id={sourceId} value={source} maxLength={80} required disabled={busy} onChange={(event) => { setSource(event.target.value); resetPreview(); }} aria-describedby={`${sourceId}-identity`} />
                  <span id={`${sourceId}-identity`} className="field__help">Reuse the same source label and player IDs to match existing profiles.</span>
                </div>
                <div className="import-file-row">
                  <input ref={fileRef} type="file" accept=".csv,text/csv" className="sr-only" aria-label="Roster CSV file" tabIndex={-1} disabled={busy} onChange={(event) => { void handleFile(event.target.files?.[0]); event.target.value = ''; }} />
                  <button type="button" className="button button--secondary" disabled={busy} onClick={() => fileRef.current?.click()}>{reading ? 'Reading…' : 'Choose CSV'}</button>
                  {fileName ? <span>{fileName}</span> : null}
                  <a href="/sample-roster.csv" download="roster-format.csv" className="import-format-link">Download CSV example</a>
                </div>
                <div className="field"><label htmlFor={csvId}>Paste CSV</label><textarea id={csvId} value={csv} rows={6} maxLength={524_288} disabled={busy} spellCheck={false} placeholder="external_id,name,level,rating" onChange={(event) => { setCsv(event.target.value); setFileName(null); resetPreview(); resetColumns(); }} aria-describedby={`${csvId}-format`} /><span id={`${csvId}-format`} className="field__help">Player ID and name required. Up to 200 players.</span></div>
                {columns.headers.length > 0 ? (
                  <details className="import-columns">
                    <summary>{needsColumnMapping ? 'Map required CSV columns' : 'Map CSV columns'}</summary>
                    <div className="import-column-grid">
                      {COLUMN_FIELDS.map(({ field, label, required }) => (
                        <div className="field" key={field}>
                          <label htmlFor={`${csvId}-${field}`}>{label}{required ? ' *' : ''}</label>
                          <select id={`${csvId}-${field}`} value={columns.mapping[field] ?? ''} disabled={busy} onChange={(event) => changeColumn(field, event.target.value)}>
                            <option value="">{required ? 'Choose column' : 'Not supplied'}</option>
                            {columns.headers.filter(Boolean).map((header) => <option key={header} value={header} disabled={Object.entries(columns.mapping).some(([other, chosen]) => other !== field && chosen === header)}>{header}</option>)}
                          </select>
                        </div>
                      ))}
                    </div>
                    <div className="import-column-actions">
                      <button type="button" className="button button--secondary" disabled={busy || !onSaveMapping} onClick={() => void saveColumns()}>{savingColumns ? 'Saving…' : 'Save mapping for next time'}</button>
                      {columnsSaved ? <span role="status">Columns saved</span> : null}
                    </div>
                  </details>
                ) : null}
                <div className="dialog__actions"><button type="button" className="button button--secondary" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="button button--primary" disabled={busy || !csv.trim() || !source.trim()}>{isSaving ? 'Checking…' : 'Preview roster'}</button></div>
              </>
            ) : (
              <>
                <div className="import-review-heading"><strong>{preview.source}</strong><span>{summary}</span></div>
                {preview.conflictCount > 0 && !reviewableChanges ? <div className="inline-alert inline-alert--error" role="alert">Resolve conflicts before importing.</div> : null}
                {reviewableChanges ? <label className="checkbox-field"><input type="checkbox" checked={applyProfileChanges} disabled={busy} onChange={(event) => setApplyProfileChanges(event.target.checked)} /><span>Update changed profiles</span></label> : null}
                <div className="import-preview-scroll"><table className="import-preview-table"><caption className="sr-only">Roster import preview</caption><thead><tr><th scope="col">Player</th><th scope="col">Level</th><th scope="col">Local rating</th><th scope="col">Import</th></tr></thead><tbody>{preview.rows.map((row) => <tr key={row.externalId}><td><strong>{row.name}</strong><small>{row.externalId}</small></td><td className="roster-level">{row.skillLevel}</td><td>{row.skillRating === null ? <span aria-label="Local rating not recorded">—</span> : row.skillRating.toFixed(1)}</td><td><span className={`import-row-status import-row-status--${row.status}`}>{row.status === 'new' ? 'New profile' : row.status === 'existing' ? 'Profile matches' : row.canUpdate ? 'Review change' : 'Conflict'}</span><ProfileChanges row={row} />{row.message && !row.canUpdate ? <small>{row.message}</small> : null}</td></tr>)}</tbody></table></div>
                <div className="dialog__actions"><button type="button" className="button button--secondary" onClick={resetPreview} disabled={busy}>Back</button>{joining === 0 && preview.conflictCount === 0 ? <button type="button" className="button button--primary" onClick={onClose}>Done</button> : <button type="button" className="button button--primary" disabled={busy || (preview.conflictCount > 0 && (!reviewableChanges || !applyProfileChanges))} onClick={() => void onImport(preview.source, rows, reviewableChanges ? { updateExisting: applyProfileChanges, revision: preview.revision } : undefined)}>{isSaving ? 'Importing…' : reviewableChanges ? 'Apply roster' : joining === 0 ? 'Import roster' : `Import ${joining} ${joining === 1 ? 'player' : 'players'}`}</button>}</div>
              </>
            )}
          </form>
        )}
      </div>
    </AnimatedDialog>
  );
}
