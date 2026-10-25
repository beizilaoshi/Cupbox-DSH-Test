/**
 * 离线冒烟测试：不装进 DSH 也能验证引擎是否正确。
 *   node test/smoke.mjs
 *
 * 用一个假的 llm 顶替 ctx.llm：收到请求后流式吐回可预测的文本，
 * 顺带验证「占位符插值 / 分层并发 / join 节点 / JS 节点 / 多模型协作图」。
 */

import assert from 'node:assert/strict';
import { buildTeamWorkflow, callModel, interpolate, normalizeDefinition, planLayers, runWorkflow } from '../lib/engine.js';
import { CupboxStore } from '../lib/store.js';

/** 假 llm：把 prompt 的前 60 个字符回显出来，便于断言。 */
function fakeLlm(calls) {
  return {
    async *stream(request) {
      calls.push(request);
      const text = request.messages?.[0]?.content?.[0]?.text ?? '';
      yield { type: 'text-delta', text: `[${request.model}] ` };
      yield { type: 'text-delta', text: text.slice(0, 60) };
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('interpolate：嵌套路径与缺失值', () => {
  const scope = { input: 'HI', nodes: { a: 'AAA' }, vars: { tone: 'dry' } };
  assert.equal(interpolate('{{input}}/{{nodes.a}}/{{vars.tone}}/{{missing}}', scope), 'HI/AAA/dry/');
});

test('normalizeDefinition：重复 id 与坏 edge 报错', () => {
  assert.throws(() => normalizeDefinition({ nodes: [{ id: 'x' }, { id: 'x' }] }), /重复/);
  assert.throws(() => normalizeDefinition({ nodes: [{ id: 'x' }], edges: [['x', 'y']] }), /不存在/);
  assert.throws(() => normalizeDefinition({ nodes: [] }), /至少/);
});

test('planLayers：菱形分层与环检测', () => {
  const def = normalizeDefinition({
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    edges: [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']],
  });
  const layers = planLayers(def).map((layer) => layer.map((node) => node.id));
  assert.deepEqual(layers, [['a'], ['b', 'c'], ['d']]);

  const cyclic = normalizeDefinition({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [['a', 'b'], ['b', 'a']] });
  assert.throws(() => planLayers(cyclic), /环/);
});

test('runWorkflow：并行 + join + js 节点', async () => {
  const calls = [];
  const definition = normalizeDefinition({
    id: 'pipeline',
    name: 'pipeline',
    nodes: [
      { id: 'start', kind: 'start' },
      { id: 'a', kind: 'model', model: 'm-a', prompt: 'A:{{input}}' },
      { id: 'b', kind: 'model', model: 'm-b', prompt: 'B:{{input}}' },
      { id: 'merge', kind: 'join', separator: '\n--\n' },
      { id: 'wrap', kind: 'js', code: 'return "<" + $input.length + ">"' },
    ],
    edges: [
      ['start', 'a'],
      ['start', 'b'],
      ['a', 'merge'],
      ['b', 'merge'],
      ['merge', 'wrap'],
    ],
  });
  const summary = await runWorkflow({
    llm: fakeLlm(calls),
    definition,
    input: '任务正文',
    defaultRoute: { provider: 'p', model: 'm-a' },
  });

  assert.equal(summary.status, 'ok');
  assert.deepEqual(calls.map((call) => call.model).sort(), ['m-a', 'm-b']);
  assert.match(summary.outputs.a, /\[m-a\]/);
  assert.match(summary.outputs.merge, /A:任务正文/);
  assert.match(summary.outputs.merge, /--/);
  assert.match(summary.outputs.wrap, /^<\d+>$/);
  assert.deepEqual(summary.timeline.map((node) => node.status), ['ok', 'ok', 'ok', 'ok', 'ok']);
});

test('runWorkflow：onError=skip 不中断', async () => {
  const llm = {
    async *stream(request) {
      if (request.model === 'bad') {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } };
        return;
      }
      yield { type: 'text-delta', text: 'ok' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const definition = normalizeDefinition({
    nodes: [
      { id: 'bad', kind: 'model', model: 'bad', prompt: 'x', onError: 'skip' },
      { id: 'good', kind: 'model', model: 'good', prompt: 'y:{{nodes.bad}}' },
    ],
    edges: [['bad', 'good']],
  });
  const summary = await runWorkflow({
    llm,
    definition,
    input: '',
    defaultRoute: { provider: 'p', model: 'good' },
  });
  assert.equal(summary.status, 'ok');
  assert.equal(summary.outputs.bad, '');
  assert.equal(summary.outputs.good, 'ok');
});

test('buildTeamWorkflow：parallel 与 debate 都可执行', async () => {
  const models = [
    { provider: 'p1', model: 'm1' },
    { provider: 'p2', model: 'm2' },
    { provider: 'p3', model: 'm3' },
  ];

  for (const mode of ['parallel', 'debate']) {
    const calls = [];
    const team = buildTeamWorkflow({ task: '评审这份方案', models, mode, judge: { provider: 'j', model: 'jm' } });
    const definition = normalizeDefinition(team);
    const layers = planLayers(definition);
    const summary = await runWorkflow({ llm: fakeLlm(calls), definition, input: '评审这份方案' });
    assert.equal(summary.status, 'ok', mode);
    assert.ok(summary.outputs.verdict.length > 0, mode);
    assert.ok(layers.length >= 3, mode);
    // 三个成员都用各自的模型跑过
    const used = calls.map((call) => call.model);
    for (const model of ['m1', 'm2', 'm3']) assert.ok(used.includes(model), `${mode} 缺 ${model}`);
  }
});

test('CupboxStore：模板可见、保存后覆盖、删除恢复模板', () => {
  const dir = `${process.env.TEMP ?? '/tmp'}/cupbox-smoke-${Date.now().toString(36)}`;
  const store = new CupboxStore(dir);
  const templates = store.listWorkflows();
  assert.ok(templates.length >= 4);
  assert.ok(templates.every((workflow) => workflow.builtin === true));

  store.saveWorkflow({ id: 'research', name: '我的调研', nodes: [{ id: 'n' }] });
  const merged = store.listWorkflows();
  assert.equal(merged.find((workflow) => workflow.id === 'research').builtin, false);
  assert.equal(merged.find((workflow) => workflow.id === 'research').name, '我的调研');

  store.deleteWorkflow('research');
  assert.equal(store.getWorkflow('research').builtin, true);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}\n      ${error?.stack ?? error}`);
  }
}
console.log(failed === 0 ? `\n全部通过（${tests.length} 项）` : `\n失败 ${failed}/${tests.length} 项`);
process.exit(failed === 0 ? 0 : 1);
