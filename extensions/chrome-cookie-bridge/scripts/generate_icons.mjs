// 生成 icons/ 下的占位图标。
//
// 为什么要脚本而不是直接塞几张图：这个仓库没有任何图形素材，也不想为了一个本机自用的扩展
// 引入图像依赖。Chromium 的 manifest icons 只认 PNG（不吃 SVG），所以这里手写一个
// 最小 PNG 编码器（只用 node 自带的 zlib），把 icons/icon.svg 描述的同一个图形栅格化出来。
// 换正式图标时直接覆盖 icons/*.png 即可，这个脚本不参与运行时。
//
// 用法：node scripts/generate_icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");
const SIZES = [16, 32, 48, 128];
// 和 popup / badge 用的绿色一致，扫一眼就知道是同一个东西。
const BRAND = [0x0b, 0xbf, 0x72];
const WHITE = [0xff, 0xff, 0xff];
// 4x 超采样再降采样，16px 下边缘不至于全是锯齿。
const SUPERSAMPLE = 4;

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

function encodePng(size, rgba) {
  const stride = size * 4;
  // PNG 每行前面要有一个 filter 字节，这里全部用 0（None）。
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function insideRoundedSquare(x, y, radius) {
  if (x < 0 || x > 1 || y < 0 || y > 1) return false;
  const cx = Math.min(Math.max(x, radius), 1 - radius);
  const cy = Math.min(Math.max(y, radius), 1 - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function insideTriangle(x, y, [ax, ay], [bx, by], [cx, cy]) {
  const sign = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = sign(x, y, ax, ay, bx, by);
  const d2 = sign(x, y, bx, by, cx, cy);
  const d3 = sign(x, y, cx, cy, ax, ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

// 极简信封：绿色圆角底 + 白色信封身 + 绿色信封盖三角。
function sample(x, y) {
  if (!insideRoundedSquare(x, y, 0.22)) return null;
  const inBody = x >= 0.2 && x <= 0.8 && y >= 0.33 && y <= 0.67;
  if (!inBody) return BRAND;
  if (insideTriangle(x, y, [0.2, 0.33], [0.8, 0.33], [0.5, 0.57])) return BRAND;
  return WHITE;
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SUPERSAMPLE);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = (px * SUPERSAMPLE + sx + 0.5) * step;
          const y = (py * SUPERSAMPLE + sy + 0.5) * step;
          const colour = sample(x, y);
          if (!colour) continue;
          r += colour[0];
          g += colour[1];
          b += colour[2];
          a += 255;
        }
      }
      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const covered = a / 255;
      const offset = (py * size + px) * 4;
      if (covered > 0) {
        rgba[offset] = Math.round(r / covered);
        rgba[offset + 1] = Math.round(g / covered);
        rgba[offset + 2] = Math.round(b / covered);
      }
      rgba[offset + 3] = Math.round(a / samples);
    }
  }
  return rgba;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, encodePng(size, render(size)));
  console.log(`wrote ${file}`);
}
