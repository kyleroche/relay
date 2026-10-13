/** The mark: two nodes and the relay between them. currentColor so it follows text. */
export function RelayMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <circle cx="5" cy="12" r="3" fill="currentColor" />
      <circle cx="19" cy="12" r="3" fill="currentColor" opacity="0.55" />
      <path d="M8 12h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M13 9l3 3-3 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
