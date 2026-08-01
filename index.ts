import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { open, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import { calendarAgeDays, findContentRisk, isExpired, MEMORY_SCHEMA_VERSION } from "./contract.ts";

type MemoryType = "fact" | "decision" | "constraint" | "failure_pattern";
type Fact = {
  id: string;
  title: string;
  tags: string[];
  verified: string;
  ttlDays: number;
  type: MemoryType;
  priority: "normal" | "pinned";
  replaces?: string;
  source?: string;
  body: string;
};
type ToolMeta = { name: string; sourceInfo?: { path?: string; baseDir?: string; source?: string; scope?: string } };
function isProjectMemoryGuard(cwd: string, tools: ToolMeta[]): boolean {
  const recall = tools.find((t) => t.name === "memory-recall");
  const save = tools.find((t) => t.name === "memory-save");
  const review = tools.find((t) => t.name === "memory-review");
  if (!recall || !save || !review) return false;
  const expectedDir = canonicalPath(join(cwd, ".pi", "extensions", "memory-guard"));
  const matches = (info?: ToolMeta["sourceInfo"]): boolean => {
    if (!info) return false;
    const candidates = [info.path, info.baseDir, info.source].filter(Boolean) as string[];
    return candidates.some((candidate) => {
      const real = canonicalPath(candidate);
      return real === expectedDir || real.startsWith(`${expectedDir}${sep}`);
    });
  };
  const allPath = matches(recall.sourceInfo) && matches(save.sourceInfo) && matches(review.sourceInfo);
  if (allPath) return true;
  // Fallback: if sourceInfo is entirely absent for all three, trust the complete trio.
  const noInfo = !recall.sourceInfo && !save.sourceInfo && !review.sourceInfo;
  return noInfo;
}

type Location = { projectRoot: string; projectKey: string; memoryDir: string; kind: "project" | "central" };
type Observation = { ts: string; category: "tool_failure" | "config_change" | "distilled"; summary: string };
type PreferenceCategory = "language" | "output-style" | "workflow" | "approval-policy";
type GlobalPreference = { id: string; category: PreferenceCategory; preference: string; tags: string[]; verified: string; ttlDays: number; priority: "normal" | "pinned" };
type ProjectLink = { id: string; fromProjectKey: string; fromProjectRoot: string; toProjectKey: string; toProjectRoot: string; relation: "shared-component" | "shared-goal" | "dependency" | "reference"; direction: "one-way" | "two-way"; summary: string; tags: string[]; approved: string; ttlDays: number };

// Test-only override keeps tests isolated; production always uses the Pi agent home.
const AGENT_HOME = process.env.PI_MEMORY_GUARD_HOME ? resolve(process.env.PI_MEMORY_GUARD_HOME) : join(homedir(), ".pi", "agent");
const CENTRAL_ROOT = join(AGENT_HOME, "memory", "projects");
const GLOBAL_ROOT = join(AGENT_HOME, "memory", "global");
const PREFERENCES_FILE = join(GLOBAL_ROOT, "PREFERENCES.json");
const LINKS_FILE = join(GLOBAL_ROOT, "LINKS.json");
const MAX_BRIEF_CHARS = 760;
const MAX_FACT_CHARS = 320;
const MAX_RECALL_FACTS = 5;
const MAX_FACTS_BYTES = 65_536;
const MAX_FACTS_LINES = 800;
const MAX_GLOBAL_PREFERENCES = 100;
const MAX_PROJECT_LINKS = 100;
const LOCK_TIMEOUT_MS = 8_000;
const TAG_ALIASES: Record<string, string[]> = {
  memory: ["memory", "context", "session"],
  model: ["model", "codex", "thinking"],
  network: ["network", "router", "proxy", "dns", "vps"],
  pwa: ["pwa", "mobile", "sse"],
};

function today(): string { return new Date().toISOString().slice(0, 10); }
function timestamp(): string { return new Date().toISOString().replace("T", " ").slice(0, 19); }
function futureDate(days: number): string {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
function expiryDate(verified: string, ttlDays: number): string {
  const value = new Date(`${verified}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + ttlDays);
  return value.toISOString().slice(0, 10);
}
function readText(file: string): string {
  try { return existsSync(file) ? readFileSync(file, "utf8") : ""; } catch { return ""; }
}
function compact(text: string, maxChars: number): string {
  const normalized = String(text ?? "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (maxChars <= 1) return "";
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}
function wrap(tag: string, body: string, maxChars: number): string {
  const openTag = `<${tag}>`;
  const closeTag = `</${tag}>`;
  return `${openTag}\n${compact(body, Math.max(1, maxChars - openTag.length - closeTag.length - 2))}\n${closeTag}`;
}
function requireSingleLine(name: string, text: string): void {
  if (/[\r\n]/.test(text)) throw new Error(`拒绝保存：${name} 必须是单行文本。`);
}
function requireSafe(text: string): void {
  const risk = findContentRisk(text);
  if (risk) throw new Error(`拒绝保存：检测到 ${risk} 风险。只可记录安全位置、轮换状态或非敏感摘要。`);
}
function canonicalPath(path: string): string {
  try { return realpathSync.native(path); } catch { return resolve(path); }
}
function pathKey(path: string): string {
  return canonicalPath(path).replace(/\\/g, "/").replace(/^([A-Z]):/, (_, drive) => `${drive.toLowerCase()}:`);
}
function safeSlug(text: string): string {
  const slug = text.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug || "project";
}
function projectKeyFor(root: string): string { return createHash("sha256").update(pathKey(root)).digest("hex").slice(0, 12); }
function activeByTtl(verified: string, ttlDays: number): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(verified) && Number.isInteger(ttlDays) && ttlDays > 0 && !isExpired(verified, ttlDays); }
function nextScopedId(prefix: "P" | "L", entries: Array<{ id: string }>): string {
  const max = entries.reduce((value, entry) => Math.max(value, Number(entry.id.slice(2)) || 0), 0);
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}
function parseJsonEntries<T>(file: string): T[] {
  try {
    const value = JSON.parse(readText(file)) as { entries?: unknown };
    return Array.isArray(value.entries) ? value.entries as T[] : [];
  } catch { return []; }
}
function writeJsonEntries<T>(file: string, entries: T[]): void {
  writeAtomically(file, `${JSON.stringify({ schemaVersion: MEMORY_SCHEMA_VERSION, entries }, null, 2)}\n`);
}
function isPreference(value: unknown): value is GlobalPreference {
  const item = value as GlobalPreference | undefined;
  return Boolean(item && /^P-\d+$/.test(item.id) && ["language", "output-style", "workflow", "approval-policy"].includes(item.category)
    && typeof item.preference === "string" && item.preference.length > 0 && item.preference.length <= 320
    && Array.isArray(item.tags) && item.tags.every((tag) => typeof tag === "string")
    && typeof item.verified === "string" && Number.isInteger(item.ttlDays) && item.ttlDays >= 1 && item.ttlDays <= 365
    && (item.priority === "normal" || item.priority === "pinned") && !findContentRisk(`${item.preference}\n${item.tags.join(" ")}`));
}
function isProjectLink(value: unknown): value is ProjectLink {
  const item = value as ProjectLink | undefined;
  return Boolean(item && /^L-\d+$/.test(item.id) && /^[a-f0-9]{12}$/.test(item.fromProjectKey) && /^[a-f0-9]{12}$/.test(item.toProjectKey)
    && typeof item.fromProjectRoot === "string" && typeof item.toProjectRoot === "string"
    && ["shared-component", "shared-goal", "dependency", "reference"].includes(item.relation)
    && (item.direction === "one-way" || item.direction === "two-way")
    && typeof item.summary === "string" && item.summary.length > 0 && item.summary.length <= 360
    && Array.isArray(item.tags) && item.tags.every((tag) => typeof tag === "string")
    && typeof item.approved === "string" && Number.isInteger(item.ttlDays) && item.ttlDays >= 1 && item.ttlDays <= 365
    && !findContentRisk(`${item.summary}\n${item.tags.join(" ")}`));
}
function globalPreferences(): GlobalPreference[] { return parseJsonEntries<unknown>(PREFERENCES_FILE).filter(isPreference).filter((item) => activeByTtl(item.verified, item.ttlDays)).slice(-MAX_GLOBAL_PREFERENCES); }
function projectLinks(): ProjectLink[] { return parseJsonEntries<unknown>(LINKS_FILE).filter(isProjectLink).filter((item) => activeByTtl(item.approved, item.ttlDays)).slice(-MAX_PROJECT_LINKS); }
function projectLabel(root: string): string { return safeSlug(basename(root)); }
function findUp(start: string, predicate: (dir: string) => boolean): string | undefined {
  let cursor = resolve(start);
  const root = parse(cursor).root;
  while (true) {
    if (predicate(cursor)) return cursor;
    if (cursor === root) return undefined;
    cursor = dirname(cursor);
  }
}
function projectRootFor(cwd: string): string {
  const git = findUp(cwd, (dir) => existsSync(join(dir, ".git")));
  if (git) return git;
  const home = canonicalPath(homedir());
  const agents = findUp(cwd, (dir) => existsSync(join(dir, "AGENTS.md")) || existsSync(join(dir, "CLAUDE.md")));
  if (agents && canonicalPath(agents) !== home) return agents;
  return resolve(cwd);
}
function resolveLocation(cwd: string, trusted: boolean): Location {
  if (trusted) {
    const owner = findUp(cwd, (dir) => {
      const memory = join(dir, ".pi", "memory");
      return existsSync(join(memory, "FACTS.md")) || existsSync(join(memory, "STATUS.md"));
    });
    if (owner) {
      const projectKey = createHash("sha256").update(pathKey(owner)).digest("hex").slice(0, 12);
      return { projectRoot: owner, projectKey, memoryDir: join(owner, ".pi", "memory"), kind: "project" };
    }
  }
  const projectRoot = projectRootFor(cwd);
  const projectKey = createHash("sha256").update(pathKey(projectRoot)).digest("hex").slice(0, 12);
  const dirName = `${safeSlug(basename(projectRoot))}-${projectKey}`;
  return { projectRoot, projectKey, memoryDir: join(CENTRAL_ROOT, dirName), kind: "central" };
}
function writeAtomically(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temp, text, { encoding: "utf8", flag: "wx" });
    renameSync(temp, file);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}
function ensureProjectMeta(loc: Location): void {
  if (loc.kind !== "central") return;
  const metaFile = join(loc.memoryDir, "PROJECT.json");
  if (!existsSync(metaFile)) {
    mkdirSync(loc.memoryDir, { recursive: true });
    writeAtomically(metaFile, `${JSON.stringify({ schemaVersion: MEMORY_SCHEMA_VERSION, projectKey: loc.projectKey, projectRoot: pathKey(loc.projectRoot), createdAt: new Date().toISOString() }, null, 2)}\n`);
  }
}
function initializeLocation(location: Location): void {
  mkdirSync(location.memoryDir, { recursive: true });
  const statusFile = join(location.memoryDir, "STATUS.md");
  const factsFile = join(location.memoryDir, "FACTS.md");
  const inboxFile = join(location.memoryDir, "INBOX.jsonl");
  if (!existsSync(statusFile)) {
    writeAtomically(statusFile, [
      "# STATUS",
      `> Updated: ${today()} | Verify-by: ${futureDate(7)}`,
      "",
      "## 当前状态",
      "尚无已验证的项目状态。",
      "",
      "## Next Actions",
      "",
    ].join("\n"));
  }
  if (!existsSync(factsFile)) writeAtomically(factsFile, "# 稳定事实\n");
  if (!existsSync(inboxFile)) writeAtomically(inboxFile, "");
}
function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code !== "ESRCH"; }
}
async function canBreakLock(lockFile: string): Promise<boolean> {
  try {
    const owner = JSON.parse(readText(lockFile)) as { pid?: number };
    if (Number.isInteger(owner.pid)) return !isProcessRunning(owner.pid as number);
    return Date.now() - (await stat(lockFile)).mtimeMs > 30_000;
  } catch {
    try { return Date.now() - (await stat(lockFile)).mtimeMs > 30_000; } catch { return true; }
  }
}
async function withLock<T>(target: string, action: () => Promise<T> | T): Promise<T> {
  const lockFile = `${target}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  mkdirSync(dirname(target), { recursive: true });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (!handle) {
    try {
      handle = await open(lockFile, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      if (await canBreakLock(lockFile)) { await unlink(lockFile).catch(() => undefined); continue; }
      if (Date.now() >= deadline) throw new Error(`记忆文件正被另一个会话写入：${target}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 35 + Math.floor(Math.random() * 40)));
    }
  }
  try { return await action(); }
  finally { await handle.close().catch(() => undefined); await unlink(lockFile).catch(() => undefined); }
}
function normalizeTags(tags: string[] = []): string[] {
  const values = tags.map((tag) => tag.trim().replace(/^#/, "").toLowerCase()).filter(Boolean);
  for (const tag of values) if (!/^[a-z0-9-]{1,32}$/.test(tag)) throw new Error("标签只能使用 1–32 位小写英文、数字或连字符。");
  return [...new Set(values)];
}
function expandTags(tags: string[]): string[] { return [...new Set(tags.flatMap((tag) => TAG_ALIASES[tag] ?? [tag]))]; }
function parseFacts(raw: string): Fact[] {
  const headings = [...raw.matchAll(/^## (F-\d+)\s*\|\s*(.+)$/gm)];
  return headings.map((heading, index) => {
    const start = (heading.index ?? 0) + heading[0].length;
    const end = index + 1 < headings.length ? (headings[index + 1].index ?? raw.length) : raw.length;
    const block = raw.slice(start, end).trim();
    const titleAndTags = heading[2].trim();
    const tags = [...titleAndTags.matchAll(/#([a-z0-9-]+)/gi)].map((match) => match[1].toLowerCase());
    const verified = block.match(/^> Verified: (\d{4}-\d{2}-\d{2}) \| TTL: (\d+)d$/m);
    const typed = block.match(/^> Type: (fact|decision|constraint|failure_pattern) \| Priority: (normal|pinned)(?: \| Replaces: (F-\d+))?$/m);
    const source = block.match(/^> Source: (.+)$/m);
    return {
      id: heading[1],
      title: titleAndTags.replace(/\s*#[a-z0-9-]+/gi, "").trim(),
      tags,
      verified: verified?.[1] ?? "1970-01-01",
      ttlDays: Number(verified?.[2] ?? 0),
      type: (typed?.[1] as MemoryType | undefined) ?? "fact",
      priority: (typed?.[2] as "normal" | "pinned" | undefined) ?? "normal",
      replaces: typed?.[3],
      source: source?.[1],
      body: block.split("\n").filter((line) => !line.startsWith("> Verified:") && !line.startsWith("> Type:") && !line.startsWith("> Source:")).join("\n").trim(),
    };
  });
}
function currentFacts(facts: Fact[]): Fact[] {
  const superseded = new Set(facts.flatMap((fact) => fact.replaces ? [fact.replaces] : []));
  return facts.filter((fact) => !superseded.has(fact.id));
}
function activeFacts(facts: Fact[]): Fact[] { return currentFacts(facts).filter((fact) => !isExpired(fact.verified, fact.ttlDays)); }
function reinforceVerified(raw: string, ids: string[]): string {
  const target = new Set(ids);
  let current: string | null = null;
  return raw.split("\n").map((line) => {
    const heading = line.match(/^## (F-\d+) \|/);
    if (heading) { current = heading[1]; return line; }
    if (current && target.has(current)) {
      const verified = line.match(/^> Verified: (\d{4}-\d{2}-\d{2}) \| TTL: (\d+)d$/);
      if (verified) return `> Verified: ${today()} | TTL: ${verified[2]}d`;
    }
    return line;
  }).join("\n");
}
function expiringCount(raw: string): number {
  return activeFacts(parseFacts(raw)).filter((fact) => {
    const remaining = fact.ttlDays - calendarAgeDays(fact.verified);
    return remaining <= Math.max(1, Math.ceil(fact.ttlDays * 0.2));
  }).length;
}
function renderFact(fact: Fact, maxChars = MAX_FACT_CHARS): string {
  const meta = [`类型: ${fact.type}`, `验证: ${fact.verified}`, fact.source ? `来源: ${fact.source}` : ""].filter(Boolean).join(" | ");
  return compact(`- [${fact.id}] ${fact.title} (#${fact.tags.join(" #")})\n  ${meta}\n  ${fact.body}`, maxChars);
}
function section(markdown: string, heading: string): string {
  return markdown.match(new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=^## |$)`, "m"))?.[1]?.trim() ?? "";
}
function statusBrief(status: string, maxChars: number): string {
  const metadata = status.match(/^> Updated: \d{4}-\d{2}-\d{2} \| Verify-by: (\d{4}-\d{2}-\d{2})$/m);
  const warning = !metadata ? "⚠ STATUS 缺少有效复验期限；先验证运行状态。" : isExpired(metadata[1], 0) ? `⚠ STATUS 已超过复验期限 ${metadata[1]}；先验证运行状态。` : "";
  const actions = section(status, "Next Actions").split("\n").filter((line) => line.startsWith("- [ ]")).slice(0, 3).join("\n");
  return compact([warning, section(status, "当前状态"), actions ? `待办:\n${actions}` : ""].filter(Boolean).join("\n"), maxChars);
}
function deriveTags(prompt: string): string[] {
  const lower = prompt.toLowerCase();
  const routes: Array<[string, string[]]> = [
    ["memory", ["记忆", "memory", "会话", "上下文"]],
    ["network", ["网络", "路由", "代理", "dns", "vps"]],
    ["model", ["模型", "codex", "gpt", "qwen", "thinking"]],
    ["pwa", ["pwa", "mobile", "sse", "service worker"]],
  ];
  return routes.filter(([, words]) => words.some((word) => lower.includes(word))).map(([tag]) => tag);
}
function isSubstantive(prompt: string): boolean {
  const value = prompt.trim().toLowerCase().replace(/[\s!！?？,.，。~～]+/g, "");
  return Boolean(value) && !new Set(["你好", "您好", "哈喽", "嗨", "在吗", "早", "早上好", "晚上好", "hi", "hello", "hey"]).has(value);
}
function validateFacts(text: string): void {
  requireSafe(text);
  if (Buffer.byteLength(text, "utf8") > MAX_FACTS_BYTES) throw new Error("拒绝保存：FACTS.md 超过 64 KiB，请先合并或归档。");
  if (text.split(/\r?\n/).length > MAX_FACTS_LINES) throw new Error("拒绝保存：FACTS.md 超过 800 行，请先合并或归档。");
  const headings = [...text.matchAll(/^## (F-\d+) \| [^\r\n]+$/gm)];
  const strict = [...text.matchAll(/^## (F-\d+) \| [^\r\n]+\r?\n> Verified: (\d{4}-\d{2}-\d{2}) \| TTL: (\d+)d\r?\n> Type: (fact|decision|constraint|failure_pattern) \| Priority: (normal|pinned)(?: \| Replaces: (F-\d+))?\r?\n> Source: [^\r\n]+$/gm)];
  if ((text.match(/^## /gm)?.length ?? 0) !== strict.length || headings.length !== strict.length) throw new Error("拒绝保存：FACTS.md 元数据不完整或顺序错误。");
  const facts = parseFacts(text);
  const ids = facts.map((fact) => fact.id);
  const idSet = new Set(ids);
  if (idSet.size !== ids.length) throw new Error("拒绝保存：FACTS.md 存在重复 Fact ID。");
  const replaced = new Map<string, number>();
  for (const fact of facts) {
    const age = calendarAgeDays(fact.verified);
    if (!Number.isFinite(age) || age < 0) throw new Error(`拒绝保存：${fact.id} 的 Verified 日期无效。`);
    if (fact.replaces) {
      if (!idSet.has(fact.replaces) || fact.replaces === fact.id) throw new Error(`拒绝保存：${fact.id} 的 Replaces 无效。`);
      replaced.set(fact.replaces, (replaced.get(fact.replaces) ?? 0) + 1);
    }
  }
  if ([...replaced.values()].some((count) => count > 1)) throw new Error("拒绝保存：一个事实不能被多个事实同时替代。");
}
function nextFactId(facts: Fact[]): string {
  const max = facts.reduce((value, fact) => Math.max(value, Number(fact.id.slice(2)) || 0), 0);
  return `F-${String(max + 1).padStart(3, "0")}`;
}
const AUDIT_KEEP = 40;
const CANDIDATE_KEEP = 60;
function observations(file: string): Observation[] {
  // 全量读取（分层后上限 100 行），不再截断最近 20 条——避免旧候选成为不可见僵尸数据。
  return readText(file).split(/\r?\n/).filter(Boolean).flatMap((line) => { try { const value = JSON.parse(line) as Observation; return value.summary ? [value] : []; } catch { return []; } });
}
async function appendObservation(file: string, item: Observation): Promise<void> {
  await withFileMutationQueue(file, () => withLock(file, () => {
    const lines = readText(file).split(/\r?\n/).filter(Boolean);
    const safe = findContentRisk(item.summary) ? { ...item, summary: `${item.category}: [摘要已脱敏]` } : item;
    // 全量查重：同 summary 且同分钟视为重复（不再只看最近 20 条）。
    const duplicate = lines.some((line) => { try { const old = JSON.parse(line) as Observation; return old.summary === safe.summary && old.ts.slice(0, 16) === safe.ts.slice(0, 16); } catch { return false; } });
    // 同分钟同工具失败只保留一条：防命令链/重试批量触发灌满 INBOX。
    const toolKey = safe.summary.startsWith("工具失败: ") ? safe.summary.split("]")[0] : "";
    const dupMinute = toolKey !== "" && lines.some((line) => { try { const old = JSON.parse(line) as Observation; return old.ts.slice(0, 16) === safe.ts.slice(0, 16) && old.summary.startsWith(toolKey); } catch { return false; } });
    if (duplicate || dupMinute) return;
    // 分层容量：审计事件（tool_failure/config_change）保留最近 40 条，蒸馏候选（distilled）保留最近 60 条。
    const next = [...lines, JSON.stringify(safe)];
    const audit: string[] = []; const candidates: string[] = [];
    for (const line of next) { try { (JSON.parse(line) as Observation).category === "distilled" ? candidates.push(line) : audit.push(line); } catch { audit.push(line); } }
    const trimmed = [...audit.slice(-AUDIT_KEEP), ...candidates.slice(-CANDIDATE_KEEP)];
    writeAtomically(file, `${trimmed.join("\n")}\n`);
  }));
}

export default function globalMemoryGuard(pi: ExtensionAPI) {
  let location: Location | undefined;
  let delegated = false;
  let toolsRegistered = false;
  let statusToolRegistered = false;
  let globalToolsRegistered = false;

  const statusFile = () => join(location!.memoryDir, "STATUS.md");
  const factsFile = () => join(location!.memoryDir, "FACTS.md");
  const inboxFile = () => join(location!.memoryDir, "INBOX.jsonl");
  const handoffFile = () => join(location!.memoryDir, "HANDOFF.md");
  function trustedFor(ctx: any): boolean { return typeof ctx?.isProjectTrusted === "function" ? Boolean(ctx.isProjectTrusted()) : false; }
  function matchesSessionProject(ctx: any): boolean {
    if (!location || typeof ctx?.cwd !== "string") return Boolean(location);
    const current = resolveLocation(ctx.cwd, trustedFor(ctx));
    return current.projectKey === location.projectKey && pathKey(current.projectRoot) === pathKey(location.projectRoot);
  }
  function requireSessionProject(ctx: any): Location {
    if (!location) throw new Error("项目记忆尚未初始化。");
    if (!matchesSessionProject(ctx)) throw new Error("检测到当前工作目录已切换到另一项目；为防止混淆，已拒绝读写旧项目记忆。请新建会话后继续。");
    return location;
  }
  function hasCustomMessage(ctx: any, customType: string): boolean {
    const id = ctx.sessionManager.getSessionId?.();
    const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries?.() ?? [];
    return entries.some((entry: any) => entry.type === "custom_message" && entry.customType === customType && entry.details?.sessionId === id);
  }
  function applicableLinks(): ProjectLink[] {
    if (!location) return [];
    return projectLinks().filter((link) => link.fromProjectKey === location!.projectKey || (link.direction === "two-way" && link.toProjectKey === location!.projectKey));
  }
  function buildGlobalPreferencesBrief(): string | null {
    const preferences = globalPreferences().sort((a, b) => a.priority !== b.priority ? (a.priority === "pinned" ? -1 : 1) : b.verified.localeCompare(a.verified)).slice(0, 3);
    if (!preferences.length) return null;
    const body = [
      "以下是经用户确认的跨项目协作偏好；它们不是项目事实、状态、配置或项目间关系。",
      ...preferences.map((item) => `- [${item.id}] ${item.category}: ${compact(item.preference, 110)}（有效至 ${expiryDate(item.verified, item.ttlDays)}）`),
      "只将其用于语言、输出方式、工作流或确认习惯；当前项目事实仍必须以项目记忆和运行时验证为准。",
    ].join("\n");
    return wrap("global_preferences", body, 680);
  }
  function safeReadSet(): { status: string; facts: string; risk: string | null } {
    const status = readText(statusFile());
    const facts = readText(factsFile());
    const statusRisk = findContentRisk(status);
    const factsRisk = findContentRisk(facts);
    return { status, facts, risk: statusRisk ? `STATUS.md: ${statusRisk}` : factsRisk ? `FACTS.md: ${factsRisk}` : null };
  }
  function selectFacts(tags: string[] = [], limit = MAX_RECALL_FACTS, raw = readText(factsFile())): Fact[] {
    const expanded = expandTags(tags);
    const facts = activeFacts(parseFacts(raw));
    const selected = expanded.length ? facts.filter((fact) => fact.tags.some((tag) => expanded.includes(tag))) : facts;
    return selected.sort((a, b) => a.priority !== b.priority ? (a.priority === "pinned" ? -1 : 1) : b.verified.localeCompare(a.verified)).slice(0, limit);
  }
  function hasBrief(ctx: any): boolean { return hasCustomMessage(ctx, "project-memory-brief"); }
  function buildBrief(prompt: string): string {
    const read = safeReadSet();
    if (read.risk) return wrap("project_memory_brief", `⚠ 已阻止加载项目记忆：检测到 ${read.risk}。本次未输出记忆原文。`, MAX_BRIEF_CHARS);
    const tags = deriveTags(prompt);
    const facts = selectFacts(tags, tags.length ? 2 : 1, read.facts);
    const links = applicableLinks();
    const expiring = expiringCount(read.facts);
    const body = [
      `这是当前项目（${projectLabel(location!.projectRoot)} / ${location!.projectKey}）的跨会话背景；运行时验证优先，且凭据值不得进入记忆。`,
      "作用域边界：以下状态和事实只适用于当前项目，禁止外推、复制或混入其他项目。",
      `当前状态:\n${statusBrief(read.status, tags.length ? 300 : 420)}`,
      facts.length ? `相关事实:\n${facts.map((fact) => renderFact(fact, 200)).join("\n")}` : "",
      expiring ? `⚠ ${expiring} 条事实即将到期（剩余 ≤20% TTL）；先复核再引用。` : "",
      links.length ? `存在 ${links.length} 条已批准项目关联；仅在明确需要时调用 memory-link-recall 读取其最小摘要，禁止假定关联内容。` : "",
      "需要更多当前项目历史时按标签调用 memory-recall；只保存已验证、可复用的结论。",
    ].filter(Boolean).join("\n\n");
    return wrap("project_memory_brief", body, MAX_BRIEF_CHARS);
  }
  function buildHandoff(reason: string): string {
    const read = safeReadSet();
    const pinned = selectFacts([], 2, read.facts).filter((f) => f.priority === "pinned");
    const obs = observations(inboxFile()).slice(-3);
    const body = [
      `压缩交接 (reason: ${reason})`,
      `当前状态:\n${statusBrief(read.status, 300)}`,
      pinned.length ? `关键事实:\n${pinned.map((f) => renderFact(f, 150)).join("\n")}` : "",
      obs.length ? `近期观察:\n${obs.map((o) => `- ${o.category}: ${o.summary}`).join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
    // Disk state must stay data-only. Wrap only when injecting into a session;
    // otherwise memory:check correctly treats this control delimiter as unsafe.
    return compact(body, 500);
  }
  function readHandoffIfFresh(): string | null {
    const content = readText(handoffFile());
    if (!content) return null;
    const match = content.match(/<!-- HANDOFF (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
    if (!match) return null;
    // timestamp() writes UTC (`toISOString`) without a suffix; restore its UTC
    // semantics explicitly so non-UTC hosts do not discard a fresh handoff.
    const age = Date.now() - new Date(`${match[1].replace(" ", "T")}Z`).getTime();
    if (age > 600_000) return null;
    return content;
  }
  function hasBriefWithHandoff(ctx: any): boolean {
    const id = ctx.sessionManager.getSessionId?.();
    const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries?.() ?? [];
    return entries.some((entry: any) => entry.type === "custom_message" && entry.customType === "project-memory-brief" && entry.details?.sessionId === id && entry.details?.handoff === true);
  }
  function registerStatusTool(): void {
    if (statusToolRegistered || pi.getAllTools().some((tool) => tool.name === "memory-status")) return;
    statusToolRegistered = true;
    pi.registerTool({
      name: "memory-status",
      label: "Memory Status",
      description: "更新当前项目的短期状态检查点。只写已验证状态和最多 6 个下一步，不得包含凭据值。",
      promptSnippet: "Update the current project's concise cross-session status checkpoint",
      promptGuidelines: ["Use memory-status after a verified milestone or before a session/model handoff; never include credential values."],
      parameters: Type.Object({
        currentState: Type.String({ minLength: 4, maxLength: 1000, pattern: "^[^\\r\\n]+$" }),
        nextActions: Type.Optional(Type.Array(Type.String({ minLength: 2, maxLength: 240, pattern: "^[^\\r\\n]+$" }), { maxItems: 6 })),
        verifyDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
      }),
      executionMode: "sequential",
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const current = requireSessionProject(ctx);
        requireSingleLine("currentState", params.currentState);
        for (const action of params.nextActions ?? []) requireSingleLine("nextActions", action);
        requireSafe([params.currentState, ...(params.nextActions ?? [])].join("\n"));
        ensureProjectMeta(current);
        const next = [
          "# STATUS",
          `> Updated: ${today()} | Verify-by: ${futureDate(params.verifyDays ?? 7)}`,
          "",
          "## 当前状态",
          params.currentState.trim(),
          "",
          "## Next Actions",
          ...(params.nextActions ?? []).map((action) => `- [ ] ${action.trim()}`),
          "",
        ].join("\n");
        await withFileMutationQueue(statusFile(), () => withLock(statusFile(), () => writeAtomically(statusFile(), next)));
        return { content: [{ type: "text", text: "已更新项目 STATUS 检查点。" }], details: { projectKey: location.projectKey, kind: location.kind } };
      },
    });
  }
  function registerProjectTools(): void {
    if (toolsRegistered) return;
    toolsRegistered = true;
    pi.registerTool({
      name: "memory-recall",
      label: "Memory Recall",
      description: "读取当前项目的跨会话记忆。无参数返回状态和少量事实；提供 tags 时精确召回。",
      promptSnippet: "Load concise project memory by tag when prior context matters",
      promptGuidelines: ["Use memory-recall only when the injected brief is absent or domain details are needed; prefer precise tags."],
      parameters: Type.Object({
        tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 32 }), { maxItems: 8 })),
        maxItems: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
      }),
      executionMode: "sequential",
      async execute(_id, params, _signal, _onUpdate, ctx) {
        requireSessionProject(ctx);
        const read = safeReadSet();
        if (read.risk) return { content: [{ type: "text", text: wrap("project_memory_recall", `⚠ 已阻止加载项目记忆：检测到 ${read.risk}。本次未输出记忆原文。`, 2400) }], details: { blocked: true } };
        const tags = normalizeTags(params.tags ?? []);
        const facts = selectFacts(tags, params.maxItems ?? MAX_RECALL_FACTS, read.facts);
        // 命中强化：剩余寿命不足一半的有效事实刷新验证日期，避免常用事实因 TTL 到期而失效（借鉴 PowerMem reinforce）。
        const toReinforce = facts.filter((fact) => !isExpired(fact.verified, fact.ttlDays) && calendarAgeDays(fact.verified) > fact.ttlDays / 2).map((fact) => fact.id);
        if (toReinforce.length) {
          try {
            await withFileMutationQueue(factsFile(), () => withLock(factsFile(), () => {
              const raw = readText(factsFile());
              const next = reinforceVerified(raw, toReinforce);
              if (next !== raw) { validateFacts(next); writeAtomically(factsFile(), next); }
            }));
          } catch { /* 强化失败不影响召回结果 */ }
        }
        const expiring = expiringCount(read.facts);
        const body = [
          `当前状态:\n${statusBrief(read.status, tags.length ? 300 : 480)}`,
          facts.length ? `有效事实${tags.length ? `（${tags.map((tag) => `#${tag}`).join(" ")}）` : ""}:\n${facts.map((fact) => renderFact(fact)).join("\n\n")}` : "没有匹配的有效事实。",
          expiring ? `⚠ ${expiring} 条事实即将到期（剩余 ≤20% TTL）；先复核再引用。` : "",
        ].filter(Boolean).join("\n\n");
        return { content: [{ type: "text", text: wrap("project_memory_recall", body, 2400) }], details: { projectKey: location.projectKey, tags, factIds: facts.map((fact) => fact.id) } };
      },
    });
    pi.registerTool({
      name: "memory-save",
      label: "Memory Save",
      description: "保存当前项目已验证、可复用的事实/决策/约束/失败模式。拒绝凭据、Cookie、私钥及认证 URL。",
      promptSnippet: "Save an important verified project fact without secrets",
      promptGuidelines: ["Use memory-save only for verified reusable project knowledge; never pass credential values or raw command output."],
      parameters: Type.Object({
        fact: Type.String({ minLength: 12, maxLength: 1200, pattern: "^[^\\r\\n]+$" }),
        tags: Type.Array(Type.String({ minLength: 1, maxLength: 32 }), { minItems: 1, maxItems: 8 }),
        type: StringEnum(["fact", "decision", "constraint", "failure_pattern"] as const),
        ttlDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
        priority: Type.Optional(StringEnum(["normal", "pinned"] as const)),
        source: Type.String({ minLength: 3, maxLength: 240, pattern: "^[^\\r\\n]+$" }),
        replaces: Type.Optional(Type.String({ pattern: "^F-[0-9]{3,}$" })),
      }),
      executionMode: "sequential",
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const current = requireSessionProject(ctx);
        requireSingleLine("fact", params.fact);
        requireSingleLine("source", params.source);
        requireSafe(`${params.fact}\n${params.source}`);
        ensureProjectMeta(current);
        const tags = normalizeTags(params.tags);
        return withFileMutationQueue(factsFile(), () => withLock(factsFile(), () => {
          const raw = readText(factsFile());
          const facts = parseFacts(raw);
          if (params.replaces && !currentFacts(facts).some((fact) => fact.id === params.replaces)) throw new Error(`只能替代当前事实；${params.replaces} 不存在或已被替代。`);
          const id = nextFactId(facts);
          const title = compact(params.fact.replace(/\s+/g, " "), 56);
          const entry = [
            `## ${id} | ${title} ${tags.map((tag) => `#${tag}`).join(" ")}`,
            `> Verified: ${today()} | TTL: ${params.ttlDays ?? (params.type === "constraint" ? 90 : 30)}d`,
            `> Type: ${params.type} | Priority: ${params.priority ?? "normal"}${params.replaces ? ` | Replaces: ${params.replaces}` : ""}`,
            `> Source: ${params.source.trim()}`,
            `- ${params.fact.trim()}`,
          ].join("\n");
          const next = `${raw.trimEnd() || "# 稳定事实"}\n\n${entry}\n`;
          validateFacts(next);
          writeAtomically(factsFile(), next);
          return { content: [{ type: "text", text: `已保存 ${id}（${tags.map((tag) => `#${tag}`).join(" ")}）。` }], details: { id, projectKey: location!.projectKey, kind: location!.kind } };
        }));
      },
    });
    pi.registerTool({
      name: "memory-review",
      label: "Memory Review",
      description: "查看低噪声候选观察；候选不会自动成为长期事实。",
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        requireSessionProject(ctx);
        const raw = readText(inboxFile());
        const risk = findContentRisk(raw);
        if (risk) return { content: [{ type: "text", text: wrap("project_memory_candidates", `⚠ 已阻止加载候选观察：检测到 ${risk}。`, 2400) }], details: { blocked: true, count: 0 } };
        const items = observations(inboxFile());
        const candidates = items.filter((item) => item.category === "distilled");
        const auditCount = items.length - candidates.length;
        if (!items.length) return { content: [{ type: "text", text: wrap("project_memory_candidates", "没有待审核的候选观察。", 2400) }], details: { count: 0, auditCount: 0 } };
        const lines = candidates.map((item) => `- ${item.ts} | ${item.summary}`);
        const footer = auditCount ? `\n\n（另有 ${auditCount} 条审计事件未显示，不参与审核。）` : "";
        return { content: [{ type: "text", text: wrap("project_memory_candidates", lines.length ? lines.join("\n") + footer : "没有待审核的蒸馏候选。", 2400) }], details: { count: candidates.length, auditCount } };
      },
    });
    pi.registerTool({
      name: "memory-distill",
      label: "Memory Distill",
      description: "从最近会话文本提取候选记忆（事实/决策/约束/失败模式）写入待审 INBOX，供 memory-review 审核后决定是否入库。需要当前模型可用；无模型或失败时安全跳过，不影响主流程。",
      promptSnippet: "Distill recent conversation into memory review candidates",
      promptGuidelines: ["Use memory-distill at task wrap-up or before compaction to surface candidate memories; candidates never auto-enter FACTS."],
      parameters: Type.Object({
        maxItems: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
      }),
      executionMode: "sequential",
      async execute(_id, params, _signal, _onUpdate, ctx) {
        requireSessionProject(ctx);
        const model = (ctx as any)?.model;
        const registry = (ctx as any)?.modelRegistry;
        if (!model || !registry || typeof registry.getApiKeyAndHeaders !== "function") {
          return { content: [{ type: "text", text: "当前会话无可用模型，蒸馏已跳过（候选不会自动成为事实）。" }], details: { skipped: "no-model" } };
        }
        const branch = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries?.() ?? [];
        const parts: string[] = [];
        for (const entry of [...branch].slice(-20)) {
          if (entry?.type !== "message") continue;
          const msg = entry.message;
          if (!msg || !("role" in msg)) continue;
          // 只蒸馏 user/assistant 纯文本；跳过 system（记忆注入、指令）与工具消息，避免状态快照/工具输出被当作事实。
          if (msg.role !== "user" && msg.role !== "assistant") continue;
          const text = (Array.isArray(msg.content) ? msg.content : []).filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("\n").trim();
          if (!text) continue;
          parts.push(`${msg.role === "user" ? "用户" : "助手"}: ${text.slice(0, 1200)}`);
        }
        if (!parts.length) return { content: [{ type: "text", text: "当前会话没有可蒸馏的文本消息。" }], details: { skipped: "no-text" } };
        const conversation = parts.join("\n\n").slice(-8000);
        let completeFn: ((model: any, context: any, options: any) => Promise<any>) | undefined;
        try {
          const compat = await import("@earendil-works/pi-ai/compat");
          completeFn = (compat as any)?.complete;
        } catch { /* module unavailable */ }
        if (typeof completeFn !== "function") return { content: [{ type: "text", text: "蒸馏模块不可用，已跳过；不影响主流程。" }], details: { skipped: "module-unavailable" } };
        let auth: any;
        try { auth = await registry.getApiKeyAndHeaders(model); } catch { return { content: [{ type: "text", text: "获取模型凭据失败，蒸馏已跳过。" }], details: { skipped: "auth-failed" } }; }
        if (!auth?.ok || !auth?.apiKey) return { content: [{ type: "text", text: "未取得模型凭据，蒸馏已跳过。" }], details: { skipped: "no-credentials" } };
        const systemPrompt = `你是记忆提炼器。从对话中提取值得长期记忆的候选（已验证事实、决策、约束、失败模式）。规则：1) 每条候选独立、自包含，在未来会话单独成立；2) 只提取可复用的结论，忽略客套、临时操作细节；3) 拒绝提取：文件路径、行数、命令、工具名、目录/文件清单、会话元观察（本对话正在做什么）、执行步骤描述、时间戳；4) 保留原文语言；5) 绝不提取密钥、令牌、密码、私钥、Cookie 或配对码。只输出 JSON：{"facts": ["候选1", "候选2"]}，最多 ${params.maxItems ?? 3} 条；没有则 {"facts": []}。`;
        let response: any;
        try {
          response = await completeFn(model, {
            systemPrompt,
            messages: [{ role: "user", content: [{ type: "text", text: conversation }], timestamp: Date.now() }],
          }, { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal: _signal, cacheRetention: "none" });
        } catch { return { content: [{ type: "text", text: "蒸馏调用失败，已跳过；不影响主流程。" }], details: { skipped: "llm-failed" } }; }
        if (response?.stopReason === "aborted") return { content: [{ type: "text", text: "蒸馏已中止。" }], details: { skipped: "aborted" } };
        const text = (Array.isArray(response?.content) ? response.content : []).filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("\n").trim();
        let candidates: string[] = [];
        try {
          const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
          candidates = Array.isArray(parsed?.facts) ? parsed.facts.filter((f: any) => typeof f === "string" && f.trim().length >= 8).map((f: string) => f.trim().slice(0, 200)) : [];
        } catch { /* unparsable output */ }
        if (!candidates.length) return { content: [{ type: "text", text: "蒸馏未提取到合格候选。" }], details: { count: 0 } };
        let added = 0;
        for (const candidate of candidates.slice(0, params.maxItems ?? 3)) {
          await appendObservation(inboxFile(), { ts: timestamp(), category: "distilled", summary: candidate });
          added++;
        }
        return { content: [{ type: "text", text: `已写入 ${added} 条蒸馏候选到待审 INBOX；可调用 memory-review 审核后决定是否入库。` }], details: { count: added } };
      },
    });
  }

  function registerGlobalTools(): void {
    if (globalToolsRegistered) return;
    globalToolsRegistered = true;
    const confirmWrite = async (ctx: any, title: string, detail: string): Promise<void> => {
      requireSessionProject(ctx);
      if (ctx?.hasUI !== true || typeof ctx?.ui?.confirm !== "function") throw new Error("全局偏好和项目关联只能在可交互会话中，由用户确认后写入。");
      if (!await ctx.ui.confirm(title, detail)) throw new Error("用户取消了全局记忆写入。");
    };
    if (!pi.getAllTools().some((tool) => tool.name === "memory-preference-save")) pi.registerTool({
      name: "memory-preference-save",
      label: "Memory Preference Save",
      description: "保存经用户确认的跨项目协作偏好；不能保存项目事实、状态、配置或凭据。",
      promptSnippet: "Save a user-confirmed global preference without project facts or secrets",
      promptGuidelines: ["Use memory-preference-save only for a user-confirmed language, output-style, workflow, or approval-policy preference that applies across projects."],
      parameters: Type.Object({
        category: StringEnum(["language", "output-style", "workflow", "approval-policy"] as const),
        preference: Type.String({ minLength: 4, maxLength: 320, pattern: "^[^\\r\\n]+$" }),
        tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 32 }), { maxItems: 8 })),
        ttlDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
        priority: Type.Optional(StringEnum(["normal", "pinned"] as const)),
      }),
      executionMode: "sequential",
      async execute(_id, params, _signal, _onUpdate, ctx) {
        requireSingleLine("preference", params.preference);
        requireSafe(params.preference);
        const tags = normalizeTags(params.tags ?? []);
        await confirmWrite(ctx, "保存跨项目偏好", `分类：${params.category}\n偏好：${params.preference}\n这不会保存任何项目状态或配置。确认后将供所有项目按规则使用。`);
        return withFileMutationQueue(PREFERENCES_FILE, () => withLock(PREFERENCES_FILE, () => {
          const entries = parseJsonEntries<unknown>(PREFERENCES_FILE).filter(isPreference);
          const entry: GlobalPreference = { id: nextScopedId("P", entries), category: params.category, preference: params.preference.trim(), tags, verified: today(), ttlDays: params.ttlDays ?? 180, priority: params.priority ?? "pinned" };
          writeJsonEntries(PREFERENCES_FILE, [...entries, entry].slice(-MAX_GLOBAL_PREFERENCES));
          return { content: [{ type: "text", text: `已保存全局偏好 ${entry.id}；它与项目事实严格分离。` }], details: { id: entry.id, scope: "global-preference", category: entry.category } };
        }));
      },
    });
    if (!pi.getAllTools().some((tool) => tool.name === "memory-preference-recall")) pi.registerTool({
      name: "memory-preference-recall",
      label: "Memory Preference Recall",
      description: "读取经用户确认的跨项目协作偏好；返回内容不是项目事实。",
      parameters: Type.Object({
        categories: Type.Optional(Type.Array(StringEnum(["language", "output-style", "workflow", "approval-policy"] as const), { maxItems: 4 })),
        tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 32 }), { maxItems: 8 })),
        maxItems: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        requireSessionProject(ctx);
        const tags = normalizeTags(params.tags ?? []);
        const entries = globalPreferences().filter((item) => (!params.categories?.length || params.categories.includes(item.category)) && (!tags.length || item.tags.some((tag) => tags.includes(tag)))).sort((a, b) => a.priority !== b.priority ? (a.priority === "pinned" ? -1 : 1) : b.verified.localeCompare(a.verified)).slice(0, params.maxItems ?? 5);
        const body = entries.length ? entries.map((item) => `- [${item.id}] ${item.category}: ${item.preference}（有效至 ${expiryDate(item.verified, item.ttlDays)}）`).join("\n") : "没有匹配的有效全局偏好。";
        return { content: [{ type: "text", text: wrap("global_preferences", `以下是用户偏好，不是项目事实：\n${body}`, 1800) }], details: { scope: "global-preference", preferenceIds: entries.map((item) => item.id) } };
      },
    });
    if (!pi.getAllTools().some((tool) => tool.name === "memory-preference-remove")) pi.registerTool({
      name: "memory-preference-remove",
      label: "Memory Preference Remove",
      description: "经用户确认后删除一条跨项目偏好。",
      parameters: Type.Object({ id: Type.String({ pattern: "^P-[0-9]{3,}$" }) }),
      executionMode: "sequential",
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const entries = parseJsonEntries<unknown>(PREFERENCES_FILE).filter(isPreference);
        const target = entries.find((item) => item.id === params.id);
        if (!target) throw new Error(`未找到全局偏好 ${params.id}。`);
        await confirmWrite(ctx, "删除跨项目偏好", `将删除 ${target.id}: ${target.preference}`);
        return withFileMutationQueue(PREFERENCES_FILE, () => withLock(PREFERENCES_FILE, () => {
          writeJsonEntries(PREFERENCES_FILE, parseJsonEntries<unknown>(PREFERENCES_FILE).filter(isPreference).filter((item) => item.id !== params.id));
          return { content: [{ type: "text", text: `已删除全局偏好 ${params.id}。` }], details: { id: params.id, scope: "global-preference" } };
        }));
      },
    });
    if (!pi.getAllTools().some((tool) => tool.name === "memory-link-save")) pi.registerTool({
      name: "memory-link-save",
      label: "Memory Link Save",
      description: "经用户确认，保存当前项目与另一项目间的最小关联摘要；不会复制任一项目的 STATUS 或 FACTS。",
      promptSnippet: "Save a user-confirmed minimal cross-project relationship summary",
      promptGuidelines: ["Use memory-link-save only after the user explicitly approves a minimal shared summary; never copy another project's STATUS.md or FACTS.md."],
      parameters: Type.Object({
        targetProjectRoot: Type.String({ minLength: 1, maxLength: 500, pattern: "^[^\\r\\n]+$" }),
        relation: StringEnum(["shared-component", "shared-goal", "dependency", "reference"] as const),
        direction: Type.Optional(StringEnum(["one-way", "two-way"] as const)),
        summary: Type.String({ minLength: 12, maxLength: 360, pattern: "^[^\\r\\n]+$" }),
        tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 32 }), { maxItems: 8 })),
        ttlDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
      }),
      executionMode: "sequential",
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const current = requireSessionProject(ctx);
        requireSingleLine("targetProjectRoot", params.targetProjectRoot);
        requireSingleLine("summary", params.summary);
        requireSafe(`${params.targetProjectRoot}\n${params.summary}`);
        const targetRoot = projectRootFor(resolve(params.targetProjectRoot));
        const targetKey = projectKeyFor(targetRoot);
        if (targetKey === current.projectKey) throw new Error("项目关联的目标不能是当前项目。");
        const tags = normalizeTags(params.tags ?? []);
        const direction = params.direction ?? "one-way";
        await confirmWrite(ctx, "保存项目关联摘要", `来源：${projectLabel(current.projectRoot)}\n目标：${projectLabel(targetRoot)}\n关系：${params.relation}（${direction}）\n摘要：${params.summary}\n不会读取或复制任一项目的事实/状态。`);
        return withFileMutationQueue(LINKS_FILE, () => withLock(LINKS_FILE, () => {
          const entries = parseJsonEntries<unknown>(LINKS_FILE).filter(isProjectLink);
          const entry: ProjectLink = { id: nextScopedId("L", entries), fromProjectKey: current.projectKey, fromProjectRoot: pathKey(current.projectRoot), toProjectKey: targetKey, toProjectRoot: pathKey(targetRoot), relation: params.relation, direction, summary: params.summary.trim(), tags, approved: today(), ttlDays: params.ttlDays ?? 90 };
          writeJsonEntries(LINKS_FILE, [...entries, entry].slice(-MAX_PROJECT_LINKS));
          return { content: [{ type: "text", text: `已保存项目关联 ${entry.id}；它仅可按需读取最小摘要。` }], details: { id: entry.id, scope: "project-link", fromProjectKey: entry.fromProjectKey, toProjectKey: entry.toProjectKey } };
        }));
      },
    });
    if (!pi.getAllTools().some((tool) => tool.name === "memory-link-recall")) pi.registerTool({
      name: "memory-link-recall",
      label: "Memory Link Recall",
      description: "按需读取当前项目可访问的、未过期的项目关联最小摘要；不会读取关联项目的事实或状态。",
      parameters: Type.Object({
        linkId: Type.Optional(Type.String({ pattern: "^L-[0-9]{3,}$" })),
        tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 32 }), { maxItems: 8 })),
        maxItems: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        requireSessionProject(ctx);
        const tags = normalizeTags(params.tags ?? []);
        const entries = applicableLinks().filter((item) => (!params.linkId || item.id === params.linkId) && (!tags.length || item.tags.some((tag) => tags.includes(tag)))).slice(0, params.maxItems ?? 3);
        const body = entries.length ? entries.map((item) => `- [${item.id}] ${projectLabel(item.fromProjectRoot)} → ${projectLabel(item.toProjectRoot)} | ${item.relation} | ${item.direction}\n  摘要：${item.summary}\n  有效至：${expiryDate(item.approved, item.ttlDays)}`).join("\n") : "没有当前项目可访问的有效关联摘要。";
        return { content: [{ type: "text", text: wrap("linked_project_context", `以下是显式批准的最小关联摘要，不是其他项目的事实、状态或配置；不得据此推断未提供的内容。\n${body}`, 2200) }], details: { scope: "project-link", linkIds: entries.map((item) => item.id), projectKey: location!.projectKey } };
      },
    });
    if (!pi.getAllTools().some((tool) => tool.name === "memory-link-remove")) pi.registerTool({
      name: "memory-link-remove",
      label: "Memory Link Remove",
      description: "经用户确认后删除当前项目可访问的一条项目关联。",
      parameters: Type.Object({ id: Type.String({ pattern: "^L-[0-9]{3,}$" }) }),
      executionMode: "sequential",
      async execute(_id, params, _signal, _onUpdate, ctx) {
        requireSessionProject(ctx);
        const entries = parseJsonEntries<unknown>(LINKS_FILE).filter(isProjectLink);
        const target = entries.find((item) => item.id === params.id);
        if (!target || !applicableLinks().some((item) => item.id === params.id)) throw new Error(`当前项目不可删除关联 ${params.id}。`);
        await confirmWrite(ctx, "删除项目关联", `将删除 ${target.id}: ${projectLabel(target.fromProjectRoot)} → ${projectLabel(target.toProjectRoot)}\n摘要：${target.summary}`);
        return withFileMutationQueue(LINKS_FILE, () => withLock(LINKS_FILE, () => {
          writeJsonEntries(LINKS_FILE, parseJsonEntries<unknown>(LINKS_FILE).filter(isProjectLink).filter((item) => item.id !== params.id));
          return { content: [{ type: "text", text: `已删除项目关联 ${params.id}。` }], details: { id: params.id, scope: "project-link" } };
        }));
      },
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    location = resolveLocation(ctx.cwd, trustedFor(ctx));
    delegated = isProjectMemoryGuard(ctx.cwd, pi.getAllTools() as ToolMeta[]);
    registerStatusTool();
    registerGlobalTools();
    if (!delegated) registerProjectTools();
    const hf = handoffFile();
    if (existsSync(hf) && !readHandoffIfFresh()) { try { unlinkSync(hf); } catch { /* stale handoff cleanup */ } }
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (!location || !isSubstantive(event.prompt)) return;
    if (!matchesSessionProject(ctx)) {
      return { message: { customType: "project-memory-boundary", content: wrap("project_memory_boundary", `检测到工作目录已从 ${projectLabel(location.projectRoot)} 切换。旧会话可能仍保留先前项目上下文；为避免混淆，本次不会加载或写入项目记忆。请在新项目根目录新建会话后继续。`, 500), display: false, details: { source: "global-memory-guard", sessionId: ctx.sessionManager.getSessionId?.(), previousProjectKey: location.projectKey } } };
    }
    const preferences = buildGlobalPreferencesBrief();
    if (delegated) {
      if (!preferences || hasCustomMessage(ctx, "global-memory-preferences")) return;
      return { message: { customType: "global-memory-preferences", content: preferences, display: false, details: { source: "global-memory-guard", sessionId: ctx.sessionManager.getSessionId?.(), scope: "global-preference" } } };
    }
    const projectBrief = buildBrief(event.prompt);
    const content = preferences ? `${projectBrief}\n\n${preferences}` : projectBrief;
    const handoff = readHandoffIfFresh();
    if (handoff && !hasBriefWithHandoff(ctx)) {
      const wrappedHandoff = wrap("project_memory_handoff", handoff, 500);
      return { message: { customType: "project-memory-brief", content: `${content}\n\n${wrappedHandoff}`, display: false, details: { source: "global-memory-guard", sessionId: ctx.sessionManager.getSessionId?.(), schemaVersion: MEMORY_SCHEMA_VERSION, projectKey: location.projectKey, handoff: true } } };
    }
    if (hasBrief(ctx)) return;
    return { message: { customType: "project-memory-brief", content, display: false, details: { source: "global-memory-guard", sessionId: ctx.sessionManager.getSessionId?.(), schemaVersion: MEMORY_SCHEMA_VERSION, projectKey: location.projectKey } } };
  });
  pi.on("session_before_compact", async (event) => {
    if (!location || delegated) return;
    try {
      const reason = event.reason ?? "compact";
      const content = buildHandoff(reason);
      writeAtomically(handoffFile(), `<!-- HANDOFF ${timestamp()} [compact:${reason}] -->\n${content}`);
    } catch { /* Handoff never interrupts compaction. */ }
  });
  pi.on("tool_result", async (event) => {
    if (!location || delegated || event.toolName.startsWith("memory-")) return;
    try {
      if (event.isError) {
        const errorText = (event.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text ?? "").join(" ").replace(/\n+/g, " ").trim();
        const inputHint = event.toolName === "bash" && typeof (event.input as any).command === "string"
          ? compact(String((event.input as any).command).replace(/\n+/g, " "), 60)
          : (event.toolName === "edit" || event.toolName === "write" || event.toolName === "read") && typeof (event.input as any).path === "string"
            ? String((event.input as any).path) : "";
        // 降噪：bash 非零退出常为合法语义（grep 无匹配、which/test 探活、wc 通配符无命中）。
        // 仅当错误文本含真实错误信号才记录；edit/write/read 失败照记（路径+错误）。
        if (event.toolName === "bash") {
          if (!errorText || !/error|fail|denied|no such|not found|exception|EACCES|ENOENT|EADDR|timed? ?out|unexpected/i.test(errorText)) return;
        }
        ensureProjectMeta(location);
        return await appendObservation(inboxFile(), { ts: timestamp(), category: "tool_failure", summary: `工具失败: ${event.toolName}${inputHint ? ` [${inputHint}]` : ""}${errorText ? ` - ${compact(errorText, 80)}` : ""}` });
      }
      if ((event.toolName === "edit" || event.toolName === "write") && typeof (event.input as any).path === "string") {
        const path = String((event.input as any).path).replace(/\\/g, "/");
        if (/(^|\/)(AGENTS\.md|package\.json|\.pi\/)/i.test(path)) { ensureProjectMeta(location); await appendObservation(inboxFile(), { ts: timestamp(), category: "config_change", summary: `关键配置修改: ${path}` }); }
      }
    } catch { /* Memory observation never interrupts the primary tool flow. */ }
  });
  pi.registerCommand("memory-project", {
    description: "显示当前项目的全局路由记忆状态",
    handler: async (_args, ctx) => {
      if (!location) return;
      const parsed = parseFacts(readText(factsFile()));
      const active = activeFacts(parsed).length;
      const stale = currentFacts(parsed).filter((fact) => isExpired(fact.verified, fact.ttlDays)).length;
      ctx.ui.notify(`Memory ${location.kind}: ${active} 条有效事实，${stale} 条待复核；${relative(AGENT_HOME, location.memoryDir) || location.memoryDir}`, "info");
    },
  });
}
