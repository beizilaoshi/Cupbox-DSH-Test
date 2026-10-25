window.__ModuleLoader__.load({
  id: 'dsh-cupbox',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
    var h = React.createElement;

    var inject = ['slots'];

    /* ── HTTP ─────────────────────────────────────────────────────── */

    function api(path, init) {
      return fetch('/dsh-cupbox-api' + path, init).then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok || body.ok === false) {
            throw new Error((body && body.error) || 'HTTP ' + res.status);
          }
          return body;
        });
      });
    }

    function postJson(path, payload) {
      return api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {}),
      });
    }

    /* ── 样式 ─────────────────────────────────────────────────────── */

    var C = {
      text: 'inherit',
      muted: 'rgba(127,127,127,0.85)',
      line: 'rgba(127,127,127,0.28)',
      soft: 'rgba(127,127,127,0.10)',
      accent: '#4f8cff',
      ok: '#2f9e63',
      warn: '#d08a2b',
      bad: '#d0483f',
    };

    var S = {
      root: { display: 'flex', flexDirection: 'column', gap: 12, padding: '14px 16px 28px', height: '100%', boxSizing: 'border-box', overflow: 'auto', fontSize: 13, fontFamily: 'inherit', color: C.text },
      tabs: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
      tab: { cursor: 'pointer', border: '1px solid ' + C.line, background: 'transparent', color: 'inherit', borderRadius: 8, padding: '5px 12px', fontSize: 13, fontFamily: 'inherit' },
      tabOn: { cursor: 'pointer', border: '1px solid ' + C.accent, background: 'rgba(79,140,255,0.12)', color: 'inherit', borderRadius: 8, padding: '5px 12px', fontSize: 13, fontFamily: 'inherit' },
      btn: { cursor: 'pointer', border: '1px solid ' + C.line, background: 'transparent', color: 'inherit', borderRadius: 8, padding: '6px 14px', fontSize: 13, fontFamily: 'inherit', whiteSpace: 'nowrap' },
      btnOn: { cursor: 'pointer', border: '1px solid transparent', background: C.accent, color: '#fff', borderRadius: 8, padding: '6px 14px', fontSize: 13, fontFamily: 'inherit', whiteSpace: 'nowrap' },
      btnTiny: { cursor: 'pointer', border: '1px solid ' + C.line, background: 'transparent', color: C.muted, borderRadius: 6, padding: '2px 8px', fontSize: 12, fontFamily: 'inherit' },
      grid: { display: 'grid', gridTemplateColumns: 'minmax(210px, 260px) minmax(0, 1fr)', gap: 14, alignItems: 'start' },
      card: { border: '1px solid ' + C.line, borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 },
      list: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 420, overflow: 'auto' },
      item: { cursor: 'pointer', border: '1px solid ' + C.line, borderRadius: 8, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 3 },
      itemOn: { cursor: 'pointer', border: '1px solid ' + C.accent, background: 'rgba(79,140,255,0.10)', borderRadius: 8, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 3 },
      label: { fontSize: 12, color: C.muted, letterSpacing: 0.2 },
      input: { width: '100%', boxSizing: 'border-box', border: '1px solid ' + C.line, borderRadius: 8, background: 'transparent', color: 'inherit', padding: '7px 10px', fontSize: 13, fontFamily: 'inherit' },
      area: { width: '100%', boxSizing: 'border-box', border: '1px solid ' + C.line, borderRadius: 8, background: 'transparent', color: 'inherit', padding: '8px 10px', fontSize: 12.5, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', lineHeight: 1.5, resize: 'vertical' },
      pre: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12.5, lineHeight: 1.55, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      dot: { width: 7, height: 7, borderRadius: 4, display: 'inline-block', flex: '0 0 auto' },
      node: { display: 'flex', gap: 8, alignItems: 'baseline', padding: '5px 0', borderBottom: '1px dashed ' + C.line },
      err: { color: C.bad, fontSize: 12.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
    };

    function btn(label, onClick, on, tiny, title) {
      return h('button', { onClick: onClick, style: tiny ? S.btnTiny : on ? S.btnOn : S.btn, title: title }, label);
    }

    function field(label, child) {
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
        h('div', { style: S.label }, label), child);
    }

    function statusColor(status) {
      if (status === 'ok' || status === 'success' || status === 'done') return C.ok;
      if (status === 'error' || status === 'failed') return C.bad;
      if (status === 'running') return C.warn;
      return C.muted;
    }

    /* ── 运行结果视图 ─────────────────────────────────────────────── */

    function RunResult(props) {
      var run = props.run;
      if (!run) return null;
      var keys = Object.keys(run.outputs || {});
      return h('div', { style: S.card },
        h('div', { style: S.row },
          h('span', { style: { fontWeight: 600 } }, run.workflowName || run.workflowId),
          h('span', { style: { color: C.muted } }, run.status + ' · ' + run.durationMs + 'ms · ' + (run.runId || '')),
          h('span', { style: { flex: 1 } }),
          props.onSave ? btn('存为工作流', props.onSave, false, true) : null),
        h('div', { style: { display: 'flex', flexDirection: 'column' } },
          (run.timeline || []).map(function (node, index) {
            return h('div', { key: index, style: S.node },
              h('span', { style: Object.assign({ background: statusColor(node.status) }, S.dot) }),
              h('span', { style: { minWidth: 120, fontWeight: 500 } }, node.label || node.nodeId),
              h('span', { style: { color: C.muted, fontSize: 12 } },
                [node.kind, node.provider && node.model ? node.provider + '/' + node.model : null, node.durationMs != null ? node.durationMs + 'ms' : null]
                  .filter(Boolean).join(' · ')),
              node.error ? h('span', { style: S.err }, node.error) : null);
          })),
        keys.length === 0 ? h('div', { style: { color: C.muted } }, '没有产出节点') : null,
        keys.map(function (key) {
          return h('details', { key: key, open: keys.length <= 2, style: { borderTop: '1px solid ' + C.line, paddingTop: 8 } },
            h('summary', { style: { cursor: 'pointer', fontWeight: 600, fontSize: 12.5 } }, key),
            h('pre', { style: S.pre }, run.outputs[key]));
        }));
    }

    /* ── 设置页：沿用 Cupbox 的 logo 与视觉语言 ───────────────────── */

    var B = {
      accent: '#7ca8f4',
      accentLine: 'rgba(124,168,244,0.62)',
      accentSoft: 'rgba(124,168,244,0.14)',
      grad: 'linear-gradient(135deg,#d6f4ff 0%,#75b8fb 48%,#8472e5 100%)',
      ink: '#0b1223',
      line: 'rgba(122,132,162,0.26)',
      soft: 'rgba(122,132,162,0.07)',
      muted: 'rgba(127,127,127,0.88)',
      faint: 'rgba(127,127,127,0.62)',
      ok: '#3f9d6d',
      bad: '#cf5a4e',
    };

    var SS = {
      page: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 880, padding: '4px 2px 40px', fontSize: 13, color: 'inherit', fontFamily: 'inherit' },
      hero: { display: 'flex', gap: 16, alignItems: 'center', padding: '18px 20px', border: '1px solid ' + B.line, borderRadius: 18, background: B.soft },
      logo: { width: 56, height: 56, borderRadius: 16, flex: '0 0 auto', boxShadow: '0 6px 18px rgba(31,52,96,0.22)' },
      logoFallback: { width: 56, height: 56, borderRadius: 16, flex: '0 0 auto', background: B.grad, display: 'grid', placeItems: 'center', color: B.ink, fontWeight: 700, fontSize: 20, boxShadow: '0 6px 18px rgba(31,52,96,0.22)' },
      eyebrow: { fontSize: 10, letterSpacing: 2.2, color: B.faint, fontWeight: 600 },
      h1: { fontSize: 21, fontWeight: 650, margin: '5px 0 4px', lineHeight: 1.35 },
      desc: { fontSize: 12, color: B.muted, lineHeight: 1.7 },
      pill: { fontSize: 11, color: B.muted, border: '1px solid ' + B.line, borderRadius: 20, padding: '3px 10px', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6 },
      dot: { width: 6, height: 6, borderRadius: 3, display: 'inline-block' },
      section: { border: '1px solid ' + B.line, borderRadius: 16, background: B.soft, padding: '16px 20px 18px', display: 'flex', flexDirection: 'column', gap: 14 },
      head: { display: 'flex', alignItems: 'flex-start', gap: 12, justifyContent: 'space-between', paddingBottom: 12, borderBottom: '1px solid ' + B.line },
      h2: { fontSize: 14.5, fontWeight: 650, margin: '4px 0 0' },
      body: { display: 'flex', flexDirection: 'column', gap: 0 },
      row: { display: 'flex', gap: 16, alignItems: 'center', justifyContent: 'space-between', padding: '11px 0', borderBottom: '1px dashed ' + B.line, flexWrap: 'wrap' },
      rowLast: { display: 'flex', gap: 16, alignItems: 'center', justifyContent: 'space-between', padding: '11px 0 2px', flexWrap: 'wrap' },
      label: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 150, flex: '0 0 auto' },
      labelText: { fontSize: 12.5, fontWeight: 550 },
      labelNote: { fontSize: 11, color: B.faint, lineHeight: 1.55, maxWidth: 330 },
      select: { minWidth: 280, maxWidth: '100%', border: '1px solid ' + B.line, borderRadius: 10, background: 'transparent', color: 'inherit', padding: '7px 10px', fontSize: 12.5, fontFamily: 'inherit' },
      seg: { display: 'inline-flex', border: '1px solid ' + B.line, borderRadius: 10, padding: 3, gap: 3, background: 'transparent' },
      segOn: { border: '1px solid ' + B.accentLine, background: B.accentSoft, borderRadius: 8, padding: '5px 14px', fontSize: 12.5, fontFamily: 'inherit', color: 'inherit', cursor: 'pointer', fontWeight: 600 },
      segOff: { border: '1px solid transparent', background: 'transparent', borderRadius: 8, padding: '5px 14px', fontSize: 12.5, fontFamily: 'inherit', color: B.muted, cursor: 'pointer' },
      chip: { display: 'inline-flex', alignItems: 'center', gap: 7, border: '1px solid ' + B.accentLine, background: B.accentSoft, borderRadius: 20, padding: '4px 10px', fontSize: 11.5, maxWidth: '100%' },
      chipX: { cursor: 'pointer', border: 0, background: 'transparent', color: B.muted, fontSize: 13, lineHeight: 1, padding: 0, fontFamily: 'inherit' },
      addSelect: { border: '1px dashed ' + B.line, borderRadius: 20, background: 'transparent', color: B.muted, padding: '4px 10px', fontSize: 11.5, fontFamily: 'inherit', maxWidth: '100%' },
      metric: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10 },
      metricCard: { border: '1px solid ' + B.line, borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 3 },
      metricNum: { fontSize: 21, fontWeight: 650, lineHeight: 1.2 },
      metricCap: { fontSize: 11, color: B.faint, letterSpacing: 0.3 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 11.5, wordBreak: 'break-all', color: B.muted },
      tpl: { display: 'flex', gap: 12, alignItems: 'baseline', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px dashed ' + B.line, flexWrap: 'wrap' },
      tplName: { fontSize: 12.5, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 7 },
      badge: { fontSize: 10, color: B.muted, border: '1px solid ' + B.line, borderRadius: 5, padding: '0 5px', fontWeight: 400 },
      tplMeta: { fontSize: 11, color: B.faint, whiteSpace: 'nowrap' },
      tinyBtn: { cursor: 'pointer', border: '1px solid ' + B.line, background: 'transparent', color: B.muted, borderRadius: 8, padding: '4px 10px', fontSize: 11.5, fontFamily: 'inherit' },
      footer: { display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', paddingTop: 4, fontSize: 11, color: B.faint },
      toast: { fontSize: 11, color: B.ok, whiteSpace: 'nowrap' },
    };

    function sfield(label, note, control, last) {
      return h('div', { style: last ? SS.rowLast : SS.row },
        h('div', { style: SS.label },
          h('div', { style: SS.labelText }, label),
          note ? h('div', { style: SS.labelNote }, note) : null),
        control);
    }

    function ssection(title, eyebrow, right) {
      var children = Array.prototype.slice.call(arguments, 3).filter(function (child) { return child != null && child !== false; });
      return h('section', { style: SS.section },
        h('div', { style: SS.head },
          h('div', null,
            h('div', { style: SS.eyebrow }, eyebrow),
            h('h2', { style: SS.h2 }, title)),
          right || null),
        h('div', { style: SS.body }, children));
    }

    function routeValue(entry) {
      return typeof entry === 'string' ? entry : entry && entry.route ? entry.route : '';
    }

    function SettingsPanel() {
      var stateHook = React.useState(null);
      var state = stateHook[0], setState = stateHook[1];
      var settingsHook = React.useState({ defaultRoute: '', teamMode: 'parallel', teamMembers: [], judgeRoute: '' });
      var settings = settingsHook[0], setSettings = settingsHook[1];
      var logoHook = React.useState(true);
      var logoOk = logoHook[0], setLogoOk = logoHook[1];
      var toastHook = React.useState('');
      var toast = toastHook[0], setToast = toastHook[1];
      var errHook = React.useState('');
      var error = errHook[0], setError = errHook[1];

      function refresh() {
        return api('/state').then(function (body) {
          setState(body);
          if (body.settings) setSettings(body.settings);
          return body;
        }).catch(function (e) { setError(String(e.message || e)); });
      }

      React.useEffect(function () { refresh(); }, []);

      function persist(patch, label) {
        var next = Object.assign({}, settings, patch);
        setSettings(next);
        setToast('保存中…');
        postJson('/settings', { settings: next })
          .then(function (body) {
            setSettings(body.settings || next);
            setToast((label || '已保存') + ' · ' + new Date().toLocaleTimeString());
            setError('');
          })
          .catch(function (e) { setToast(''); setError(String(e.message || e)); });
      }

      var routes = ((state && state.routes) || []).map(function (entry) { return routeValue(entry); }).filter(Boolean);
      var workflows = (state && state.workflows) || [];
      var runs = (state && state.runs) || [];
      var dataDir = (state && state.dataDir) || '';
      var members = settings.teamMembers || [];
      var addable = routes.filter(function (r) { return members.indexOf(r) < 0; });

      var hero = h('div', { style: SS.hero },
        logoOk
          ? h('img', {
              src: '/dsh-cupbox-api/logo.svg', alt: 'Cupbox', style: SS.logo,
              onError: function () { setLogoOk(false); },
            })
          : h('div', { style: SS.logoFallback }, 'C'),
        h('div', { style: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 } },
          h('div', { style: SS.eyebrow }, 'CUPBOX · DEEPSEEK HARNESS'),
          h('h1', { style: SS.h1 }, 'Cupbox 工作流'),
          h('div', { style: SS.desc }, '把任务拆成 DAG 交给不同模型，节点产出可再加工；也可一键把同一任务分给多个模型协作。设置会写进数据目录，工具与面板共用。'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 } },
            h('span', { style: SS.pill }, h('span', { style: Object.assign({ background: B.ok }, SS.dot) }), '引擎在线'),
            h('span', { style: SS.pill }, 'v1.0.0'),
            h('span', { style: SS.pill }, '模板 ' + workflows.length + ' 条 · 路由 ' + routes.length + ' 条'))));

      var defaults = ssection('运行默认值', 'DEFAULTS', toast ? h('span', { style: SS.toast }, toast) : null,
        sfield('默认模型', '工具与面板没指定 route 时用它；留空则跟随宿主自动挑。',
          h('select', {
            style: SS.select, value: settings.defaultRoute || '',
            onChange: function (e) { persist({ defaultRoute: e.target.value }, '已保存默认模型'); },
          },
            h('option', { value: '' }, '（跟随宿主自动挑）'),
            routes.map(function (r) { return h('option', { key: r, value: r }, r); }))),
        sfield('协作模式', '多模型协作的默认形态：并行各写各的，辩论则逐位批判前一位。',
          h('div', { style: SS.seg },
            h('button', {
              style: settings.teamMode === 'parallel' ? SS.segOn : SS.segOff,
              onClick: function () { persist({ teamMode: 'parallel' }, '已切到并行'); },
            }, '并行 parallel'),
            h('button', {
              style: settings.teamMode === 'debate' ? SS.segOn : SS.segOff,
              onClick: function () { persist({ teamMode: 'debate' }, '已切到辩论'); },
            }, '辩论 debate'))),
        sfield('默认成员', '留空则自动取前 3 个可用路由；最多 6 个。',
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', justifyContent: 'flex-end', maxWidth: 420 } },
            members.length === 0 ? h('span', { style: { fontSize: 11.5, color: B.faint } }, '未指定（自动）') : null,
            members.map(function (r) {
              return h('span', { key: r, style: SS.chip }, r,
                h('button', {
                  style: SS.chipX, title: '移除',
                  onClick: function () {
                    persist({ teamMembers: members.filter(function (x) { return x !== r; }) }, '已移除成员');
                  },
                }, '×'));
            }),
            addable.length > 0
              ? h('select', {
                  style: SS.addSelect, value: '',
                  onChange: function (e) {
                    if (!e.target.value) return;
                    persist({ teamMembers: members.concat([e.target.value]) }, '已加入成员');
                  },
                },
                  h('option', { value: '' }, '＋ 添加成员模型'),
                  addable.map(function (r) { return h('option', { key: r, value: r }, r); }))
              : null)),
        sfield('裁决模型', '辩论/并行最后的汇总节点用它；留空跟随默认模型。',
          h('select', {
            style: SS.select, value: settings.judgeRoute || '',
            onChange: function (e) { persist({ judgeRoute: e.target.value }, '已保存裁决模型'); },
          },
            h('option', { value: '' }, '（跟随默认模型）'),
            routes.map(function (r) { return h('option', { key: r, value: r }, r); })), true));

      var status = ssection('引擎状态', 'STATUS', null,
        h('div', { style: SS.metric },
          h('div', { style: SS.metricCard }, h('div', { style: SS.metricNum }, String(workflows.length)), h('div', { style: SS.metricCap }, '工作流（含内置模板）')),
          h('div', { style: SS.metricCard }, h('div', { style: SS.metricNum }, String(routes.length)), h('div', { style: SS.metricCap }, '可用模型路由')),
          h('div', { style: SS.metricCard }, h('div', { style: SS.metricNum }, String(runs.length)), h('div', { style: SS.metricCap }, '最近运行记录'))),
        sfield('数据目录', 'workflows.json / runs.json / settings.json 都存在这里。',
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' } },
            h('code', { style: SS.mono }, dataDir || '—'),
            h('button', {
              style: SS.tinyBtn,
              onClick: function () {
                postJson('/runs/clear', {}).then(function () { setToast('已清空运行记录'); refresh(); })
                  .catch(function (e) { setError(String(e.message || e)); });
              },
            }, '清空运行记录'))),
        sfield('快捷键', '在任意会话里让 Agent 直接编排工作流。',
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' } },
            ['cupbox_list', 'cupbox_run', 'cupbox_team'].map(function (name) {
              return h('span', { key: name, style: SS.pill }, h('code', { style: SS.mono }, name));
            })), true));

      var templates = ssection('内置模板', 'TEMPLATES', null,
        workflows.slice(0, 8).map(function (w, index, list) {
          return h('div', { key: w.id, style: index === list.length - 1 ? Object.assign({}, SS.tpl, { borderBottom: 'none', paddingBottom: 2 }) : SS.tpl },
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 } },
              h('div', { style: SS.tplName }, w.name || w.id, w.builtin ? h('span', { style: SS.badge }, '内置') : h('span', { style: SS.badge }, '自定义')),
              h('div', { style: { fontSize: 11.5, color: B.muted, lineHeight: 1.6 } }, w.description || '—')),
            h('div', { style: SS.tplMeta }, (w.nodes || []).length + ' 节点'));
        }));

      var about = ssection('关于', 'ABOUT', null,
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h('div', { style: SS.label },
            h('div', { style: SS.labelText }, '面板 API'),
            h('div', { style: SS.labelNote }, '同源、无需额外鉴权；面板与设置页都用它。')),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 12px', border: '1px solid ' + B.line, borderRadius: 10 } },
            ['GET  /dsh-cupbox-api/state', 'GET  /dsh-cupbox-api/settings', 'POST /dsh-cupbox-api/settings', 'POST /dsh-cupbox-api/run', 'POST /dsh-cupbox-api/team', 'GET  /dsh-cupbox-api/logo.svg'].map(function (line) {
              return h('code', { key: line, style: SS.mono }, line);
            }))),
        sfield('品牌', 'logo 与深蓝底 + 冰蓝/紫渐变直接取自 Cupbox 桌面端 assets/cupbox-logo.svg。',
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('span', { style: { width: 28, height: 28, borderRadius: 9, background: B.grad, display: 'inline-block' } }),
            h('span', { style: { width: 28, height: 28, borderRadius: 9, background: '#0b1223', display: 'inline-block' } }),
            h('span', { style: { width: 28, height: 28, borderRadius: 9, background: '#263851', display: 'inline-block' } })), true));

      return h('div', { style: SS.page },
        hero,
        error ? h('div', { style: { color: B.bad, fontSize: 12, whiteSpace: 'pre-wrap' } }, error) : null,
        defaults, status, templates, about,
        h('div', { style: SS.footer },
          h('span', null, 'dsh-cupbox · 独立出来的 Cupbox 核心：DAG 工作流 + 多模型协作'),
          h('span', null, '设置随 profile 走，可用 DSH_CUPBOX_DIR 覆盖数据目录')));
    }

    /* ── 主面板 ───────────────────────────────────────────────────── */

    function Panel(props) {
      var panelState = React.useState(null);
      var state = panelState[0], setState = panelState[1];
      var tabState = React.useState('run');
      var tab = tabState[0], setTab = tabState[1];
      var selState = React.useState('');
      var selectedId = selState[0], setSelectedId = selState[1];
      var draftState = React.useState('');
      var draft = draftState[0], setDraft = draftState[1];
      var inputState = React.useState('');
      var input = inputState[0], setInput = inputState[1];
      var routeState = React.useState('');
      var route = routeState[0], setRoute = routeState[1];
      var busyState = React.useState(false);
      var busy = busyState[0], setBusy = busyState[1];
      var errState = React.useState('');
      var error = errState[0], setError = errState[1];
      var runState = React.useState(null);
      var run = runState[0], setRun = runState[1];
      var teamTextState = React.useState('');
      var teamText = teamTextState[0], setTeamText = teamTextState[1];
      var teamModeState = React.useState('parallel');
      var teamMode = teamModeState[0], setTeamMode = teamModeState[1];
      var teamPickState = React.useState([]);
      var teamPick = teamPickState[0], setTeamPick = teamPickState[1];

      function refresh() {
        return api('/state').then(function (body) {
          setState(body);
          if (!route) setRoute((body.settings && body.settings.defaultRoute) || body.defaultRoute || '');
          if (body.settings && body.settings.teamMode) setTeamMode(body.settings.teamMode);
          if (!selectedId && body.workflows.length > 0) {
            setSelectedId(body.workflows[0].id);
          }
          return body;
        }).catch(function (e) { setError(String(e.message || e)); });
      }

      React.useEffect(function () { refresh(); }, []);

      React.useEffect(function () {
        if (!state) return;
        var found = (state.workflows || []).filter(function (w) { return w.id === selectedId; })[0];
        if (found) setDraft(JSON.stringify(found, null, 2));
      }, [selectedId, state && state.workflows.length]);

      function handleRun(useDraft) {
        setBusy(true);
        setError('');
        var payload = { input: input, route: route || undefined };
        if (useDraft) {
          var parsed;
          try {
            parsed = JSON.parse(draft);
          } catch (e) {
            setBusy(false);
            setError('工作流 JSON 解析失败：' + e.message);
            return;
          }
          payload.definition = parsed;
        } else {
          payload.workflowId = selectedId;
        }
        postJson('/run', payload)
          .then(function (body) { setRun(body.run); setTab('run'); return refresh(); })
          .catch(function (e) { setError(String(e.message || e)); })
          .then(function () { setBusy(false); });
      }

      function handleSave() {
        setError('');
        var parsed;
        try {
          parsed = JSON.parse(draft);
        } catch (e) {
          setError('工作流 JSON 解析失败：' + e.message);
          return;
        }
        postJson('/save', { definition: parsed })
          .then(function (body) { setId(body.saved); return refresh(); })
          .catch(function (e) { setError(String(e.message || e)); });
      }

      function setId(id) {
        setSelectedId(id);
      }

      function handleDelete() {
        if (!selectedId) return;
        if (!window.confirm('删除工作流 ' + selectedId + '？')) return;
        postJson('/delete', { id: selectedId })
          .then(function () { setSelectedId(''); setDraft(''); return refresh(); })
          .catch(function (e) { setError(String(e.message || e)); });
      }

      function handleTeam() {
        if (!teamText.trim()) {
          setError('请先填写任务');
          return;
        }
        setBusy(true);
        setError('');
        postJson('/team', { task: teamText, models: teamPick, mode: teamMode })
          .then(function (body) { setRun(body.run); return refresh(); })
          .catch(function (e) { setError(String(e.message || e)); })
          .then(function () { setBusy(false); });
      }

      var workflows = (state && state.workflows) || [];
      var routes = (state && state.routes) || [];

      var tabs = h('div', { style: S.tabs },
        ['run', 'team', 'runs'].map(function (key) {
          var names = { run: '工作流', team: '多模型协作', runs: '运行历史' };
          return h('button', { key: key, onClick: function () { setTab(key); }, style: tab === key ? S.tabOn : S.tab }, names[key]);
        }),
        h('span', { style: { flex: 1 } }),
        state && state.dataDir ? h('span', { style: { color: C.muted, fontSize: 11.5 } }, state.dataDir) : null,
        btn('刷新', function () { refresh(); }, false, true));

      var body;

      if (tab === 'team') {
        body = h('div', { style: S.card },
          h('div', { style: { fontWeight: 600 } }, '把同一个任务分给多个模型，再汇总裁决'),
          field('任务', h('textarea', {
            style: Object.assign({}, S.area, { minHeight: 110 }),
            value: teamText,
            placeholder: '例如：给出 Cupbox 工作流引擎的三个可优化点，并说明取舍。',
            onChange: function (e) { setTeamText(e.target.value); },
          })),
          field('成员模型（留空 = 自动取前 3 个）', h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
            routes.map(function (r) {
              var on = teamPick.indexOf(r.route) >= 0;
              return h('button', {
                key: r.route,
                style: on ? S.tabOn : S.tab,
                onClick: function () {
                  setTeamPick(on ? teamPick.filter(function (x) { return x !== r.route; }) : teamPick.concat([r.route]));
                },
              }, r.route);
            }))),
          h('div', { style: S.row },
            field('模式', h('select', {
              style: Object.assign({}, S.input, { width: 160 }),
              value: teamMode,
              onChange: function (e) { setTeamMode(e.target.value); },
            },
              h('option', { value: 'parallel' }, 'parallel 并行'),
              h('option', { value: 'debate' }, 'debate 辩论'))),
            h('span', { style: { flex: 1 } }),
            btn(busy ? '运行中…' : '开始协作', handleTeam, true)),
          error ? h('div', { style: S.err }, error) : null);
      } else if (tab === 'runs') {
        var runs = (state && state.runs) || [];
        body = h('div', { style: S.card },
          h('div', { style: S.row },
            h('span', { style: { fontWeight: 600 } }, '最近运行（' + runs.length + '）'),
            h('span', { style: { flex: 1 } }),
            btn('清空', function () {
              postJson('/runs/clear', {}).then(function () { return refresh(); });
            }, false, true)),
          runs.length === 0 ? h('div', { style: { color: C.muted } }, '还没有运行记录') : null,
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            runs.map(function (entry) {
              return h('div', { key: entry.id, style: { border: '1px solid ' + C.line, borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 } },
                h('div', { style: S.row },
                  h('span', { style: Object.assign({ background: statusColor(entry.status) }, S.dot) }),
                  h('span', { style: { fontWeight: 600 } }, entry.workflowName || entry.workflowId),
                  h('span', { style: { color: C.muted, fontSize: 12 } }, entry.status + ' · ' + entry.durationMs + 'ms · ' + entry.startedAt),
                  h('span', { style: { flex: 1 } }),
                  btn('载入', function () {
                    setState(function (prev) {
                      if (!prev) return prev;
                      var found = prev.workflows.filter(function (w) { return w.id === entry.workflowId; })[0];
                      if (found) { setSelectedId(found.id); setTab('run'); }
                      return prev;
                    });
                  }, false, true)),
                entry.input ? h('div', { style: { color: C.muted, fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 60, overflow: 'hidden' } }, entry.input) : null,
                entry.error ? h('div', { style: S.err }, entry.error) : null,
                h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 12, color: C.muted } },
                  (entry.nodes || []).map(function (node, i) {
                    return h('span', { key: i, style: { display: 'inline-flex', gap: 5, alignItems: 'center' } },
                      h('span', { style: Object.assign({ background: statusColor(node.status) }, S.dot) }),
                      (node.label || node.nodeId) + ' ' + (node.durationMs != null ? node.durationMs + 'ms' : '') +
                      (node.model ? ' (' + node.model + ')' : ''));
                  })));
            })));
      } else {
        body = h('div', { style: S.grid },
          h('div', { style: S.card },
            h('div', { style: S.row },
              h('span', { style: { fontWeight: 600 } }, '工作流'),
              h('span', { style: { flex: 1 } }),
              btn('新建', function () {
                var blank = {
                  id: 'w-' + Date.now().toString(36),
                  name: '新的工作流',
                  description: '',
                  nodes: [
                    { id: 'start', label: '输入', kind: 'start' },
                    { id: 'answer', label: '回答', kind: 'model', prompt: '请处理下面的任务：\n\n{{input}}' },
                  ],
                  edges: [{ from: 'start', to: 'answer' }],
                };
                setSelectedId(blank.id);
                setDraft(JSON.stringify(blank, null, 2));
              }, false, true)),
            h('div', { style: S.list },
              workflows.map(function (w) {
                return h('div', {
                  key: w.id,
                  style: w.id === selectedId ? S.itemOn : S.item,
                  onClick: function () { setSelectedId(w.id); },
                },
                  h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                    h('span', { style: { fontWeight: 600 } }, w.name || w.id),
                    w.builtin ? h('span', { style: { fontSize: 10.5, color: C.muted, border: '1px solid ' + C.line, borderRadius: 4, padding: '0 4px' } }, '内置') : null),
                  h('div', { style: { color: C.muted, fontSize: 11.5 } }, w.description || w.id),
                  h('div', { style: { color: C.muted, fontSize: 11 } }, (w.nodes || []).length + ' 个节点'));
              }))),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 } },
            h('div', { style: S.card },
              h('div', { style: S.row },
                h('span', { style: { fontWeight: 600 } }, selectedId || '未选择'),
                h('span', { style: { flex: 1 } }),
                btn('保存', handleSave, false, true),
                btn('删除', handleDelete, false, true)),
              field('任务输入（写入 {{input}}）', h('textarea', {
                style: Object.assign({}, S.area, { minHeight: 84, fontFamily: 'inherit' }),
                value: input,
                placeholder: '输入要交给这条工作流的任务…',
                onChange: function (e) { setInput(e.target.value); },
              })),
              h('div', { style: S.row },
                field('默认模型', h('select', {
                  style: Object.assign({}, S.input, { width: 260 }),
                  value: route,
                  onChange: function (e) { setRoute(e.target.value); },
                }, h('option', { value: '' }, '（宿主默认）'),
                  routes.map(function (r) { return h('option', { key: r.route, value: r.route }, r.route); }))),
                h('span', { style: { flex: 1 } }),
                btn(busy ? '运行中…' : '用工作流运行', function () { handleRun(false); }, true),
                btn('用编辑器定义运行', function () { handleRun(true); }, false)),
              error ? h('div', { style: S.err }, error) : null),
            h('div', { style: S.card },
              field('工作流定义（JSON，可编辑后直接运行）', h('textarea', {
                style: Object.assign({}, S.area, { minHeight: 200 }),
                value: draft,
                spellCheck: false,
                onChange: function (e) { setDraft(e.target.value); },
              }))),
            RunResult({ run: run, onSave: function () { handleSave(); } })));
      }

      return h('div', { style: S.root },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
          h('div', { style: { fontSize: 15, fontWeight: 650 } }, 'Cupbox 工作流'),
          h('div', { style: { color: C.muted, fontSize: 12 } }, '把任务拆成 DAG 交给不同模型，节点产出可再加工；也可一键把同一任务分给多个模型协作。')),
        tabs,
        body);
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          { name: 'settings.section', id: 'cupbox', order: 95, label: function () { return 'Cupbox 工作流'; } },
          SettingsPanel,
        );
      });
      ctx.slots.inject('conversation.view', function () {
        return ctx.slots.register(
          { name: 'conversation.view', id: 'cupbox', order: 45, label: function () { return 'Cupbox'; } },
          Panel,
        );
      });
    }

    module.exports = { apply: apply, inject: inject };
    return module.exports;
  },
});
