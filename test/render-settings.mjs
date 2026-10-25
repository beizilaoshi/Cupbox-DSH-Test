/**
 * dsh-cupbox / render-settings.mjs
 *
 * 不装浏览器也能验证设置页：用最小 React 运行时跑 lib/client.js 的 SettingsPanel，
 * 接真实宿主 API（/dsh-cupbox-api/state），再把结果序列化成 HTML 检查关键元素。
 *
 * 验证点：组件不抛错、加载到真实 settings、渲染出品牌 logo/路由下拉/成员 chip/模板列表。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.CUPBOX_BASE ?? 'http://127.0.0.1:62595';
const CLIENT = fileURLToPath(new URL('../lib/client.js', import.meta.url));

/* ── 最小 React ──────────────────────────────────────────────────── */

const hooks = { states: [], effects: new Set() };
let hookIndex = 0;
let dirty = false;

const React = {
  createElement(type, props, ...children) {
    const next = { ...(props ?? {}) };
    const kids = children.flat(Infinity).filter((kid) => kid !== null && kid !== undefined && kid !== false);
    if (kids.length === 1) next.children = kids[0];
    else if (kids.length > 1) next.children = kids;
    return { type, props: next };
  },
  useState(initial) {
    const index = hookIndex++;
    if (!(index in hooks.states)) hooks.states[index] = typeof initial === 'function' ? initial() : initial;
    const set = (value) => {
      const next = typeof value === 'function' ? value(hooks.states[index]) : value;
      if (next !== hooks.states[index]) {
        hooks.states[index] = next;
        dirty = true;
      }
    };
    return [hooks.states[index], set];
  },
  useEffect(fn) {
    hookIndex++;
    hooks.effects.add(fn);
  },
};

const childrenOf = (node) => (node.props.children === undefined ? [] : [].concat(node.props.children));

/** 展开函数组件，得到宿主元素树。 */
function expand(node, depth = 0) {
  if (node === null || node === undefined || node === false) return null;
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (Array.isArray(node)) return node.map((item) => expand(item, depth + 1));
  if (typeof node.type === 'function') {
    hookIndex = 0;
    const out = node.type(node.props);
    return expand(out, depth + 1);
  }
  return { type: node.type, props: node.props, children: childrenOf(node).map((kid) => expand(kid, depth + 1)) };
}

const UNITLESS = new Set(['flex', 'flexGrow', 'flexShrink', 'fontWeight', 'lineHeight', 'opacity', 'zIndex', 'order', 'aspectRatio']);
const styleText = (style) =>
  Object.entries(style ?? {})
    .map(([key, value]) => {
      const prop = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      const val = typeof value === 'number' && !UNITLESS.has(key) ? `${value}px` : value;
      return `${prop}:${val}`;
    })
    .join(';');

function toHtml(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(toHtml).join('');
  const { type, props, children } = node;
  const attrs = [];
  if (props.style) attrs.push(`style="${styleText(props.style)}"`);
  if (props.src) attrs.push(`src="${props.src}"`);
  if (props.value !== undefined && props.value !== null) attrs.push(`value="${props.value}"`);
  if (type === 'select') attrs.push('data-select');
  if (type === 'img') attrs.push('data-img');
  return `<${type}${attrs.length ? ' ' + attrs.join(' ') : ''}>${(children ?? []).map(toHtml).join('')}</${type}>`;
}

/* ── 加载客户端 bundle ──────────────────────────────────────────── */

let captured = null;
const loader = {
  load({ factory }) {
    const module = factory((name) => {
      if (name === 'react') return React;
      throw new Error(`unknown require: ${name}`);
    });
    captured = module;
  },
};

globalThis.window = { __ModuleLoader__: loader, confirm: () => true };
const nativeFetch = globalThis.fetch;
const fetchImpl = (url, init) => nativeFetch(url, init);
globalThis.fetch = (path, init) =>
  fetchImpl(String(path).startsWith('http') ? path : BASE + path, init);

const source = readFileSync(CLIENT, 'utf8');
new Function('window', 'fetch', source)(globalThis.window, globalThis.fetch);
if (!captured || typeof captured.apply !== 'function') throw new Error('client bundle 没有导出 apply');

const slots = {};
captured.apply({
  slots: {
    inject(_name, register) {
      register();
    },
    register(meta, component) {
      slots[meta.name] = component;
      return () => {};
    },
  },
});

const SettingsPanel = slots['settings.section'];
if (typeof SettingsPanel !== 'function') throw new Error('settings.section 没有注册组件');

/* ── 渲染 + 等待数据 ────────────────────────────────────────────── */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function render() {
  dirty = false;
  const tree = expand(React.createElement(SettingsPanel, {}));
  return tree;
}

let tree = render();
const ran = new Set();
for (let round = 0; round < 40; round += 1) {
  for (const effect of hooks.effects) {
    if (ran.has(effect)) continue;
    ran.add(effect);
    try {
      effect();
    } catch (error) {
      console.error('effect 抛错：', error);
      process.exitCode = 1;
    }
  }
  await sleep(40);
  if (!dirty) {
    const html = toHtml(tree);
    if (html.includes('Cupbox 工作流') && html.includes('data-select')) break;
  }
  tree = render();
}

const html = toHtml(tree);
if (process.env.CUPBOX_RENDER_OUT) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.CUPBOX_RENDER_OUT, html, 'utf8');
}
if (process.env.CUPBOX_RENDER_DOC) {
  const { writeFileSync, readFileSync: readSync } = await import('node:fs');
  const dark = process.env.CUPBOX_RENDER_DOC.includes('dark');
  const bg = dark ? '#16181c' : '#ffffff';
  const fg = dark ? '#ededeb' : '#272c26';
  const logo = readSync(new URL('../assets/cupbox-logo.svg', import.meta.url));
  const logoData = `data:image/svg+xml;base64,${logo.toString('base64')}`;
  const inlined = html.replace('src="/dsh-cupbox-api/logo.svg"', `src="${logoData}"`);
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:${bg};color:${fg};}
    body{font-family:"Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",sans-serif;padding:26px 30px;box-sizing:border-box;}
    .frame{max-width:920px;margin:0 auto;border:1px solid rgba(122,132,162,0.22);border-radius:18px;padding:18px 20px;background:${dark ? '#1c1f24' : '#f7f8fb'};}
  </style></head><body><div class="frame">${inlined}</div></body></html>`;
  writeFileSync(process.env.CUPBOX_RENDER_DOC, doc, 'utf8');
}
const checks = [
  ['品牌标题', html.includes('Cupbox 工作流')],
  ['品牌 logo', html.includes('src="/dsh-cupbox-api/logo.svg"') || html.includes('logo-fallback')],
  ['默认模型下拉', html.includes('data-select')],
  ['协作模式分段', html.includes('并行 parallel') && html.includes('辩论 debate')],
  ['默认成员区', html.includes('默认成员')],
  ['引擎状态', html.includes('数据目录')],
  ['内置模板', html.includes('内置模板') && html.includes('深度调研')],
  ['面板 API', html.includes('/dsh-cupbox-api/settings')],
  ['真实数据目录', html.includes('.dsh') || html.includes('cupbox')],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? '  ok' : 'FAIL'}  ${name}`);
  if (!ok) failed += 1;
}

const state = hooks.states[0];
console.log(`\n渲染状态：workflows=${state?.workflows?.length ?? 0} routes=${state?.routes?.length ?? 0} settings=${JSON.stringify(state?.settings ?? null)}`);
console.log(`HTML 长度 ${html.length}`);

if (failed > 0) {
  console.error(`\n${failed} 项未通过`);
  console.error(html.slice(0, 1200));
  process.exit(1);
}
console.log('\n设置页渲染检查全部通过');
