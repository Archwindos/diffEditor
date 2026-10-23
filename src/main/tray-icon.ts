import { nativeImage } from 'electron';

export function createTrayIcon() {
  const draw = (size: number) => {
    const bitmap = Buffer.alloc(size * size * 4), scale = size / 16;
    const rect = (x: number, y: number, width: number, height: number, color: number[]) => {
      for (let row = y * scale; row < (y + height) * scale; row++) {
        for (let col = x * scale; col < (x + width) * scale; col++) {
          const offset = (row * size + col) * 4;
          bitmap[offset] = color[2]; bitmap[offset + 1] = color[1];
          bitmap[offset + 2] = color[0]; bitmap[offset + 3] = 255;
        }
      }
    };
    rect(1, 2, 6, 12, [29, 116, 112]); rect(9, 2, 6, 12, [195, 114, 67]);
    for (const y of [5, 8, 11]) { rect(2, y, 4, 1, [255, 255, 255]); rect(10, y, 4, 1, [255, 255, 255]); }
    return nativeImage.createFromBitmap(bitmap, { width: size, height: size });
  };
  const icon = draw(16);
  icon.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: draw(32).toPNG() });
  return icon;
}
