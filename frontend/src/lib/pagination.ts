export function pageWindow(total: number, requestedPage: number, pageSize: number) {
  const count = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  const size = Number.isFinite(pageSize) ? Math.max(1, Math.floor(pageSize)) : 12;
  const pageCount = Math.max(1, Math.ceil(count / size));
  const page = Math.min(pageCount, Math.max(1, Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1));
  const start = (page - 1) * size;
  return { page, pageCount, start, end: Math.min(count, start + size) };
}
