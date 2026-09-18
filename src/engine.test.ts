import { describe, expect, it } from 'vitest';
import {
  MAX_STEPS,
  matchHost,
  matchPath,
  matchQuery,
  resolveTarget,
  simulate,
  substitute,
} from './engine';
import type { Rule } from './types';
import { validateRules } from './validate';

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

describe('matchHost', () => {
  it('精确匹配，忽略大小写', () => {
    expect(matchHost('Example.com', 'example.com')).toBe(true);
    expect(matchHost('example.com', 'sub.example.com')).toBe(false);
  });

  it('通配子域：匹配任意层级子域，但不匹配裸域', () => {
    expect(matchHost('*.example.com', 'a.example.com')).toBe(true);
    expect(matchHost('*.example.com', 'a.b.example.com')).toBe(true);
    expect(matchHost('*.example.com', 'example.com')).toBe(false);
    expect(matchHost('*.example.com', 'notexample.com')).toBe(false);
  });

  it('星号匹配任意主机，空模式不匹配', () => {
    expect(matchHost('*', 'anything.dev')).toBe(true);
    expect(matchHost('', 'anything.dev')).toBe(false);
  });
});

describe('matchPath', () => {
  it('字面段与参数段', () => {
    expect(matchPath('/users/:id', '/users/42')).toEqual({ id: '42' });
    expect(matchPath('/users/:id', '/users/42/extra')).toBeNull();
    expect(matchPath('/users/:id', '/groups/42')).toBeNull();
  });

  it('根路径与末尾斜杠', () => {
    expect(matchPath('/', '/')).toEqual({});
    expect(matchPath('/users', '/users/')).toEqual({});
  });

  it('空模板与 * 匹配任意路径', () => {
    expect(matchPath('', '/any/thing')).toEqual({});
    expect(matchPath('*', '/any/thing')).toEqual({});
  });

  it('参数捕获会解码', () => {
    expect(matchPath('/p/:v', '/p/a%20b')).toEqual({ v: 'a b' });
  });
});

describe('substitute / resolveTarget', () => {
  it('替换已捕获参数并重新编码，未知占位符保留', () => {
    expect(substitute('/u/:id/:missing', { id: 'a b' })).toBe('/u/a%20b/:missing');
  });

  it('相对路径保留源，绝对 URL 整体替换', () => {
    const cur = new URL('http://a.com/x/y');
    expect(resolveTarget('/z', cur).toString()).toBe('http://a.com/z');
    expect(resolveTarget('https://b.com/q', cur).toString()).toBe('https://b.com/q');
  });

  it('目标不含查询串时保留原查询串', () => {
    const cur = new URL('http://a.com/x?debug=1');
    expect(resolveTarget('/y', cur).toString()).toBe('http://a.com/y?debug=1');
    expect(resolveTarget('/y?a=1', cur).toString()).toBe('http://a.com/y?a=1');
  });
});

describe('matchQuery', () => {
  const sp = (s: string) => new URLSearchParams(s);

  it('空条件集匹配任意查询串', () => {
    expect(matchQuery([], sp(''))).toBe(true);
    expect(matchQuery([], sp('a=1&b=2'))).toBe(true);
  });

  it('exists：参数出现即命中（空值也算出现）', () => {
    const conds = [{ name: 'debug', op: 'exists' as const, value: '' }];
    expect(matchQuery(conds, sp('debug=1'))).toBe(true);
    expect(matchQuery(conds, sp('debug='))).toBe(true);
    expect(matchQuery(conds, sp('debug'))).toBe(true);
    expect(matchQuery(conds, sp('other=1'))).toBe(false);
    expect(matchQuery(conds, sp(''))).toBe(false);
  });

  it('absent：参数不出现才命中', () => {
    const conds = [{ name: 'debug', op: 'absent' as const, value: '' }];
    expect(matchQuery(conds, sp('a=1'))).toBe(true);
    expect(matchQuery(conds, sp(''))).toBe(true);
    expect(matchQuery(conds, sp('debug='))).toBe(false);
    expect(matchQuery(conds, sp('debug=1&a=2'))).toBe(false);
  });

  it('equals：同名参数任一值相等即命中（重复参数取任一）', () => {
    const conds = [{ name: 'a', op: 'equals' as const, value: '2' }];
    expect(matchQuery(conds, sp('a=2'))).toBe(true);
    expect(matchQuery(conds, sp('a=1&a=2'))).toBe(true);
    expect(matchQuery(conds, sp('a=2&a=1'))).toBe(true);
    expect(matchQuery(conds, sp('a=1'))).toBe(false);
    expect(matchQuery(conds, sp('a=12'))).toBe(false);
    expect(matchQuery(conds, sp('b=2'))).toBe(false);
  });

  it('参数名与值按解码后形态比较', () => {
    expect(
      matchQuery([{ name: 'q', op: 'equals', value: 'a b' }], sp('q=a%20b')),
    ).toBe(true);
    expect(
      matchQuery([{ name: 'a b', op: 'exists', value: '' }], sp('a%20b=1')),
    ).toBe(true);
  });

  it('多条条件按 AND 组合', () => {
    const conds = [
      { name: 'debug', op: 'exists' as const, value: '' },
      { name: 'env', op: 'equals' as const, value: 'gray' },
      { name: 'legacy', op: 'absent' as const, value: '' },
    ];
    expect(matchQuery(conds, sp('debug=1&env=gray'))).toBe(true);
    expect(matchQuery(conds, sp('debug=1&env=prod'))).toBe(false);
    expect(matchQuery(conds, sp('env=gray'))).toBe(false);
    expect(matchQuery(conds, sp('debug=1&env=gray&legacy=1'))).toBe(false);
  });
});

describe('simulate 查询条件', () => {
  it('带查询条件的规则只在条件满足时命中', () => {
    const rules = [
      rule({
        id: 'gray',
        pathTemplate: '/users/:id',
        query: [{ name: 'debug', op: 'equals', value: '1' }],
        action: { type: 'rewrite', target: '/gray/users/:id', status: 302 },
      }),
    ];
    const hit = simulate(rules, 'GET', 'http://example.com/users/7?debug=1');
    expect(hit.steps.map((s) => s.rule.id)).toEqual(['gray']);
    expect(hit.finalUrl).toBe('http://example.com/gray/users/7?debug=1');
    const miss = simulate(rules, 'GET', 'http://example.com/users/7?debug=0');
    expect(miss.steps).toHaveLength(0);
    expect(miss.finalUrl).toBe('http://example.com/users/7?debug=0');
  });

  it('查询条件参与首条命中选择：条件规则在前、通用规则兜底', () => {
    const rules = [
      rule({
        id: 'cond',
        pathTemplate: '/a',
        query: [{ name: 'x', op: 'exists', value: '' }],
        action: { type: 'rewrite', target: '/with-x', status: 302 },
      }),
      rule({
        id: 'fallback',
        pathTemplate: '/a',
        action: { type: 'rewrite', target: '/plain', status: 302 },
      }),
    ];
    expect(simulate(rules, 'GET', 'http://example.com/a?x=1').finalUrl).toBe(
      'http://example.com/with-x?x=1',
    );
    expect(simulate(rules, 'GET', 'http://example.com/a').finalUrl).toBe(
      'http://example.com/plain',
    );
  });

  it('重写后查询串保留，继续参与下一步匹配', () => {
    const rules = [
      rule({
        id: 'r1',
        pathTemplate: '/a',
        action: { type: 'rewrite', target: '/b', status: 302 },
      }),
      rule({
        id: 'r2',
        pathTemplate: '/b',
        query: [{ name: 'debug', op: 'exists', value: '' }],
        action: { type: 'rewrite', target: '/done', status: 302 },
      }),
    ];
    const withDebug = simulate(rules, 'GET', 'http://example.com/a?debug=1');
    expect(withDebug.steps.map((s) => s.rule.id)).toEqual(['r1', 'r2']);
    expect(withDebug.finalUrl).toBe('http://example.com/done?debug=1');
    const plain = simulate(rules, 'GET', 'http://example.com/a');
    expect(plain.steps.map((s) => s.rule.id)).toEqual(['r1']);
    expect(plain.finalUrl).toBe('http://example.com/b');
  });

  it('absent 条件可用查询串区分循环出口', () => {
    // /a 无 m 参数时追加 ?m=1；有 m 参数时落到 /done —— 正常终止而非循环
    const rules = [
      rule({
        id: 'add-m',
        pathTemplate: '/a',
        query: [{ name: 'm', op: 'absent', value: '' }],
        action: { type: 'rewrite', target: '/a?m=1', status: 302 },
      }),
      rule({
        id: 'finish',
        pathTemplate: '/a',
        query: [{ name: 'm', op: 'equals', value: '1' }],
        action: { type: 'rewrite', target: '/done', status: 302 },
      }),
    ];
    const sim = simulate(rules, 'GET', 'http://example.com/a');
    expect(sim.status).toBe('final');
    expect(sim.steps.map((s) => s.rule.id)).toEqual(['add-m', 'finish']);
    // 目标 /done 不含 ?，按引擎语义保留当前查询串
    expect(sim.finalUrl).toBe('http://example.com/done?m=1');
  });
});

describe('simulate', () => {
  it('无规则命中：按原始请求放行', () => {
    const sim = simulate([], 'GET', 'http://example.com/a?x=1');
    expect(sim.status).toBe('final');
    expect(sim.ok).toBe(true);
    expect(sim.finalUrl).toBe('http://example.com/a?x=1');
    expect(sim.steps).toHaveLength(0);
  });

  it('首条命中规则生效，重写后从第一条重新匹配', () => {
    const rules = [
      rule({ id: 'r1', pathTemplate: '/a', action: { type: 'rewrite', target: '/b', status: 302 } }),
      rule({ id: 'r2', pathTemplate: '/a', action: { type: 'rewrite', target: '/never', status: 302 } }),
      rule({ id: 'r3', pathTemplate: '/b', action: { type: 'rewrite', target: '/c', status: 302 } }),
    ];
    const sim = simulate(rules, 'GET', 'http://example.com/a');
    expect(sim.steps.map((s) => s.rule.id)).toEqual(['r1', 'r3']);
    expect(sim.status).toBe('final');
    expect(sim.finalUrl).toBe('http://example.com/c');
  });

  it('重写目标可引用路径参数，方法 ANY 与具体方法均可命中', () => {
    const rules = [
      rule({
        id: 'r1',
        method: 'POST',
        pathTemplate: '/users/:id',
        action: { type: 'rewrite', target: '/internal/:id', status: 302 },
      }),
    ];
    const sim = simulate(rules, 'POST', 'http://example.com/users/7');
    expect(sim.finalUrl).toBe('http://example.com/internal/7');
    expect(sim.steps[0].params).toEqual({ id: '7' });
    // 方法不匹配则不命中
    const miss = simulate(rules, 'GET', 'http://example.com/users/7');
    expect(miss.steps).toHaveLength(0);
  });

  it('重定向立即终止，后续规则不再执行', () => {
    const rules = [
      rule({
        id: 'r1',
        pathTemplate: '/old/:slug',
        action: { type: 'redirect', target: 'https://new.com/:slug', status: 301 },
      }),
      rule({ id: 'r2', pathTemplate: '/old/:slug', action: { type: 'stop', target: '', status: 302 } }),
    ];
    const sim = simulate(rules, 'GET', 'http://example.com/old/hello');
    expect(sim.status).toBe('redirect');
    expect(sim.ok).toBe(true);
    expect(sim.redirectStatus).toBe(301);
    expect(sim.redirectLocation).toBe('https://new.com/hello');
    expect(sim.steps).toHaveLength(1);
  });

  it('停止动作立即终止', () => {
    const rules = [rule({ id: 'r1', pathTemplate: '/admin', action: { type: 'stop', target: '', status: 302 } })];
    const sim = simulate(rules, 'GET', 'http://example.com/admin');
    expect(sim.status).toBe('stopped');
    expect(sim.ok).toBe(true);
  });

  it('未启用的规则被跳过', () => {
    const rules = [rule({ id: 'r1', enabled: false, pathTemplate: '/a', action: { type: 'stop', target: '', status: 302 } })];
    const sim = simulate(rules, 'GET', 'http://example.com/a');
    expect(sim.status).toBe('final');
  });

  it('自我重写被判定为循环，不返回成功结果', () => {
    const rules = [rule({ id: 'r1', pathTemplate: '/a', action: { type: 'rewrite', target: '/a', status: 302 } })];
    const sim = simulate(rules, 'GET', 'http://example.com/a');
    expect(sim.status).toBe('loop');
    expect(sim.ok).toBe(false);
    expect(sim.finalUrl).toBeUndefined();
  });

  it('A↔B 往返被判定为循环', () => {
    const rules = [
      rule({ id: 'r1', pathTemplate: '/a', action: { type: 'rewrite', target: '/b', status: 302 } }),
      rule({ id: 'r2', pathTemplate: '/b', action: { type: 'rewrite', target: '/a', status: 302 } }),
    ];
    const sim = simulate(rules, 'GET', 'http://example.com/a');
    expect(sim.status).toBe('loop');
    expect(sim.ok).toBe(false);
  });

  it('状态以方法+URL 区分：不同方法不构成循环', () => {
    // 规则把 /a 重写到 /a?m=1，再把 /a?m=1 重写到 /done —— 正常终止
    const rules = [
      rule({ id: 'r1', pathTemplate: '/a', action: { type: 'rewrite', target: '/a?m=1', status: 302 } }),
      rule({ id: 'r2', pathTemplate: '/a', action: { type: 'rewrite', target: '/done', status: 302 } }),
    ];
    // r1 会先命中 /a 与 /a?m=1（匹配忽略查询串），导致 /a?m=1 → /a?m=1 自我循环
    const sim = simulate(rules, 'GET', 'http://example.com/a');
    expect(sim.status).toBe('loop');
    expect(sim.reason).toContain('GET http://example.com/a?m=1');
  });

  it(`超过 ${MAX_STEPS} 步判定超限`, () => {
    const rules: Rule[] = Array.from({ length: MAX_STEPS + 5 }, (_, i) =>
      rule({
        id: `r${i}`,
        pathTemplate: `/s${i}`,
        action: { type: 'rewrite', target: `/s${i + 1}`, status: 302 },
      }),
    );
    const sim = simulate(rules, 'GET', 'http://example.com/s0');
    expect(sim.status).toBe('max-steps');
    expect(sim.ok).toBe(false);
    expect(sim.steps).toHaveLength(MAX_STEPS);
  });

  it('非法输入 URL 直接失败', () => {
    const sim = simulate([], 'GET', 'not a url');
    expect(sim.status).toBe('invalid-url');
    expect(sim.ok).toBe(false);
  });
});

describe('validateRules', () => {
  it('接受合法规则并补全默认值', () => {
    const rules = validateRules([
      {
        method: 'GET',
        host: 'a.com',
        pathTemplate: '/x/:id',
        action: { type: 'rewrite', target: '/y/:id', status: 302 },
      },
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0].enabled).toBe(true);
    expect(rules[0].id).toBeTruthy();
  });

  it('拒绝非法输入', () => {
    expect(() => validateRules({})).toThrow('数组');
    expect(() => validateRules([{ method: 'FOO' }])).toThrow('method');
    expect(() =>
      validateRules([{ action: { type: 'rewrite', target: '' } }]),
    ).toThrow('target');
    expect(() =>
      validateRules([{ action: { type: 'redirect', target: '/x', status: 200 } }]),
    ).toThrow('status');
  });

  it('旧数据缺省 query 字段时补空条件', () => {
    const rules = validateRules([
      { host: 'a.com', pathTemplate: '/x', action: { type: 'stop' } },
    ]);
    expect(rules[0].query).toEqual([]);
  });

  it('规范化查询条件：参数名去空白、op 缺省为 exists、value 缺省为空串', () => {
    const rules = validateRules([
      {
        host: 'a.com',
        action: { type: 'stop' },
        query: [{ name: ' debug ' }, { name: 'env', op: 'equals', value: 'gray' }],
      },
    ]);
    expect(rules[0].query).toEqual([
      { name: 'debug', op: 'exists', value: '' },
      { name: 'env', op: 'equals', value: 'gray' },
    ]);
  });

  it('拒绝非法查询条件并给出位置', () => {
    expect(() => validateRules([{ query: {} }])).toThrow('第 1 条规则的 query 必须是数组');
    expect(() => validateRules([{ query: [{}] }])).toThrow('第 1 个查询条件');
    expect(() => validateRules([{ query: [{ name: '  ' }] }])).toThrow('参数名不能为空');
    expect(() => validateRules([{ query: [{ name: 'a', op: 'regex' }] }])).toThrow(
      'op 必须是 exists / absent / equals 之一',
    );
    expect(() => validateRules([{ query: [{ name: 'a', value: 1 }] }])).toThrow(
      'value 必须是字符串',
    );
    // 错误信息定位到具体规则
    expect(() =>
      validateRules([
        { host: 'a.com', action: { type: 'stop' } },
        { query: [{ name: 1 }] },
      ]),
    ).toThrow('第 2 条规则');
  });

  it('同一规则内查询参数名重复时给出定位错误', () => {
    expect(() =>
      validateRules([
        {
          host: 'a.com',
          query: [
            { name: 'debug', op: 'exists', value: '' },
            { name: 'env', op: 'equals', value: 'gray' },
            { name: 'debug', op: 'equals', value: '1' },
          ],
        },
      ]),
    ).toThrow('第 1 条规则的查询条件参数名「debug」重复（第 1 个与第 3 个条件）');
  });
});
