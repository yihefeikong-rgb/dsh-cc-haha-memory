// src/index.ts
import z from "@deepseek-ai/schemastery";

// src/store.ts
import { mkdir, readFile, writeFile, readdir, stat, rename, unlink } from "node:fs/promises";
import { join as join2, basename as basename2, dirname as dirname2, isAbsolute, relative, resolve as resolve2, sep as sep2 } from "node:path";
import { homedir as homedir2 } from "node:os";

// src/scope.ts
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { homedir } from "node:os";
var REGISTRY_FILE = ".projects.json";
var GENERAL_SCOPE = "\u901A\u7528";
function canonicalPath(path) {
  try {
    return normalize(realpathSync(path)).replace(/[\\/]+$/, "").toLowerCase();
  } catch {
    return normalize(resolve(path)).replace(/[\\/]+$/, "").toLowerCase();
  }
}
function findProjectRoot(cwd) {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}
function sanitizeScopeName(value) {
  let cleaned = String(value ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 64);
  if (cleaned.startsWith(".")) cleaned = `dot-${cleaned.replace(/^\.+/, "") || "project"}`;
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "project";
}
function isSafeScopeName(value) {
  return typeof value === "string" && value.length > 0 && value === sanitizeScopeName(value) && !value.startsWith(".") && !value.includes("/") && !value.includes("\\");
}
function loadRegistry(memoryRoot) {
  try {
    const parsed = JSON.parse(readFileSync(join(memoryRoot, REGISTRY_FILE), "utf8"));
    return parsed?.version === 1 && parsed.paths && typeof parsed.paths === "object" ? parsed : { version: 1, paths: {} };
  } catch {
    return { version: 1, paths: {} };
  }
}
function saveRegistry(memoryRoot, registry) {
  mkdirSync(memoryRoot, { recursive: true });
  const target = join(memoryRoot, REGISTRY_FILE);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, JSON.stringify(registry, null, 2), "utf8");
  renameSync(temp, target);
}
function existingScope(memoryRoot, name2) {
  try {
    return readdirSync(memoryRoot, { withFileTypes: true }).find((entry) => entry.isDirectory() && entry.name.toLowerCase() === name2.toLowerCase())?.name;
  } catch {
    return void 0;
  }
}
function resolveProjectScope(memoryRoot, cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) return null;
  const root = findProjectRoot(cwd.trim());
  const key = canonicalPath(root);
  const registry = loadRegistry(memoryRoot);
  const mapped = registry.paths[key];
  if (isSafeScopeName(mapped)) return mapped;
  const base = sanitizeScopeName(basename(root));
  const usedByOtherPath = Object.entries(registry.paths).some(([path, scope2]) => path !== key && String(scope2).toLowerCase() === base.toLowerCase());
  let scope = base;
  const unownedExisting = existingScope(memoryRoot, base);
  if (scope === GENERAL_SCOPE || usedByOtherPath || unownedExisting) {
    const suffix = createHash("sha256").update(key).digest("hex").slice(0, 8);
    scope = `${base}-${suffix}`;
  }
  registry.paths[key] = scope;
  saveRegistry(memoryRoot, registry);
  return scope;
}
function seedClaudeProjectMappings(memoryRoot, claudeProjectsRoot = join(homedir(), ".claude", "projects")) {
  const registry = loadRegistry(memoryRoot);
  let changed = false;
  let projects = [];
  try {
    projects = readdirSync(claudeProjectsRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = join(claudeProjectsRoot, project.name);
    let sessions = [];
    try {
      sessions = readdirSync(projectDir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).slice(0, 5);
    } catch {
      continue;
    }
    for (const session of sessions) {
      const cwd = readSessionCwd(join(projectDir, session.name));
      if (!cwd) continue;
      const root = findProjectRoot(cwd);
      const key = canonicalPath(root);
      if (isSafeScopeName(registry.paths[key])) break;
      const base = sanitizeScopeName(basename(root));
      const existing = existingScope(memoryRoot, base);
      if (!existing) break;
      const claimed = Object.entries(registry.paths).some(([path, scope]) => path !== key && String(scope).toLowerCase() === existing.toLowerCase());
      if (!claimed && existing !== GENERAL_SCOPE) {
        registry.paths[key] = existing;
        changed = true;
      }
      break;
    }
  }
  if (changed) saveRegistry(memoryRoot, registry);
  return changed ? 1 : 0;
}
function readSessionCwd(path) {
  try {
    const lines = readFileSync(path, "utf8").split(/\r?\n/).slice(0, 100);
    for (const line of lines) {
      if (!line.includes("cwd")) continue;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed?.cwd === "string" && parsed.cwd.trim()) return parsed.cwd.trim();
      } catch {
      }
    }
  } catch {
  }
  return null;
}
function scopesForCwd(memoryRoot, cwd) {
  const project = resolveProjectScope(memoryRoot, cwd);
  return project ? [GENERAL_SCOPE, project] : [GENERAL_SCOPE];
}
function topScopeFromId(id) {
  const normalized = String(id ?? "").replace(/\\/g, "/");
  return normalized.includes("/") ? normalized.split("/")[0] : "";
}

// src/store.ts
var TYPE_ORDER = [
  ["user", "\u7528\u6237\u753B\u50CF"],
  ["feedback", "\u53CD\u9988"],
  ["project", "\u9879\u76EE\u72B6\u6001"],
  ["reference", "\u5DE5\u5177\u53C2\u8003"],
  ["archive", "\u5F52\u6863"]
];
var MEMORY_TYPES = ["user", "feedback", "project", "reference", "archive"];
var INDEX_HISTORY_KEEP = 20;
var INDEX_FILE = "MEMORY.md";
function defaultStorageDir() {
  return join2(homedir2(), ".dsh", "memory");
}
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value === "null") value = null;
    meta[key] = value;
  }
  return { meta, body: text.slice(match[0].length) };
}
function serializeMemory(memory) {
  const lines = ["---"];
  if (memory.name) lines.push(`name: ${frontmatterLine(memory.name)}`);
  if (memory.description) lines.push(`description: ${frontmatterLine(memory.description)}`);
  if (memory.type) lines.push(`type: ${frontmatterLine(memory.type)}`);
  if (memory.created) lines.push(`created: ${frontmatterLine(memory.created)}`);
  if (memory.updated) lines.push(`updated: ${frontmatterLine(memory.updated)}`);
  if (Array.isArray(memory.tags) && memory.tags.length > 0) {
    lines.push(`tags: [${memory.tags.map((t) => `"${String(t).replaceAll('"', '\\"')}"`).join(", ")}]`);
  }
  if (memory.source) lines.push(`source: ${frontmatterLine(memory.source)}`);
  lines.push("---", "");
  const body = typeof memory.content === "string" ? memory.content : "";
  return lines.join("\n") + body + (body.endsWith("\n") ? "" : "\n");
}
function frontmatterLine(value) {
  return String(value ?? "").replace(/\r?\n/g, " ").trim();
}
function normalizeMemoryTitle(value) {
  return frontmatterLine(value);
}
function slugify(title) {
  const cleaned = String(title ?? "untitled").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48);
  return cleaned || "untitled";
}
var MemoryStore = class {
  constructor(root) {
    this.root = resolve2(root);
    this.writeQueue = Promise.resolve();
  }
  /** 记忆文件绝对路径。id 即文件名(不含 .md)。 */
  pathOf(id) {
    const safeId = normalizeId(id);
    const abs = resolve2(this.root, `${safeId}.md`);
    if (!isWithin(this.root, abs)) throw new Error("\u8BB0\u5FC6\u8DEF\u5F84\u8D8A\u754C");
    return abs;
  }
  async ensureDirs() {
    const dirs = [this.root, join2(this.root, ".history")];
    for (const d of dirs) await mkdir(d, { recursive: true });
  }
  /** 列出所有记忆文件(不含 imported 内部结构,含子目录),返回 {id, absPath}。 */
  async scan(opts = {}) {
    const allowedScopes = normalizeScopes(opts.scopes);
    const found = [];
    const walk = async (dir) => {
      let entries = [];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name === INDEX_FILE || e.name === ".history" || e.name === "IMPORTED.md") continue;
        const abs = join2(dir, e.name);
        if (e.isDirectory()) await walk(abs);
        else if (e.isFile() && e.name.endsWith(".md")) {
          const id = relative(this.root, abs).replace(/\.md$/i, "").split(sep2).join("/");
          if (!allowedScopes || allowedScopes.has(topScopeFromId(id))) found.push({ id, abs });
        }
      }
    };
    await walk(this.root);
    return found;
  }
  /** 读单条记忆(含 frontmatter 元数据)。id 支持相对路径或文件名。 */
  async get(id, opts = {}) {
    const normalizedId = normalizeId(id);
    const files = await this.scan({ scopes: opts.scopes });
    const exact = files.find((f) => f.id === normalizedId);
    const matches = exact ? [exact] : files.filter((f) => f.id.endsWith(`/${normalizedId}`) || basename2(f.abs, ".md") === normalizedId);
    if (matches.length !== 1) return null;
    const abs = matches[0].abs;
    let text;
    try {
      text = await readFile(abs, "utf8");
    } catch {
      return null;
    }
    const { meta, body } = parseFrontmatter(text);
    return {
      id: matches[0].id,
      name: meta.name ?? basename2(abs, ".md"),
      description: meta.description ?? "",
      type: meta.type ?? "reference",
      tags: parseTags(meta.tags),
      created: meta.created ?? "",
      updated: meta.updated ?? "",
      source: meta.source ?? "",
      content: body.trim(),
      path: abs
    };
  }
  /** 写入记忆。顶层目录表示作用域；默认写入通用，禁止静默覆盖。 */
  async write(input, opts = {}) {
    return this.withWriteLock(async () => {
      await this.ensureDirs();
      const type = MEMORY_TYPES.includes(input.type) ? input.type : "reference";
      const scope = validateScope(opts.scope ?? GENERAL_SCOPE);
      const id = slugify(opts.id ?? input.title);
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const memory = {
        name: input.title,
        description: input.description ?? "",
        type,
        created: input.created ?? now,
        updated: now,
        tags: Array.isArray(input.tags) ? input.tags.filter(Boolean).map(String) : [],
        source: input.source ?? "",
        content: input.content ?? ""
      };
      const dir = resolve2(this.root, scope);
      if (!isWithin(this.root, dir)) throw new Error("\u8BB0\u5FC6\u4F5C\u7528\u57DF\u8D8A\u754C");
      await mkdir(dir, { recursive: true });
      const abs = resolve2(dir, `${id}.md`);
      if (!isWithin(dir, abs)) throw new Error("\u8BB0\u5FC6\u8DEF\u5F84\u8D8A\u754C");
      const existing = await readFile(abs, "utf8").catch(() => null);
      if (existing !== null && opts.overwrite !== true) {
        const error = new Error(`\u540C\u540D\u8BB0\u5FC6\u5DF2\u5B58\u5728: ${scope}/${id}`);
        error.code = "MEMORY_CONFLICT";
        throw error;
      }
      await atomicWrite(abs, serializeMemory(memory));
      await this.refreshIndexUnlocked();
      const relId = relative(this.root, abs).replace(/\.md$/i, "").split(sep2).join("/");
      return { id: relId, scope, path: abs, ...memory };
    });
  }
  /** 更新记忆:先存历史版本再覆盖。 */
  async update(id, patch) {
    return this.withWriteLock(async () => {
      const existing = await this.get(id, { scopes: patch.scopes });
      if (!existing) return null;
      if (existing.content.trim() || existing.name) await this.saveHistory(existing.id, existing);
      const next = {
        ...existing,
        name: patch.title ?? existing.name,
        description: patch.description !== void 0 ? patch.description : existing.description,
        type: patch.type !== void 0 && MEMORY_TYPES.includes(patch.type) ? patch.type : existing.type,
        tags: patch.tags !== void 0 ? patch.tags.filter(Boolean).map(String) : existing.tags,
        content: patch.content !== void 0 ? patch.content : existing.content,
        updated: (/* @__PURE__ */ new Date()).toISOString()
      };
      await atomicWrite(existing.path, serializeMemory(next));
      await this.refreshIndexUnlocked();
      return { id: existing.id, ...next, path: existing.path };
    });
  }
  /** 删除记忆。 */
  async remove(id, opts = {}) {
    return this.withWriteLock(async () => {
      const existing = await this.get(id, { scopes: opts.scopes });
      if (!existing) return false;
      await this.saveHistory(existing.id, existing);
      await unlink(existing.path);
      await this.refreshIndexUnlocked();
      return true;
    });
  }
  /** 保存历史版本到 .history/。 */
  async saveHistory(id, memory) {
    const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
    const safeId = String(id).replace(/[\\/:*?"<>|]/g, "_");
    const abs = join2(this.root, ".history", `${safeId}.${ts}.md`);
    const text = await readFile(memory.path, "utf8").catch(() => serializeMemory(memory));
    await writeFile(abs, text, "utf8");
  }
  /**
   * 索引备份:MEMORY.md 每次写入都是原子覆盖,而 dsh-memory 和 dsh-dream
   * 都会重建它 —— 一旦写坏没有任何回退点。覆盖前把**旧内容**best-effort
   * 备份到 .history/_index/MEMORY.md.<ISO>.md,内容与上一份相同则不产生新文件,
   * 只保留最近 INDEX_HISTORY_KEEP 份。备份失败绝不影响主流程。
   */
  async backupIndexUnlocked(previous) {
    try {
      if (!previous || !previous.trim()) return;
      const dir = join2(this.root, ".history", "_index");
      await mkdir(dir, { recursive: true });
      const list = async () => (await readdir(dir)).filter((f) => f.startsWith(`${INDEX_FILE}.`)).sort();
      const before = await list();
      const newest = before.length ? await readFile(join2(dir, before[before.length - 1]), "utf8").catch(() => "") : "";
      if (newest !== previous) {
        const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
        await writeFile(join2(dir, `${INDEX_FILE}.${ts}.md`), previous, "utf8");
      }
      const after = await list();
      for (const stale of after.slice(0, Math.max(0, after.length - INDEX_HISTORY_KEEP))) {
        await unlink(join2(dir, stale)).catch(() => {
        });
      }
    } catch {
    }
  }
  /** 全文关键词搜索:标题/描述/内容分词评分。 */
  async search(query, opts = {}) {
    const q = String(query ?? "").trim().toLowerCase();
    if (!q) return [];
    const limit = Math.min(opts.limit ?? 10, 50);
    const terms = [...new Set(q.split(/\s+/).filter(Boolean))];
    const files = await this.scan({ scopes: opts.scopes });
    const scored = [];
    for (const { id, abs } of files) {
      let text;
      try {
        text = await readFile(abs, "utf8");
      } catch {
        continue;
      }
      const { meta } = parseFrontmatter(text);
      if (opts.type && meta.type !== opts.type) continue;
      const title = meta.name ?? id;
      const description = meta.description ?? "";
      const body = text.slice(0, 4e3);
      const hayTitle = title.toLowerCase();
      const hayDesc = description.toLowerCase();
      const hayBody = body.toLowerCase();
      let score = 0;
      let hits = 0;
      for (const term of terms) {
        if (hayTitle.includes(term)) score += 5;
        if (hayDesc.includes(term)) score += 3;
        if (hayBody.includes(term)) score += 1;
        if (hayTitle.includes(term) || hayDesc.includes(term) || hayBody.includes(term)) hits++;
      }
      if (hits === terms.length && score > 0) {
        scored.push({
          id,
          title,
          description,
          type: meta.type ?? "reference",
          tags: parseTags(meta.tags),
          updated: meta.updated ?? "",
          score
        });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
  /** 从已有记忆收集标签频次,按输入文本相关性推荐。 */
  async suggestTags(text, limit = 5, opts = {}) {
    const files = await this.scan({ scopes: opts.scopes });
    const freq = /* @__PURE__ */ new Map();
    for (const { abs } of files) {
      const raw = await readFile(abs, "utf8").catch(() => "");
      const { meta } = parseFrontmatter(raw);
      for (const tag of parseTags(meta.tags)) {
        freq.set(tag, (freq.get(tag) ?? 0) + 1);
      }
    }
    const lower = String(text ?? "").toLowerCase();
    const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
    if (lower) {
      const matched = sorted.filter((t) => t.toLowerCase().includes(lower));
      const rest = sorted.filter((t) => !t.toLowerCase().includes(lower));
      return [...matched, ...rest].slice(0, limit);
    }
    return sorted.slice(0, limit);
  }
  /** 读索引文本。 */
  async readIndex() {
    try {
      return await readFile(join2(this.root, INDEX_FILE), "utf8");
    } catch {
      return "";
    }
  }
  /** 重建 MEMORY.md 索引(按顶层项目文件夹分节,条目 = - [title](rel) — desc)。 */
  async refreshIndex() {
    return this.withWriteLock(() => this.refreshIndexUnlocked());
  }
  async refreshIndexUnlocked() {
    await this.ensureDirs();
    const files = await this.scan();
    const groups = /* @__PURE__ */ new Map();
    for (const { id, abs } of files) {
      const text = await readFile(abs, "utf8").catch(() => "");
      const { meta } = parseFrontmatter(text);
      const rel = relative(this.root, abs).split(sep2).join("/");
      const topDir = rel.includes("/") ? rel.split("/")[0] : "(\u6839)";
      const entry = {
        title: meta.name ?? basename2(abs, ".md"),
        description: meta.description ?? "",
        type: meta.type ?? "reference",
        updated: meta.updated ?? "",
        rel
      };
      if (!groups.has(topDir)) groups.set(topDir, []);
      groups.get(topDir).push(entry);
    }
    const lines = ["# \u8BB0\u5FC6\u7D22\u5F15", "", `> \u81EA\u52A8\u751F\u6210,\u5171 ${files.length} \u6761\u8BB0\u5FC6\u3002`, ""];
    const ordered = [...groups.keys()].sort((a, b) => a === "\u901A\u7528" ? -1 : b === "\u901A\u7528" ? 1 : a.localeCompare(b, "zh"));
    for (const dir of ordered) {
      const entries = groups.get(dir);
      if (!entries?.length) continue;
      lines.push(`## ${dir}`, "");
      for (const [type, label] of TYPE_ORDER) {
        const typed = entries.filter((e) => (e.type ?? "reference") === type);
        if (!typed.length) continue;
        lines.push(`### ${label}`, "");
        for (const e of typed) {
          const hook = e.description ? ` \u2014 ${e.description}` : "";
          lines.push(`- [${e.title}](${e.rel})${hook}`);
        }
        lines.push("");
      }
    }
    await this.backupIndexUnlocked(await this.readIndex());
    await atomicWrite(join2(this.root, INDEX_FILE), lines.join("\n"));
  }
  /** 当前所有索引条目(按分类分节的结构化视图)。 */
  async indexEntries() {
    const text = await this.readIndex();
    const entries = [];
    let section = "\u672A\u5206\u7C7B";
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("## ")) section = line.slice(3).trim();
      const m = /^- \[(.+?)\]\((.+?)\)(?: — (.*))?$/.exec(line);
      if (m) {
        entries.push({ title: m[1], rel: m[2], description: m[3] ?? "", section });
      }
    }
    return entries;
  }
  async manifest(scopes) {
    const files = await this.scan({ scopes });
    const entries = [];
    for (const { id } of files) {
      const memory = await this.get(id, { scopes });
      if (!memory) continue;
      entries.push({ id: memory.id, title: memory.name, description: memory.description, type: memory.type, tags: memory.tags, updated: memory.updated });
    }
    return entries;
  }
  withWriteLock(operation) {
    const run = this.writeQueue.then(operation, operation);
    this.writeQueue = run.catch(() => {
    });
    return run;
  }
};
function normalizeScopes(scopes) {
  if (!Array.isArray(scopes)) return null;
  return new Set(scopes.map(validateScope));
}
function validateScope(scope) {
  if (!isSafeScopeName(scope)) throw new Error(`\u65E0\u6548\u8BB0\u5FC6\u4F5C\u7528\u57DF: ${scope}`);
  return scope;
}
function normalizeId(id) {
  const value = String(id ?? "").replace(/\\/g, "/").replace(/\.md$/i, "");
  if (!value || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("\u65E0\u6548\u8BB0\u5FC6 id");
  }
  return value;
}
function isWithin(root, target) {
  const rel = relative(resolve2(root), resolve2(target));
  return rel === "" || !rel.startsWith(`..${sep2}`) && rel !== ".." && !isAbsolute(rel);
}
async function atomicWrite(target, content) {
  await mkdir(dirname2(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, content, "utf8");
  try {
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {
    });
    throw error;
  }
}
function parseTags(raw) {
  if (Array.isArray(raw)) return raw.map(String);
  if (raw === null || raw === void 0 || raw === "") return [];
  const s = String(raw);
  if (s.startsWith("[") && s.endsWith("]")) {
    return s.slice(1, -1).split(",").map((t) => t.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")).filter(Boolean);
  }
  return [s];
}

// src/import.ts
import { readFile as readFile2, writeFile as writeFile2, mkdir as mkdir2, readdir as readdir2, stat as stat2, rename as rename2, unlink as unlink2 } from "node:fs/promises";
import { join as join3, basename as basename3, relative as relative2, sep as sep3 } from "node:path";
import { homedir as homedir3 } from "node:os";
var CLAUDE_PROJECTS = join3(homedir3(), ".claude", "projects");
var MARKER = "IMPORTED.md";
var GENERIC_SUBDIRS = /* @__PURE__ */ new Set(["\u901A\u7528\u57FA\u7EBF", "\u7528\u6237\u753B\u50CF", "\u901A\u7528"]);
async function findClaudeProjects(projectsRoot) {
  const projects = [];
  let entries;
  try {
    entries = await readdir2(projectsRoot, { withFileTypes: true });
  } catch {
    return projects;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const memRoot = join3(projectsRoot, e.name, "memory");
    try {
      await stat2(memRoot);
    } catch {
      continue;
    }
    const files = [];
    const walk = async (dir) => {
      let list;
      try {
        list = await readdir2(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const f of list) {
        if (f.name === "MEMORY.md") continue;
        const abs = join3(dir, f.name);
        if (f.isDirectory()) await walk(abs);
        else if (f.isFile() && f.name.endsWith(".md")) files.push(abs);
      }
    };
    await walk(memRoot);
    if (files.length > 0) projects.push({ dir: e.name, files });
  }
  return projects;
}
async function resolveProjectName(projectDir, projectsRoot = CLAUDE_PROJECTS) {
  const dir = join3(projectsRoot, projectDir);
  let entries;
  try {
    entries = await readdir2(dir);
  } catch {
    return null;
  }
  const sessions = entries.filter((f) => f.endsWith(".jsonl")).slice(0, 3);
  for (const s of sessions) {
    try {
      const raw = await readFile2(join3(dir, s), "utf8");
      for (const line of raw.split("\n").slice(0, 60)) {
        if (!line.includes("cwd")) continue;
        const parsed = JSON.parse(line);
        const cwd = parsed?.cwd;
        if (typeof cwd === "string" && cwd.trim()) {
          return safeProjectName(basename3(cwd.replace(/[\\/]+$/, "")).trim(), projectDir);
        }
      }
    } catch {
    }
  }
  return decodeProjectName(projectDir);
}
function decodeProjectName(dir) {
  let p = dir.replace(/^([A-Za-z])-/, "$1:/");
  p = p.replace(/--/g, "/");
  p = p.replace(/-/g, " ");
  return safeProjectName(p.split(/[/\\]/).pop().trim(), dir);
}
function safeProjectName(value, fallback) {
  const cleaned = String(value ?? "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").trim();
  if (cleaned && !/^[A-Za-z]_?$/.test(cleaned)) return cleaned;
  return String(fallback ?? "claude-project").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "") || "claude-project";
}
async function importClaudeMemory(storageRoot, options = {}) {
  const projectsRoot = options.projectsRoot ?? CLAUDE_PROJECTS;
  const projects = await findClaudeProjects(projectsRoot);
  await mkdir2(storageRoot, { recursive: true });
  const markerPath = join3(storageRoot, MARKER);
  const marker = await readMarker(markerPath);
  let imported = 0;
  let skipped = 0;
  let total = 0;
  const genericByName = /* @__PURE__ */ new Map();
  for (const project of projects) {
    const projectName = await resolveProjectName(project.dir, projectsRoot) ?? project.dir;
    if (projectName === project.dir) continue;
    const byName = /* @__PURE__ */ new Map();
    for (const abs of project.files) {
      let content;
      try {
        content = await readFile2(abs, "utf8");
      } catch {
        continue;
      }
      total++;
      const key = basename3(abs);
      const existing = byName.get(key);
      if (!existing || content.length > existing.content.length) byName.set(key, { abs, content });
    }
    for (const { abs, content } of byName.values()) {
      if (!GENERIC_SUBDIRS.has(basename3(join3(abs, "..")))) continue;
      const key = basename3(abs);
      const existing = genericByName.get(key);
      if (!existing || content.length > existing.content.length) {
        genericByName.set(key, { abs, content });
      }
    }
    const projectFiles = [...byName.values()].filter(({ abs }) => !GENERIC_SUBDIRS.has(basename3(join3(abs, ".."))));
    if (projectFiles.length === 0) continue;
    const targetRoot = join3(storageRoot, projectName);
    if (projectFiles.some(({ abs }) => !marker[abs])) await mkdir2(targetRoot, { recursive: true });
    for (const { abs, content } of projectFiles) {
      if (marker[abs]) {
        skipped++;
        continue;
      }
      const target = join3(targetRoot, basename3(abs));
      const tagged = tagSource(content, projectName);
      const written = await writeNew(target, tagged);
      marker[abs] = relative2(storageRoot, target).split(sep3).join("/");
      if (written) imported++;
      else skipped++;
    }
  }
  if (genericByName.size > 0) {
    const genericRoot = join3(storageRoot, "\u901A\u7528");
    await mkdir2(genericRoot, { recursive: true });
    for (const { abs, content } of genericByName.values()) {
      if (marker[abs]) {
        skipped++;
        continue;
      }
      const target = join3(genericRoot, basename3(abs));
      const written = await writeNew(target, tagSource(content, "\u901A\u7528"));
      marker[abs] = relative2(storageRoot, target).split(sep3).join("/");
      if (written) imported++;
      else skipped++;
    }
  }
  await atomicWriteMarker(markerPath, marker);
  return { imported, skipped, total };
}
async function readMarker(path) {
  try {
    const parsed = JSON.parse(await readFile2(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
async function writeNew(path, content) {
  try {
    await writeFile2(path, content, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}
async function atomicWriteMarker(path, marker) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile2(temp, `${JSON.stringify(marker, null, 2)}
`, { encoding: "utf8", flag: "wx" });
    await rename2(temp, path);
  } finally {
    await unlink2(temp).catch(() => {
    });
  }
}
function tagSource(content, project) {
  if (!project) return content;
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return content;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return content;
  for (let i = 1; i < end; i++) {
    if (lines[i].startsWith("source:")) return content;
  }
  lines.splice(end, 0, `source: claude:${project}`);
  return lines.join("\n");
}

// src/tools.ts
var STR = { type: "string" };
var STR_ARRAY = { type: "array", items: { type: "string" } };
function renderText(title, text) {
  return [{ type: "text", text: `${title}
${String(text ?? "").slice(0, 12e3)}` }];
}
function tool(name2, description, parameters, execute) {
  return {
    name: name2,
    description,
    parameters: { type: "object", properties: parameters, required: [] },
    output: { schema: { type: "object" }, render: (_args, value) => renderText(name2, typeof value === "string" ? value : JSON.stringify(value, null, 2)) },
    async execute(args, exec) {
      return await execute(args, exec) ?? {};
    }
  };
}
function registerMemoryTools(ctx, store) {
  const tools = [
    tool(
      "memory_remember",
      "\u628A\u7528\u6237\u660E\u786E\u8981\u6C42\u8BB0\u4F4F\u7684\u4FE1\u606F\u771F\u5B9E\u4FDD\u5B58\u5230\u5F53\u524D\u9879\u76EE\u7684\u72EC\u7ACB Markdown \u8BB0\u5FC6\u6587\u4EF6\u3002\u8BFB\u53D6\u7D22\u5F15\u53D1\u73B0\u540C\u4E3B\u9898\u65F6\u4F20\u5165\u5176 id \u66F4\u65B0\uFF1B\u672A\u4F20 id \u65F6\u4EC5\u540C\u540D\u66F4\u65B0\uFF0C\u5426\u5219\u65B0\u5EFA\uFF0C\u7981\u6B62\u7528\u6A21\u7CCA\u6807\u9898\u8986\u76D6\u5176\u4ED6\u4E3B\u9898\u3002\u53EA\u6709\u8FD4\u56DE saved=true \u540E\u624D\u80FD\u5411\u7528\u6237\u786E\u8BA4\u201C\u5DF2\u8BB0\u4F4F\u201D\u3002\u5982\u9996\u8F6E\u5C1A\u672A\u66B4\u9732\u6B64\u5DE5\u5177\uFF0C\u5148\u7528 read \u8BFB\u53D6\u8BB0\u5FC6\u7D22\u5F15\uFF0C\u4E0B\u4E00\u6B65\u518D\u8C03\u7528\u672C\u5DE5\u5177\u3002",
      {
        title: { ...STR, description: "\u4E3B\u9898\u5316\u7684\u77ED\u6807\u9898\uFF1B\u540C\u4E00\u4E3B\u9898\u5E94\u4FDD\u6301\u7A33\u5B9A" },
        content: { ...STR, description: "\u9700\u8981\u957F\u671F\u4FDD\u5B58\u7684\u5B8C\u6574\u4E8B\u5B9E\u6216\u89C4\u5219(Markdown)" },
        id: { ...STR, description: "\u8BFB\u53D6\u7D22\u5F15\u540E\u53D1\u73B0\u540C\u4E3B\u9898\u6761\u76EE\u65F6\u4F20\u5165\u5176\u8BB0\u5FC6 id\uFF1B\u53EF\u9009" },
        type: { ...STR, description: "\u8BB0\u5FC6\u7C7B\u578B", enum: MEMORY_TYPES },
        tags: { ...STR_ARRAY, description: "\u6807\u7B7E\u5217\u8868(\u53EF\u9009)" },
        description: { ...STR, description: "\u4E00\u884C\u6982\u8FF0(\u53EF\u9009)" },
        scope: { ...STR, description: "project=\u5F53\u524D\u9879\u76EE(\u9ED8\u8BA4),general=\u901A\u7528", enum: ["project", "general"] }
      },
      async (args, exec) => {
        if (!args.title || !args.content) throw new Error("memory_remember \u9700\u8981 title \u548C content");
        const scope = args.scope === "general" ? GENERAL_SCOPE : currentProjectScope(store, exec);
        const target = await findRememberTarget(store, scope, args.title, args.id);
        if (target?.error) return { ok: false, saved: false, code: target.code, error: target.error };
        if (target?.memory) {
          const result2 = await store.update(target.memory.id, {
            title: args.title,
            content: args.content,
            type: args.type ?? target.memory.type,
            tags: args.tags ?? target.memory.tags,
            description: args.description ?? target.memory.description,
            scopes: [scope]
          });
          if (!result2) return { ok: false, saved: false, code: "MEMORY_NOT_FOUND", error: `\u8BB0\u5FC6\u4E0D\u5B58\u5728: ${target.memory.id}` };
          return { ok: true, saved: true, action: "updated", id: result2.id, scope, path: result2.path, type: result2.type };
        }
        const result = await store.write({
          title: args.title,
          content: args.content,
          type: args.type ?? "reference",
          tags: args.tags,
          description: args.description
        }, { scope });
        return { ok: true, saved: true, action: "created", id: result.id, scope, path: result.path, type: result.type };
      }
    ),
    tool(
      "memory_write",
      "\u5199\u5165\u4E00\u6761\u8BB0\u5FC6:\u6807\u9898\u3001\u6B63\u6587\u3001\u7C7B\u578B(user=\u7528\u6237\u753B\u50CF/feedback=\u53CD\u9988\u7EA0\u6B63/project=\u9879\u76EE\u72B6\u6001/reference=\u901A\u7528\u53C2\u8003),\u53EF\u9009\u6807\u7B7E\u3002\u5199\u5165\u540E\u81EA\u52A8\u66F4\u65B0 MEMORY.md \u7D22\u5F15\u3002\u9002\u5408:\u7528\u6237\u660E\u786E\u8981\u6C42\u8BB0\u4F4F\u3001\u5B66\u5230\u7528\u6237\u504F\u597D/\u7EA0\u6B63/\u9879\u76EE\u4E8B\u5B9E/\u5916\u90E8\u8D44\u6599\u3002",
      {
        title: { ...STR, description: "\u8BB0\u5FC6\u6807\u9898(\u7B80\u77ED,\u4E3B\u9898\u5316)" },
        content: { ...STR, description: "\u8BB0\u5FC6\u6B63\u6587(Markdown)" },
        type: { ...STR, description: "\u8BB0\u5FC6\u7C7B\u578B", enum: MEMORY_TYPES },
        tags: { ...STR_ARRAY, description: "\u6807\u7B7E\u5217\u8868(\u53EF\u9009)" },
        description: { ...STR, description: "\u4E00\u884C\u6982\u8FF0(\u7D22\u5F15 hook,\u53EF\u9009)" },
        scope: { ...STR, description: "\u5199\u5165\u8303\u56F4:project=\u5F53\u524D\u9879\u76EE(\u9ED8\u8BA4),general=\u901A\u7528", enum: ["project", "general"] }
      },
      async (args, exec) => {
        if (!args.title || !args.content) throw new Error("memory_write \u9700\u8981 title \u548C content");
        const scope = args.scope === "general" ? GENERAL_SCOPE : currentProjectScope(store, exec);
        try {
          const result = await store.write({
            title: args.title,
            content: args.content,
            type: args.type ?? "reference",
            tags: args.tags,
            description: args.description
          }, { scope });
          return { ok: true, saved: true, id: result.id, scope, path: result.path, type: result.type };
        } catch (error) {
          if (error?.code === "MEMORY_CONFLICT") {
            return { ok: false, saved: false, code: error.code, error: `${error.message};\u8BF7\u5148 memory_read\uFF0C\u518D\u4F7F\u7528 memory_update \u66F4\u65B0\u539F\u6761\u76EE` };
          }
          throw error;
        }
      }
    ),
    tool(
      "memory_read",
      "\u8BFB\u53D6\u4E00\u6761\u8BB0\u5FC6\u7684\u5B8C\u6574\u5185\u5BB9(\u542B\u5143\u6570\u636E)\u3002\u5148\u7528 memory_search \u6216 memory_list \u627E\u5230 id\u3002",
      { id: { ...STR, description: "\u8BB0\u5FC6 id(\u6587\u4EF6\u540D,\u4E0D\u542B .md)" } },
      async (args, exec) => {
        if (!args.id) throw new Error("memory_read \u9700\u8981 id");
        const memory = await store.get(args.id, { scopes: visibleScopes(store, exec) });
        if (!memory) return { ok: false, error: `\u8BB0\u5FC6\u4E0D\u5B58\u5728: ${args.id}` };
        return { ok: true, ...memory };
      }
    ),
    tool(
      "memory_update",
      "\u66F4\u65B0\u4E00\u6761\u8BB0\u5FC6(\u6807\u9898/\u6B63\u6587/\u7C7B\u578B/\u6807\u7B7E)\u3002\u66F4\u65B0\u524D\u81EA\u52A8\u4FDD\u5B58\u5386\u53F2\u7248\u672C\u5230 .history/\u3002",
      {
        id: { ...STR, description: "\u8BB0\u5FC6 id" },
        title: { ...STR, description: "\u65B0\u6807\u9898(\u53EF\u9009)" },
        content: { ...STR, description: "\u65B0\u6B63\u6587(\u53EF\u9009)" },
        type: { ...STR, description: "\u65B0\u7C7B\u578B(\u53EF\u9009)", enum: MEMORY_TYPES },
        tags: { ...STR_ARRAY, description: "\u65B0\u6807\u7B7E(\u53EF\u9009,\u4F20\u7A7A\u6570\u7EC4\u6E05\u7A7A)" },
        description: { ...STR, description: "\u65B0\u6982\u8FF0(\u53EF\u9009)" }
      },
      async (args, exec) => {
        if (!args.id) throw new Error("memory_update \u9700\u8981 id");
        const result = await store.update(args.id, { ...args, scopes: visibleScopes(store, exec) });
        if (!result) return { ok: false, error: `\u8BB0\u5FC6\u4E0D\u5B58\u5728: ${args.id}` };
        return { ok: true, id: result.id, updated: result.updated };
      }
    ),
    tool(
      "memory_delete",
      "\u5220\u9664\u4E00\u6761\u8BB0\u5FC6(\u5220\u9664\u524D\u4FDD\u5B58\u5386\u53F2\u7248\u672C\u5230 .history/,\u53EF\u6062\u590D)\u3002",
      { id: { ...STR, description: "\u8BB0\u5FC6 id" } },
      async (args, exec) => {
        if (!args.id) throw new Error("memory_delete \u9700\u8981 id");
        const ok = await store.remove(args.id, { scopes: visibleScopes(store, exec) });
        return ok ? { ok: true } : { ok: false, error: `\u8BB0\u5FC6\u4E0D\u5B58\u5728: ${args.id}` };
      }
    ),
    tool(
      "memory_search",
      "\u5168\u6587\u641C\u7D22\u8BB0\u5FC6:\u6309\u6807\u9898/\u63CF\u8FF0/\u6B63\u6587\u5173\u952E\u8BCD\u8BC4\u5206\u8FD4\u56DE Top-N\u3002\u4F1A\u8BDD\u5F00\u59CB\u65F6\u53EF\u641C\u7D22\u76F8\u5173\u8BB0\u5FC6\u83B7\u5F97\u4E0A\u4E0B\u6587(\u53C2\u8003:\u7528\u6237\u540D/\u9879\u76EE\u540D/\u5DE5\u5177\u540D/\u4E3B\u9898\u8BCD)\u3002",
      {
        query: { ...STR, description: "\u641C\u7D22\u5173\u952E\u8BCD(\u7A7A\u683C\u5206\u9694\u591A\u4E2A\u8BCD)" },
        type: { ...STR, description: "\u8FC7\u6EE4\u7C7B\u578B(\u53EF\u9009)", enum: MEMORY_TYPES },
        limit: { type: "number", description: "\u8FD4\u56DE\u6761\u6570(\u9ED8\u8BA4 10,\u6700\u5927 50)" }
      },
      async (args, exec) => {
        if (!args.query) throw new Error("memory_search \u9700\u8981 query");
        const results = await store.search(args.query, { type: args.type, limit: args.limit, scopes: visibleScopes(store, exec) });
        return { ok: true, count: results.length, results };
      }
    ),
    tool(
      "memory_list",
      "\u5217\u51FA\u5168\u90E8\u8BB0\u5FC6\u7D22\u5F15(\u53EF\u6309\u7C7B\u578B/\u6807\u7B7E\u8FC7\u6EE4)\u3002\u67E5\u770B\u6574\u4F53\u8BB0\u5FC6\u7ED3\u6784\u7528\u6B64\u5DE5\u5177\u3002",
      {
        type: { ...STR, description: "\u8FC7\u6EE4\u7C7B\u578B(\u53EF\u9009)", enum: MEMORY_TYPES },
        tag: { ...STR, description: "\u8FC7\u6EE4\u6807\u7B7E(\u53EF\u9009)" }
      },
      async (args, exec) => {
        const scopes = visibleScopes(store, exec);
        const entries = await store.manifest(scopes);
        const filtered = entries.filter((entry) => !args.type || entry.type === args.type).filter((entry) => !args.tag || entry.tags?.includes(args.tag)).map((entry) => ({ ...entry, section: topScopeFromId(entry.id) }));
        return { ok: true, count: filtered.length, entries: filtered };
      }
    ),
    tool(
      "memory_suggest_tags",
      "\u4ECE\u5DF2\u6709\u8BB0\u5FC6\u7684\u6807\u7B7E\u4E2D\u63A8\u8350\u76F8\u5173\u6807\u7B7E(\u6309\u9891\u6B21,\u53EF\u9009\u8F93\u5165\u6587\u672C\u505A\u76F8\u5173\u6027\u8FC7\u6EE4)\u3002",
      { text: { ...STR, description: "\u8F93\u5165\u6587\u672C(\u53EF\u9009,\u7528\u4E8E\u76F8\u5173\u6027\u8FC7\u6EE4)" } },
      async (args, exec) => {
        const tags = await store.suggestTags(args.text ?? "", 5, { scopes: visibleScopes(store, exec) });
        return { ok: true, tags };
      }
    )
  ];
  for (const t of tools) {
    ctx.tools.register(t);
  }
  ctx.logger?.info?.("[dsh-memory] registered 8 memory tools");
}
async function findRememberTarget(store, scope, title, requestedId) {
  if (requestedId) {
    if (topScopeFromId(requestedId) !== scope) {
      return { code: "SCOPE_VIOLATION", error: `\u8BB0\u5FC6 id \u4E0D\u5C5E\u4E8E\u5F53\u524D\u4F5C\u7528\u57DF: ${requestedId}` };
    }
    const memory = await store.get(requestedId, { scopes: [scope] });
    return memory ? { memory } : { code: "MEMORY_NOT_FOUND", error: `\u8BB0\u5FC6\u4E0D\u5B58\u5728: ${requestedId}` };
  }
  const slug = slugify(title);
  const exact = await store.get(`${scope}/${slug}`, { scopes: [scope] });
  if (exact) {
    if (normalizeMemoryTitle(exact.name) !== normalizeMemoryTitle(title)) {
      return { code: "MEMORY_CONFLICT", error: `\u6807\u9898\u4E0D\u540C\u4F46\u6587\u4EF6\u540D\u622A\u65AD\u51B2\u7A81("${exact.name}" vs "${title}"): ${scope}/${slug}\uFF1B\u8BF7\u6539\u7528 memory_update \u66F4\u65B0\u539F\u6761\u76EE\u6216\u6362\u7528\u5176\u4ED6\u6807\u9898` };
    }
    return { memory: exact };
  }
  return null;
}
function cwdFromExec(exec) {
  return exec?.agent?.session?.header?.cwd;
}
function currentProjectScope(store, exec) {
  const scope = resolveProjectScope(store.root, cwdFromExec(exec));
  if (scope) return scope;
  const error = new Error("\u65E0\u6CD5\u786E\u8BA4\u5F53\u524D\u9879\u76EE\uFF0C\u62D2\u7EDD\u628A\u9879\u76EE\u8BB0\u5FC6\u5199\u5165\u901A\u7528\u4F5C\u7528\u57DF\uFF1B\u5982\u786E\u9700\u8DE8\u9879\u76EE\u8BB0\u5FC6\uFF0C\u8BF7\u660E\u786E\u8BBE\u7F6E scope=general");
  error.code = "PROJECT_SCOPE_UNRESOLVED";
  throw error;
}
function visibleScopes(store, exec) {
  return scopesForCwd(store.root, cwdFromExec(exec));
}

// src/events.ts
function extractEventText(data) {
  const message = data?.message ?? data;
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === "string" ? part : part?.text ?? "").join("\n").trim();
  }
  return String(message?.text ?? data?.text ?? "").trim();
}

// src/recorder.ts
var REVIEWABLE_KINDS = /* @__PURE__ */ new Set(["completed"]);
var MEMORY_WRITE_TOOLS = /* @__PURE__ */ new Set(["memory_remember", "memory_write", "memory_update", "memory_delete", "memory_dream"]);
var MAX_MESSAGE_CHARS = 8e3;
var MAX_BUFFER_MESSAGES = 50;
var REVIEW_SYSTEM = [
  "\u4F60\u662F\u9879\u76EE\u8BB0\u5FC6\u63D0\u53D6\u5668\u3002\u53EA\u8F93\u51FA\u4E25\u683C JSON\uFF0C\u4E0D\u8981\u8F93\u51FA\u4EE3\u7801\u5757\u6216\u89E3\u91CA\u3002",
  '\u683C\u5F0F\uFF1A{"actions":[{"action":"create|update|delete","id":"\u66F4\u65B0/\u5220\u9664\u65F6\u5FC5\u586B","type":"user|feedback|project|reference","title":"\u521B\u5EFA\u65F6\u5FC5\u586B","content":"\u521B\u5EFA/\u66F4\u65B0\u6B63\u6587","description":"\u4E00\u884C\u7D22\u5F15\u8BF4\u660E","tags":["\u6807\u7B7E"]}]}\u3002',
  '\u6CA1\u6709\u503C\u5F97\u957F\u671F\u4FDD\u5B58\u7684\u4FE1\u606F\u65F6\uFF0C\u5FC5\u987B\u660E\u786E\u8F93\u51FA {"actions":[]}\u3002',
  "\u8BB0\u5FC6\u7C7B\u578B\uFF08\u4E25\u683C\u56DB\u9009\u4E00\uFF09\uFF1A",
  "- user: \u7528\u6237\u753B\u50CF\u2014\u2014\u7528\u6237\u7684\u89D2\u8272\u3001\u76EE\u6807\u3001\u6280\u80FD\u6C34\u5E73\u4E0E\u534F\u4F5C\u504F\u597D\uFF08\u5DE5\u4F5C\u65B9\u5F0F/\u56DE\u590D\u98CE\u683C\uFF09",
  '- feedback: \u884C\u4E3A\u53CD\u9988\u2014\u2014\u7528\u6237\u5BF9\u4F60\u5DE5\u4F5C\u65B9\u5F0F\u7684\u7EA0\u6B63\u6216\u80AF\u5B9A\uFF1B\u6B63\u6587\u672B\u5C3E\u5FC5\u987B\u542B "**Why:**" \u4E0E "**How to apply:**" \u4E24\u6BB5',
  '- project: \u65E0\u6CD5\u4ECE\u4EE3\u7801\u6216 Git \u63A8\u65AD\u7684\u9879\u76EE\u52A8\u6001\u2014\u2014\u8C01\u5728\u505A\u4EC0\u4E48\u3001\u4E3A\u4EC0\u4E48\u3001\u622A\u6B62\u65E5\u671F\uFF1B\u76F8\u5BF9\u65E5\u671F\uFF08"\u6628\u5929""\u5468\u56DB"\uFF09\u5FC5\u987B\u8F6C\u6362\u4E3A\u7EDD\u5BF9\u65E5\u671F\uFF08YYYY-MM-DD\uFF09',
  "- reference: \u6307\u5411\u5916\u90E8\u7CFB\u7EDF\u7684\u6307\u9488\u2014\u2014\u4EEA\u8868\u677F\u3001\u5DE5\u5355\u7CFB\u7EDF\u3001\u5DE5\u5177\u7528\u6CD5\u3001\u5916\u90E8\u8D44\u6E90\u4F4D\u7F6E",
  "\u5FC5\u987B\u4FDD\u5B58\uFF1A\u8DE8\u4F1A\u8BDD\u4ECD\u6709\u4EF7\u503C\u7684\u7528\u6237\u753B\u50CF\u3001\u884C\u4E3A\u53CD\u9988\u3001\u9879\u76EE\u51B3\u7B56/\u72B6\u6001\u3001\u5916\u90E8\u7CFB\u7EDF\u4E0E\u5DE5\u5177\u5F15\u7528\u3002",
  "\u4E0D\u8981\u4FDD\u5B58\uFF1A\u80FD\u4ECE\u5F53\u524D\u4EE3\u7801/Git/\u8BA1\u5212\u76F4\u63A5\u63A8\u65AD\u7684\u4FE1\u606F\u3001\u4E00\u6B21\u6027\u8C03\u8BD5\u8FC7\u7A0B\u3001\u5BD2\u6684\u3001\u4E34\u65F6\u4EFB\u52A1\u6E05\u5355\u3001\u4F1A\u8BDD\u539F\u6587\u642C\u8FD0\u3002",
  "\u5373\u4F7F\u7528\u6237\u660E\u786E\u8981\u6C42\u4FDD\u5B58\uFF0C\u4E0A\u8FF0\u6392\u9664\u9879\u4F9D\u7136\u9002\u7528\u3002",
  "\u82E5\u7528\u6237\u8981\u6C42\u4FDD\u5B58 PR \u5217\u8868\u3001\u6D3B\u52A8\u6D41\u6C34\u8FD9\u7C7B\u5185\u5BB9\uFF0C\u5148\u95EE\u5176\u4E2D\u4EC0\u4E48\u662F\u610F\u5916/\u975E\u663E\u7136\u7684\u2014\u2014\u90A3\u624D\u662F\u503C\u5F97\u7559\u4E0B\u7684\u90E8\u5206\u3002",
  "\u5148\u68C0\u67E5\u5DF2\u6709\u8BB0\u5FC6\u3002\u76F8\u540C\u4E3B\u9898\u4F18\u5148 update\uFF1B\u4E0D\u8981\u521B\u5EFA\u8FD1\u4F3C\u91CD\u590D\u6761\u76EE\uFF1B\u53EA\u6709\u660E\u786E\u8FC7\u65F6\u4E14\u5E94\u79FB\u9664\u65F6\u624D delete\u3002\u66F4\u65B0\u65F6\u4FDD\u7559\u6E90\u6587\u4EF6\u4E2D\u4ECD\u6709\u6548\u7684\u5185\u5BB9\u3002"
].join("\n");
var ReviewError = class extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReviewError";
    this.code = code;
  }
};
var TurnRecorder = class {
  constructor(ctx, store, config) {
    this.ctx = ctx;
    this.store = store;
    this.config = config;
    this.turnCounts = /* @__PURE__ */ new Map();
    this.buffers = /* @__PURE__ */ new Map();
    this.sessionCwds = /* @__PURE__ */ new Map();
    this.agentWrote = /* @__PURE__ */ new Set();
    this.inFlight = /* @__PURE__ */ new Set();
    this.pending = /* @__PURE__ */ new Set();
  }
  install() {
    this.ctx.on("session/event", (session, event) => this.handleEvent(session, event), { global: true });
    this.ctx.on("session/disposed", (session) => this.disposeSession(session?.id), { global: true });
    this.ctx.logger?.info?.("[dsh-memory] recorder installed");
  }
  handleEvent(session, event) {
    if (!event?.type || !session?.id) return;
    const sessionId = session.id;
    if (session.header?.cwd) this.sessionCwds.set(sessionId, session.header.cwd);
    if (event.type === "user/message" && event.data?.source?.kind === "user") {
      this.pushMessage(sessionId, "user", extractEventText(event.data));
      return;
    }
    if (event.type === "assistant/message") {
      this.pushMessage(sessionId, "assistant", extractEventText(event.data));
      return;
    }
    if (event.type === "tool/call") {
      if (MEMORY_WRITE_TOOLS.has(event.data?.name)) this.agentWrote.add(sessionId);
      return;
    }
    if (event.type === "turn/end" && REVIEWABLE_KINDS.has(event.data?.reason?.kind)) {
      const count = (this.turnCounts.get(sessionId) ?? 0) + 1;
      this.turnCounts.set(sessionId, count);
      if (this.config.skipReviewAfterAgentWrite !== false && this.agentWrote.has(sessionId)) {
        this.agentWrote.delete(sessionId);
        this.buffers.delete(sessionId);
        this.ctx.logger?.info?.(`[dsh-memory] review skipped code=AGENT_WROTE_MEMORY session=${shortId(sessionId)}`);
        return;
      }
      const interval = Math.max(this.config.reviewInterval ?? 5, 1);
      if (count % interval === 0) void this.maybeReview(sessionId);
    }
  }
  pushMessage(sessionId, role, text) {
    if (!text) return;
    let buffer = this.buffers.get(sessionId);
    if (!buffer) {
      buffer = [];
      this.buffers.set(sessionId, buffer);
    }
    buffer.push({ role, text: text.slice(0, MAX_MESSAGE_CHARS) });
    if (buffer.length > MAX_BUFFER_MESSAGES) buffer.splice(0, buffer.length - MAX_BUFFER_MESSAGES);
  }
  disposeSession(sessionId) {
    if (!sessionId) return;
    this.turnCounts.delete(sessionId);
    this.buffers.delete(sessionId);
    this.sessionCwds.delete(sessionId);
    this.agentWrote.delete(sessionId);
    this.inFlight.delete(sessionId);
    this.pending.delete(sessionId);
  }
  async maybeReview(sessionId) {
    if (this.config.reviewEnabled === false) return { status: "disabled" };
    if (this.inFlight.has(sessionId)) {
      this.pending.add(sessionId);
      return { status: "coalesced" };
    }
    const buffer = this.buffers.get(sessionId);
    if (!buffer?.length) return { status: "empty" };
    this.inFlight.add(sessionId);
    const snapshot = buffer.slice();
    const cwd = this.sessionCwds.get(sessionId) ?? this.ctx.agents?.get?.(sessionId)?.session?.header?.cwd;
    const projectScope = resolveProjectScope(this.store.root, cwd);
    if (!projectScope) {
      buffer.splice(0, snapshot.length);
      this.ctx.logger?.warn?.(`[dsh-memory] review skipped code=PROJECT_SCOPE_UNRESOLVED session=${shortId(sessionId)}`);
      return { status: "skipped", code: "PROJECT_SCOPE_UNRESOLVED" };
    }
    const visibleScopes2 = projectScope === GENERAL_SCOPE ? [GENERAL_SCOPE] : [GENERAL_SCOPE, projectScope];
    try {
      const manifest = await this.store.manifest(visibleScopes2);
      const review = await this.reviewWithLlm(sessionId, snapshot, manifest);
      await this.applyActions(review.actions, projectScope);
      buffer.splice(0, snapshot.length);
      this.ctx.logger?.info?.(`[dsh-memory] review ${review.actions.length ? `applied=${review.actions.length}` : "none"} session=${shortId(sessionId)} scope=${projectScope}`);
      return { status: review.actions.length ? "applied" : "none", count: review.actions.length };
    } catch (error) {
      const code = error?.code ?? "REVIEW_FAILED";
      this.ctx.logger?.warn?.(`[dsh-memory] review failed code=${code} session=${shortId(sessionId)} scope=${projectScope}: ${error instanceof Error ? error.message : String(error)}`);
      return { status: "failed", code };
    } finally {
      this.inFlight.delete(sessionId);
      if (this.pending.delete(sessionId) && this.buffers.get(sessionId)?.length) {
        queueMicrotask(() => {
          void this.maybeReview(sessionId);
        });
      }
    }
  }
  async applyActions(actions, scope) {
    const prepared = [];
    const createIds = /* @__PURE__ */ new Set();
    for (const action of actions) {
      if (action.action === "create") {
        const id = `${scope}/${slugify(action.title)}`;
        if (createIds.has(id)) throw new ReviewError("DUPLICATE_ACTION", `\u540C\u4E00\u6279\u8BC4\u5BA1\u5305\u542B\u91CD\u590D create: ${id}`);
        createIds.add(id);
        const existing2 = await this.store.get(id, { scopes: [scope] });
        if (existing2) {
          if (existing2.content.trim() === String(action.content).trim()) continue;
          throw new ReviewError("MEMORY_CONFLICT", `\u540C\u4E3B\u9898\u8BB0\u5FC6\u5DF2\u5B58\u5728\uFF0C\u5E94\u6539\u7528 update: ${id}`);
        }
        prepared.push(action);
        continue;
      }
      if (!action.id || !String(action.id).startsWith(`${scope}/`)) {
        throw new ReviewError("SCOPE_VIOLATION", `\u81EA\u52A8\u8BB0\u5F55\u52A8\u4F5C\u8D8A\u51FA\u5F53\u524D\u9879\u76EE: ${action.id ?? "(missing id)"}`);
      }
      const existing = await this.store.get(action.id, { scopes: [scope] });
      if (!existing) throw new ReviewError("MEMORY_NOT_FOUND", `\u76EE\u6807\u8BB0\u5FC6\u4E0D\u5B58\u5728: ${action.id}`);
      prepared.push(action);
    }
    for (const action of prepared) {
      if (action.action === "create") {
        await this.store.write({
          title: action.title,
          content: stripFrontmatter(action.content),
          description: action.description,
          type: action.type ?? "reference",
          tags: Array.isArray(action.tags) ? action.tags.map(String) : parseTags(action.tags)
        }, { scope });
        continue;
      }
      if (action.action === "update") {
        const result = await this.store.update(action.id, { ...action, content: stripFrontmatter(action.content), scopes: [scope] });
        if (!result) throw new ReviewError("MEMORY_NOT_FOUND", `\u5F85\u66F4\u65B0\u8BB0\u5FC6\u4E0D\u5B58\u5728: ${action.id}`);
      } else if (action.action === "delete") {
        const removed = await this.store.remove(action.id, { scopes: [scope] });
        if (!removed) throw new ReviewError("MEMORY_NOT_FOUND", `\u5F85\u5220\u9664\u8BB0\u5FC6\u4E0D\u5B58\u5728: ${action.id}`);
      }
    }
  }
  async reviewWithLlm(sessionId, buffer, manifest) {
    const llm = this.resolveLlm();
    if (!llm) throw new ReviewError("LLM_UNAVAILABLE", "LLM \u670D\u52A1\u4E0D\u53EF\u7528");
    let provider = this.config.provider || void 0;
    let model = this.config.model || void 0;
    if (!provider || !model) {
      const agent = this.ctx.agents?.get?.(sessionId);
      provider = provider ?? agent?.options?.provider;
      model = model ?? agent?.options?.model;
    }
    if (!provider || !model) throw new ReviewError("MODEL_UNRESOLVED", "\u65E0\u6CD5\u89E3\u6790\u81EA\u52A8\u8BB0\u5F55\u4F7F\u7528\u7684 provider/model");
    provider = unwrapReviewProvider(provider);
    const transcript = buffer.map((message) => `${message.role === "user" ? "\u7528\u6237" : "\u52A9\u624B"}: ${message.text}`).join("\n").slice(0, 32e3);
    const existing = manifest.length ? manifest.map((item) => `- ${item.id} [${item.type}] ${item.title}${item.description ? ` \u2014 ${item.description}` : ""}`).join("\n") : "(\u5F53\u524D\u4F5C\u7528\u57DF\u6CA1\u6709\u5DF2\u6709\u8BB0\u5FC6)";
    const prompt = `\u5DF2\u6709\u8BB0\u5FC6\u6E05\u5355\uFF1A
${existing}

\u5F85\u8BC4\u5BA1\u5BF9\u8BDD\uFF1A
${transcript}

\u8F93\u51FA\u52A8\u4F5C JSON\u3002`;
    let attempt = 0;
    while (true) {
      const { text, finish } = await this.streamReview(llm, provider, model, prompt);
      if (finish?.kind === "error" || finish?.kind === "aborted") {
        throw new ReviewError(finish.failure?.code ?? `LLM_${finish.kind.toUpperCase()}`, finish.failure?.message ?? `LLM ${finish.kind}`);
      }
      if (!finish) throw new ReviewError("LLM_NO_FINISH", "\u81EA\u52A8\u8BB0\u5F55\u6A21\u578B\u6D41\u7ED3\u675F\u4F46\u6CA1\u6709 finish \u7EC8\u6001");
      if (finish.kind === "max-tokens") throw new ReviewError("LLM_MAX_TOKENS", "\u81EA\u52A8\u8BB0\u5F55\u8F93\u51FA\u8FBE\u5230 token \u4E0A\u9650\uFF0C\u7ED3\u679C\u53EF\u80FD\u4E0D\u5B8C\u6574");
      if (text.trim()) return parseReviewJson(text);
      attempt++;
      if (attempt >= 2) throw new ReviewError("LLM_EMPTY_OUTPUT", "\u81EA\u52A8\u8BB0\u5F55\u6A21\u578B\u6CA1\u6709\u8FD4\u56DE\u6587\u672C");
    }
  }
  /** 单次评审流读取:超时/提前结束都释放迭代器,返回 { text, finish }。 */
  async streamReview(llm, provider, model, prompt) {
    const controller = new AbortController();
    const timeoutMs = Math.max(this.config.reviewTimeoutMs ?? 12e4, 1);
    const maxTokens = this.config.reviewMaxTokens ?? 1e3;
    let timeout;
    let iterator;
    let done = false;
    let terminal = false;
    let text = "";
    let finish;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new ReviewError("REVIEW_TIMEOUT", `\u81EA\u52A8\u8BB0\u5F55\u8BC4\u5BA1\u8D85\u8FC7 ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      const stream = await Promise.race([llm.stream({
        provider,
        model,
        system: REVIEW_SYSTEM,
        messages: [{
          id: crypto.randomUUID(),
          role: "user",
          source: { kind: "user" },
          content: [{ type: "text", text: prompt }]
        }],
        temperature: 0,
        reasoningEffort: "off",
        maxTokens,
        signal: controller.signal
      }), timeoutPromise]);
      iterator = stream[Symbol.asyncIterator]();
      while (true) {
        const step = await Promise.race([iterator.next(), timeoutPromise]);
        if (step.done) {
          done = true;
          break;
        }
        const chunk = step.value;
        if (chunk?.type === "text-delta") text += chunk.text ?? "";
        if (chunk?.type === "finish") {
          finish = chunk.reason;
          terminal = true;
          break;
        }
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      if (!done) {
        if (!terminal) controller.abort();
        try {
          void iterator?.return?.();
        } catch {
        }
      }
    }
    return { text, finish };
  }
  resolveLlm() {
    const root = this.ctx.get?.("root") ?? this.ctx.root;
    return root?.get?.("llm") ?? this.ctx.get?.("llm") ?? this.ctx.llm ?? null;
  }
};
function unwrapReviewProvider(provider) {
  if (provider === "deepseek-modlens") return "deepseek-official";
  return String(provider).startsWith("modlens-") ? String(provider).slice("modlens-".length) : provider;
}
function parseReviewJson(text) {
  const cleaned = String(text ?? "").replace(/```(?:json)?\s*/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end < start) throw new ReviewError("INVALID_JSON", "\u81EA\u52A8\u8BB0\u5F55\u8F93\u51FA\u4E2D\u6CA1\u6709 JSON \u5BF9\u8C61");
  let parsed;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new ReviewError("INVALID_JSON", "\u81EA\u52A8\u8BB0\u5F55\u8F93\u51FA\u4E0D\u662F\u6709\u6548 JSON");
  }
  if (Array.isArray(parsed.memories)) {
    return { actions: parsed.memories.map((memory) => ({ action: "create", ...memory })) };
  }
  if (!Array.isArray(parsed.actions)) throw new ReviewError("INVALID_SCHEMA", "\u81EA\u52A8\u8BB0\u5F55\u8F93\u51FA\u7F3A\u5C11 actions \u6570\u7EC4");
  const actions = parsed.actions.map(validateAction);
  return { actions };
}
function stripFrontmatter(text) {
  const s = String(text ?? "");
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(s);
  return m ? s.slice(m[0].length) : s;
}
function validateAction(action) {
  if (!action || !["create", "update", "delete"].includes(action.action)) {
    throw new ReviewError("INVALID_ACTION", `\u672A\u77E5\u81EA\u52A8\u8BB0\u5F55\u52A8\u4F5C: ${action?.action}`);
  }
  if (action.action === "create" && (!action.title || !action.content)) {
    throw new ReviewError("INVALID_ACTION", "create \u52A8\u4F5C\u7F3A\u5C11 title/content");
  }
  if (action.action !== "create" && !action.id) {
    throw new ReviewError("INVALID_ACTION", `${action.action} \u52A8\u4F5C\u7F3A\u5C11 id`);
  }
  return action;
}
function shortId(value) {
  return String(value ?? "").slice(0, 8);
}

// src/recall.ts
import { readdirSync as readdirSync2, readFileSync as readFileSync2, statSync } from "node:fs";
import { join as join4 } from "node:path";
var MAX_INDEX_LINES = 200;
var DEFAULT_INDEX_BYTES = 25e3;
var DEFAULT_RELEVANT_BYTES = 16e3;
var IGNORE_MEMORY = /(?:本次|本轮|这次)?.{0,4}(?:忽略|不要使用|不用|别用).{0,4}记忆|从零开始/u;
var EXPLICIT_REMEMBER = /(?:请|帮我|一定要|务必)?(?:记住|记一下|记下来|保存到记忆|以后(?:都|统一|一直).{0,12}(?:按|用|是|不要|别))/u;
var ENTRY_CACHE_TTL_MS = 1e3;
var DEFAULT_SESSION_BYTES = 60 * 1024;
var MEMORY_USAGE_GUIDANCE = [
  "## \u5F15\u7528\u8BB0\u5FC6\u524D\u7684\u6838\u9A8C",
  "",
  "\u8BB0\u5FC6\u91CC\u63D0\u5230\u67D0\u4E2A\u51FD\u6570\u3001\u6587\u4EF6\u6216\u5F00\u5173\uFF0C\u53EA\u4EE3\u8868**\u5199\u4E0B\u90A3\u6761\u8BB0\u5FC6\u65F6**\u5B83\u5B58\u5728\uFF1A\u5B83\u53EF\u80FD\u5DF2\u88AB\u6539\u540D\u3001\u5220\u9664\uFF0C\u6216\u4ECE\u672A\u5408\u5165\u3002\u636E\u6B64\u7ED9\u51FA\u5EFA\u8BAE\u4E4B\u524D\uFF1A",
  "",
  "- \u8BB0\u5FC6\u91CC\u7ED9\u4E86\u6587\u4EF6\u8DEF\u5F84 \u2192 \u5148\u786E\u8BA4\u8BE5\u6587\u4EF6\u5B58\u5728\u3002",
  "- \u8BB0\u5FC6\u91CC\u7ED9\u4E86\u51FD\u6570\u540D\u6216\u5F00\u5173 \u2192 \u5148 grep \u4E00\u904D\u3002",
  "- \u7528\u6237\u51C6\u5907\u7167\u7740\u4F60\u7684\u5EFA\u8BAE\u52A8\u624B\uFF08\u800C\u4E0D\u53EA\u662F\u95EE\u5386\u53F2\uFF09\u2192 \u5148\u9A8C\u8BC1\u518D\u7B54\u3002",
  "",
  "\u300C\u8BB0\u5FC6\u8BF4 X \u5B58\u5728\u300D\u4E0D\u7B49\u4E8E\u300CX \u73B0\u5728\u5B58\u5728\u300D\u3002",
  "",
  '- \u8BB0\u5FC6\u4F1A\u968F\u65F6\u95F4\u8FC7\u65F6\uFF1A\u628A\u5B83\u5F53\u6210"\u67D0\u4E2A\u65F6\u95F4\u70B9\u4E3A\u771F"\u7684\u4E0A\u4E0B\u6587\uFF1B\u4EC5\u51ED\u8BB0\u5FC6\u4F5C\u7B54\u6216\u5EFA\u7ACB\u5047\u8BBE\u524D\uFF0C\u5148\u8BFB\u5F53\u524D\u6587\u4EF6/\u8D44\u6E90\u7684\u5B9E\u9645\u72B6\u6001\u6838\u5B9E\u3002',
  "- \u8BB0\u5FC6\u4E0E\u73B0\u72B6\u51B2\u7A81\u65F6\uFF0C\u4EE5\u4F60\u73B0\u5728\u89C2\u5BDF\u5230\u7684\u4E3A\u51C6\u2014\u2014\u5E76\u987A\u624B\u66F4\u65B0\u6216\u5220\u9664\u90A3\u6761\u8FC7\u671F\u8BB0\u5FC6\uFF0C\u800C\u4E0D\u662F\u7167\u7740\u5B83\u884C\u52A8\u3002",
  "- \u8BB0\u5FC6\u53EA\u662F\u4ED3\u5E93\u72B6\u6001\u7684\u5FEB\u7167\uFF08\u6D3B\u52A8\u8BB0\u5F55\u3001\u67B6\u6784\u5FEB\u7167\uFF09\u65F6\uFF0C\u82E5\u7528\u6237\u95EE\u7684\u662F\u8FD1\u671F/\u5F53\u524D\u72B6\u6001\uFF0C\u4F18\u5148 `git log` \u6216\u76F4\u63A5\u8BFB\u4EE3\u7801\u3002"
].join("\n");
function installRecall(ctx, store, config) {
  const latestQueries = /* @__PURE__ */ new Map();
  const recentToolsBySession = /* @__PURE__ */ new Map();
  const toolsWindow = Math.max(0, Number(config.recentToolsWindow ?? 8));
  ctx.on("session/event", (session, event) => {
    if (event?.type === "tool/call" && session?.id) {
      const name2 = typeof event.data?.name === "string" ? event.data.name : "";
      if (name2 && toolsWindow > 0) {
        const list = recentToolsBySession.get(session.id) ?? [];
        recentToolsBySession.set(session.id, [name2, ...list.filter((item) => item !== name2)].slice(0, toolsWindow));
        if (recentToolsBySession.size > 500) recentToolsBySession.delete(recentToolsBySession.keys().next().value);
      }
      return;
    }
    if (event?.type !== "user/message" || event.data?.source?.kind !== "user") return;
    const text = extractEventText(event.data);
    if (text && session?.id) {
      latestQueries.set(session.id, text);
      if (latestQueries.size > 500) latestQueries.delete(latestQueries.keys().next().value);
      if (EXPLICIT_REMEMBER.test(text)) appendRememberGuide(ctx, store, session, event);
    }
  }, { global: true });
  if (config.guidanceEnabled !== false) {
    try {
      ctx.systemPrompt?.section?.({ name: "memory:usage", order: Number(config.guidanceOrder ?? 118), text: MEMORY_USAGE_GUIDANCE });
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-memory] \u4F7F\u7528\u6307\u5357 section \u6CE8\u518C\u5931\u8D25(\u5DF2\u5FFD\u7565): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let entryCache = { key: "", at: 0, entries: [] };
  const cachedEntries = (cwd) => {
    const key = `${store.root}|${cwd ?? ""}`;
    if (entryCache.key === key && Date.now() - entryCache.at < ENTRY_CACHE_TTL_MS) return entryCache.entries;
    const entries = readScopedEntries(store.root, scopedDirs(store, cwd));
    entryCache = { key, at: Date.now(), entries };
    return entries;
  };
  const sessionState = /* @__PURE__ */ new Map();
  const stateFor = (sessionId) => {
    const key = String(sessionId ?? "");
    let state = sessionState.get(key);
    if (!state) {
      state = { paths: /* @__PURE__ */ new Set(), bytes: 0, decision: null };
      sessionState.set(key, state);
      if (sessionState.size > 200) sessionState.delete(sessionState.keys().next().value);
    }
    return state;
  };
  const memoryContext = (context) => {
    const session = context?.agent?.session;
    const cwd = session?.header?.cwd;
    const query = latestQueries.get(session?.id) ?? "";
    return buildRecallBundle(store, config, cwd, query, cachedEntries(cwd), [], 0).text || void 0;
  };
  ctx.systemPrompt.context({ name: "memory:index", order: config.recallOrder ?? 117, text: memoryContext });
  const selectionCache = /* @__PURE__ */ new Map();
  const selectRelevantAsync = async (context, entries) => {
    if (config.selectEnabled === false) return null;
    const session = context?.agent?.session;
    const query = latestQueries.get(session?.id) ?? "";
    if (entries.length <= 5 || !query) return null;
    const tools = config.recentToolsEnabled === false ? [] : recentToolsBySession.get(session?.id) ?? [];
    const cacheKey = `${session?.id ?? ""}|${query}|${entries.length}|${entries[0]?.updated ?? ""}|${tools.join(",")}`;
    if (selectionCache.has(cacheKey)) return selectionCache.get(cacheKey);
    const promise = selectRelevantByLlm(ctx, config, context, entries, query, 5, tools).then((picked) => picked ?? null).catch(() => null);
    selectionCache.set(cacheKey, promise);
    if (selectionCache.size > 200) selectionCache.delete(selectionCache.keys().next().value);
    return promise;
  };
  ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
    const assembled = await next();
    const session = context?.agent?.session;
    const cwd = session?.header?.cwd;
    const query = latestQueries.get(session?.id) ?? "";
    const entries = cachedEntries(cwd);
    const state = stateFor(session?.id);
    const dedupe = config.dedupeRelevant !== false;
    const sessionMax = Number(config.sessionMaxBytes ?? DEFAULT_SESSION_BYTES);
    const budgetLeft = sessionMax <= 0 ? Number.POSITIVE_INFINITY : Math.max(0, sessionMax - state.bytes);
    const reused = state.decision && state.decision.query === query ? state.decision : null;
    let pick;
    let bodyMax;
    if (reused) {
      const byRel = new Map(entries.map((entry) => [entry.rel, entry]));
      pick = reused.picked.map((rel) => byRel.get(rel)).filter(Boolean);
      bodyMax = reused.bodyMax;
    } else {
      const candidates = dedupe ? entries.filter((entry) => !state.paths.has(entry.rel)) : entries;
      pick = candidates.length ? selectRelevant(candidates, query, 5) : [];
      const llmPick = await selectRelevantAsync(context, candidates);
      if (llmPick && llmPick.length > 0) pick = llmPick;
      bodyMax = Math.min(Number(config.recallRelevantMaxBytes ?? DEFAULT_RELEVANT_BYTES), budgetLeft);
    }
    const bundle = buildRecallBundle(store, config, cwd, query, entries, pick, bodyMax);
    if (!bundle.text) return assembled;
    if (!reused) {
      if (dedupe) {
        for (const rel of bundle.included) state.paths.add(rel);
        state.bytes += bundle.bodyBytes;
      }
      state.decision = { query, picked: pick.map((entry) => entry.rel), rels: bundle.included, bodyMax };
    }
    return {
      ...assembled,
      contexts: [
        ...assembled.contexts.filter((item) => item.name !== "memory:index"),
        { name: "memory:index", text: bundle.text }
      ]
    };
  }, { global: true, prepend: true });
  ctx.logger?.info?.("[dsh-memory] recall injector installed");
}
function appendRememberGuide(ctx, store, session, event) {
  const fromRegistry = ctx.agents?.get?.(session.id);
  const fromScope = ctx.get?.("agent");
  const agent = fromRegistry ?? (fromScope?.session === session || fromScope?.session?.id === session.id ? fromScope : null);
  if (!agent?.inbox?.append) return;
  const indexPath = join4(store.root, "MEMORY.md");
  try {
    agent.inbox.append("next-step", {
      id: `dsh-memory-guide-${event.data?.id ?? event.seq ?? Date.now()}`,
      role: "user",
      source: { kind: "plugin", plugin: "dsh-memory", form: "notice", summary: "\u663E\u5F0F\u8BB0\u5FC6\u5199\u5165\u89C4\u5219" },
      content: [{
        type: "text",
        text: `\u8BB0\u5FC6\u89C4\u5219\uFF1A\u7528\u6237\u660E\u786E\u8981\u6C42\u957F\u671F\u8BB0\u4F4F\u3002\u73B0\u5728\u4E0D\u8981\u53EA\u7528\u6587\u5B57\u58F0\u79F0\u5DF2\u8BB0\u4F4F\u3002\u82E5 memory_remember \u5C1A\u672A\u51FA\u73B0\u5728\u9996\u8F6E\u5DE5\u5177\u4E2D\uFF0C\u5148\u7528 read \u8BFB\u53D6\u8BB0\u5FC6\u7D22\u5F15 ${indexPath}\uFF1B\u9996\u6B21\u771F\u5B9E\u5DE5\u5177\u8C03\u7528\u540E\u5B8C\u6574\u5DE5\u5177\u76EE\u5F55\u4F1A\u5C55\u5F00\u3002\u968F\u540E\u5FC5\u987B\u8C03\u7528 memory_remember\uFF0C\u5C06\u5185\u5BB9\u4FDD\u5B58\u4E3A\u5F53\u524D\u9879\u76EE\u7684\u72EC\u7ACB\u8BB0\u5FC6\u6587\u4EF6\u3002\u53EA\u6709\u5DE5\u5177\u8FD4\u56DE saved=true \u540E\u624D\u80FD\u786E\u8BA4\u201C\u5DF2\u8BB0\u4F4F\u201D\uFF1B\u5931\u8D25\u65F6\u660E\u786E\u8BF4\u660E\u672A\u4FDD\u5B58\u6210\u529F\u3002`
      }]
    });
  } catch {
  }
}
function scopedDirs(store, cwd) {
  return scopesForCwd(store.root, cwd);
}
function ignoreMemoryText() {
  return "# \u672C\u8F6E\u5DF2\u5FFD\u7565\u8BB0\u5FC6\n\n\u7528\u6237\u8981\u6C42\u672C\u8F6E\u4E0D\u4F7F\u7528\u5386\u53F2\u8BB0\u5FC6\uFF1B\u4E0D\u8981\u4F9D\u636E\u8BB0\u5FC6\u5185\u5BB9\u4F5C\u7B54\u3002";
}
function buildRecallBundle(store, config, cwd, query, entries, relevant, relevantMaxBytes) {
  if (IGNORE_MEMORY.test(String(query))) {
    return { text: ignoreMemoryText(), bodyBytes: 0, included: [] };
  }
  const dirs = scopedDirs(store, cwd);
  const lines = [];
  for (const dir of dirs) {
    const scoped = entries.filter((entry) => entry.scope === dir);
    if (scoped.length === 0) continue;
    lines.push(`## ${dir}`, "");
    for (const [type, label] of TYPE_ORDER) {
      const typed = scoped.filter((entry) => (entry.type ?? "reference") === type);
      if (!typed.length) continue;
      lines.push(`### ${label}`, "");
      for (const memory of typed) {
        lines.push(`- [${memory.name}](${memory.rel})${memory.description ? ` \u2014 ${memory.description}` : ""}`);
      }
      lines.push("");
    }
  }
  const maxIndexBytes = config.recallMaxBytes ?? DEFAULT_INDEX_BYTES;
  const head = [
    "# \u8BB0\u5FC6\u7D22\u5F15\uFF08\u4EC5\u901A\u7528 + \u5F53\u524D\u9879\u76EE\uFF09",
    "",
    `\u8BB0\u5FC6\u7D22\u5F15\u6587\u4EF6\uFF1A${join4(store.root, "MEMORY.md")}`,
    "\u5F53\u524D\u7528\u6237\u6307\u4EE4\u4F18\u5148\u4E8E\u5386\u53F2\u8BB0\u5FC6\uFF1B\u9879\u76EE\u8BB0\u5FC6\u4F18\u5148\u4E8E\u901A\u7528\u8BB0\u5FC6\u3002\u9700\u8981\u66F4\u591A\u5185\u5BB9\u65F6\u4F7F\u7528 memory_search/memory_read\u3002",
    "\u7528\u6237\u660E\u786E\u8BF4\u201C\u8BB0\u4F4F\u201D\u65F6\uFF0C\u5FC5\u987B\u4EA7\u751F\u771F\u5B9E\u8BB0\u5FC6\u5DE5\u5177\u8C03\u7528\uFF0C\u4E0D\u80FD\u53EA\u7528\u6587\u5B57\u786E\u8BA4\u3002\u82E5\u9996\u8F6E memory_remember \u5C1A\u672A\u66B4\u9732\uFF0C\u5148\u7528 read \u8BFB\u53D6\u4E0A\u8FF0\u7D22\u5F15\u6587\u4EF6\u4EE5\u89E6\u53D1\u5B8C\u6574\u5DE5\u5177\u76EE\u5F55\uFF1B\u5DF2\u6709\u540C\u4E3B\u9898\u65F6\u628A\u7D22\u5F15\u4E2D\u7684 id \u4F20\u7ED9 memory_remember \u66F4\u65B0\uFF0C\u5426\u5219\u65B0\u5EFA\u72EC\u7ACB\u6587\u4EF6\u3002\u53EA\u6709\u5DE5\u5177\u8FD4\u56DE saved=true \u624D\u80FD\u8BF4\u5DF2\u8BB0\u4F4F\u3002",
    "\u7528\u6237\u8981\u6C42\u5FD8\u8BB0\u65F6\uFF0C\u5148\u641C\u7D22\u5E76\u786E\u8BA4\u76EE\u6807\uFF0C\u518D\u4F7F\u7528 memory_delete\u3002\u4E0D\u8981\u628A\u5F53\u524D\u8BA1\u5212\u3001\u53EF\u4ECE\u4EE3\u7801/Git \u63A8\u65AD\u7684\u4FE1\u606F\u6216\u4E00\u6B21\u6027\u8C03\u8BD5\u8FC7\u7A0B\u5199\u5165\u957F\u671F\u8BB0\u5FC6\u3002",
    ""
  ].join("\n");
  const index = truncateLines(lines, Math.max(maxIndexBytes - Buffer.byteLength(head), 0));
  const detail = renderRelevant(relevant ?? [], relevantMaxBytes ?? config.recallRelevantMaxBytes ?? DEFAULT_RELEVANT_BYTES);
  return { text: head + index + detail.text, bodyBytes: detail.bytes, included: detail.included };
}
function readScopedEntries(root, dirs) {
  const entries = [];
  for (const scope of dirs) {
    readDir(join4(root, scope), scope, scope, entries);
  }
  return entries;
}
function readDir(dir, scope, relBase, entries) {
  let files = [];
  try {
    files = readdirSync2(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const file of files) {
    if (file.name.startsWith(".")) continue;
    const abs = join4(dir, file.name);
    const rel = `${relBase}/${file.name}`;
    if (file.isDirectory()) {
      readDir(abs, scope, rel, entries);
      continue;
    }
    if (!file.isFile() || !file.name.endsWith(".md") || file.name === "MEMORY.md") continue;
    try {
      const raw = readFileSync2(abs, "utf8");
      const { meta, body } = parseFrontmatter(raw);
      const info = statSync(abs);
      entries.push({
        scope,
        rel,
        name: meta.name ?? file.name.replace(/\.md$/, ""),
        description: meta.description ?? "",
        type: meta.type ?? "reference",
        updated: meta.updated ?? meta.created ?? info.mtime.toISOString(),
        body: body.trim()
      });
    } catch {
    }
  }
}
function selectRelevant(entries, query, limit = 5) {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const scored = [];
  for (const entry of entries) {
    const title = entry.name.toLowerCase();
    const description = entry.description.toLowerCase();
    const body = entry.body.toLowerCase().slice(0, 8e3);
    let score = entry.scope === "\u901A\u7528" ? 0 : 2;
    let hits = 0;
    for (const term of terms) {
      let hit = false;
      if (title.includes(term)) {
        score += 8;
        hit = true;
      }
      if (description.includes(term)) {
        score += 4;
        hit = true;
      }
      if (body.includes(term)) {
        score += 1;
        hit = true;
      }
      if (hit) hits++;
    }
    if (hits > 0) scored.push({ ...entry, score: score + hits });
  }
  scored.sort((a, b) => b.score - a.score || Date.parse(b.updated || 0) - Date.parse(a.updated || 0));
  return scored.slice(0, Math.max(0, limit));
}
function queryTerms(query) {
  const text = String(query ?? "").toLowerCase().trim();
  if (!text) return [];
  const terms = new Set(text.match(/[a-z0-9_.+#-]{2,}|[\p{Script=Han}]{2,}/gu) ?? []);
  for (const run of text.match(/[\p{Script=Han}]{3,}/gu) ?? []) {
    for (let index = 0; index < run.length - 1; index++) terms.add(run.slice(index, index + 2));
  }
  return [...terms].slice(0, 24);
}
var SELECT_SYSTEM = [
  "\u4F60\u662F\u8BB0\u5FC6\u76F8\u5173\u6027\u9009\u62E9\u5668\u3002\u6839\u636E\u7528\u6237\u5F53\u524D\u67E5\u8BE2\uFF0C\u4ECE\u5019\u9009\u8BB0\u5FC6\u6E05\u5355\u4E2D\u6311\u9009\u6700\u76F8\u5173\u7684\u8BB0\u5FC6\u6761\u76EE\u3002",
  '\u53EA\u8F93\u51FA\u4E25\u683C JSON \u6570\u7EC4\uFF0C\u5143\u7D20\u662F\u5019\u9009\u6761\u76EE\u7684 id \u5B57\u7B26\u4E32\uFF0C\u4F8B\u5982 ["\u9006\u5411/box_analysis"]\u3002',
  "\u6700\u591A\u6311 5 \u6761\uFF1B\u4E0D\u76F8\u5173\u7684\u67E5\u8BE2\u5141\u8BB8\u8F93\u51FA\u7A7A\u6570\u7EC4 []\u3002\u4E0D\u8981\u8F93\u51FA\u4EFB\u4F55\u89E3\u91CA\u6216\u4EE3\u7801\u5757\u3002",
  "\u4F18\u5148\u9009\u62E9\u80FD\u76F4\u63A5\u5E2E\u52A9\u56DE\u7B54\u5F53\u524D\u67E5\u8BE2\u7684\u8BB0\u5FC6\uFF1B\u9879\u76EE\u8BB0\u5FC6\u4F18\u5148\u4E8E\u901A\u7528\u8BB0\u5FC6\uFF1B\u4E0E\u67E5\u8BE2\u65E0\u5173\u7684\u4E0D\u8981\u9009\u3002",
  // 以下两条对齐上游 cc-haha 的选择器提示词(commit d52bbec7,
  // src/memdir/findRelevantMemories.ts:18-24)。上游用 json_schema 强制结构化输出,
  // DSH 的 llm.stream 没有 output_format,因此改为把同一约束写进提示词。
  "\u53EA\u6311\u4F60\u6709\u628A\u63E1\u786E\u5B9E\u6709\u5E2E\u52A9\u7684\u6761\u76EE\uFF1B\u4E0D\u786E\u5B9A\u5C31\u4E0D\u8981\u6311\uFF0C\u5B81\u53EF\u8FD4\u56DE\u7A7A\u6570\u7EC4\u2014\u2014\u8981\u6311\u5254\u3001\u8981\u6709\u5224\u65AD\u529B\u3002",
  "\u82E5\u7ED9\u51FA\u4E86\u300C\u6700\u8FD1\u4F7F\u7528\u8FC7\u7684\u5DE5\u5177\u300D\uFF1A\u4E0D\u8981\u6311\u8FD9\u4E9B\u5DE5\u5177\u7684\u7528\u6CD5/API \u53C2\u8003\u7C7B\u8BB0\u5FC6\uFF08\u5BF9\u8BDD\u91CC\u5DF2\u7ECF\u5728\u7528\u4E86\uFF09\uFF1B\u4F46\u8981\u6311\u5305\u542B**\u5751\u3001\u8B66\u544A\u3001\u5DF2\u77E5\u95EE\u9898**\u7684\u6B64\u7C7B\u8BB0\u5FC6\u3002"
].join("\n");
async function selectRelevantByLlm(ctx, config, context, entries, query, limit = 5, recentTools = []) {
  const llm = ctx.get?.("root")?.get?.("llm") ?? ctx.get?.("llm") ?? ctx.llm;
  if (!llm?.stream) return null;
  const sessionId = context?.agent?.session?.id;
  let provider = config.selectProvider || config.provider || void 0;
  let model = config.selectModel || config.model || void 0;
  if (!provider || !model) {
    const agent = sessionId ? ctx.agents?.get?.(sessionId) : null;
    provider = provider ?? agent?.options?.provider ?? context?.agent?.options?.provider;
    model = model ?? agent?.options?.model ?? context?.agent?.options?.model;
  }
  if (!provider || !model) return null;
  const manifest = entries.map((e) => `- ${e.rel} [${e.type ?? "reference"}] ${e.name}${e.description ? ` \u2014 ${e.description}` : ""}`).join("\n");
  const toolsSection = Array.isArray(recentTools) && recentTools.length > 0 ? `

\u6700\u8FD1\u4F7F\u7528\u8FC7\u7684\u5DE5\u5177\uFF1A${recentTools.join(", ")}` : "";
  const prompt = `\u5019\u9009\u8BB0\u5FC6\u6E05\u5355\uFF1A
${manifest}

\u5F53\u524D\u7528\u6237\u67E5\u8BE2\uFF1A
${query}${toolsSection}

\u8F93\u51FA\u76F8\u5173\u8BB0\u5FC6 id \u7684 JSON \u6570\u7EC4\u3002`;
  const controller = new AbortController();
  const timeoutMs = Math.max(Number(config.selectTimeoutMs) > 0 ? Number(config.selectTimeoutMs) : 12e3, 2e3);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let text = "";
  try {
    const stream = await llm.stream({
      provider,
      model,
      system: SELECT_SYSTEM,
      messages: [{
        id: crypto.randomUUID(),
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: prompt }]
      }],
      temperature: 0,
      reasoningEffort: "off",
      maxTokens: 256,
      signal: controller.signal
    });
    for await (const chunk of stream) {
      if (chunk?.type === "text-delta") text += chunk.text ?? "";
    }
  } finally {
    clearTimeout(timeout);
  }
  if (!text.trim()) return null;
  let ids = [];
  try {
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    const parsed = JSON.parse(start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned);
    if (Array.isArray(parsed)) ids = parsed.map(String);
  } catch {
    return null;
  }
  const byId = new Map(entries.map((e) => [e.rel.replace(/\.md$/i, ""), e]));
  const picked = [];
  for (const id of ids) {
    const normalized = String(id).replace(/\\/g, "/").replace(/\.md$/i, "");
    const entry = byId.get(normalized) ?? entries.find((e) => e.rel.replace(/\.md$/i, "") === normalized || e.rel.endsWith(`/${normalized}.md`));
    if (entry && !picked.includes(entry)) picked.push(entry);
    if (picked.length >= limit) break;
  }
  return picked;
}
function renderRelevant(entries, maxBytes) {
  if (entries.length === 0 || maxBytes <= 0) return { text: "", bytes: 0, included: [] };
  const lines = ["", "# \u4E0E\u5F53\u524D\u95EE\u9898\u76F8\u5173\u7684\u8BB0\u5FC6\u6B63\u6587", ""];
  for (const entry of entries) {
    lines.push(`## ${entry.name}\uFF08${entry.scope}\uFF09`);
    const age = memoryAgeDays(entry.updated);
    if (age > 1 && (entry.type === "project" || entry.type === "reference")) {
      lines.push(`> \u6B64\u8BB0\u5FC6\u7EA6 ${age} \u5929\u524D\u66F4\u65B0\uFF0C\u53EF\u80FD\u5DF2\u7ECF\u8FC7\u65F6\uFF1B\u5F15\u7528\u8DEF\u5F84\u3001\u7248\u672C\u6216\u72B6\u6001\u524D\u5FC5\u987B\u91CD\u65B0\u6838\u9A8C\u3002`);
    }
    lines.push(entry.body, "");
  }
  const text = truncateByBytes(lines.join("\n"), maxBytes);
  const included = [];
  for (const entry of entries) {
    if (text.includes(`## ${entry.name}\uFF08${entry.scope}\uFF09`)) included.push(entry.rel);
  }
  return { text, bytes: Buffer.byteLength(text), included };
}
function memoryAgeDays(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 0;
  return Math.floor(Math.max(0, Date.now() - timestamp) / 864e5);
}
function truncateLines(lines, maxBytes) {
  const selected = [];
  let bytes = 0;
  let truncated = false;
  for (const line of lines.slice(0, MAX_INDEX_LINES)) {
    const next = Buffer.byteLength(`${line}
`);
    if (bytes + next > maxBytes) {
      truncated = true;
      break;
    }
    selected.push(line);
    bytes += next;
  }
  if (lines.length > MAX_INDEX_LINES) truncated = true;
  if (truncated) selected.push("", "> WARNING\uFF1A\u8BB0\u5FC6\u7D22\u5F15\u8D85\u8FC7 200 \u884C\u6216 25KB\uFF0C\u5DF2\u622A\u65AD\uFF1B\u8BF7\u4F7F\u7528 memory_search \u68C0\u7D22\u5B8C\u6574\u5185\u5BB9\u3002", "");
  return selected.join("\n");
}
function truncateByBytes(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let output = "";
  for (const line of text.split("\n")) {
    if (Buffer.byteLength(`${output}${line}
`) > maxBytes) break;
    output += `${line}
`;
  }
  return `${output}> \u76F8\u5173\u8BB0\u5FC6\u6B63\u6587\u5DF2\u622A\u65AD\uFF1B\u9700\u8981\u65F6\u4F7F\u7528 memory_read \u8BFB\u53D6\u5B8C\u6574\u5185\u5BB9\u3002
`;
}

// src/api.ts
var BODY_LIMIT = 64 * 1024;
function installMemoryApi(ctx, store, importer) {
  ctx.inject(["webServer"], (scope) => {
    scope.webServer.register({
      kind: "prefix",
      path: "/memory",
      handler: (request, response) => {
        void handle(request, response, ctx, store, importer);
      }
    });
  });
}
async function handle(request, response, ctx, store, importer) {
  try {
    const url = new URL(request.url, "http://dsh.local");
    const path = url.pathname.replace(/^\/memory/, "");
    const method = request.method ?? "GET";
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const scope = requestScope(ctx, store, sessionId);
    if (path === "/api/scope" && method === "GET") {
      return json(response, 200, { ok: true, project: scope.project, scopes: scope.scopes, cwdKnown: Boolean(scope.cwd) });
    }
    if (path === "/api/index" && method === "GET") {
      const entries = await store.indexEntries();
      return json(response, 200, { ok: true, entries: entries.filter((entry) => scope.scopes.includes(entry.section)) });
    }
    if (path === "/api/get" && method === "GET") {
      const id = url.searchParams.get("id");
      const memory = id ? await store.get(id, { scopes: scope.scopes }) : null;
      return memory ? json(response, 200, { ok: true, memory }) : json(response, 404, { ok: false, error: "\u8BB0\u5FC6\u4E0D\u5B58\u5728" });
    }
    if (path === "/api/search" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const results = await store.search(q, {
        type: url.searchParams.get("type") ?? void 0,
        limit: Number(url.searchParams.get("limit") ?? 10),
        scopes: scope.scopes
      });
      return json(response, 200, { ok: true, count: results.length, results });
    }
    if (path === "/api/suggest-tags" && method === "GET") {
      const tags = await store.suggestTags(url.searchParams.get("text") ?? "", 5, { scopes: scope.scopes });
      return json(response, 200, { ok: true, tags });
    }
    if (path === "/api/import" && method === "POST") {
      const result = await importer(store.root);
      return json(response, 200, { ok: true, ...result });
    }
    if (method === "POST" && ["/api/write", "/api/update", "/api/delete"].includes(path)) {
      const body = await readBody(request);
      if (path === "/api/write") {
        const targetScope = body.scope === "general" ? GENERAL_SCOPE : scope.project;
        if (!targetScope) return json(response, 400, { ok: false, error: "\u5F53\u524D\u4F1A\u8BDD\u6CA1\u6709\u53EF\u8BC6\u522B\u7684\u9879\u76EE\uFF1B\u8BF7\u9009\u62E9\u5199\u5165\u901A\u7528\u8BB0\u5FC6" });
        try {
          const memory = await store.write(body, { scope: targetScope });
          return json(response, 200, { ok: true, saved: true, id: memory.id, scope: targetScope });
        } catch (error) {
          if (error?.code === "MEMORY_CONFLICT") return json(response, 409, { ok: false, saved: false, code: error.code, error: error.message });
          throw error;
        }
      }
      if (path === "/api/update") {
        const memory = await store.update(body.id, { ...body, scopes: scope.scopes });
        return memory ? json(response, 200, { ok: true, id: memory.id }) : json(response, 404, { ok: false, error: "\u8BB0\u5FC6\u4E0D\u5B58\u5728" });
      }
      const removed = await store.remove(body.id, { scopes: scope.scopes });
      return removed ? json(response, 200, { ok: true }) : json(response, 404, { ok: false, error: "\u8BB0\u5FC6\u4E0D\u5B58\u5728" });
    }
    return json(response, 404, { ok: false, error: `unknown endpoint: ${method} ${path}` });
  } catch (error) {
    return json(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
function requestScope(ctx, store, sessionId) {
  const agents = ctx.get?.("agents") ?? ctx.agents;
  const cwd = sessionId ? agents?.get?.(sessionId)?.session?.header?.cwd : void 0;
  const project = resolveProjectScope(store.root, cwd);
  return { cwd, project, scopes: scopesForCwd(store.root, cwd) };
}
function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(body);
}
async function readBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > BODY_LIMIT) throw new Error("body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

// src/index.ts
var name = "dsh-memory";
var inject = ["tools", "systemPrompt", "agents", "llm", "settings"];
var Config = z.object({
  storageDir: z.string().default(defaultStorageDir()).description("\u8BB0\u5FC6\u5B58\u50A8\u76EE\u5F55(\u9ED8\u8BA4 ~/.dsh/memory)"),
  reviewEnabled: z.boolean().default(true).description("\u56DE\u5408\u540E\u81EA\u52A8\u8BB0\u5F55"),
  reviewInterval: z.natural().min(1).default(1).description("\u6BCF N \u56DE\u5408\u8BC4\u5BA1\u4E00\u6B21(\u5BF9\u9F50\u539F\u7248\u6BCF\u8F6E\u63D0\u53D6)"),
  reviewMaxTokens: z.natural().min(64).default(1e3).description("\u5355\u6B21\u8BC4\u5BA1\u8F93\u51FA\u4E0A\u9650"),
  reviewTimeoutMs: z.natural().min(1e3).default(12e4).description("\u81EA\u52A8\u8BB0\u5F55\u8BC4\u5BA1\u603B\u8D85\u65F6(ms)"),
  provider: z.string().default("").description("\u81EA\u52A8\u8BB0\u5F55 provider(\u7A7A=\u7EE7\u627F\u4F1A\u8BDD)"),
  model: z.string().default("").description("\u81EA\u52A8\u8BB0\u5F55 model(\u7A7A=\u7EE7\u627F\u4F1A\u8BDD)"),
  recallOrder: z.number().default(117).description("\u7D22\u5F15\u6CE8\u5165\u987A\u5E8F"),
  recallMaxBytes: z.natural().min(1024).default(25e3).description("\u6CE8\u5165\u7D22\u5F15\u4E0A\u9650\u5B57\u8282"),
  recallRelevantMaxBytes: z.natural().min(1024).default(16e3).description("\u5355\u6B21\u76F8\u5173\u8BB0\u5FC6\u6B63\u6587\u6CE8\u5165\u4E0A\u9650\u5B57\u8282"),
  sessionMaxBytes: z.natural().min(0).default(61440).description("\u672C\u4F1A\u8BDD\u76F8\u5173\u8BB0\u5FC6\u6B63\u6587\u7D2F\u8BA1\u6CE8\u5165\u4E0A\u9650\u5B57\u8282(0=\u4E0D\u9650);\u5BF9\u9F50 CC-HAHA MAX_SESSION_BYTES=60KB"),
  dedupeRelevant: z.boolean().default(true).description("\u540C\u4E00\u4F1A\u8BDD\u5185\u5DF2\u6CE8\u5165\u8FC7\u7684\u8BB0\u5FC6\u6B63\u6587\u4E0D\u518D\u91CD\u590D\u6CE8\u5165(\u5BF9\u9F50 CC-HAHA alreadySurfaced)"),
  guidanceEnabled: z.boolean().default(true).description('\u628A"\u5F15\u7528\u8BB0\u5FC6\u524D\u7684\u6838\u9A8C"\u6307\u5357\u653E\u8FDB\u7CFB\u7EDF\u63D0\u793A\u8BCD\u7684\u9759\u6001 section(\u5BF9\u9F50 CC-HAHA TRUSTING_RECALL/DRIFT_CAVEAT)'),
  guidanceOrder: z.number().default(118).description("\u4F7F\u7528\u6307\u5357 section \u7684\u6392\u5E8F\u4F4D"),
  recentToolsEnabled: z.boolean().default(true).description('\u628A"\u6700\u8FD1\u4F7F\u7528\u8FC7\u7684\u5DE5\u5177"\u4F20\u7ED9\u76F8\u5173\u6027\u9009\u62E9\u5668,\u907F\u514D\u6CE8\u5165\u6B63\u5728\u4F7F\u7528\u7684\u5DE5\u5177\u7684\u53C2\u8003\u7C7B\u8BB0\u5FC6'),
  recentToolsWindow: z.natural().min(0).default(8).description('"\u6700\u8FD1\u4F7F\u7528\u8FC7\u7684\u5DE5\u5177"\u4FDD\u7559\u4E2A\u6570(0=\u4E0D\u4F20)'),
  selectEnabled: z.boolean().default(true).description("LLM \u8BED\u4E49\u76F8\u5173\u6027\u9009\u62E9(\u5931\u8D25\u56DE\u843D\u5173\u952E\u8BCD\u8BC4\u5206)"),
  selectProvider: z.string().default("").description("\u76F8\u5173\u6027\u9009\u62E9 provider(\u7A7A=\u7EE7\u627F\u4F1A\u8BDD)"),
  selectModel: z.string().default("").description("\u76F8\u5173\u6027\u9009\u62E9 model(\u7A7A=\u7EE7\u627F\u4F1A\u8BDD)"),
  selectTimeoutMs: z.natural().min(2e3).default(12e3).description("\u76F8\u5173\u6027\u9009\u62E9\u8D85\u65F6(ms)"),
  skipReviewAfterAgentWrite: z.boolean().default(true).description("\u672C\u56DE\u5408\u4E3B agent \u81EA\u5DF1\u5199\u8FC7\u8BB0\u5FC6\u65F6\uFF0C\u8DF3\u8FC7\u8BE5\u56DE\u5408\u7684\u540E\u53F0\u8BC4\u5BA1(\u5BF9\u9F50\u4E0A\u6E38 hasMemoryWritesSince)")
});
function apply(ctx, config = {}) {
  const storageDir = config.storageDir ?? defaultStorageDir();
  const store = new MemoryStore(storageDir);
  void (async () => {
    try {
      await store.ensureDirs();
      await store.refreshIndex();
      const result = await importClaudeMemory(storageDir);
      seedClaudeProjectMappings(storageDir);
      await store.refreshIndex();
      if (result.imported > 0) {
        ctx.logger?.info?.(`[dsh-memory] imported ${result.imported} memory(ies) from Claude Code`);
      }
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-memory] init failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();
  registerMemoryTools(ctx, store);
  const recorder = new TurnRecorder(ctx, store, config);
  recorder.install();
  installRecall(ctx, store, config);
  installMemoryApi(ctx, store, importClaudeMemory);
  ctx.logger?.info?.(`[dsh-memory] ready; storage=${storageDir} (index=${INDEX_FILE})`);
}
var index_default = { name, inject, Config, apply };
export {
  Config,
  apply,
  index_default as default,
  inject,
  name
};
//# sourceMappingURL=index.js.map
