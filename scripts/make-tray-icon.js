// 生成托盘图标（16×16 / 32×32）并打印 base64 + ASCII 预览
//
//   node scripts\make-tray-icon.js
//
// 为什么有这个脚本：托盘图标是**直接嵌在 main.js 里的 base64**（软件不带任何图片文件，
// 分享版拷走一个目录就能跑）。手写/手调 base64 很容易弄出一张「全透明」的图 ——
// 2026-10-19 主播报的「托盘里没有图标，但右键有菜单」就是这么来的：
// 原来那段 16×16 PNG 解出来 256 个像素**全是 alpha=0**，而且 zlib 校验都过不了。
//
// 想改图标：改下面的 `shade()`（它返回归一化坐标下的 [r,g,b,a]），重跑脚本，
// 把打印出来的两行 base64 粘回 main.js 的 TRAY_ICON_16 / TRAY_ICON_32。
// ASCII 预览可以直接肉眼看形状（# 白鱼 / + 蓝盘 / . 透明），不用真机。
const zlib = require('zlib');

/** CRC32（PNG 每个 chunk 都要） */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(Buffer.from([0])); // filter 0
    rows.push(rgba.subarray(y * width * 4, (y + 1) * width * 4));
  }
  const idat = zlib.deflateSync(Buffer.concat(rows), { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** 品牌色：和面板一致（--brand #5b83ff → --brand-2 #3f63d8），白鱼是图形 */
const BRAND_TOP = [0x5b, 0x83, 0xff];
const BRAND_BOTTOM = [0x3f, 0x63, 0xd8];
const EYE = [0x25, 0x3a, 0x8f];

/** 在 0..1 的归一化坐标里画：返回 [r,g,b,a]（a 0..1） */
function shade(nx, ny) {
  // 圆盘：稍微留点边，Windows 托盘边上不要贴死
  const dx = nx - 0.5;
  const dy = ny - 0.5;
  const inDisc = dx * dx + dy * dy <= 0.47 * 0.47;
  // 鱼身：横椭圆
  const bx = (nx - 0.44) / 0.325;
  const by = (ny - 0.5) / 0.225;
  const inBody = bx * bx + by * by <= 1;
  // 鱼尾：右侧三角形（从鱼身右缘收成一个尖）
  const inTail = nx >= 0.7 && nx <= 0.95 && Math.abs(ny - 0.5) <= (0.95 - nx) * 0.9;
  // 眼睛
  const ex = (nx - 0.33) / 0.05;
  const ey = (ny - 0.435) / 0.05;
  const inEye = ex * ex + ey * ey <= 1;

  if (!inDisc) return [0, 0, 0, 0];
  if (inEye) return [...EYE, 1];
  if (inBody || inTail) return [255, 255, 255, 1];
  // 圆盘：上浅下深，和面板的渐变一致
  const t = Math.min(1, Math.max(0, (ny - 0.03) / 0.94));
  return [
    Math.round(BRAND_TOP[0] + (BRAND_BOTTOM[0] - BRAND_TOP[0]) * t),
    Math.round(BRAND_TOP[1] + (BRAND_BOTTOM[1] - BRAND_TOP[1]) * t),
    Math.round(BRAND_TOP[2] + (BRAND_BOTTOM[2] - BRAND_TOP[2]) * t),
    1
  ];
}

/** 超采样画一张：size 是最终边长，ss 是每边采样数（抗锯齿靠它） */
function render(size, ss = 6) {
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const nx = (x + (sx + 0.5) / ss) / size;
          const ny = (y + (sy + 0.5) / ss) / size;
          const [pr, pg, pb, pa] = shade(nx, ny);
          // 预乘后再平均，免得边缘出现黑边
          r += pr * pa;
          g += pg * pa;
          b += pb * pa;
          a += pa;
        }
      }
      const count = ss * ss;
      const i = (y * size + x) * 4;
      out[i + 3] = Math.round((a / count) * 255);
      if (a > 0) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
      }
    }
  }
  return out;
}

function ascii(rgba, size) {
  const lines = [];
  for (let y = 0; y < size; y += 1) {
    let line = '';
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const alpha = rgba[i + 3];
      if (alpha < 40) line += '.';
      else if (rgba[i] > 200 && rgba[i + 1] > 200) line += '#';
      else if (rgba[i + 2] > 200 && rgba[i] < 120) line += '@';
      else line += '+';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

const small = render(16);
const big = render(32);
const base64_16 = encodePng(16, 16, small).toString('base64');
const base64_32 = encodePng(32, 32, big).toString('base64');

console.log('=== 16×16（# 白鱼 / + 蓝盘 / . 透明）===');
console.log(ascii(small, 16));
console.log('\n=== 32×32 ===');
console.log(ascii(big, 32));
console.log('\n=== base64 ===');
console.log('16:', base64_16);
console.log('32:', base64_32);

// `--write`：直接写回 main.js 里的两行常量。
// 为什么要脚本写而不是手粘：这两串 base64 有几百个字符，手粘一次漏一个字符就是「托盘又看不见了」，
// 而且那种错还不会报错（createFromDataURL 解不出来只会得到一张空图）。
if (process.argv.includes('--write')) {
  const mainFile = require('path').join(__dirname, '..', 'src', 'main', 'main.js');
  const source = require('fs').readFileSync(mainFile, 'utf8');
  const replaced = source
    .replace(/(const TRAY_ICON_16 =\s*\n?\s*')data:image\/png;base64,[^']*'/, `$1data:image/png;base64,${base64_16}'`)
    .replace(/(const TRAY_ICON_32 =\s*\n?\s*')data:image\/png;base64,[^']*'/, `$1data:image/png;base64,${base64_32}'`);
  if (replaced === source) {
    console.error('\n✗ 没写进 main.js：没找到 TRAY_ICON_16 / TRAY_ICON_32 这两行常量');
    process.exit(1);
  }
  require('fs').writeFileSync(mainFile, replaced, 'utf8');
  console.log(`\n✓ 已写回 src/main/main.js（16 = ${base64_16.length} 字符，32 = ${base64_32.length} 字符）`);
}
