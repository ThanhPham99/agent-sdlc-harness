// Interactive Visual Dashboard Generator for Agent SDLC Harness.
import fs from 'node:fs';
import path from 'node:path';
import {stateDir,projectConfig,listTasks} from '../store.mjs';
import {metrics as getMetrics} from '../telemetry.mjs';
import {readJson} from '../util.mjs';

function escapeHtml(s){
  return String(s??'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

export function generateDashboardHtml({project,state,runs=[],tasks=[],metrics=null,version='3.0.0'}){
  const totalTokens=metrics?.tasks?.total_tokens??0;
  const totalCost=metrics?.tasks?.total_cost_usd??0;
  const runsCount=runs.length;
  const tasksCount=tasks.length;
  const doneTasks=tasks.filter(t=>t.status==='DONE').length;
  const runningTasks=tasks.filter(t=>t.status==='RUNNING').length;
  const failedTasks=tasks.filter(t=>t.status==='FAILED'||t.status==='FAIL').length;

  const taskRows=tasks.map(t=>{
    const color=t.status==='DONE'?'#22c55e':t.status==='RUNNING'?'#f59e0b':t.status==='BLOCKED'?'#a855f7':t.status==='FAILED'?'#ef4444':'#3b82f6';
    return `<div style="background:#1e293b;border:1px solid #334155;border-left:4px solid ${color};border-radius:6px;padding:12px;margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
        <span style="font-weight:600;color:#f8fafc;font-family:monospace;">${escapeHtml(t.task_id)}</span>
        <span style="background:${color}22;color:${color};padding:2px 8px;border-radius:12px;font-size:12px;font-weight:600;">${escapeHtml(t.status)}</span>
      </div>
      <div style="color:#94a3b8;font-size:13px;margin-bottom:6px;">${escapeHtml(t.title||t.description||'(no description)')}</div>
      <div style="display:flex;gap:12px;font-size:11px;color:#64748b;font-family:monospace;">
        <span>Category: ${escapeHtml(t.category||'feature')}</span>
        <span>Attempt: ${t.attempt||1}</span>
        ${t.diff_hash?`<span>Diff: ${t.diff_hash.slice(0,8)}</span>`:''}
      </div>
    </div>`;
  }).join('\n');

  const runCards=runs.map(r=>{
    return `<div style="background:#1e293b;border:1px solid #334155;border-radius:6px;padding:12px;margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span style="font-weight:600;color:#38bdf8;font-family:monospace;">${escapeHtml(r.run_id)}</span>
        <span style="background:#3b82f622;color:#38bdf8;padding:2px 8px;border-radius:12px;font-size:12px;">${escapeHtml(r.state)}</span>
      </div>
      <div style="color:#e2e8f0;font-size:14px;margin-bottom:6px;">${escapeHtml(r.objective||'(no objective)')}</div>
      <div style="display:flex;gap:12px;font-size:12px;color:#94a3b8;">
        <span>Workflow: <strong>${escapeHtml(r.workflow||'standard')}</strong></span>
        <span>Profile: <strong>${escapeHtml(r.profile||'STANDARD')}</strong></span>
        <span>Revision: ${r.revision||0}</span>
      </div>
    </div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent SDLC Dashboard - ${escapeHtml(project?.project||'Project')}</title>
  <style>
    :root { --bg: #0f172a; --card: #1e293b; --text: #f8fafc; --muted: #94a3b8; --border: #334155; }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 24px; }
    .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 16px; margin-bottom: 24px; }
    .badge { background: #3b82f633; color: #60a5fa; border: 1px solid #3b82f666; padding: 4px 10px; border-radius: 999px; font-size: 13px; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
    .stat-val { font-size: 28px; font-weight: 700; margin-top: 4px; color: #38bdf8; }
    .layout-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
    @media (max-width: 900px) { .layout-grid { grid-template-columns: 1fr; } }
    .section-title { font-size: 18px; font-weight: 600; margin-bottom: 12px; color: #cbd5e1; display: flex; align-items: center; gap: 8px; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1 style="font-size:24px;font-weight:700;">Agent SDLC Dashboard</h1>
      <p style="color:var(--muted);font-size:14px;margin-top:4px;">Project: <strong>${escapeHtml(project?.project||'agent-sdlc')}</strong> | Harness Version: ${escapeHtml(version)}</p>
    </div>
    <div>
      <span class="badge">Live SDLC State</span>
    </div>
  </div>

  <div class="stats-grid">
    <div class="stat-card">
      <div style="color:var(--muted);font-size:13px;">Total Runs</div>
      <div class="stat-val">${runsCount}</div>
    </div>
    <div class="stat-card">
      <div style="color:var(--muted);font-size:13px;">Total Tasks</div>
      <div class="stat-val" style="color:#a855f7;">${tasksCount}</div>
    </div>
    <div class="stat-card">
      <div style="color:var(--muted);font-size:13px;">Tasks Completed</div>
      <div class="stat-val" style="color:#22c55e;">${doneTasks}</div>
    </div>
    <div class="stat-card">
      <div style="color:var(--muted);font-size:13px;">Total Tokens / Cost</div>
      <div class="stat-val" style="color:#eab308;font-size:22px;">${totalTokens.toLocaleString()} tk / $${Number(totalCost).toFixed(4)}</div>
    </div>
  </div>

  <div class="layout-grid">
    <div>
      <div class="section-title">
        <span>🔄</span> Active Runs & Workflows
      </div>
      <div>
        ${runCards||'<div style="color:#64748b;font-style:italic;">No runs recorded yet.</div>'}
      </div>
    </div>
    <div>
      <div class="section-title">
        <span>⚡</span> Task DAG Execution State
      </div>
      <div>
        ${taskRows||'<div style="color:#64748b;font-style:italic;">No tasks materialized yet.</div>'}
      </div>
    </div>
  </div>
</body>
</html>`;
}

export const commands={
  dashboard:async ctx=>{
    const {ROOT,projectRoot,args,print}=ctx;
    const proj=fs.existsSync(path.join(projectRoot,'.agent-sdlc','project.json'))?projectConfig(projectRoot):{};
    const state=fs.existsSync(path.join(projectRoot,'.agent-sdlc','state.json'))?readJson(path.join(projectRoot,'.agent-sdlc','state.json'),{}):{};
    const version=readJson(path.join(ROOT,'agent-sdlc.manifest.json')).version;
    const runsDir=path.join(stateDir(projectRoot),'runs');
    const runs=[];
    if(fs.existsSync(runsDir)){
      for(const f of fs.readdirSync(runsDir).filter(x=>x.endsWith('.json')).sort()){
        try{runs.push(readJson(path.join(runsDir,f)));}catch{}
      }
    }
    const allTasks=[];
    for(const r of runs){
      try{allTasks.push(...listTasks(projectRoot,r.run_id));}catch{}
    }
    const metrics=getMetrics(projectRoot);
    const html=generateDashboardHtml({project:proj,state,runs,tasks:allTasks,metrics,version});
    const outPath=args.out?path.resolve(projectRoot,args.out):path.join(projectRoot,'.agent-sdlc','dashboard.html');
    fs.mkdirSync(path.dirname(outPath),{recursive:true});
    fs.writeFileSync(outPath,html,'utf8');

    print({
      status:'GENERATED',
      dashboard_path:outPath,
      runs_count:runs.length,
      tasks_count:allTasks.length,
      version
    });
  },
  serve:async ctx=>{
    const {projectRoot,args,print}=ctx;
    const port=args.port?Number(args.port):4100;
    const host=args.host||'127.0.0.1';
    const {startServer}=await import('../server.mjs');
    const srv=await startServer(projectRoot,{port,host});
    print({
      status:'SERVER_LISTENING',
      url:srv.url,
      port:srv.port,
      host:srv.host
    });
    if(args['close-after-init']) {
      await srv.close();
    }
  }
};
