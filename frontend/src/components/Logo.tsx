type LogoMarkProps = {
  size?: number;
};

// The ring mark: a capital M in Cinzel inside a thin outer ring and a slightly
// heavier inner ring. It inherits `currentColor`, so gold on black and ink on
// ivory both work without a second asset.
export function LogoMark({ size = 96 }: LogoMarkProps) {
  return (
    <span className="logo-mark" style={{ width: size, height: size }} aria-hidden="true">
      <span className="logo-letter" style={{ fontSize: Math.round(size * 0.44) }}>
        M
      </span>
    </span>
  );
}

type LogoProps = {
  size?: number;
  compact?: boolean;
};

export default function Logo({ size = 92, compact = false }: LogoProps) {
  if (compact) return <LogoMark size={size} />;

  return (
    <span className="logo" aria-hidden="true">
      <LogoMark size={size} />
      <span className="logo-word" style={{ fontSize: Math.max(11, Math.round(size * 0.15)) }}>
        MUR REVIEWS
      </span>
    </span>
  );
}
