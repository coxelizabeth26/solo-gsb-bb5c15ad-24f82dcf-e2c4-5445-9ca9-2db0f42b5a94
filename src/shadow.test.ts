import { describe, expect, it } from 'vitest';
import {
  analyzeShadowing,
  hostCovers,
  methodCovers,
  pathCovers,
  queryCovers,
  ruleCovers,
} from './shadow';
import type { Rule } from './types';

function rule(partial: Partial<Rule> & { id: string }): Rule {
  return {
    name: partial.id,
    enabled: true,
    method: 'ANY',
    host: 'example.com',
    pathTemplate: '/',
    query: [],
    action: { type: 'rewrite', target: '/', status: 302 },
    ...partial,
  };
}

describe('methodCovers', () => {
  it('ANY 覆盖具体方法与 ANY', () => {
    expect(methodCovers('ANY', 'GET')).toBe(true);
    expect(methodCovers('ANY', 'DELETE')).toBe(true);
    expect(methodCovers('ANY', 'ANY')).toBe(true);
  });

  it('具体方法仅覆盖相同方法', () => {
    expect(methodCovers('GET', 'GET')).toBe(true);
    expect(methodCovers('GET', 'POST')).toBe(false);
    expect(methodCovers('GET', 'ANY')).toBe(false);
  });
});

describe('hostCovers', () => {
  it('* 覆盖任意主机模式', () => {
    expect(hostCovers('*', 'example.com')).toBe(true);
    expect(hostCovers('*', '*.example.com')).toBe(true);
    expect(hostCovers('*', '*')).toBe(true);
  });

  it('*.example.com 只覆盖其至少一级子域', () => {
    expect(hostCovers('*.example.com', 'a.example.com')).toBe(true);
    expect(hostCovers('*.example.com', 'a.b.example.com')).toBe(true);
    expect(hostCovers('*.example.com', '*.example.com')).toBe(true);
    expect(hostCovers('*.example.com', '*.sub.example.com')).toBe(true);
    // 裸域与无关域不在覆盖范围
    expect(hostCovers('*.example.com', 'example.com')).toBe(false);
    expect(hostCovers('*.example.com', 'notexample.com')).toBe(false);
    expect(hostCovers('*.example.com', '*')).toBe(false);
    expect(hostCovers('*.example.com', '*.other.com')).toBe(false);
  });

  it('反向不成立：更具体的通配覆盖不了更宽的通配', () => {
    expect(hostCovers('*.sub.example.com', '*.example.com')).toBe(false);
    expect(hostCovers('*.sub.example.com', 'a.example.com')).toBe(false);
    expect(hostCovers('*.sub.example.com', 'a.sub.example.com')).toBe(true);
  });

  it('具体主机仅覆盖相同主机（忽略大小写与首尾空白）', () => {
    expect(hostCovers('Example.com', 'example.com')).toBe(true);
    expect(hostCovers(' example.com ', 'EXAMPLE.com')).toBe(true);
    expect(hostCovers('example.com', 'a.example.com')).toBe(false);
    expect(hostCovers('example.com', '*.example.com')).toBe(false);
    expect(hostCovers('example.com', '*')).toBe(false);
  });

  it('空主机模式不参与遮蔽判定', () => {
    expect(hostCovers('', 'example.com')).toBe(false);
    expect(hostCovers('*', '')).toBe(false);
    expect(hostCovers('', '')).toBe(false);
  });
});

describe('pathCovers', () => {
  it('空值或 * 覆盖任意路径', () => {
    expect(pathCovers('', '/users/42')).toBe(true);
    expect(pathCovers('*', '/users/42')).toBe(true);
    expect(pathCovers('', '')).toBe(true);
    expect(pathCovers('*', '*')).toBe(true);
  });

  it('具体模板覆盖不了「任意路径」', () => {
    expect(pathCovers('/users/:id', '')).toBe(false);
    expect(pathCovers('/users/:id', '*')).toBe(false);
  });

  it('参数段覆盖同位任意单段', () => {
    expect(pathCovers('/users/:id', '/users/42')).toBe(true);
    expect(pathCovers('/users/:id', '/users/:name')).toBe(true);
    expect(pathCovers('/:a/:b', '/x/y')).toBe(true);
  });

  it('字面段仅覆盖相同字面值', () => {
    expect(pathCovers('/users/list', '/users/list')).toBe(true);
    expect(pathCovers('/users/list', '/users/detail')).toBe(false);
    // 字面段覆盖不了参数段（参数段可匹配任意单段）
    expect(pathCovers('/users/list', '/users/:id')).toBe(false);
  });

  it('段数必须一致', () => {
    expect(pathCovers('/users/:id', '/users/42/extra')).toBe(false);
    expect(pathCovers('/users/:id/extra', '/users/42')).toBe(false);
  });

  it('忽略空段差异，字面值比较对百分号编码宽容', () => {
    expect(pathCovers('/users/', '/users')).toBe(true);
    expect(pathCovers('/a%20b', '/a b')).toBe(true);
    expect(pathCovers('/', '/')).toBe(true);
  });

  it('含空名参数段的模板永不命中，不参与覆盖', () => {
    expect(pathCovers('/:/x', '/a/x')).toBe(false);
    expect(pathCovers('/a/x', '/:/x')).toBe(false);
  });
});

describe('queryCovers', () => {
  const q = (name: string, op: 'exists' | 'absent' | 'equals', value = '') => ({
    name,
    op,
    value,
  });

  it('空条件集覆盖任意条件集（含空）', () => {
    expect(queryCovers([], [])).toBe(true);
    expect(queryCovers([], [q('debug', 'equals', '1')])).toBe(true);
    expect(queryCovers([], [q('a', 'exists'), q('b', 'absent')])).toBe(true);
  });

  it('有条件集覆盖不了空条件集', () => {
    expect(queryCovers([q('debug', 'exists')], [])).toBe(false);
    expect(queryCovers([q('debug', 'absent')], [])).toBe(false);
  });

  it('exists 被 exists 或 equals 蕴含（值等于蕴含存在）', () => {
    expect(queryCovers([q('a', 'exists')], [q('a', 'exists')])).toBe(true);
    expect(queryCovers([q('a', 'exists')], [q('a', 'equals', '1')])).toBe(true);
    expect(queryCovers([q('a', 'exists')], [q('a', 'absent')])).toBe(false);
    expect(queryCovers([q('a', 'exists')], [q('b', 'equals', '1')])).toBe(false);
  });

  it('absent 仅被 absent 蕴含', () => {
    expect(queryCovers([q('a', 'absent')], [q('a', 'absent')])).toBe(true);
    expect(queryCovers([q('a', 'absent')], [q('a', 'exists')])).toBe(false);
    expect(queryCovers([q('a', 'absent')], [q('a', 'equals', '1')])).toBe(false);
  });

  it('equals 仅被同值 equals 蕴含', () => {
    expect(queryCovers([q('a', 'equals', '1')], [q('a', 'equals', '1')])).toBe(true);
    expect(queryCovers([q('a', 'equals', '1')], [q('a', 'equals', '2')])).toBe(false);
    expect(queryCovers([q('a', 'equals', '1')], [q('a', 'exists')])).toBe(false);
    expect(queryCovers([q('a', 'equals', '1')], [q('a', 'absent')])).toBe(false);
  });

  it('参数名按精确值比较（大小写敏感）', () => {
    expect(queryCovers([q('Debug', 'exists')], [q('debug', 'exists')])).toBe(false);
  });

  it('多条条件逐条蕴含：upper 的每条都要被 lower 覆盖', () => {
    const upper = [q('a', 'exists'), q('b', 'equals', '1')];
    expect(queryCovers(upper, [q('a', 'equals', 'x'), q('b', 'equals', '1')])).toBe(true);
    expect(queryCovers(upper, [q('a', 'exists')])).toBe(false);
    expect(queryCovers(upper, [q('a', 'exists'), q('b', 'equals', '2')])).toBe(false);
  });
});

describe('ruleCovers', () => {
  it('三项同时覆盖才算完整覆盖', () => {
    const upper = rule({ id: 'u', method: 'ANY', host: '*', pathTemplate: '' });
    const lower = rule({
      id: 'l',
      method: 'GET',
      host: 'api.example.com',
      pathTemplate: '/v1/users/:id',
    });
    expect(ruleCovers(upper, lower)).toBe(true);
  });

  it('任一维度不覆盖即不构成完整覆盖', () => {
    const lower = rule({
      id: 'l',
      method: 'GET',
      host: 'api.example.com',
      pathTemplate: '/v1/users/:id',
    });
    expect(
      ruleCovers(rule({ id: 'u', method: 'POST', host: '*', pathTemplate: '' }), lower),
    ).toBe(false);
    expect(
      ruleCovers(
        rule({ id: 'u', method: 'ANY', host: 'other.com', pathTemplate: '' }),
        lower,
      ),
    ).toBe(false);
    expect(
      ruleCovers(
        rule({ id: 'u', method: 'ANY', host: '*', pathTemplate: '/v1/users' }),
        lower,
      ),
    ).toBe(false);
  });

  it('查询维度：upper 无条件覆盖 lower 有条件，反之不成立', () => {
    const lower = rule({
      id: 'l',
      query: [{ name: 'debug', op: 'equals', value: '1' }],
    });
    expect(ruleCovers(rule({ id: 'u' }), lower)).toBe(true);
    expect(ruleCovers(lower, rule({ id: 'u' }))).toBe(false);
  });

  it('查询维度：upper 条件被 lower 蕴含才算覆盖', () => {
    const lower = rule({
      id: 'l',
      query: [{ name: 'debug', op: 'equals', value: '1' }],
    });
    // exists 被 equals 蕴含
    expect(
      ruleCovers(
        rule({ id: 'u', query: [{ name: 'debug', op: 'exists', value: '' }] }),
        lower,
      ),
    ).toBe(true);
    // equals 需要同值
    expect(
      ruleCovers(
        rule({ id: 'u', query: [{ name: 'debug', op: 'equals', value: '2' }] }),
        lower,
      ),
    ).toBe(false);
  });
});

describe('analyzeShadowing', () => {
  it('完全相同的规则：后者被前者遮蔽，报告首个遮蔽者与四项依据', () => {
    const rules = [
      rule({ id: 'r1', name: '旧接口', method: 'GET', host: 'api.example.com', pathTemplate: '/users/:id' }),
      rule({ id: 'r2', name: '旧接口副本', method: 'GET', host: 'api.example.com', pathTemplate: '/users/:id' }),
    ];
    const reports = analyzeShadowing(rules);
    expect(reports).toHaveLength(1);
    const r = reports[0];
    expect(r.ruleId).toBe('r2');
    expect(r.ruleIndex).toBe(1);
    expect(r.byRuleId).toBe('r1');
    expect(r.byRuleIndex).toBe(0);
    expect(r.byRuleName).toBe('旧接口');
    expect(r.basis.method).toEqual({ upper: 'GET', lower: 'GET' });
    expect(r.basis.host).toEqual({ upper: 'api.example.com', lower: 'api.example.com' });
    expect(r.basis.path).toEqual({ upper: '/users/:id', lower: '/users/:id' });
    expect(r.basis.query).toEqual({ upper: [], lower: [] });
  });

  it('更宽的在前规则遮蔽更窄的在后规则（ANY / * / 空路径）', () => {
    const rules = [
      rule({ id: 'wide', method: 'ANY', host: '*', pathTemplate: '' }),
      rule({ id: 'narrow', method: 'POST', host: 'api.example.com', pathTemplate: '/v1/:id' }),
    ];
    const reports = analyzeShadowing(rules);
    expect(reports.map((r) => r.ruleId)).toEqual(['narrow']);
    expect(reports[0].byRuleId).toBe('wide');
  });

  it('部分交集不告警：主机覆盖但路径不覆盖', () => {
    const rules = [
      rule({ id: 'r1', host: 'api.example.com', pathTemplate: '/v1/users' }),
      rule({ id: 'r2', host: 'api.example.com', pathTemplate: '/v1/users/:id' }),
    ];
    expect(analyzeShadowing(rules)).toEqual([]);
  });

  it('部分交集不告警：路径覆盖但方法不同', () => {
    const rules = [
      rule({ id: 'r1', method: 'GET', pathTemplate: '/users/:id' }),
      rule({ id: 'r2', method: 'POST', pathTemplate: '/users/42' }),
    ];
    expect(analyzeShadowing(rules)).toEqual([]);
  });

  it('禁用规则不参与分析：既不遮蔽别人，也不被诊断', () => {
    const rules = [
      rule({ id: 'off-wide', enabled: false, host: '*', pathTemplate: '' }),
      rule({ id: 'r2', host: 'api.example.com', pathTemplate: '/a' }),
      rule({ id: 'off-copy', enabled: false, host: 'api.example.com', pathTemplate: '/a' }),
    ];
    expect(analyzeShadowing(rules)).toEqual([]);
  });

  it('多条在前规则都能遮蔽时，只报告首个', () => {
    const rules = [
      rule({ id: 'first', host: 'example.com', pathTemplate: '/a/:x' }),
      rule({ id: 'second', host: 'example.com', pathTemplate: '/a/:y' }),
      rule({ id: 'victim', host: 'example.com', pathTemplate: '/a/1' }),
    ];
    const reports = analyzeShadowing(rules);
    expect(reports).toHaveLength(2); // second 被 first 遮蔽，victim 被 first 遮蔽
    expect(reports.find((r) => r.ruleId === 'victim')?.byRuleId).toBe('first');
    expect(reports.find((r) => r.ruleId === 'second')?.byRuleId).toBe('first');
  });

  it('调整顺序后诊断随之变化：窄规则在前则宽规则不被遮蔽', () => {
    const narrowFirst = [
      rule({ id: 'narrow', method: 'GET', host: 'api.example.com', pathTemplate: '/a' }),
      rule({ id: 'wide', method: 'ANY', host: '*', pathTemplate: '' }),
    ];
    expect(analyzeShadowing(narrowFirst)).toEqual([]);
    const wideFirst = [narrowFirst[1], narrowFirst[0]];
    expect(analyzeShadowing(wideFirst).map((r) => r.ruleId)).toEqual(['narrow']);
  });

  it('被遮蔽规则之后仍可遮蔽更窄的规则（链式）', () => {
    const rules = [
      rule({ id: 'r1', host: '*', pathTemplate: '' }),
      rule({ id: 'r2', host: 'example.com', pathTemplate: '/a/:x' }),
      rule({ id: 'r3', host: 'example.com', pathTemplate: '/a/1' }),
    ];
    const reports = analyzeShadowing(rules);
    expect(reports.map((r) => r.ruleId)).toEqual(['r2', 'r3']);
    expect(reports[1].byRuleId).toBe('r1'); // 首个遮蔽者仍是最前的 r1
  });

  it('空主机规则匹配不到请求，不标记为被遮蔽', () => {
    const rules = [
      rule({ id: 'wide', host: '*', pathTemplate: '' }),
      rule({ id: 'empty-host', host: '', pathTemplate: '/a' }),
    ];
    expect(analyzeShadowing(rules)).toEqual([]);
  });

  it('分析不修改规则表（纯函数）', () => {
    const rules = [
      rule({ id: 'r1', host: '*', pathTemplate: '' }),
      rule({ id: 'r2', host: 'a.com', pathTemplate: '/x' }),
    ];
    const snapshot = JSON.stringify(rules);
    analyzeShadowing(rules);
    expect(JSON.stringify(rules)).toBe(snapshot);
  });

  it('查询维度：无条件的在前规则遮蔽有条件的同路径规则，依据含查询', () => {
    const rules = [
      rule({ id: 'general', host: 'api.example.com', pathTemplate: '/users/:id' }),
      rule({
        id: 'gray',
        host: 'api.example.com',
        pathTemplate: '/users/:id',
        query: [{ name: 'debug', op: 'equals', value: '1' }],
      }),
    ];
    const reports = analyzeShadowing(rules);
    expect(reports.map((r) => r.ruleId)).toEqual(['gray']);
    expect(reports[0].byRuleId).toBe('general');
    expect(reports[0].basis.query).toEqual({
      upper: [],
      lower: [{ name: 'debug', op: 'equals', value: '1' }],
    });
  });

  it('查询维度：条件规则在前不遮蔽无条件的通用规则', () => {
    const rules = [
      rule({
        id: 'gray',
        host: 'api.example.com',
        pathTemplate: '/users/:id',
        query: [{ name: 'debug', op: 'equals', value: '1' }],
      }),
      rule({ id: 'general', host: 'api.example.com', pathTemplate: '/users/:id' }),
    ];
    expect(analyzeShadowing(rules)).toEqual([]);
  });

  it('查询维度：更宽的条件遮蔽更窄的条件（exists 覆盖 equals）', () => {
    const rules = [
      rule({
        id: 'has-debug',
        query: [{ name: 'debug', op: 'exists', value: '' }],
      }),
      rule({
        id: 'debug-1',
        query: [{ name: 'debug', op: 'equals', value: '1' }],
      }),
    ];
    const reports = analyzeShadowing(rules);
    expect(reports.map((r) => r.ruleId)).toEqual(['debug-1']);
    expect(reports[0].byRuleId).toBe('has-debug');
  });

  it('查询维度：equals 值不同或条件更宽时不构成遮蔽', () => {
    const rules = [
      rule({ id: 'debug-1', query: [{ name: 'debug', op: 'equals', value: '1' }] }),
      rule({ id: 'debug-2', query: [{ name: 'debug', op: 'equals', value: '2' }] }),
      rule({ id: 'has-debug', query: [{ name: 'debug', op: 'exists', value: '' }] }),
    ];
    // debug-1 只覆盖同值；has-debug 比 debug-1 更宽，均不被遮蔽
    expect(analyzeShadowing(rules)).toEqual([]);
  });

  it('查询维度：absent 与 exists 互不覆盖', () => {
    const rules = [
      rule({ id: 'no-debug', query: [{ name: 'debug', op: 'absent', value: '' }] }),
      rule({ id: 'has-debug', query: [{ name: 'debug', op: 'exists', value: '' }] }),
    ];
    expect(analyzeShadowing(rules)).toEqual([]);
    expect(analyzeShadowing([rules[1], rules[0]])).toEqual([]);
  });
});
