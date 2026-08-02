interface Props {
  fps: number;
  beams: number;
  glows: number;
  draws: number;
  fixtures: number;
  universes: number;
  backend: string;
}

export function StatusBar({ fps, beams, glows, draws, fixtures, universes, backend }: Props) {
  return (
    <footer className="statusbar">
      <span><em>{fps}</em> fps</span>
      <span><em>{beams}</em> beams</span>
      <span><em>{glows}</em> glows</span>
      <span><em>{draws}</em> draws</span>
      <span><em>{fixtures}</em> fixtures</span>
      <span><em>{universes}</em> universes</span>
      <span className="statusbar__backend">{backend}</span>
    </footer>
  );
}
