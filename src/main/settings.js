'use strict';

/**
 * 配置读写：所有设置存在 userData/settings.json
 * 图片以 dataURL 形式存进 mascot.images，方便单文件携带。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const { appRoot } = require('./app-paths');
// 表情（含用户自定义的那些）的规则只在 shared/emotions.js 定义一处，主进程 / 界面 / 测试共用
const sharedEmotions = require('../shared/emotions.js');
// 主动搭话的取值范围只写一处（settings 清洗和界面提示都从这儿来）
const proactiveShared = require('./proactive.js');
// 观众记忆的取值范围同理（本场文档 / 老观众名册）
const memoryShared = require('./viewer-memory.js');

/**
 * 温度上限。deepseek-chat 在 1.75 时实测会偶发退化成随机字词堆砌，
 * 线上真出现过「啰瑟根空一占向性2自具论咩流沙构约相带特江汽…」这种回复，
 * 而且一旦写进上下文，模型会顺着自己的乱码继续编。1.3 以内复现不出来。
 */
const MAX_TEMPERATURE = 1.3;

const DEFAULT_PERSONA = [
  '你是直播间里的“AI 搭档”，坐在主播旁边一起陪观众聊天。',
  '',
  '说话风格：',
  '- 语气轻松、口语化、像真人搭话，不要客服腔、不要播音腔。',
  '- 每次回复都很短：一到两句话说清，总长尽量不超过40个字。',
  '- 只回应当前这条弹幕，不要重复别人的话，不要长篇大论。',
  '- 话题跟着观众走，观众聊什么就接什么，不要硬拉回固定主题。',
  '- 观众提技术或知识问题时，给准确答案；不确定就老实说不知道。',
  '- 不讨论政治、不吵架、不接地域黑和人身攻击的梗，遇到就轻描淡写地岔开。',
  '- 不要暴露你是 AI 模型的名称和厂商，观众问起就说“我是主播的搭档”。',
  '- 你不知道主播的真名，需要称呼时直接叫「主播」，不要瞎猜。',
  ''
].join('\n');

function defaultSettings() {
  return {
    api: {
      apiKey: '',
      baseUrl: 'https://api.deepseek.com',
      // 官方现在推荐的模型名（2026-09-10 起 deepseek-v4-flash 已下线，路由到 deepseek-flash）。
      // 老配置里的 deepseek-chat 会被自动迁移，见 sanitize() 里的迁移那一段。
      model: 'deepseek-flash',
      // 思考档位：off = 不要思考（最快）/ low / high / max。
      // 直播场景默认给 low——实测真实提示词下思考只花 13~54 token、总耗时 1 秒左右；
      // 而默认的 high 档会多花约 1.5 秒，观众等不起。
      thinking: 'low',
      temperature: 1.1,
      // 单次回复的输出上限。**0 = 不限制**（请求里干脆不发 max_tokens，用服务端默认上限）。
      // 为什么不限制：思考内容也算在这个额度里，给太小会出现「思考把额度吃光、
      // 正文是空的」；而正文本身被提示词约束在 40 字以内，不会失控。
      maxTokens: 0,
      timeoutSec: 45
    },
    // 账号登录：在软件内弹出 B 站官方登录页，登录后自动保存 Cookie
    account: {
      loggedIn: false,
      sessdata: '',
      biliJct: '',
      dedeUserId: '',
      buvid3: '',
      userName: '',
      userUid: '',
      avatar: '',
      loginAt: 0,
      keepSession: true
    },
    persona: {
      botName: '小助手',
      nickname: '小助手',
      systemPrompt: DEFAULT_PERSONA,
      // 性格 / 说话风格（可选，一行短句）。它和人设一起进提示词，但分开存：
      // 人设是「它是谁」，性格是「它怎么说话」，改其中一个不用重写另一个。
      styleNotes: '',
      // ---- 角色表（多套人设的存档）----
      // 键是角色 id，值是 { name, emoji, prompt, style }。
      // ⚠️ 这是一个「以 id 为键的动态表」，不能按默认值的键来筛（否则新增角色会被丢掉），
      // 删角色时也必须整块替换（见 REPLACE_KEYS），不然删了会被合并回来。
      // `default` 这一条在首次读配置时由下面的人设字段生成 —— 也就是「你原本配的那个小助手」。
      roles: {},
      activeRole: 'default',
      // 完整系统提示词的**覆盖模板**（留空 = 用程序内置的完整模板）。
      // 里面可以写 {搭档名字} / {当前时间} / {情绪清单} 这类占位符，每次请求再渲染成真实值。
      // 为什么要模板而不是存渲染结果：渲染结果会把「编辑那一刻的时间」和「当时的主播称呼」
      // 冻进去，过一会儿就全是错的。
      systemPromptOverride: '',
      contextRounds: 8,
      memoryMinutes: 20,
      // 已停用：实测「JSON 输出模式 + 这套中文长系统提示词」下 DeepSeek 会返回纯空格
      // （completion_tokens 十几个、finish_reason 却是 stop），8 次里空 7~8 次。
      // 情绪改用句末 [情绪:xxx] 标记，稳定性实测 8/8。保留字段只为兼容老配置。
      useJsonFormat: false,
      // 直播上下文：默认保持通用，不把主播名/标题之类的房间信息发给模型
      anchorName: '',
      sendStreamTitle: false,
      // 允许 AI 在对话中自己微调语气（会作为一行“自我风格备注”带进后续请求）
      selfTuning: true,
      maxSelfNoteLength: 40,
      selfNote: ''
    },
    overlay: {
      displayId: null,
      posXRatio: 0.76,
      posYRatio: 0.55,
      width: 460,
      height: 620,
      mascotWidth: 200,
      fontScale: 1,
      opacity: 1,
      clickThrough: true,
      alwaysOnTop: true,
      // 锁定窗口位置（2026-10-19 加的；悬浮窗顶栏有个 🔒 按钮切它）：
      // 锁定后顶栏不能再拖动悬浮窗（系统拖动区被关掉），双击也不复位——防止直播中手滑拖歪。
      // **不影响**窗口里的按钮：否则锁上就解不开了。
      locked: false,
      // AI 回复文本在悬浮窗里停留多久（秒）：超过这段时间没有新内容就淡出
      replySeconds: 22,
      // 窗口高度怎么定（2026-10-19 加，配合四边拖拽抓手）：
      //   content = 跟着内容走（默认，原行为）：回复长了窗口自己变高，最高到 overlay.height
      //   fixed   = 固定成 overlay.height：回复再长也在回复区里滚动，窗口不动
      // 用户从四条边拖过高度之后会自动切成 fixed —— 不然松手的那一刻就被"内容高度"覆盖回去了。
      heightMode: 'content',
      // 回复气泡**不自动消失**（2026-10-19 主播要的）：开着的时候 `replySeconds` 不起作用，
      // 那句话会一直留在悬浮窗上，直到下一条回复把它顶掉。
      // 典型用法：讲一段话的时候开着，讲完再关；或者场子安静时把最后一句留在屏幕上。
      replyPersist: false,
      // 回复文本里是否带上观众原话（「某某说：…」那一行小字）
      showViewerMessage: true,
      hideInScreenshot: false,
      // 悬浮窗内的对话区：可以直接在这里打字和搭档聊天，同时看到弹幕
      chatEnabled: true,
      chatHeight: 210,
      chatMaxItems: 60,
      chatShowDanmaku: true,
      // 对话区里是否在观众名字下方显示弹幕 id / uid
      chatShowIds: false,
      // 启动时是否自动显示悬浮窗（默认不显示，由用户手动点按钮打开）
      autoShow: false,
      // 打开悬浮窗时是否自动展开快捷设置（默认关闭，需要时点 ⚙ 或按 Alt+S）
      autoOpenDrawer: false
    },
    danmaku: {
      autoStart: true,
      roomId: '',
      sessdata: '',
      useCookie: false,
      // ⚠️ 2026-10-21 删了 `showEnter` / `showGift` / `showSuperChat`：
      //   这条连接收不到礼物 / 上舰 / 进场 / 醒目留言（连解析都删了，见 danmaku.js 的 _dispatch），
      //   留着这三个键只会在设置页上撑出两个永远不起作用的勾。老配置里残留的同名键会被忽略。
      ignoreKeywords: '打卡,签到,抽奖',
      maxLength: 120,
      minIntervalSec: 6,
      batchWindowMs: 1500,
      maxBatch: 8,
      onlyReplyIncoming: false,
      blockedUsers: '',
      triggerMode: 'all'
      // ⚠️ 老的 `autoWarmup / warmupQuietSeconds / warmupPrompt`（冷场暖场）已经升级成下面的
      //    `proactive`（2026-10-21）。老配置由 `migrateLegacyWarmup()` 在 load 时自动迁移过来，
      //    这里不再保留这几个键——保留着会被界面绑到已经不存在的控件上（那是另一个坑）。
    },
    /**
     * 主动搭话（2026-10-21 加的，替换原来的「冷场暖场」）。
     *
     * 主播要的是「高度可定制，并且可以写进提示词里」，所以：**时机/频率/方式全是结构化的开关**，
     * **风格和规矩写进 `prompt`**（会原样拼进每一次搭话的提示词）。
     * 真正的实现在 `src/main/proactive.js`（纯函数）+ `copilot.js` 的定时器/触发。
     */
    proactive: {
      enabled: false,
      /** 安静多少秒后搭话（30~1800） */
      idleSeconds: 180,
      /** 每小时最多说几次（0 = 不限）——防止整场直播都在自言自语 */
      maxPerHour: 6,
      /** 每次冷场只有这么大的概率真的开口（0~100）：太机械会被观众看出来 */
      chancePercent: 70,
      /** 一句话最多多少字（20~120） */
      maxChars: 40,
      /** 允许哪几种方式：topic 开话题 / ask 问观众 / follow 接话（空数组 = 都不许，等于关掉） */
      modes: ['topic', 'ask', 'follow'],
      /** 允许从知识库挑「可以聊的料」 */
      useKnowledge: true,
      /** 主播自定义的搭话规矩（原样拼进提示词） */
      prompt: '别太刻意，像随口聊天一样；不要连着两次用同一种方式；有人说话的时候不要抢话。'
    },
    /**
     * 观众记忆（2026-10-21 加）：解决「清空对话上下文之后她就失忆了」。
     *   · `enabled`：本场记录（模型批量总结，注入提示词），开一次算一场，一份文件；
     *   · `rosterEnabled`：老观众名册（纯本地，零模型成本，跨场复用）；
     * 两份文件都在 `data/观众记忆/`，**不进知识库**（不参与检索、不被整理校对改写）。
     */
    viewerMemory: {
      enabled: false,
      /**
       * 每次启动软件就自动开一场（2026-10-21 加，**默认开**）。
       *   · 开着：启动时直接把 `enabled` 打开，主播不用每天手点一次；
       *   · 关掉：启动时按 `enabled` 上次的值来，等于纯手动；
       *   · 直播中手动关掉「本场记录」只结束这一场，下次启动照样自动开（这正是主播要的）。
       */
      autoStart: true,
      rosterEnabled: true,
      /** 攒够多少条弹幕就总结一次（5~60） */
      batchSize: 20,
      /** 最多隔多久总结一次（30~1800 秒） */
      intervalSec: 120,
      /** 每小时最多总结几次（0 = 不限，上限 60）：防止刷屏时一直调模型 */
      maxBatchesPerHour: 12,
      /** 每轮注入的摘要字数（200~1500）；**清空对话记忆之后照样带** */
      injectChars: 500,
      /** 老观众名册最多记多少人（超出按最近出现淘汰） */
      rosterMax: 2000
    },
    safety: {
      // 本地防线：连续失败就自动暂停，避免一路报错刷屏
      autoPauseOnError: true,
      maxConsecutiveFailures: 3
    },
    mascot: {
      images: {},
      // 状态 → 图片名的映射。留空表示「按文件名自动匹配」，
      // 所以这里**不要写任何示例键**：这张表的键由界面提交，写死了反而会把
      // 默认值里没有的状态筛掉（见 sanitize 里 images/expressions 那段注释）。
      expressions: {},
      // 状态 → 触发词[]：观众弹幕里出现这些词就切到该状态。
      // 键同样由状态表/界面决定，不要写示例键；空对象 = 用内置默认触发词。
      triggers: {},
      // 用户自己加的表情（2026-10-19 加的）：`[{key, when, alias}]`，最多 8 个。
      // 内置那 12 个状态在 shared/emotions.js 里写死、**不可删**（连接打招呼、思考切 thinking
      // 这些行为绑在状态上）；这里只放用户额外加的「生气」「吃瓜」这类。
      // 清洗交给 emotions.js 的 normaliseCustomEmotions()（限长、挡内置撞车、最多 8 个）。
      customEmotions: [],
      fallbackEmoji: '🦊',
      /**
       * 内置默认素材「种过了」没有（2026-10-21）。
       * 第一次启动会把 `默认素材图片\` 里的 12 张图导进 `images`，然后把这个标成 true。
       * 有了它，主播以后**故意删掉**这些图也不会被下次启动又加回来
       * （`main.js` 的 `seedBundledMascot()` 只种一次）。
       */
      bundledSeeded: false,
      // （原来这里有个 `showName: true`：「显示名字牌」，控制悬浮窗吉祥物下面那行「小助手」。
      //   2026-10-19 主播要求把那行字去掉，功能整个删了，键也一起删——
      //   老配置里残留的 showName 会被 sanitize 的「只认默认值里有的键」顺手扔掉。）
      animation: true
    },
    // 语音朗读：让搭档把回复念出来。
    // engine = 'system' 用 Windows 自带语音（离线、免费，默认）；
    // engine = 'cloud'  用云端 TTS（音色好听但有网络延迟，失败会自动退回系统语音）。
    speech: {
      enabled: false,
      muted: false,
      // ---- 系统语音这一套（engine=system 时用；engine=cloud 时作为降级备用）----
      voiceURI: '',
      rate: 1.05,
      pitch: 1.05,
      volume: 1,
      readViewer: false,
      // ---- 引擎选择 ----
      engine: 'system',
      // 云端失败时是否退回系统语音。默认开：直播中断声音比音色难听严重得多
      fallbackToSystem: true,
      // ---- 云端语音（阿里云百炼 / DashScope 的 Qwen TTS）----
      cloud: {
        apiKey: '',
        baseUrl: 'https://dashscope.aliyuncs.com',
        model: 'qwen3-tts-flash',
        voice: 'Cherry',
        languageType: 'Chinese',
        timeoutMs: 15000,
        cacheSize: 100
      }
    },
    window: {
      panelWidth: 1040,
      panelHeight: 760
    },
    logging: {
      maxMemory: 500,
      writeFile: true
    },
    // 弹幕记录：把收到的每一条弹幕（含被去重丢掉的）逐条写文件，方便事后对照排查。
    // dir 为空表示「用默认位置」——默认放在「我的文档」下，故意不放程序目录：
    // 实测程序目录里的 .log 文件会被一些清理软件当垃圾扫掉。
    danmakuLog: {
      enabled: true,
      dir: '',
      maxFileMB: 2,
      keepFiles: 5,
      maxTextLength: 300
    },
    // ---- 最高权限（全自动，P7）----
    // 关着 = 现在这样：她问、你点头、草稿你审。
    // 打开 = 她自己联网查、自己把产出写进知识库、自己用那几个软件功能、自己删条目。
    // ⚠️ 有几件事**任何档位都不放开**：向直播间发送任何内容（只读）、改 API Key / 房间号、
    //    开始/停止弹幕监听。改人设走另一条门（只有开发者模式）。
    agent: {
      maxPermissions: false,
      // 她自己联网的次数上限（小时）。花钱的那部分，默认收紧。
      searchPerHour: 6,
      // 她自己调用软件功能的次数上限（小时）。防她钻牛角尖反复暂停/恢复。
      toolsPerHour: 30
    },
    // ---- 知识库 ----
    // 直播间自己的资料（梗、商品、口播稿…）存在「软件目录/知识库/notes/*.md」，
    // 回复前按弹幕内容检索，把命中的条目塞进这一次的请求。
    knowledge: {
      // 是否把命中的知识带进提示词（关掉 = 完全不影响回复）
      enabled: true,
      // 一次最多注入几条 / 整段多少字（附注本身约 40 字，所以下限给 200）
      injectCount: 3,
      injectChars: 600,
      // 空 = 用「软件目录/知识库」。⚠️ 不要把它写死成绝对路径：
      // 这个目录同时是 DSH 的工作区，写死了换台电脑就指到别人家去了。
      dir: '',
      // ---- 研究引擎：谁来「读文件 / 联网 / 整理成条目」----
      // builtin = 用现有 DeepSeek 接口（含原生联网搜索）；dsh = 交给 DeepSeek Harness
      // ⚠️ DSH 已下线（2026-10-19）：`runResearchQuery` 把 engine **钉成了 'builtin'**，
      //    所以这份配置现在怎么写都不会走 DSH；下面那组 dsh* 键同理（保留给恢复用）。
      //    想恢复：改 main.js 里那行 engine 赋值 + 去掉 index.html 的 #dshCard hidden，见交接文档 §6.16。
      engine: 'builtin',
      // ---- 内置联网走哪条路（只有 engine=builtin 时才有意义）----
      // 两条都保留、随时能换，产出格式完全一样（都先进「待审草稿」）：
      //   self  = DeepSeek 2026-10-17 开放的**自研搜索接口**（POST /v1/tools/search）：
      //           先拿到结构化结果（带站点 / 日期 / 权威度 / 链接），再让模型整理成条目。
      //           实测 0.7 秒出结果、一次 0.005 元，整理那步再花 2~4 千 token；失败自动退回 model。
      //   model = **模型联网**（老办法，原本就在用的）：Anthropic 兼容接口 + 服务端
      //           web_search 工具，模型一边搜一边写。实测 6~15 秒、一次约 0.03 元
      //           （2026-11-01 起服务端搜索按 0.005 元/次单独计费）。
      // ⚠️ 默认 self 是因为实测又快又便宜；哪天真搜不动了，主播在面板上一键切回 model 就行。
      searchMode: 'self',
      // ---- 下面这组 dsh* 全部**已下线**（2026-10-19，DSH 研究引擎下线，面板入口也藏了）----
      // 只是**保留**（只藏不删），当前代码没有任何路径会用到它们（唯一例外：dshTimeoutSec
      // 被联网查询借去当超时上限）。想恢复时这些键原样可用，不用改配置。
      // DSH 怎么跑：
      //   session  = 长驻 SDK 进程 + 一个固定会话（推荐）：会话落在 DSH 的会话库里，
      //              你在 DSH Web 的列表里能看到它、能看它一步步干活、随时接手
      //   headless = 一次性子进程：跑完就退，安静但看不见过程
      dshMode: 'session',
      // 那个固定会话叫什么（**软件这边的标注**：会作为新会话第一句话的前缀，
      // DSH 用它自动生成会话标题，所以我们不控制 DSH 里的标题，但能一眼认出）
      dshSessionName: '直播知识整理',
      // DSH 那边的会话 id（由 DSH 生成、软件存下来续用）。
      // ⚠️ 不要手改：它是 resume 的钥匙，改错了只会「续不上 → 新建一个」。
      dshSessionId: '',
      // 让 DSH 用哪个模型（会话模式）：软件在会话上直接指定，不用去改 DSH 的配置。
      // deepseek-flash = **DeepSeek-V41-Flash**（4.1 Flash，便宜快，默认）；
      // 想换就填 deepseek-v4-pro 之类；**留空 = 不指定**，用 DSH 自己的默认。
      dshModel: 'deepseek-flash',
      // 「她自己动库」的次数上限：一小时最多几次（0 = 不限）
      selfEditPerHour: 10,
      // ---- 整理 / 校对 / 更新（2026-10-19 加，面板「知识库」页）----
      // 一次「联网校对」最多跑几条：每条 = 一次搜索 + 一次最高思考档调用（约 3~8 秒、约 0.01~0.02 元）。
      // 默认 5 条是"先试一小批"的节奏；跑完界面上还有"再校对 N 条"。
      // ⚠️ 上限收在 20：这活儿是逐条串行的，20 条在慢机器上要好几分钟。
      reviewLimit: 5,
      // ---- 她自己改库的权限（P6）----
      //   auto = 她发现写错 / 想补内容就**直接改**（改完告诉你改了哪条）
      //   ask  = 先问你一句，你回「改」她才改
      //   off  = 她只提，改不改由你在面板点
      // 不管哪一档，每次改动都会：① 先把旧版本备份到「知识库/.history/」；
      // ② 在面板「知识库改动记录」里留一条，能一键撤销（新建的条目撤销 = 删掉它）。
      selfEdit: 'auto',
      // 空 = 自动探测（PATH 上的 dsh，以及本机 npx 缓存里那一份）
      dshCommand: '',      // 空 = 用 PATH 上的 node。⚠️ 实测不能用 Electron 自带的 Node 跑 DSH（静默失败）
      dshNode: '',
      dshTimeoutSec: 300,
      // 是否已经告诉过用户「DSH 的工作区被限定在知识库目录里」。
      // 只告知一次：这事说一遍就够，每次跑都弹会烦人（界面上那行字是常驻的）。
      dshWorkspaceNoticeSeen: false,
      // 研究引擎产出的条目先放「待审」，主播点通过才进库
      requireReview: true
    }
  };
}

/**
 * 弹幕记录的默认存放位置：我的文档\直播AI搭档\弹幕记录
 *
 * 为什么不用程序目录：实测 data 目录里的 .log 会被清理类软件（360 / 火绒 / CCleaner
 * 这类按扩展名清扫的工具）删掉，排查弹幕问题时记录跟着一起没了就白记了。
 */
function defaultDanmakuLogDir() {
  const candidates = [];
  if (process.env.USERPROFILE) candidates.push(path.join(process.env.USERPROFILE, 'Documents'));
  candidates.push(path.join(os.homedir(), 'Documents'));
  candidates.push(os.homedir());
  for (const base of candidates) {
    if (base && fs.existsSync(base)) return path.join(base, '直播AI搭档', '弹幕记录');
  }
  return '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 配置文件固定在「程序根目录/data/settings.json」，找不到可写位置才退回 userData。
 * 这样无论如何都能确定配置在哪，排查问题时不至于找不到文件。
 *
 * ⚠️ 程序根目录必须用 `app-paths.appRoot()`：打包后它就是 **exe 所在目录**。
 *    以前这里写的是 `__dirname/../../data`，打包后会变成 `resources\app\data`
 *    ——用户翻不到、装到 Program Files 还写不进去（打发布包时实测踩到）。
 */
function pickSettingsFile() {
  const candidates = [path.join(appRoot(), 'data', 'settings.json')];
  try {
    candidates.push(path.join(app.getPath('userData'), 'settings.json'));
  } catch (_) {
    /* ignore */
  }
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      fs.accessSync(path.dirname(candidate), fs.constants.W_OK);
      return candidate;
    } catch (_) {
      /* 换下一个 */
    }
  }
  return candidates[0];
}

/**
 * 是不是官方 DeepSeek 接口（用于「只在官方接口下迁移模型名」这类判断）。
 * 中转站/自建网关一律算「不是」，那边的模型名由中转站自己定，不要去改。
 */
function isOfficialDeepSeek(baseUrl) {
  const text = String(baseUrl || '').trim().toLowerCase();
  if (!text) return true; // 空 = 用默认官方地址
  return /^https?:\/\/(api\.)?deepseek\.com(\/|$)/.test(text);
}

/**
 * 哪些字段要「整块替换」而不是逐键合并。
 *
 * 为什么需要它：合并默认是**逐键覆盖**，没提到的键会保留——这对普通设置项是对的
 * （界面只提交改动的字段），但对**以名字为键的表**是致命的：
 * 「吉祥物」页删掉一张图时传的是 `{images: {剩下的图}}`，逐键合并会把它当成
 * 「更新这几张」，被删的那张原样留着 → 表现就是「点删除没反应」。
 */
const REPLACE_KEYS = ['mascot.images', 'persona.roles'];

/** 角色字段的长度上限（用户手改配置时不至于把提示词撑爆） */
const ROLE_LIMITS = { name: 40, emoji: 8, prompt: 20000, style: 2000 };/**
 * 清洗角色表：`{ [id]: {name, emoji, prompt, style} }`。
 * 键（角色 id）是用户数据，不能按默认值的键去筛——默认值是空表，
 * 一筛就把用户建的角色全丢了（这个坑在吉祥物图片表上踩过一次）。
 */
function normaliseRoles(given) {
  const table = {};
  if (!isPlainObject(given)) return table;
  for (const [id, entry] of Object.entries(given)) {
    const key = String(id || '').trim();
    if (!key || !isPlainObject(entry)) continue;
    const role = {};
    for (const [field, limit] of Object.entries(ROLE_LIMITS)) {
      role[field] = String(entry[field] == null ? '' : entry[field]).slice(0, limit);
    }
    table[key] = role;
  }
  return table;
}

/**
 * 把「当前正在编辑的人设」同步进当前角色。
 *
 * 为什么要有这一步：界面上的名字 / 人设 / 性格是**活字段**，而角色是它们的存档。
 * 如果不自动同步，用户改完人设直接切角色，改动就没了（或者得再点一次「保存」）。
 * 放在主进程做，是为了让**任何**改人设的路径都生效——包括主播在开发者模式里
 * 直接对 AI 说「以后你叫小明」那种（AI 改配置走的也是 patch）。
 */
function syncActiveRole(data) {
  const persona = data && data.persona;
  if (!isPlainObject(persona) || !isPlainObject(persona.roles)) return;
  const id = String(persona.activeRole || 'default');
  const role = persona.roles[id];
  if (!isPlainObject(role)) return;
  role.name = String(persona.botName || role.name || '').slice(0, ROLE_LIMITS.name);
  role.prompt = String(persona.systemPrompt || '').slice(0, ROLE_LIMITS.prompt);
  role.style = String(persona.styleNotes || '').slice(0, ROLE_LIMITS.style);
}

/**
 * 递归合并。`path` / `replaceKeys` 是内部参数，用来判断当前这层要不要整块替换
 * （路径写成 `mascot.images` 这种点号形式）。
 */
function deepMerge(base, patch, replaceKeys, path = '') {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!isPlainObject(patch)) return out;
  for (const [key, value] of Object.entries(patch)) {
    const childPath = path ? `${path}.${key}` : key;
    const mustReplace = Array.isArray(replaceKeys) && replaceKeys.includes(childPath);
    if (isPlainObject(value) && isPlainObject(out[key]) && !mustReplace) {
      out[key] = deepMerge(out[key], value, replaceKeys, childPath);
    } else if (value !== undefined) {
      out[key] = isPlainObject(value) ? { ...value } : value;
    }
  }
  return out;
}

/**
 * 老「冷场暖场」→ 新「主动搭话」的迁移（2026-10-21）。
 *
 * 只处理**还没有 `proactive` 段**的配置（也就是第一次升级），迁完 `load()` 会立刻落盘；
 * 之后主播改开关就不会再被老键覆盖（老键留着不删，想回滚旧版本时值还在，但新版本不再读它们）。
 *
 * ⚠️ 必须在 `deepMerge(defaultSettings(), ...)` **之前**跑：默认值里已经有 `proactive`，
 *    合并之后再判断"有没有这一段"就永远成立，迁移等于没写。
 *
 * @returns {{data:object, changed:boolean}}
 */
function migrateLegacyWarmup(raw) {
  if (!isPlainObject(raw) || isPlainObject(raw.proactive)) return { data: raw, changed: false };
  const legacy = isPlainObject(raw.danmaku) ? raw.danmaku : null;
  if (!legacy) return { data: raw, changed: false };
  const hasLegacy =
    legacy.autoWarmup !== undefined || legacy.warmupQuietSeconds !== undefined || legacy.warmupPrompt !== undefined;
  if (!hasLegacy) return { data: raw, changed: false };
  const idle = Number(legacy.warmupQuietSeconds);
  const proactive = {
    enabled: legacy.autoWarmup === true,
    idleSeconds: Number.isFinite(idle) && idle > 0 ? idle : proactiveShared.DEFAULT_IDLE_SECONDS,
    prompt:
      typeof legacy.warmupPrompt === 'string' && legacy.warmupPrompt.trim()
        ? legacy.warmupPrompt.trim()
        : proactiveShared.DEFAULT_PROMPT
  };
  return { data: { ...raw, proactive }, changed: true };
}

/**
 * 清洗配置：用户可能手改 settings.json，或者旧版本字段类型不一样。
 * 这里按默认值的类型逐个校正，避免一个字段类型错了把整个界面搞崩。
 */
function sanitize(data) {
  const defaults = defaultSettings();
  const out = {};

  // 老配置里的 bubbleSeconds 是「回复停留秒数」的旧名字。改名必须发生在下面这层
  // 按默认值逐键拷贝之前：那层只认默认值里有的键，bubbleSeconds 会被直接丢掉。
  if (isPlainObject(data) && isPlainObject(data.overlay)) {
    const legacy = Number(data.overlay.bubbleSeconds);
    if (data.overlay.replySeconds === undefined && Number.isFinite(legacy)) {
      data = { ...data, overlay: { ...data.overlay, replySeconds: legacy } };
    }
  }

  for (const [section, defaultValue] of Object.entries(defaults)) {
    const incoming = data && isPlainObject(data[section]) ? data[section] : {};
    if (Array.isArray(defaultValue)) {
      out[section] = Array.isArray(incoming) ? incoming : defaultValue;
      continue;
    }
    if (!isPlainObject(defaultValue)) {
      out[section] = typeof incoming === typeof defaultValue ? incoming : defaultValue;
      continue;
    }
    const section2 = {};
    for (const [key, value] of Object.entries(defaultValue)) {
      const given = incoming[key];
      if (Array.isArray(value)) {
        section2[key] = Array.isArray(given) ? given : value;
      } else if (isPlainObject(value)) {
        // 触发词表：键是状态、值是字符串数组，直接原样收（清洗交给 emotions.js 的
        // normaliseTriggers()，那边才知道哪些状态名是合法的）
        if (key === 'triggers') {
          const table = {};
          if (isPlainObject(given)) {
            for (const [name, entry] of Object.entries(given)) {
              if (Array.isArray(entry)) table[String(name)] = entry.map((word) => String(word == null ? '' : word));
            }
          }
          section2[key] = table;
        } else if (key === 'roles') {
          // 角色表：键是角色 id（用户自己建的），值是 {name, emoji, prompt, style}
          section2[key] = normaliseRoles(given);
        } else if (key === 'images' || key === 'expressions') {
          // 「以名字为键的表」：图片表（名字 → dataURL）和表情映射表（状态 → 图片名）。
          // 这两张表的键是用户自己定的，**不能按默认值里的键来筛**——
          // 默认值里只列了几个示例，一旦按它筛，新增的状态（惊讶/睡觉/打招呼…）
          // 在读配置时就会被整条丢掉，表现是「选了图片又变回未指定」。
          const table = {};
          if (isPlainObject(given)) {
            for (const [name, entry] of Object.entries(given)) {
              if (typeof entry !== 'string') continue;
              // 图片表：空 dataURL 等于没有这张图，直接丢掉；
              // 表情映射表：空字符串是有意义的，表示「这个状态让自动匹配去挑」
              if (key === 'images' ? !entry : false) continue;
              table[String(name)] = entry;
            }
          }
          section2[key] = table;
        } else {
          const nested = {};
          for (const [subKey, subValue] of Object.entries(value)) {
            const givenSub = isPlainObject(given) ? given[subKey] : undefined;
            if (Array.isArray(subValue)) nested[subKey] = Array.isArray(givenSub) ? givenSub : subValue;
            else if (isPlainObject(subValue)) nested[subKey] = isPlainObject(givenSub) ? givenSub : subValue;
            else nested[subKey] = typeof givenSub === typeof subValue ? givenSub : subValue;
          }
          section2[key] = nested;
        }
      } else if (value === null) {
        // 允许为空的字段（如 overlay.displayId）
        section2[key] = given === undefined ? value : given;
      } else {
        section2[key] = typeof given === typeof value ? given : value;
      }
    }
    out[section] = section2;
  }

  // 数值字段做范围兜底，避免手改出 0 或负数导致界面算不出来
  const clampNumber = (target, key, min, max) => {
    const value = Number(target[key]);
    if (!Number.isFinite(value)) return;
    target[key] = Math.min(max, Math.max(min, value));
  };
  clampNumber(out.overlay, 'posXRatio', 0, 1);
  clampNumber(out.overlay, 'posYRatio', 0, 1);
  clampNumber(out.overlay, 'width', 160, 1200);
  clampNumber(out.overlay, 'height', 120, 1200);
  clampNumber(out.overlay, 'mascotWidth', 60, 800);
  clampNumber(out.overlay, 'fontScale', 0.5, 2.5);
  clampNumber(out.overlay, 'opacity', 0.1, 1);
  clampNumber(out.overlay, 'replySeconds', 3, 600);
  clampNumber(out.overlay, 'chatHeight', 120, 520);
  // 高度模式只认这两个值（手改配置写坏了就退回"跟内容走"，至少窗口还能用）
  if (out.overlay && !['content', 'fixed'].includes(out.overlay.heightMode)) out.overlay.heightMode = 'content';
  clampNumber(out.danmaku, 'minIntervalSec', 0, 600);
  clampNumber(out.danmaku, 'batchWindowMs', 100, 30000);
  clampNumber(out.danmaku, 'maxBatch', 1, 50);
  clampNumber(out.danmaku, 'maxLength', 1, 2000);
  // 主动搭话：开关只认真布尔；数值收敛到可用范围；方式表去重；自定义规矩限长
  if (out.proactive) {
    out.proactive.enabled = out.proactive.enabled === true;
    // 「允许从知识库挑谈资」默认是开的：只有明确写 false 才关
    out.proactive.useKnowledge = out.proactive.useKnowledge !== false;
    clampNumber(out.proactive, 'idleSeconds', proactiveShared.MIN_IDLE_SECONDS, proactiveShared.MAX_IDLE_SECONDS);
    clampNumber(out.proactive, 'maxPerHour', 0, proactiveShared.MAX_PER_HOUR_LIMIT);
    clampNumber(out.proactive, 'chancePercent', 0, 100);
    clampNumber(out.proactive, 'maxChars', proactiveShared.MIN_MAX_CHARS, proactiveShared.MAX_MAX_CHARS);
    out.proactive.modes = proactiveShared.normaliseModes(out.proactive.modes);
    out.proactive.prompt =
      typeof out.proactive.prompt === 'string'
        ? out.proactive.prompt.slice(0, 2000)
        : proactiveShared.DEFAULT_PROMPT;
  }
  // 观众记忆：开关只认真布尔（名册/启动自动记录默认开，只有明确写 false 才关）；数值收敛
  if (out.viewerMemory) {
    out.viewerMemory.enabled = out.viewerMemory.enabled === true;
    out.viewerMemory.autoStart = out.viewerMemory.autoStart !== false;
    out.viewerMemory.rosterEnabled = out.viewerMemory.rosterEnabled !== false;
    clampNumber(out.viewerMemory, 'batchSize', memoryShared.MIN_BATCH_SIZE, memoryShared.MAX_BATCH_SIZE);
    clampNumber(out.viewerMemory, 'intervalSec', memoryShared.MIN_INTERVAL_SEC, memoryShared.MAX_INTERVAL_SEC);
    clampNumber(out.viewerMemory, 'maxBatchesPerHour', 0, memoryShared.MAX_BATCHES_LIMIT);
    clampNumber(out.viewerMemory, 'injectChars', memoryShared.MIN_INJECT_CHARS, memoryShared.MAX_INJECT_CHARS);
    clampNumber(out.viewerMemory, 'rosterMax', memoryShared.MIN_ROSTER_MAX, memoryShared.MAX_ROSTER_MAX);
  }
  clampNumber(out.persona, 'contextRounds', 0, 60);
  clampNumber(out.persona, 'memoryMinutes', 0, 1440);
  clampNumber(out.api, 'temperature', 0, MAX_TEMPERATURE);
  // 上限放到 393216（服务端允许的最大值）。0 是特殊值，表示「不限制」，见下面的迁移。
  clampNumber(out.api, 'maxTokens', 0, 393216);
  clampNumber(out.api, 'timeoutSec', 3, 300);
  clampNumber(out.danmakuLog, 'maxFileMB', 0.1, 100);
  clampNumber(out.danmakuLog, 'keepFiles', 1, 50);
  clampNumber(out.danmakuLog, 'maxTextLength', 20, 5000);
  // 最高权限：两个次数上限（0 = 不限），开关只认真布尔
  clampNumber(out.agent, 'searchPerHour', 0, 100);
  clampNumber(out.agent, 'toolsPerHour', 0, 500);
  if (out.agent) out.agent.maxPermissions = out.agent.maxPermissions === true;
  clampNumber(out.knowledge, 'injectCount', 0, 10);
  clampNumber(out.knowledge, 'injectChars', 200, 4000);
  clampNumber(out.knowledge, 'dshTimeoutSec', 30, 1800);
  // 「她自己动库」的次数上限：0 = 不限（界面上可选）
  clampNumber(out.knowledge, 'selfEditPerHour', 0, 200);
  // 一次联网校对跑几条：1~20（0 或乱填按默认 5 处理，见 main.js 的 runKnowledgeVerify）
  clampNumber(out.knowledge, 'reviewLimit', 1, 20);

  // 研究引擎只认这两个值
  if (out.knowledge && !['builtin', 'dsh'].includes(out.knowledge.engine)) out.knowledge.engine = 'builtin';
  // 内置联网的走法只认这两个值（self = 自研搜索接口，model = 模型联网老办法）——
  // 手改配置写错了不能把「去查」弄成永远失败，一律按默认来
  if (out.knowledge && !['self', 'model'].includes(out.knowledge.searchMode)) out.knowledge.searchMode = 'self';
  // DSH 的跑法只认这两个值
  if (out.knowledge && !['session', 'headless'].includes(out.knowledge.dshMode)) out.knowledge.dshMode = 'session';
  // 她自己动库的权限只认这三个值
  if (out.knowledge && !['auto', 'ask', 'off'].includes(out.knowledge.selfEdit)) out.knowledge.selfEdit = 'auto';

  // 一次性迁移：老配置里存着 useJsonFormat: true，而它正是空回复的元凶。
  // 不迁的话重启后照样踩坑，所以无论配置里写的是什么，一律关掉。
  if (out.persona) out.persona.useJsonFormat = false;

  // 角色表：老配置里只有一套人设，这里把它变成「默认角色」这一条存档
  // ——也就是「你自己原本配的那个小助手」。
  // ⚠️ 只在缺失时创建：每次都从活字段重建的话，用户切到别的角色重启后，
  // 默认角色会被当前角色的内容覆盖，等于默认人设被悄悄改掉。
  if (out.persona) {
    if (!isPlainObject(out.persona.roles)) out.persona.roles = {};
    if (!isPlainObject(out.persona.roles.default)) {
      out.persona.roles.default = {
        name: String(out.persona.botName || '小助手').slice(0, 40),
        emoji: '🐟',
        prompt: String(out.persona.systemPrompt || ''),
        style: String(out.persona.styleNotes || '')
      };
    }
    // activeRole 指向一个不存在的角色（手改配置 / 删过角色）→ 回默认，不然界面会空白
    if (!isPlainObject(out.persona.roles[out.persona.activeRole])) out.persona.activeRole = 'default';
  }

  // 思考档位只认这四个值，写别的（或老配置里没有这个字段）就回落到 low
  if (out.api && !['off', 'low', 'high', 'max'].includes(out.api.thinking)) {
    out.api.thinking = 'low';
  }

  // 语音引擎只认 system / cloud，老配置里没这个字段（等于以前只有系统语音）
  if (out.speech && !['system', 'cloud'].includes(out.speech.engine)) {
    out.speech.engine = 'system';
  }
  // 云端相关数值也别让手改坏
  if (out.speech && out.speech.cloud) {
    const num = (key, min, max, fallback) => {
      const value = Number(out.speech.cloud[key]);
      out.speech.cloud[key] = Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
    };
    num('timeoutMs', 3000, 120000, 15000);
    num('cacheSize', 10, 2000, 100);
  }

  // 模型名迁移：deepseek-chat / deepseek-reasoner 官方已于 2026-07-24 停止服务
  // （现在只是被路由到 flash，随时可能彻底断掉），官方接口下的老配置一律换成新名字。
  //
  // ⚠️ 只对**官方接口**做这个替换：用中转站的人，那边的模型名可能真的就叫
  // deepseek-chat（甚至是他们自己的命名），无脑改名会把人家搞坏。
  if (out.api && isOfficialDeepSeek(out.api.baseUrl)) {
    if (out.api.model === 'deepseek-chat' || out.api.model === 'deepseek-reasoner') {
      out.api.model = 'deepseek-flash';
    }
  }

  // 输出上限太小会把思考内容顶满、正文变空：老配置里的小值统一改成「不限制」。
  // 0 是特殊值「不限制」，所以判断条件是「大于 0 但小得不够用」。
  if (out.api && Number(out.api.maxTokens) > 0 && Number(out.api.maxTokens) < 800) {
    out.api.maxTokens = 0;
  }

  // 指向「已不存在的图片」的表情映射要清掉。
  // 删除图片时界面会顺手清一次，但更早的版本没清干净，配置里会留下
  // mascot.expressions.happy = "某张早就删掉的图" 这种死映射：
  // 界面上那一行会显示成「没指定」，看着像设置丢了。
  if (out.mascot && isPlainObject(out.mascot.expressions)) {
    const images = out.mascot.images || {};
    for (const [emotion, target] of Object.entries(out.mascot.expressions)) {
      if (target && !images[target]) out.mascot.expressions[emotion] = '';
    }
  }

  // ---- 自定义表情（2026-10-19）----
  // ① 清洗：名字长度、挡掉跟内置撞车的、最多 8 个（规则都在 emotions.js 里，一处定义）；
  // ② **顺手清掉「已经不存在」的状态键**：用户删掉一个自定义表情之后，
  //    expressions / triggers 里还会留着它的键（界面删的时候会清，但手改配置 / 老版本不一定），
  //    留着就会变成「图还在、但永远切不到」的死配置。
  if (out.mascot) {
    out.mascot.customEmotions = sharedEmotions.normaliseCustomEmotions(out.mascot.customEmotions);
    // 内置素材只种一次：老配置里没有这个键 → 当「还没种过」，交给 main.js 判断
    out.mascot.bundledSeeded = out.mascot.bundledSeeded === true;
    const validKeys = new Set(sharedEmotions.emotionList(out.mascot.customEmotions).map((item) => item.key));
    for (const table of ['expressions', 'triggers']) {
      if (!isPlainObject(out.mascot[table])) continue;
      const next = {};
      for (const [key, value] of Object.entries(out.mascot[table])) {
        if (validKeys.has(key)) next[key] = value;
      }
      out.mascot[table] = next;
    }
  }

  return out;
}

class SettingsStore {
  /**
   * @param {string} [file] 显式指定配置文件路径。**测试和一次性脚本必须传它**，
   *   否则会落到真实配置（`data/settings.json`）上——这个坑真踩过：
   *   构造函数原来不收参数，测试里写的 `new SettingsStore(tmpFile)` 被静默忽略，
   *   结果测试把用户真实的 settings.json 覆盖了。
   */
  constructor(file) {
    this.file = file ? path.resolve(String(file)) : pickSettingsFile();
    this.data = defaultSettings();
    this.load();
  }

  /**
   * 把空的 danmakuLog.dir 补成真实默认路径，并写回配置。
   * 写回是故意的：这样「弹幕记录存在哪」在配置文件里是看得见的，不会被当成神秘行为。
   */
  resolveDanmakuLogDir({ persist = true } = {}) {
    if (this.data.danmakuLog && this.data.danmakuLog.dir) return this.data.danmakuLog.dir;
    const resolved = defaultDanmakuLogDir();
    if (!resolved) return '';
    this.data.danmakuLog.dir = resolved;
    if (persist) this.save();
    return resolved;
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf8');
        const parsed = JSON.parse(raw);
        // 老的「冷场暖场」配置先迁成「主动搭话」，再合并默认值（顺序不能反，见函数注释）
        const migrated = migrateLegacyWarmup(parsed);
        this.data = sanitize(deepMerge(defaultSettings(), migrated.data));
        if (migrated.changed) {
          // 迁移结果立刻落盘：不然下次启动又会拿老键迁一次，
          // 主播明明关了主动搭话、重启却被老配置重新打开。
          this.save();
        }
      } else {
        this.data = defaultSettings();
        this.resolveDanmakuLogDir();
        this.save();
      }
    } catch (error) {
      // 配置损坏时不要把程序卡死，备份一份再用默认值
      try {
        fs.copyFileSync(this.file, `${this.file}.broken`);
      } catch (_) {
        /* ignore */
      }
      console.error('[settings] 配置读取失败，已回退到默认值:', error.message);
      this.data = defaultSettings();
    }
    // 老版本配置里没有 danmakuLog.dir，这里补上并落盘
    this.resolveDanmakuLogDir();
    return this.data;
  }

  get() {
    return this.data;
  }

  patch(partial) {
    // REPLACE_KEYS 里的字段整块替换（比如吉祥物图片表），否则删除操作会被合并掉
    this.data = sanitize(deepMerge(this.data, partial, REPLACE_KEYS));
    // 人设的活字段一改就存进当前角色，切角色时不会丢改动
    syncActiveRole(this.data);
    this.resolveDanmakuLogDir();
    this.save();
    return this.data;
  }

  reset() {
    this.data = sanitize(defaultSettings());
    syncActiveRole(this.data);
    this.save();
    return this.data;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (error) {
      console.error('[settings] 保存失败:', error);
    }
  }
}

module.exports = {
  SettingsStore,
  defaultSettings,
  DEFAULT_PERSONA,
  deepMerge,
  sanitize,
  migrateLegacyWarmup,
  defaultDanmakuLogDir
};
