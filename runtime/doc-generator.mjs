import fs from 'node:fs';
import path from 'node:path';
import {stateDir,listRuns,loadRun,latestRunId,projectConfig,listTasks} from './store.mjs';
import {ensureDir,now,rootFrom} from './util.mjs';
import {generateDashboardHtml} from './commands/dashboard.mjs';
import {metrics as getMetrics} from './telemetry.mjs';

/**
 * Ensures standard human-readable directories and documentation templates exist in .agent-sdlc
 */
export function ensureStandardDocs(projectRoot){
  const ROOT=rootFrom(import.meta.url);
  const d=stateDir(projectRoot);
  const docsDir=path.join(d,'docs');
  const reportsDir=path.join(d,'reports');
  ensureDir(docsDir);
  ensureDir(reportsDir);

  const docFiles=[
    {tpl:'SUMMARY.md',dest:path.join(d,'SUMMARY.md')},
    {tpl:'docs-README.md',dest:path.join(docsDir,'README.md')},
    {tpl:'ARCHITECTURE-AND-STATE.md',dest:path.join(docsDir,'ARCHITECTURE-AND-STATE.md')},
    {tpl:'WORKFLOWS-GUIDE.md',dest:path.join(docsDir,'WORKFLOWS-GUIDE.md')},
    {tpl:'CLI-CHEAT-SHEET.md',dest:path.join(docsDir,'CLI-CHEAT-SHEET.md')}
  ];

  for(const item of docFiles){
    const src=path.join(ROOT,'templates',item.tpl);
    if(fs.existsSync(src)&&!fs.existsSync(item.dest)){
      try{fs.copyFileSync(src,item.dest);}catch{}
    }
  }
}

/**
 * Generates a human-readable Markdown report for a specific run.
 */
export function generateRunReport(projectRoot,run,options={}){
  if(!run)return null;
  const d=stateDir(projectRoot);
  const reportsDir=path.join(d,'reports');
  ensureDir(reportsDir);

  const tasks=listTasks(projectRoot,run.run_id)||[];
  const runFileId=run.run_id.startsWith('run_')?run.run_id:`run_${run.run_id}`;
  const reportFile=path.join(reportsDir,`${runFileId}.md`);

  const taskRows=tasks.length?tasks.map(t=>{
    const statusBadge=t.status==='DONE'?'✅ DONE':t.status==='RUNNING'?'⏳ RUNNING':t.status==='FAILED'?'❌ FAILED':`⚪ ${t.status}`;
    return `| \`${t.task_id}\` | ${t.title||t.description||'(không có mô tả)'} | ${statusBadge} | \`${t.category||'feature'}\` |`;
  }).join('\n'):'| *(Chưa có tasks nào)* | - | - | - |';

  const evidenceList=[];
  if(run.evidence&&typeof run.evidence==='object'){
    for(const [stage,claims] of Object.entries(run.evidence)){
      if(Array.isArray(claims)&&claims.length){
        evidenceList.push(`- **Stage \`${stage}\`:** ${claims.map(c=>`\`${c}\``).join(', ')}`);
      }
    }
  }

  const artifactsList=(run.artifacts&&Array.isArray(run.artifacts)&&run.artifacts.length)
    ? run.artifacts.map(a=>`- Mã artifact: \`${a}\``).join('\n')
    : '- *(Không có artifacts phát sinh)*';

  const content=`# Báo Cáo Thực Thi SDLC: Run ${run.run_id}

- **Mục tiêu (Objective):** ${run.objective||'(Không có mục tiêu)'}
- **Workflow:** \`${run.workflow||'unknown'}\` (Profile: **${run.profile||'STANDARD'}**)
- **Trạng thái:** **${run.state||'IDLE'}**
- **Thời gian khởi tạo:** ${run.created_at||'-'}
- **Thời gian cập nhật:** ${run.updated_at||'-'}
- **Số lần chuyển trạng thái (Revision):** ${run.revision||0}

---

## 1. Danh Sách Nhiệm Vụ (Tasks)

| Task ID | Tiêu Đề | Trạng Thái | Phân Loại |
| :--- | :--- | :--- | :--- |
${taskRows}

---

## 2. Bằng Chứng Kiểm Định Vượt Qua (Verification Evidence)

${evidenceList.length?evidenceList.join('\n'):'- *(Chưa ghi nhận bằng chứng)*'}

---

## 3. Danh Sách Artifacts Đã Lưu

${artifactsList}

---

*Báo cáo được tự động tạo bởi Agent SDLC Harness lúc ${now()}.*
`;

  fs.writeFileSync(reportFile,content,'utf8');
  return {
    report_file:reportFile,
    run_id:run.run_id,
    status:'GENERATED'
  };
}

/**
 * Updates the master SUMMARY.md in .agent-sdlc with latest runs, reports, and links.
 */
export function updateSummaryIndex(projectRoot){
  const d=stateDir(projectRoot);
  const summaryFile=path.join(d,'SUMMARY.md');
  const reportsDir=path.join(d,'reports');
  ensureDir(reportsDir);

  const runIds=listRuns(projectRoot);
  const runs=runIds.map(id=>loadRun(projectRoot,id)).filter(Boolean);
  runs.sort((a,b)=>(b.updated_at||'').localeCompare(a.updated_at||''));

  const activeRun=runs[0]||null;
  const reports=fs.existsSync(reportsDir)
    ? fs.readdirSync(reportsDir).filter(f=>f.endsWith('.md'))
    : [];

  const reportsRows=reports.length?reports.map(r=>{
    return `| **[${r}](file://${path.join(reportsDir,r)})** | Báo cáo chi tiết kết quả chạy hoặc kiểm định |`;
  }).join('\n'):'| *(Chưa có báo cáo nào)* | - |';

  const runsRows=runs.slice(0,5).map(r=>{
    const stBadge=r.state==='CLOSE'?'✅ CLOSE':r.state==='FAIL'?'❌ FAIL':`⏳ ${r.state}`;
    return `| \`${r.run_id}\` | ${r.workflow||'standard'} | ${stBadge} | ${r.objective?r.objective.slice(0,50)+'...':'-'} |`;
  }).join('\n')||'| *(Chưa có lượt chạy nào)* | - | - | - |';

  const content=`# Bảng Tóm Tắt Trạng Thái & Trung Tâm Tài Liệu SDLC (.agent-sdlc)

> **Lưu ý:** Thư mục \`.agent-sdlc/\` lưu trữ toàn bộ trạng thái thực thi, bằng chứng kiểm định (evidence), và các tài liệu con người có thể đọc trực tiếp (human-readable docs).

---

## 1. Trạng Thái Hoạt Động Hiện Tại

- **Lượt chạy gần nhất:** \`${activeRun?.run_id||'Không có'}\`
- **Giai đoạn hiện tại:** **${activeRun?.state||'IDLE'}**
- **Workflow / Profile:** \`${activeRun?.workflow||'-'}\` (**${activeRun?.profile||'-'}**)
- **Mục tiêu:** ${activeRun?.objective||'(Không có)'}
- **Cập nhật lần cuối:** ${activeRun?.updated_at||now()}

---

## 2. Tài Liệu Hướng Dẫn & Kiến Trúc (Dành Cho Người Dùng Đọc)

| Tài liệu | Mô tả | Liên kết |
| :--- | :--- | :--- |
| **Hướng Dẫn Cấu Trúc & Tra Cứu** | Hướng dẫn cấu trúc thư mục \`.agent-sdlc\`, cách đọc artifact băm SHA-256 | [docs/README.md](file://${path.join(d,'docs','README.md')}) |
| **Kiến Trúc & 5 Human Gates** | Chi tiết 10 giai đoạn SDLC, 5 cổng phê duyệt của con người và 3 risk profiles | [ARCHITECTURE-AND-STATE.md](file://${path.join(d,'docs','ARCHITECTURE-AND-STATE.md')}) |
| **Cẩm Nang 21 Workflows** | Bảng đối chiếu 21 workflows (STRICT / STANDARD / FAST) và cách chọn luồng | [WORKFLOWS-GUIDE.md](file://${path.join(d,'docs','WORKFLOWS-GUIDE.md')}) |
| **Bảng Tra Cứu Lệnh CLI** | Tra cứu nhanh các lệnh: \`auto\`, \`status\`, \`task\`, \`gate\`, \`approval\`, \`report\` | [CLI-CHEAT-SHEET.md](file://${path.join(d,'docs','CLI-CHEAT-SHEET.md')}) |
| **Chính Sách Review Code** | Quy chuẩn 3 vòng review (Bugs, Security, Compliance) và Nit Capping | [REVIEW.md](file://${path.join(d,'REVIEW.md')}) |
| **Dashboard Trực Quan** | Giao diện HTML xem trạng thái pipeline, tasks và runs trực quan trên trình duyệt | [dashboard.html](file://${path.join(d,'dashboard.html')}) |

---

## 3. Các Báo Cáo Nghiệm Thu & Tóm Tắt Đã Lưu

| Tên Báo Cáo | Mô Tả |
| :--- | :--- |
${reportsRows}

---

## 4. Năm Lượt Chạy Gần Nhất (Recent Runs)

| Run ID | Workflow | Trạng Thái | Mục Tiêu |
| :--- | :--- | :--- | :--- |
${runsRows}

---

## 5. Các Lệnh Tra Cứu Nhanh Cho Người Dùng

\`\`\`bash
# 1. Cập nhật / tạo file Dashboard giao diện HTML trực quan:
node runtime/cli.mjs dashboard

# 2. Tạo hoặc làm mới báo cáo tóm tắt Markdown cho run hiện tại:
node runtime/cli.mjs report

# 3. Xem danh sách tất cả các Artifacts đã được tạo:
node runtime/cli.mjs artifact-list

# 4. Xem nội dung văn bản/markdown rõ ràng của một Artifact theo mã ID:
node runtime/cli.mjs artifact-get --ref <artifact_id>
\`\`\`
`;

  fs.writeFileSync(summaryFile,content,'utf8');
  return summaryFile;
}

/**
 * Automatically regenerates dashboard HTML in .agent-sdlc/dashboard.html
 */
export function syncDashboard(projectRoot){
  try{
    const d=stateDir(projectRoot);
    const proj=projectConfig(projectRoot);
    const runIds=listRuns(projectRoot);
    const runs=runIds.map(id=>loadRun(projectRoot,id)).filter(Boolean);
    runs.sort((a,b)=>(b.updated_at||'').localeCompare(a.updated_at||''));
    const state=runs[0]||{state:'IDLE'};
    const tasks=state?.run_id?listTasks(projectRoot,state.run_id):[];
    let met=null;
    try{met=getMetrics(projectRoot);}catch{}
    const html=generateDashboardHtml({project:proj,state,runs,tasks,metrics:met,version:'3.0.0-rc2'});
    const outPath=path.join(d,'dashboard.html');
    fs.writeFileSync(outPath,html,'utf8');
  }catch{}
}
