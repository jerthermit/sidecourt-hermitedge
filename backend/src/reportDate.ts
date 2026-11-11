/** Strict Gregorian date, without Date.parse's normalization of impossible dates. */
export function isReportDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const at = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
}

export function localReportDate(at: number, formatter: Intl.DateTimeFormat): string {
  const parts = formatter.formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)!.value;
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
}
