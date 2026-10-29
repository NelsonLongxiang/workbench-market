/** SOP Runner 执行页渲染（S3 抽离）：服务端渲染 sop.yaml 步骤 + data-field 自动收集脚本。
 * 纯函数（manifest + app → HTML 字符串），无 IO、无 Express 依赖。 */
import type { SopManifest } from './sop-types.ts';
import type { AppRow } from './db.ts';

export function renderSopRunner(manifest: SopManifest, app: AppRow): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const stepsHtml = manifest.steps
    .map(
      (s, i) => `
      <section class="step" data-step="${esc(s.key)}">
        <header><span class="no">${i + 1}</span><h2>${esc(s.title)}</h2><span class="dot" data-dot="${esc(s.key)}" title="未保存"></span></header>
        <div class="body">${s.body ?? '<p class="muted">（本步骤无说明）</p>'}</div>
      </section>`
    )
    .join('\n');
  const pinRun = typeof (globalThis as any).__wmSopPinRun === 'number' ? (globalThis as any).__wmSopPinRun : null;
  const boot = JSON.stringify({ slug: app.slug, version: app.active_version, code: app.code || manifest.code || '', title: manifest.title, steps: manifest.steps.map((s) => s.key), pinRun })
    .replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(manifest.title)} · SOP Runner</title>
<style>
  :root { --navy:#1E3A5F; --emerald:#059669; --ink:#0F172A; --line:#E2E8F0; --mut:#5A6577; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:Inter,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; color:var(--ink); background:#F6F8FB; }
  .bar { position:sticky; top:0; z-index:5; background:var(--ink); color:#fff; padding:10px 20px; display:flex; align-items:center; gap:12px; }
  .bar .code { font-family:"Cascadia Mono",Consolas,monospace; font-size:12px; color:#94A3B8; }
  .bar h1 { font-size:16px; margin:0; font-weight:600; letter-spacing:.02em; }
  .badge { font-size:12px; padding:2px 10px; border-radius:999px; background:rgba(5,150,105,.25); color:#6EE7B7; }
  .runmeta { margin-left:auto; font-family:"Cascadia Mono",Consolas,monospace; font-size:12px; color:#94A3B8; }
  main { max-width:860px; margin:24px auto; padding:0 16px; }
  .step { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px 20px; margin-bottom:14px; }
  .step header { display:flex; align-items:center; gap:10px; }
  .step .no { width:24px; height:24px; border-radius:50%; background:var(--navy); color:#fff; font-size:12px; display:flex; align-items:center; justify-content:center; font-family:"Cascadia Mono",Consolas,monospace; }
  .step h2 { font-size:15px; margin:0; font-weight:600; }
  .dot { margin-left:auto; width:8px; height:8px; border-radius:50%; background:#CBD5E1; }
  .dot.saved { background:var(--emerald); }
  .dot.dirty { background:#F59E0B; }
  .body { margin-top:10px; font-size:14px; line-height:1.7; }
  .body:empty { display:none; }
  .muted { color:var(--mut); }
  input[data-field], select[data-field], textarea[data-field] { width:100%; max-width:420px; padding:7px 10px; border:1px solid var(--line); border-radius:6px; font:inherit; font-family:"Cascadia Mono",Consolas,monospace; font-size:13px; }
  input[data-field]:focus-visible, textarea[data-field]:focus-visible, select[data-field]:focus-visible { outline:2px solid rgba(5,150,105,.6); outline-offset:1px; }
  .foot { display:flex; align-items:center; gap:14px; margin:20px 0 40px; }
  .btn { border:none; border-radius:6px; padding:9px 22px; font:inherit; font-weight:600; cursor:pointer; }
  .btn.primary { background:var(--emerald); color:#fff; }
  .btn:disabled { opacity:.5; cursor:default; }
  .state { font-size:13px; color:var(--mut); font-family:"Cascadia Mono",Consolas,monospace; }
</style>
</head>
<body>
<div class="bar">
  <span class="code">${esc(app.code || manifest.code || 'SOP')}</span>
  <h1>${esc(manifest.title)}</h1>
  <span class="badge">v${app.active_version}</span>
  <span class="runmeta" id="runmeta">未开始</span>
</div>
<main>
${stepsHtml}
<section class="step" id="agent-extras" style="display:none">
  <header><h2>agent 交付区</h2><span class="muted" id="extras-note"></span></header>
  <div class="body" id="extras-data"></div>
  <ul id="extras-files" style="margin:8px 0 0;padding-left:18px"></ul>
  <div style="margin-top:10px;display:flex;gap:8px;align-items:center">
    <input type="file" id="upload-input" style="font-size:12px">
    <button class="btn" id="upload-btn" disabled>上传交付文件</button>
    <span class="muted" id="upload-note"></span>
  </div>
</section>
<div class="foot">
  <button class="btn primary" id="finish" disabled>完成执行</button>
  <span class="state" id="state"></span>
</div>
</main>
<script>
window.__SOP__ = ${boot};
(function () {
  var BOOT = window.__SOP__;
  var runId = null;
  var runUploadToken = ''; // #page-wire：run 级上传令牌（创建响应/本机存档）
  var timers = {};
  var LS = 'wm.sop.run.' + BOOT.slug;
  function $(s, el) { return (el || document).querySelector(s); }
  function $$(s, el) { return Array.from((el || document).querySelectorAll(s)); }
  function setState(t) { $('#state').textContent = t; }
  function setRunMeta(t) { $('#runmeta').textContent = t; }
  function dot(key, cls) { var d = $('[data-dot="' + key + '"]'); if (d) d.className = 'dot ' + cls; }

  function collect(stepKey) {
    var sec = $('[data-step="' + stepKey + '"]');
    var out = {};
    $$('[data-field]', sec).forEach(function (el) {
      var f = el.getAttribute('data-field');
      out[f] = el.type === 'checkbox' ? el.checked : el.value;
    });
    return out;
  }
  function fill(stepKey, value) {
    var sec = $('[data-step="' + stepKey + '"]');
    if (!value) return;
    Object.keys(value).forEach(function (f) {
      var el = $('[data-field="' + f + '"]', sec);
      if (!el) return;
      if (el.type === 'checkbox') el.checked = !!value[f]; else el.value = value[f];
    });
  }

  function queueSave(stepKey) {
    dot(stepKey, 'dirty');
    clearTimeout(timers[stepKey]);
    timers[stepKey] = setTimeout(function () { save(stepKey); }, 800);
  }
  function save(stepKey) {
    if (!runId) return;
    var value = collect(stepKey);
    try { localStorage.setItem(LS + '.' + stepKey, JSON.stringify(value)); } catch (e) {}
    fetch('/api/sop/runs/' + runId, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stepKey: stepKey, value: value })
    }).then(function (r) {
      dot(stepKey, r.ok ? 'saved' : 'dirty');
      if (!r.ok) setState('保存失败（HTTP ' + r.status + '）——已缓冲本地，将随下次输入重试');
    }).catch(function () {
      dot(stepKey, 'dirty'); setState('离线——已缓冲本地，恢复网络后继续填写即可');
    });
  }

  // P4（F5/F6）：把 run.data 里非 data-field 的键只读渲染 + 交付文件列表
  function renderAgentExtras(run) {
    var sec = document.getElementById('agent-extras');
    var dataBox = document.getElementById('extras-data');
    var fileBox = document.getElementById('extras-files');
    var note = document.getElementById('extras-note');
    try {
      var bound = {};
      $$('[data-field]').forEach(function (el) { bound[el.getAttribute('data-field')] = true; });
      var extra = {};
      Object.keys(run.data || {}).forEach(function (k) { if (!bound[k]) extra[k] = run.data[k]; });
      dataBox.textContent = '';
      Object.keys(extra).length && Object.keys(extra).forEach(function (k) {
        var row = document.createElement('div');
        row.style.cssText = 'margin:6px 0;padding:6px 10px;background:#F8FAFC;border:1px solid var(--line);border-radius:6px';
        var t = document.createElement('div');
        t.className = 'muted'; t.style.fontSize = '12px'; t.textContent = k;
        var v = document.createElement('pre');
        v.style.cssText = 'margin:4px 0 0;white-space:pre-wrap;word-break:break-all;font-size:12px';
        v.textContent = typeof extra[k] === 'string' ? extra[k] : JSON.stringify(extra[k], null, 2);
        row.appendChild(t); row.appendChild(v); dataBox.appendChild(row);
      });
      fetch('/api/sop/runs/' + run.id + '/files').then(function (r) { return r.ok ? r.json() : { items: [] }; }).then(function (j) {
        fileBox.textContent = '';
        (j.items || []).forEach(function (f) {
          var li = document.createElement('li');
          var a = document.createElement('a');
          a.href = f.url; a.textContent = f.original_name + ' (' + Math.round(f.size / 1024) + ' KB)';
          li.appendChild(a); fileBox.appendChild(li);
        });
        var hasData = Object.keys(extra).length > 0;
        var hasFiles = (j.items || []).length > 0;
        sec.style.display = (hasData || hasFiles) ? '' : 'none';
        note.textContent = hasData || hasFiles ? '由执行 agent 提供（只读）' : '';
      });
      if (Object.keys(extra).length) sec.style.display = '';
    } catch (e) { /* 交付区渲染失败不阻断执行 */ }
  }

  function startRun() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS) || 'null'); } catch (e) {}
    var resume = saved && saved.id && saved.status === 'running' ? saved.id : null;
    if (BOOT.pinRun) resume = BOOT.pinRun; // #263：统一待办 ?run=<id> 精确定位该记录，优先于 localStorage
    var p = resume
      ? fetch('/api/sop/runs/' + resume).then(function (r) { return r.ok ? r.json() : null; })
      : fetch('/api/sop/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: BOOT.slug }) }).then(function (r) { return r.json(); });
    p.then(function (run) {
      if (!run || !run.id) { setState('开启执行记录失败'); return; }
      runId = run.id;
      // #page-wire（监督席 direct-c869d6db）：令牌接线——创建响应即得；恢复场景读本机存档（同浏览器同 run）
      runUploadToken = String(run.upload_token || '');
      if (!runUploadToken) { try { var prevTok = JSON.parse(localStorage.getItem(LS + '.tok') || 'null'); if (prevTok && prevTok.id === run.id) runUploadToken = String(prevTok.t || ''); } catch (e) {} }
      if (runUploadToken) { try { localStorage.setItem(LS + '.tok', JSON.stringify({ id: run.id, t: runUploadToken })); } catch (e) {} }
      var ub = document.getElementById('upload-btn'); if (ub) ub.disabled = false;
      var un2 = document.getElementById('upload-note'); if (un2) un2.textContent = runUploadToken ? '' : '（无令牌：严格模式下需管理员口令或重开执行）';
      localStorage.setItem(LS, JSON.stringify({ id: run.id, status: 'running' }));
      setRunMeta('run #' + run.id + ' · v' + (run.version || BOOT.version));
      // 回填已有数据（恢复现场）：远端优先，本地缓冲兜底
      BOOT.steps.forEach(function (k) {
        var remote = run.data && run.data[k];
        var local = null;
        try { local = JSON.parse(localStorage.getItem(LS + '.' + k) || 'null'); } catch (e) {}
        fill(k, remote || local);
        if (remote || local) dot(k, 'saved');
      });
      $('#finish').disabled = false;
      setState('执行中——数据自动保存');
      void renderAgentExtras(run);
    }).catch(function () { setState('无法连接市场服务——填写仍会缓冲本地'); });
  }

  document.addEventListener('input', function (ev) {
    var el = ev.target;
    if (!el || !el.hasAttribute || !el.hasAttribute('data-field')) return;
    var sec = el.closest('[data-step]');
    if (sec) queueSave(sec.getAttribute('data-step'));
  });
  // #page-wire（监督席 direct-c869d6db）：交付上传——严格模式自动带 X-Run-Upload-Token
  (function () {
    var btn = document.getElementById('upload-btn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var inp = document.getElementById('upload-input');
      var note = document.getElementById('upload-note');
      if (!inp || !inp.files || !inp.files.length) { if (note) note.textContent = '请选择文件'; return; }
      if (!runId) { if (note) note.textContent = '执行未开始'; return; }
      var fd = new FormData();
      fd.append('file', inp.files[0]);
      var hdr = runUploadToken ? { 'X-Run-Upload-Token': runUploadToken } : {};
      btn.disabled = true;
      fetch('/api/sop/runs/' + runId + '/files', { method: 'POST', body: fd, headers: hdr })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); })
        .then(function (res) {
          if (note) note.textContent = res.ok ? ('已上传：' + (res.j.name || '')) : ('上传失败(' + res.status + ')：' + (res.j.error || ''));
          btn.disabled = false; inp.value = '';
          if (res.ok) { // 刷新交付文件列表（就地把新行加进 extras-files）
            var fileBox = document.getElementById('extras-files');
            if (fileBox && res.j && res.j.name) {
              var li = document.createElement('li');
              li.textContent = res.j.name + '（' + Math.round((res.j.size || 0) / 1024) + ' KB）';
              fileBox.appendChild(li);
            }
          }
        }).catch(function (e) { if (note) note.textContent = '上传异常：' + e; btn.disabled = false; });
    });
  })();
  document.addEventListener('change', function (ev) {
    var el = ev.target;
    if (!el || !el.hasAttribute || !el.hasAttribute('data-field')) return;
    var sec = el.closest('[data-step]');
    if (sec) queueSave(sec.getAttribute('data-step'));
  });

  $('#finish').addEventListener('click', function () {
    if (!runId) return;
    // 收尾前把所有未落盘的缓冲步骤推上去
    Promise.all(BOOT.steps.filter(function (k) { return timers[k]; }).map(function (k) {
      clearTimeout(timers[k]); return save(k), Promise.resolve();
    })).then(function () {
      return fetch('/api/sop/runs/' + runId + '/finish', { method: 'POST' });
    }).then(function (r) { return r.json(); }).then(function (out) {
      localStorage.setItem(LS, JSON.stringify({ id: runId, status: 'finished' }));
      setRunMeta('run #' + out.id + ' · 已完成');
      setState('执行完成，记录已归档（' + out.steps + ' 个步骤数据）');
      $('#finish').disabled = true;
    }).catch(function () { setState('完成失败——数据仍在，稍后重试'); });
  });

  startRun();
})();
</script>
</body>
</html>`;
}
