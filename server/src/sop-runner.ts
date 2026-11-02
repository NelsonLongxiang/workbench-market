/** SOP Runner 执行页渲染（S3 抽离）：服务端渲染 sop.yaml 步骤 + data-field 自动收集脚本。
 * 纯函数（manifest + app → HTML 字符串），无 IO、无 Express 依赖。 */
import type { SopManifest } from './sop-types.ts';
import type { AppRow } from './db.ts';

/** tokensCss：DESIGN.md 生成的 --wm-* 变量（#321，与市场前端同一份），内联进页面；缺省时页面照常渲染。 */
export function renderSopRunner(manifest: SopManifest, app: AppRow, tokensCss = ''): string {
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
${tokensCss.replace(/<\/style/gi, '')}
</style>
<style>
  /* #321：颜色、字体、字号、间距、圆角只用 --wm-* 变量（DESIGN.md），与市场前端同色同字号；顶栏是深色区，用 nav-* */
  * { box-sizing:border-box; }
  body { margin:0; font-family:var(--wm-font-sans); font-size:var(--wm-font-size-body); line-height:var(--wm-line-height-body); color:var(--wm-color-text); background:var(--wm-color-page); }
  .bar { position:sticky; top:0; z-index:5; background:var(--wm-color-nav-bg); color:var(--wm-color-nav-text-active); padding:var(--wm-space-2) var(--wm-space-6); display:flex; align-items:center; gap:var(--wm-space-3); }
  .bar .code { font-family:var(--wm-font-mono); font-size:var(--wm-font-size-caption); color:var(--wm-color-nav-text); }
  .bar h1 { font-size:var(--wm-font-size-subtitle); line-height:var(--wm-line-height-subtitle); margin:0; font-weight:var(--wm-font-weight-subtitle); }
  .badge { font-size:var(--wm-font-size-caption); padding:2px var(--wm-space-2); border-radius:var(--wm-radius-full); background:var(--wm-color-success-bg); color:var(--wm-color-success-text); }
  .runmeta { margin-left:auto; font-family:var(--wm-font-mono); font-size:var(--wm-font-size-caption); color:var(--wm-color-nav-text); }
  main { max-width:860px; margin:var(--wm-space-6) auto; padding:0 var(--wm-space-4); }
  .step { background:var(--wm-color-surface); border:1px solid var(--wm-color-border); border-radius:var(--wm-radius-lg); padding:var(--wm-space-4) var(--wm-space-6); margin-bottom:var(--wm-space-3); box-shadow:var(--wm-shadow-1); }
  .step header { display:flex; align-items:center; gap:var(--wm-space-2); }
  .step .no { width:24px; height:24px; border-radius:var(--wm-radius-full); background:var(--wm-color-primary); color:var(--wm-color-on-primary); font-size:var(--wm-font-size-caption); display:flex; align-items:center; justify-content:center; font-family:var(--wm-font-mono); }
  .step h2 { font-size:var(--wm-font-size-subtitle); line-height:var(--wm-line-height-subtitle); margin:0; font-weight:var(--wm-font-weight-subtitle); }
  .dot { margin-left:auto; width:8px; height:8px; border-radius:var(--wm-radius-full); background:var(--wm-color-border-strong); }
  .dot.saved { background:var(--wm-color-success); }
  .dot.dirty { background:var(--wm-color-warning); }
  .body { margin-top:var(--wm-space-2); }
  .body:empty { display:none; }
  .muted { color:var(--wm-color-text-secondary); }
  input[data-field], select[data-field], textarea[data-field] { width:100%; max-width:420px; padding:var(--wm-space-2) var(--wm-space-3); border:1px solid var(--wm-color-border-strong); border-radius:var(--wm-radius-md); font:inherit; font-family:var(--wm-font-mono); font-size:var(--wm-font-size-body); color:var(--wm-color-text); background:var(--wm-color-surface); }
  input[data-field]:focus-visible, textarea[data-field]:focus-visible, select[data-field]:focus-visible { outline:2px solid var(--wm-color-primary); outline-offset:1px; }
  .foot { display:flex; align-items:center; gap:var(--wm-space-3); margin:var(--wm-space-6) 0 var(--wm-space-8); }
  .btn { border:1px solid var(--wm-color-border-strong); border-radius:var(--wm-radius-md); padding:var(--wm-space-2) var(--wm-space-6); font:inherit; font-weight:var(--wm-font-weight-body-strong); cursor:pointer; background:var(--wm-color-surface); color:var(--wm-color-text); }
  .btn.primary { background:var(--wm-color-primary); border-color:var(--wm-color-primary); color:var(--wm-color-on-primary); }
  .btn:disabled { opacity:.5; cursor:default; }
  .state { font-size:var(--wm-font-size-caption); color:var(--wm-color-text-secondary); font-family:var(--wm-font-mono); }
  .extra-row { margin:var(--wm-space-2) 0; padding:var(--wm-space-2) var(--wm-space-3); background:var(--wm-color-page); border:1px solid var(--wm-color-border); border-radius:var(--wm-radius-md); }
  .extra-row pre { margin:var(--wm-space-1) 0 0; white-space:pre-wrap; word-break:break-all; font-size:var(--wm-font-size-caption); font-family:var(--wm-font-mono); }
  @media (prefers-reduced-motion: reduce) { * { transition:none !important; animation:none !important; } }
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
  <ul id="extras-files" style="margin:var(--wm-space-2) 0 0;padding-left:var(--wm-space-4)"></ul>
  <div style="margin-top:var(--wm-space-2);display:flex;gap:var(--wm-space-2);align-items:center">
    <input type="file" id="upload-input">
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
  var runReadCap = ''; // #309 phase2：run 级读能力（创建响应即得/本机存档；恢复与附件读取用）
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
        row.className = 'extra-row';
        var t = document.createElement('div');
        t.className = 'muted'; t.textContent = k;
        var v = document.createElement('pre');
        v.textContent = typeof extra[k] === 'string' ? extra[k] : JSON.stringify(extra[k], null, 2);
        row.appendChild(t); row.appendChild(v); dataBox.appendChild(row);
      });
      var fh = runReadCap ? { headers: { 'X-Run-Read-Capability': runReadCap } } : {};
      fetch('/api/sop/runs/' + run.id + '/files', fh).then(function (r) {
        if (r.status === 403) { fileBox.textContent = ''; var fn2 = document.getElementById('extras-note'); if (fn2) fn2.textContent = '附件需要读授权（旧记录或无凭据）'; return { items: [] }; }
        return r.ok ? r.json() : { items: [] };
      }).then(function (j) {
        fileBox.textContent = '';
        (j.items || []).forEach(function (f) {
          var li = document.createElement('li');
          var a = document.createElement('a');
          a.href = f.url; a.textContent = f.original_name + ' (' + Math.round(f.size / 1024) + ' KB)';
          // #309 phase2：cap 持有者点链下载——带读能力取流再存（普通导航带不了自定义头）
          if (runReadCap) { a.href = '#'; a.addEventListener('click', function (ev) { ev.preventDefault();
            fetch(f.url, { headers: { 'X-Run-Read-Capability': runReadCap } }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); }).then(function (b) {
              var u = URL.createObjectURL(b); var d = document.createElement('a'); d.href = u; d.download = f.original_name || 'file'; d.click(); setTimeout(function () { URL.revokeObjectURL(u); }, 4000);
            }).catch(function (e) { setState('附件下载失败：' + e.message); });
          }); }
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
    window.__wmPinnedRun = resume; // 供状态呈现判断（只读定位不改写入权限）
    var resumeCap = '';
    try { var rc = JSON.parse(localStorage.getItem(LS + '.rcap') || 'null'); if (rc && rc.id === resume) resumeCap = String(rc.c || ''); } catch (e) {}
    var p = resume
      ? fetch('/api/sop/runs/' + resume, resumeCap ? { headers: { 'X-Run-Read-Capability': resumeCap } } : {}).then(function (r) { return r.ok ? r.json() : null; })
      : fetch('/api/sop/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: BOOT.slug }) }).then(function (r) { return r.json(); });
    p.then(function (run) {
      if (!run || !run.id) { setState('开启执行记录失败'); return; }
      runId = run.id;
      // #page-wire（监督席 direct-c869d6db）：令牌接线——创建响应即得；恢复场景读本机存档（同浏览器同 run）
      runUploadToken = String(run.upload_token || '');
      if (!runUploadToken) { try { var prevTok = JSON.parse(localStorage.getItem(LS + '.tok') || 'null'); if (prevTok && prevTok.id === run.id) runUploadToken = String(prevTok.t || ''); } catch (e) {} }
      if (runUploadToken) { try { localStorage.setItem(LS + '.tok', JSON.stringify({ id: run.id, t: runUploadToken })); } catch (e) {} }
      // #309 phase2：读能力接线——创建响应即得；恢复场景读本机存档（同浏览器同 run）
      runReadCap = String(run.read_capability || resumeCap || '');
      if (!runReadCap) { try { var prevRc = JSON.parse(localStorage.getItem(LS + '.rcap') || 'null'); if (prevRc && prevRc.id === run.id) runReadCap = String(prevRc.c || ''); } catch (e) {} }
      if (runReadCap) { try { localStorage.setItem(LS + '.rcap', JSON.stringify({ id: run.id, c: runReadCap })); } catch (e) {} }
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
      $('#finish').disabled = run.status !== 'running';
      if (run.status === 'finished') { setState('已完成——冻结录入（只读）'); document.querySelectorAll('[data-field]').forEach(function (el) { el.disabled = true; }); }
      else if (run.private_read === 'authorization-required' || !run.data) { setState(runReadCap ? '' : '此记录需读授权（旧记录或无凭据）——已回退本地缓冲'); }
      else { setState('执行中——数据自动保存'); }
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
