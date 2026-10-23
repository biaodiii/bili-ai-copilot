'use strict';

/**
 * 云端语音合成（TTS）客户端。
 *
 * 为什么放在主进程：
 *   · 密钥不进渲染层（界面脚本里拿不到 Key）
 *   · 没有浏览器 CORS 问题
 *   · 缓存能跨界面共享
 *
 * 现在只实现了阿里云百炼（DashScope）的 Qwen TTS。要换别的服务商，
 * 只需要再写一个 `synthesize` 分支——调用方（界面）拿到的永远是「一段音频」，
 * 与具体服务商无关。
 *
 * 设计上刻意的几点：
 *   · **缓存**：直播里「你好呀」这种高频句会反复念，按「音色+文本」缓存，
 *     不然每次都重新合成，白花钱还慢。命中缓存时按 LRU 顺序提前，超出上限丢最旧的。
 *   · **合并在途请求**：同一句话在短时间内被请求两次（比如预热 + 真播），只发一次 HTTP。
 *   · **失败就抛**：绝不返回空音频假装成功——由调用方决定降级（退回系统语音）。
 */

const DEFAULT_TIMEOUT_MS = 15000;
/** 缓存最多留多少条（按音频体积算，60 字左右的 wav 大约 200KB，100 条约 20MB） */
const DEFAULT_CACHE_SIZE = 100;

// ---------------------------------------------------------------- 接口族
//
// ⚠️ **一个模型只认一条接口路径**，这是实测出来的，不是猜的：
//   · qwen3-tts-flash          → `/api/v1/services/aigc/multimodal-generation/generation`
//                                 （报文 input: {text, voice, language_type}）
//   · qwen-audio-*、cosyvoice-* → `/api/v1/services/audio/tts/SpeechSynthesizer`
//                                 （报文 input: {text, voice, format, sample_rate}）
// 走错路径服务端会回 `url error, please check url！`——看起来像域名写错，其实是路径不对。
// 官方文档说后一条路径要用业务空间专属域名，但 2026-10 实测**共享域名也能通**，
// 所以不用逼用户去控制台找 Workspace ID。
//
// 另外：**音色不能跨模型混用**，音色不匹配会回 `Invalid voice specified`。
// 所以换模型时必须连带把音色换成那个模型认的，否则一定报错。
const PATH_QWEN_TTS = '/api/v1/services/aigc/multimodal-generation/generation';
const PATH_SPEECH_SYNTH = '/api/v1/services/audio/tts/SpeechSynthesizer';

/** qwen3-tts-flash 的内置音色（2026-10 实测 12 个全部可用） */
const QWEN3_VOICES = [
  { voice: 'Cherry', name: '芊悦', desc: '阳光积极、亲切自然的小姐姐' },
  { voice: 'Serena', name: '苏瑶', desc: '温柔小姐姐' },
  { voice: 'Ethan', name: '晨煦', desc: '标准普通话带北方口音，阳光温暖有活力（男）' },
  { voice: 'Chelsie', name: '千雪', desc: '二次元虚拟女友' },
  { voice: 'Momo', name: '茉兔', desc: '撒娇搞怪，逗你开心' },
  { voice: 'Vivian', name: '十三', desc: '拽拽的、可爱的小暴躁' },
  { voice: 'Moon', name: '月白', desc: '率性帅气（男）' },
  { voice: 'Maia', name: '四月', desc: '知性与温柔' },
  { voice: 'Kai', name: '凯', desc: '耳朵的一场 SPA（男）' },
  { voice: 'Nofish', name: '不吃鱼', desc: '不会翘舌音的设计师（男）' },
  { voice: 'Bella', name: '萌宝', desc: '喝酒不打醉拳的小萝莉' },
  { voice: 'Jennifer', name: '詹妮弗', desc: '品牌级、电影质感美语女声' }
];

/**
 * 可选的语音合成模型。界面拿它做两个下拉（模型 + 音色），改模型只改这一处。
 *   id          请求体里的 `model`
 *   path        该模型唯一能走的接口路径
 *   price/note  界面上的提示文案（帮用户判断「贵不贵、适合什么」）
 *   defaultVoice 这个模型默认用哪个音色（换模型时如果原音色不通用，就落到它）
 */
const TTS_MODELS = [
  {
    id: 'qwen3-tts-flash',
    label: '千问3-TTS-Flash（默认）',
    path: PATH_QWEN_TTS,
    price: '约 0.8 元/万字符',
    note: '最快最便宜，12 个内置音色，直播陪伴够用',
    defaultVoice: 'Cherry',
    voices: QWEN3_VOICES
  },
  {
    id: 'qwen-audio-3.1-tts-flash',
    label: 'Qwen-Audio-3.1-TTS-Flash（最新）',
    path: PATH_SPEECH_SYNTH,
    price: '输入 1.5 元 + 输出 12 元 / 百万 token',
    note: '新一代，音色最多也最精致；按 token 计费（比按字符略贵）',
    defaultVoice: 'longanhuan_v3.1',
    voices: [
      // 多语种与方言（上海/广东/东北/重庆/陕西/云南/宁波/甘肃话 + 日韩法德葡意越印尼语）
      { voice: 'longanhuan_v3.1', name: '龙安欢_v3.1', desc: '女 · 多语种+方言，直播陪伴' },
      { voice: 'longanlingxin_v3.1', name: '龙安灵心_v3.1', desc: '女 · 云南/陕西/上海话，法语意语' },
      { voice: 'longanfengyue_v3.1', name: '龙安风悦_v3.1', desc: '女 · 东北话，日语越南语' },
      { voice: 'xunanchuan_v3.1', name: '许南川', desc: '男 · 甘肃/东北话，法语葡语' },
      // 精品中文
      { voice: 'yuxiaoyun_v3.1', name: '于小云', desc: '女 · 元气、亲切、自然' },
      { voice: 'qiaoxiaojiao_v3.1', name: '乔小娇', desc: '女 · 俏丽、可爱' },
      { voice: 'xiaxiaochen_v3.1', name: '夏小晨', desc: '女 · 元气、明亮' },
      { voice: 'xuxiaoqiao_v3.1', name: '徐小俏', desc: '女 · 自然、俏皮' },
      { voice: 'anyuqing_v3.1', name: '安语晴', desc: '女 · 甜妹' },
      { voice: 'anxiaolan_v3.1', name: '安小岚', desc: '女 · 清甜、纯净' },
      { voice: 'yeqinghe_v3.1', name: '叶清禾', desc: '女 · 亲切、温柔' },
      { voice: 'xieshurou_v3.1', name: '谢舒柔', desc: '女 · 柔和、知性' },
      { voice: 'baiqinglan_v3.1', name: '白清岚', desc: '女 · 明亮、清纯' },
      { voice: 'wenhuaiqing_v3.1', name: '温怀清', desc: '女 · 清亮、柔和' },
      { voice: 'yunhuanhuan_v3.1', name: '云欢欢', desc: '女 · 高亢、热情' },
      { voice: 'xuyuyuan_v3.1', name: '许玉远', desc: '女 · 知性、成熟' },
      { voice: 'anruorou_v3.1', name: '安若柔', desc: '女 · 气声、知性' },
      { voice: 'wenhuaizhi_v3.1', name: '闻怀之', desc: '女 · 稳重、成熟' },
      { voice: 'xiaoxingzhi_v3.1', name: '萧行之', desc: '女 · 端庄、贵气' },
      { voice: 'guyunshu_v3.1', name: '顾云舒', desc: '女 · 成熟、稳重' },
      { voice: 'xuyanchu_v3.1', name: '许言初', desc: '女 · 沉稳、磁性' },
      { voice: 'baianran_v3.1', name: '白安然', desc: '女 · 低沉、浑厚、气声' },
      { voice: 'yezhiqing_v3.1', name: '叶知晴', desc: '女 · 轻快、自然' },
      { voice: 'anmingyuan_v3.1', name: '安明远', desc: '男 · 清亮、自然' },
      { voice: 'huozhuoshi_v3.1', name: '霍拙石', desc: '男 · 清亮' },
      { voice: 'andi_v3.1', name: '安迪', desc: '男 · ABC 口音' },
      // 社交陪伴 / 角色 / 直播
      { voice: 'longanyuanfei_v3.1', name: '龙安元妃_v3.1', desc: '女 · 高傲妃子音（整活用）' },
      { voice: 'longanlingxi_v3.1', name: '龙安灵希_v3.1', desc: '女 · 可爱甜美音' },
      { voice: 'longanya_v3.1', name: '龙安雅_v3.1', desc: '女 · 高雅气质' },
      { voice: 'longwan_v3.1', name: '龙婉_v3.1', desc: '女 · 细腻柔声' },
      { voice: 'longxing_v3.1', name: '龙星_v3.1', desc: '女 · 温婉邻家' },
      { voice: 'longhua_v3.1', name: '龙华_v3.1', desc: '女 · 元气甜美' },
      { voice: 'longhan_v3.1', name: '龙寒_v3.1', desc: '男 · 温暖痴情' },
      { voice: 'longanzhi_v3.1', name: '龙安智_v3.1', desc: '男 · 睿智轻熟' },
      { voice: 'longzhe_v3.1', name: '龙哲_v3.1', desc: '男 · 呆板大暖男' },
      { voice: 'longanyang_v3.1', name: '龙安洋_v3.1', desc: '男 · 阳光大男孩（标杆音色）' },
      { voice: 'longhuohuo_v3.1', name: '龙火火_v3.1', desc: '男 · 顽皮少年音' },
      { voice: 'libai_v3.1', name: '李白_v3.1', desc: '男 · 古代诗仙（念弹幕很好笑）' },
      { voice: 'longanchong_v3.1', name: '龙安冲_v3.1', desc: '男 · 激情推销（带货）' }
    ]
  },
  {
    id: 'qwen-audio-3.0-tts-flash',
    label: 'Qwen-Audio-3.0-TTS-Flash',
    path: PATH_SPEECH_SYNTH,
    price: '1 元/万字符',
    note: '上一代，按字符计费；音色比 3.1 少',
    defaultVoice: 'longanhuan_v3.6',
    voices: [
      { voice: 'longanhuan_v3.6', name: '龙安欢', desc: '女 · 25 岁，官方示例音色（最稳）' },
      { voice: 'longanxiaoxin', name: '龙安小昕', desc: '女 · 亲切活泼，22 岁' },
      { voice: 'longanlingxi', name: '龙安灵希', desc: '女 · 可爱甜美，25 岁' },
      { voice: 'longanfengyue', name: '龙安风悦', desc: '女 · 自然亲切，30 岁' },
      { voice: 'longanyuanfei', name: '龙安元妃', desc: '女 · 高傲妃子音' },
      { voice: 'longchuanshu_v3.6', name: '龙川叔', desc: '男 · 川普大叔音' },
      { voice: 'longhuohuo_v3.6', name: '龙火火', desc: '男 · 顽皮少年音' },
      { voice: 'longjielidou_v3.6', name: '龙杰力豆', desc: '男 · 天真男童' },
      { voice: 'longpaopao_v3.6', name: '龙泡泡', desc: '女 · 软糯可爱（童声）' },
      { voice: 'loongjohn', name: 'loongJohn', desc: '男 · 沉稳亲切美音（英文）' },
      { voice: 'loongeva_v3.6', name: 'loongeva', desc: '女 · 高智美音（英文）' },
      { voice: 'loongmary', name: 'loongmary', desc: '女 · 温暖英音（英文）' }
    ]
  },
  {
    id: 'qwen-audio-3.0-tts-plus',
    label: 'Qwen-Audio-3.0-TTS-Plus（音质更好）',
    path: PATH_SPEECH_SYNTH,
    price: '1.4 元/万字符',
    note: '旗舰音色，音质比 flash 好；只有两个内置音色',
    defaultVoice: 'longanlingxin',
    voices: [
      { voice: 'longanlingxin', name: '龙安灵心', desc: '女 · 知心温暖音，陪伴感最强' },
      { voice: 'longanlufeng', name: '龙安鲁风', desc: '男 · 明亮开朗音' }
    ]
  },
  {
    id: 'cosyvoice-v3-flash',
    label: 'CosyVoice-v3-Flash',
    path: PATH_SPEECH_SYNTH,
    price: '1 元/万字符',
    note: '音色最多（88 个），支持 7 种情感指令；也支持声音复刻',
    defaultVoice: 'longanhuan',
    voices: [
      // 标杆 / 社交陪伴
      { voice: 'longanhuan', name: '龙安欢', desc: '女 · 欢脱元气，支持 7 种情感指令' },
      { voice: 'longanhuan_v3', name: '龙安欢（V3）', desc: '女 · 支持 9 种方言指令' },
      { voice: 'longanyang', name: '龙安洋', desc: '男 · 阳光大男孩' },
      { voice: 'longantai_v3', name: '龙安台', desc: '女 · 嗲甜台湾腔' },
      { voice: 'longhua_v3', name: '龙华', desc: '女 · 元气甜美' },
      { voice: 'longcheng_v3', name: '龙橙', desc: '男 · 智慧青年' },
      { voice: 'longze_v3', name: '龙泽', desc: '男 · 温暖元气' },
      { voice: 'longzhe_v3', name: '龙哲', desc: '男 · 呆板大暖男' },
      { voice: 'longyan_v3', name: '龙颜', desc: '女 · 温暖春风' },
      { voice: 'longxing_v3', name: '龙星', desc: '女 · 温婉邻家' },
      { voice: 'longtian_v3', name: '龙天', desc: '男 · 磁性理智' },
      { voice: 'longwan_v3', name: '龙婉', desc: '女 · 细腻柔声' },
      { voice: 'longqiang_v3', name: '龙嫱', desc: '女 · 浪漫风情' },
      { voice: 'longfeifei_v3', name: '龙菲菲', desc: '女 · 甜美娇气' },
      { voice: 'longhao_v3', name: '龙浩', desc: '男 · 多情忧郁' },
      { voice: 'longanrou_v3', name: '龙安柔', desc: '女 · 温柔闺蜜' },
      { voice: 'longhan_v3', name: '龙寒', desc: '男 · 温暖痴情' },
      { voice: 'longanzhi_v3', name: '龙安智', desc: '男 · 睿智轻熟' },
      { voice: 'longanling_v3', name: '龙安灵', desc: '女 · 思维灵动' },
      { voice: 'longanya_v3', name: '龙安雅', desc: '女 · 高雅气质' },
      { voice: 'longanqin_v3', name: '龙安亲', desc: '女 · 亲和活泼' },
      // 直播带货
      { voice: 'longanxuan_v3', name: '龙安宣', desc: '女 · 经典直播女声' },
      { voice: 'longanran_v3', name: '龙安燃', desc: '女 · 活泼质感' },
      // 方言
      { voice: 'longjiaxin_v3', name: '龙嘉欣', desc: '女 · 优雅粤语' },
      { voice: 'longjiayi_v3', name: '龙嘉怡', desc: '女 · 知性粤语' },
      { voice: 'longanyue_v3', name: '龙安粤', desc: '男 · 欢脱粤语' },
      { voice: 'longlaotie_v3', name: '龙老铁', desc: '男 · 东北直率' },
      { voice: 'longshange_v3', name: '龙陕哥', desc: '男 · 原味陕北' },
      { voice: 'longanmin_v3', name: '龙安闽', desc: '女 · 闽南话' },
      // 整活 / 短视频
      { voice: 'longjiqi_v3', name: '龙机器', desc: '呆萌机器人' },
      { voice: 'longhouge_v3', name: '龙猴哥', desc: '猴哥' },
      { voice: 'longdaiyu_v3', name: '龙黛玉', desc: '娇弱黛玉' },
      { voice: 'longfei_v3', name: '龙飞', desc: '男 · 热血磁性（诗词朗诵）' },
      // 童声
      { voice: 'longhuhu_v3', name: '龙呼呼', desc: '女童 · 天真烂漫' },
      { voice: 'longshanshan_v3', name: '龙闪闪', desc: '男 · 戏剧化童声' },
      { voice: 'longniuniu_v3', name: '龙牛牛', desc: '男 · 阳光男童' },
      { voice: 'longpaopao_v3', name: '龙泡泡', desc: '女 · 飞天泡泡音' },
      { voice: 'longjielidou_v3', name: '龙杰力豆', desc: '男 · 阳光顽皮' },
      // 语音助手 / 客服 / 有声书（耐听，适合长时间直播）
      { voice: 'longxiaochun_v3', name: '龙小淳', desc: '女 · 知性积极' },
      { voice: 'longanwen_v3', name: '龙安温', desc: '女 · 优雅知性' },
      { voice: 'longanli_v3', name: '龙安莉', desc: '女 · 利落从容' },
      { voice: 'longanlang_v3', name: '龙安朗', desc: '男 · 清爽利落' },
      { voice: 'longanyun_v3', name: '龙安昀', desc: '男 · 居家暖男' },
      { voice: 'longyingtao_v3', name: '龙应桃', desc: '女 · 温柔淡定' },
      { voice: 'longyumi_v3', name: 'YUMI', desc: '女 · 正经青年' },
      { voice: 'longmiao_v3', name: '龙妙', desc: '女 · 抑扬顿挫（有声书）' },
      { voice: 'longsanshu_v3', name: '龙三叔', desc: '男 · 沉稳质感（有声书）' },
      { voice: 'longyuan_v3', name: '龙媛', desc: '女 · 温暖治愈（有声书）' },
      { voice: 'longshuo_v3', name: '龙硕', desc: '男 · 博才干练（新闻播报）' }
    ]
  },
  {
    id: 'cosyvoice-v3-plus',
    label: 'CosyVoice-v3-Plus（音质更好）',
    path: PATH_SPEECH_SYNTH,
    price: '2 元/万字符',
    note: '音质与相似度更好，但内置音色只有两个',
    defaultVoice: 'longanhuan',
    voices: [
      { voice: 'longanhuan', name: '龙安欢', desc: '女 · 欢脱元气（官方标杆）' },
      { voice: 'longanyang', name: '龙安洋', desc: '男 · 阳光大男孩' }
    ]
  },
  {
    id: 'cosyvoice-v2',
    label: 'CosyVoice-v2（老版）',
    path: PATH_SPEECH_SYNTH,
    price: '2 元/万字符',
    note: '老模型，音色命名和 v3 不通用',
    defaultVoice: 'longhua_v2',
    voices: [
      { voice: 'longhua_v2', name: '龙华', desc: '女 · 元气甜美' },
      { voice: 'longfeifei_v2', name: '龙菲菲', desc: '女 · 甜美娇气' },
      { voice: 'longwan_v2', name: '龙婉', desc: '女 · 积极知性' },
      { voice: 'longqiang_v2', name: '龙嫱', desc: '女 · 浪漫风情' },
      { voice: 'longyan_v2', name: '龙颜', desc: '女 · 温暖' },
      { voice: 'longxing_v2', name: '龙星', desc: '女 · 温婉' },
      { voice: 'longhan_v2', name: '龙寒', desc: '男 · 温暖痴情' },
      { voice: 'longzhe_v2', name: '龙哲', desc: '男 · 暖男' },
      { voice: 'longze_v2', name: '龙泽', desc: '男 · 元气' },
      { voice: 'longtian_v2', name: '龙天', desc: '男 · 磁性理智' },
      { voice: 'longhao_v2', name: '龙浩', desc: '男 · 多情忧郁' },
      { voice: 'longxiaocheng_v2', name: '龙小诚', desc: '男 · 磁性低音' },
      { voice: 'kabuleshen_v2', name: '龙深', desc: '男 · 实力歌手' },
      { voice: 'longxiaochun_v2', name: '龙小淳', desc: '女 · 知性（语音助手）' },
      { voice: 'longanli', name: '龙安莉', desc: '女 · 利落从容（语音助手）' },
      { voice: 'longanlang', name: '龙安朗', desc: '男 · 清爽利落（语音助手）' },
      { voice: 'longhuhu', name: '龙呼呼', desc: '女童 · 天真烂漫' },
      { voice: 'longwangwang', name: '龙汪汪', desc: '台湾少年音' },
      { voice: 'longpaopao', name: '龙泡泡', desc: '飞天泡泡音' }
    ]
  }
];

const DEFAULT_MODEL = 'qwen3-tts-flash';

/** 按 id 找模型；找不到返回 null（界面/客户端都要处理这种情况） */
function findModel(id) {
  const key = String(id == null ? '' : id).trim();
  return TTS_MODELS.find((item) => item.id === key) || null;
}

/** 某个模型认哪些音色；模型不认识时返回空数组 */
function voicesOfModel(id) {
  const model = findModel(id);
  return model ? model.voices : [];
}

/** 换模型时用：优先给个这个模型认的音色，免得报 Invalid voice specified */
function defaultVoiceFor(modelId) {
  const model = findModel(modelId);
  if (!model) return '';
  return model.defaultVoice || (model.voices[0] && model.voices[0].voice) || '';
}

/** 兼容旧名字（老代码/文档里叫 BUILTIN_VOICES，指的是默认模型的音色） */
const BUILTIN_VOICES = QWEN3_VOICES;

class TtsError extends Error {
  constructor(message, { code, status } = {}) {
    super(message);
    this.name = 'TtsError';
    this.code = code;
    this.status = status;
  }
}

/** 去掉首尾空白并压缩内部空白：同一句话只该合成一次 */
function normalizeText(text) {
  return String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 修 wav 头里的长度字段。
 *
 * ⚠️ 为什么必须修：实测百炼返回的 wav，`RIFF` 块和 `data` 块的**大小字段都是 0x7FFFFFFF**
 * （约 2GB 的占位符，应该是流式生成时不知道最终长度就先填最大值）。
 * 明明文件只有 96KB，头里却写着 2GB —— Chromium 直接拒绝加载，报
 * `Failed to load because no supported source was found`。
 * 音频数据本身没问题，把两个长度字段改成真实值就能播。
 *
 * wav 的块格式：`4 字节块名 + 4 字节块大小 + 数据`，
 * 其中 `RIFF` 块的「数据」是剩下的整个文件（所以它的大小 = 文件长度 - 8）。
 */
function repairWavHeader(buffer) {
  if (buffer.length < 44) return buffer;
  if (buffer.subarray(0, 4).toString('ascii') !== 'RIFF') return buffer;
  if (buffer.subarray(8, 12).toString('ascii') !== 'WAVE') return buffer;

  const out = Buffer.from(buffer); // 不改调用方那份
  const riffActual = out.length - 8;
  let changed = false;
  if (out.readUInt32LE(4) !== riffActual) {
    out.writeUInt32LE(riffActual, 4);
    changed = true;
  }

  // 顺着块往下走，找到 data 块并校正它的大小（其它块的大小声明不动，它们本来就对）
  let offset = 12;
  while (offset + 8 <= out.length) {
    const id = out.subarray(offset, offset + 4).toString('ascii');
    const declared = out.readUInt32LE(offset + 4);
    if (id === 'data') {
      const actual = out.length - (offset + 8);
      if (declared !== actual) {
        out.writeUInt32LE(actual, offset + 4);
        changed = true;
      }
      break;
    }
    const next = offset + 8 + declared;
    if (next <= offset) break; // 大小字段有问题，别死循环
    offset = next;
  }
  return changed ? out : buffer;
}

/** 判断一段音频是不是需要修头（日志和测试用） */
function wavHeaderLooksBroken(buffer) {
  if (buffer.length < 44) return false;
  if (buffer.subarray(0, 4).toString('ascii') !== 'RIFF') return false;
  return buffer.readUInt32LE(4) !== buffer.length - 8;
}

class TtsClient {
  /**
   * @param {{getConfig:Function, logger?:object, fetchImpl?:Function}} options
   *   getConfig() 返回 `{ apiKey, baseUrl, model, voice, languageType, timeoutMs, cacheSize }`
   */
  constructor({ getConfig, logger, fetchImpl } = {}) {
    this.getConfig = typeof getConfig === 'function' ? getConfig : () => ({});
    this.logger = logger || console;
    // 测试里可以塞一个假的 fetch
    this.fetchImpl = fetchImpl || ((...args) => fetch(...args));
    /** 文本+音色 → base64 音频（LRU：命中时删了再塞，保证 Map 的顺序就是使用顺序） */
    this.cache = new Map();
    /** 正在请求中的那句话：避免「预热 + 真播」发两次 HTTP */
    this.inFlight = new Map();
    this.stats = { requests: 0, hits: 0, errors: 0, characters: 0, repaired: 0 };
  }

  _config() {
    const raw = this.getConfig() || {};
    const model = String(raw.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    return {
      apiKey: String(raw.apiKey || '').trim(),
      baseUrl: String(raw.baseUrl || 'https://dashscope.aliyuncs.com').replace(/\/+$/, ''),
      model,
      // 音色没填就落到这个模型的默认音色（换过模型的老配置可能是空/不通用）
      voice: String(raw.voice || '').trim() || defaultVoiceFor(model),
      languageType: String(raw.languageType || 'Chinese').trim() || 'Chinese',
      timeoutMs: Number(raw.timeoutMs) > 0 ? Number(raw.timeoutMs) : DEFAULT_TIMEOUT_MS,
      cacheSize: Number(raw.cacheSize) > 0 ? Number(raw.cacheSize) : DEFAULT_CACHE_SIZE
    };
  }

  /** 配好了没有（界面用它决定「云音色」能不能选） */
  available() {
    return Boolean(this._config().apiKey);
  }

  status() {
    const config = this._config();
    const model = findModel(config.model);
    return {
      available: Boolean(config.apiKey),
      model: config.model,
      modelLabel: model ? model.label : config.model,
      voice: config.voice,
      cached: this.cache.size,
      // 可选模型清单（含各自的音色）：界面拿它做「模型」下拉，
      // 换模型时把「音色」下拉整份换掉——音色不能跨模型混用
      models: TTS_MODELS.map((item) => ({
        id: item.id,
        label: item.label,
        price: item.price,
        note: item.note,
        defaultVoice: item.defaultVoice || '',
        voices: item.voices
      })),
      // 当前模型的音色清单（老字段，保持兼容）
      voices: model ? model.voices : [],
      ...this.stats
    };
  }

  clearCache() {
    this.cache.clear();
    return true;
  }

  _cacheKey(config, text) {
    return `${config.model}|${config.voice}|${config.languageType}|${text}`;
  }

  _remember(key, audio, limit) {
    this.cache.delete(key);
    this.cache.set(key, audio);
    while (this.cache.size > limit) {
      // Map 的迭代顺序 = 插入顺序，第一个就是最久没用过的
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
  }

  /**
   * 合成一段语音。
   * @returns {Promise<{ audio: string, mime: string, cached: boolean, characters: number }>}
   *   `audio` 是纯 base64（不含 data: 前缀），界面自己拼 `data:audio/wav;base64,...`
   */
  async synthesize(text) {
    const config = this._config();
    const content = normalizeText(text);
    if (!content) throw new TtsError('没有要合成的内容', { code: 'EMPTY_TEXT' });
    if (!config.apiKey) throw new TtsError('还没填云端语音的 API Key', { code: 'NO_API_KEY' });

    const key = this._cacheKey(config, content);
    const hit = this.cache.get(key);
    if (hit) {
      this.stats.hits += 1;
      this._remember(key, hit, config.cacheSize); // 刷新 LRU 位置
      return { audio: hit, mime: 'audio/wav', cached: true, characters: 0 };
    }
    if (this.inFlight.has(key)) return this.inFlight.get(key);

    const job = this._request(config, content)
      .then((result) => {
        this._remember(key, result.audio, config.cacheSize);
        return result;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, job);
    return job;
  }

  async _request(config, content) {
    const model = findModel(config.model);
    if (!model) {
      this.stats.errors += 1;
      throw new TtsError(
        `不认识的语音模型「${config.model}」——在语音页的「模型」下拉里选一个`,
        { code: 'UNKNOWN_MODEL' }
      );
    }

    // 报文形状由接口族决定：走错路径服务端只会回一句「url error」，很难查
    const body =
      model.path === PATH_SPEECH_SYNTH
        ? {
            model: model.id,
            input: { text: content, voice: config.voice, format: 'wav', sample_rate: 24000 }
          }
        : {
            model: model.id,
            input: { text: content, voice: config.voice, language_type: config.languageType }
          };

    this.stats.requests += 1;
    this.stats.characters += content.length;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(`${config.baseUrl}${model.path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      this.stats.errors += 1;
      const reason = error && error.name === 'AbortError' ? `超过 ${config.timeoutMs}ms 没返回` : error.message;
      throw new TtsError(`云端语音请求失败：${reason}`, { code: 'NETWORK' });
    } finally {
      clearTimeout(timer);
    }

    let data = null;
    try {
      data = await response.json();
    } catch (_) {
      /* 下面按状态码统一报错 */
    }
    if (!response.ok) {
      this.stats.errors += 1;
      const detail = String((data && (data.message || data.code)) || `HTTP ${response.status}`);
      // 这两类错误光看原文很难查（官方原话是英文且不提原因），补一句「该怎么办」
      let hint = '';
      if (/invalid voice|not licensed/i.test(detail)) {
        hint = `——音色「${config.voice}」不属于模型「${model.id}」，到语音页把音色也换成这个模型认的（音色不能跨模型混用）`;
      } else if (/url error/i.test(detail)) {
        hint = `——这个模型的接口路径不对（换模型时由程序自动选，手动改过地址的话检查一下"接口地址"那一栏）`;
      }
      throw new TtsError(`云端语音返回错误：${detail}${hint}`, { code: 'HTTP', status: response.status });
    }

    const audio = (data && data.output && data.output.audio) || {};
    // ⚠️ 实测（2026-10，北京地域）：**非流式返回的是 url，不是 data**。
    // 官方文档有一句自相矛盾的备注（「非流式模式下该字段直接返回完整音频文件 URL」），
    // 我一开始只读 data，结果 data 是空字符串 → 明明合成成功却报「没有返回音频」。
    // 所以两种都要支持：有 base64 直接用，没有就按 url 下载再转 base64。
    let base64 = audio.data ? String(audio.data) : '';
    let mime = 'audio/wav';
    if (!base64 && audio.url) {
      const downloaded = await this._download(config, String(audio.url));
      base64 = downloaded.base64;
      // 用服务端实际给的 Content-Type（实测是 audio/x-wav），
      // 别硬编码 audio/wav——万一以后那边改返回 mp3，硬编码就会让浏览器认不出来
      if (downloaded.mime) mime = downloaded.mime;
    }
    if (!base64) {
      this.stats.errors += 1;
      throw new TtsError('云端语音没有返回音频（既没有 data 也没有 url）', { code: 'NO_AUDIO' });
    }
    return {
      audio: base64,
      mime,
      cached: false,
      characters: Number((data.usage || {}).characters) || content.length
    };
  }

  /**
   * 把服务端给的音频 URL 下载下来转成 base64。
   * 为什么转 base64 而不是直接把 url 交给界面：那个 URL 24 小时后过期，
   * 而我们要缓存音频；而且渲染层用 dataURL 播放最省事（不用管跨域和临时目录）。
   * @returns {Promise<{base64:string, mime:string}>}
   */
  async _download(config, url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        throw new TtsError(`下载云端音频失败：HTTP ${response.status}`, { code: 'DOWNLOAD', status: response.status });
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) throw new TtsError('下载到的音频是空的', { code: 'DOWNLOAD' });
      // 服务端给的 wav 头里长度字段是占位符，浏览器会拒绝加载，这里修一下
      const fixed = repairWavHeader(buffer);
      if (fixed !== buffer) {
        this.stats.repaired += 1;
        this.logger.warn?.('云端音频的 wav 头长度字段不对（服务端占位符），已自动修正');
      }
      const header = response.headers && response.headers.get ? response.headers.get('content-type') : '';
      return { base64: fixed.toString('base64'), mime: String(header || '').split(';')[0].trim() || 'audio/wav' };
    } catch (error) {
      if (error instanceof TtsError) {
        this.stats.errors += 1;
        throw error;
      }
      this.stats.errors += 1;
      const reason = error && error.name === 'AbortError' ? `超过 ${config.timeoutMs}ms 没下完` : error.message;
      throw new TtsError(`下载云端音频失败：${reason}`, { code: 'DOWNLOAD' });
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = {
  TtsClient,
  TtsError,
  normalizeText,
  repairWavHeader,
  wavHeaderLooksBroken,
  TTS_MODELS,
  DEFAULT_MODEL,
  findModel,
  voicesOfModel,
  defaultVoiceFor,
  BUILTIN_VOICES,
  DEFAULT_CACHE_SIZE
};
