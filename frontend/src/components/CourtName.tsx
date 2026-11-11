/** Use the configured name in both views; only canonical numbered courts receive numeral styling. */
export function CourtName({ name }: { name: string }) {
  const numbered = /^Court (\d+)$/.exec(name);
  return <h3 className={numbered ? 'court-name court-name--numbered' : 'court-name'} aria-label={name}>
    {numbered ? <><span className="court-card__label">Court</span>{' '}<span className="court-card__number">{numbered[1]}</span></> : name}
  </h3>;
}
