/* ================================================================
   PROGRESS.JS — "Kişisel Mod": isme özel ilerleme takibi + SRS
   ================================================================
   Bu dosya index.html'deki #personalView kutusunu doldurur.
   Firebase (leaderboard.js ile AYNI app/db örneğini kullanır) ile
   ilerleme cihazlar arası senkronlanır; Firebase erişilemezse
   localStorage'a düşer ve site yine çalışmaya devam eder.

   Beklenen global bağımlılıklar (index.html'in ana <script>'inde
   tanımlı ve bu dosya ondan SONRA yüklendiği için erişilebilir):
     LANGS, VOCAB, activeLang, activeLevel, poolForLevel(),
     speak(), pickVoice(), normalizeWord(), findStemMatch(),
     renderLangPair(), rebuildLevelBox(), rebuildChips(), applyFilter(),
     soundOn
   leaderboard.js'den:
     window.LB_getUserName(), window.LB_sanitizeKey(), window.LB_getDb(),
     window.LB_checkName(), window.LB_onNameReady, window.LB_getTotalSeconds()
================================================================ */
(function(){

  /* ---------------- SABİTLER ---------------- */
  // Aşama süreleri: 0=yeni, sonraki her doğru cevapta bir sonraki aşamaya geçer.
  const STAGE_MS = [0, 10*60*1000, 24*3600*1000, 3*24*3600*1000, 7*24*3600*1000, 16*24*3600*1000, 35*24*3600*1000];
  const KNOWN_STAGE = 4; // bu aşamaya ulaşan kelime "öğrenildi" sayılır
  const BADGE_THRESHOLDS = [50, 100, 250, 500, 1000];
  const DEFAULT_DAILY_GOAL = 30;

  /* ---------------- DURUM ---------------- */
  let currentName = '';
  let currentKey = '';
  let dataLoaded = false;
  let wordProgress = {};     // { wordKey: {seen,correct,wrong,stage,dueAt,lastSeen,lang,level,cat} }
  let meta = null;           // { xp, streak, lastStudyDate, todayDate, todayCount, dailyGoal, badges:{}, dailyCounts:{} }

  let sessionQueue = [];
  let sessionIdx = 0;
  let sessionStats = { total:0, correct:0, wrong:0, xp:0, newBadges:[], mistakes:[] };
  let comboStreak = 0;
  let currentAnswered = false;

  const root = document.getElementById('personalView');

  /* ---------------- YARDIMCILAR ---------------- */
  function sanitizeKeyFallback(name){
    return String(name).trim().toLowerCase().replace(/\s+/g,'_').slice(0,20).replace(/[.#$\/\[\]]/g,'_');
  }
  function getKey(name){
    return (window.LB_sanitizeKey ? window.LB_sanitizeKey(name) : sanitizeKeyFallback(name));
  }
  function dbRef(path){
    const db = window.LB_getDb ? window.LB_getDb() : null;
    return db ? db.ref(path) : null;
  }
  function safeLocalGet(k){
    try{ const raw = localStorage.getItem(k); return raw ? JSON.parse(raw) : null; }catch(e){ return null; }
  }
  function safeLocalSet(k, val){
    try{ localStorage.setItem(k, JSON.stringify(val)); }catch(e){}
  }
  function todayStr(){
    const d = new Date();
    const p = n => String(n).padStart(2,'0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
  }
  function dayDiff(a,b){
    const da = new Date(a+'T00:00:00');
    const db_ = new Date(b+'T00:00:00');
    return Math.round((db_-da)/86400000);
  }
  function defaultMeta(){
    return { xp:0, streak:0, lastStudyDate:null, todayDate:null, todayCount:0, dailyGoal:DEFAULT_DAILY_GOAL, badges:{}, dailyCounts:{} };
  }
  function wordKeyFor(v){
    const raw = v.lang+'_'+v.level+'_'+v.w;
    return raw.toLowerCase()
      .replace(/[.#$\[\]\/\s]+/g,'_')
      .replace(/[^a-z0-9_äöüßáéíóúñçğışâêàèéìòù]/gi,'_')
      .slice(0,120);
  }
  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function pmSpeak(text, voiceLang, rate){
    if(typeof soundOn !== 'undefined' && !soundOn) return;
    if(!('speechSynthesis' in window)) return;
    try{
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const voice = (typeof pickVoice === 'function') ? pickVoice(voiceLang) : null;
      if(voice){ u.voice = voice; u.lang = voice.lang; } else { u.lang = voiceLang; }
      u.rate = rate || 0.92;
      u.volume = 1.0;
      window.speechSynthesis.speak(u);
    }catch(e){}
  }
  function shuffle(arr){
    for(let i=arr.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; }
    return arr;
  }

  /* ---------------- VERİ YÜKLEME / KAYDETME ---------------- */
  function loadUserData(name, cb){
    currentName = name;
    currentKey = getKey(name);
    dataLoaded = false;
    const local = safeLocalGet('pm_data_'+currentKey);
    wordProgress = (local && local.words) ? local.words : {};
    meta = (local && local.meta) ? local.meta : null;

    const ref = dbRef('progress/'+currentKey);
    if(ref){
      ref.once('value').then(snap=>{
        const val = snap.val();
        if(val){
          if(val.words) wordProgress = val.words;
          if(val.meta) meta = val.meta;
        }
        finalizeLoad(cb);
      }).catch(()=> finalizeLoad(cb));
    } else {
      finalizeLoad(cb);
    }
  }
  function finalizeLoad(cb){
    wordProgress = wordProgress || {};
    meta = Object.assign(defaultMeta(), meta || {});
    ensureDailyRollover();
    persistLocalMirror();
    dataLoaded = true;
    if(cb) cb();
  }
  function persistLocalMirror(){
    safeLocalSet('pm_data_'+currentKey, { words: wordProgress, meta: meta });
  }
  function persistWordRecord(key, rec){
    wordProgress[key] = rec;
    persistLocalMirror();
    const ref = dbRef('progress/'+currentKey+'/words/'+key);
    if(ref) ref.set(rec).catch(()=>{});
  }
  function persistMeta(){
    persistLocalMirror();
    const ref = dbRef('progress/'+currentKey+'/meta');
    if(ref) ref.set(meta).catch(()=>{});
  }

  function ensureDailyRollover(){
    const t = todayStr();
    if(meta.todayDate !== t){
      meta.todayDate = t;
      meta.todayCount = 0;
    }
  }
  function markStudyToday(){
    const t = todayStr();
    if(meta.lastStudyDate !== t){
      const diff = meta.lastStudyDate ? dayDiff(meta.lastStudyDate, t) : null;
      meta.streak = (diff === 1) ? (meta.streak||0)+1 : 1;
      meta.lastStudyDate = t;
    }
    meta.dailyCounts = meta.dailyCounts || {};
    meta.dailyCounts[t] = (meta.dailyCounts[t]||0) + 1;
    const keys = Object.keys(meta.dailyCounts).sort();
    while(keys.length > 14){ delete meta.dailyCounts[keys.shift()]; }
  }
  function weeklyCount(){
    const days = [];
    const now = new Date();
    for(let i=0;i<7;i++){
      const d = new Date(now); d.setDate(d.getDate()-i);
      const p = n => String(n).padStart(2,'0');
      days.push(`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`);
    }
    return days.reduce((sum,d)=> sum + ((meta.dailyCounts && meta.dailyCounts[d]) || 0), 0);
  }
  function checkBadges(){
    const known = Object.values(wordProgress).filter(r=>r.stage>=KNOWN_STAGE).length;
    BADGE_THRESHOLDS.forEach(t=>{
      if(known>=t && !(meta.badges && meta.badges[t])){
        meta.badges = meta.badges || {};
        meta.badges[t] = true;
        sessionStats.newBadges.push(t);
        showToast(`🏅 Rozet kazandın: ${t} kelime öğrenildi!`);
      }
    });
  }
  function showToast(msg){
    let layer = document.getElementById('pmToastLayer');
    if(!layer){
      layer = document.createElement('div');
      layer.id = 'pmToastLayer';
      layer.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2000;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;';
      document.body.appendChild(layer);
    }
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'background:linear-gradient(135deg,#3a2410,#1c1006);border:1px solid rgba(255,180,84,0.6);color:#ffe9c7;padding:10px 18px;border-radius:999px;font-size:13px;font-weight:700;box-shadow:0 6px 22px rgba(0,0,0,0.4),0 0 18px rgba(255,180,84,0.3);opacity:0;transform:translateY(-8px);transition:opacity .35s ease, transform .35s ease;';
    layer.appendChild(t);
    requestAnimationFrame(()=>{ t.style.opacity='1'; t.style.transform='translateY(0)'; });
    setTimeout(()=>{
      t.style.opacity='0'; t.style.transform='translateY(-8px)';
      setTimeout(()=>t.remove(), 400);
    }, 3200);
  }

  /* ---------------- SRS ---------------- */
  function stageOnCorrect(stage){ return Math.min(stage+1, STAGE_MS.length-1); }
  function stageOnWrong(stage){ return Math.max(stage-2, 0); }
  function modeForStage(stage){
    if(stage <= 1) return 'flash';
    if(stage === 2) return 'mc';
    if(stage === 3) return 'listen';
    if(stage === 4) return 'blank';
    return 'write';
  }
  function getRecord(v){
    return wordProgress[wordKeyFor(v)] || null;
  }

  /* ---------------- STİL (ayrı tema — sıcak amber/bakır) ---------------- */
  function injectStyles(){
    if(document.getElementById('pmStyles')) return;
    const style = document.createElement('style');
    style.id = 'pmStyles';
    style.textContent = `
      .pm-root{
        --pm-accent:#ffb454; --pm-accent2:#ff7a6b; --pm-good:#3dffa0; --pm-bad:#ff5f7a;
        --pm-panel: linear-gradient(160deg, rgba(58,36,16,0.38), rgba(20,12,6,0.42));
        --pm-border: rgba(255,180,84,0.35);
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      }
      .pm-root .pm-head{
        text-align:center;padding:18px 14px 22px;border-radius:22px;margin-bottom:16px;
        background: radial-gradient(circle at 50% -10%, rgba(255,180,84,0.16), transparent 60%), var(--pm-panel);
        border:1px solid var(--pm-border);
        box-shadow:0 8px 30px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(255,180,84,0.12);
      }
      .pm-root .pm-eyebrow{font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--pm-accent);margin-bottom:6px;text-shadow:0 0 10px rgba(255,180,84,0.4);}
      .pm-root .pm-title{font-family:Georgia,'Iowan Old Style',serif;font-size:22px;font-weight:700;color:#ffe9c7;margin-bottom:2px;}
      .pm-root .pm-sub{font-size:11.5px;color:#c9a37a;}
      .pm-root .pm-pill-row{display:flex;gap:6px;justify-content:center;flex-wrap:wrap;margin-top:14px;}
      .pm-root .pm-pill{padding:6px 12px;border-radius:999px;font-size:11.5px;font-weight:700;background:rgba(255,180,84,0.1);border:1px solid var(--pm-border);color:#ffe9c7;}
      .pm-root .pm-pill.flame{background:rgba(255,122,107,0.14);border-color:rgba(255,122,107,0.4);}
      .pm-root .pm-mini-select{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-top:14px;}
      .pm-root .pm-chip{padding:6px 11px;border-radius:10px;font-size:11.5px;font-weight:700;color:#c9a37a;background:rgba(255,255,255,0.03);border:1px solid rgba(255,180,84,0.18);cursor:pointer;}
      .pm-root .pm-chip.active{color:#1c1006;background:linear-gradient(135deg,var(--pm-accent),var(--pm-accent2));border-color:transparent;box-shadow:0 0 14px rgba(255,180,84,0.4);}
      .pm-root .pm-goal-wrap{margin-top:14px;text-align:left;}
      .pm-root .pm-goal-row{display:flex;justify-content:space-between;font-size:11px;color:#c9a37a;margin-bottom:5px;}
      .pm-root .pm-bar{height:6px;border-radius:6px;background:rgba(255,255,255,0.08);overflow:hidden;}
      .pm-root .pm-bar-fill{height:100%;background:linear-gradient(90deg,var(--pm-accent),var(--pm-accent2));box-shadow:0 0 10px rgba(255,180,84,0.6);transition:width .3s ease;}

      .pm-root .pm-card{
        background:var(--pm-panel);border:1px solid var(--pm-border);border-radius:18px;padding:16px;margin-bottom:12px;
        box-shadow:0 6px 22px rgba(0,0,0,0.3);
      }
      .pm-root .pm-card h4{margin:0 0 10px;font-size:12.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--pm-accent);}
      .pm-root .pm-level-row{display:flex;justify-content:space-between;align-items:center;font-size:12.5px;color:#ffe9c7;margin-bottom:8px;}
      .pm-root .pm-level-row .pm-bar{flex:1;margin:0 10px;}
      .pm-root .pm-stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
      .pm-root .pm-stat-box{background:rgba(255,255,255,0.03);border:1px solid rgba(255,180,84,0.14);border-radius:12px;padding:10px 12px;}
      .pm-root .pm-stat-num{font-size:19px;font-weight:800;color:#ffe9c7;font-family:Georgia,serif;}
      .pm-root .pm-stat-label{font-size:10.5px;color:#c9a37a;margin-top:2px;}
      .pm-root .pm-badges{display:flex;gap:8px;flex-wrap:wrap;}
      .pm-root .pm-badge{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;background:rgba(255,180,84,0.12);border:1px solid var(--pm-border);}
      .pm-root .pm-badge.locked{opacity:.25;filter:grayscale(1);}

      .pm-root button.pm-btn{
        width:100%;padding:14px 0;border-radius:14px;border:1px solid var(--pm-border);
        background:rgba(255,255,255,0.03);color:#ffe9c7;font-size:14px;font-weight:700;cursor:pointer;margin-bottom:10px;
      }
      .pm-root button.pm-btn.primary{
        background:linear-gradient(135deg,var(--pm-accent),var(--pm-accent2));color:#241206;border:none;
        box-shadow:0 6px 22px rgba(255,122,107,0.35), 0 0 30px rgba(255,180,84,0.25);
      }
      .pm-root button.pm-btn:active{opacity:.7;transform:scale(.98);}
      .pm-root button.pm-btn.small{padding:10px 0;font-size:12.5px;}

      .pm-root .pm-session-bar{display:flex;justify-content:space-between;font-size:11.5px;color:#c9a37a;margin-bottom:8px;}
      .pm-root .pm-study-card{
        background:var(--pm-panel);border:1px solid var(--pm-border);border-radius:20px;padding:26px 20px;text-align:center;margin-bottom:16px;
        box-shadow:0 10px 30px rgba(0,0,0,0.35);
      }
      .pm-root .pm-mode-tag{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--pm-accent);margin-bottom:10px;}
      .pm-root .pm-word{font-size:27px;font-weight:700;font-family:Georgia,'Iowan Old Style',serif;color:#ffe9c7;margin-bottom:6px;}
      .pm-root .pm-word-sub{font-size:12px;color:#c9a37a;margin-bottom:8px;}
      .pm-root .pm-blank-sentence{font-size:13px;font-style:italic;color:#ffe9c7;margin-top:8px;line-height:1.5;}
      .pm-root .pm-blank-hint{font-size:11.5px;color:#c9a37a;margin-top:6px;}
      .pm-root .pm-speak-btn{
        display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:50%;
        background:rgba(255,180,84,0.14);border:1px solid var(--pm-border);cursor:pointer;margin:0 4px;
      }
      .pm-root .pm-speak-btn svg{width:17px;height:17px;stroke:var(--pm-accent);}
      .pm-root .pm-options{display:flex;flex-direction:column;gap:9px;margin-top:6px;}
      .pm-root .pm-opt{padding:12px 14px;border-radius:12px;border:1px solid var(--pm-border);background:rgba(255,255,255,0.03);color:#ffe9c7;font-size:14px;text-align:left;cursor:pointer;}
      .pm-root .pm-opt.correct{background:rgba(61,255,160,0.14);border-color:var(--pm-good);color:var(--pm-good);}
      .pm-root .pm-opt.wrong{background:rgba(255,95,122,0.14);border-color:var(--pm-bad);color:var(--pm-bad);}
      .pm-root .pm-opt[disabled]{cursor:default;}
      .pm-root .pm-flash-actions{display:flex;gap:10px;margin-top:16px;}
      .pm-root .pm-flash-actions button{flex:1;padding:13px 0;border-radius:14px;font-size:13.5px;font-weight:800;cursor:pointer;border:1px solid;}
      .pm-root .pm-know-no{background:rgba(255,95,122,0.12);border-color:var(--pm-bad);color:var(--pm-bad);}
      .pm-root .pm-know-yes{background:rgba(61,255,160,0.12);border-color:var(--pm-good);color:var(--pm-good);}
      .pm-root input.pm-write-input{
        width:100%;padding:13px 14px;border-radius:12px;border:1px solid var(--pm-border);
        background:rgba(0,0,0,0.25);color:#ffe9c7;font-size:15px;text-align:center;margin-top:12px;
      }
      .pm-root .pm-write-result{margin-top:10px;font-size:13px;font-weight:700;}
      .pm-root .pm-write-result.ok{color:var(--pm-good);}
      .pm-root .pm-write-result.no{color:var(--pm-bad);}
      .pm-root .pm-weak-item{background:var(--pm-panel);border:1px solid var(--pm-border);border-radius:14px;padding:14px 16px;margin-bottom:10px;text-align:left;}
      .pm-root .pm-weak-word{font-size:16px;font-weight:700;color:#ffe9c7;}
      .pm-root .pm-weak-meta{font-size:11px;color:#c9a37a;margin-top:4px;line-height:1.6;}
      .pm-root .pm-empty{text-align:center;padding:30px 10px;color:#c9a37a;font-size:13px;}
      .pm-root .pm-loading{text-align:center;padding:40px 10px;color:#c9a37a;font-size:13px;}
      .pm-root .pm-back-link{display:block;text-align:center;font-size:11.5px;color:#c9a37a;margin-top:4px;cursor:pointer;text-decoration:underline;}
    `;
    document.head.appendChild(style);
  }

  const SPEAK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/></svg>';

  /* ---------------- EKRAN: ANA SAYFA (PANEL) ---------------- */
  function poolForActiveLang(){
    return VOCAB.filter(v => v.lang === activeLang);
  }
  function poolForActiveFilter(){
    return (activeLevel === 'TÜMÜ') ? poolForActiveLang() : poolForActiveLang().filter(v=>v.level===activeLevel);
  }
  function knownCountIn(list){
    return list.filter(v=>{
      const r = getRecord(v);
      return r && r.stage >= KNOWN_STAGE;
    }).length;
  }
  function accuracyOverall(){
    let c=0,w=0;
    Object.values(wordProgress).forEach(r=>{ c+=r.correct||0; w+=r.wrong||0; });
    const tot = c+w;
    return tot>0 ? Math.round((c/tot)*100) : null;
  }
  function categoryAccuracy(){
    const byCat = {};
    Object.values(wordProgress).forEach(r=>{
      const cat = r.cat || '—';
      byCat[cat] = byCat[cat] || {c:0,w:0};
      byCat[cat].c += r.correct||0; byCat[cat].w += r.wrong||0;
    });
    let best=null,worst=null;
    Object.keys(byCat).forEach(cat=>{
      const tot = byCat[cat].c+byCat[cat].w;
      if(tot < 3) return; // yeterli veri yoksa dahil etme
      const acc = byCat[cat].c/tot;
      if(!best || acc>best.acc) best = {cat, acc};
      if(!worst || acc<worst.acc) worst = {cat, acc};
    });
    return {best, worst};
  }

  function renderHome(){
    injectStyles();
    if(!dataLoaded){
      root.innerHTML = `<div class="pm-root"><div class="pm-loading">Kişisel alan yükleniyor…</div></div>`;
      return;
    }
    const L = LANGS[activeLang];
    const filterPool = poolForActiveFilter();
    const filterKnown = knownCountIn(filterPool);
    const filterPct = filterPool.length ? Math.round((filterKnown/filterPool.length)*100) : 0;
    const today = meta.todayCount||0;
    const goal = meta.dailyGoal||DEFAULT_DAILY_GOAL;
    const goalPct = Math.min(100, Math.round((today/goal)*100));
    const acc = accuracyOverall();
    const week = weeklyCount();
    const totalKnownLang = knownCountIn(poolForActiveLang());
    const catInfo = categoryAccuracy();

    let levelRows = '';
    L.levels.forEach(lv=>{
      const list = poolForActiveLang().filter(v=>v.level===lv);
      const known = knownCountIn(list);
      const pct = list.length ? Math.round((known/list.length)*100) : 0;
      levelRows += `
        <div class="pm-level-row">
          <span>${lv}</span>
          <div class="pm-bar"><div class="pm-bar-fill" style="width:${pct}%"></div></div>
          <span>${pct}%</span>
        </div>`;
    });

    let badgeRow = '';
    BADGE_THRESHOLDS.forEach(t=>{
      const earned = meta.badges && meta.badges[t];
      badgeRow += `<div class="pm-badge ${earned?'':'locked'}" title="${t} kelime">${earned?'🏅':'🔒'}</div>`;
    });

    root.innerHTML = `
      <div class="pm-root">
        <div class="pm-head">
          <div class="pm-eyebrow">Kişisel Öğrenme Alanı</div>
          <div class="pm-title">👤 ${escapeHtml(currentName)}'e Özel</div>
          <div class="pm-sub">${L.native} öğrenimi — ilerlemen tüm cihazlarında senkron</div>
          <div class="pm-mini-select" id="pmLangSelect">
            ${Object.keys(LANGS).map(code=>`<div class="pm-chip ${code===activeLang?'active':''}" data-lang="${code}">${LANGS[code].label}</div>`).join('')}
          </div>
          <div class="pm-mini-select" id="pmLevelSelect">
            <div class="pm-chip ${activeLevel==='TÜMÜ'?'active':''}" data-level="TÜMÜ">TÜMÜ</div>
            ${L.levels.map(lv=>`<div class="pm-chip ${lv===activeLevel?'active':''}" data-level="${lv}">${lv}</div>`).join('')}
          </div>
          <div class="pm-pill-row">
            <div class="pm-pill flame">🔥 ${meta.streak||0} günlük seri</div>
            <div class="pm-pill">⭐ Seviye ${Math.floor((meta.xp||0)/200)+1} · ${meta.xp||0} XP</div>
          </div>
          <div class="pm-goal-wrap">
            <div class="pm-goal-row"><span>Bugün</span><span>${today} / ${goal} kelime</span></div>
            <div class="pm-bar"><div class="pm-bar-fill" style="width:${goalPct}%"></div></div>
          </div>
        </div>

        <div class="pm-card">
          <h4>İlerleme — ${activeLevel} · ${filterKnown} / ${filterPool.length} kelime (%${filterPct})</h4>
          ${levelRows || '<div class="pm-empty">Bu dil için henüz seviye tanımlı değil.</div>'}
        </div>

        <div class="pm-card">
          <h4>İstatistikler</h4>
          <div class="pm-stat-grid">
            <div class="pm-stat-box"><div class="pm-stat-num">${totalKnownLang}</div><div class="pm-stat-label">Toplam öğrenilen (${L.label})</div></div>
            <div class="pm-stat-box"><div class="pm-stat-num">${today}</div><div class="pm-stat-label">Bugün öğrenilen</div></div>
            <div class="pm-stat-box"><div class="pm-stat-num">${week}</div><div class="pm-stat-label">Bu hafta çalışılan</div></div>
            <div class="pm-stat-box"><div class="pm-stat-num">${acc===null?'—':acc+'%'}</div><div class="pm-stat-label">Doğruluk oranı</div></div>
          </div>
          <div class="pm-weak-meta" style="margin-top:10px;">
            ${catInfo.best ? `💪 En güçlü kategori: <b>${escapeHtml(catInfo.best.cat)}</b>` : 'Henüz yeterli veri yok.'}<br>
            ${catInfo.worst ? `🎯 Geliştirilecek kategori: <b>${escapeHtml(catInfo.worst.cat)}</b>` : ''}
          </div>
          <div class="pm-weak-meta" id="pmTotalTime" style="margin-top:6px;">⏱ Toplam çalışma süresi yükleniyor…</div>
        </div>

        <div class="pm-card">
          <h4>Rozetler</h4>
          <div class="pm-badges">${badgeRow}</div>
        </div>

        <button class="pm-btn primary" id="pmStartBtn">🚀 Çalışmaya Başla</button>
        <button class="pm-btn small" id="pmWeakBtn">📉 Zayıf Kelimelerimi Gör</button>
      </div>
    `;

    document.querySelectorAll('#pmLangSelect .pm-chip').forEach(el=>{
      el.onclick = () => {
        activeLang = el.dataset.lang;
        activeLevel = 'TÜMÜ';
        if(typeof renderLangPair==='function') renderLangPair();
        if(typeof rebuildLevelBox==='function') rebuildLevelBox();
        if(typeof rebuildChips==='function') rebuildChips();
        if(typeof applyFilter==='function') applyFilter();
        renderHome();
      };
    });
    document.querySelectorAll('#pmLevelSelect .pm-chip').forEach(el=>{
      el.onclick = () => {
        activeLevel = el.dataset.level;
        if(typeof rebuildLevelBox==='function') rebuildLevelBox();
        if(typeof rebuildChips==='function') rebuildChips();
        if(typeof applyFilter==='function') applyFilter();
        renderHome();
      };
    });
    document.getElementById('pmStartBtn').onclick = startSession;
    document.getElementById('pmWeakBtn').onclick = renderWeakWords;

    if(window.LB_getTotalSeconds){
      window.LB_getTotalSeconds(currentName, (secs)=>{
        const el = document.getElementById('pmTotalTime');
        if(!el) return;
        const s = Math.floor(secs);
        const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
        el.textContent = `⏱ Toplam çalışma süresi: ${h>0?h+'s ':''}${m}dk`;
      });
    }
  }

  /* ---------------- ÇALIŞMA KUYRUĞU ---------------- */
  function buildSessionQueue(){
    const now = Date.now();
    const pool = poolForActiveFilter();
    const due = [], fresh = [];
    pool.forEach(v=>{
      const key = wordKeyFor(v);
      const rec = wordProgress[key];
      if(rec){ if(rec.dueAt <= now) due.push({v,key}); }
      else fresh.push({v,key});
    });
    due.sort((a,b)=> (wordProgress[a.key].dueAt) - (wordProgress[b.key].dueAt));
    const remainingGoal = Math.max(0, (meta.dailyGoal||DEFAULT_DAILY_GOAL) - (meta.todayCount||0));
    let newCap;
    if(due.length === 0 && remainingGoal === 0) newCap = Math.min(fresh.length, 10);
    else newCap = Math.min(fresh.length, Math.max(remainingGoal, 0));
    shuffle(fresh);
    return due.concat(fresh.slice(0, newCap));
  }

  function startSession(){
    sessionQueue = buildSessionQueue();
    sessionIdx = 0;
    comboStreak = 0;
    sessionStats = { total:0, correct:0, wrong:0, xp:0, newBadges:[], mistakes:[] };
    if(sessionQueue.length === 0){
      root.innerHTML = `
        <div class="pm-root">
          <div class="pm-empty">
            🎉 Şu an tekrar edilecek kelime yok — harika iş çıkardın!<br><br>
            Hazır olduğunda yeni kelimelerle serbest bir tur çalışabilirsin.
          </div>
          <button class="pm-btn primary" id="pmFreeStudyBtn">Yeni Kelimelerle Çalış</button>
          <span class="pm-back-link" id="pmBackHome">← Ana sayfaya dön</span>
        </div>`;
      document.getElementById('pmBackHome').onclick = renderHome;
      document.getElementById('pmFreeStudyBtn').onclick = () => {
        const pool = poolForActiveFilter();
        const fresh = pool.filter(v=>!wordProgress[wordKeyFor(v)]).map(v=>({v,key:wordKeyFor(v)}));
        shuffle(fresh);
        sessionQueue = fresh.slice(0,10);
        sessionIdx = 0;
        if(sessionQueue.length===0){
          root.innerHTML = `<div class="pm-root"><div class="pm-empty">Bu seviyede tüm kelimeler zaten öğrenilmiş durumda! 🎉</div><span class="pm-back-link" id="pmBackHome2">← Ana sayfaya dön</span></div>`;
          document.getElementById('pmBackHome2').onclick = renderHome;
          return;
        }
        renderStudyCard();
      };
      return;
    }
    renderStudyCard();
  }

  function renderStudyCard(){
    if(sessionIdx >= sessionQueue.length){ renderSessionSummary(); return; }
    const item = sessionQueue[sessionIdx];
    const rec = wordProgress[item.key];
    const stage = rec ? rec.stage : 0;
    const mode = modeForStage(stage);
    currentAnswered = false;

    const progressPct = Math.round(((sessionIdx)/sessionQueue.length)*100);
    const barHtml = `
      <div class="pm-session-bar"><span>Kelime ${sessionIdx+1} / ${sessionQueue.length}</span><span>${sessionStats.correct} doğru</span></div>
      <div class="pm-bar" style="margin-bottom:14px;"><div class="pm-bar-fill" style="width:${progressPct}%"></div></div>
    `;

    if(mode === 'flash') renderFlash(item, barHtml);
    else if(mode === 'mc') renderMC(item, barHtml);
    else if(mode === 'listen') renderListen(item, barHtml);
    else if(mode === 'blank') renderBlank(item, barHtml);
    else renderWrite(item, barHtml);
  }

  function pickDistractors(v, count){
    let pool = poolForActiveFilter().filter(x=>x.w!==v.w);
    if(pool.length < count) pool = VOCAB.filter(x=>x.lang===v.lang && x.w!==v.w);
    shuffle(pool);
    return pool.slice(0,count);
  }

  function renderFlash(item, barHtml){
    const v = item.v;
    root.innerHTML = `
      <div class="pm-root">
        ${barHtml}
        <div class="pm-study-card">
          <div class="pm-mode-tag">Flash Kart</div>
          <div class="pm-word" dir="${LANGS[v.lang].dir}">${escapeHtml(v.w)}</div>
          <div class="pm-word-sub">${escapeHtml(v.pos||'')}</div>
          <div class="pm-speak-btn" id="pmSpeakBtn">${SPEAK_ICON}</div>
          <div id="pmFlashBack" style="display:none;margin-top:14px;">
            <div class="pm-word" style="font-size:20px;color:var(--pm-accent);">${escapeHtml(v.tr)}</div>
          </div>
        </div>
        <button class="pm-btn primary" id="pmRevealBtn">Cevabı Gör</button>
        <div class="pm-flash-actions" id="pmFlashActions" style="display:none;">
          <button class="pm-know-no" id="pmKnowNo">❌ Bilmiyorum</button>
          <button class="pm-know-yes" id="pmKnowYes">✅ Biliyorum</button>
        </div>
      </div>
    `;
    document.getElementById('pmSpeakBtn').onclick = () => pmSpeak(v.w, LANGS[v.lang].voice);
    document.getElementById('pmRevealBtn').onclick = () => {
      document.getElementById('pmFlashBack').style.display = 'block';
      document.getElementById('pmFlashActions').style.display = 'flex';
      document.getElementById('pmRevealBtn').style.display = 'none';
      pmSpeak(v.w, LANGS[v.lang].voice);
    };
    document.getElementById('pmKnowNo').onclick = () => answerCurrent(item, false);
    document.getElementById('pmKnowYes').onclick = () => answerCurrent(item, true);
  }

  function renderMC(item, barHtml){
    const v = item.v;
    const distractors = pickDistractors(v, 3);
    const opts = shuffle([v.tr, ...distractors.map(d=>d.tr)]);
    root.innerHTML = `
      <div class="pm-root">
        ${barHtml}
        <div class="pm-study-card">
          <div class="pm-mode-tag">Çoktan Seçmeli</div>
          <div class="pm-word" dir="${LANGS[v.lang].dir}">${escapeHtml(v.w)}</div>
          <div class="pm-word-sub">${escapeHtml(v.pos||'')} · bu kelimenin anlamı nedir?</div>
          <div class="pm-speak-btn" id="pmSpeakBtn">${SPEAK_ICON}</div>
        </div>
        <div class="pm-options" id="pmOptions"></div>
      </div>
    `;
    document.getElementById('pmSpeakBtn').onclick = () => pmSpeak(v.w, LANGS[v.lang].voice);
    const wrap = document.getElementById('pmOptions');
    opts.forEach(o=>{
      const b = document.createElement('button');
      b.className = 'pm-opt'; b.textContent = o;
      b.onclick = () => resolveOption(item, o, v.tr, b);
      wrap.appendChild(b);
    });
    pmSpeak(v.w, LANGS[v.lang].voice);
  }

  function renderListen(item, barHtml){
    const v = item.v;
    const distractors = pickDistractors(v, 3);
    const opts = shuffle([v.w, ...distractors.map(d=>d.w)]);
    root.innerHTML = `
      <div class="pm-root">
        ${barHtml}
        <div class="pm-study-card">
          <div class="pm-mode-tag">Dinle ve Seç</div>
          <div class="pm-word-sub">Türkçesi: <b>${escapeHtml(v.tr)}</b></div>
          <div style="margin-top:14px;display:flex;justify-content:center;gap:10px;">
            <div class="pm-speak-btn" id="pmSpeakBtn" title="Normal hızda dinle">${SPEAK_ICON}</div>
            <div class="pm-speak-btn" id="pmSpeakSlowBtn" title="Yavaş dinle">🐢</div>
          </div>
        </div>
        <div class="pm-options" id="pmOptions"></div>
      </div>
    `;
    document.getElementById('pmSpeakBtn').onclick = () => pmSpeak(v.w, LANGS[v.lang].voice);
    document.getElementById('pmSpeakSlowBtn').onclick = () => pmSpeak(v.w, LANGS[v.lang].voice, 0.55);
    const wrap = document.getElementById('pmOptions');
    opts.forEach(o=>{
      const b = document.createElement('button');
      b.className = 'pm-opt'; b.setAttribute('dir', LANGS[v.lang].dir); b.textContent = o;
      b.onclick = () => resolveOption(item, o, v.w, b);
      wrap.appendChild(b);
    });
    pmSpeak(v.w, LANGS[v.lang].voice);
  }

  function renderBlank(item, barHtml){
    const v = item.v;
    let blankSentence = v.ex || '';
    if(v.ex && typeof findStemMatch === 'function'){
      const range = findStemMatch(v.ex, v.w);
      if(range) blankSentence = v.ex.slice(0,range.start) + '____' + v.ex.slice(range.end);
    }
    const distractors = pickDistractors(v, 3);
    const opts = shuffle([v.w, ...distractors.map(d=>d.w)]);
    root.innerHTML = `
      <div class="pm-root">
        ${barHtml}
        <div class="pm-study-card">
          <div class="pm-mode-tag">Boşluk Doldurma</div>
          <div class="pm-blank-sentence" dir="${LANGS[v.lang].dir}">${escapeHtml(blankSentence)}</div>
          ${v.exTr ? `<div class="pm-blank-hint">💬 ${escapeHtml(v.exTr)}</div>` : ''}
        </div>
        <div class="pm-options" id="pmOptions"></div>
      </div>
    `;
    const wrap = document.getElementById('pmOptions');
    opts.forEach(o=>{
      const b = document.createElement('button');
      b.className = 'pm-opt'; b.setAttribute('dir', LANGS[v.lang].dir); b.textContent = o;
      b.onclick = () => resolveOption(item, o, v.w, b);
      wrap.appendChild(b);
    });
  }

  function renderWrite(item, barHtml){
    const v = item.v;
    root.innerHTML = `
      <div class="pm-root">
        ${barHtml}
        <div class="pm-study-card">
          <div class="pm-mode-tag">Yazma Testi</div>
          <div class="pm-word-sub">Türkçesi:</div>
          <div class="pm-word" style="font-size:22px;">${escapeHtml(v.tr)}</div>
          <div class="pm-word-sub">${LANGS[v.lang].native} olarak yaz</div>
          <input type="text" class="pm-write-input" id="pmWriteInput" placeholder="Cevabını yaz..." dir="${LANGS[v.lang].dir}" autocomplete="off" autocapitalize="off" spellcheck="false">
          <div class="pm-write-result" id="pmWriteResult"></div>
        </div>
        <button class="pm-btn primary" id="pmCheckBtn">Kontrol Et</button>
      </div>
    `;
    const input = document.getElementById('pmWriteInput');
    input.focus();
    function doCheck(){
      if(currentAnswered) return;
      currentAnswered = true;
      const clean = s => (typeof normalizeWord==='function' ? normalizeWord(String(s)) : String(s)).toLowerCase().trim().replace(/[.,!?]/g,'');
      const correct = clean(input.value) === clean(v.w);
      const resEl = document.getElementById('pmWriteResult');
      input.disabled = true;
      if(correct){
        resEl.textContent = '✅ Doğru!'; resEl.className = 'pm-write-result ok';
      } else {
        resEl.textContent = `❌ Doğrusu: ${v.w}`; resEl.className = 'pm-write-result no';
      }
      document.getElementById('pmCheckBtn').textContent = 'Devam Et →';
      setTimeout(()=>{ answerCurrent(item, correct); }, 250);
    }
    document.getElementById('pmCheckBtn').onclick = () => {
      if(!currentAnswered) doCheck(); else renderStudyCard();
    };
    input.addEventListener('keydown', e => { if(e.key==='Enter') doCheck(); });
  }

  function resolveOption(item, chosen, correctText, btnEl){
    if(currentAnswered) return;
    currentAnswered = true;
    const correct = chosen === correctText;
    document.querySelectorAll('#pmOptions .pm-opt').forEach(b=>{
      b.disabled = true;
      if(b.textContent === correctText) b.classList.add('correct');
      else if(b === btnEl) b.classList.add('wrong');
    });
    setTimeout(()=> answerCurrent(item, correct), 700);
  }

  function answerCurrent(item, correct){
    const v = item.v;
    const key = item.key;
    const now = Date.now();
    let rec = wordProgress[key] || { seen:0, correct:0, wrong:0, stage:0, dueAt:0, lastSeen:0, lang:v.lang, level:v.level, cat:v.cat };
    rec.seen = (rec.seen||0) + 1;
    if(correct){
      rec.correct = (rec.correct||0)+1;
      rec.stage = stageOnCorrect(rec.stage||0);
      comboStreak++;
    } else {
      rec.wrong = (rec.wrong||0)+1;
      rec.stage = stageOnWrong(rec.stage||0);
      comboStreak = 0;
      sessionStats.mistakes.push({ word:v.w, tr:v.tr });
    }
    rec.lastSeen = now;
    rec.dueAt = now + STAGE_MS[rec.stage];
    persistWordRecord(key, rec);

    meta.todayCount = (meta.todayCount||0) + 1;
    markStudyToday();
    let xpGain = 0;
    if(correct){ xpGain = 10 + Math.min(comboStreak*2, 20); meta.xp = (meta.xp||0) + xpGain; }
    persistMeta();
    checkBadges();

    sessionStats.total++;
    if(correct) sessionStats.correct++; else sessionStats.wrong++;
    sessionStats.xp += xpGain;

    sessionIdx++;
    renderStudyCard();
  }

  function renderSessionSummary(){
    const s = sessionStats;
    root.innerHTML = `
      <div class="pm-root">
        <div class="pm-head">
          <div class="pm-eyebrow">Oturum Tamamlandı</div>
          <div class="pm-title">🎉 Harika İş!</div>
          <div class="pm-sub">${s.correct} / ${s.total} doğru · +${s.xp} XP</div>
        </div>
        ${s.newBadges.length ? `<div class="pm-card"><h4>Yeni Rozetler</h4><div class="pm-weak-meta">${s.newBadges.map(t=>`🏅 ${t} kelime rozeti`).join('<br>')}</div></div>` : ''}
        ${s.mistakes.length ? `<button class="pm-btn small" id="pmSeeMistakes">Bu Oturumdaki Hatalarını Gör (${s.mistakes.length})</button>` : ''}
        <button class="pm-btn primary" id="pmBackHomeBtn">Ana Sayfaya Dön</button>
      </div>
    `;
    document.getElementById('pmBackHomeBtn').onclick = renderHome;
    if(s.mistakes.length){
      document.getElementById('pmSeeMistakes').onclick = () => {
        root.innerHTML = `
          <div class="pm-root">
            <div class="pm-head"><div class="pm-title">Bu Oturumdaki Hataların</div></div>
            ${s.mistakes.map(m=>`
              <div class="pm-weak-item">
                <div class="pm-weak-word">${escapeHtml(m.word)}</div>
                <div class="pm-weak-meta">Doğrusu: ${escapeHtml(m.tr)}</div>
              </div>`).join('')}
            <button class="pm-btn primary" id="pmBackSummary">Geri Dön</button>
          </div>`;
        document.getElementById('pmBackSummary').onclick = renderSessionSummary;
      };
    }
  }

  /* ---------------- ZAYIF KELİMELER ---------------- */
  function renderWeakWords(){
    const entries = Object.keys(wordProgress)
      .map(k=>({key:k, rec:wordProgress[k]}))
      .filter(e => e.rec.lang === activeLang && (e.rec.seen||0) > 0)
      .map(e=>{
        const tot = (e.rec.correct||0)+(e.rec.wrong||0);
        const acc = tot>0 ? (e.rec.correct||0)/tot : 0;
        return Object.assign(e, {acc, tot});
      })
      .sort((a,b)=> a.acc - b.acc)
      .slice(0, 20);

    // orijinal kelime metnini bulmak için VOCAB'da eşleştir
    const lookup = {};
    VOCAB.forEach(v=>{ lookup[wordKeyFor(v)] = v; });

    root.innerHTML = `
      <div class="pm-root">
        <div class="pm-head"><div class="pm-title">📉 Zayıf Kelimelerin</div><div class="pm-sub">En çok zorlandığın 20 kelime</div></div>
        ${entries.length===0 ? '<div class="pm-empty">Henüz yeterli veri yok — birkaç oturum çalıştıktan sonra burada görünecekler.</div>' : entries.map(e=>{
          const v = lookup[e.key];
          if(!v) return '';
          const last = e.rec.lastSeen ? new Date(e.rec.lastSeen).toLocaleDateString('tr-TR') : '—';
          const learnPct = Math.round((Math.min(e.rec.stage,KNOWN_STAGE)/KNOWN_STAGE)*100);
          return `
            <div class="pm-weak-item">
              <div class="pm-weak-word" dir="${LANGS[v.lang].dir}">${escapeHtml(v.w)} <span style="color:var(--pm-accent);font-size:12px;">— ${escapeHtml(v.tr)}</span></div>
              <div class="pm-weak-meta">
                👁 Görülme: ${e.rec.seen||0} · ✅ Doğru: ${e.rec.correct||0} · ❌ Yanlış: ${e.rec.wrong||0}<br>
                📅 Son tekrar: ${last} · 📈 Öğrenme: %${learnPct}
              </div>
            </div>`;
        }).join('')}
        <button class="pm-btn primary" id="pmBackHomeBtn2">Ana Sayfaya Dön</button>
      </div>
    `;
    document.getElementById('pmBackHomeBtn2').onclick = renderHome;
  }

  /* ---------------- GİRİŞ NOKTASI ---------------- */
  function openPersonalMode(){
    if(!root) return; // index.html eski kalmış olabilir — sessizce çık, sayfanın geri kalanını bozma
    injectStyles();
    const name = window.LB_getUserName ? window.LB_getUserName() : '';
    if(!name){
      root.innerHTML = `
        <div class="pm-root">
          <div class="pm-empty">
            Kişisel alanı kullanmak için önce adını girmen gerekiyor.
          </div>
          <button class="pm-btn primary" id="pmAskNameBtn">Adımı Gir</button>
        </div>`;
      document.getElementById('pmAskNameBtn').onclick = () => { if(window.LB_checkName) window.LB_checkName(); };
      return;
    }
    if(dataLoaded && currentName === name){
      renderHome();
      return;
    }
    root.innerHTML = `<div class="pm-root"><div class="pm-loading">Kişisel alan yükleniyor…</div></div>`;
    loadUserData(name, renderHome);
  }

  // İsim splash modalında girildiğinde (leaderboard.js tetikler) — eğer
  // kullanıcı o an Kişisel sekmesindeyse verileri hemen yükle.
  window.LB_onNameReady = function(name){
    if(root && root.style.display !== 'none'){
      loadUserData(name, renderHome);
    }
  };

  window.PM_open = openPersonalMode;
})();