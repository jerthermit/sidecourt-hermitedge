import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  AddPlayerModal,
  AuthGate,
  Court,
  CourtsGrid,
  HoldingPool,
  Layout,
  LeftPanel,
  MatchProposalModal,
  NextGamePool,
  PlayerCard,
  RightPanel,
  Roster,
  RosterImportModal,
} from './components';
import { useAppStore } from './store/useAppStore';
import { PUBLIC_DEMO } from './lib/api';
import { PlayerDisplay } from './components/PlayerDisplay';
import { SessionDialog } from './components/SessionDialog';
import { ReportsWorkspace } from './components/ReportsWorkspace';
import type { WorkspaceView } from './components/Layout';
import { PlayerMoveDialog } from './components/PlayerMoveDialog';
import { PlayerScreenDialog } from './components/PlayerScreenDialog';
import { StagedGroupDialog } from './components/StagedGroupDialog';
import { EquipmentMark } from './components/EquipmentMark';
import { RotationPlanDialog } from './components/RotationPlanDialog';
import { SessionRotationControl } from './components/SessionRotationControl';
import { AnimatePresence, LayoutGroup } from 'motion/react';
import { DragMotionContext, useMotionPolicy } from './lib/interactionMotion';
import { WorkspaceSurface } from './components/WorkspaceSurface';
import { dragAnnouncements } from './lib/dragAccessibility';
import { playerIsLocked } from './lib/playerMoves';
import type { Player, QueueLane } from './types/models';

const queueLanes: QueueLane[] = ['beginner', 'intermediate', 'advanced', 'mixed'];
const readLocationHash = () => window.location.hash;
const subscribeLocationHash = (onChange: () => void) => {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
};

function HostApp() {
  const motionPolicy = useMotionPolicy();
  const {
    accessKey,
    authRequired,
    courts,
    roster,
    holdingPool,
    nextGamePool,
    gameHistory,
    isLoading,
    isSaving,
    error,
    matchProposal,
    matchProposalCourtId,
    isProposalLoading,
    setAccessKey,
    logout,
    initialize,
    reload,
    addPlayer,
    removePlayer,
    movePlayer,
    reorderHoldingPool,
    startGame,
    assignStagedGroup,
    endGame,
    endGameAndReview,
    toggleCourtStatus,
    updateCourtTimer,
    getCourtHistory,
    requestMatchProposal,
    applyMatchProposal,
    dismissMatchProposal,
    clearError,
    rosterImportPreview,
    rosterImportResult,
    clearRosterImport,
    previewRosterImport,
    importRoster,
    setPlayerAttendance,
    settings,
    session,
    sessions,
    updateSettings,
    startSession,
    closeSession,
    resetVisitorSession,
    exportSession,
    loadSessionReport,
    loadDailyReport,
    createPlayerView,
    rotation,
    voidActiveGame,
    voidRecordedGame,
    correctRecordedGame,
    saveRosterMapping,
    rotationPlan,
    requestRotationPlan,
    applyRotationPlan,
    clearRotationPlan,
    dismissRotationPlan,
  } = useAppStore();

  const initializationStarted = useRef(false);
  const [matchReviewTrigger, setMatchReviewTrigger] = useState<HTMLElement | null>(null);
  const rotationActionRef = useRef<HTMLButtonElement>(null);
  const [rotationReview, setRotationReview] = useState<{ accessKey: string; sessionId: string; trigger: HTMLElement | null } | null>(null);
  const [rosterImportTrigger, setRosterImportTrigger] = useState<HTMLButtonElement | null>(null);
  const [activePlayer, setActivePlayer] = useState<Player | null>(null);
  const [isAddPlayerOpen, setIsAddPlayerOpen] = useState(false);
  const [activeView, setActiveView] = useState<WorkspaceView>('courts');
  const [isRosterImportOpen, setIsRosterImportOpen] = useState(false);
  const [isSessionOpen, setIsSessionOpen] = useState(false);
  const [playerScreenAccess, setPlayerScreenAccess] = useState<string | null>(null);
  const [stagedReview, setStagedReview] = useState<{
    accessKey: string | null; sessionId: string; lane: QueueLane; players: Player[]; playerCount: number; revision: number;
  } | null>(null);
  const stagedReviewRevision = useRef(0);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const lastDragEndedAt = useRef(0);
  const hasActiveMatch = courts.some((court) => court.status === 'in-play');
  const activeRotationReview = rotationReview && rotationReview.accessKey === accessKey
    && rotationReview.sessionId === session?.id && session.endedAt === null ? rotationReview
    : rotationPlan && rotationPlan.sessionId === session?.id && session.endedAt === null && accessKey
      ? { accessKey, sessionId: session.id, trigger: null } : null;

  useEffect(() => {
    if (initializationStarted.current) return;
    initializationStarted.current = true;
    void initialize();
  }, [initialize]);

  useEffect(() => {
    if (!hasActiveMatch) return;

    const timer = window.setInterval(() => {
      useAppStore.getState().courts.forEach((court) => {
        if (court.status === 'in-play') updateCourtTimer(court.id);
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [hasActiveMatch, updateCourtTimer]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const interactionsLocked = isSaving || isProposalLoading || session?.endedAt != null;
  const playerCount = settings?.gameMode === 'singles' ? 2 : 4;
  const canReviewNext = (rotation?.eligiblePlayerIds.length ?? 0) >= playerCount
    || (rotation?.needsMixedApproval === true && holdingPool.length >= playerCount);
  const selectedPlayer = roster.find((player) => player.id === selectedPlayerId);

  const handlePlayerSelect = (player: Player) => {
    if (interactionsLocked || playerIsLocked(player, courts) || Date.now() - lastDragEndedAt.current < 250) return;
    clearError();
    setSelectedPlayerId(player.id);
  };

  const handleDragStart = (event: DragStartEvent) => {
    if (interactionsLocked) return;
    const player = event.active.data.current?.player as Player | undefined;
    if (player) setActivePlayer(player);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    lastDragEndedAt.current = Date.now();
    setActivePlayer(null);
    if (interactionsLocked || !event.over) return;

    const player = event.active.data.current?.player as Player | undefined;
    const overData = event.over.data.current;
    if (!player || !overData) return;

    const sourceLocation = player.location;
    if (sourceLocation.type === 'court') {
      const sourceCourt = courts.find((court) => court.id === sourceLocation.courtId);
      if (sourceCourt?.status === 'in-play') return;
    }

    if (overData.type === 'player') {
      const targetPlayer = overData.player as Player;
      if (targetPlayer.id === player.id) return;

      if (player.location.type === 'holding-pool' && targetPlayer.location.type === 'holding-pool') {
        const fromIndex = holdingPool.findIndex((item) => item.id === player.id);
        const toIndex = holdingPool.findIndex((item) => item.id === targetPlayer.id);
        if (fromIndex >= 0 && toIndex >= 0 && fromIndex !== toIndex) {
          await reorderHoldingPool(fromIndex, toIndex);
        }
        return;
      }

      const targetLocation = targetPlayer.location;

      if (targetLocation.type === 'next-game-pool') {
        await movePlayer(player.id, {
          type: 'next-game-pool',
          lane: targetLocation.lane,
        });
        return;
      }

      if (targetLocation.type === 'court') {
        const targetCourt = courts.find((court) => court.id === targetLocation.courtId);
        if (targetCourt?.status === 'available' && targetCourt.players.length < playerCount) {
          await movePlayer(player.id, {
            type: 'court',
            courtId: targetLocation.courtId,
          });
        }
        return;
      }
    }

    if (overData.type === 'holding-pool') {
      await movePlayer(player.id, { type: 'holding-pool' });
      return;
    }

    if (overData.type === 'next-game-pool') {
      const lane = overData.poolType as QueueLane;
      if (queueLanes.includes(lane)) {
        await movePlayer(player.id, { type: 'next-game-pool', lane });
      }
      return;
    }

    if (overData.type === 'court') {
      const courtId = Number(overData.courtId);
      const targetCourt = courts.find((court) => court.id === courtId);
      if (targetCourt?.status === 'available' && targetCourt.players.length < playerCount) {
        await movePlayer(player.id, { type: 'court', courtId });
      }
    }
  };

  const handleAccessKey = async (key: string): Promise<boolean> => {
    setAccessKey(key);
    return initialize();
  };

  const handleLogout = () => {
    setSelectedPlayerId(null);
    setIsAddPlayerOpen(false);
    setIsRosterImportOpen(false);
    setIsSessionOpen(false);
    setPlayerScreenAccess(null);
    setStagedReview(null);
    setRotationReview(null);
    setActiveView('courts');
    setActivePlayer(null);
    logout();
  };

  const handleReload = async (): Promise<boolean> => {
    clearError();
    return reload();
  };

  const jumpToBoardSection = (id: 'court-board' | 'player-queues') => {
    const section = document.getElementById(id);
    section?.focus({ preventScroll: true });
    section?.scrollIntoView({ block: 'start', behavior: motionPolicy.reduced ? 'auto' : 'smooth' });
  };

  const handleSuggestMatch = async (allowMixed = false, courtId?: number) => {
    setMatchReviewTrigger(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    clearError();
    return requestMatchProposal(allowMixed, courtId);
  };

  const handleReviewRotation = async () => {
    if (!accessKey || !session || session.endedAt !== null) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!await dismissMatchProposal()) return;
    clearRotationPlan();
    clearError();
    setRotationReview({ accessKey, sessionId: session.id, trigger });
    await requestRotationPlan();
  };

  const handleApproveRotation = async (approveMixed: boolean) => {
    const original = useAppStore.getState();
    const success = await applyRotationPlan(approveMixed);
    const current = useAppStore.getState();
    if (success && current.accessKey === original.accessKey && current.session?.id === original.session?.id) {
      setRotationReview(null);
      clearError();
      return true;
    }
    return false;
  };

  const handleDismissRotation = async () => {
    const original = useAppStore.getState();
    const dismissed = await dismissRotationPlan();
    const current = useAppStore.getState();
    if (dismissed && current.accessKey === original.accessKey && current.session?.id === original.session?.id) {
      setRotationReview(null);
      clearError();
    }
  };

  const handleStagedReview = (lane: QueueLane) => {
    const current = useAppStore.getState();
    const size = current.settings?.gameMode === 'singles' ? 2 : 4;
    const players = current.nextGamePool[lane]?.slice(0, size) ?? [];
    if (!current.session || current.session.endedAt !== null || players.length !== size) return;
    clearError();
    setStagedReview({ accessKey: current.accessKey, sessionId: current.session.id, lane, players,
      playerCount: size, revision: ++stagedReviewRevision.current });
  };

  const handleRefreshStagedReview = async () => {
    if (!stagedReview) return;
    const original = stagedReview;
    if (!await reload()) return;
    const current = useAppStore.getState();
    if (current.accessKey !== original.accessKey || current.session?.id !== original.sessionId || current.session.endedAt !== null) {
      setStagedReview(null);
      return;
    }
    const size = current.settings?.gameMode === 'singles' ? 2 : 4;
    if ((current.nextGamePool[original.lane]?.length ?? 0) < size) setStagedReview(null);
    else handleStagedReview(original.lane);
  };

  const handleEndAndReview = async (courtId: number): Promise<boolean> => {
    const access = useAppStore.getState().accessKey;
    const sessionId = useAppStore.getState().session?.id;
    setMatchReviewTrigger(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    clearError();
    const completed = await endGameAndReview(courtId);
    const current = useAppStore.getState();
    if (current.accessKey === access && current.session?.id === sessionId && current.matchProposal?.status !== 'pending') {
      const court = document.querySelector<HTMLElement>(`[data-court-id="${courtId}"]`);
      (court?.querySelector<HTMLElement>('.court-card__footer button:not(:disabled)') ?? court)?.focus({ preventScroll: true });
    }
    return completed;
  };

  const handleApproveProposal = async (courtId?: number, approveMixed = false): Promise<boolean> => {
    clearError();
    return applyMatchProposal(courtId, approveMixed);
  };

  const handleDismissProposal = async (): Promise<boolean> => {
    const dismissed = await dismissMatchProposal();
    if (dismissed) clearError();
    return dismissed;
  };

  const handleRequestAnother = async (): Promise<boolean> => {
    const dismissed = await dismissMatchProposal();
    if (!dismissed) return false;
    clearError();
    return requestMatchProposal(matchProposal?.mixed ?? false, matchProposalCourtId ?? undefined);
  };

  if (authRequired) {
    if (PUBLIC_DEMO) return <StatusPage title="Session ended" message={error ?? undefined} actionLabel="Start again" onAction={() => void initialize()} />;
    return (
      <AuthGate
        error={error}
        isLoading={isLoading}
        onSubmit={handleAccessKey}
        onClearError={clearError}
      />
    );
  }

  if (isLoading && courts.length === 0) {
    return <StatusPage title="Loading" busy />;
  }

  if (error && courts.length === 0) {
    return (
      <StatusPage
        title="Unavailable"
        message={error}
        actionLabel="Retry"
        onAction={() => void handleReload()}
      />
    );
  }

  return (
    <DndContext
      sensors={sensors}
      accessibility={{
        announcements: dragAnnouncements(courts),
        screenReaderInstructions: { draggable: 'Press Space to pick up a player. Use arrow keys to move, Space to drop or Escape to cancel. Press Enter for player actions.' },
      }}
      onDragStart={handleDragStart}
      onDragCancel={() => { lastDragEndedAt.current = Date.now(); setActivePlayer(null); }}
      onDragEnd={(event) => void handleDragEnd(event)}
    >
      <DragMotionContext.Provider value={Boolean(activePlayer)}>
      <LayoutGroup id={`session-${session?.id ?? 'empty'}`}>
      <Layout
        isLoading={isLoading}
        isSaving={isSaving}
        isProposalLoading={isProposalLoading}
        onAddPlayerClick={activeView === 'reports' ? undefined : () => {
          clearError();
          setIsAddPlayerOpen(true);
        }}
        activeView={activeView}
        onViewChange={(view) => { if (view !== activeView) { clearError(); setActiveView(view); } }}
        reportsAvailable={Boolean(session)}
        actionsDisabled={interactionsLocked}
        canLogout={Boolean(accessKey)}
        onLogout={handleLogout}
        venueName={settings?.venueName}
        timezone={settings?.timezone}
      >
        <div className="workspace">
          {session && activeView !== 'reports' ? <div className="session-bar">
            <div className="session-bar__identity">
              <EquipmentMark playing={session.endedAt === null && courts.some((court) => court.status === 'in-play')} />
              <div className="session-bar__details"><strong>{session.name}</strong>
                <div className="session-bar__meta"><time dateTime={new Date(session.startedAt).toISOString()}>{new Date(session.startedAt).toLocaleDateString('en-AU', { timeZone: settings?.timezone ?? 'Australia/Sydney', day: 'numeric', month: 'short' })}</time><span>{session.endedAt !== null ? 'Closed' : settings?.gameMode === 'singles' ? 'Singles' : 'Doubles'}</span></div>
              </div>
            </div>
            <div className="session-bar__actions">
              {activeView === 'courts' ? <SessionRotationControl waiting={holdingPool.length}
                emptyCourts={courts.filter((court) => court.status === 'available' && court.players.length === 0).length}
                playerCount={playerCount} busy={isSaving || isLoading} preparing={isProposalLoading}
                closed={session.endedAt !== null} onReview={() => void handleReviewRotation()}
                onViewWaiting={() => jumpToBoardSection('player-queues')} buttonRef={rotationActionRef} /> : null}
              <div className="session-bar__tools">
              <button type="button" className="button button--secondary button--small" disabled={isSaving || isProposalLoading} onClick={() => { clearError(); setPlayerScreenAccess(accessKey); }}>Player screen</button>
              <button type="button" className="button button--ghost button--small" disabled={isSaving || isProposalLoading} onClick={() => { clearError(); setIsSessionOpen(true); }}>Session & club</button>
              </div>
            </div>
          </div> : null}
          {error && activeView !== 'reports' ? (
            <div className="app-alert" role="alert">
              <span>{error}</span>
              <div>
                <button type="button" className="button button--ghost button--small" onClick={() => void handleReload()} disabled={isLoading}>
                  Retry
                </button>
                <button type="button" className="icon-button icon-button--small" onClick={clearError} aria-label="Dismiss error">
                  <span aria-hidden="true">×</span>
                </button>
              </div>
            </div>
          ) : null}

          <AnimatePresence initial={false} mode="wait">
          {activeView === 'reports' && session ? (
            <WorkspaceSurface key="reports" className="workspace__reports">
              <ReportsWorkspace key={session.id} sessionId={session.id}
                onLoad={loadSessionReport} onExport={exportSession} error={error} busy={isSaving || isProposalLoading}
                sessions={sessions} timezone={settings?.timezone} onLoadDay={loadDailyReport} />
            </WorkspaceSurface>
          ) : activeView === 'roster' ? (
            <WorkspaceSurface key="roster" className="workspace__roster">
              <Roster
                players={roster}
                courts={courts}
                disabled={interactionsLocked}
                onImport={(trigger) => {
                  setRosterImportTrigger(trigger);
                  clearError();
                  clearRosterImport();
                  setIsRosterImportOpen(true);
                }}
                onAttendance={setPlayerAttendance}
                onRemove={removePlayer} error={error} onClearError={clearError}
                paginationLocked={isSaving || isProposalLoading}
              />
            </WorkspaceSurface>
          ) : <WorkspaceSurface key="courts" className="workspace__content">
            <LeftPanel>
              <CourtsGrid courtCount={courts.length}>
                {courts.map((court) => (
                  <Court
                    key={court.id}
                    court={court}
                    history={getCourtHistory(court.id)}
                    identityHistory={gameHistory.filter((game) => game.sessionId === session?.id)}
                    disabled={interactionsLocked}
                    busy={isSaving || isProposalLoading}
                    playerCount={playerCount}
                    timezone={settings?.timezone}
                    onStartGame={startGame}
                    onEndGame={endGame}
                    onEndAndReview={handleEndAndReview}
                    onReviewNext={(courtId) => handleSuggestMatch(rotation?.needsMixedApproval ?? false, courtId)}
                    canReviewNext={canReviewNext}
                    reviewMixed={rotation?.needsMixedApproval ?? false}
                    onToggleStatus={toggleCourtStatus}
                    roster={roster}
                    sessionId={session?.id}
                    sessionOpen={session?.endedAt === null}
                    error={error}
                    onClearError={clearError}
                    onVoidGame={voidActiveGame}
                    onVoidRecordedGame={voidRecordedGame}
                    onCorrectRecordedGame={correctRecordedGame}
                    onSelectPlayer={handlePlayerSelect}
                  />
                ))}
              </CourtsGrid>
            </LeftPanel>

            <RightPanel>
              <button type="button" className="button button--ghost button--small queue-return"
                onClick={() => jumpToBoardSection('court-board')}>Back to courts</button>
              <NextGamePool nextGamePool={nextGamePool} disabled={interactionsLocked} onSelectPlayer={handlePlayerSelect}
                playerCount={playerCount} onAssignGroup={handleStagedReview} />
              <HoldingPool
                players={holdingPool}
                disabled={interactionsLocked}
                isProposalLoading={isProposalLoading}
                onSuggestMatch={(allowMixed) => void handleSuggestMatch(allowMixed)}
                playerCount={playerCount}
                rotation={rotation}
                onReviewRotation={() => void handleReviewRotation()}
                rotationAvailable={courts.some((court) => court.status === 'available' && court.players.length === 0)}
                showReviewAction={false} showCount={false}
                paginationLocked={Boolean(activePlayer) || isSaving || isProposalLoading}
                onSelectPlayer={handlePlayerSelect}
              />
            </RightPanel>
          </WorkspaceSurface>}
          </AnimatePresence>
        </div>
      </Layout>

      <DragOverlay dropAnimation={motionPolicy.reduced ? null : { duration: 180, easing: 'ease-out' }}>
        {activePlayer ? <PlayerCard player={activePlayer} isDragging /> : null}
      </DragOverlay>

      <AnimatePresence initial={false}>
      {selectedPlayer ? <PlayerMoveDialog key="player-move" player={selectedPlayer} courts={courts} playerCount={playerCount}
        busy={interactionsLocked} error={error}
        onClose={() => { setSelectedPlayerId(null); clearError(); }}
        onMove={(destination) => movePlayer(selectedPlayer.id, destination)}
        onRest={() => setPlayerAttendance(selectedPlayer.id, 'resting')}
      /> : null}

      {isAddPlayerOpen ? (
        <AddPlayerModal
          key="add-player"
          onAdd={addPlayer}
          onClose={() => {
            setIsAddPlayerOpen(false);
            clearError();
          }}
          onClearError={clearError}
          isSaving={isSaving}
          error={error}
        />
      ) : null}

      {matchProposal && !activeRotationReview ? (
        <MatchProposalModal
          key={`pairing-${matchProposal.id}`}
          returnFocusTo={matchReviewTrigger}
          proposal={matchProposal}
          error={error}
          isSaving={isSaving}
          isProposalLoading={isProposalLoading}
          onApprove={handleApproveProposal}
          onDismiss={handleDismissProposal}
          onRequestAnother={handleRequestAnother}
          courts={courts}
          playerCount={playerCount}
          preferredCourtId={matchProposalCourtId ?? undefined}
        />
      ) : null}

      {activeRotationReview ? <RotationPlanDialog key="rotation-review"
        plan={rotationPlan} busy={isSaving || isProposalLoading || isLoading} error={error}
        returnFocusTo={activeRotationReview.trigger} onRefresh={requestRotationPlan} onApprove={handleApproveRotation}
        onClose={() => void handleDismissRotation()}
      /> : null}

      {isSessionOpen && settings && session ? <SessionDialog key="session-settings"
        settings={settings} session={session}
        busy={isSaving || isProposalLoading} hasActiveMatch={courts.some((court) => court.status === 'in-play')}
        error={error} publicAccess={PUBLIC_DEMO} onClose={() => { setIsSessionOpen(false); clearError(); }}
        onSaveSettings={updateSettings} onStart={startSession} onEnd={closeSession} onReset={resetVisitorSession}
      /> : null}

      {playerScreenAccess !== null && playerScreenAccess === accessKey ? <PlayerScreenDialog key="player-screen"
        onCreate={createPlayerView} error={error}
        onClose={() => { setPlayerScreenAccess(null); clearError(); }}
      /> : null}

      {stagedReview && stagedReview.accessKey === accessKey && stagedReview.sessionId === session?.id ? <StagedGroupDialog
        key={`staged-${stagedReview.revision}`} sessionId={stagedReview.sessionId} lane={stagedReview.lane}
        players={stagedReview.players} courts={courts} playerCount={stagedReview.playerCount}
        requireMixedApproval={settings?.rotationMode === 'skill-banded' && new Set(stagedReview.players.map((player) => player.skillLevel)).size > 1}
        stale={session.endedAt !== null || stagedReview.playerCount !== playerCount || stagedReview.players.some((player, index) => nextGamePool[stagedReview.lane]?.[index]?.id !== player.id)}
        busy={isSaving || isProposalLoading || isLoading} error={error} onAssign={assignStagedGroup}
        onRefresh={handleRefreshStagedReview} onClose={() => { setStagedReview(null); clearError(); }}
      /> : null}

      {isRosterImportOpen ? (
        <RosterImportModal
          key="roster-import"
          returnFocusTo={rosterImportTrigger}
          preview={rosterImportPreview}
          result={rosterImportResult}
          isSaving={isSaving}
          error={error}
          onPreview={previewRosterImport}
          onImport={importRoster}
          onClear={() => { clearRosterImport(); clearError(); }}
          onClose={() => { setIsRosterImportOpen(false); clearRosterImport(); clearError(); }}
          mapping={settings?.rosterMapping}
          onSaveMapping={saveRosterMapping}
        />
      ) : null}
      </AnimatePresence>
      </LayoutGroup>
      </DragMotionContext.Provider>
    </DndContext>
  );
}

interface StatusPageProps {
  title: string;
  message?: string;
  busy?: boolean;
  actionLabel?: string;
  onAction?: () => void;
}

const StatusPage = ({ title, message, busy = false, actionLabel, onAction }: StatusPageProps) => (
  <Layout isLoading={busy}>
    <section className="status-page" aria-live="polite">
      {busy ? <span className="spinner" aria-hidden="true" /> : null}
      <h2>{title}</h2>
      {message ? <p>{message}</p> : null}
      {actionLabel && onAction ? (
        <button type="button" className="button button--primary" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </section>
  </Layout>
);

function App() {
  const locationHash = useSyncExternalStore(subscribeLocationHash, readLocationHash, () => '');
  const displayToken = new URLSearchParams(locationHash.slice(1)).get('display');
  return displayToken ? <PlayerDisplay key={displayToken} accessKey={displayToken} /> : <HostApp />;
}

export default App;
