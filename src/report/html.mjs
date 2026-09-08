// 單一自足 HTML 報表：不連任何外部資源，沒有字型 CDN、沒有圖表函式庫。
// 版面刻意做成「檢驗報告」而不是儀表板——先講結論，再攤開證據，最後交代量測方法。

export function renderHtml(d) {
  const t = d.totals;
  // 空索引時所有分母都會是 0，統一墊 1 免得整頁變成 NaN。
  const acc = Math.max(1, t.accounted);
  const live = catBytes(d, 'text') + catBytes(d, 'thinking');
  const ribbon = d.categories.map((r) => ({ ...r, pctv: r.bytes / acc }));
  const maxCalls = d.tools.length ? d.tools[0].calls : 1;
  const days = spanDays(t.firstTs, t.lastTs);

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>存檔體檢報告 · ccarchive</title>
<style>${css()}</style>
</head>
<body>
<a class="skip" href="#main">跳到主要內容</a>
<div class="sheet">

<header class="masthead">
  <div class="masthead-left">
    <p class="eyebrow">ccarchive</p>
    <h1>存檔體檢報告</h1>
    <p class="sub">Claude Code 對話存檔的體積、重複與內容組成</p>
  </div>
  <dl class="colophon">
    <dt>來源</dt><dd class="mono">${esc(d.root)}</dd>
    <dt>掃描於</dt><dd class="mono">${esc(fmtDateTime(d.scannedAt))}</dd>
    <dt>產出於</dt><dd class="mono">${esc(fmtDateTime(d.generatedAt))}</dd>
    <dt>索引大小</dt><dd class="mono">${bytes(d.dbSize)}</dd>
  </dl>
</header>

<main id="main">

<section class="lede">
  <p class="statement">
    這份存檔佔 <b class="fig">${bytes(t.bytes)}</b>。真正是你和 Claude 說過的話——文字加思考——只有 <b class="fig live">${bytes(live)}</b>，佔 <b class="fig live">${pct(live, acc)}</b>。
  </p>
  <figure class="ratio" aria-label="對話內容佔全部位元組的比例">
    <div class="ratio-track">
      <div class="ratio-live" style="--w:${(live / acc * 100).toFixed(3)}%"></div>
    </div>
    <figcaption>
      <span><i class="swatch live"></i>對話內容 ${bytes(live)}</span>
      <span><i class="swatch dim"></i>格式與工具開銷 ${bytes(acc - live)}</span>
    </figcaption>
  </figure>

  <div class="figures">
    ${figure(num(t.sessions), 'session', `${num(days)} 天內 · ${num(t.activeDays)} 天有活動`)}
    ${figure(num(t.msgs), '訊息', `你 ${num(t.userMsgs)} · Claude ${num(t.asstMsgs)}`)}
    ${figure(bytes(d.lineage.redundantBytes), '重複位元組', `${pct(d.lineage.redundantBytes, t.bytes)}，來自 ${num(d.lineage.groups.length)} 組分岔`)}
    ${figure(num(d.lineage.roles.subsumed), '可整檔回收', d.lineage.roles.subsumed === 0 ? '沒有任何檔案是多餘的' : '訊息全部在別處')}
  </div>
</section>

<section class="sec">
  <h2><span class="idx">01</span>位元組去了哪裡</h2>
  <p class="lead">每一行 JSON 都被拆成十二類分別計數。分類依欄位歸戶，不是估算：<code>message.content</code> 裡的每個區塊按型別計，<code>toolUseResult</code>、<code>attachment</code>、<code>usage</code> 這些頂層欄位各自成類，剩下對不上的才算進「JSON 結構」。</p>

  <div class="ribbon" role="img" aria-label="位元組分類比例">
    ${ribbon.map((r, i) => `<div class="seg ${tone(r.key)}" style="--w:${(r.pctv * 100).toFixed(3)}%;--i:${i}" title="${esc(r.label)} ${bytes(r.bytes)}（${pct(r.bytes, acc)}）"></div>`).join('')}
  </div>

  <div class="scroll"><table class="tbl">
    <thead><tr><th>類別</th><th class="r">大小</th><th class="r">佔比</th><th class="note-h">說明</th></tr></thead>
    <tbody>
      ${ribbon.map((r) => `<tr>
        <td><i class="swatch ${tone(r.key)}"></i>${esc(r.label)}</td>
        <td class="r mono">${bytes(r.bytes)}</td>
        <td class="r mono">${pct(r.bytes, acc)}</td>
        <td class="note">${esc(CAT_NOTE[r.key] || '')}</td>
      </tr>`).join('')}
    </tbody>
  </table></div>

  ${catBytes(d, 'tool_result_dup') > 0 ? `<p class="finding">
    <b>工具結果被存了兩份。</b>同一份工具輸出同時出現在 <code>message.content</code> 的 <code>tool_result</code> 區塊和頂層的 <code>toolUseResult</code> 欄位裡。這一份副本佔 ${bytes(catBytes(d, 'tool_result_dup'))}，是全檔的 ${pct(catBytes(d, 'tool_result_dup'), acc)}——比你說過的所有話加起來還多 ${(catBytes(d, 'tool_result_dup') / Math.max(1, live)).toFixed(1)} 倍。這是存檔格式造成的，跟使用方式無關。</p>` : ''}
</section>

<section class="sec">
  <h2><span class="idx">02</span>分岔：同一段對話存了幾份</h2>
  <p class="lead"><code>/resume</code> 續接時，Claude Code 會把既有訊息原樣複製進一個新檔案。這裡用訊息 <code>uuid</code> 的交集把有血緣的檔案連成群——不是比對內容，是比對同一則訊息的身分。</p>

  <div class="roles">
    ${roleChip('primary', d.lineage.roles.primary, '群內重複最少，最該保留的一份')}
    ${roleChip('fork', d.lineage.roles.fork, '與別人共用開頭的分岔')}
    ${roleChip('subsumed', d.lineage.roles.subsumed, '每一則訊息都能在別處找到')}
    ${roleChip('solo', d.lineage.roles.solo, '沒有任何共用訊息')}
  </div>

  ${d.lineage.roles.subsumed === 0 ? `<p class="finding">
    <b>沒有任何一個檔案可以整個刪掉。</b>重複的 ${bytes(d.lineage.redundantBytes)} 全部落在各檔案的開頭，每個分岔在共用的前綴之後都長出了自己的內容。刪掉其中任何一個 <code>.jsonl</code>，都會連帶失去只存在於那個檔案裡的訊息。「刪掉短的對話來省空間」在這份存檔上實測是無效的。</p>` : ''}

  <div class="groups">
    ${d.lineage.groups.map((g) => renderGroup(g)).join('')}
  </div>
</section>

<section class="sec">
  <h2><span class="idx">03</span>專案</h2>
  <div class="scroll"><table class="tbl">
    <thead><tr><th>專案</th><th class="r">session</th><th class="r">訊息</th><th class="r">大小</th><th class="r">佔比</th><th>最後活動</th></tr></thead>
    <tbody>
      ${d.projects.map((p) => `<tr>
        <td>${esc(p.label)}${p.exists ? '' : ' <span class="tag">目錄已不存在</span>'}</td>
        <td class="r mono">${num(p.sessions)}</td>
        <td class="r mono">${num(p.msgs)}</td>
        <td class="r mono">${bytes(p.bytes)}</td>
        <td class="r"><span class="track"><i class="minibar" style="--w:${(p.bytes / Math.max(1, t.bytes) * 100).toFixed(2)}%"></i></span><span class="mono">${pct(p.bytes, t.bytes)}</span></td>
        <td class="mono dim">${esc(fmtDate(p.lastTs))}</td>
      </tr>`).join('')}
    </tbody>
  </table></div>
</section>

<section class="sec">
  <h2><span class="idx">04</span>節奏</h2>
  <div class="two">
    <div>
      <h3>逐月訊息量</h3>
      <ul class="hbars">
        ${d.time.months.map((m) => `<li><span class="k mono">${esc(m.k)}</span><span class="b" style="--w:${(m.v / maxOf(d.time.months) * 100).toFixed(2)}%"></span><span class="v mono">${num(m.v)}</span></li>`).join('')}
      </ul>
      <h3>星期</h3>
      <ul class="hbars">
        ${d.time.weekdays.map((m) => `<li><span class="k mono">週${esc(m.k)}</span><span class="b" style="--w:${(m.v / maxOf(d.time.weekdays) * 100).toFixed(2)}%"></span><span class="v mono">${num(m.v)}</span></li>`).join('')}
      </ul>
    </div>
    <div>
      <h3>一天之中（本機時間）</h3>
      <ul class="vbars" aria-label="每小時訊息量">
        ${d.time.hours.map((h) => `<li title="${esc(h.k)}:00 · ${num(h.v)} 則"><span class="col" style="--h:${(h.v / maxOf(d.time.hours) * 100).toFixed(2)}%"></span><span class="lb mono">${Number(h.k) % 6 === 0 ? esc(h.k) : ''}</span></li>`).join('')}
      </ul>
      ${d.time.busiest ? `<p class="note">最忙的一天是 <span class="mono">${esc(d.time.busiest[0])}</span>，${num(d.time.busiest[1])} 則訊息。</p>` : ''}
      <h3>token</h3>
      <dl class="kv">
        <dt>輸入</dt><dd class="mono">${num(t.tokens.input)}</dd>
        <dt>輸出</dt><dd class="mono">${num(t.tokens.output)}</dd>
        <dt>快取讀取</dt><dd class="mono">${num(t.tokens.cacheRead)}</dd>
        <dt>快取寫入</dt><dd class="mono">${num(t.tokens.cacheWrite)}</dd>
      </dl>
      ${t.tokens.cacheRead > t.tokens.input * 10 ? `<p class="note">快取讀取是新輸入的 ${num(Math.round(t.tokens.cacheRead / Math.max(1, t.tokens.input)))} 倍。長對話的成本幾乎全在重讀既有脈絡，不在新打的字。</p>` : ''}
    </div>
  </div>
</section>

<section class="sec">
  <h2><span class="idx">05</span>工具</h2>
  <div class="scroll"><table class="tbl">
    <thead><tr><th>工具</th><th class="r">呼叫次數</th><th class="r">佔比</th></tr></thead>
    <tbody>
      ${d.tools.map((r) => `<tr>
        <td class="mono">${esc(r.name)}</td>
        <td class="r mono">${num(r.calls)}</td>
        <td class="r"><span class="track wide"><i class="minibar" style="--w:${(r.calls / maxCalls * 100).toFixed(2)}%"></i></span></td>
      </tr>`).join('')}
    </tbody>
  </table></div>
  <p class="note">次數不等於體積。單筆工具結果大小差異可以到三個數量級，索引不把位元組逐筆歸戶到工具名稱，所以這裡只報次數。</p>
</section>

<section class="sec">
  <h2><span class="idx">06</span>全部 session</h2>
  <div class="toolbar">
    <label class="field"><span>篩選</span><input id="q" type="search" placeholder="標題、專案或 ID" autocomplete="off"></label>
    <label class="field"><span>角色</span><select id="role">
      <option value="">全部</option><option value="primary">primary</option>
      <option value="fork">fork</option><option value="subsumed">subsumed</option><option value="solo">solo</option>
    </select></label>
    <span id="count" class="note mono"></span>
  </div>
  <div class="scroll"><table class="tbl sortable" id="stab">
    <thead><tr>
      <th data-k="title">標題</th>
      <th data-k="project">專案</th>
      <th data-k="lastTs">最後活動</th>
      <th data-k="msgs" class="r">訊息</th>
      <th data-k="size" class="r">大小</th>
      <th data-k="role">分岔</th>
      <th data-k="topLabel">主要組成</th>
    </tr></thead>
    <tbody></tbody>
  </table></div>
</section>

<section class="sec">
  <h2><span class="idx">07</span>量測方法與限制</h2>
  <div class="two">
    <div>
      <h3>怎麼算的</h3>
      <dl class="defs">
        <dt>位元組</dt><dd>逐行讀原始 <code>.jsonl</code>，把每個頂層欄位與 <code>content</code> 區塊分別序列化後量長度。整行長度減去已歸戶的部分算進「JSON 結構」。</dd>
        <dt>共用訊息</dt><dd>同一個 <code>uuid</code> 出現在兩個以上的檔案裡。用聯集尋找把有交集的檔案併成群。</dd>
        <dt>重複位元組</dt><dd>每個共用 <code>uuid</code> 指定一個保留者（訊息最多者優先），其餘檔案裡的同一則訊息算重複。</dd>
        <dt>孤兒快取</dt><dd>專案目錄下與 session 同名、但對應 <code>.jsonl</code> 已不存在的子目錄。<code>memory/</code>、<code>todos/</code>、<code>shell-snapshots/</code>、<code>scripts/</code> 一律排除。</dd>
      </dl>
    </div>
    <div>
      <h3>這份報表不知道的事</h3>
      <ul class="bullets">
        <li>沒有內容層級的去重。訊息被 compact 重寫後 <code>uuid</code> 會全新，靠 uuid 交集抓不到。</li>
        <li>工具結果的位元組沒有歸戶到個別工具名稱。</li>
        <li>token 數字取自存檔中的 <code>usage</code> 欄位，是 API 回報值，不是重新計算的。</li>
        <li>「目錄已不存在」的專案只代表本機路徑對應不上，可能只是改了名。</li>
        ${t.badLines > 0 ? `<li>有 ${num(t.badLines)} 行無法解析（多半是寫入中途中斷），這些行只計入「JSON 結構」的位元組。</li>` : '<li>全部行都解析成功，沒有被略過的資料。</li>'}
      </ul>
      <h3>快取目錄</h3>
      <p class="note">${num(t.sidecarDirs)} 個工具結果快取目錄，共 ${bytes(t.sidecarBytes)}。${t.orphanDirs > 0
        ? `其中 ${num(t.orphanDirs)} 個是孤兒（${bytes(t.orphanBytes)}）——快取目錄是整套工具裡唯一可以整個丟掉的東西。`
        : '每一個都有對應的對話檔，沒有孤兒可以清。'}</p>
    </div>
  </div>
</section>

<section class="sec">
  <h2><span class="idx">08</span>重現這些數字</h2>
  <div class="scroll"><table class="tbl">
    <thead><tr><th>想看什麼</th><th>指令</th></tr></thead>
    <tbody>
      <tr><td>重建索引</td><td class="mono">ccarchive scan</td></tr>
      <tr><td>位元組分類</td><td class="mono">ccarchive bloat --by-project --by-session</td></tr>
      <tr><td>分岔群組</td><td class="mono">ccarchive lineage --all</td></tr>
      <tr><td>孤兒快取</td><td class="mono">ccarchive orphans</td></tr>
      <tr><td>回收計畫（不動檔案）</td><td class="mono">ccarchive reclaim</td></tr>
      <tr><td>全文檢索</td><td class="mono">ccarchive search &lt;關鍵字&gt;</td></tr>
      <tr><td>重新產生這份報表</td><td class="mono">ccarchive report</td></tr>
    </tbody>
  </table></div>
</section>

</main>

<footer class="foot">
  <p>由 <span class="mono">ccarchive</span> 產生。除了 <span class="mono">reclaim --apply</span> 與 <span class="mono">undo</span>，本工具對存檔目錄一律唯讀；這份報表只讀索引，沒有把任何對話內容寫進 HTML。</p>
</footer>
</div>

<script id="data" type="application/json">${jsonScript(d.sessions.map((s) => ({
  id: s.id, title: s.title, project: s.project, lastTs: s.lastTs, msgs: s.msgs,
  size: s.size, role: s.role, topLabel: s.topCategory.label, redundantBytes: s.redundantBytes,
})))}</script>
<script>${js()}</script>
</body>
</html>
`;
}

const CAT_NOTE = {
  text: '你和 Claude 真正說出來的字',
  thinking: '思考區塊的可讀內容',
  signature: '思考區塊的加密簽章，無法閱讀也無法重建',
  tool_use: '工具呼叫的名稱與參數',
  tool_result: 'content 區塊裡的工具輸出',
  tool_result_dup: '同一份工具輸出的第二份拷貝（toolUseResult）',
  image: '貼進對話的圖片',
  attachment: '自動附掛的目錄樹、檔案摘要等',
  usage: 'token 計量欄位',
  ids: 'uuid、sessionId、requestId 等識別碼',
  context: 'cwd、version、gitBranch 等環境欄位',
  envelope: '括號、欄位名、逗號等純結構開銷',
};

function renderGroup(g) {
  const max = Math.max(...g.members.map((m) => m.size), 1);
  return `<details class="group"${g.redundantBytes > 1e6 ? ' open' : ''}>
    <summary>
      <span class="gt">${esc(g.title)}</span>
      <span class="gm mono">${g.members.length} 檔</span>
      <span class="gr mono">重複 ${bytes(g.redundantBytes)}</span>
    </summary>
    <ol class="members">
      ${g.members.map((m) => {
    const dup = m.redundantBytes / Math.max(1, m.size);
    return `<li>
        <span class="role ${m.role}">${m.role}</span>
        <span class="mono id">${esc(m.id.slice(0, 8))}</span>
        <span class="bar" style="--w:${(m.size / max * 100).toFixed(2)}%;--d:${(dup * 100).toFixed(2)}%"
              title="獨有 ${bytes(m.size - m.redundantBytes)} · 重複 ${bytes(m.redundantBytes)}"></span>
        <span class="mono sz">${bytes(m.size)}</span>
        <span class="mono uq">${num(m.uniqueMsgs)} 獨有</span>
        <span class="mono dt">${esc(fmtDate(m.lastTs))}</span>
      </li>`;
  }).join('')}
    </ol>
  </details>`;
}

function figure(v, label, note) {
  return `<div class="fig-item"><b>${v}</b><span class="lb">${esc(label)}</span><span class="nt">${esc(note)}</span></div>`;
}

function roleChip(role, n, note) {
  return `<div class="chip"><span class="role ${role}">${role}</span><b class="mono">${num(n)}</b><span class="nt">${esc(note)}</span></div>`;
}

function tone(key) {
  if (key === 'text' || key === 'thinking') return 'live';
  if (key === 'tool_result_dup' || key === 'signature' || key === 'envelope') return 'sig';
  return 'dim';
}

function catBytes(d, key) { return d.categories.find((r) => r.key === key)?.bytes || 0; }
function maxOf(rows) { return Math.max(...rows.map((r) => r.v), 1); }
function spanDays(a, b) {
  if (!a || !b) return 0;
  return Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 86400000));
}

function bytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024, i = 0;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x < 10 ? x.toFixed(1) : Math.round(x)} ${u[i]}`;
}
function num(n) { return Number(n || 0).toLocaleString('en-US'); }
function pct(a, b) { return b ? `${(a / b * 100).toFixed(1)}%` : '0%'; }
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : `${fmtDate(iso)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
function p2(n) { return String(n).padStart(2, '0'); }

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/** 內嵌 JSON：只需要防止 </script> 提早結束標籤。 */
function jsonScript(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

function css() {
  return `
:root {
  /* 紙與墨：暖白底、深褐黑字，避開預設的 gray-50 / blue-500 組合 */
  --paper: #f4f1ea;
  --paper-2: #ebe6db;
  --paper-3: #e2dccf;
  --ink: #191710;
  --ink-2: #4e4a3f;
  --ink-3: #837c6c;
  --rule: #d5cdbb;
  --rule-2: #c3b9a3;
  /* 兩個語意色：live＝真正的內容，sig＝格式與重複造成的開銷 */
  --live: #4b5f36;
  --live-soft: #7f9463;
  --sig: #8c3722;
  --sig-soft: #b5644c;
  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, "Songti TC", "Noto Serif CJK TC", Georgia, serif;
  --sans: -apple-system, BlinkMacSystemFont, "PingFang TC", "Noto Sans CJK TC", "Microsoft JhengHei", system-ui, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Noto Sans Mono CJK TC", monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #14120d;
    --paper-2: #1d1a14;
    --paper-3: #262219;
    --ink: #ece6d8;
    --ink-2: #aaa392;
    --ink-3: #7b7364;
    --rule: #322d23;
    --rule-2: #453e31;
    --live: #93ae70;
    --live-soft: #6a8150;
    --sig: #cd7259;
    --sig-soft: #9e5340;
  }
}

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 15px;
  line-height: 1.65;
}
.skip { position: absolute; left: -9999px; }
.skip:focus { left: 1rem; top: 1rem; background: var(--paper-2); padding: .5rem .75rem; z-index: 9; }
.sheet { max-width: 68rem; margin: 0 auto; padding: 3.5rem 2rem 5rem; }
.mono { font-family: var(--mono); font-size: .86em; font-variant-numeric: tabular-nums; }
.dim { color: var(--ink-3); }
.note { color: var(--ink-3); font-size: .875rem; line-height: 1.6; }
code { font-family: var(--mono); font-size: .86em; background: var(--paper-2); padding: .1em .35em; border-radius: 2px; }
b { font-weight: 600; }

/* ── 報頭 ───────────────────────────── */
.masthead {
  display: grid; grid-template-columns: 1fr auto; gap: 2rem 3rem; align-items: end;
  border-bottom: 2px solid var(--ink); padding-bottom: 1.25rem; margin-bottom: 3rem;
}
.eyebrow {
  margin: 0 0 .35rem; font-family: var(--mono); font-size: .72rem;
  letter-spacing: .22em; text-transform: uppercase; color: var(--ink-3);
}
.masthead h1 { margin: 0; font-family: var(--serif); font-size: clamp(2.1rem, 5vw, 3.1rem); font-weight: 600; line-height: 1.05; letter-spacing: -.01em; }
.masthead .sub { margin: .45rem 0 0; color: var(--ink-2); font-size: .95rem; }
.colophon { display: grid; grid-template-columns: auto 1fr; gap: .1rem .9rem; margin: 0; font-size: .78rem; }
.colophon dt { color: var(--ink-3); }
.colophon dd { margin: 0; overflow-wrap: anywhere; }

/* ── 頭條 ───────────────────────────── */
.lede { margin-bottom: 4rem; }
.statement {
  font-family: var(--serif); font-size: clamp(1.35rem, 3vw, 1.9rem);
  line-height: 1.5; margin: 0 0 1.75rem; max-width: 46ch; text-wrap: balance;
}
.statement .fig { font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.statement .live { color: var(--live); }

.ratio { margin: 0 0 2.5rem; }
.ratio-track { height: 54px; background: var(--paper-3); border: 1px solid var(--rule-2); position: relative; overflow: hidden; }
.ratio-live { height: 100%; width: var(--w); background: var(--live); animation: grow .7s cubic-bezier(.2,.7,.3,1) both; }
.ratio figcaption { display: flex; gap: 1.5rem; margin-top: .6rem; font-size: .82rem; color: var(--ink-2); flex-wrap: wrap; }
.swatch { display: inline-block; width: .7em; height: .7em; margin-right: .45em; vertical-align: baseline; background: var(--ink-3); }
.swatch.live { background: var(--live); }
.swatch.sig { background: var(--sig); }
.swatch.dim { background: var(--paper-3); border: 1px solid var(--rule-2); }

.figures { display: grid; grid-template-columns: repeat(4, 1fr); border-top: 1px solid var(--rule); }
.fig-item { padding: 1.1rem 1.25rem 1.1rem 0; border-right: 1px solid var(--rule); }
.fig-item:last-child { border-right: 0; }
.fig-item + .fig-item { padding-left: 1.25rem; }
.fig-item b { display: block; font-family: var(--serif); font-size: 1.85rem; line-height: 1.15; font-variant-numeric: tabular-nums; }
.fig-item .lb { display: block; font-size: .78rem; letter-spacing: .1em; color: var(--ink-2); margin-top: .15rem; }
.fig-item .nt { display: block; font-size: .76rem; color: var(--ink-3); margin-top: .4rem; line-height: 1.45; }

/* ── 區段 ───────────────────────────── */
.sec { margin: 0 0 4rem; }
.sec h2 {
  font-family: var(--serif); font-size: 1.5rem; font-weight: 600; margin: 0 0 .9rem;
  padding-bottom: .5rem; border-bottom: 1px solid var(--ink); display: flex; align-items: baseline; gap: .8rem;
}
.idx { font-family: var(--mono); font-size: .78rem; color: var(--ink-3); letter-spacing: .1em; }
.sec h3 { font-family: var(--serif); font-size: 1rem; font-weight: 600; margin: 1.75rem 0 .6rem; }
.sec h3:first-child { margin-top: 0; }
.lead { color: var(--ink-2); max-width: 62ch; margin: 0 0 1.5rem; }

.finding {
  border-left: 3px solid var(--sig); padding: .85rem 0 .85rem 1.1rem;
  margin: 1.75rem 0 0; max-width: 62ch; color: var(--ink-2);
}
.finding b { color: var(--ink); }

/* ── 分類色帶 ───────────────────────── */
.ribbon { display: flex; height: 42px; margin: 0 0 1.75rem; border: 1px solid var(--rule-2); }
.seg { width: var(--w); background: var(--paper-3); animation: grow .55s cubic-bezier(.2,.7,.3,1) both; animation-delay: calc(var(--i) * 28ms); }
.seg + .seg { border-left: 1px solid var(--paper); }
.seg.live { background: var(--live); }
.seg.sig { background: var(--sig); }
.seg.dim:nth-child(even) { background: var(--rule); }
@keyframes grow { from { width: 0; } to { width: var(--w); } }
@media (prefers-reduced-motion: reduce) {
  .ratio-live, .seg { animation: none; }
}

/* ── 表格 ───────────────────────────── */
/* 表格在窄螢幕自己橫向捲，頁面本身永遠不橫向捲 */
.scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.tbl { width: 100%; border-collapse: collapse; font-size: .88rem; }
.tbl th {
  text-align: left; font-weight: 600; font-size: .74rem; letter-spacing: .09em;
  text-transform: uppercase; color: var(--ink-3); border-bottom: 1px solid var(--rule-2);
  padding: .5rem .7rem .5rem 0; white-space: nowrap;
}
.tbl td { padding: .48rem .7rem .48rem 0; border-bottom: 1px solid var(--rule); vertical-align: baseline; }
.tbl tr:last-child td { border-bottom: 0; }
.tbl .r { text-align: right; }
.tbl td.note { font-size: .8rem; }
.tag { font-size: .7rem; color: var(--sig); border: 1px solid var(--sig-soft); padding: 0 .3em; }
.track { display: inline-block; width: 3.5rem; margin-right: .5em; vertical-align: middle; }
.track.wide { width: 8rem; }
.minibar { display: block; width: var(--w); max-width: 100%; height: .5em; background: var(--ink-3); min-width: 1px; }

.sortable th[data-k] { cursor: pointer; user-select: none; }
.sortable th[data-k]:hover { color: var(--ink); }
.sortable th[aria-sort]::after { content: "↑"; margin-left: .35em; font-size: .8em; }
.sortable th[aria-sort="descending"]::after { content: "↓"; }

/* ── 角色 ───────────────────────────── */
.roles { display: flex; flex-wrap: wrap; gap: 0; border-top: 1px solid var(--rule); margin-bottom: 1.75rem; }
.chip { flex: 1 1 12rem; padding: .9rem 1.1rem .9rem 0; border-right: 1px solid var(--rule); }
.chip:last-child { border-right: 0; }
.chip + .chip { padding-left: 1.1rem; }
.chip b { display: block; font-family: var(--serif); font-size: 1.5rem; margin: .2rem 0 .1rem; }
.chip .nt { display: block; font-size: .75rem; color: var(--ink-3); line-height: 1.45; }
.role {
  font-family: var(--mono); font-size: .7rem; letter-spacing: .06em;
  border: 1px solid currentColor; padding: 0 .35em; color: var(--ink-3);
}
.role.primary { color: var(--live); }
.role.fork { color: var(--ink-2); }
.role.subsumed { color: var(--sig); }

/* ── 分岔群組 ───────────────────────── */
.groups { border-top: 1px solid var(--rule); }
.group { border-bottom: 1px solid var(--rule); }
.group summary {
  display: flex; align-items: baseline; gap: .9rem; padding: .7rem 0; cursor: pointer;
  list-style: none;
}
.group summary::-webkit-details-marker { display: none; }
.group summary::before { content: "+"; font-family: var(--mono); color: var(--ink-3); width: 1ch; }
.group[open] summary::before { content: "−"; }
.group .gt { font-weight: 600; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.group .gm { color: var(--ink-3); font-size: .78rem; }
.group .gr { color: var(--sig); font-size: .78rem; }
.members { list-style: none; margin: 0 0 .9rem; padding: 0 0 0 1.9rem; }
.members li { display: grid; grid-template-columns: 5.5rem 5rem 1fr 5rem 6rem 6rem; gap: .7rem; align-items: center; padding: .22rem 0; font-size: .82rem; }
.members .bar {
  height: .8em; width: var(--w); min-width: 2px;
  background: linear-gradient(to right, var(--sig) 0 var(--d), var(--live-soft) var(--d) 100%);
}
.members .sz, .members .uq, .members .dt { color: var(--ink-2); }
.members .dt { color: var(--ink-3); }

/* ── 長條圖 ─────────────────────────── */
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 2.5rem 3.5rem; }
.hbars { list-style: none; margin: 0; padding: 0; }
.hbars li { display: grid; grid-template-columns: 4.5rem 1fr 4rem; gap: .7rem; align-items: center; padding: .16rem 0; font-size: .82rem; }
.hbars .b { height: .8em; width: var(--w); min-width: 2px; background: var(--ink-2); }
.hbars .v { text-align: right; color: var(--ink-2); }
.vbars { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(24, 1fr); gap: 2px; height: 130px; align-items: end; }
.vbars li { display: flex; flex-direction: column; justify-content: flex-end; height: 100%; }
.vbars .col { height: var(--h); min-height: 1px; background: var(--ink-2); }
.vbars .lb { font-size: .62rem; color: var(--ink-3); text-align: center; margin-top: .25rem; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: .1rem 1rem; margin: 0; font-size: .85rem; }
.kv dt { color: var(--ink-3); }
.kv dd { margin: 0; text-align: right; }
.defs { margin: 0; font-size: .87rem; }
.defs dt { font-weight: 600; margin-top: .8rem; }
.defs dd { margin: .15rem 0 0; color: var(--ink-2); }
.bullets { margin: 0; padding-left: 1.1rem; font-size: .87rem; color: var(--ink-2); }
.bullets li { margin-bottom: .45rem; }

/* ── 工具列 ─────────────────────────── */
.toolbar { display: flex; gap: 1.25rem; align-items: center; flex-wrap: wrap; margin-bottom: 1rem; }
.field { display: flex; align-items: center; gap: .5rem; font-size: .78rem; color: var(--ink-3); }
.field input, .field select {
  font: inherit; font-size: .85rem; color: var(--ink); background: var(--paper);
  border: 1px solid var(--rule-2); padding: .3rem .5rem; border-radius: 0;
}
.field input { width: 15rem; max-width: 45vw; }
.field input:focus, .field select:focus { outline: 2px solid var(--ink-2); outline-offset: -1px; }

.foot { border-top: 1px solid var(--rule); margin-top: 3rem; padding-top: 1.25rem; color: var(--ink-3); font-size: .8rem; }
.foot p { margin: 0; max-width: 68ch; }

@media (max-width: 760px) {
  .sheet { padding: 2rem 1.1rem 3rem; }
  .masthead { grid-template-columns: 1fr; align-items: start; }
  .figures { grid-template-columns: 1fr 1fr; }
  .fig-item:nth-child(2n) { border-right: 0; }
  .fig-item:nth-child(n+3) { border-top: 1px solid var(--rule); }
  /* 兩欄時左欄一律貼齊左邊界，右欄才縮排 */
  .fig-item:nth-child(odd) { padding-left: 0; }
  .fig-item:nth-child(even) { padding-left: 1.1rem; }
  .two { grid-template-columns: 1fr; }
  /* 手機只留 ID、比例條與大小；角色由條子的紅色比例看得出來 */
  .members li { grid-template-columns: 5.2rem 1fr 4.2rem; gap: .5rem; }
  .members .uq, .members .dt, .members .role { display: none; }
  .members { padding-left: .9rem; }
  .tbl { font-size: .8rem; }
  .tbl td.note { display: none; }
  .tbl th.note-h { display: none; }
  #stab th:nth-child(2), #stab td:nth-child(2),
  #stab th:nth-child(7), #stab td:nth-child(7) { display: none; }
  .tbl td.mono, .tbl td.r { white-space: nowrap; }
  .group summary { gap: .5rem; }
  .group .gm, .group .gr { white-space: nowrap; }
  .scroll { margin-right: -1.1rem; padding-right: 1.1rem; }
  .vbars { height: 90px; }
}

@media print {
  :root { --paper: #fff; --paper-2: #f3f0e9; --paper-3: #e8e3d7; --ink: #000; --rule: #ccc; }
  body { font-size: 10.5pt; }
  .sheet { max-width: none; padding: 0; }
  .toolbar, .skip { display: none; }
  .sec { break-inside: avoid; }
  .group { break-inside: avoid; }
  details { display: block; }
  details > summary { list-style: none; }
  details:not([open]) > *:not(summary) { display: revert; }
}
`;
}

function js() {
  return `
(function () {
  var rows = JSON.parse(document.getElementById('data').textContent);
  var tbody = document.querySelector('#stab tbody');
  var q = document.getElementById('q');
  var roleSel = document.getElementById('role');
  var count = document.getElementById('count');
  var sortKey = 'lastTs', sortDir = -1;

  function bytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    var u = ['KB','MB','GB','TB'], x = n / 1024, i = 0;
    while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
    return (x < 10 ? x.toFixed(1) : Math.round(x)) + ' ' + u[i];
  }
  function num(n) { return Number(n || 0).toLocaleString('en-US'); }
  function date(s) { return s ? s.slice(0, 10) : '—'; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function render() {
    var term = q.value.trim().toLowerCase();
    var role = roleSel.value;
    var out = rows.filter(function (r) {
      if (role && r.role !== role) return false;
      if (!term) return true;
      return (r.title + ' ' + r.project + ' ' + r.id).toLowerCase().indexOf(term) >= 0;
    });
    out.sort(function (a, b) {
      var x = a[sortKey], y = b[sortKey];
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * sortDir;
      return String(x == null ? '' : x).localeCompare(String(y == null ? '' : y), 'zh-Hant') * sortDir;
    });
    tbody.innerHTML = out.map(function (r) {
      return '<tr>'
        + '<td>' + esc(r.title || '（無標題）') + '</td>'
        + '<td class="dim">' + esc(r.project) + '</td>'
        + '<td class="mono dim">' + date(r.lastTs) + '</td>'
        + '<td class="r mono">' + num(r.msgs) + '</td>'
        + '<td class="r mono">' + bytes(r.size) + '</td>'
        + '<td><span class="role ' + esc(r.role) + '">' + esc(r.role) + '</span></td>'
        + '<td class="dim">' + esc(r.topLabel || '') + '</td>'
        + '</tr>';
    }).join('');
    count.textContent = out.length + ' / ' + rows.length + ' 個 session';
  }

  document.querySelectorAll('#stab th[data-k]').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.getAttribute('data-k');
      if (k === sortKey) sortDir = -sortDir;
      else { sortKey = k; sortDir = (k === 'msgs' || k === 'size' || k === 'lastTs') ? -1 : 1; }
      document.querySelectorAll('#stab th[data-k]').forEach(function (o) { o.removeAttribute('aria-sort'); });
      th.setAttribute('aria-sort', sortDir < 0 ? 'descending' : 'ascending');
      render();
    });
  });
  q.addEventListener('input', render);
  roleSel.addEventListener('change', render);
  render();
})();
`;
}
