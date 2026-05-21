// agent-notebook 单页应用 (v1 + v1.1)
// v1: lesson blocks + messages 侧栏 + 折叠/单步
// v1.1: 抽屉(代码完整查看)+hljs 高亮+role 卡片化+字段折叠+点击跳 round+hover 联动+抽屉状态保留
const TOOL_COLORS = 8;
function escapeHtml(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");}
function hashColor(id){let h=0;for(let i=0;i<id.length;i++)h=(h*31+id.charCodeAt(i))|0;return Math.abs(h)%TOOL_COLORS;}
function cssEscape(s){return String(s).replace(/["\\]/g,"\\$&");}
// 任务 4: hljs.highlight 输出已对 < > & 字面进行 HTML 实体转义（实测确认）
// 失败/未识别 lang → 回退到 escapeHtml 纯文本
function safeHighlight(content,lang){
  if(window.__hljsFailed||!window.hljs)return escapeHtml(content);
  const language=lang||"plaintext";
  try{
    if(language!=="plaintext"&&!window.hljs.getLanguage(language))return escapeHtml(content);
    return window.hljs.highlight(content,{language,ignoreIllegals:true}).value;
  }catch(e){console.warn("hljs.highlight failed:",e);return escapeHtml(content);}
}
function langToHljs(lang){
  const m={ts:"typescript",tsx:"typescript",js:"javascript",jsx:"javascript",json:"json",markdown:"markdown",bash:"bash",python:"python",text:"plaintext"};
  return m[lang]??lang??"plaintext";
}

const state={task:"",blocks:[],snapshots:[],cursor:0,expanded:new Set()};
// 任务 11: 抽屉状态缓存（filePath → { scrollTop, focusLine }）
const drawerStates=new Map();
let currentDrawerFile=null;

function init(){
  document.getElementById("prev-btn").addEventListener("click",stepPrev);
  document.getElementById("next-btn").addEventListener("click",stepNext);
  document.getElementById("drawer-close").addEventListener("click",closeDrawer);
  document.getElementById("drawer-mask").addEventListener("click",closeDrawer);
  document.addEventListener("keydown",(e)=>{
    if(e.key==="Escape"&&!document.getElementById("drawer").classList.contains("hidden"))closeDrawer();
  });
  fetch("/api/lesson").then((r)=>r.json()).then(onLessonLoaded).catch((e)=>{
    document.getElementById("lesson").innerHTML=`<div class="lesson-error">[ERROR] failed to fetch /api/lesson: ${escapeHtml(e.message||e)}</div>`;
  });
}
function onLessonLoaded(data){
  if(data.error){
    document.getElementById("lesson").innerHTML=`<div class="lesson-error">[ERROR] ${escapeHtml(data.error)}</div>`;
    return;
  }
  state.task=data.task;state.blocks=data.blocks||[];state.snapshots=data.messagesSnapshots||[];
  document.getElementById("task-banner").textContent=`task: ${state.task}`;
  const firstRoundBlockIdx=state.blocks.findIndex((b)=>b.type==="log"&&b.source&&typeof b.source.round==="number");
  if(firstRoundBlockIdx>=0)state.expanded.add(firstRoundBlockIdx);
  state.cursor=state.snapshots.length>0?1:0;
  renderLesson();renderSidebar();renderStep();
}
function renderLesson(){
  const root=document.getElementById("lesson");root.innerHTML="";
  state.blocks.forEach((b,idx)=>root.appendChild(renderBlock(b,idx)));
}
function renderBlock(b,idx){
  if(b.type==="markdown"){
    const div=document.createElement("div");div.className="block-md";div.innerHTML=b.html;return div;
  }
  if(b.type==="code"){
    const wrap=document.createElement("div");wrap.className="block-code";wrap.dataset.blockIdx=String(idx);
    const tag=document.createElement("span");tag.className="source-tag";
    const sl=b.source.startLine,el=b.source.endLine,tl=b.source.totalLines;
    tag.textContent=(typeof sl==="number"&&typeof el==="number")
      ?`${b.source.file} · section=${b.source.section} · lines ${sl}-${el} / ${tl}`
      :`${b.source.file} · section=${b.source.section}`;
    const pre=document.createElement("pre");
    const code=document.createElement("code");
    code.innerHTML=safeHighlight(b.content,langToHljs(b.lang)); // 任务 4: hljs 输出已转义，直接 innerHTML
    pre.appendChild(code);wrap.appendChild(tag);wrap.appendChild(pre);
    // 任务 6: 主区片段 click → openDrawer
    wrap.addEventListener("click",()=>openDrawer(b.source.file,sl||1,sl,el));
    return wrap;
  }
  if(b.type==="log"){
    const wrap=document.createElement("div");wrap.className="block-log";wrap.dataset.blockIdx=String(idx);
    if(typeof b.source.round==="number")wrap.dataset.round=String(b.source.round);
    if(b.source.section)wrap.dataset.section=String(b.source.section);
    if(!state.expanded.has(idx))wrap.classList.add("collapsed");
    const head=document.createElement("div");head.className="log-head";
    const left=document.createElement("span");
    if(typeof b.source.round==="number")left.textContent=`Round ${b.source.round}`;
    else if(b.source.section)left.textContent=b.source.section;
    else left.textContent=b.source.file;
    const right=document.createElement("span");right.className="stop-reason";
    if(b.stopReason)right.textContent=`stop_reason=${b.stopReason}`;
    head.appendChild(left);head.appendChild(right);
    head.addEventListener("click",()=>{
      if(state.expanded.has(idx))state.expanded.delete(idx);else state.expanded.add(idx);
      wrap.classList.toggle("collapsed");
    });
    const body=document.createElement("div");body.className="log-body";
    const tag=document.createElement("div");tag.className="source-tag";tag.style.margin="8px 12px 0";
    tag.textContent=(typeof b.source.round==="number")
      ?`${b.source.file} · round=${b.source.round}`
      :`${b.source.file} · section=${b.source.section}`;
    const pre=document.createElement("pre");pre.innerHTML=highlightToolIds(b.content);
    body.appendChild(tag);body.appendChild(pre);
    wrap.appendChild(head);wrap.appendChild(body);
    return wrap;
  }
  if(b.type==="error"){
    const div=document.createElement("div");div.className="lesson-error";
    div.textContent=`[ERROR] ${b.message}: ${b.raw}`;
    return div;
  }
  return document.createElement("div");
}
// log 块原始文本中搜寻 tool_use_id（仅对 log 块；data-tooluse-id 用于 hover 联动）
function highlightToolIds(raw){
  return escapeHtml(raw).replace(/(&quot;(?:id|tool_use_id)&quot;:\s*&quot;)([^&]+)(&quot;)/g,(_m,p1,id,p3)=>{
    const c=hashColor(id);
    return `${p1}<span class="toolpair tp-c${c}" data-tooluse-id="${escapeHtml(id)}">${escapeHtml(id)}</span>${p3}`;
  });
}

// ==== 任务 7: messages role 卡片化 + 任务 8: 长字段折叠 + 任务 9/10: 联动 ====
function detectRole(msg){
  if(msg.role==="user"&&Array.isArray(msg.content)&&msg.content.some((b)=>b&&b.type==="tool_result"))return "tool-result";
  return msg.role;
}
function renderMessageCard(msg,idx,isNew,roundForMsg){
  const li=document.createElement("li");
  const role=detectRole(msg);
  li.className=`msg msg-${role}`;
  if(isNew)li.classList.add("is-new");
  if(typeof roundForMsg==="number")li.dataset.roundIndex=String(roundForMsg);
  if(isNew){const tag=document.createElement("span");tag.className="new-tag";tag.textContent="NEW";li.appendChild(tag);}
  const head=document.createElement("div");head.className="msg-head";
  const roleSpan=document.createElement("span");roleSpan.className="role-tag";roleSpan.textContent=`${idx}. ${role}`;
  head.appendChild(roleSpan);
  // 任务 v1.2: 「查看完整 JSON」按钮 → 复用抽屉，hljs JSON 高亮
  const jsonBtn=document.createElement("button");jsonBtn.className="msg-view-json";jsonBtn.type="button";
  jsonBtn.textContent="{ } JSON";jsonBtn.title="查看完整 JSON";
  jsonBtn.addEventListener("click",(e)=>{
    e.stopPropagation();
    // 任务 v1.2: 全周期 = 最终快照的完整 messages 数组（messages 演化只追加不修改，索引稳定）
    const allMsgs=state.snapshots.length>0?state.snapshots[state.snapshots.length-1].messages:[msg];
    openDrawerJson(`messages 全周期 · 定位 [${idx}] ${role}`,allMsgs,idx);
  });
  head.appendChild(jsonBtn);
  li.appendChild(head);
  const body=document.createElement("div");body.className="msg-body";
  if(typeof msg.content==="string"){body.appendChild(renderTextField(msg.content));}
  else if(Array.isArray(msg.content)){for(const sub of msg.content)body.appendChild(renderContentBlock(sub));}
  else{const pre=document.createElement("pre");pre.textContent=JSON.stringify(msg.content,null,2);body.appendChild(pre);}
  li.appendChild(body);
  // 任务 10: message 卡 onclick → 主区跳到所属 round（避免 details 内 click 触发）
  li.addEventListener("click",(e)=>{
    if(e.target.closest("summary"))return;
    if(typeof roundForMsg==="number")jumpToRound(roundForMsg);else jumpToFinal();
  });
  return li;
}
function renderContentBlock(b){
  const div=document.createElement("div");div.className=`cblock cblock-${b?.type||"unknown"}`;
  if(!b||typeof b!=="object"){div.textContent=JSON.stringify(b);return div;}
  if(b.type==="text"){div.appendChild(renderTextField(b.text||"","text"));}
  else if(b.type==="thinking"){
    // 任务 8: thinking 默认折叠
    const det=document.createElement("details");
    const sum=document.createElement("summary");
    sum.textContent=`thinking (${String(b.thinking||"").split("\n").length} 行)`;
    det.appendChild(sum);
    const pre=document.createElement("pre");pre.className="field-pre";pre.textContent=b.thinking||"";
    det.appendChild(pre);div.appendChild(det);
  }
  else if(b.type==="tool_use"){
    const head=document.createElement("div");head.className="tu-head";
    const tag=document.createElement("span");tag.className="tu-tag";tag.textContent=`tool_use · ${b.name||""}`;
    head.appendChild(tag);
    if(b.id){
      const idSpan=document.createElement("span");
      idSpan.className=`toolpair tp-c${hashColor(b.id)}`;idSpan.dataset.tooluseId=b.id;idSpan.textContent=b.id;
      head.appendChild(idSpan);
    }
    div.appendChild(head);
    const pre=document.createElement("pre");pre.className="field-pre";pre.textContent=JSON.stringify(b.input||{},null,2);
    div.appendChild(pre);
  }
  else if(b.type==="tool_result"){
    const head=document.createElement("div");head.className="tr-head";
    const tag=document.createElement("span");tag.className="tr-tag";tag.textContent="tool_result";head.appendChild(tag);
    if(b.tool_use_id){
      const idSpan=document.createElement("span");
      idSpan.className=`toolpair tp-c${hashColor(b.tool_use_id)}`;
      idSpan.dataset.tooluseId=b.tool_use_id;idSpan.textContent=b.tool_use_id;
      head.appendChild(idSpan);
    }
    div.appendChild(head);
    const txt=typeof b.content==="string"?b.content:JSON.stringify(b.content);
    div.appendChild(renderTextField(txt,"result"));
  }
  else{const pre=document.createElement("pre");pre.className="field-pre";pre.textContent=JSON.stringify(b,null,2);div.appendChild(pre);}
  return div;
}
// 任务 8: 长 text 字段（>200 字符）默认折叠
function renderTextField(text,kind){
  const len=String(text).length;
  if(len>200){
    const det=document.createElement("details");
    const sum=document.createElement("summary");sum.textContent=`${kind||"text"} (${len} 字符)`;
    det.appendChild(sum);
    const pre=document.createElement("pre");pre.className="field-pre";pre.textContent=text;det.appendChild(pre);
    return det;
  }
  const pre=document.createElement("pre");pre.className="field-pre";pre.textContent=text;return pre;
}
function renderSidebar(){
  const list=document.getElementById("messages-list");const hint=document.getElementById("snapshot-hint");
  list.innerHTML="";
  if(state.snapshots.length===0){hint.textContent="lesson 不含 round 日志块，无法重建 messages 演化";return;}
  if(state.cursor===0){hint.textContent="点击 [下一步] 推进到 Round 1";return;}
  const snap=state.snapshots[state.cursor-1];
  hint.textContent=`当前快照: 推进到 Round ${snap.roundIndex} 后，messages 数组共 ${snap.messages.length} 条`;
  const added=new Set(snap.addedIndices);
  // 计算每条 message 属于哪一轮：以前一快照为分界
  const prevLen=state.cursor>=2?state.snapshots[state.cursor-2].messages.length:0;
  snap.messages.forEach((msg,i)=>{
    let rfm=null;
    if(i>=prevLen){rfm=snap.roundIndex;}
    else{
      for(let s=0;s<state.cursor-1;s++){
        if(state.snapshots[s].addedIndices.includes(i)){rfm=state.snapshots[s].roundIndex;break;}
      }
    }
    list.appendChild(renderMessageCard(msg,i,added.has(i),rfm));
  });
}
// 任务 9: tool_use hover 联动（事件委托）
function bindToolPairHover(){
  document.body.addEventListener("mouseover",(e)=>{
    const t=e.target.closest("[data-tooluse-id]");if(!t)return;
    const id=t.dataset.tooluseId;if(!id)return;
    document.querySelectorAll(`[data-tooluse-id="${cssEscape(id)}"]`).forEach((el)=>el.classList.add("hl-paired"));
  });
  document.body.addEventListener("mouseout",(e)=>{
    const t=e.target.closest("[data-tooluse-id]");if(!t)return;
    const id=t.dataset.tooluseId;if(!id)return;
    document.querySelectorAll(`[data-tooluse-id="${cssEscape(id)}"]`).forEach((el)=>el.classList.remove("hl-paired"));
  });
}
function renderStep(){
  document.getElementById("step-indicator").textContent=`round ${state.cursor} / ${state.snapshots.length}`;
  document.getElementById("prev-btn").disabled=state.cursor<=0;
  document.getElementById("next-btn").disabled=state.cursor>=state.snapshots.length;
}
function roundBlockIndices(){
  return state.blocks.map((b,i)=>({b,i})).filter((x)=>x.b.type==="log"&&typeof x.b.source?.round==="number").map((x)=>x.i);
}
function syncExpandedToCursor(){
  const r=roundBlockIndices();
  for(let k=0;k<state.cursor&&k<r.length;k++)state.expanded.add(r[k]);
}
function stepNext(){
  if(state.cursor>=state.snapshots.length)return;
  state.cursor+=1;syncExpandedToCursor();renderLesson();renderSidebar();renderStep();scrollToCurrentRound();
}
function stepPrev(){
  if(state.cursor<=0)return;
  const r=roundBlockIndices();
  if(state.cursor-1<r.length&&state.cursor>1)state.expanded.delete(r[state.cursor-1]);
  state.cursor-=1;renderLesson();renderSidebar();renderStep();scrollToCurrentRound();
}
function scrollToCurrentRound(){
  if(state.cursor<=0)return;
  const r=roundBlockIndices();const targetIdx=r[state.cursor-1];
  if(typeof targetIdx!=="number")return;
  const el=document.getElementById("lesson").children[targetIdx];
  if(el&&el.scrollIntoView)el.scrollIntoView({behavior:"smooth",block:"center"});
}
// 任务 10: messages 点击 → 跳到对应 round 的 lesson 块
function jumpToRound(roundIndex){
  const r=roundBlockIndices();const targetBlockIdx=r[roundIndex-1];
  if(typeof targetBlockIdx!=="number")return jumpToFinal();
  const el=document.getElementById("lesson").children[targetBlockIdx];
  if(!el)return;
  el.scrollIntoView({behavior:"smooth",block:"center"});flashOutline(el);
}
function jumpToFinal(){
  const last=document.getElementById("lesson").lastElementChild;
  if(!last)return;
  last.scrollIntoView({behavior:"smooth",block:"center"});flashOutline(last);
}
function flashOutline(el){el.classList.add("flash-outline");setTimeout(()=>el.classList.remove("flash-outline"),1500);}

// ==== 任务 3-5-6-11: 抽屉 ====
async function openDrawer(filePath,focusLine,startLine,endLine){
  const drawer=document.getElementById("drawer"),mask=document.getElementById("drawer-mask");
  const title=document.getElementById("drawer-title"),body=document.getElementById("drawer-body");
  // 任务 11: 若同 file 已有缓存状态，scroll 复位优先用缓存
  const cached=drawerStates.get(filePath);
  const fl=(cached&&cached.focusLine)||focusLine||1;
  drawer.classList.remove("hidden");mask.classList.remove("hidden");
  drawer.setAttribute("aria-hidden","false");document.body.classList.add("drawer-open");
  body.innerHTML=`<p class="loading">正在加载 ${escapeHtml(filePath)}…</p>`;
  title.textContent=filePath;currentDrawerFile=filePath;
  let res,json;
  try{res=await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);}
  catch(e){body.innerHTML=`<div class="lesson-error">[ERROR] fetch failed: ${escapeHtml(String(e.message||e))}</div>`;return;}
  if(!res.ok){
    let errMsg=`HTTP ${res.status}`;
    try{const j=await res.json();if(j.error)errMsg=j.error;}catch{}
    body.innerHTML=`<div class="lesson-error">[ERROR] ${escapeHtml(errMsg)} (path=${escapeHtml(filePath)})</div>`;return;
  }
  try{json=await res.json();}catch(e){body.innerHTML=`<div class="lesson-error">[ERROR] invalid JSON</div>`;return;}
  const {content,totalLines,lang}=json;
  // 顶部 banner（焦点行范围）
  const banner=document.createElement("div");banner.className="drawer-banner";
  banner.textContent=(typeof startLine==="number"&&typeof endLine==="number")
    ?`${filePath} · 当前聚焦 lines ${startLine}-${endLine} / 总 ${totalLines} 行 · lang=${lang}`
    :`${filePath} · 总 ${totalLines} 行 · lang=${lang}`;
  body.innerHTML="";body.appendChild(banner);
  // hljs 整文件着色，再按行切（保留跨行 span）
  const htmlLines=splitHighlightedLines(safeHighlight(content,lang));
  const table=document.createElement("table");table.className="code-table";
  for(let i=0;i<htmlLines.length;i++){
    const tr=document.createElement("tr");const lineNo=i+1;
    if(typeof startLine==="number"&&typeof endLine==="number"&&lineNo>=startLine&&lineNo<=endLine)tr.classList.add("is-focused");
    tr.dataset.line=String(lineNo);
    const td1=document.createElement("td");td1.className="ln";td1.textContent=String(lineNo);
    const td2=document.createElement("td");td2.className="code";td2.innerHTML=htmlLines[i]||"&nbsp;";
    tr.appendChild(td1);tr.appendChild(td2);
    // 任务 6: 抽屉行 click → closeDrawer + 主区高亮
    tr.addEventListener("click",()=>{closeDrawer();jumpBackToCodeBlock(filePath,lineNo);});
    table.appendChild(tr);
  }
  body.appendChild(table);
  // scroll 复位：优先 cached.scrollTop，否则定位 focus 行
  requestAnimationFrame(()=>{
    if(cached&&typeof cached.scrollTop==="number")body.scrollTop=cached.scrollTop;
    else{const tr=table.querySelector(`tr[data-line="${fl}"]`);if(tr&&tr.scrollIntoView)tr.scrollIntoView({block:"start"});}
  });
}
// hljs 输出按 \n 分行，避免跨行 span 丢失：状态机记录 open span，分行处闭合，新行开头重新打开
function splitHighlightedLines(html){
  const stack=[],lines=[];let cur="",i=0;
  while(i<html.length){
    const ch=html[i];
    if(ch==="<"){
      const end=html.indexOf(">",i);if(end===-1){cur+=html.slice(i);break;}
      const tag=html.slice(i,end+1);cur+=tag;
      if(tag.startsWith("</"))stack.pop();
      else if(!tag.endsWith("/>"))stack.push(tag);
      i=end+1;continue;
    }
    if(ch==="\n"){
      for(let k=stack.length-1;k>=0;k--)cur+="</span>";
      lines.push(cur);cur="";
      for(const t of stack)cur+=t;
      i++;continue;
    }
    cur+=ch;i++;
  }
  if(cur.length>0||lines.length===0)lines.push(cur);
  return lines;
}
function jumpBackToCodeBlock(filePath,lineNo){
  // 找主区第一个 source.file === filePath 且 startLine ≤ lineNo ≤ endLine 的 code block
  let target=state.blocks.findIndex((b)=>b.type==="code"&&b.source&&b.source.file===filePath&&typeof b.source.startLine==="number"&&lineNo>=b.source.startLine&&lineNo<=b.source.endLine);
  if(target<0)target=state.blocks.findIndex((b)=>b.type==="code"&&b.source&&b.source.file===filePath);
  if(target<0)return;
  const el=document.getElementById("lesson").children[target];
  if(el&&el.scrollIntoView){el.scrollIntoView({behavior:"smooth",block:"center"});flashOutline(el);}
}
function closeDrawer(){
  const drawer=document.getElementById("drawer"),mask=document.getElementById("drawer-mask"),body=document.getElementById("drawer-body");
  // 任务 11: 关闭前缓存 scrollTop（仅文件视图，JSON 视图 currentDrawerFile=null 不缓存）
  if(currentDrawerFile){
    const prev=drawerStates.get(currentDrawerFile)||{};
    drawerStates.set(currentDrawerFile,{...prev,scrollTop:body.scrollTop});
  }
  drawer.classList.add("hidden");mask.classList.add("hidden");
  drawer.setAttribute("aria-hidden","true");document.body.classList.remove("drawer-open");
  currentDrawerFile=null;
}
// 任务 v1.2: 数组顶层元素的行号范围（1-based, inclusive）— 依赖 JSON.stringify(_, null, 2) 的固定 2 空格缩进
function getArrayElementLineRanges(arr){
  const lines=JSON.stringify(arr,null,2).split("\n");
  const ranges=[];let start=-1;
  for(let i=0;i<lines.length;i++){
    if(/^  [{\[]/.test(lines[i]))start=i+1;
    else if(start>0&&/^  [}\]],?\s*$/.test(lines[i])){ranges.push({start,end:i+1});start=-1;}
  }
  return ranges;
}
// 任务 v1.2: 复用抽屉，渲染完整 messages 数组 JSON（hljs language=json）+ 高亮定位 focusIdx
function openDrawerJson(title,allMessages,focusIdx){
  const drawer=document.getElementById("drawer"),mask=document.getElementById("drawer-mask");
  const titleEl=document.getElementById("drawer-title"),body=document.getElementById("drawer-body");
  drawer.classList.remove("hidden");mask.classList.remove("hidden");
  drawer.setAttribute("aria-hidden","false");document.body.classList.add("drawer-open");
  titleEl.textContent=title;currentDrawerFile=null;
  const content=JSON.stringify(allMessages,null,2);
  const ranges=getArrayElementLineRanges(allMessages);
  const focus=(typeof focusIdx==="number"&&ranges[focusIdx])?ranges[focusIdx]:null;
  const banner=document.createElement("div");banner.className="drawer-banner";
  banner.textContent=focus?`${title} · 共 ${content.split("\n").length} 行 · 当前定位 messages[${focusIdx}] lines ${focus.start}-${focus.end}`:`${title} · 共 ${content.split("\n").length} 行`;
  body.innerHTML="";body.appendChild(banner);
  const htmlLines=splitHighlightedLines(safeHighlight(content,"json"));
  const table=document.createElement("table");table.className="code-table";
  for(let i=0;i<htmlLines.length;i++){
    const tr=document.createElement("tr");const lineNo=i+1;tr.dataset.line=String(lineNo);
    if(focus&&lineNo>=focus.start&&lineNo<=focus.end)tr.classList.add("is-focused");
    const td1=document.createElement("td");td1.className="ln";td1.textContent=String(lineNo);
    const td2=document.createElement("td");td2.className="code";td2.innerHTML=htmlLines[i]||"&nbsp;";
    tr.appendChild(td1);tr.appendChild(td2);table.appendChild(tr);
  }
  body.appendChild(table);
  requestAnimationFrame(()=>{
    if(focus){const tr=table.querySelector(`tr[data-line="${focus.start}"]`);if(tr&&tr.scrollIntoView)tr.scrollIntoView({block:"start",behavior:"instant"});}
    else body.scrollTop=0;
  });
}
bindToolPairHover();init();
