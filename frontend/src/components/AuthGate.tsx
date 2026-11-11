import React, { useEffect, useId, useRef, useState } from 'react';
import { PRODUCT_DESCRIPTION, PRODUCT_NAME } from '../lib/product';

interface AuthGateProps {
  error: string | null;
  isLoading: boolean;
  onSubmit: (accessKey: string) => Promise<boolean>;
  onClearError: () => void;
}

export const AuthGate: React.FC<AuthGateProps> = ({
  error,
  isLoading,
  onSubmit,
  onClearError,
}) => {
  const titleId = useId();
  const keyId = useId();
  const keyRef = useRef<HTMLInputElement>(null);
  const [accessKey, setAccessKey] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    keyRef.current?.focus();
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedKey = accessKey.trim();
    if (!trimmedKey) {
      setLocalError('Operator code required.');
      keyRef.current?.focus();
      return;
    }

    setLocalError(null);
    onClearError();
    const authenticated = await onSubmit(trimmedKey);
    if (!authenticated) keyRef.current?.select();
  };

  return (
    <main className="gate-page">
      <section className="gate-card" aria-labelledby={titleId}>
        <img className="app-brand__logo gate-mark" src="/app-logo.png" alt="Hermit Edge" width="48" height="48" />
        <h1 id={titleId}>{PRODUCT_NAME}</h1>
        <p className="gate-description">{PRODUCT_DESCRIPTION}</p>

        <form className="form-stack" onSubmit={handleSubmit}>
          {localError || error ? (
            <div className="inline-alert inline-alert--error" role="alert">
              {localError ?? error}
            </div>
          ) : null}

          <div className="field">
            <label htmlFor={keyId}>Operator code</label>
            <input
              ref={keyRef}
              id={keyId}
              type="password"
              value={accessKey}
              autoComplete="current-password"
              onChange={(event) => {
                setAccessKey(event.target.value);
                setLocalError(null);
              }}
              disabled={isLoading}
            />
          </div>

          <button type="submit" className="button button--primary button--full" disabled={isLoading}>
            {isLoading ? <span className="spinner spinner--small" aria-hidden="true" /> : null}
            {isLoading ? 'Opening…' : 'Enter'}
          </button>
        </form>
      </section>
    </main>
  );
};
