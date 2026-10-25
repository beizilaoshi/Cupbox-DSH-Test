/**
 * dsh-cupbox — 宿主半边
 *
 * 把 Cupbox 的核心能力（工作流 DAG、多模型协作、JS 变换节点）带进 DeepSeek Harness：
 *   · 工具：cupbox_list / cupbox_run / cupbox_team   —— 让 Agent 自己编排多模型工作流
 *   · HTTP：/dsh-cupbox-api/*                        —— 给 Web 面板读写工作流与运行记录
 *   · 面板：lib/client.js                            —— conversation.view + settings.section
 *
 * 三条纪律：
 *   1. apply() 绝不抛错（否则该条目 fiber 失败，启动审计会报 failed to load plugins）
 *   2. 只声明确实存在的服务（tools），其余用 ctx.get 可选访问
 *   3. 模型调用一律走 ctx.llm.stream，不自己拼 HTTP
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CupboxStore, resolveDataDir, TEMPLATES } from './store.js';
import { WorkflowError, buildTeamWorkflow, normalizeDefinition, planLayers, runWorkflow } from './engine.js';

const PACKAGE_ID = 'dsh-cupbox';
const ROUTE_PREFIX = '/dsh-cupbox-api';
const MAX_NODE_TEXT_TOOLS = 6000;
const MAX_NODE_TEXT_PANEL = 20000;
const LOGO_FILE = fileURLToPath(new URL('../assets/cupbox-logo.svg', import.meta.url));

let logoCache = null;

/** 设置页头部用的品牌 logo（读包内 assets/cupbox-logo.svg，失败返回 null）。 */
function readLogo() {
  if (logoCache !== null) return logoCache;
  try {
    logoCache = readFileSync(LOGO_FILE, 'utf8');
  } catch {
    logoCache = '';
  }
  return logoCache;
}

export const inject = ['tools'];

/* ── 小工具 ───────────────────────────────────────────────────────── */

function loggerFor(ctx) {
  const sink = typeof ctx?.logger === 'function' ? ctx.logger(PACKAGE_ID) : ctx?.logger;
  return (message) => {
    try {
      if (sink && typeof sink.info === 'function') sink.info(`[${PACKAGE_ID}] ${message}`);
      else console.info(`[${PACKAGE_ID}] ${message}`);
    } catch {
      /* 日志失败无所谓 */
    }
  };
}

function textBlock(text) {
  return { type: 'text', text };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** 直接写 Node 的 ServerResponse（Web 服务器路由用）。 */
function sendJson(res, value, status = 200) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function errorResponse(error, status = 400) {
  const message = error instanceof Error ? error.message : String(error);
  return jsonResponse({ ok: false, error: message }, status);
}

async function readJsonBody(request) {
  const text = await request.text();
  if (text.trim() === '') return {};
  return JSON.parse(text);
}

function truncate(text, limit) {
  if (typeof text !== 'string') return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…（已截断，共 ${text.length} 字）`;
}

/* ── 模型路由发现 ─────────────────────────────────────────────────── */

function createRouteCatalog(ctx) {
  let cache = null;
  let cachedAt = 0;

  async function load() {
    const llm = ctx.get('llm');
    if (!llm) return { providers: [], routes: [], defaultRoute: null };
    const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : [];
    const routes = [];
    for (const provider of providers) {
      try {
        const models = typeof llm.listModels === 'function' ? await llm.listModels(provider.id) : [];
        for (const model of models) {
          routes.push({
            provider: provider.id,
            providerName: provider.name ?? provider.id,
            model: model.id,
            name: model.name ?? model.id,
            reasoning: model.reasoning ?? null,
          });
        }
      } catch {
        /* 一个 provider 探测失败不影响其它 */
      }
    }
    const preferred = routes.find((route) => /flash|chat|pro/i.test(route.model)) ?? routes[0] ?? null;
    return { providers, routes, defaultRoute: preferred };
  }

  return {
    async get(force = false) {
      const now = Date.now();
      if (!force && cache !== null && now - cachedAt < 60_000) return cache;
      cache = await load();
      cachedAt = now;
      return cache;
    },
  };
}

/** "provider/model" 或 {provider,model} → 路由；无法识别返回 null。 */
function parseRoute(value) {
  if (!value) return null;
  if (typeof value === 'object' && value.provider && value.model) {
    return { provider: String(value.provider), model: String(value.model) };
  }
  if (typeof value !== 'string') return null;
  const index = value.indexOf('/');
  if (index <= 0 || index === value.length - 1) return null;
  return { provider: value.slice(0, index), model: value.slice(index + 1) };
}

/* ── 运行入口（工具与 HTTP 共用） ─────────────────────────────────── */

function createRunner(ctx, store, catalog, log) {
  return async function run(request) {
    const llm = ctx.get('llm');
    if (!llm) throw new WorkflowError('当前宿主没有可用的 llm 服务，无法调用模型');

    const definition = request.definition
      ? normalizeDefinition(request.definition)
      : (() => {
          const found = store.getWorkflow(request.workflowId);
          if (!found) throw new WorkflowError(`找不到工作流：${request.workflowId}`);
          return normalizeDefinition(found);
        })();

    const catalogState = await catalog.get();
    const settings = store.readSettings();
    const override = parseRoute(request.route) ?? parseRoute(settings.defaultRoute) ?? null;
    const startedAt = Date.now();
    let summary;
    try {
      summary = await runWorkflow({
        llm,
        definition,
        input: request.input ?? '',
        vars: request.vars ?? {},
        override: override ?? undefined,
        defaultRoute: catalogState.defaultRoute,
        signal: request.signal,
      });
    } catch (error) {
      const record = {
        id: `run-${startedAt.toString(36)}`,
        workflowId: definition.id,
        workflowName: definition.name,
        status: 'error',
        input: request.input ?? '',
        error: error instanceof Error ? error.message : String(error),
        startedAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        timeline: [],
      };
      store.appendRun(record);
      log(`运行失败：${definition.id} — ${record.error}`);
      throw error;
    }

    const record = {
      id: `run-${startedAt.toString(36)}`,
      workflowId: definition.id,
      workflowName: definition.name,
      status: summary.status,
      input: request.input ?? '',
      startedAt: new Date(startedAt).toISOString(),
      durationMs: summary.durationMs,
      timeline: summary.timeline,
      outputs: summary.outputs,
    };
    store.appendRun(record);
    log(`运行完成：${definition.id}（${summary.timeline.length} 个节点，${summary.durationMs}ms）`);
    return { ...summary, runId: record.id };
  };
}

/** 面板用的运行结果载荷（节点文本放大到 2 万字）。 */
function panelRunPayload(summary) {
  return {
    runId: summary.runId,
    workflowId: summary.workflowId,
    workflowName: summary.workflowName,
    status: summary.status,
    durationMs: summary.durationMs,
    outputs: Object.fromEntries(
      Object.entries(summary.outputs).map(([key, text]) => [key, truncate(text, MAX_NODE_TEXT_PANEL)]),
    ),
    timeline: summary.timeline.map((item) => ({
      nodeId: item.nodeId,
      label: item.label,
      kind: item.kind,
      status: item.status,
      durationMs: item.durationMs,
      provider: item.meta?.provider ?? null,
      model: item.meta?.model ?? null,
      error: item.error ?? null,
    })),
  };
}

/* ── 工具注册 ─────────────────────────────────────────────────────── */

function registerTools(ctx, store, catalog, run) {
  const tools = ctx.get('tools');
  if (!tools || typeof tools.register !== 'function') {
    return;
  }

  const listTool = {
    name: 'cupbox_list',
    description:
      '列出 Cupbox 工作流（含内置模板）与当前可用的模型路由。多模型编排前先用它确认 workflowId 和 provider/model。',
    parameters: {
      type: 'object',
      properties: {
        detail: { type: 'boolean', description: '为 true 时返回每条工作流的节点结构。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          workflows: { type: 'array', items: { type: 'object' } },
          routes: { type: 'array', items: { type: 'object' } },
          dataDir: { type: 'string' },
        },
      },
      render(_args, value) {
        return [textBlock(typeof value === 'string' ? value : JSON.stringify(value, null, 2))];
      },
    },
    async execute(args) {
      const detail = args?.detail === true;
      const state = await catalog.get();
      const workflows = store.listWorkflows().map((workflow) => {
        const definition = normalizeDefinition(workflow);
        const layers = planLayers(definition);
        const base = {
          id: definition.id,
          name: definition.name,
          description: definition.description,
          builtin: workflow.builtin === true,
          nodes: definition.nodes.length,
          layers: layers.length,
        };
        if (!detail) return base;
        return {
          ...base,
          graph: definition.nodes.map((node) => ({
            id: node.id,
            label: node.label,
            kind: node.kind,
            provider: node.provider ?? null,
            model: node.model ?? null,
          })),
          edges: definition.edges,
        };
      });
      return {
        workflows,
        routes: state.routes.map((route) => ({ route: `${route.provider}/${route.model}`, name: route.name })),
        dataDir: store.dir,
      };
    },
  };

  const runTool = {
    name: 'cupbox_run',
    description:
      '运行一条 Cupbox 工作流（DAG、多模型、JS 变换节点）。用 workflowId 跑内置模板，或用 definition 传内联定义。节点可分别指定 provider/model 实现多模型协作。',
    parameters: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: '工作流 id，例如 research / review-panel / quick-answer（用 cupbox_list 查）。' },
        definition: { type: 'object', description: '内联工作流定义（与 workflowId 二选一）。' },
        input: { type: 'string', description: '写入 {{input}} 的任务正文。' },
        vars: { type: 'object', description: '写入 {{vars.*}} 的变量。' },
        route: { type: 'string', description: '默认模型路由 "provider/model"；节点自己指定时以节点为准。' },
      },
      required: ['input'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          outputs: { type: 'object' },
          timeline: { type: 'array', items: { type: 'object' } },
        },
      },
      render(_args, value) {
        return [textBlock(typeof value === 'string' ? value : JSON.stringify(value, null, 2))];
      },
    },
    async execute(args) {
      if (!args?.input || typeof args.input !== 'string') {
        throw new Error('缺少 input');
      }
      const summary = await run({
        workflowId: args.workflowId,
        definition: args.definition,
        input: args.input,
        vars: args.vars,
        route: args.route,
      });
      return {
        runId: summary.runId,
        workflowId: summary.workflowId,
        workflowName: summary.workflowName,
        status: summary.status,
        durationMs: summary.durationMs,
        outputs: Object.fromEntries(
          Object.entries(summary.outputs).map(([key, text]) => [key, truncate(text, MAX_NODE_TEXT_TOOLS)]),
        ),
        timeline: summary.timeline.map((item) => ({
          nodeId: item.nodeId,
          label: item.label,
          kind: item.kind,
          status: item.status,
          durationMs: item.durationMs,
          provider: item.meta?.provider ?? null,
          model: item.meta?.model ?? null,
          error: item.error ?? null,
        })),
      };
    },
  };

  const teamTool = {
    name: 'cupbox_team',
    description:
      '多模型协作：把同一个任务分给多个模型（并行 / 辩论），再汇总并裁决。models 留空则用当前可用的全部路由（最多 3 个）。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '任务正文。' },
        models: {
          type: 'array',
          items: { type: 'string' },
          description: '成员路由列表，形如 ["deepseek-account/deepseek-flash"]。',
        },
        mode: { type: 'string', enum: ['parallel', 'debate'], description: '协作模式，默认 parallel。' },
        judge: { type: 'string', description: '裁决者路由；留空用默认路由。' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          outputs: { type: 'object' },
        },
      },
      render(_args, value) {
        return [textBlock(typeof value === 'string' ? value : JSON.stringify(value, null, 2))];
      },
    },
    async execute(args) {
      if (!args?.task || typeof args.task !== 'string') throw new Error('缺少 task');
      const state = await catalog.get();
      const settings = store.readSettings();
      const requested = Array.isArray(args.models) ? args.models.map(parseRoute).filter(Boolean) : [];
      const configured = (settings.teamMembers || []).map(parseRoute).filter(Boolean);
      const members =
        requested.length > 0
          ? requested
          : configured.length > 0
            ? configured
            : state.routes
                .filter((route) => /flash|chat|pro/i.test(route.model))
                .slice(0, 3)
                .map((route) => ({ provider: route.provider, model: route.model }));
      if (members.length === 0) throw new Error('没有可用的模型路由');
      const judgeRoute = parseRoute(args.judge) ?? parseRoute(settings.judgeRoute) ?? state.defaultRoute;
      const mode = args.mode === 'debate' || args.mode === 'parallel' ? args.mode : settings.teamMode;
      const definition = buildTeamWorkflow({
        task: args.task,
        models: members,
        mode,
        judge: judgeRoute ? { provider: judgeRoute.provider, model: judgeRoute.model } : undefined,
      });
      const summary = await run({ definition, input: args.task });
      return {
        runId: summary.runId,
        status: summary.status,
        members: members.map((member) => `${member.provider}/${member.model}`),
        outputs: Object.fromEntries(
          Object.entries(summary.outputs).map(([key, text]) => [key, truncate(text, MAX_NODE_TEXT_TOOLS)]),
        ),
      };
    },
  };

  for (const tool of [listTool, runTool, teamTool]) {
    try {
      tools.register(tool);
    } catch (error) {
      // 同名工具已存在等情况：只影响这一个工具
      console.warn(`[${PACKAGE_ID}] 工具 ${tool.name} 注册失败：${String(error)}`);
    }
  }
}

/* ── HTTP 路由（面板用） ───────────────────────────────────────────── */

function registerRoutes(ctx, store, catalog, run) {
  const connection = ctx.get('connection');
  const webServer = ctx.get('webServer');
  if (!webServer || typeof webServer.register !== 'function') {
    console.warn(`[${PACKAGE_ID}] webServer 不可用，面板 API 未注册（工具仍可用）`);
    return;
  }

  const routes = [
    {
      path: `${ROUTE_PREFIX}/state`,
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch() {
        const state = await catalog.get();
        return jsonResponse({
          ok: true,
          dataDir: resolveDataDir(),
          settings: store.readSettings(),
          workflows: store.listWorkflows(),
          runs: store.listRuns().map((entry) => ({
            id: entry.id,
            workflowId: entry.workflowId,
            workflowName: entry.workflowName,
            status: entry.status,
            input: entry.input,
            startedAt: entry.startedAt,
            durationMs: entry.durationMs,
            error: entry.error ?? null,
            nodes: (entry.timeline ?? []).map((node) => ({
              nodeId: node.nodeId,
              label: node.label,
              kind: node.kind,
              status: node.status,
              durationMs: node.durationMs,
              provider: node.meta?.provider ?? null,
              model: node.meta?.model ?? null,
              error: node.error ?? null,
            })),
          })),
          routes: state.routes.map((route) => ({ route: `${route.provider}/${route.model}`, name: route.name })),
          defaultRoute: state.defaultRoute
            ? `${state.defaultRoute.provider}/${state.defaultRoute.model}`
            : null,
          templates: TEMPLATES.map((template) => template.id),
        });
      },
    },
    {
      path: `${ROUTE_PREFIX}/run`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        try {
          const body = await readJsonBody(request);
          const summary = await run({
            workflowId: body.workflowId,
            definition: body.definition,
            input: body.input ?? '',
            vars: body.vars,
            route: body.route,
          });
          return jsonResponse({ ok: true, run: panelRunPayload(summary) });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/team`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        try {
          const body = await readJsonBody(request);
          const task = typeof body.task === 'string' ? body.task : '';
          if (task.trim() === '') return errorResponse(new Error('缺少 task'));
          const state = await catalog.get();
          const settings = store.readSettings();
          const members = (Array.isArray(body.models) ? body.models : [])
            .map(parseRoute)
            .filter(Boolean);
          const configured = (settings.teamMembers || []).map(parseRoute).filter(Boolean);
          const chosen =
            members.length > 0
              ? members
              : configured.length > 0
                ? configured
                : state.routes
                    .filter((route) => /flash|chat|pro/i.test(route.model))
                    .slice(0, 3)
                    .map((route) => ({ provider: route.provider, model: route.model }));
          if (chosen.length === 0) return errorResponse(new Error('没有可用的模型路由'));
          const mode = body.mode === 'debate' || body.mode === 'parallel' ? body.mode : settings.teamMode;
          const definition = buildTeamWorkflow({
            task,
            models: chosen,
            mode,
            judge: parseRoute(body.judge) ?? parseRoute(settings.judgeRoute) ?? state.defaultRoute ?? undefined,
          });
          const summary = await run({ definition, input: task });
          return jsonResponse({ ok: true, run: panelRunPayload(summary) });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/save`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        try {
          const body = await readJsonBody(request);
          const definition = normalizeDefinition(body.definition);
          planLayers(definition);
          store.saveWorkflow({ ...definition, builtin: false, savedAt: new Date().toISOString() });
          return jsonResponse({ ok: true, saved: definition.id });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/delete`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        try {
          const body = await readJsonBody(request);
          if (!body?.id) return errorResponse(new Error('缺少 id'));
          return jsonResponse({ ok: true, removed: store.deleteWorkflow(String(body.id)) });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/runs/clear`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch() {
        try {
          store.clearRuns();
          return jsonResponse({ ok: true });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/settings`,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      async fetch(request) {
        try {
          if ((request.method || 'GET').toUpperCase() === 'GET') {
            return jsonResponse({ ok: true, settings: store.readSettings(), dataDir: resolveDataDir() });
          }
          const body = await readJsonBody(request);
          const settings = store.saveSettings(body && body.settings ? body.settings : body);
          return jsonResponse({ ok: true, settings });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/logo.svg`,
      methods: ['GET'],
      async fetch() {
        const svg = readLogo();
        if (!svg) return new Response('logo not found', { status: 404 });
        return new Response(svg, {
          headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400' },
        });
      },
    },
  ];

  /** 把一个 Node 请求转成 Web Request 交给上面的处理函数，再把结果写回 Node 响应。 */
  const dispatch = async (req, res) => {
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      sendJson(res, { ok: false, error: '非法 URL' }, 400);
      return;
    }
    const method = (req.method || 'GET').toUpperCase();
    const route = routes.find(
      (item) =>
        item.path === url.pathname && item.methods.includes(method === 'HEAD' ? 'GET' : method),
    );
    if (!route) {
      sendJson(res, { ok: false, error: `未知路径 ${url.pathname}` }, 404);
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const hasBody = method !== 'GET' && method !== 'HEAD';
      const request = new Request(`http://localhost${url.pathname}${url.search}`, {
        method,
        headers: req.headers,
        body: hasBody ? Buffer.concat(chunks) : undefined,
      });
      const response = await route.fetch(request);
      const text = await response.text();
      const headers = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      delete headers['content-length'];
      res.writeHead(response.status, headers);
      res.end(text);
    } catch (error) {
      sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
  };

  try {
    const disposer = webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: dispatch });
    if (typeof ctx.effect === 'function' && typeof disposer === 'function') {
      ctx.effect(() => () => {
        try {
          void disposer();
        } catch {
          /* 卸载失败无所谓 */
        }
      });
    }
  } catch (error) {
    console.warn(`[${PACKAGE_ID}] 面板 API 注册失败：${String(error)}`);
  }

  // 顺手也挂一份到 Connection 的精确 Fetch 通道（宿主会先做鉴权，失败不影响上面那条）
  if (connection && connection.fetch && typeof connection.fetch.register === 'function') {
    for (const route of routes) {
      try {
        connection.fetch.register(route);
      } catch {
        /* 该通道不可用时忽略 */
      }
    }
  }
}

/* ── apply ───────────────────────────────────────────────────────── */

export function apply(ctx) {
  try {
    const log = loggerFor(ctx);
    const store = new CupboxStore();
    const catalog = createRouteCatalog(ctx);
    const run = createRunner(ctx, store, catalog, log);

    registerTools(ctx, store, catalog, run);
    registerRoutes(ctx, store, catalog, run);

    log(`已就绪：数据目录 ${store.dir}，工作流 ${store.listWorkflows().length} 条`);
  } catch (error) {
    try {
      console.error(`[${PACKAGE_ID}] 初始化失败（插件其余功能仍可用）：${String(error)}`);
    } catch {
      /* 连日志都不能抛 */
    }
  }
}

export default { apply, inject };
