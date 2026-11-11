import { useEffect, useId, useRef, useState } from 'react';
import { AnimatedDialog } from './AnimatedDialog';
import type { Court, Destination, Player } from '../types/models';
import { playerIsLocked, playerMoveOptions } from '../lib/playerMoves';

interface PlayerMoveDialogProps {
  player: Player;
  courts: Court[];
  playerCount: number;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onMove: (destination: Destination) => Promise<boolean>;
  onRest: () => Promise<boolean>;
}

export function PlayerMoveDialog({ player, courts, playerCount, busy, error, onClose, onMove, onRest }: PlayerMoveDialogProps) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const movedPlayer = useRef<string | null>(null);
  const [destination, setDestination] = useState('');
  const options = playerMoveOptions(player, courts, playerCount);
  const selected = options.find((option) => option.value === destination);
  const locked = playerIsLocked(player, courts);

  useEffect(() => {
    const dialog = dialogRef.current;
    const origin = document.activeElement;
    dialog?.showModal();
    selectRef.current?.focus();
    return () => {
      dialog?.close();
      const relocated = movedPlayer.current === null ? null : Array.from(document.querySelectorAll<HTMLElement>('[data-player-id]'))
        .find(element => element.dataset.playerId === movedPlayer.current && element.getAttribute('aria-disabled') !== 'true');
      if (relocated) { relocated.focus({ preventScroll: true }); return; }
      if (origin instanceof HTMLElement && origin.isConnected) origin.focus({ preventScroll: true });
      else document.querySelector<HTMLButtonElement>('[aria-label="Workspace"] button[aria-pressed="true"]')?.focus({ preventScroll: true });
    };
  }, []);

  return <AnimatedDialog ref={dialogRef} className="dialog dialog--small player-move-dialog" aria-labelledby={id}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="dialog__header"><h2 id={id}>{player.name}</h2><button type="button" className="icon-button" disabled={busy} aria-label="Close player actions" onClick={onClose}><span aria-hidden="true">×</span></button></div>
    <form className="dialog__body form-stack" onSubmit={async (event) => {
      event.preventDefault();
      if (!busy && !locked && selected && await onMove(selected.destination)) { movedPlayer.current = player.id; onClose(); }
    }}>
      <div className="player-move-summary"><span>{player.skillLevel === 'unrated' ? 'Unrated' : player.skillLevel}</span><span>{player.gamesPlayed ?? '—'} {player.gamesPlayed === 1 ? 'game' : 'games'}</span></div>
      {error ? <div className="inline-alert inline-alert--error" role="alert">{error}</div> : null}
      {locked ? <p className="field-error" role="status">Player no longer available to move. Refresh the board.</p> : <label className="field"><span>Move to</span><select ref={selectRef} value={destination} onChange={(event) => setDestination(event.target.value)} disabled={busy} required>
        <option value="">Choose destination</option>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select></label>}
      <div className="dialog__actions player-move-actions">
        <button type="button" className="button button--ghost" disabled={busy || locked} onClick={async () => { if (!busy && !locked && await onRest()) onClose(); }}>Rest</button>
        <button type="button" className="button button--secondary" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" className="button button--primary" disabled={busy || locked || !selected}>{busy ? 'Saving…' : 'Move player'}</button>
      </div>
    </form>
  </AnimatedDialog>;
}
