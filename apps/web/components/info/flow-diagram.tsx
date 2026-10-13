import { FLOW } from "@/lib/content/info";

/**
 * A task's life as one inline SVG. Vertical so it reads at phone width; colors come
 * from the theme tokens so it follows light and dark without a second asset.
 */
export function FlowDiagram({ className }: { className?: string }) {
  const W = 360;
  const boxX = 56;
  const boxW = W - boxX - 12;
  const rowH = 92;
  const boxH = 60;
  const H = FLOW.length * rowH - (rowH - boxH) + 8;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby="flow-title flow-desc" className={className} style={{ fontFamily: "var(--font-geist-sans), system-ui, sans-serif" }}>
      <title id="flow-title">How a task flows through relay</title>
      <desc id="flow-desc">{FLOW.map((f, i) => `${i + 1}. ${f.step} (${f.where}).`).join(" ")}</desc>
      <defs>
        <marker id="flow-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 1 1 L 9 5 L 1 9 z" fill="var(--muted-foreground)" />
        </marker>
      </defs>
      {FLOW.map((f, i) => {
        const y = 4 + i * rowH;
        const cx = boxX / 2;
        const mid = y + boxH / 2;
        return (
          <g key={i}>
            {i < FLOW.length - 1 && (
              <line x1={boxX + boxW / 2} y1={y + boxH} x2={boxX + boxW / 2} y2={y + rowH - 2} stroke="var(--muted-foreground)" strokeWidth="1.5" markerEnd="url(#flow-arrow)" />
            )}
            <circle cx={cx} cy={mid} r="12" fill="var(--primary)" />
            <text x={cx} y={mid + 4} textAnchor="middle" fontSize="12" fontWeight="600" fill="var(--primary-foreground)">
              {i + 1}
            </text>
            <rect x={boxX} y={y} width={boxW} height={boxH} rx="6" fill="var(--card)" stroke="var(--border)" />
            <text x={boxX + 12} y={y + 23} fontSize="13" fontWeight="600" fill="var(--foreground)">
              {f.step}
            </text>
            <text x={boxX + 12} y={y + 43} fontSize="11" fill="var(--muted-foreground)" fontFamily="var(--font-geist-mono), ui-monospace, monospace">
              {f.where}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
