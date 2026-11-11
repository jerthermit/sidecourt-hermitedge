import { useEffect, useRef, useState } from 'react';
import { animate, LayoutGroup, motion } from 'motion/react';
import { ApiError, cancelPendingRequests, getPlayerDisplay } from '../lib/api';
import type { PlayerDisplay as DisplayState, QueueLane } from '../types/models';
import { Layout } from './Layout';
import { CourtDiagram } from './CourtDiagram';
import { CourtName } from './CourtName';
import { animateCourtCommit } from '../lib/courtMotion';
import { interactionEase, useMotionPolicy } from '../lib/interactionMotion';
import { pageWindow } from '../lib/pagination';
import { usePageSize } from '../lib/usePageSize';
import { ListPagination } from './ListPagination';

const lanes: QueueLane[] = ['beginner', 'intermediate', 'advanced', 'mixed'];
const elapsed = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;

export function PlayerDisplay({ accessKey }: { accessKey: string }) {
  const [snapshot, setSnapshot] = useState<{ state: DisplayState; receivedAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    let disposed = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const next = await getPlayerDisplay(accessKey);
        if (disposed) return;
        const receivedAt = Date.now();
        setSnapshot({ state: next, receivedAt });
        setNow(receivedAt);
        setError(null);
        setExpired(false);
      } catch (failure) {
        if (disposed) return;
        const invalidAccess = failure instanceof ApiError && (failure.status === 401 || failure.status === 403);
        setExpired(invalidAccess);
        if (invalidAccess) setSnapshot(null);
        setError(invalidAccess ? 'Player view expired. Ask the host for a new link.' : 'Connection lost. Reconnecting…');
        if (invalidAccess) return;
      }
      if (!disposed) poll = setTimeout(() => void load(), 5000);
    };
    void load();
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { disposed = true; clearTimeout(poll); window.clearInterval(timer); cancelPendingRequests(); };
  }, [accessKey, revision]);

  return <PlayerDisplayContent state={snapshot?.state ?? null} lastUpdatedAt={snapshot?.receivedAt ?? null}
    now={now} error={error} expired={expired} onRetry={() => setRevision((value) => value + 1)} />;
}

interface PlayerDisplayContentProps {
  state: DisplayState | null;
  lastUpdatedAt: number | null;
  now: number;
  error: string | null;
  expired: boolean;
  onRetry: () => void;
}

export function PlayerDisplayContent({ state, lastUpdatedAt, now, error, expired, onRetry }: PlayerDisplayContentProps) {
  const motionPolicy = useMotionPolicy();
  const playerCount = state?.settings.gameMode === 'singles' ? 2 : 4;
  const secondsSinceUpdate = !error && lastUpdatedAt !== null ? Math.max(0, Math.floor((now - lastUpdatedAt) / 1000)) : 0;
  const stagedState = lanes.map((lane) => `${lane}:${state?.nextGamePool[lane]?.map((player) => player.id).join(',') ?? ''}`).join('|');

  return (
    <Layout venueName={state?.settings.venueName} timezone={state?.settings.timezone}>
      <section className="player-display" aria-label="Player view">
        {error ? <div className="app-alert" role="alert"><span>{error}{state && lastUpdatedAt !== null ? <>{' '}Last updated <time dateTime={new Date(lastUpdatedAt).toISOString()}>{new Date(lastUpdatedAt).toLocaleTimeString('en-AU', { timeZone: state.settings.timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</time> ({state.settings.timezone}).</> : null}</span>{!expired ? <button type="button" className="button button--secondary" onClick={onRetry}>Retry</button> : null}</div> : null}
        {!state ? <div className="status-page" aria-live="polite">{!error ? <><span className="spinner" aria-hidden="true" /><h2>Loading</h2></> : null}</div> : (
          <>
            <div className="session-bar"><strong>{state.session.name}</strong><span>{state.session.endedAt === null ? 'Player view' : 'Session closed'}</span>
              {state.holdingPool?.length ? <button type="button" className="button button--ghost display-waiting-jump"
                aria-controls="display-waiting" onClick={() => {
                  const waiting = document.getElementById('display-waiting');
                  waiting?.scrollIntoView({ behavior: motionPolicy.reduced ? 'auto' : 'smooth', block: 'start' });
                  waiting?.querySelector<HTMLInputElement>('input[type="search"]')?.focus({ preventScroll: true });
                }}>Waiting</button> : null}
            </div>
            <LayoutGroup id={`player-display-${state.session.id}`}>
            <div className="display-board">
              <div className="courts-grid" data-courts={state.courts.length}>
                {state.courts.map((court) => <DisplayCourt key={court.id} court={court} playerCount={playerCount} secondsSinceUpdate={secondsSinceUpdate} />)}
              </div>
              <div className="display-queues">
                <motion.aside className="display-next" aria-label="Next game" layout={motionPolicy.layout ? 'position' : false} layoutDependency={stagedState} transition={motionPolicy.transition} initial={false}>
                  <h2>Next game</h2>
                  {lanes.map((lane) => (state.nextGamePool[lane]?.length ?? 0) > 0 ? <motion.section key={lane} layout={motionPolicy.layout ? 'position' : false} layoutDependency={stagedState} transition={motionPolicy.transition}>
                    <h3>{lane === 'mixed' ? 'Open group' : lane}</h3>
                    <ol>{state.nextGamePool[lane]?.map((player) => <motion.li key={player.id} layout={motionPolicy.layout ? 'position' : false} layoutId={motionPolicy.layout ? `player-${player.id}` : undefined} layoutDependency={stagedState} transition={motionPolicy.transition}>{player.name}</motion.li>)}</ol>
                  </motion.section> : null)}
                  {lanes.every((lane) => !state.nextGamePool[lane]?.length) ? <p>Not yet assigned</p> : null}
                </motion.aside>
                <PlayerWaitingList key={state.session.id} players={state.holdingPool ?? []} />
              </div>
            </div>
            </LayoutGroup>
          </>
        )}
      </section>
    </Layout>
  );
}

export function PlayerWaitingList({ players }: { players: Array<{ id: string; name: string }> }) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize(true);
  const motionPolicy = useMotionPolicy();
  const query = search.trim().toLocaleLowerCase();
  const filtered = players.map((player, index) => ({ player, position: index + 1 }))
    .filter(({ player }) => !query || player.name.toLocaleLowerCase().includes(query));
  const pagination = pageWindow(filtered.length, page, pageSize);
  if (page !== pagination.page) setPage(pagination.page);
  const visible = filtered.slice(pagination.start, pagination.end);
  const layoutState = `${visible.map(({ player }) => player.id).join(',')}:${query}:${pagination.page}`;

  return <motion.section id="display-waiting" className="display-waiting" aria-labelledby="display-waiting-title"
    layout={motionPolicy.layout ? 'position' : false} layoutDependency={layoutState} transition={motionPolicy.transition} initial={false}>
    <h2 id="display-waiting-title">Waiting</h2>
    {players.length > 0 ? <label className="queue-search">
      <span className="sr-only">Search waiting players</span>
      <input type="search" placeholder="Find a waiting player" value={search}
        onChange={(event) => { setSearch(event.target.value); setPage(1); }} />
    </label> : null}
    {visible.length > 0 ? <ol className="display-waiting__list" aria-label="Waiting order">
      {visible.map(({ player, position }) => <motion.li key={player.id} value={position}
        aria-label={`Position ${position}: ${player.name}`}
        layout={motionPolicy.layout ? 'position' : false} layoutId={motionPolicy.layout ? `player-${player.id}` : undefined}
        layoutDependency={layoutState} transition={motionPolicy.transition}>
        <span className="display-waiting__position" aria-hidden="true">{position}</span><span>{player.name}</span>
      </motion.li>)}
    </ol> : <p role="status">{players.length === 0 ? 'No players waiting' : 'No matching players'}</p>}
    {players.length > 0 ? <ListPagination label="Waiting" {...pagination} total={filtered.length} pageSize={pageSize}
      onPageChange={setPage} onPageSizeChange={(size) => { setPageSize(size); setPage(1); }} /> : null}
  </motion.section>;
}

function DisplayCourt({ court, playerCount, secondsSinceUpdate }: {
  court: DisplayState['courts'][number];
  playerCount: number;
  secondsSinceUpdate: number;
}) {
  const motionPolicy = useMotionPolicy();
  const courtRef = useRef<HTMLElement>(null);
  const playerIds = court.players.map((player) => player.id).join(',');
  const layoutState = `${court.status}:${playerCount}:${playerIds}`;
  const previousState = useRef({ status: court.status, ids: playerIds });
  useEffect(() => {
    const current = { status: court.status, ids: playerIds };
    const previous = previousState.current;
    previousState.current = current;
    const element = courtRef.current;
    if (!element) return;
    const suspended = motionPolicy.reduced || motionPolicy.dragging;
    const stopCommit = animateCourtCommit(element, previous, current, suspended);
    const timer = element.querySelector('.court-timer');
    const timerEntry = !suspended && previous.status !== 'in-play' && current.status === 'in-play' && timer
      ? animate(timer, { opacity: [0.6, 1], y: [-3, 0] }, { duration: 0.26, ease: interactionEase }) : null;
    return () => { stopCommit(); timerEntry?.complete(); };
  }, [court.status, playerIds, motionPolicy.reduced, motionPolicy.dragging]);
  const courtName = court.name ?? `Court ${court.id}`;
  const ready = court.status === 'available' && court.players.length === playerCount;

  return <motion.article ref={courtRef} className={`court-card court-card--${court.status}`}
    aria-label={courtName} data-ready={ready} data-occupied={court.players.length > 0}
    layout={motionPolicy.layout ? 'position' : false} layoutDependency={layoutState} transition={motionPolicy.transition} initial={false}>
    <header className="court-card__header">
      <div className="court-card__identity"><CourtName name={courtName} /><span className={`status-badge status-badge--${court.status}${ready ? ' status-badge--ready' : ''}`}>{court.status === 'in-play' ? 'In play' : court.status === 'disabled' ? 'Closed' : ready ? 'Ready' : court.players.length > 0 ? 'Assigned' : 'Open'}</span></div>
      {court.status === 'in-play' ? <time className="court-timer">{elapsed(court.timeElapsed + secondsSinceUpdate)}</time> : null}
    </header>
    <div className="court-card__roster" aria-label={`${courtName} roster`}>
      {court.players.length ? <motion.div className="court-card__players" layout={motionPolicy.layout ? 'position' : false} layoutDependency={layoutState} transition={motionPolicy.transition}>
        {[0, 1].map((team) => <motion.section className="court-team" key={team} layout={motionPolicy.layout ? 'position' : false} layoutDependency={layoutState} transition={motionPolicy.transition}>
          <h4>Team {team + 1}</h4>
          <ol className="display-players" aria-label={`${courtName} team ${team + 1}`}>
            {court.players.slice(team * playerCount / 2, (team + 1) * playerCount / 2).map((player) => <motion.li key={player.id} layout={motionPolicy.layout ? 'position' : false} layoutId={motionPolicy.layout ? `player-${player.id}` : undefined} layoutDependency={layoutState} transition={motionPolicy.transition}>{player.name}</motion.li>)}
          </ol>
        </motion.section>)}
      </motion.div> : <div className="court-empty" aria-label={court.status === 'disabled' ? 'Court closed' : 'No group assigned'}><CourtDiagram />{court.status !== 'disabled' ? <span>No group assigned</span> : null}</div>}
    </div>
  </motion.article>;
}
