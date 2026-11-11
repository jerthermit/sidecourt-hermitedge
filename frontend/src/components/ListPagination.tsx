interface ListPaginationProps {
  label: string;
  page: number;
  pageCount: number;
  start: number;
  end: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  disabled?: boolean;
}

export function ListPagination({ label, page, pageCount, start, end, total, pageSize,
  onPageChange, onPageSizeChange, disabled = false }: ListPaginationProps) {
  return <nav className="list-pagination" aria-label={`${label} pages`}>
    <span className="list-pagination__range" role="status" aria-label={`${label}: ${total === 0 ? 0 : start + 1} to ${end} of ${total}`}>
      {total === 0 ? '0' : `${start + 1}–${end}`} of {total}
    </span>
    {total > 6 ? <label className="list-pagination__size">
      <span className="sr-only">{label} per page</span>
      <select value={pageSize} disabled={disabled} onChange={event => onPageSizeChange(Number(event.target.value))}>
        {[6, 12, 24, 48].map(size => <option key={size} value={size}>{size} / page</option>)}
      </select>
    </label> : null}
    {pageCount > 1 ? <div className="list-pagination__buttons">
      <button type="button" className="icon-button" aria-label={`Previous ${label} page`}
        disabled={disabled || page <= 1} onClick={() => onPageChange(page - 1)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg>
      </button>
      <span className="list-pagination__page" aria-label={`Page ${page} of ${pageCount}`}>{page} / {pageCount}</span>
      <button type="button" className="icon-button" aria-label={`Next ${label} page`}
        disabled={disabled || page >= pageCount} onClick={() => onPageChange(page + 1)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6" /></svg>
      </button>
    </div> : null}
  </nav>;
}
