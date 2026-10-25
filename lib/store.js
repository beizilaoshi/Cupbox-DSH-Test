/**
 * dsh-cupbox / store.js — 本地持久化
 *
 * 数据目录优先级：DSH_CUPBOX_DIR > DSH_PROFILE_DIR/cupbox > ~/.dsh/cupbox
 * 里面就两个文件：workflows.json（用户工作流）与 runs.json（最近运行记录）。
 *
 * 内置模板是代码里的常量：每次 list 时与用户工作流合并，
 * 用户存了同 id 的工作流会自动覆盖模板（模板带 builtin: true 标记）。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const MAX_RUNS = 40;

/** 设置页的默认值：留空表示“跟着宿主/自动挑”。 */
export const DEFAULT_SETTINGS = {
  defaultRoute: '',
  teamMode: 'parallel',
  teamMembers: [],
  judgeRoute: '',
};

/** 把任意输入收敛成合法设置，避免面板写进脏数据。 */
export function normalizeSettings(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const route = (value) => (typeof value === 'string' && /^[^/\s]+\/[^/\s]+$/.test(value.trim()) ? value.trim() : '');
  const members = Array.isArray(raw.teamMembers)
    ? raw.teamMembers
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry) => route(entry) !== '')
        .slice(0, 6)
    : [];
  return {
    defaultRoute: route(raw.defaultRoute),
    teamMode: raw.teamMode === 'debate' ? 'debate' : 'parallel',
    teamMembers: Array.from(new Set(members)),
    judgeRoute: route(raw.judgeRoute),
  };
}

export function resolveDataDir() {
  const explicit = process.env.DSH_CUPBOX_DIR;
  if (explicit && explicit.trim() !== '') return explicit.trim();
  const profile = process.env.DSH_PROFILE_DIR;
  if (profile && profile.trim() !== '') return join(profile.trim(), 'cupbox');
  return join(homedir(), '.dsh', 'cupbox');
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  ensureDir(dirname(file));
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function safeName(value) {
  return String(value ?? '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/* ── 内置模板工作流 ───────────────────────────────────────────────── */

export const TEMPLATES = [
  {
    id: 'research',
    name: '深度调研',
    description: '先拆问题，再并行调研三个角度，最后汇总成一份可读报告。',
    builtin: true,
    vars: {},
    nodes: [
      { id: 'start', label: '接收任务', kind: 'start' },
      {
        id: 'decompose',
        label: '拆解问题',
        kind: 'model',
        prompt:
          '你是调研负责人。把下面的任务拆成三个互不重叠、可以并行调研的子问题，每个子问题写清「要回答什么」和「验收标准」。只输出列表，不要客套。\n\n任务：{{input}}',
      },
      {
        id: 'angle-a',
        label: '角度 A：现状',
        kind: 'model',
        prompt:
          '基于下面的子问题清单，只负责【现状与事实】这一块的调研：有哪些已知事实、数据、时间线？哪些是共识、哪些还有争议？用条目输出，不确定的地方明确标注「待核实」。\n\n{{nodes.decompose}}',
      },
      {
        id: 'angle-b',
        label: '角度 B：机制',
        kind: 'model',
        prompt:
          '基于下面的子问题清单，只负责【机制与原因】这一块的调研：为什么会这样？关键变量与因果关系是什么？给出 2-3 个竞争性解释并说明哪个更可信。\n\n{{nodes.decompose}}',
      },
      {
        id: 'angle-c',
        label: '角度 C：风险',
        kind: 'model',
        prompt:
          '基于下面的子问题清单，只负责【风险与反例】这一块的调研：最可能出错的假设是什么？有哪些反例、边界条件、失败案例？按「风险 → 触发条件 → 缓解」输出。\n\n{{nodes.decompose}}',
      },
      {
        id: 'synthesize',
        label: '汇总报告',
        kind: 'model',
        prompt:
          '把三份调研整理成一份给决策者看的报告，结构：\n1) 一句话结论\n2) 关键事实（带出处/不确定性标注）\n3) 机制解释\n4) 风险与反例\n5) 建议的下一步（最多 3 条）\n\n原始任务：{{input}}\n\n=== 现状 ===\n{{nodes.angle-a}}\n\n=== 机制 ===\n{{nodes.angle-b}}\n\n=== 风险 ===\n{{nodes.angle-c}}',
      },
    ],
    edges: [
      ['start', 'decompose'],
      ['decompose', 'angle-a'],
      ['decompose', 'angle-b'],
      ['decompose', 'angle-c'],
      ['angle-a', 'synthesize'],
      ['angle-b', 'synthesize'],
      ['angle-c', 'synthesize'],
    ],
  },
  {
    id: 'review-panel',
    name: '多模型评审团',
    description: '同一份材料交给三个不同模型评审，再汇总成裁决结论。',
    builtin: true,
    nodes: [
      { id: 'start', label: '接收材料', kind: 'start' },
      {
        id: 'review-1',
        label: '评审 A：挑错',
        kind: 'model',
        prompt:
          '你是严格的技术评审。逐条指出下面材料里的问题：事实错误、逻辑跳跃、遗漏的边界条件、不可执行的建议。每条给「问题 → 为什么是问题 → 怎么改」。\n\n{{input}}',
      },
      {
        id: 'review-2',
        label: '评审 B：读者视角',
        kind: 'model',
        prompt:
          '你是从零开始的读者。读下面这段材料时，哪里让你困惑、哪里没有说服你、哪里需要更多证据？请以问题清单的方式输出，不要复述材料。\n\n{{input}}',
      },
      {
        id: 'review-3',
        label: '评审 C：落地视角',
        kind: 'model',
        prompt:
          '你是负责落地的工程师。这段材料如果直接拿去执行，会在哪里卡住？给出具体阻塞点、缺失信息、以及最小可行改法。\n\n{{input}}',
      },
      {
        id: 'chair',
        label: '裁决',
        kind: 'model',
        prompt:
          '三位评审的意见如下。请去重、合并、判定优先级，输出最终评审结论：必须改（阻断）、建议改、可以保留。对每条注明依据来自哪位评审。\n\n=== 评审 A ===\n{{nodes.review-1}}\n\n=== 评审 B ===\n{{nodes.review-2}}\n\n=== 评审 C ===\n{{nodes.review-3}}',
      },
    ],
    edges: [
      ['start', 'review-1'],
      ['start', 'review-2'],
      ['start', 'review-3'],
      ['review-1', 'chair'],
      ['review-2', 'chair'],
      ['review-3', 'chair'],
    ],
  },
  {
    id: 'translate-polish',
    name: '翻译润色',
    description: '直译 → 母语化改写 → 术语与语气校对，三步流水线。',
    builtin: true,
    nodes: [
      { id: 'start', label: '接收原文', kind: 'start' },
      {
        id: 'literal',
        label: '直译',
        kind: 'model',
        prompt: '把下面的内容翻译成中文，尽量贴原句结构，不要润色，保留术语原文：\n\n{{input}}',
      },
      {
        id: 'polish',
        label: '母语化',
        kind: 'model',
        prompt:
          '把下面这段直译文本改写成像中文母语者写的：调整语序、替换生硬表达、统一人称。不要增删信息。\n\n{{nodes.literal}}',
      },
      {
        id: 'proof',
        label: '校对',
        kind: 'model',
        prompt:
          '对照原文与译文做最后校对。输出两段：\n1) 最终译文\n2) 修改说明（只列实质性改动，最多 5 条）\n\n原文：\n{{input}}\n\n译文：\n{{nodes.polish}}',
      },
    ],
    edges: [
      ['start', 'literal'],
      ['literal', 'polish'],
      ['polish', 'proof'],
    ],
  },
  {
    id: 'quick-answer',
    name: '快速问答',
    description: '单节点最小工作流：一个起手模板，方便改成自己的。',
    builtin: true,
    nodes: [
      { id: 'start', label: '输入', kind: 'start' },
      {
        id: 'answer',
        label: '回答',
        kind: 'model',
        prompt: '请回答下面的问题，先给结论，再给两三条关键理由：\n\n{{input}}',
      },
    ],
    edges: [['start', 'answer']],
  },
];

/* ── 存储 ─────────────────────────────────────────────────────────── */

export class CupboxStore {
  constructor(dir = resolveDataDir()) {
    this.dir = dir;
    this.workflowsFile = join(dir, 'workflows.json');
    this.runsFile = join(dir, 'runs.json');
    this.settingsFile = join(dir, 'settings.json');
    ensureDir(dir);
  }

  /** 面板里保存的默认路由 / 协作偏好。 */
  readSettings() {
    const raw = readJson(this.settingsFile, null);
    return normalizeSettings({ ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) });
  }

  saveSettings(patch) {
    const next = normalizeSettings({ ...this.readSettings(), ...(patch ?? {}) });
    writeJson(this.settingsFile, next);
    return next;
  }

  /** 用户工作流（不含模板）。 */
  readWorkflows() {
    const raw = readJson(this.workflowsFile, { workflows: [] });
    const list = Array.isArray(raw) ? raw : raw?.workflows;
    return Array.isArray(list) ? list : [];
  }

  writeWorkflows(list) {
    writeJson(this.workflowsFile, { workflows: list });
  }

  /** 模板 + 用户工作流，用户同 id 覆盖模板。 */
  listWorkflows() {
    const user = this.readWorkflows();
    const ids = new Set(user.map((workflow) => workflow.id));
    const templates = TEMPLATES.filter((template) => !ids.has(template.id)).map((template) => ({
      ...template,
      nodes: template.nodes.map((node) => ({ ...node })),
    }));
    return [...templates, ...user];
  }

  getWorkflow(id) {
    if (!id) return undefined;
    return this.listWorkflows().find((workflow) => workflow.id === id);
  }

  saveWorkflow(workflow) {
    const list = this.readWorkflows();
    const index = list.findIndex((entry) => entry.id === workflow.id);
    const next = { ...workflow, builtin: false, updatedAt: new Date().toISOString() };
    if (index >= 0) list[index] = next;
    else list.push(next);
    this.writeWorkflows(list);
    return next;
  }

  deleteWorkflow(id) {
    const list = this.readWorkflows();
    const next = list.filter((entry) => entry.id !== id);
    const removed = next.length !== list.length;
    if (removed) this.writeWorkflows(next);
    return removed;
  }

  listRuns() {
    const raw = readJson(this.runsFile, { runs: [] });
    const list = Array.isArray(raw) ? raw : raw?.runs;
    return Array.isArray(list) ? list : [];
  }

  appendRun(record) {
    const list = this.listRuns();
    list.unshift(record);
    writeJson(this.runsFile, { runs: list.slice(0, MAX_RUNS) });
    return record;
  }

  clearRuns() {
    writeJson(this.runsFile, { runs: [] });
  }
}
