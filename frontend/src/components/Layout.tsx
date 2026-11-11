import React, { useId } from 'react';
import { LayoutGroup, motion } from 'motion/react';
import { useMotionPolicy } from '../lib/interactionMotion';
import { Clock } from './Clock';
import { PRODUCT_DESCRIPTION, PRODUCT_NAME } from '../lib/product';

export type WorkspaceView = 'courts' | 'roster' | 'reports';
const workspaceViews: { id: WorkspaceView; label: string }[] = [
  { id: 'courts', label: 'Courts' },
  { id: 'roster', label: 'Roster' },
  { id: 'reports', label: 'Reports' },
];

interface LayoutProps {
  children: React.ReactNode;
  isLoading?: boolean;
  isSaving?: boolean;
  isProposalLoading?: boolean;
  onAddPlayerClick?: () => void;
  activeView?: WorkspaceView;
  onViewChange?: (view: WorkspaceView) => void;
  reportsAvailable?: boolean;
  actionsDisabled?: boolean;
  canLogout?: boolean;
  onLogout?: () => void;
  venueName?: string;
  timezone?: string;
}

export const Layout: React.FC<LayoutProps> = ({
  children,
  isLoading = false,
  isSaving = false,
  isProposalLoading = false,
  onAddPlayerClick,
  activeView = 'courts',
  onViewChange,
  reportsAvailable = true,
  actionsDisabled = false,
  canLogout = false,
  onLogout,
  venueName = 'Court Operations',
  timezone = 'Australia/Sydney',
}) => {
  const tabsId = useId();
  const motionPolicy = useMotionPolicy();
  const venueLabel = venueName.trim();
  const showVenue = venueLabel.length > 0
    && !['court operations', 'court steward', PRODUCT_NAME.toLowerCase()].includes(venueLabel.toLowerCase());
  const status = isSaving
    ? 'Saving'
    : isProposalLoading
      ? 'Matching'
      : isLoading
        ? 'Loading'
        : null;

  return (
    <div className="app-shell">
      <header className={`app-header ${onViewChange ? '' : 'app-header--plain'}`}>
        <div className="app-brand">
          <img className="app-brand__logo" src="/app-logo.png" alt="Hermit Edge" width="34" height="34" />
          <div className="app-brand__identity">
            <h1>{PRODUCT_NAME}</h1>
            <p className="app-brand__description">{PRODUCT_DESCRIPTION}</p>
            {showVenue ? <span className="app-brand__venue" title={venueName}>{venueLabel}</span> : null}
          </div>
        </div>

        {onViewChange ? (
          <LayoutGroup id={tabsId}>
          <nav className="workspace-tabs" aria-label="Workspace">
            {workspaceViews.map(({ id, label }) => (
              <button key={id} type="button" aria-pressed={activeView === id} disabled={id === 'reports' && !reportsAvailable}
                onClick={() => onViewChange(id)}>
                {label}{activeView === id ? <motion.span className="workspace-tabs__indicator" layoutId={motionPolicy.layout ? 'active-workspace' : undefined} transition={motionPolicy.transition} aria-hidden="true" /> : null}
              </button>
            ))}
          </nav>
          </LayoutGroup>
        ) : null}

        <div className="app-header__tools">
          {onAddPlayerClick ? (
            <button
              type="button"
              className="button button--secondary"
              onClick={onAddPlayerClick}
              disabled={actionsDisabled}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              Add player
            </button>
          ) : null}
          {status ? (
            <span className="save-status" role="status" aria-live="polite">
              <span className="spinner spinner--small" aria-hidden="true" />
              {status}
            </span>
          ) : null}
          <Clock timezone={timezone} />
          {canLogout && onLogout ? (
            <button type="button" className="button button--ghost button--small" onClick={onLogout}>
              Exit
            </button>
          ) : null}
        </div>
      </header>
      <main className="app-main">{children}</main>
      <footer className="app-footer"><small>© Emman Ermitaño. All rights reserved.</small></footer>
    </div>
  );
};

interface LeftPanelProps {
  children: React.ReactNode;
}

export const LeftPanel: React.FC<LeftPanelProps> = ({ children }) => (
  <section className="left-panel" id="court-board" tabIndex={-1} aria-label="Courts">
    <div className="left-panel__content">{children}</div>
  </section>
);

interface RightPanelProps {
  children: React.ReactNode;
}

export const RightPanel: React.FC<RightPanelProps> = ({ children }) => (
  <aside className="right-panel" id="player-queues" tabIndex={-1} aria-label="Player queues">
    {children}
  </aside>
);

interface CourtsGridProps {
  children: React.ReactNode;
  courtCount?: number;
}

export const CourtsGrid: React.FC<CourtsGridProps> = ({ children, courtCount = 6 }) => (
  <div className="courts-grid" data-courts={courtCount}>{children}</div>
);
