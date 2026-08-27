/** The hexagon is the hive; the arrow through it is the transfer. */
export function Logo({ className = 'h-6 w-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7L12 2.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M8 12h8m0 0-2.75-2.75M16 12l-2.75 2.75"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
