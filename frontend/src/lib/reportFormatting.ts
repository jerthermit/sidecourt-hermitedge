export const reportDuration = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours ? `${hours}h ${minutes}m ${remainder}s` : `${minutes}m ${remainder}s`;
};

export const reportTimestamp = (value: number, timezone: string): string => new Intl.DateTimeFormat('en-AU', {
  timeZone: timezone, day: 'numeric', month: 'short', year: 'numeric',
  hour: 'numeric', minute: '2-digit', second: '2-digit',
}).format(value);

export const reportLocalDate = (timezone: string, now = Date.now()): string => {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((value) => value.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};
