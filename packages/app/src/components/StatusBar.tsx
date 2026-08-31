interface Props {
  fps: number;
  beams: number;
  glows: number;
  draws: number;
  fixtures: number;
  universes: number;
  /** Emitters taking their colour from video. Hidden when nothing is playing. */
  videoPixels: number;
  backend: string;
}

export function StatusBar({
  fps, beams, glows, draws, fixtures, universes, videoPixels, backend,
}: Props) {
  return (
    <footer className="statusbar">
      <span><em>{fps}</em> fps</span>
      <span><em>{beams}</em> beams</span>
      <span><em>{glows}</em> glows</span>
      <span><em>{draws}</em> draws</span>
      <span><em>{fixtures}</em> fixtures</span>
      <span><em>{universes}</em> universes</span>
      {/* Only while a feed is playing: a permanent "0 video px" would read as
          a feature that is broken rather than one that is switched off. */}
      {videoPixels > 0 && <span><em>{videoPixels}</em> video px</span>}
      <span className="statusbar__backend">{backend}</span>
    </footer>
  );
}
