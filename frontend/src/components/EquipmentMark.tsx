import { useEffect, useId, useRef } from 'react';
import type { mountEquipmentScene } from '../lib/equipmentScene';

/** One decorative equipment study. It never owns session state or player actions. */
export function EquipmentMark({ playing = false }: { playing?: boolean }) {
  const weaveId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ReturnType<typeof mountEquipmentScene> | null>(null);
  const playingRef = useRef(playing);

  useEffect(() => {
    playingRef.current = playing;
    sceneRef.current?.setPlaying(playing);
  }, [playing]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    // Keep WebGL outside the operator bundle; an unavailable GPU leaves the SVG intact.
    void import('../lib/equipmentScene').then(({ mountEquipmentScene }) => {
      if (disposed) return;
      const scene = mountEquipmentScene(container);
      sceneRef.current = scene;
      scene.setPlaying(playingRef.current);
    }).catch(() => { /* The static equipment illustration is the complete fallback. */ });
    return () => {
      disposed = true;
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, []);

  return <div ref={containerRef} className="equipment-mark" aria-hidden="true">
    <svg className="equipment-mark__fallback" viewBox="0 0 180 110" focusable="false">
      <defs><pattern id={weaveId} width="4" height="4" patternUnits="userSpaceOnUse">
        <path d="M0 0h4v4H0Z" fill="#245c46" />
        <path d="M0 0h2v2H0Zm2 2h2v2H2Z" fill="#edf3ed" opacity="0.1" />
      </pattern></defs>
      <ellipse cx="88" cy="99" rx="59" ry="5" fill="#192f26" opacity="0.08" />
      <g transform="translate(43 1) rotate(-24 40 55)">
        <path d="M16 10Q16 2 27 2H63Q74 2 74 14V48Q74 58 58 66L54 71V99Q54 104 48 104H42Q37 104 37 99V71L32 66Q16 58 16 48Z" fill="#192f26" />
        <path d="M12 8Q12 0 24 0H59Q70 0 70 12V46Q70 56 54 64L50 69V96Q50 101 44 101H39Q33 101 33 96V69L28 64Q12 56 12 46Z" fill="#b8c8bd" />
        <path d="M17 11Q17 5 26 5H57Q65 5 65 13V44Q65 52 51 59L47 63H36L31 59Q17 52 17 44Z" fill={`url(#${weaveId})`} />
        <path d="M24 14V44Q24 48 33 53" fill="none" stroke="#edf3ed" strokeWidth="2" opacity="0.6" />
        <path d="M34 72H50V97Q50 101 44 101H39Q34 101 34 97Z" fill="#192f26" />
        <path d="m34 77 16 4m-16 3 16 4m-16 3 16 4" stroke="#b8c8bd" opacity="0.55" />
      </g>
      <circle cx="122" cy="67" r="25" fill="#b8c8bd" />
      <circle cx="119" cy="63" r="24" fill="#edf3ed" />
      <path d="M102 56a20 20 0 0 1 21-13" fill="none" stroke="#ffffff" strokeWidth="3" strokeLinecap="round" />
      <g fill="#245c46">
        <ellipse cx="116" cy="48" rx="3" ry="2" transform="rotate(-15 116 48)" />
        <ellipse cx="104" cy="61" rx="2.5" ry="3.5" />
        <circle cx="119" cy="62" r="3.4" />
        <ellipse cx="133" cy="56" rx="2.3" ry="3.2" transform="rotate(-35 133 56)" />
        <ellipse cx="110" cy="76" rx="3.2" ry="2.4" transform="rotate(30 110 76)" />
        <ellipse cx="127" cy="77" rx="3.1" ry="2.6" transform="rotate(-25 127 77)" />
        <ellipse cx="137" cy="69" rx="1.8" ry="3" transform="rotate(15 137 69)" />
      </g>
    </svg>
  </div>;
}
