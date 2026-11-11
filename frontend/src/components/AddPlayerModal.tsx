import React, { useEffect, useId, useRef, useState } from 'react';
import { AnimatedDialog } from './AnimatedDialog';
import type { SkillLevel } from '../types/models';

interface AddPlayerModalProps {
  onAdd: (name: string, skillLevel: SkillLevel, skillRating: number | null, playStyle: string) => Promise<boolean>;
  onClose: () => void;
  onClearError: () => void;
  isSaving: boolean;
  error: string | null;
}

const skillLevels: Array<{ value: SkillLevel; label: string }> = [
  { value: 'beginner', label: 'Beginner' },
  { value: 'intermediate', label: 'Intermediate' },
  { value: 'advanced', label: 'Advanced' },
  { value: 'unrated', label: 'Unrated' },
];

const playStyles = ['Balanced', 'Aggressive', 'Tactical', 'Defensive'];

export const AddPlayerModal: React.FC<AddPlayerModalProps> = ({
  onAdd,
  onClose,
  onClearError,
  isSaving,
  error,
}) => {
  const titleId = useId();
  const descriptionId = useId();
  const nameId = useId();
  const ratingId = useId();
  const styleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [skillLevel, setSkillLevel] = useState<SkillLevel>('unrated');
  const [ratingInput, setRatingInput] = useState('');
  const [playStyle, setPlayStyle] = useState('Balanced');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const returnFocusTo = document.activeElement;
    dialog?.showModal();
    nameRef.current?.focus();
    return () => {
      dialog?.close();
      if (returnFocusTo instanceof HTMLElement && returnFocusTo.isConnected) {
        returnFocusTo.focus({ preventScroll: true });
      }
    };
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();

    if (!trimmedName) {
      setLocalError('Name required.');
      nameRef.current?.focus();
      return;
    }

    const skillRating = ratingInput.trim() === '' ? null : Number(ratingInput);
    if (skillRating !== null && (!Number.isFinite(skillRating) || skillRating < 1 || skillRating > 6)) {
      setLocalError('Use a rating from 1.0 to 6.0.');
      return;
    }

    setLocalError(null);
    onClearError();
    const saved = await onAdd(trimmedName, skillLevel, skillRating, playStyle);
    if (saved) onClose();
  };

  const displayedError = localError ?? error;

  return (
    <AnimatedDialog
        ref={dialogRef}
        className="dialog dialog--small"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onCancel={(event) => {
          event.preventDefault();
          if (!isSaving) onClose();
        }}
      >
        <div className="dialog__header">
          <div>
            <h2 id={titleId}>New player</h2>
            <span id={descriptionId} className="sr-only">Player details</span>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={isSaving}
            aria-label="Close add player dialog"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <form className="dialog__body form-stack" onSubmit={handleSubmit}>
          {displayedError ? (
            <div className="inline-alert inline-alert--error" role="alert">
              {displayedError}
            </div>
          ) : null}

          <div className="field">
            <label htmlFor={nameId}>Name</label>
            <input
              ref={nameRef}
              id={nameId}
              type="text"
              value={name}
              maxLength={80}
              autoComplete="off"
              onChange={(event) => {
                setName(event.target.value);
                setLocalError(null);
              }}
              disabled={isSaving}
            />
          </div>

          <fieldset className="field">
            <legend>Level</legend>
            <div className="segmented-control">
              {skillLevels.map((level) => (
                <label key={level.value}>
                  <input
                    type="radio"
                    name="skill-level"
                    value={level.value}
                    checked={skillLevel === level.value}
                    onChange={() => setSkillLevel(level.value)}
                    disabled={isSaving}
                  />
                  <span>{level.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="form-grid">
            <div className="field">
              <label htmlFor={ratingId}>Local rating <span className="field__optional">optional</span></label>
              <input
                id={ratingId}
                type="number"
                min="1"
                max="6"
                step="0.1"
                value={ratingInput}
                placeholder="—"
                onChange={(event) => setRatingInput(event.target.value)}
                disabled={isSaving}
                inputMode="decimal"
              />
              <span className="field__help">1.0 to 6.0</span>
            </div>

            <div className="field">
              <label htmlFor={styleId}>Style</label>
              <select
                id={styleId}
                value={playStyle}
                onChange={(event) => setPlayStyle(event.target.value)}
                disabled={isSaving}
              >
                {playStyles.map((style) => (
                  <option key={style} value={style}>{style}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="dialog__actions">
            <button type="button" className="button button--secondary" onClick={onClose} disabled={isSaving}>
              Cancel
            </button>
            <button type="submit" className="button button--primary" disabled={isSaving || !name.trim()}>
              {isSaving ? <span className="spinner spinner--small" aria-hidden="true" /> : null}
              {isSaving ? 'Adding…' : 'Add'}
            </button>
          </div>
        </form>
    </AnimatedDialog>
  );
};
