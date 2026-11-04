/**
 * The weave figure.
 *
 * A field of hairline threads crossed by three blue bars (action) and two orange
 * bars (evidence), interleaved at the crossings. Flat: account strokes, no
 * gradient, no shadow. Decorative only, so it is hidden from assistive tech and
 * the point it makes is written in the copy instead.
 */
export function WeaveFigure({ className }: Readonly<{ className?: string }>) {
  const gridLines = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320];
  const blueBars = [96, 160, 224];
  const orangeBars = [96, 224];

  return (
    <svg
      viewBox="0 0 320 320"
      className={className}
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <g stroke="var(--line)" strokeWidth="1">
        {gridLines.map((position) => (
          <path key={`v-${position}`} d={`M${position} 0V320`} />
        ))}
        {gridLines.map((position) => (
          <path key={`h-${position}`} d={`M0 ${position}H320`} />
        ))}
      </g>

      <g fill="var(--accent)">
        {blueBars.map((x) => (
          <rect key={`b-${x}`} x={x} y={32} width={8} height={256} />
        ))}
      </g>

      <g fill="var(--signal)">
        {orangeBars.map((y) => (
          <rect key={`o-${y}`} x={32} y={y} width={256} height={8} />
        ))}
      </g>

      {/* Blue passes over orange at alternating crossings, which is what makes
          the figure read as woven rather than as a grid with bars on it. */}
      <g fill="var(--accent)">
        <rect x={96} y={96} width={8} height={8} />
        <rect x={224} y={96} width={8} height={8} />
        <rect x={160} y={224} width={8} height={8} />
      </g>
    </svg>
  );
}
