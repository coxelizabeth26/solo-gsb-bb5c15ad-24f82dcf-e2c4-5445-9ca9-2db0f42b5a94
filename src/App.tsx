import { useCallback, useEffect, useState } from 'react';
import type { Rule, Simulation } from './types';
import { simulate } from './engine';
import { validateRules } from './validate';
import { SAMPLE_RULES, PRESETS } from './samples';
import { useRuleHistory } from './useRuleHistory';
import { RulesPanel } from './components/RulesPanel';
import { Simulator } from './components/Simulator';
import { TraceView } from './components/TraceView';
import { RegressionPanel } from './components/RegressionPanel';
import { ShareCreateDialog } from './components/ShareCreateDialog';
import { ShareUnlock } from './components/ShareUnlock';
import {
  cleanLocationUrl,
  parseShareHash,
  type SharePayload,
} from './share';

const STORAGE_KEY = 'url-route-debugger.rules.v1';

function loadRules(): Rule[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return validateRules(JSON.parse(raw));
  } catch {
    // 本地缓存损坏时回退到示例规则
  }
  return structuredClone(SAMPLE_RULES);
}

function readPendingShare(): string | null {
  try {
    return parseShareHash(window.location.hash);
  } catch {
    return null;
  }
}

/** 移除地址栏中的分享 hash（用 replaceState，不新增历史记录） */
function removeShareHash() {
  if (window.location.hash !== '') {
    window.history.replaceState(null, '', cleanLocationUrl());
  }
}

/** 事件目标是否是可编辑控件：此时保留浏览器原生编辑行为，不拦截快捷键 */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el === null) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable
  );
}

export default function App() {
  // 打开分享链接时，整个调试台让位给口令解锁页；任何解密/校验失败都保持当前状态不变
  const [pendingShare, setPendingShare] = useState<string | null>(readPendingShare);
  const [sharing, setSharing] = useState(false);

  const hist = useRuleHistory(loadRules);
  const { rules } = hist;
  const [method, setMethod] = useState(PRESETS[0].method);
  const [url, setUrl] = useState(PRESETS[0].url);
  const [sim, setSim] = useState<Simulation | null>(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
  }, [rules]);

  // 撤销 / 重做恢复的是完整规则快照，旧轨迹引用的是旧快照，因此同时清空当前模拟轨迹
  const undo = useCallback(() => {
    const ok = hist.undo();
    if (ok) setSim(null);
    return ok;
  }, [hist]);
  const redo = useCallback(() => {
    const ok = hist.redo();
    if (ok) setSim(null);
    return ok;
  }, [hist]);

  // Ctrl/Cmd+Z 撤销、Ctrl/Cmd+Shift+Z 重做；焦点在输入控件时交给浏览器原生编辑行为
  useEffect(() => {
    if (pendingShare) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pendingShare, undo, redo]);

  // 监听浏览器前进 / 后退或手工改写 hash 带来的分享链接变化
  useEffect(() => {
    const onHashChange = () => setPendingShare(readPendingShare());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const run = () => setSim(simulate(rules, method, url));

  // 用户在预览页确认：此刻才真正替换状态，同时清空旧轨迹与地址栏 hash。
  // 分享导入相当于换了一份文档，撤销 / 重做分支一并清空。
  const confirmImport = (payload: SharePayload) => {
    hist.reset(payload.rules);
    setMethod(payload.method);
    setUrl(payload.url);
    setSim(null);
    removeShareHash();
    setPendingShare(null);
  };

  // 用户放弃导入：仅移除 hash 回到调试台，当前规则表 / 请求 / 轨迹一概不动
  const abortImport = () => {
    removeShareHash();
    setPendingShare(null);
  };

  // 创建者关闭分享对话框：清掉自己刚写入地址栏的 hash（复制出的链接不受影响）
  const closeShareDialog = () => {
    setSharing(false);
    removeShareHash();
  };

  if (pendingShare) {
    return (
      <ShareUnlock
        fragment={pendingShare}
        onConfirm={confirmImport}
        onAbort={abortImport}
      />
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>URL 路由规则调试台</h1>
        <p>
          编排有序规则（方法 / 主机 / 路径模板 / 查询参数条件 → 重写、重定向或停止），模拟请求逐步追踪命中过程。
          重写后从第一条规则重新匹配；以「方法 + URL」识别循环，最多执行 20 步。
        </p>
      </header>
      <main className="layout">
        <RulesPanel
          history={{ ...hist, undo, redo }}
          onShare={() => setSharing(true)}
        />
        <div className="right-col">
          <Simulator
            method={method}
            url={url}
            onMethodChange={setMethod}
            onUrlChange={setUrl}
            onRun={run}
          />
          {sim && <TraceView sim={sim} />}
        </div>
      </main>
      <RegressionPanel rules={rules} />
      {sharing && (
        <ShareCreateDialog
          rules={rules}
          method={method}
          url={url}
          onClose={closeShareDialog}
        />
      )}
    </div>
  );
}
