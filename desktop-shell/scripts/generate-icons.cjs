'use strict';

const { mkdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { deflateSync } = require('node:zlib');

const bridgeRoot = resolve(__dirname, '..', '..');
const iconRoot = join(bridgeRoot, 'assets', 'icons');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  name.copy(header, 4);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([header, data, checksum]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4);
    rows[row] = 0;
    rgba.copy(rows, row + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(rows, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function clamp(value, low = 0, high = 1) {
  return Math.max(low, Math.min(high, value));
}

function mix(a, b, amount) {
  return Math.round(a + (b - a) * amount);
}

function distanceToSegment(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? clamp(((x - x1) * dx + (y - y1) * dy) / lengthSquared) : 0;
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

function roundedRectDistance(x, y, left, top, right, bottom, radius) {
  const qx = Math.abs(x - (left + right) / 2) - ((right - left) / 2 - radius);
  const qy = Math.abs(y - (top + bottom) / 2) - ((bottom - top) / 2 - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function blend(buffer, index, color, coverage) {
  const sourceAlpha = clamp(coverage) * ((color[3] ?? 255) / 255);
  if (sourceAlpha <= 0) return;
  const destinationAlpha = buffer[index + 3] / 255;
  const outAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  if (outAlpha <= 0) return;
  for (let channel = 0; channel < 3; channel += 1) {
    buffer[index + channel] = Math.round(
      (color[channel] * sourceAlpha + buffer[index + channel] * destinationAlpha * (1 - sourceAlpha)) / outAlpha,
    );
  }
  buffer[index + 3] = Math.round(outAlpha * 255);
}

function drawFill(buffer, size, designSize, distance, colorAt) {
  const scale = size / designSize;
  for (let py = 0; py < size; py += 1) {
    const y = (py + 0.5) / scale;
    for (let px = 0; px < size; px += 1) {
      const x = (px + 0.5) / scale;
      const coverage = clamp(0.5 - distance(x, y) * scale);
      if (coverage > 0) blend(buffer, (py * size + px) * 4, colorAt(x, y), coverage);
    }
  }
}

function drawStroke(buffer, size, designSize, points, width, color) {
  const scale = size / designSize;
  const radius = width / 2;
  const minX = Math.max(0, Math.floor((Math.min(...points.map((point) => point[0])) - radius - 1) * scale));
  const maxX = Math.min(size - 1, Math.ceil((Math.max(...points.map((point) => point[0])) + radius + 1) * scale));
  const minY = Math.max(0, Math.floor((Math.min(...points.map((point) => point[1])) - radius - 1) * scale));
  const maxY = Math.min(size - 1, Math.ceil((Math.max(...points.map((point) => point[1])) + radius + 1) * scale));
  for (let py = minY; py <= maxY; py += 1) {
    const y = (py + 0.5) / scale;
    for (let px = minX; px <= maxX; px += 1) {
      const x = (px + 0.5) / scale;
      let distance = Infinity;
      for (let point = 1; point < points.length; point += 1) {
        distance = Math.min(distance, distanceToSegment(
          x, y,
          points[point - 1][0], points[point - 1][1],
          points[point][0], points[point][1],
        ));
      }
      const coverage = clamp(0.5 - (distance - radius) * scale);
      if (coverage > 0) blend(buffer, (py * size + px) * 4, color, coverage);
    }
  }
}

function cubicPoints(start, first, second, end, count = 48) {
  const points = [];
  for (let step = 0; step <= count; step += 1) {
    const t = step / count;
    const inverse = 1 - t;
    points.push([
      inverse ** 3 * start[0] + 3 * inverse ** 2 * t * first[0] + 3 * inverse * t ** 2 * second[0] + t ** 3 * end[0],
      inverse ** 3 * start[1] + 3 * inverse ** 2 * t * first[1] + 3 * inverse * t ** 2 * second[1] + t ** 3 * end[1],
    ]);
  }
  return points;
}

function renderAppIcon(size) {
  const design = 1024;
  const pixels = Buffer.alloc(size * size * 4);
  drawFill(
    pixels, size, design,
    (x, y) => roundedRectDistance(x, y, 72, 72, 952, 952, 222),
    (x, y) => {
      const t = clamp(((x - 130) + (y - 96)) / 1592);
      const middle = [124, 58, 237, 255];
      if (t < 0.52) {
        const local = t / 0.52;
        return [mix(167, middle[0], local), mix(139, middle[1], local), mix(250, middle[2], local), 255];
      }
      const local = (t - 0.52) / 0.48;
      return [mix(middle[0], 76, local), mix(middle[1], 29, local), mix(middle[2], 149, local), 255];
    },
  );
  const white = [255, 255, 255, 255];
  const softWhite = [237, 233, 254, 255];
  drawStroke(pixels, size, design, [[266, 716], [266, 372]], 74, softWhite);
  drawStroke(pixels, size, design, [[758, 716], [758, 372]], 74, softWhite);
  drawStroke(pixels, size, design, cubicPoints([266, 412], [376, 570], [648, 570], [758, 412]), 62, white);
  drawStroke(pixels, size, design, [[202, 716], [822, 716]], 74, white);
  for (const [x, top] of [[390, 512], [512, 548], [634, 512]]) {
    drawStroke(pixels, size, design, [[x, top], [x, 716]], 34, softWhite);
  }
  drawFill(pixels, size, design, (x, y) => Math.hypot(x - 758, y - 298) - 86, () => [255, 247, 237, 255]);
  drawFill(pixels, size, design, (x, y) => Math.hypot(x - 758, y - 298) - 62, () => [245, 158, 11, 255]);
  return encodePng(size, size, pixels);
}

function renderTrayIcon(size, connected) {
  const design = 256;
  const pixels = Buffer.alloc(size * size * 4);
  drawFill(
    pixels, size, design,
    (x, y) => roundedRectDistance(x, y, 8, 8, 248, 248, 64),
    () => connected ? [109, 40, 217, 255] : [75, 85, 99, 255],
  );
  const white = [255, 255, 255, 255];
  drawStroke(pixels, size, design, [[60, 184], [60, 86]], 16, white);
  drawStroke(pixels, size, design, [[196, 184], [196, 86]], 16, white);
  drawStroke(pixels, size, design, cubicPoints([60, 98], [90, 142], [166, 142], [196, 98], 24), 16, white);
  drawStroke(pixels, size, design, [[42, 184], [214, 184]], 16, white);
  for (const [x, top] of [[94, 128], [128, 138], [162, 128]]) drawStroke(pixels, size, design, [[x, top], [x, 184]], 16, white);
  drawFill(pixels, size, design, (x, y) => Math.hypot(x - 201, y - 55) - 31, () => connected ? [236, 253, 245, 255] : [255, 247, 237, 255]);
  drawFill(pixels, size, design, (x, y) => Math.hypot(x - 201, y - 55) - 23, () => connected ? [16, 185, 129, 255] : [245, 158, 11, 255]);
  return encodePng(size, size, pixels);
}

function makeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const table = Buffer.alloc(entries.length * 16);
  let offset = header.length + table.length;
  entries.forEach(({ size, png }, index) => {
    const entry = index * 16;
    table[entry] = size >= 256 ? 0 : size;
    table[entry + 1] = size >= 256 ? 0 : size;
    table.writeUInt16LE(1, entry + 4);
    table.writeUInt16LE(32, entry + 6);
    table.writeUInt32LE(png.length, entry + 8);
    table.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, table, ...entries.map(({ png }) => png)]);
}

function makeIcns(entries) {
  const typeBySize = new Map([[16, 'icp4'], [32, 'icp5'], [64, 'icp6'], [128, 'ic07'], [256, 'ic08'], [512, 'ic09'], [1024, 'ic10']]);
  const chunks = entries.map(({ size, png }) => {
    const header = Buffer.alloc(8);
    header.write(typeBySize.get(size), 0, 4, 'ascii');
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

mkdirSync(iconRoot, { recursive: true });
const allSizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024].map((size) => ({ size, png: renderAppIcon(size) }));
writeFileSync(join(iconRoot, 'bridge.png'), allSizes.find(({ size }) => size === 512).png);
writeFileSync(join(iconRoot, 'bridge.ico'), makeIco(allSizes.filter(({ size }) => size <= 256)));
writeFileSync(join(iconRoot, 'bridge.icns'), makeIcns(allSizes.filter(({ size }) => ![24, 48].includes(size))));
writeFileSync(join(iconRoot, 'bridge-tray-connected.png'), renderTrayIcon(64, true));
writeFileSync(join(iconRoot, 'bridge-tray-disconnected.png'), renderTrayIcon(64, false));
console.log(`Generated Empir3 Bridge icon set in ${iconRoot}`);
