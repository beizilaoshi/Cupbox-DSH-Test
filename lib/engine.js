/**
 * dsh-cupbox / engine.js — 工作流执行引擎（从 Cupbox 核心移植并适配 DSH）
 *
 * 一个 workflow 是一张 DAG：
 *   {
 *     id, name, description,
 *     vars?: Record<string, string>,
 *     nodes: Node[],
 *     edges?: Array<[fromId, toId]>,
 *   }
 *
 * Node：
 *   {
 *     id, label?, kind: 'model' | 'js' | 'join',
 *     provider?, model?,            // kind=model：留空表示用运行时默认路由
 *     system?, prompt?,             // 支持 {{input}} / {{vars.x}} / {{nodes.<id>}} 插值
 *     code?,                        // kind=js：函数体，可用 $input / $nodes / $vars，需 return
 *     separator?,                   // kind=join：拼接分隔符，默认 "\n\n"
 *     temperature?, maxTokens?, reasoningEffort?,
 *     timeoutMs?, retries?, onError?: 'fail' | 'skip',
 *     outputKey?,                   // 默认用 id；{{nodes.<outputKey>}} 取结果
 *   }
 *
 * 执行语义（与 Cupbox 的 phases 一致）：
 *   - 按拓扑层执行，同一层的节点并发（Promise.allSettled）
 *   - 节点输出写进 results[outputKey]，下游用 {{nodes.x}} 引用
 *   - 失败默认中断整条 workflow；onError:'skip' 时该节点记 skipped，下游拿到空串
 */

export class WorkflowError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'WorkflowError';
    this.nodeId = details.nodeId;
    this.cause = details.cause;
  }
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.$-]+)\s*\}\}/g;

function readPath(scope, path) {
  const parts = path.split('.');
  let cursor = scope;
  for (const part of parts) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

/** 把 {{...}} 占位符替换成作用域里的值；对象自动 JSON 化。 */
export function interpolate(template, scope) {
  if (typeof template !== 'string') return template ?? '';
  return template.replace(PLACEHOLDER, (_match, path) => {
    const value = readPath(scope, path);
    if (value === undefined || value === null) return '';
    return typeof value === 'string' ? value : stringify(value);
  });
}

export function stringify(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 校验并规范化定义，抛出的错误信息要能直接给用户看。 */
export function normalizeDefinition(raw) {
  if (!raw || typeof raw !== 'object') throw new WorkflowError('工作流定义必须是对象');
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  if (nodes.length === 0) throw new WorkflowError('工作流至少要有一个节点');
  const ids = new Set();
  const normalized = nodes.map((node, index) => {
    const id = String(node?.id ?? `node${index + 1}`).trim();
    if (id === '') throw new WorkflowError(`第 ${index + 1} 个节点缺少 id`);
    if (ids.has(id)) throw new WorkflowError(`节点 id 重复：${id}`);
    ids.add(id);
    const kind = node?.kind ?? 'model';
    if (kind !== 'model' && kind !== 'js' && kind !== 'join' && kind !== 'start') {
      throw new WorkflowError(`节点 ${id} 的 kind 只能是 model / js / join / start`);
    }
    const outputKey = node?.outputKey ? String(node.outputKey) : id;
    return {
      id,
      outputKey,
      label: node?.label ? String(node.label) : id,
      kind,
      provider: node?.provider ? String(node.provider) : undefined,
      model: node?.model ? String(node.model) : undefined,
      system: node?.system === undefined ? undefined : String(node.system),
      prompt: node?.prompt === undefined ? undefined : String(node.prompt),
      code: node?.code === undefined ? undefined : String(node.code),
      separator: node?.separator === undefined ? undefined : String(node.separator),
      temperature: typeof node?.temperature === 'number' ? node.temperature : undefined,
      maxTokens: typeof node?.maxTokens === 'number' ? node.maxTokens : undefined,
      reasoningEffort: node?.reasoningEffort ? String(node.reasoningEffort) : undefined,
      timeoutMs: typeof node?.timeoutMs === 'number' ? node.timeoutMs : 180_000,
      retries: typeof node?.retries === 'number' ? Math.max(0, Math.min(3, node.retries)) : 0,
      onError: node?.onError === 'skip' ? 'skip' : 'fail',
    };
  });

  const edges = [];
  for (const edge of Array.isArray(raw.edges) ? raw.edges : []) {
    if (!Array.isArray(edge) || edge.length < 2) throw new WorkflowError('edges 每项必须是 [from, to]');
    const from = String(edge[0]);
    const to = String(edge[1]);
    if (!ids.has(from) || !ids.has(to)) throw new WorkflowError(`edges 引用了不存在的节点：${from} -> ${to}`);
    edges.push([from, to]);
  }

  return {
    id: String(raw.id ?? 'workflow'),
    name: String(raw.name ?? raw.id ?? '未命名工作流'),
    description: raw.description ? String(raw.description) : '',
    vars: raw.vars && typeof raw.vars === 'object' ? { ...raw.vars } : {},
    nodes: normalized,
    edges,
  };
}

/** 拓扑分层；有环直接报错。没有显式 edges 时按数组顺序逐层串联。 */
export function planLayers(def) {
  const byId = new Map(def.nodes.map((node) => [node.id, node]));
  const indegree = new Map(def.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(def.nodes.map((node) => [node.id, []]));

  let edges = def.edges;
  if (edges.length === 0 && def.nodes.length > 1) {
    edges = def.nodes.slice(1).map((node, index) => [def.nodes[index].id, node.id]);
  }
  for (const [from, to] of edges) {
    outgoing.get(from).push(to);
    indegree.set(to, indegree.get(to) + 1);
  }

  const layers = [];
  const remaining = new Set(byId.keys());
  while (remaining.size > 0) {
    const layer = [...remaining].filter((id) => indegree.get(id) === 0);
    if (layer.length === 0) {
      throw new WorkflowError(`edges 中存在环，无法执行（涉及：${[...remaining].join(', ')}）`);
    }
    layers.push(layer.map((id) => byId.get(id)));
    for (const id of layer) {
      remaining.delete(id);
      for (const next of outgoing.get(id)) indegree.set(next, indegree.get(next) - 1);
    }
  }
  return layers;
}

/* ── 模型调用 ───────────────────────────────────────────────────────── */

const MAX_CAPTURED_TEXT = 200_000;

/** 流式跑一次模型调用，拼出完整文本。 */
export async function callModel(llm, options) {
  const { provider, model, system, prompt, temperature, maxTokens, reasoningEffort, signal, purpose } = options;
  if (!provider || !model) throw new WorkflowError('模型节点缺少 provider / model');
  const request = {
    provider,
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt ?? '' }] }],
  };
  if (system !== undefined && system !== '') request.system = system;
  if (temperature !== undefined) request.temperature = temperature;
  if (maxTokens !== undefined) request.maxTokens = maxTokens;
  if (reasoningEffort !== undefined) request.reasoningEffort = reasoningEffort;
  if (purpose !== undefined) request.purpose = purpose;
  if (signal !== undefined) request.signal = signal;

  let text = '';
  let usage = null;
  let failure = null;
  for await (const chunk of llm.stream(request)) {
    if (chunk.type === 'text-delta') {
      if (text.length < MAX_CAPTURED_TEXT) text += chunk.text;
    } else if (chunk.type === 'usage') {
      usage = chunk.usage;
    } else if (chunk.type === 'finish') {
      if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') failure = chunk.reason;
    }
  }
  if (failure !== null) {
    const info = failure.failure ?? {};
    const code = info.code ? ` [${info.code}]` : '';
    throw new WorkflowError(`模型调用失败${code}：${info.message ?? failure.kind}`, { cause: failure });
  }
  return { text: text.trim(), usage };
}

/* ── 节点执行 ───────────────────────────────────────────────────────── */

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

function compileJsNode(node) {
  // 允许写成函数体：可用 $input / $nodes / $vars，必须 return
  const body = `"use strict";\n${node.code ?? 'return $input;'}\n`;
  try {
    return new AsyncFunction('$input', '$nodes', '$vars', body);
  } catch (error) {
    throw new WorkflowError(`节点 ${node.id} 的 JS 代码有语法错误：${error.message}`, { nodeId: node.id, cause: error });
  }
}

function upstreamIds(def, nodeId) {
  return def.edges.filter(([, to]) => to === nodeId).map(([from]) => from);
}

/** 上游节点产出的拼接文本；没有显式 edges 时取全部已有产出。 */
function upstreamText(definition, nodeId, scope) {
  const sources = upstreamIds(definition, nodeId);
  const ids = sources.length > 0 ? sources : definition.nodes.map((node) => node.id).filter((id) => id !== nodeId);
  return ids
    .map((id) => {
      const source = definition.nodes.find((candidate) => candidate.id === id);
      const key = source?.outputKey ?? id;
      return scope.nodes[key] ?? '';
    })
    .filter((text) => text !== '')
    .join('\n\n');
}

async function executeNode(node, scope, runtime) {
  const { llm, signal, override } = runtime;

  // start：纯入口节点，把 {{input}} 直接传给下游
  if (node.kind === 'start') {
    return { text: scope.input ?? '', meta: { kind: 'start' } };
  }

  if (node.kind === 'js') {
    const fn = compileJsNode(node);
    // $input：优先用节点自己的 prompt 插值结果，否则用上游产出拼接
    const jsInput = node.prompt
      ? interpolate(node.prompt, scope)
      : upstreamText(runtime.definition, node.id, scope);
    const value = await fn(jsInput, scope.nodes, scope.vars);
    if (value === undefined) {
      return { text: '', meta: { kind: 'js' } };
    }
    return { text: typeof value === 'string' ? value : stringify(value), meta: { kind: 'js' } };
  }

  if (node.kind === 'join') {
    const separator = node.separator === undefined ? '\n\n' : node.separator;
    const upstream = upstreamIds(runtime.definition, node.id);
    const parts = upstream
      .map((from) => {
        const source = runtime.definition.nodes.find((candidate) => candidate.id === from);
        const key = source?.outputKey ?? from;
        const text = scope.nodes[key];
        return text === undefined || text === '' ? '' : `## ${source?.label ?? from}\n${text}`;
      })
      .filter((part) => part !== '');
    const joined = parts.join(separator);
    const extra = node.prompt ? interpolate(node.prompt, scope) : '';
    return { text: extra ? `${joined}\n${extra}` : joined, meta: { kind: 'join' } };
  }

  const provider = node.provider ?? override?.provider ?? runtime.defaultRoute?.provider;
  const model = node.model ?? override?.model ?? runtime.defaultRoute?.model;
  const prompt = interpolate(node.prompt ?? '{{input}}', scope);
  const system = node.system === undefined ? undefined : interpolate(node.system, scope);
  const result = await callModel(llm, {
    provider,
    model,
    system,
    prompt,
    temperature: node.temperature,
    maxTokens: node.maxTokens,
    reasoningEffort: node.reasoningEffort,
    signal,
  });
  return { text: result.text, usage: result.usage, meta: { kind: 'model', provider, model } };
}

async function executeNodeWithRetry(node, scope, runtime) {
  let attempt = 0;
  for (;;) {
    try {
      return await executeNode(node, scope, runtime);
    } catch (error) {
      if (attempt >= node.retries) throw error;
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
}

/* ── 整条 workflow ─────────────────────────────────────────────────── */

/**
 * @param {object} runtime
 * @param {object} runtime.llm              ctx.llm
 * @param {object} runtime.definition       normalizeDefinition 的结果
 * @param {string} runtime.input            {{input}} 的值
 * @param {object} [runtime.vars]
 * @param {{provider:string,model:string}} [runtime.defaultRoute]
 * @param {{provider?:string,model?:string}} [runtime.override]
 * @param {AbortSignal} [runtime.signal]
 * @param {(event:object)=>void} [runtime.onEvent]
 */
export async function runWorkflow(runtime) {
  const { definition, llm, input, onEvent } = runtime;
  const layers = planLayers(definition);
  const vars = { ...(definition.vars ?? {}), ...(runtime.vars ?? {}) };
  const nodes = {};
  const timeline = [];
  const startedAt = Date.now();
  const emit = (event) => {
    try {
      onEvent?.(event);
    } catch {
      /* 观察者失败不影响执行 */
    }
  };

  emit({ type: 'run-start', workflowId: definition.id, layers: layers.map((layer) => layer.map((node) => node.id)) });

  for (let index = 0; index < layers.length; index += 1) {
    const layer = layers[index];
    emit({ type: 'layer-start', index, nodeIds: layer.map((node) => node.id) });
    const settled = await Promise.allSettled(
      layer.map(async (node) => {
        const scope = { input: input ?? '', nodes: { ...nodes }, vars };
        const nodeStarted = Date.now();
        emit({ type: 'node-start', nodeId: node.id, label: node.label });
        try {
          const outcome = await executeNodeWithRetry(node, scope, { ...runtime, definition });
          nodes[node.outputKey] = outcome.text;
          const record = {
            nodeId: node.id,
            outputKey: node.outputKey,
            label: node.label,
            kind: node.kind,
            status: 'ok',
            text: outcome.text,
            usage: outcome.usage ?? null,
            meta: outcome.meta ?? null,
            durationMs: Date.now() - nodeStarted,
          };
          timeline.push(record);
          emit({ type: 'node-end', ...record });
          return record;
        } catch (error) {
          const record = {
            nodeId: node.id,
            outputKey: node.outputKey,
            label: node.label,
            kind: node.kind,
            status: node.onError === 'skip' ? 'skipped' : 'error',
            text: '',
            error: error?.message ?? String(error),
            durationMs: Date.now() - nodeStarted,
          };
          timeline.push(record);
          emit({ type: 'node-end', ...record });
          if (node.onError === 'skip') {
            nodes[node.outputKey] = '';
            return record;
          }
          throw new WorkflowError(`节点 ${node.label} 执行失败：${record.error}`, { nodeId: node.id, cause: error });
        }
      }),
    );
    const failed = settled.find((result) => result.status === 'rejected');
    if (failed) {
      const error = failed.reason;
      emit({ type: 'run-end', status: 'error', error: error?.message ?? String(error) });
      throw error;
    }
  }

  const ordered = timeline.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  const summary = {
    workflowId: definition.id,
    workflowName: definition.name,
    status: 'ok',
    input: input ?? '',
    outputs: nodes,
    timeline: ordered,
    durationMs: Date.now() - startedAt,
  };
  emit({ type: 'run-end', status: 'ok', durationMs: summary.durationMs });
  return summary;
}

/* ── 多模型协作：根据一个任务生成一张团队图 ─────────────────────────── */

/**
 * @param {object} options
 * @param {string} options.task
 * @param {Array<{provider:string,model:string,name?:string}>} options.models
 * @param {'parallel'|'debate'|'pipeline'} [options.mode]
 * @param {string} [options.judge]   'provider/model'，辩论/汇总的裁判
 */
export function buildTeamWorkflow(options) {
  const { task, models, mode = 'parallel', judge } = options;
  const members = models.map((route, index) => ({
    provider: route.provider,
    model: route.model,
    name: route.name ?? `agent-${index + 1}`,
  }));
  const nodes = [
    {
      id: 'brief',
      label: '任务简报',
      kind: 'model',
      provider: judge?.provider,
      model: judge?.model,
      system: '你是多模型协作团队的协调者。把用户任务整理成清晰、可执行的简报，列出目标、约束、验收标准。只输出简报正文。',
      prompt: '用户任务：\n{{input}}',
      maxTokens: 1200,
    },
  ];
  const edges = [];
  const memberIds = [];
  members.forEach((member, index) => {
    const id = `member-${index + 1}`;
    memberIds.push(id);
    nodes.push({
      id,
      label: member.name,
      kind: 'model',
      provider: member.provider,
      model: member.model,
      system: '你是多模型协作团队中的一名专家。基于简报独立完成工作，给出可验证的结论与关键推理。',
      prompt: '任务简报：\n{{nodes.brief}}\n\n原始任务：\n{{input}}',
      timeoutMs: 240_000,
    });
    edges.push(['brief', id]);
  });
  if (mode === 'debate') {
    // 串成一条链：后一位能看到前一位的结论并做批判性回应（不能成环）
    members.forEach((member, index) => {
      if (index === 0) return;
      const node = nodes.find((candidate) => candidate.id === memberIds[index]);
      const previous = memberIds[index - 1];
      edges.push([previous, memberIds[index]]);
      node.prompt = `${node.prompt}\n\n上一位专家的结论（请批判性回应，明确指出你不同意的地方）：\n{{nodes.${previous}}}`;
    });
  }
  nodes.push({
    id: 'merge',
    label: '汇总',
    kind: 'join',
  });
  memberIds.forEach((id) => edges.push([id, 'merge']));
  nodes.push({
    id: 'verdict',
    label: '最终裁决',
    kind: 'model',
    provider: judge?.provider,
    model: judge?.model,
    system: '你是首席评审。综合各模型结论，输出最终答案：先给结论，再给依据，最后列出仍存在的不确定性。',
    prompt: '原始任务：\n{{input}}\n\n各模型结论：\n{{nodes.merge}}',
    maxTokens: 3000,
  });
  edges.push(['merge', 'verdict']);

  return {
    id: `team-${Date.now().toString(36)}`,
    name: task.slice(0, 40) || '多模型协作',
    description: `多模型协作（${mode}）：${members.map((member) => member.name).join(' / ')}`,
    nodes,
    edges,
  };
}
