import { describe, expect, it } from 'vitest';
import {
  MAX_STEPS,
  matchHost,
  matchPath,
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
});
