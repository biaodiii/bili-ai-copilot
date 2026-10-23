'use strict';

/**
 * 内置默认吉祥物素材（2026-10-21 加）。
 *
 * 主播的要求：**「我的默认吉祥物素材应该也放在发布包里，并且应该设为默认的吉祥物」**——
 * 别人装好就该看见那只大肥鱼，而不是一块空白/emoji，也不该让他自己去文件夹里一张张导入。
 *
 * 做法：把 `默认素材图片\` 里的 PNG 读成 dataURL（和界面里「导入图片」存的是同一种格式），
 * 第一次启动时写进 `mascot.images`。文件名本身就是表情名（平常/喜欢/害羞/睡觉/打招呼/
 * 疑惑/慌张/叹气/聆听/说话/突然出现/吃白饭），`pickMascotImage()` 认不出来时会按
 * `EMOTION_KEYWORDS` 用文件名自动配图，所以**不需要**预先写死 `expressions`。
 *
 * 纯函数式（不碰配置、不碰 app），方便单测；落盘由 main.js 的 `seedBundledMascot()` 负责。
 */

const fs = require('fs');
const path = require('path');

/** 素材目录名（项目根 / 发布包根目录下，和 exe 放一起，用户一眼能看见） */
const MASCOT_DIR_NAME = '默认素材图片';

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
};

/** 单张图最大 4MB：再大就别往 settings.json 里塞了（那是整份读写的文件） */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** 最多认 60 张：够覆盖 12 个状态 + 若干自定义表情，再多就是资源目录放错了 */
const MAX_FILES = 60;

function isImageName(name) {
  return Object.prototype.hasOwnProperty.call(MIME_BY_EXT, path.extname(String(name)).toLowerCase());
}

/** 目录里有没有可用的图片（只数一层，不递归） */
function hasImages(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isFile() && isImageName(entry.name));
  } catch (_) {
    return false;
  }
}

/**
 * 找素材目录：优先 `默认素材图片\` 本身，其次它下面**一层**子目录
 * （当前素材是 `默认素材图片\吉祥物大肥鱼\*.png`）。找不到返回空串。
 */
function findMascotFolder(root) {
  const base = path.join(String(root || '.'), MASCOT_DIR_NAME);
  if (!fs.existsSync(base)) return '';
  if (hasImages(base)) return base;
  try {
    const subDirs = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(base, entry.name))
      .sort();
    for (const dir of subDirs) {
      if (hasImages(dir)) return dir;
    }
  } catch (_) {
    /* 读不了就当没有 */
  }
  return '';
}

/**
 * 读一个目录里的图片，转成 `{ 文件名: dataURL }`（键就是面板里显示的名字）。
 *
 * @returns {{images:object, bytes:number, skipped:Array<{name:string,reason:string}>}}
 */
function loadMascotImages(folder) {
  const images = {};
  const skipped = [];
  let bytes = 0;
  let entries = [];
  try {
    entries = fs
      .readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isImageName(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    return { images, bytes, skipped: [{ name: folder, reason: `读不了目录：${error.message}` }] };
  }
  for (const name of entries) {
    if (Object.keys(images).length >= MAX_FILES) {
      skipped.push({ name, reason: `超过 ${MAX_FILES} 张上限` });
      continue;
    }
    const file = path.join(folder, name);
    try {
      const size = fs.statSync(file).size;
      if (size > MAX_FILE_BYTES) {
        skipped.push({ name, reason: `超过单张 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB` });
        continue;
      }
      const mime = MIME_BY_EXT[path.extname(name).toLowerCase()];
      const buffer = fs.readFileSync(file);
      images[name] = `data:${mime};base64,${buffer.toString('base64')}`;
      bytes += size;
    } catch (error) {
      skipped.push({ name, reason: error.message });
    }
  }
  return { images, bytes, skipped };
}

module.exports = {
  MASCOT_DIR_NAME,
  MAX_FILE_BYTES,
  MAX_FILES,
  findMascotFolder,
  loadMascotImages
};
