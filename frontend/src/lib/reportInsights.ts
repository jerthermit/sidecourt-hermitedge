import type { GameHistory } from '../types/models';

const hour = 3_600_000;
const maxIntervals = 8;
const intervalHours = [1, 2, 3, 4, 6, 12, 24, 48, 72, 168];

interface CourtTotal {
  courtId: number;
  courtName: string;
  matches: number;
  seconds: number;
}

export function summarizeCompletedPlay(matches: GameHistory[], timezone: string) {
  let firstStart = Infinity;
  let lastStart = -Infinity;
  let longestCourtTime = 0;
  const completed = matches.filter((match) => match.status !== 'voided');
  const byCourt = new Map<string, CourtTotal>();
  for (const match of completed) {
    firstStart = Math.min(firstStart, match.startedAt);
    lastStart = Math.max(lastStart, match.startedAt);
    const courtName = match.courtName ?? `Court ${match.courtId}`;
    const key = JSON.stringify([match.courtId, courtName]);
    const court = byCourt.get(key) ?? { courtId: match.courtId, courtName, matches: 0, seconds: 0 };
    court.matches += 1;
    court.seconds += match.duration;
    byCourt.set(key, court);
    longestCourtTime = Math.max(longestCourtTime, court.seconds);
  }
  if (completed.length === 0) return null;

  const courts = [...byCourt.values()].sort((left, right) => right.seconds - left.seconds || left.courtId - right.courtId
    || left.courtName.localeCompare(right.courtName, 'en-AU'));
  const clock = new Intl.DateTimeFormat('en-AU', { timeZone: timezone, minute: '2-digit', second: '2-digit' });
  const parts = clock.formatToParts(firstStart);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  const second = Number(parts.find((part) => part.type === 'second')?.value);
  const anchor = firstStart - (minute * 60 + second) * 1000 - new Date(firstStart).getUTCMilliseconds();
  // Measure elapsed time from the first local hour so daylight-saving folds retain separate intervals.
  const spanHours = (lastStart - anchor) / hour;
  const hours = intervalHours.find((candidate) => spanHours < candidate * maxIntervals)
    ?? (Math.floor(spanHours / (168 * maxIntervals)) + 1) * 168;
  const interval = hours * hour;
  const starts = Array.from({ length: Math.floor(spanHours / hours) + 1 }, (_, index) => ({
    at: anchor + index * interval, count: 0,
  }));
  for (const match of completed) starts[Math.floor((match.startedAt - anchor) / interval)]!.count += 1;
  const busiest = Math.max(...starts.map(({ count }) => count));
  return { courts, longestCourtTime, starts, hours, busiest };
}

export function formatStartIntervals(starts: { at: number; count: number }[], timezone: string) {
  const localDay = new Intl.DateTimeFormat('en-AU', { timeZone: timezone, dateStyle: 'short' });
  const showDate = localDay.format(starts[0]!.at) !== localDay.format(starts.at(-1)!.at);
  const localYear = new Intl.DateTimeFormat('en-AU', { timeZone: timezone, year: 'numeric' });
  const showYear = showDate && localYear.format(starts[0]!.at) !== localYear.format(starts.at(-1)!.at);
  const date = new Intl.DateTimeFormat('en-AU', {
    timeZone: timezone, day: 'numeric', month: 'short', year: showYear ? 'numeric' : undefined,
  });
  const time = new Intl.DateTimeFormat('en-AU', { timeZone: timezone, hour: 'numeric', minute: '2-digit' });
  const axisClock = new Intl.DateTimeFormat('en-AU', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const offsetTime = new Intl.DateTimeFormat('en-AU', {
    timeZone: timezone, hour: 'numeric', minute: '2-digit', timeZoneName: 'shortOffset',
  });
  const labels = starts.map(({ at }) => `${localDay.format(at)} ${time.format(at)}`);
  const intervals = starts.map((start, index) => {
    const repeated = labels.indexOf(labels[index]!) !== labels.lastIndexOf(labels[index]!);
    const offset = repeated ? offsetTime.formatToParts(start.at).find((part) => part.type === 'timeZoneName') : null;
    return {
      ...start,
      date: showDate ? date.format(start.at) : null,
      time: repeated ? offsetTime.format(start.at) : time.format(start.at),
      axisTime: axisClock.format(start.at),
      axisOffset: offset?.value.replace(/^GMT/, ''),
    };
  });
  const singleDate = showDate ? null : new Intl.DateTimeFormat('en-AU', {
    timeZone: timezone, day: 'numeric', month: 'short', year: 'numeric',
  }).format(starts[0]!.at);
  return { intervals, singleDate };
}
