import type { Rule } from './types';
import { METHOD_MATCHERS, REDIRECT_STATUSES } from './types';

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 校验并规范化导入的规则 JSON。
 * 字段缺失时给出合理默认值，类型错误时抛出带位置信息的中文错误。
 */
export function validateRules(data: unknown): Rule[] {
  if (!Array.isArray(data)) {
    throw new Error('JSON 顶层必须是规则数组');
  }
  return data.map((raw, i) => {
    const at = `第 ${i + 1} 条规则`;
    if (!isRecord(raw)) throw new Error(`${at}不是对象`);

    const method = raw.method ?? 'ANY';
    if (
      typeof method !== 'string' ||
      !(METHOD_MATCHERS as readonly string[]).includes(method)
    ) {
      throw new Error(`${at}的 method 必须是 ${METHOD_MATCHERS.join(' / ')} 之一`);
    }

    if (raw.host !== undefined && typeof raw.host !== 'string') {
      throw new Error(`${at}的 host 必须是字符串`);
    }
    if (raw.pathTemplate !== undefined && typeof raw.pathTemplate !== 'string') {
      throw new Error(`${at}的 pathTemplate 必须是字符串`);
    }

    const rawAction = raw.action ?? {};
    if (!isRecord(rawAction)) throw new Error(`${at}的 action 必须是对象`);
    const type = rawAction.type ?? 'rewrite';
    if (type !== 'rewrite' && type !== 'redirect' && type !== 'stop') {
      throw new Error(`${at}的 action.type 必须是 rewrite / redirect / stop 之一`);
    }
    const target = rawAction.target ?? '';
    if (typeof target !== 'string') throw new Error(`${at}的 action.target 必须是字符串`);
    if (type !== 'stop' && target.trim() === '') {
      throw new Error(`${at}的 action.target 不能为空（rewrite / redirect 需要目标）`);
    }
    const status = rawAction.status ?? 302;
    if (
      typeof status !== 'number' ||
      !(REDIRECT_STATUSES as readonly number[]).includes(status)
    ) {
      throw new Error(
        `${at}的 action.status 必须是 ${REDIRECT_STATUSES.join(' / ')} 之一`,
      );
    }

    return {
      id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : uid(),
      name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : `规则 ${i + 1}`,
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
      method: method as Rule['method'],
      host: typeof raw.host === 'string' ? raw.host : '',
      pathTemplate: typeof raw.pathTemplate === 'string' ? raw.pathTemplate : '',
      action: { type, target, status },
    };
  });
}
