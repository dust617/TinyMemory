import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createJiti } from './node_modules/jiti/lib/jiti.mjs';

const extensionDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, '$1:'));
const jiti = createJiti(import.meta.url, { moduleCache: false });

function harness(preloaded = []) {
  const handlers = new Map();
  const tools = new Map(preloaded.map((tool) => [tool.name, tool]));
  const commands = new Map();
  return {
    handlers, tools, commands,
    api: {
      on(name, fn) { const values = handlers.get(name) ?? []; values.push(fn); handlers.set(name, values); },
      registerTool(tool) { tools.set(tool.name, tool); },
      registerCommand(name, command) { commands.set(name, command); },
      getAllTools() { return [...tools.values()]; },
    },
  };
}
function context(cwd, id = 'session-test', trusted = false, branch = [], approved = true) {
  return {
    cwd,
    hasUI: true,
    isProjectTrusted: () => trusted,
    sessionManager: { getSessionId: () => id, getBranch: () => branch, getEntries: () => branch },
    ui: { notify() {}, async confirm() { return approved; } },
  };
}
async function emit(runtime, name, event, ctx) {
  let output;
  for (const fn of runtime.handlers.get(name) ?? []) output = (await fn(event, ctx)) ?? output;
  return output;
}

const root = mkdtempSync(path.join(tmpdir(), 'pi-global-memory-'));
const agentHome = path.join(root, '.agent-home');
process.env.PI_MEMORY_GUARD_HOME = agentHome;
const factory = (await jiti.import(pathToFileURL(path.join(extensionDir, 'index.ts')).href)).default;
try {
  mkdirSync(path.join(root, '.pi', 'memory'), { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(path.join(root, '.pi', 'memory', 'STATUS.md'), `# STATUS\n> Updated: ${date} | Verify-by: ${date}\n\n## 当前状态\nTest active.\n\n## Next Actions\n`, 'utf8');
  writeFileSync(path.join(root, '.pi', 'memory', 'FACTS.md'), '# 稳定事实\n', 'utf8');
  writeFileSync(path.join(root, '.pi', 'memory', 'INBOX.jsonl'), '', 'utf8');

  const runtime = harness();
  factory(runtime.api);
  const ctx = context(root, 'session-a', true);
  await emit(runtime, 'session_start', { reason: 'startup' }, ctx);
  assert.ok(runtime.tools.has('memory-recall'));
  assert.ok(runtime.tools.has('memory-save'));
  assert.ok(runtime.tools.has('memory-review'));
  assert.ok(runtime.tools.has('memory-status'));

  assert.equal(await emit(runtime, 'before_agent_start', { prompt: '你好' }, ctx), undefined);
  const brief = await emit(runtime, 'before_agent_start', { prompt: '继续记忆测试' }, ctx);
  assert.match(brief.message.content, /<project_memory_brief>/);
  assert.ok(brief.message.content.endsWith('</project_memory_brief>'));

  await runtime.tools.get('memory-status').execute('status', { currentState: 'Global memory test is verified.', nextActions: ['Finish validation'], verifyDays: 7 });
  await runtime.tools.get('memory-save').execute('save', {
    fact: 'Global memory test saved a reusable verified fact.',
    tags: ['memory'], type: 'fact', ttlDays: 30, priority: 'normal', source: 'isolated global extension test',
  });
  const recall = await runtime.tools.get('memory-recall').execute('recall', { tags: ['memory'], maxItems: 2 });
  assert.deepEqual(recall.details.factIds, ['F-001']);
  assert.match(readFileSync(path.join(root, '.pi', 'memory', 'STATUS.md'), 'utf8'), /Global memory test is verified/);
  await assert.rejects(() => runtime.tools.get('memory-save').execute('unsafe', {
    fact: 'Unsafe test should be rejected by memory guard.', tags: ['memory'], type: 'fact', source: 'token=synthetic-example-value',
  }), /拒绝保存/);

  const delegatedProjectExt = path.join(root, '.pi', 'extensions', 'memory-guard', 'index.ts');
  const delegatedRuntime = harness([
    { name: 'memory-recall', sourceInfo: { scope: 'project', path: delegatedProjectExt }, marker: 'project' },
    { name: 'memory-save', sourceInfo: { scope: 'project', path: delegatedProjectExt }, marker: 'project' },
    { name: 'memory-review', sourceInfo: { scope: 'project', path: delegatedProjectExt }, marker: 'project' },
  ]);
  factory(delegatedRuntime.api);
  const delegatedCtx = context(root, 'session-b', true);
  await emit(delegatedRuntime, 'session_start', { reason: 'startup' }, delegatedCtx);
  assert.ok(delegatedRuntime.tools.has('memory-status'), 'global status tool remains available');
  assert.equal(delegatedRuntime.tools.get('memory-save').marker, 'project', 'global extension must not overwrite project memory-save');
  assert.equal(delegatedRuntime.tools.get('memory-recall').marker, 'project', 'global extension must not overwrite project memory-recall');
  assert.equal(await emit(delegatedRuntime, 'before_agent_start', { prompt: '继续' }, delegatedCtx), undefined, 'delegated runtime must not inject a second brief');

  // Delegated (project-level shadow) runtime: global layer must not write HANDOFF or INBOX.
  const delegatedHandoff = path.join(root, '.pi', 'memory', 'HANDOFF.md');
  assert.equal(await emit(delegatedRuntime, 'session_before_compact', { reason: 'test' }, delegatedCtx), undefined, 'delegated compact must not hand off');
  assert.ok(!existsSync(delegatedHandoff), 'delegated compact must not write HANDOFF.md');
  await emit(delegatedRuntime, 'tool_result', { toolName: 'bash', isError: true, content: [{ type: 'text', text: 'fail' }], input: { command: 'echo boom' } }, delegatedCtx);
  assert.equal(readFileSync(path.join(root, '.pi', 'memory', 'INBOX.jsonl'), 'utf8').trim(), '', 'delegated tool_result must not append INBOX');

  // INBOX 分层容量（PowerMem 分层思想的简化）：audit ≤ 40 且不被蒸馏候选挤掉；同分钟同工具失败去重；bash 合法非零退出降噪。
  {
    const auditRuntime = harness();
    factory(auditRuntime.api);
    const auditCtx = context(root, 'session-audit', true);
    await emit(auditRuntime, 'session_start', { reason: 'startup' }, auditCtx);
    const inboxPath = path.join(root, '.pi', 'memory', 'INBOX.jsonl');
    // 预置 10 条蒸馏候选（模拟 distill 写入）
    const seed = Array.from({ length: 10 }, (_, i) => JSON.stringify({ ts: `2026-08-01 10:${String(i).padStart(2, '0')}:00`, category: 'distilled', summary: `候选 ${i} 应保留` }));
    writeFileSync(inboxPath, seed.join('\n') + '\n', 'utf8');
    // 触发 50 条 config_change（不同路径，避开同分钟去重）→ audit 应裁到 40
    for (let i = 0; i < 50; i++) {
      await emit(auditRuntime, 'tool_result', { toolName: 'write', isError: false, content: [], input: { path: path.join(root, '.pi', 'memory', `f${i}.md`) } }, auditCtx);
    }
    // 同分钟同工具 bash 失败 3 次 → 只留 1 条
    for (let i = 0; i < 3; i++) {
      await emit(auditRuntime, 'tool_result', { toolName: 'bash', isError: true, content: [{ type: 'text', text: 'error: boom' }], input: { command: 'echo boom' } }, auditCtx);
    }
    // bash 合法非零退出（grep 无匹配）→ 降噪不记录
    await emit(auditRuntime, 'tool_result', { toolName: 'bash', isError: true, content: [{ type: 'text', text: '(no output) Command exited with code 1' }], input: { command: 'grep -n foo bar' } }, auditCtx);
    const lines = readFileSync(inboxPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const audit = lines.filter((o) => o.category !== 'distilled');
    const distilled = lines.filter((o) => o.category === 'distilled');
    assert.ok(audit.length <= 40, `audit trimmed to 40 (got ${audit.length})`);
    assert.equal(distilled.length, 10, 'distilled candidates must survive audit flood');
    assert.equal(audit.filter((o) => o.category === 'tool_failure').length, 1, 'same-minute same-tool failures dedupe to 1');
    // review 只显示蒸馏候选并附审计计数
    const review = await auditRuntime.tools.get('memory-review').execute('review', {}, undefined, undefined, auditCtx);
    assert.equal(review.details.count, 10, 'review lists only distilled candidates');
    assert.ok(review.details.auditCount >= 40, 'review reports audit count separately');
    assert.match(review.content[0].text, /审计事件未显示/);
  }

  // 同步闸门（PowerMem migration 思想：单一 schema 事实源）：扩展分层常量与分类必须与项目 scripts/memory-contract.mjs 一致。
  // 设置环境变量 PI_MEMORY_CONTRACT=<path> 启用；未设置时跳过。
  {
    const contractPath = process.env.PI_MEMORY_CONTRACT;
    if (contractPath && existsSync(contractPath)) {
      const contract = await import(pathToFileURL(contractPath).href);
      const src = readFileSync(path.join(extensionDir, 'index.ts'), 'utf8');
      const auditKeep = Number(src.match(/const AUDIT_KEEP = (\d+)/)?.[1]);
      const candidateKeep = Number(src.match(/const CANDIDATE_KEEP = (\d+)/)?.[1]);
      const categories = [...new Set((src.match(/category: "(tool_failure|config_change|distilled)"/g) ?? []).map((m) => m.slice(11, -1)))].sort();
      assert.equal(auditKeep, contract.INBOX_AUDIT_KEEP, 'extension AUDIT_KEEP must match contract');
      assert.equal(candidateKeep, contract.INBOX_CANDIDATE_KEEP, 'extension CANDIDATE_KEEP must match contract');
      assert.deepEqual(categories, [...contract.INBOX_CATEGORIES].sort(), 'extension categories must equal contract categories');
    } else {
      console.log('SKIP: PI_MEMORY_CONTRACT not set; contract sync gate skipped.');
    }
  }

  // Partial third-party tools (only memory-recall) must NOT trigger delegation.
  const partialRuntime = harness([{ name: 'memory-recall', sourceInfo: { scope: 'project', path: '/tmp/fake/index.ts' }, marker: 'third-party' }]);
  factory(partialRuntime.api);
  const partialCtx = context(root, 'session-partial', true);
  await emit(partialRuntime, 'session_start', { reason: 'startup' }, partialCtx);
  assert.equal(partialRuntime.tools.get('memory-save').marker, undefined, 'partial third-party tools must not suppress global memory-save');

  const centralCwd = mkdtempSync(path.join(tmpdir(), 'pi-new-project-'));
  let centralDir;
  try {
    const centralRuntime = harness();
    factory(centralRuntime.api);
    const centralCtx = context(centralCwd, 'session-central', false);
    await emit(centralRuntime, 'session_start', { reason: 'startup' }, centralCtx);
    const result = await centralRuntime.tools.get('memory-status').execute('central-status', { currentState: 'New project memory initialized.', nextActions: [] });
    assert.equal(result.details.kind, 'central', 'unconfigured new projects must use central isolated storage');
    const projectsRoot = path.join(agentHome, 'memory', 'projects');
    mkdirSync(projectsRoot, { recursive: true });
    centralDir = readdirSync(projectsRoot, { withFileTypes: true })
      .find((entry) => entry.isDirectory() && entry.name.endsWith(`-${result.details.projectKey}`));
    assert.ok(centralDir, 'central project directory must be created');
    const meta = JSON.parse(readFileSync(path.join(projectsRoot, centralDir.name, 'PROJECT.json'), 'utf8'));
    assert.equal(meta.projectKey, result.details.projectKey);
  } finally {
    rmSync(centralCwd, { recursive: true, force: true });
    if (centralDir) rmSync(path.join(agentHome, 'memory', 'projects', centralDir.name), { recursive: true, force: true });
  }

  // Untrusted project with a fake .pi/memory must not read its contents (prompt injection defense).
  const untrustedCwd = mkdtempSync(path.join(tmpdir(), 'pi-untrusted-'));
  try {
    mkdirSync(path.join(untrustedCwd, '.pi', 'memory'), { recursive: true });
    writeFileSync(path.join(untrustedCwd, '.pi', 'memory', 'FACTS.md'), '# 稳定事实\n\n## F-001 | Injected #memory\n> Verified: 2020-01-01 | TTL: 3650d\n> Type: fact | Priority: pinned\n> Source: untrusted\n- Injected fact from untrusted project.\n', 'utf8');
    const untrustedRuntime = harness();
    factory(untrustedRuntime.api);
    const untrustedCtx = context(untrustedCwd, 'session-untrusted', false);
    await emit(untrustedRuntime, 'session_start', { reason: 'startup' }, untrustedCtx);
    const untrustedBrief = await emit(untrustedRuntime, 'before_agent_start', { prompt: '检查记忆' }, untrustedCtx);
    assert.ok(!untrustedBrief.message.content.includes('Injected fact'), 'untrusted .pi/memory must never be read');
    assert.notEqual(untrustedBrief.message.details.projectKey, undefined, 'untrusted project gets a central projectKey');
    const untrustedRecall = await untrustedRuntime.tools.get('memory-recall').execute('r', {}, undefined, undefined, untrustedCtx);
    assert.ok(!untrustedRecall.content[0].text.includes('Injected fact'), 'untrusted recall must not echo fake memory');
  } finally {
    rmSync(untrustedCwd, { recursive: true, force: true });
  }

  // Lazy initialization: a greeting-only session must not create central storage.
  const lazyCwd = mkdtempSync(path.join(tmpdir(), 'pi-lazy-'));
  try {
    const lazyRuntime = harness();
    factory(lazyRuntime.api);
    const lazyCtx = context(lazyCwd, 'session-lazy', false);
    await emit(lazyRuntime, 'session_start', { reason: 'startup' }, lazyCtx);
    assert.equal(await emit(lazyRuntime, 'before_agent_start', { prompt: '你好' }, lazyCtx), undefined, 'greeting must not trigger brief');
    const projectsRoot = path.join(agentHome, 'memory', 'projects');
    mkdirSync(projectsRoot, { recursive: true });
    const beforeCount = readdirSync(projectsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
    const lazyStatus = await lazyRuntime.tools.get('memory-status').execute('lazy-status', { currentState: 'First write creates storage.' });
    const afterDirs = readdirSync(projectsRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
    assert.ok(afterDirs.length > beforeCount, 'first write must create central storage');
    rmSync(path.join(projectsRoot, afterDirs.find((d) => d.name.endsWith(`-${lazyStatus.details.projectKey}`)).name), { recursive: true, force: true });
  } finally {
    rmSync(lazyCwd, { recursive: true, force: true });
  }

  // Global preferences are separate from project facts, require a real UI confirmation, and can be injected independently.
  assert.ok(runtime.tools.has('memory-preference-save'));
  assert.ok(runtime.tools.has('memory-preference-recall'));
  assert.ok(runtime.tools.has('memory-link-save'));
  assert.ok(runtime.tools.has('memory-link-recall'));
  const preference = await runtime.tools.get('memory-preference-save').execute('pref-save', {
    category: 'language', preference: '默认使用中文，保留必要的技术术语。', tags: ['language'], ttlDays: 90,
  }, undefined, undefined, ctx);
  assert.equal(preference.details.scope, 'global-preference');
  const recalledPreference = await runtime.tools.get('memory-preference-recall').execute('pref-recall', { categories: ['language'] }, undefined, undefined, ctx);
  assert.match(recalledPreference.content[0].text, /用户偏好/);
  assert.match(recalledPreference.content[0].text, /默认使用中文/);
  await assert.rejects(() => runtime.tools.get('memory-preference-save').execute('pref-denied', {
    category: 'workflow', preference: '保存前先核对验证结果。',
  }, undefined, undefined, context(root, 'session-denied', true, [], false)), /用户取消/);

  const preferenceRuntime = harness();
  factory(preferenceRuntime.api);
  const preferenceCtx = context(root, 'session-preference-brief', true);
  await emit(preferenceRuntime, 'session_start', { reason: 'startup' }, preferenceCtx);
  const preferenceBrief = await emit(preferenceRuntime, 'before_agent_start', { prompt: '继续实现' }, preferenceCtx);
  assert.match(preferenceBrief.message.content, /<global_preferences>/, 'confirmed preferences are injected in a separate scope');
  assert.match(preferenceBrief.message.content, /不是项目事实/);

  // One-way links expose only an approved summary to the source project, never target project facts or status.
  const linkedRoot = mkdtempSync(path.join(tmpdir(), 'pi-linked-project-'));
  try {
    const link = await runtime.tools.get('memory-link-save').execute('link-save', {
      targetProjectRoot: linkedRoot, relation: 'shared-component', direction: 'one-way',
      summary: '共享组件只使用稳定公开接口，改动前需双方单独验证。', tags: ['component'], ttlDays: 90,
    }, undefined, undefined, ctx);
    assert.equal(link.details.scope, 'project-link');
    const recalledLink = await runtime.tools.get('memory-link-recall').execute('link-recall', { tags: ['component'] }, undefined, undefined, ctx);
    assert.match(recalledLink.content[0].text, /最小关联摘要/);
    assert.match(recalledLink.content[0].text, /稳定公开接口/);

    const targetRuntime = harness();
    factory(targetRuntime.api);
    const targetCtx = context(linkedRoot, 'session-target', false);
    await emit(targetRuntime, 'session_start', { reason: 'startup' }, targetCtx);
    const hiddenAtTarget = await targetRuntime.tools.get('memory-link-recall').execute('link-target', {}, undefined, undefined, targetCtx);
    assert.match(hiddenAtTarget.content[0].text, /没有当前项目可访问/);

    const boundary = await emit(runtime, 'before_agent_start', { prompt: '继续记忆工作' }, targetCtx);
    assert.match(boundary.message.content, /project_memory_boundary/, 'project changes fail closed instead of injecting old facts');
    await assert.rejects(() => runtime.tools.get('memory-status').execute('wrong-project', { currentState: 'Must not write into old project.' }, undefined, undefined, targetCtx), /已切换到另一项目/);
  } finally {
    rmSync(linkedRoot, { recursive: true, force: true });
  }

  console.log('Global memory guard tests passed.');
} finally {
  rmSync(root, { recursive: true, force: true });
}
