import type { Rule } from './types';
import { METHOD_MATCHERS, QUERY_OPS, REDIRECT_STATUSES } from './types';
import template from './bundle-template.mjs?raw';

/** 模板中规则数据的占位符 */
const RULES_PLACEHOLDER = '__RULES__';

/** 导出前发现的不合法规则（仅针对会进入生成物的已启用规则） */
export interface BundleIssue {
  /** 规则在规则表中的下标（从 0 计，含未启用规则的原始顺序） */
  index: number;
  ruleId: string;
  ruleName: string;
  message: string;
}

/**
 * 校验待导出的已启用规则，返回问题列表（空数组表示可以导出）。
 * 未启用的规则不进入生成物，不参与校验。
 * 每条问题都带规则在规则表中的位置，便于界面定位。
 */
export function findBundleIssues(rules: Rule[]): BundleIssue[] {
  const issues: BundleIssue[] = [];
  rules.forEach((rule, index) => {
    if (!rule.enabled) return;
    const push = (message: string) =>
      issues.push({ index, ruleId: rule.id, ruleName: rule.name, message });

    if (!(METHOD_MATCHERS as readonly string[]).includes(rule.method)) {
      push(`method「${rule.method}」必须是 ${METHOD_MATCHERS.join(' / ')} 之一`);
    }

    const host = rule.host.trim();
    if (host === '') {
      push('host 不能为空（空主机永不命中，导出后是无效规则）');
    } else if (host.startsWith('*.') && host.slice(2).trim() === '') {
      push('host 通配符「*.」后缺少域名');
    }

    // 路径模板：`:name` 参数段必须有名字，否则该段永不命中
    const segments = rule.pathTemplate.split('/').filter((s) => s !== '');
    if (segments.some((seg) => seg.startsWith(':') && seg.slice(1) === '')) {
      push(`pathTemplate「${rule.pathTemplate}」含有无名参数段「:」`);
    }

    // 查询条件：参数名非空、操作符合法、equals 必须有字符串值；同一规则内参数名不得重复
    const firstSeen = new Map<string, number>();
    (rule.query ?? []).forEach((cond, j) => {
      const atCond = `query 第 ${j + 1} 个条件`;
      if (typeof cond.name !== 'string' || cond.name.trim() === '') {
        push(`${atCond}的参数名不能为空`);
        return;
      }
      if (!(QUERY_OPS as readonly string[]).includes(cond.op)) {
        push(`${atCond}的 op「${cond.op}」必须是 ${QUERY_OPS.join(' / ')} 之一`);
      }
      if (cond.op === 'equals' && typeof cond.value !== 'string') {
        push(`${atCond}（equals）的 value 必须是字符串`);
      }
      const first = firstSeen.get(cond.name);
      if (first !== undefined) {
        push(`查询条件参数名「${cond.name}」重复（第 ${first + 1} 个与第 ${j + 1} 个条件）`);
      } else {
        firstSeen.set(cond.name, j);
      }
    });

    const { type, target, status } = rule.action;
    if (type !== 'rewrite' && type !== 'redirect' && type !== 'stop') {
      push(`action.type「${type}」必须是 rewrite / redirect / stop 之一`);
    } else {
      if (type !== 'stop' && target.trim() === '') {
        push('action.target 不能为空（rewrite / redirect 需要目标）');
      }
      if (type === 'redirect' && !(REDIRECT_STATUSES as readonly number[]).includes(status)) {
        push(`action.status「${status}」必须是 ${REDIRECT_STATUSES.join(' / ')} 之一`);
      }
    }
  });
  return issues;
}

/**
 * 把当前已启用规则生成单个自包含的 route-bundle.mjs 源码：
 * 模板内嵌完整引擎与规则数据，不依赖项目源码与第三方包。
 */
export function generateBundle(rules: Rule[]): string {
  if (!template.includes(RULES_PLACEHOLDER)) {
    throw new Error('路由器模板缺少规则占位符');
  }
  const enabled = rules.filter((r) => r.enabled);
  const data = JSON.stringify(enabled, null, 2);
  // 用函数替换，避免规则内容中的 `$&` 等序列被当作替换模式
  return template.replace(RULES_PLACEHOLDER, () => data);
}
