'use strict';

/**
 * 用量统计：记录 token 消耗并估算费用
 *
 * - 按「日期 + 模型」聚合，保存在 userData/usage.json
 * - 费用按内置价目表估算（单位：元 / 百万 token），可被设置覆盖
 * - 失败只记日志不抛错：统计坏掉绝不能影响直播
 */

const fs = require('fs');
const path = require('path');

// DeepSeek 常见模型价目（元 / 百万 token），仅为估算，实际以官方账单为准。
// 官方是「峰谷定价」：闲时是高峰的一半，这里按**闲时价**填（直播大多在闲时）。
// deepseek-flash = V4.1 Flash，deepseek-v4-pro = V4 Pro。
const DEFAULT_PRICING = {
  'deepseek-flash': { input: 1.1, output: 4.3 },
  'deepseek-v4-pro': { input: 4.7, output: 14.3 },
  // 旧名字（官方已停用，请求会被路由到 flash）：保留是为了老配置还能算出个数
  'deepseek-chat': { input: 1.1, output: 4.3 },
  'deepseek-reasoner': { input: 1.1, output: 4.3 }
};
const FALLBACK_PRICING = { input: 1.1, output: 4.3 };

function todayKey(date = new Date()) {
  const d = date;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function priceOf(model, pricing) {
  const table = pricing && typeof pricing === 'object' && Object.keys(pricing).length ? pricing : DEFAULT_PRICING;
  const key = String(model || '').trim();
  if (table[key]) return table[key];
  const lower = key.toLowerCase();
  for (const [name, value] of Object.entries(table)) {
    if (lower.startsWith(name.toLowerCase())) return value;
  }
  return FALLBACK_PRICING;
}

/** 按千分位显示 token 数 */
function formatTokens(value) {
  return Number(value || 0).toLocaleString('zh-CN');
}

function formatMoney(value) {
  const number = Number(value || 0);
  if (number === 0) return '0';
  if (number < 0.01) return number.toFixed(4);
  if (number < 1) return number.toFixed(3);
  return number.toFixed(2);
}

class UsageTracker {
  constructor({ store, logger, file }) {
    this.store = store;
    this.logger = logger;
    this.file = file;
    this.data = this.load();
    this.session = { calls: 0, prompt: 0, completion: 0, cost: 0, failed: 0 };
    this.saveTimer = null;
  }

  load() {
    const empty = { version: 1, days: {} };
    try {
      if (!fs.existsSync(this.file)) return empty;
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || typeof parsed.days !== 'object') return empty;
      return { version: 1, days: parsed.days || {} };
    } catch (error) {
      this.logger && this.logger.warn && this.logger.warn(`用量记录读取失败，将重新开始统计: ${error.message}`);
      return empty;
    }
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 2000);
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (error) {
      this.logger && this.logger.warn && this.logger.warn(`用量记录写入失败: ${error.message}`);
    }
  }

  pricing() {
    const settings = this.store && this.store.get ? this.store.get() : {};
    return (settings.logging && settings.logging.pricing) || null;
  }

  /**
   * 记一次成功调用
   * @param {{model?:string, usage?:{prompt_tokens?:number,completion_tokens?:number,total_tokens?:number}}} result
   */
  recordSuccess(result) {
    const usage = (result && result.usage) || {};
    const prompt = Number(usage.prompt_tokens) || 0;
    const completion = Number(usage.completion_tokens) || 0;
    // 开了思考模式之后，输出里有相当一部分是「思考内容」。单独记一份，
    // 界面上显示「这次回复花了多少思考 token」，方便主播自己权衡档位。
    const reasoning = Number((usage.completion_tokens_details || {}).reasoning_tokens) || 0;
    const model = String((result && result.model) || 'unknown');
    const price = priceOf(model, this.pricing());
    const cost = (prompt * price.input + completion * price.output) / 1e6;

    const day = todayKey();
    if (!this.data.days[day]) this.data.days[day] = {};
    if (!this.data.days[day][model]) {
      this.data.days[day][model] = { calls: 0, prompt: 0, completion: 0, cost: 0 };
    }
    const bucket = this.data.days[day][model];
    bucket.calls += 1;
    bucket.prompt += prompt;
    bucket.completion += completion;
    bucket.cost = Number((bucket.cost + cost).toFixed(6));

    this.session.calls += 1;
    this.session.prompt += prompt;
    this.session.completion += completion;
    this.session.cost = Number((this.session.cost + cost).toFixed(6));

    this.scheduleSave();
    return { prompt, completion, reasoning, total: prompt + completion, cost, model };
  }

  /** 记一次失败调用（费用为 0，但要能看出失败次数） */
  recordFailure() {
    this.session.failed += 1;
    const day = todayKey();
    if (!this.data.days[day]) this.data.days[day] = {};
    if (!this.data.days[day]['(失败)']) this.data.days[day]['(失败)'] = { calls: 0, prompt: 0, completion: 0, cost: 0 };
    this.data.days[day]['(失败)'].calls += 1;
    this.scheduleSave();
  }

  /** 给界面用的汇总 */
  summary() {
    const days = Object.keys(this.data.days).sort();
    const today = this.data.days[todayKey()] || {};
    const sumOf = (bucket) =>
      Object.values(bucket).reduce(
        (acc, item) => ({
          calls: acc.calls + (item.calls || 0),
          prompt: acc.prompt + (item.prompt || 0),
          completion: acc.completion + (item.completion || 0),
          cost: acc.cost + (item.cost || 0)
        }),
        { calls: 0, prompt: 0, completion: 0, cost: 0 }
      );

    const todaySum = sumOf(today);
    const totalSum = days.reduce(
      (acc, day) => {
        const item = sumOf(this.data.days[day] || {});
        return {
          calls: acc.calls + item.calls,
          prompt: acc.prompt + item.prompt,
          completion: acc.completion + item.completion,
          cost: acc.cost + item.cost
        };
      },
      { calls: 0, prompt: 0, completion: 0, cost: 0 }
    );

    return {
      today: {
        ...todaySum,
        costText: formatMoney(todaySum.cost),
        tokensText: formatTokens(todaySum.prompt + todaySum.completion)
      },
      total: {
        ...totalSum,
        days: days.length,
        costText: formatMoney(totalSum.cost),
        tokensText: formatTokens(totalSum.prompt + totalSum.completion)
      },
      session: {
        ...this.session,
        costText: formatMoney(this.session.cost),
        tokensText: formatTokens(this.session.prompt + this.session.completion)
      },
      recentDays: days
        .slice(-7)
        .reverse()
        .map((day) => {
          const item = sumOf(this.data.days[day] || {});
          return { day, calls: item.calls, tokens: item.prompt + item.completion, costText: formatMoney(item.cost) };
        })
    };
  }

  /** 清空统计（今日 / 全部） */
  reset(scope = 'all') {
    if (scope === 'today') delete this.data.days[todayKey()];
    else this.data.days = {};
    this.session = { calls: 0, prompt: 0, completion: 0, cost: 0, failed: 0 };
    this.save();
    return this.summary();
  }
}

module.exports = { UsageTracker, DEFAULT_PRICING, priceOf, todayKey, formatMoney, formatTokens };
