'use strict';

/**
 * 从文件导入资料 → 让模型整理成知识条目。
 *
 * 主播要的：知识库「添加/编辑条目」那里加个「从文件导入」，选 txt / md 之类的文件，
 * 让模型把里面的东西整理进知识库（产出先进「待审草稿」，点通过才真的进库）。
 *
 * 这个模块只放**纯函数**（读文本、判编码、切片、拼提示词），不碰网络也不碰配置，
 * 所以能直接在 `scripts/test.js` 里跑；真正的调用编排在 `main.js` 的 IPC 里。
 *
 * ## 三个必须处理好的细节（都是踩过的现实问题）
 *
 * 1. **编码**：中国用户的 txt 有一半是 GBK（记事本老版本、部分导出工具）。
 *    直接 `readFileSync(utf8)` 会得到一整篇乱码，而模型会把乱码当内容"整理"进知识库——
 *    这种脏数据事后很难捞出来。所以先严格按 UTF-8 试，不合法再按 GBK 解。
 * 2. **长度**：一整本设定集可能有几 MB。一次全发给模型又贵又容易糊，
 *    所以按「段落边界」切成 ~5000 字一片，一次最多 6 片（约 3 万字），超了就明说「只处理了前 X 字」。
 * 3. **二进制**：用户可能误选 .docx / .png / 压缩包。这类文件解出来满屏 NUL 和乱码，
 *    必须先挡掉（判据：解出来的文本里 NUL 或不可打印字符占比过高）。
 */

/** 认哪些扩展名（`.docx` 这类二进制故意不认：解出来是乱码） */
const TEXT_EXTENSIONS = ['txt', 'md', 'markdown', 'csv', 'json', 'log'];

/** 单个文件的上限（字节）。超过就不读，直接告诉他「太大了，先切一下」 */
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB
/** 切片大小（字符）：约等于中文 5000 字，一次调用 3~4k token，便宜且不容易糊 */
const CHUNK_CHARS = 5000;
/** 一次导入最多处理几片（6 × 5000 = 3 万字） */
const MAX_CHUNKS = 6;

/**
 * 解一段文本：先严格 UTF-8，失败再 GBK，都不行就当 UTF-8 有损解（保底不崩）。
 *
 * 为什么不用 BOM 判断：BOM 只说明「这个文件曾经用某种编码存过」，
 * 记事本另存为 GBK 时是没有 BOM 的，光看 BOM 判不出来。
 *
 * @param {Buffer} buffer
 * @returns {{text:string, encoding:'utf-8'|'gbk'|'utf-8-lossy'}}
 */
function decodeText(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  // 去掉 UTF-8 BOM（\uFEFF 留着会被当成正文第一个字，标题里很碍眼）
  let offset = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) offset = 3;
  const body = buf.subarray(offset);

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return { text, encoding: 'utf-8' };
  } catch (_) {
    /* 不是干净的 UTF-8，接着试 GBK */
  }
  try {
    const text = new TextDecoder('gbk').decode(body);
    return { text, encoding: 'gbk' };
  } catch (_) {
    /* 这台机器的 Node 没带 GBK 字符集（少见），退回有损 UTF-8 */
  }
  const text = new TextDecoder('utf-8').decode(body);
  return { text: text.replace(/\uFFFD/g, ''), encoding: 'utf-8-lossy' };
}

/**
 * 这段"文本"到底是不是文本？
 *
 * 判据：NUL 占比或不可打印字符占比过高就判定为二进制。
 * 为什么要这么严：`.docx` 是 zip，解出来大段 NUL；`.png` 解出来是一堆随机字节，
 * 都会被模型当成"资料"去整理，产出全是垃圾条目。
 */
function looksBinary(text) {
  const source = String(text || '');
  if (!source) return false;
  const sample = source.slice(0, 4000);
  let bad = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i);
    if (code === 0) return true; // 有 NUL 基本就是二进制
    // 允许：\t \n \r、可打印字符、中文等宽字符
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32) bad += 1;
    if (code >= 0xfff0) return true; // 替换字符 / 私用区：解码失败的典型痕迹
  }
  return bad / sample.length > 0.02;
}

/** 统一的换行 + 去行尾空白（切片和提示词都指望它） */
function normaliseText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 按段落边界切片。
 *
 * 为什么不直接 `slice(i, i+5000)`：会把一句话（甚至一个词）劈成两半，
 * 模型拿到半截话只能瞎猜，整理出来的条目就错。所以优先在空行处断开，
 * 没有空行才退到句号/换行，最后才硬切。
 *
 * @returns {string[]}
 */
function chunkText(text, size = CHUNK_CHARS) {
  const source = normaliseText(text);
  const limit = Math.max(200, Number(size) || CHUNK_CHARS);
  if (!source) return [];
  if (source.length <= limit) return [source];

  const chunks = [];
  let rest = source;
  while (rest.length > limit) {
    // 在 limit 附近找一个"像样的结尾"：空行 > 换行 > 句末标点
    const window = rest.slice(0, limit);
    const candidates = [
      window.lastIndexOf('\n\n'),
      window.lastIndexOf('\n'),
      Math.max(window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'), window.lastIndexOf('.'))
    ];
    let cut = Math.max(...candidates);
    if (cut < limit * 0.6) cut = limit; // 断点太靠前就浪费了，直接硬切
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

/**
 * 读一个文件 → 可交给模型的内容。
 *
 * @param {{path?:string, name?:string, buffer:Buffer}} input
 * @returns {{ok:boolean, name:string, text:string, chars:number, encoding:string, reason?:string}}
 */
function prepareImport(input) {
  const name = String((input && (input.name || input.path)) || '').trim();
  const buffer = input && input.buffer ? input.buffer : Buffer.alloc(0);
  if (!buffer.length) return { ok: false, name, text: '', chars: 0, encoding: '', reason: '文件是空的' };
  if (buffer.length > MAX_FILE_BYTES) {
    return {
      ok: false,
      name,
      text: '',
      chars: 0,
      encoding: '',
      reason: `文件太大（${Math.round(buffer.length / 1024)}KB，上限 ${Math.round(MAX_FILE_BYTES / 1024)}KB）——先切小一点再导`
    };
  }
  const { text, encoding } = decodeText(buffer);
  if (looksBinary(text)) {
    return {
      ok: false,
      name,
      text: '',
      chars: 0,
      encoding,
      reason: '看起来不是纯文本（可能是 Word/PDF/图片/压缩包）——先另存成 .txt 或 .md 再导'
    };
  }
  const clean = normaliseText(text);
  if (!clean) return { ok: false, name, text: '', chars: 0, encoding, reason: '里面没有文字' };
  return { ok: true, name, text: clean, chars: clean.length, encoding };
}

/**
 * 把多个文件排成"这次要发几次模型"的计划。
 *
 * - 单文件按段落切；
 * - 总切片数不超过 `maxChunks`（默认 6），超了就**截断**并记下丢了哪些，好如实告诉用户；
 * - 返回里带 `chars`/`droppedChars`，界面能直接显示「这次处理了 X 字，还有 Y 字没处理」。
 *
 * @param {Array<{name:string,text:string}>} files
 * @returns {{jobs:Array<{name:string,chunk:string,index:number,total:number,chars:number,first:boolean}>, chars:number, droppedChars:number, droppedFiles:string[]}}
 */
function planImportJobs(files, { maxChunks = MAX_CHUNKS, chunkChars = CHUNK_CHARS } = {}) {
  const list = Array.isArray(files) ? files.filter((file) => file && file.text) : [];
  const jobs = [];
  let chars = 0;
  let droppedChars = 0;
  const droppedFiles = [];

  // 先给每个文件切好，再统一分配预算：这样「一个文件被截断」和「后面的文件整个没排上」
  // 能分开报告（用户要知道自己是该切文件还是分批导）
  for (const file of list) {
    const pieces = chunkText(file.text, chunkChars);
    const total = pieces.length;
    for (let index = 0; index < pieces.length; index += 1) {
      if (jobs.length >= maxChunks) {
        droppedChars += pieces[index].length;
        continue;
      }
      jobs.push({
        name: String(file.name || ''),
        chunk: pieces[index],
        index: index + 1,
        total,
        chars: pieces[index].length,
        first: index === 0
      });
      chars += pieces[index].length;
    }
    if (pieces.length && jobs.every((job) => job.name !== String(file.name || ''))) {
      droppedFiles.push(String(file.name || ''));
    }
  }
  return { jobs, chars, droppedChars, droppedFiles };
}

/** 导入时的系统提示词（和别的链路一样：只写确定信息，别编） */
const IMPORT_SYSTEM_PROMPT = [
  '你在帮主播把资料整理进「直播知识库」。资料是主播自己上传的文件片段。',
  '',
  '任务：把这段资料里**直播时能直接用上的事实**整理成 1~6 条知识。',
  '',
  '硬要求：',
  '1. **只写资料里明确写了的东西**。不要补充、不要推测、不要编；资料里没写的一律不写。',
  '2. 一条知识 = 一件事（一个商品 / 一个角色 / 一个梗 / 一条规则 / 一个时间点）。',
  '   不相关的内容不要硬塞进同一条。',
  '3. 正文 2~6 句、不超过 300 字，写成**直播时能直接照着说**的口吻；保留资料里的数字、名字、时间。',
  '4. 标题一句话说清是什么，不超过 20 字。',
  '5. 资料里如果有明显的章节名 / 小标题，可以用它当标题的一部分，便于以后检索。',
  '',
  '输出格式（每条之间空一行，不要用代码块包起来，除了条目不要输出任何解释）：',
  '===知识条目===',
  '标题：<一句话标题>',
  '标签：<逗号分隔，可以留空>',
  '正文：<这条知识的内容>'
].join('\n');

/**
 * 拼这一次的用户提示词：文件信息 + 片段内容。
 * 片段序号要带上：模型知道自己在看"第 2/5 片"，就不会把开头的总述当成全部内容。
 */
function buildImportPrompt({ name, chunk, index = 1, total = 1 } = {}) {
  const label = String(name || '上传的资料').trim();
  const where = total > 1 ? `（第 ${index}/${total} 段）` : '';
  return [
    `文件名：${label}${where}`,
    '',
    '资料原文：',
    '"""',
    String(chunk || '').trim(),
    '"""',
    '',
    '请按系统提示词里的格式整理成知识条目。'
  ].join('\n');
}

module.exports = {
  TEXT_EXTENSIONS,
  MAX_FILE_BYTES,
  CHUNK_CHARS,
  MAX_CHUNKS,
  IMPORT_SYSTEM_PROMPT,
  decodeText,
  looksBinary,
  normaliseText,
  chunkText,
  prepareImport,
  planImportJobs,
  buildImportPrompt
};
