import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

/** Draws the code as one crisp vector path, so it stays sharp on any TV. */
export function QrCode({ text, label }: { text: string; label: string }) {
  const { size, path } = useMemo(() => {
    const code = qrcode(0, 'M');
    code.addData(text);
    code.make();
    const modules = code.getModuleCount();
    let d = '';
    for (let row = 0; row < modules; row += 1) {
      for (let column = 0; column < modules; column += 1) {
        if (code.isDark(row, column)) d += `M${column} ${row}h1v1h-1z`;
      }
    }
    return { size: modules, path: d };
  }, [text]);

  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <path d={path} fill="#1B1C1A" />
    </svg>
  );
}
