// Feet on one common projection: 44 × 20 court, net across its 22-foot midpoint.
const project = (length: number, width: number, height = 0): string =>
  `${Number((12 + (length + width) * 1.6).toFixed(3))},${Number((29 + (length - width) * 0.7 - height * 2).toFixed(3))}`;
const corners = [[0, 0], [44, 0], [44, 20], [0, 20]] as const;
const outline = corners.map(([length, width]) => project(length, width)).join(' ');
const area = (start: number, end: number): string =>
  [[start, 0], [end, 0], [end, 20], [start, 20]]
    .map(([length, width]) => project(length, width)).join(' ');
const netLine = (height: number): string =>
  `M${project(22, -1, height)}Q${project(22, 10, height - 1 / 3)} ${project(22, 21, height)}`;
const netHeight = (width: number, height: number): number => {
  const position = (width + 1) / 22;
  return height - (2 / 3) * position * (1 - position);
};

export function CourtDiagram() {
  return <svg className="court-empty__drawing" viewBox="0 0 128 72" aria-hidden="true" focusable="false">
    <g className="court-diagram__slab" strokeLinejoin="round">
      <polygon points={`${project(0, 0)} ${project(44, 0)} ${project(44, 0, -0.8)} ${project(0, 0, -0.8)}`} fill="#192f26" />
      <polygon points={`${project(44, 0)} ${project(44, 20)} ${project(44, 20, -0.8)} ${project(44, 0, -0.8)}`} fill="#245c46" />
    </g>
    <polygon className="court-diagram__surface" points={outline} fill="#245c46" />
    <g fill="#edf3ed">
      <polygon points={area(0, 15)} fillOpacity="0.1" />
      <polygon points={area(29, 44)} fillOpacity="0.1" />
      <polygon className="court-diagram__kitchen" points={area(15, 29)} fillOpacity="0.26" />
    </g>
    <g className="court-diagram__markings" fill="none" stroke="#edf3ed" strokeWidth="0.8" strokeLinejoin="round">
      <polygon points={outline} />
      <path className="court-diagram__lines" d={`M${project(15, 0)}L${project(15, 20)}M${project(29, 0)}L${project(29, 20)}M${project(0, 10)}L${project(15, 10)}M${project(29, 10)}L${project(44, 10)}`} />
    </g>
    <polygon points={`${project(22, -1)} ${project(23.6, -1)} ${project(23.6, 21)} ${project(22, 21)}`}
      fill="#192f26" fillOpacity="0.14" />
    <g className="court-diagram__net" data-length="22" fill="none" strokeLinecap="round">
      <path d={`${netLine(3)}L${project(22, 21, 0.45)}Q${project(22, 10, 0.45 - 1 / 3)} ${project(22, -1, 0.45)}Z`}
        fill="#192f26" fillOpacity="0.65" stroke="#192f26" strokeWidth="0.45" />
      <g className="court-diagram__weave" stroke="#edf3ed" strokeWidth="0.3" strokeOpacity="0.55">
        {[1.15, 1.9, 2.55].map((height) => <path key={height} d={netLine(height)} />)}
        {[0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20].map((width) => <path key={width}
          d={`M${project(22, width, netHeight(width, 0.45))}L${project(22, width, netHeight(width, 3))}`} />)}
      </g>
      <path className="court-diagram__posts" d={`M${project(22, -1)}L${project(22, -1, 3.15)}M${project(22, 21)}L${project(22, 21, 3.15)}`}
        stroke="#192f26" strokeWidth="1.2" />
      <path className="court-diagram__tape" d={netLine(3)} stroke="#edf3ed" strokeWidth="0.95" />
    </g>
  </svg>;
}
