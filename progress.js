/* ================================================================
   PROGRESS.JS - "Kişisel Mod": isme özel ilerleme takibi (v2)
   - Bir kelime quiz'de doğru cevaplanınca bilindiği varsayılır, bir
     daha normal çalışmada karşımıza çıkmaz (self-report yalanı yok).
   - Çalışmaya Başla: aynı kategoriden 10 kelime -> kart (tanışma) ->
     yazılı quiz -> dinleme quizi. İki turda da doğruysa bilinir;
     yanlışsa bir sonraki değil ondan sonraki oturumda tekrar çıkar.
   - Genel Tekrar: seviye grubunda (A1-A2/B1-B2) bilinen kelimeleri
     tekrar sorar; yanlışsa bilinmiyor listesine geri düşer.
   - Görevler + XP sistemi, günlük tekrar kuyruğu (dün öğrenilenler).
================================================================ */
(function(){

  const BADGE_THRESHOLDS = [50, 100, 250, 500, 1000];
  const DEFAULT_DAILY_GOAL = 100;
  const BATCH_SIZE = 10;
  const RETRY_SESSION_GAP = 1; // 1: hemen bir sonraki oturumu atlar, ondan sonraki oturumda tekrar çıkar
  const XP_PER_NEW_WORD = 3;
  const TASK_XP = { t1:25, t2:100, t3:300, t5:200 };
  const TASK5_SECONDS = 60*60;

  let currentName = '';
  let currentKey = '';
  let dataLoaded = false;
  let wordProgress = {};
  let meta = null;

  let batch = [];
  let batchResult = {};
  let cardIdx = 0, quizIdx = 0, listenIdx = 0;
  let quizOrder = [], listenOrder = [];
  let sessionStats = { total:0, correct:0, wrong:0, xp:0, newKnown:0, newBadges:[], mistakes:[] };
  let currentAnswered = false;
  let reviewMode = null;

  const root = document.getElementById('personalView');

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
    return {
      xp:0, streak:0, lastStudyDate:null, todayDate:null, todayCount:0,
      dailyGoal:DEFAULT_DAILY_GOAL, badges:{}, dailyCounts:{},
      studySessionCount:0,
      tasksDate:null, tasks:{t1:false,t2:false,t3:false,t4:false,t5:false},
      lastDueCount:0
    };
  }
  function wordKeyFor(v){
    const raw = v.lang+'_'+v.level+'_'+v.w;
    return raw.toLowerCase()
      .replace(/[.#$\[\]\/\s]+/g,'_')
      .replace(/[^a-z0-9_aoubcdefghijklmnopqrstuvwxyz]/gi,'_')
      .slice(0,120);
  }
  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function shuffle(arr){
    for(let i=arr.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; }
    return arr;
  }
  function pmSpeak(text, langCode, slow){
    if(typeof soundOn !== 'undefined' && !soundOn) return;
    try{
      if(slow && typeof speakSlow === 'function'){ speakSlow(text, langCode); return; }
      if(typeof speak === 'function'){ speak(text, langCode); return; }
    }catch(e){}
  }

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
    if(!meta.tasks) meta.tasks = {t1:false,t2:false,t3:false,t4:false,t5:false};
    ensureDailyRollover();
    persistLocalMirror();
    dataLoaded = true;
    if(cb) cb();
  }
  function persistLocalMirror(){
    safeLocalSet('pm_data_'+currentKey, { words: wordProgress, meta: meta });
  }
  function persistMeta(){
    persistLocalMirror();
    const ref = dbRef('progress/'+currentKey+'/meta');
    if(ref) ref.set(meta).catch(()=>{});
  }
  function ensureDailyRollover(){
    const t = todayStr();
    if(meta.todayDate !== t){ meta.todayDate = t; meta.todayCount = 0; }
    if(meta.tasksDate !== t){ meta.tasksDate = t; meta.tasks = {t1:false,t2:false,t3:false,t4:false,t5:false}; }
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
    while(keys.length > 30){ delete meta.dailyCounts[keys.shift()]; }
  }
  function checkBadges(){
    const known = Object.values(wordProgress).filter(r=>r.known).length;
    BADGE_THRESHOLDS.forEach(t=>{
      if(known>=t && !(meta.badges && meta.badges[t])){
        meta.badges = meta.badges || {};
        meta.badges[t] = true;
        sessionStats.newBadges.push(t);
        showToast('Rozet kazandın: '+t+' kelime öğrenildi!');
      }
    });
  }
  function addXp(amount, reason){
    if(amount <= 0) return;
    meta.xp = (meta.xp||0) + amount;
    if(reason) showToast('+'+amount+' XP - '+reason);
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
    t.style.cssText = 'background:linear-gradient(135deg,#1a1235,#0a0715);border:1px solid rgba(79,232,255,0.6);color:#eef4ff;padding:10px 18px;border-radius:999px;font-size:13px;font-weight:700;box-shadow:0 6px 22px rgba(0,0,0,0.4),0 0 18px rgba(79,232,255,0.3);opacity:0;transform:translateY(-8px);transition:opacity .35s ease, transform .35s ease;';
    layer.appendChild(t);
    requestAnimationFrame(()=>{ t.style.opacity='1'; t.style.transform='translateY(0)'; });
    setTimeout(()=>{
      t.style.opacity='0'; t.style.transform='translateY(-8px)';
      setTimeout(()=>t.remove(), 400);
    }, 3200);
  }
  function getRecord(v){ return wordProgress[wordKeyFor(v)] || null; }

  function checkThresholdTasks(){
    const t = meta.todayCount||0;
    if(t>=10 && !meta.tasks.t1){ meta.tasks.t1 = true; addXp(TASK_XP.t1, 'Görev: bugün 10 yeni kelime'); }
    if(t>=50 && !meta.tasks.t2){ meta.tasks.t2 = true; addXp(TASK_XP.t2, 'Görev: bugün 50 yeni kelime'); }
    if(t>=100 && !meta.tasks.t3){ meta.tasks.t3 = true; addXp(TASK_XP.t3, 'Görev: bugün 100 yeni kelime'); }
  }
  function checkTask5(){
    if(meta.tasks.t5) return;
    const secs = (window.APP_getActiveSeconds ? window.APP_getActiveSeconds() : 0);
    if(secs >= TASK5_SECONDS){
      meta.tasks.t5 = true; addXp(TASK_XP.t5, 'Görev: 60dk çalışma');
      persistMeta();
    }
  }
  function awardTask4(reviewedCount){
    if(meta.tasks.t4 || reviewedCount<=0) return;
    meta.tasks.t4 = true;
    addXp(reviewedCount*2, 'Görev: günlük tekrarı tamamla');
  }

  function levelGroups(){
    const levels = LANGS[activeLang].levels;
    const groups = [];
    for(let i=0;i<levels.length;i+=2){
      const chunk = levels.slice(i, i+2);
      groups.push({ name: chunk.join('-'), levels: chunk });
    }
    return groups;
  }

  function poolForActiveLang(){ return VOCAB.filter(v => v.lang === activeLang); }
  function poolForActiveFilter(){
    return (activeLevel === 'TUMU' || activeLevel === 'TÜMÜ') ? poolForActiveLang() : poolForActiveLang().filter(v=>v.level===activeLevel);
  }
  function knownCountIn(list){
    return list.filter(v=>{ const r=getRecord(v); return r && r.known; }).length;
  }
  function totalStudiedCount(){
    return Object.values(wordProgress).filter(r=>(r.seen||0) > 0).length;
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
      const cat = r.cat || '-';
      byCat[cat] = byCat[cat] || {c:0,w:0};
      byCat[cat].c += r.correct||0; byCat[cat].w += r.wrong||0;
    });
    let best=null,worst=null;
    Object.keys(byCat).forEach(cat=>{
      const tot = byCat[cat].c+byCat[cat].w;
      if(tot < 3) return;
      const acc = byCat[cat].c/tot;
      if(!best || acc>best.acc) best = {cat, acc};
      if(!worst || acc<worst.acc) worst = {cat, acc};
    });
    return {best, worst};
  }
  // ESKİ (dahili) mekanik: bir çalışma oturumunda yanlış yapılan kelimeler,
  // bir sonraki oturumu atlayıp ondan sonraki oturumda normal çalışma
  // havuzuna geri döner. Bu, kullanıcıya AYRI bir "kuyruk" olarak GÖSTERİLMEZ,
  // sadece pickBatch() içinde sessizce çalışır.
  function sessionRetryDueWords(){
    const pool = poolForActiveFilter();
    const out = [];
    pool.forEach(v=>{
      const r = getRecord(v);
      if(r && !r.known && r.retryAfterSession != null && r.retryAfterSession <= meta.studySessionCount){
        out.push(v);
      }
    });
    return out;
  }
  // YENİ Günlük Tekrar: DÜN öğrenilmiş (bilinen işaretlenmiş) kelimeleri bugün
  // tekrar sormak için. Aktif dile göre (seviye filtresinden bağımsız).
  function yesterdayStr(){
    const d = new Date();
    d.setDate(d.getDate()-1);
    const p = n => String(n).padStart(2,'0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
  }
  function dailyReviewWords(){
    const y = yesterdayStr();
    return poolForActiveLang().filter(v=>{
      const r = getRecord(v);
      return r && r.known && r.learnedDate === y;
    });
  }

  function injectStyles(){
    if(document.getElementById('pmStyles')) return;
    const style = document.createElement('style');
    style.id = 'pmStyles';
    style.textContent = `
      .pm-root{
        --pm-accent:#4fe8ff; --pm-accent2:#ff5fb8; --pm-accent3:#9b7bff; --pm-good:#3dffa0; --pm-bad:#ff5f7a;
        --pm-panel: linear-gradient(160deg, rgba(18,14,38,0.38), rgba(10,8,22,0.42));
        --pm-border: rgba(79,232,255,0.35);
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      }
      .pm-root .pm-head{
        text-align:center;padding:18px 14px 22px;border-radius:22px;margin-bottom:16px;
        background: radial-gradient(circle at 50% -10%, rgba(79,232,255,0.16), transparent 60%), var(--pm-panel);
        border:1px solid var(--pm-border);
        box-shadow:0 8px 30px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(79,232,255,0.12);
      }
      .pm-root .pm-eyebrow{font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--pm-accent);margin-bottom:6px;}
      .pm-root .pm-title{font-family:Georgia,'Iowan Old Style',serif;font-size:22px;font-weight:700;color:#eef4ff;margin-bottom:2px;}
      .pm-root .pm-sub{font-size:11.5px;color:#8291b3;}
      .pm-root .pm-pill-row{display:flex;gap:6px;justify-content:center;flex-wrap:wrap;margin-top:14px;}
      .pm-root .pm-pill{padding:6px 12px;border-radius:999px;font-size:11.5px;font-weight:700;background:rgba(79,232,255,0.1);border:1px solid var(--pm-border);color:#eef4ff;}
      .pm-root .pm-pill.flame{background:rgba(255,95,184,0.14);border-color:rgba(255,95,184,0.4);}
      .pm-root .pm-mini-select{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-top:14px;}
      .pm-root .pm-chip{padding:6px 11px;border-radius:10px;font-size:11.5px;font-weight:700;color:#8291b3;background:rgba(255,255,255,0.03);border:1px solid rgba(79,232,255,0.18);cursor:pointer;}
      .pm-root .pm-chip.active{
        color:#0a0715;
        background:linear-gradient(120deg,var(--pm-accent),var(--pm-accent3),var(--pm-accent2));
        background-size:250% 250%;
        animation:pmNeonShift 6s ease-in-out infinite;
        border-color:transparent;
        box-shadow:0 0 14px rgba(79,232,255,0.35);
      }
      .pm-root .pm-goal-wrap{margin-top:14px;text-align:left;}
      .pm-root .pm-goal-row{display:flex;justify-content:space-between;font-size:11px;color:#8291b3;margin-bottom:5px;}
      .pm-root .pm-bar{height:6px;border-radius:6px;background:rgba(255,255,255,0.08);overflow:hidden;}
      .pm-root .pm-bar-fill{height:100%;background:linear-gradient(90deg,var(--pm-accent),var(--pm-accent2));transition:width .3s ease;}
      .pm-root .pm-card{
        background:var(--pm-panel);border:1px solid var(--pm-border);border-radius:18px;padding:16px;margin-bottom:12px;
        box-shadow:0 6px 22px rgba(0,0,0,0.3);
      }
      .pm-root .pm-card h4{margin:0 0 10px;font-size:12.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--pm-accent);}
      .pm-root .pm-level-row{display:flex;justify-content:space-between;align-items:center;font-size:12.5px;color:#eef4ff;margin-bottom:8px;}
      .pm-root .pm-level-row .pm-bar{flex:1;margin:0 10px;}
      .pm-root .pm-stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
      .pm-root .pm-stat-box{background:rgba(255,255,255,0.03);border:1px solid rgba(79,232,255,0.14);border-radius:12px;padding:10px 12px;}
      .pm-root .pm-stat-num{font-size:19px;font-weight:800;color:#eef4ff;font-family:Georgia,serif;}
      .pm-root .pm-stat-label{font-size:10.5px;color:#8291b3;margin-top:2px;}
      .pm-root .pm-badges{display:flex;gap:8px;flex-wrap:wrap;}
      .pm-root .pm-badge{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;background:rgba(79,232,255,0.12);border:1px solid var(--pm-border);}
      .pm-root .pm-badge.locked{opacity:.25;filter:grayscale(1);}
      .pm-root .pm-task{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid rgba(79,232,255,0.12);}
      .pm-root .pm-task:last-child{border-bottom:none;}
      .pm-root .pm-task-icon{font-size:16px;width:22px;text-align:center;flex-shrink:0;}
      .pm-root .pm-task-body{flex:1;min-width:0;}
      .pm-root .pm-task-label{font-size:12.5px;color:#eef4ff;}
      .pm-root .pm-task-sub{font-size:10.5px;color:#8291b3;margin-top:2px;}
      .pm-root .pm-task.done .pm-task-label{color:var(--pm-good);text-decoration:line-through;opacity:.8;}
      .pm-root .pm-due-banner{
        display:flex;justify-content:space-between;align-items:center;gap:10px;
        background:rgba(255,95,122,0.1);border:1px solid rgba(255,95,122,0.4);border-radius:14px;padding:12px 14px;margin-bottom:12px;
      }
      .pm-root .pm-due-banner .pm-due-text{font-size:12.5px;color:#ffd2d9;}
      .pm-root .pm-due-banner button{flex-shrink:0;padding:8px 14px;border-radius:10px;border:1px solid rgba(255,95,122,0.5);background:rgba(255,95,122,0.18);color:#ffd2d9;font-size:12px;font-weight:700;cursor:pointer;}
      .pm-root .pm-group-row{display:flex;gap:8px;margin-top:8px;}
      .pm-root .pm-group-btn{flex:1;padding:12px 6px;border-radius:12px;text-align:center;background:rgba(255,255,255,0.03);border:1px solid var(--pm-border);color:#eef4ff;font-size:12.5px;font-weight:700;cursor:pointer;}
      .pm-root .pm-group-btn .g-count{display:block;font-size:10px;color:#8291b3;font-weight:400;margin-top:2px;}
      .pm-root button.pm-btn{
        width:100%;padding:14px 0;border-radius:14px;border:1px solid var(--pm-border);
        background:rgba(255,255,255,0.03);color:#eef4ff;font-size:14px;font-weight:700;cursor:pointer;margin-bottom:10px;
      }
      .pm-root button.pm-btn.primary{
        position:relative;overflow:hidden;
        background:linear-gradient(120deg, var(--pm-accent), var(--pm-accent3), var(--pm-accent2), var(--pm-accent));
        background-size:300% 300%;
        animation:pmNeonShift 5s ease-in-out infinite;
        color:#04050a;border:none;font-weight:800;
        box-shadow:0 6px 24px rgba(79,232,255,0.35), 0 0 34px rgba(255,95,184,0.28);
      }
      @keyframes pmNeonShift{
        0%{background-position:0% 50%;}
        50%{background-position:100% 50%;}
        100%{background-position:0% 50%;}
      }
      .pm-root button.pm-btn:active{opacity:.7;transform:scale(.98);}
      .pm-root button.pm-btn.small{padding:10px 0;font-size:12.5px;}
      .pm-root .pm-session-bar{display:flex;justify-content:space-between;font-size:11.5px;color:#8291b3;margin-bottom:8px;}
      .pm-root .pm-study-card{
        background:var(--pm-panel);border:1px solid var(--pm-border);border-radius:20px;padding:26px 20px;text-align:center;margin-bottom:16px;
        box-shadow:0 10px 30px rgba(0,0,0,0.35);cursor:pointer;
      }
      .pm-root .pm-mode-tag{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--pm-accent);margin-bottom:10px;}
      .pm-root .pm-word{font-size:27px;font-weight:700;font-family:Georgia,'Iowan Old Style',serif;color:#eef4ff;margin-bottom:6px;}
      .pm-root .pm-word-sub{font-size:12px;color:#8291b3;margin-bottom:8px;}
      .pm-root .pm-speak-row{display:flex;justify-content:center;gap:10px;margin:10px 0 4px;}
      .pm-root .pm-speak-btn{
        display:inline-flex;align-items:center;justify-content:center;width:42px;height:42px;border-radius:50%;font-size:19px;
        background:rgba(79,232,255,0.14);border:1px solid var(--pm-border);cursor:pointer;
      }
      .pm-root .pm-options{display:flex;flex-direction:column;gap:9px;margin-top:6px;}
      .pm-root .pm-opt{padding:12px 14px;border-radius:12px;border:1px solid var(--pm-border);background:rgba(255,255,255,0.03);color:#eef4ff;font-size:14px;text-align:left;cursor:pointer;}
      .pm-root .pm-opt.correct{background:rgba(61,255,160,0.14);border-color:var(--pm-good);color:var(--pm-good);}
      .pm-root .pm-opt.wrong{background:rgba(255,95,122,0.14);border-color:var(--pm-bad);color:var(--pm-bad);}
      .pm-root .pm-opt[disabled]{cursor:default;}
      .pm-root .pm-weak-item{background:var(--pm-panel);border:1px solid var(--pm-border);border-radius:14px;padding:14px 16px;margin-bottom:10px;text-align:left;}
      .pm-root .pm-weak-word{font-size:16px;font-weight:700;color:#eef4ff;}
      .pm-root .pm-weak-meta{font-size:11px;color:#8291b3;margin-top:4px;line-height:1.6;}
      .pm-root .pm-known-item{display:flex;justify-content:space-between;gap:10px;background:rgba(255,255,255,0.03);border:1px solid rgba(79,232,255,0.16);border-radius:10px;padding:8px 12px;margin-bottom:6px;font-size:12.5px;}
      .pm-root .pm-known-item b{color:#eef4ff;}
      .pm-root .pm-known-item span{color:#8291b3;}
      .pm-root .pm-empty{text-align:center;padding:30px 10px;color:#8291b3;font-size:13px;}
      .pm-root .pm-loading{text-align:center;padding:40px 10px;color:#8291b3;font-size:13px;}
      .pm-root .pm-back-link{display:block;text-align:center;font-size:11.5px;color:#8291b3;margin-top:4px;cursor:pointer;text-decoration:underline;}
    `;
    document.head.appendChild(style);
  }

  function renderHome(){
    injectStyles();
    if(!dataLoaded){
      root.innerHTML = '<div class="pm-root"><div class="pm-loading">Kişisel alan yükleniyor...</div></div>';
      return;
    }
    checkTask5();
    persistMeta();

    const L = LANGS[activeLang];
    const filterPool = poolForActiveFilter();
    const filterKnown = knownCountIn(filterPool);
    const filterPct = filterPool.length ? Math.round((filterKnown/filterPool.length)*100) : 0;
    const today = meta.todayCount||0;
    const goal = meta.dailyGoal||DEFAULT_DAILY_GOAL;
    const goalPct = Math.min(100, Math.round((today/goal)*100));
    const acc = accuracyOverall();
    const totalStudied = totalStudiedCount();
    const totalKnownLang = knownCountIn(poolForActiveLang());
    const catInfo = categoryAccuracy();
    const due = dailyReviewWords();

    let levelRows = '';
    L.levels.forEach(lv=>{
      const list = poolForActiveLang().filter(v=>v.level===lv);
      const known = knownCountIn(list);
      const pct = list.length ? Math.round((known/list.length)*100) : 0;
      levelRows += '<div class="pm-level-row"><span>'+lv+'</span><div class="pm-bar"><div class="pm-bar-fill" style="width:'+pct+'%"></div></div><span>'+pct+'%</span></div>';
    });

    let badgeRow = '';
    BADGE_THRESHOLDS.forEach(t=>{
      const earned = meta.badges && meta.badges[t];
      badgeRow += '<div class="pm-badge '+(earned?'':'locked')+'" title="'+t+' kelime">'+(earned?'🏅':'🔒')+'</div>';
    });

    const groups = levelGroups();
    let groupRow = '';
    groups.forEach(g=>{
      const glist = poolForActiveLang().filter(v=>g.levels.includes(v.level));
      const gknown = knownCountIn(glist);
      groupRow += '<div class="pm-group-btn" data-group="'+g.name+'">'+g.name+'<span class="g-count">'+gknown+' bilinen</span></div>';
    });

    const t = meta.tasks;
    const t4Sub = t.t4
      ? ('Tamamlandı · +'+(due.length*2)+' XP')
      : (due.length>0 ? (due.length+' kelime bekliyor · kelime başına +2 XP') : '[Geçen gün öğrenilen kelime yok]');
    const taskDefs = [
      { icon:'💵', label:'Bugün 10 yeni kelime öğren', sub:Math.min(today,10)+'/10 · +'+TASK_XP.t1+' XP', done:t.t1 },
      { icon:'💰', label:'Bugün 50 yeni kelime öğren', sub:Math.min(today,50)+'/50 · +'+TASK_XP.t2+' XP', done:t.t2 },
      { icon:'🪎', label:'Bugün 100 yeni kelime öğren', sub:Math.min(today,100)+'/100 · +'+TASK_XP.t3+' XP', done:t.t3 },
      { icon:'📋', label:'Günlük tekrarı tamamla', sub: t4Sub, done:t.t4 },
      { icon:'⏱️', label:'Bu oturumda 60 dakika çalış', sub:'+'+TASK_XP.t5+' XP', done:t.t5 },
    ];

    let html = '<div class="pm-root">';
    html += '<div class="pm-head">';
    html += '<div class="pm-eyebrow">Kişisel Öğrenme Alanı</div>';
    html += '<div class="pm-title">👤 '+escapeHtml(currentName)+'\'e Özel</div>';
    html += '<div class="pm-sub">'+L.native+' öğrenimi - ilerlemen tüm cihazlarında senkron</div>';
    html += '<div class="pm-mini-select" id="pmLangSelect">';
    Object.keys(LANGS).forEach(code=>{
      html += '<div class="pm-chip '+(code===activeLang?'active':'')+'" data-lang="'+code+'">'+LANGS[code].label+'</div>';
    });
    html += '</div>';
    html += '<div class="pm-mini-select" id="pmLevelSelect">';
    html += '<div class="pm-chip '+(activeLevel==='TÜMÜ'?'active':'')+'" data-level="TÜMÜ">TÜMÜ</div>';
    L.levels.forEach(lv=>{
      html += '<div class="pm-chip '+(lv===activeLevel?'active':'')+'" data-level="'+lv+'">'+lv+'</div>';
    });
    html += '</div>';
    html += '<div class="pm-pill-row"><div class="pm-pill flame">🔥 '+(meta.streak||0)+' günlük seri</div><div class="pm-pill">⭐ Seviye '+(Math.floor((meta.xp||0)/200)+1)+' - '+(meta.xp||0)+' XP</div></div>';
    html += '<div class="pm-goal-wrap"><div class="pm-goal-row"><span>Bugün öğrenilen</span><span>'+today+' / '+goal+' kelime</span></div><div class="pm-bar"><div class="pm-bar-fill" style="width:'+goalPct+'%"></div></div></div>';
    html += '</div>';

    if(due.length > 0){
      html += '<div class="pm-due-banner"><div class="pm-due-text">📋 Dün öğrendiğin <b>'+due.length+'</b> kelimenin günlük tekrarı var</div><button id="pmDueBtn">Tekrar Et</button></div>';
    }

    html += '<div class="pm-card"><h4>İlerleme - '+activeLevel+' - '+filterKnown+' / '+filterPool.length+' kelime (%'+filterPct+')</h4>';
    html += levelRows || '<div class="pm-empty">Bu dil icin henuz seviye tanimli degil.</div>';
    html += '</div>';

    html += '<div class="pm-card"><h4>Genel Tekrar</h4><div class="pm-weak-meta">Bildiğini varsaydığımız kelimeleri tekrar sorar; yanlış yaparsan çalışma listene geri döner.</div><div class="pm-group-row" id="pmGroupRow">'+groupRow+'</div></div>';

    html += '<div class="pm-card"><h4>Istatistikler</h4><div class="pm-stat-grid">';
    html += '<div class="pm-stat-box"><div class="pm-stat-num">'+totalKnownLang+'</div><div class="pm-stat-label">Öğrenilen ('+L.label+')</div></div>';
    html += '<div class="pm-stat-box"><div class="pm-stat-num">'+today+'</div><div class="pm-stat-label">Bugün öğrenilen</div></div>';
    html += '<div class="pm-stat-box"><div class="pm-stat-num">'+totalStudied+'</div><div class="pm-stat-label">Toplam çalışılan</div></div>';
    html += '<div class="pm-stat-box"><div class="pm-stat-num">'+(acc===null?'-':acc+'%')+'</div><div class="pm-stat-label">Doğruluk oranı</div></div>';
    html += '</div>';
    html += '<div class="pm-weak-meta" style="margin-top:10px;">'+(catInfo.best ? ('💪 En guclu kategori: <b>'+escapeHtml(catInfo.best.cat)+'</b>') : 'Henuz yeterli veri yok.')+'<br>'+(catInfo.worst ? ('🎯 Gelistirilecek kategori: <b>'+escapeHtml(catInfo.worst.cat)+'</b>') : '')+'</div>';
    html += '<div class="pm-weak-meta" id="pmTotalTime" style="margin-top:6px;">⏱ Toplam çalışma süresi yükleniyor...</div>';
    html += '</div>';

    html += '<div class="pm-card"><h4>Bugünkü Görevler</h4>';
    taskDefs.forEach(td=>{
      html += '<div class="pm-task '+(td.done?'done':'')+'"><div class="pm-task-icon">'+(td.done?'✅':td.icon)+'</div><div class="pm-task-body"><div class="pm-task-label">'+td.label+'</div><div class="pm-task-sub">'+td.sub+'</div></div></div>';
    });
    html += '</div>';

    html += '<div class="pm-card"><h4>Rozetler</h4><div class="pm-badges">'+badgeRow+'</div></div>';

    html += '<button class="pm-btn primary" id="pmStartBtn">🚀 Çalışmaya Başla</button>';
    html += '<button class="pm-btn small" id="pmKnownBtn">✅ Öğrendiğim Kelimeler ('+totalKnownLang+')</button>';
    html += '<button class="pm-btn small" id="pmWeakBtn">📉 Hata Yaptığım Kelimeler</button>';
    html += '</div>';

    root.innerHTML = html;

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
    document.querySelectorAll('#pmGroupRow .pm-group-btn').forEach(el=>{
      el.onclick = () => startGeneralReview(el.dataset.group);
    });
    document.getElementById('pmStartBtn').onclick = startSession;
    document.getElementById('pmKnownBtn').onclick = renderKnownWords;
    document.getElementById('pmWeakBtn').onclick = renderWeakWords;
    const dueBtn = document.getElementById('pmDueBtn');
    if(dueBtn) dueBtn.onclick = startDailyReview;

    if(window.LB_getTotalSeconds){
      window.LB_getTotalSeconds(currentName, (secs)=>{
        const el = document.getElementById('pmTotalTime');
        if(!el) return;
        const s = Math.floor(secs);
        const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
        el.textContent = '⏱ Toplam çalışma süresi: '+(h>0?h+'s ':'')+m+'dk';
      });
    }
  }

  function pickBatch(){
    const pool = poolForActiveFilter();
    const unknown = pool.filter(v=>{ const r=getRecord(v); return !(r && r.known); });
    const due = unknown.filter(v=>{
      const r = getRecord(v);
      return r && r.retryAfterSession != null && r.retryAfterSession <= meta.studySessionCount;
    });
    const fresh = unknown.filter(v=> !due.includes(v));

    function bestCategoryFrom(list){
      const byCat = {};
      list.forEach(v=>{ (byCat[v.cat] = byCat[v.cat]||[]).push(v); });
      let bestCat = null, bestList = [];
      Object.keys(byCat).forEach(cat=>{
        if(byCat[cat].length > bestList.length){ bestCat = cat; bestList = byCat[cat]; }
      });
      return bestCat;
    }

    let chosenCat = bestCategoryFrom(due.length ? due : fresh);
    if(!chosenCat) return [];

    const inCat = unknown.filter(v=>v.cat===chosenCat);
    const dueInCat = inCat.filter(v=>{
      const r=getRecord(v); return r && r.retryAfterSession!=null && r.retryAfterSession<=meta.studySessionCount;
    });
    const freshInCat = inCat.filter(v=> !dueInCat.includes(v));
    shuffle(freshInCat);
    let chosen = dueInCat.concat(freshInCat).slice(0, BATCH_SIZE);

    if(chosen.length < BATCH_SIZE){
      const rest = unknown.filter(v=>v.cat!==chosenCat);
      const restDue = rest.filter(v=>{
        const r=getRecord(v); return r && r.retryAfterSession!=null && r.retryAfterSession<=meta.studySessionCount;
      });
      shuffle(restDue);
      chosen = chosen.concat(restDue.slice(0, BATCH_SIZE-chosen.length));
    }
    return chosen.map(v=>({v, key:wordKeyFor(v)}));
  }

  function startSession(){
    batch = pickBatch();
    if(batch.length === 0){
      root.innerHTML = '<div class="pm-root"><div class="pm-empty">🎉 Bu seviyede çalışılacak yeni kelime kalmadı - harika iş çıkardın!<br><br>İstersen Genel Tekrar yaparak bildiklerini tazeleyebilirsin.</div><span class="pm-back-link" id="pmBackHome">← Ana sayfaya dön</span></div>';
      document.getElementById('pmBackHome').onclick = renderHome;
      return;
    }
    beginBatchFlow();
  }

  function startDailyReview(){
    const list = dailyReviewWords();
    if(list.length === 0){ renderHome(); return; }
    shuffle(list);
    reviewMode = { kind:'daily', group:'Günlük Tekrar', order:list, idx:0, stats:{ total:list.length, correct:0, wrong:0 } };
    renderReviewCard();
  }

  function beginBatchFlow(){
    batchResult = {};
    batch.forEach(item => { batchResult[item.key] = { quizOk:null, listenOk:null }; });
    cardIdx = 0;
    sessionStats = { total:0, correct:0, wrong:0, xp:0, newKnown:0, newBadges:[], mistakes:[] };
    renderCardsPhase();
  }

  function renderCardsPhase(){
    if(cardIdx >= batch.length){
      quizOrder = shuffle(batch.map((_,i)=>i));
      quizIdx = 0;
      renderQuizPhase();
      return;
    }
    const v = batch[cardIdx].v;
    const barHtml = '<div class="pm-session-bar"><span>Tanisma '+(cardIdx+1)+' / '+batch.length+'</span><span>Adim 1/3</span></div><div class="pm-bar" style="margin-bottom:14px;"><div class="pm-bar-fill" style="width:'+Math.round((cardIdx/batch.length)*100)+'%"></div></div>';
    let flipped = false;
    function draw(){
      let html = '<div class="pm-root">'+barHtml;
      html += '<div class="pm-study-card" id="pmCard">';
      html += '<div class="pm-mode-tag">'+(flipped ? 'Türkçesi' : 'Yeni Kelime')+'</div>';
      html += '<div class="pm-word" dir="'+LANGS[v.lang].dir+'">'+(flipped ? escapeHtml(v.tr) : escapeHtml(v.w))+'</div>';
      html += '<div class="pm-word-sub">'+escapeHtml(v.pos||'')+'</div>';
      html += '<div class="pm-speak-row"><div class="pm-speak-btn" id="pmRabbit" title="Hızlı dinle">🐰</div><div class="pm-speak-btn" id="pmTurtle" title="Yavaş dinle">🐢</div></div>';
      html += '<div class="pm-word-sub" style="margin-top:10px;">Çevirmek için karta dokun</div>';
      html += '</div>';
      html += '<button class="pm-btn primary" id="pmNextCard">Sonraki Kelime</button>';
      html += '</div>';
      root.innerHTML = html;
      // Karta her tıklandığında SADECE kelime/Türkçe arasında geçiş yapar
      // (Kartlar sekmesindeki mantıkla birebir aynı) — bir sonraki kelimeye
      // GEÇMEZ. İlerlemek için ayrı "Sonraki Kelime" butonu kullanılır.
      document.getElementById('pmCard').onclick = () => {
        flipped = !flipped;
        draw();
        if(!flipped) pmSpeak(v.w, LANGS[v.lang].voice, false);
      };
      document.getElementById('pmNextCard').onclick = (e) => {
        e.stopPropagation();
        cardIdx++;
        renderCardsPhase();
      };
      const rb = document.getElementById('pmRabbit'), tb = document.getElementById('pmTurtle');
      if(rb) rb.onclick = (e)=>{ e.stopPropagation(); pmSpeak(v.w, LANGS[v.lang].voice, false); };
      if(tb) tb.onclick = (e)=>{ e.stopPropagation(); pmSpeak(v.w, LANGS[v.lang].voice, true); };
    }
    draw();
    pmSpeak(v.w, LANGS[v.lang].voice, false);
  }

  function pickDistractors(v, count){
    let pool = poolForActiveFilter().filter(x=>x.w!==v.w);
    if(pool.length < count) pool = VOCAB.filter(x=>x.lang===v.lang && x.w!==v.w);
    shuffle(pool);
    return pool.slice(0,count);
  }

  function renderQuizPhase(){
    if(quizIdx >= quizOrder.length){
      listenOrder = shuffle(batch.map((_,i)=>i));
      listenIdx = 0;
      renderListenPhase();
      return;
    }
    currentAnswered = false;
    const item = batch[quizOrder[quizIdx]];
    const v = item.v;
    const distractors = pickDistractors(v, 3);
    const opts = shuffle([v.tr].concat(distractors.map(d=>d.tr)));
    const barHtml = '<div class="pm-session-bar"><span>Soru '+(quizIdx+1)+' / '+batch.length+'</span><span>Adim 2/3 - Anlam Testi</span></div><div class="pm-bar" style="margin-bottom:14px;"><div class="pm-bar-fill" style="width:'+Math.round((quizIdx/batch.length)*100)+'%"></div></div>';
    root.innerHTML = '<div class="pm-root">'+barHtml+
      '<div class="pm-study-card" style="cursor:default;"><div class="pm-mode-tag">Bu kelimenin anlami nedir?</div><div class="pm-word" dir="'+LANGS[v.lang].dir+'">'+escapeHtml(v.w)+'</div><div class="pm-word-sub">'+escapeHtml(v.pos||'')+'</div><div class="pm-speak-row"><div class="pm-speak-btn" id="pmRabbit">🐰</div><div class="pm-speak-btn" id="pmTurtle">🐢</div></div></div>'+
      '<div class="pm-options" id="pmOptions"></div></div>';
    document.getElementById('pmRabbit').onclick = () => pmSpeak(v.w, LANGS[v.lang].voice, false);
    document.getElementById('pmTurtle').onclick = () => pmSpeak(v.w, LANGS[v.lang].voice, true);
    const wrap = document.getElementById('pmOptions');
    opts.forEach(o=>{
      const b = document.createElement('button');
      b.className = 'pm-opt'; b.textContent = o;
      b.onclick = () => {
        if(currentAnswered) return;
        currentAnswered = true;
        const ok = (o === v.tr);
        batchResult[item.key].quizOk = ok;
        document.querySelectorAll('#pmOptions .pm-opt').forEach(x=>{
          x.disabled = true;
          if(x.textContent === v.tr) x.classList.add('correct');
          else if(x===b && !ok) x.classList.add('wrong');
        });
        setTimeout(()=>{ quizIdx++; renderQuizPhase(); }, 650);
      };
      wrap.appendChild(b);
    });
  }

  function renderListenPhase(){
    if(listenIdx >= listenOrder.length){
      finalizeBatch();
      return;
    }
    currentAnswered = false;
    const item = batch[listenOrder[listenIdx]];
    const v = item.v;
    const distractors = pickDistractors(v, 3);
    const opts = shuffle([v.tr].concat(distractors.map(d=>d.tr)));
    const barHtml = '<div class="pm-session-bar"><span>Soru '+(listenIdx+1)+' / '+batch.length+'</span><span>Adim 3/3 - Dinleme</span></div><div class="pm-bar" style="margin-bottom:14px;"><div class="pm-bar-fill" style="width:'+Math.round((listenIdx/batch.length)*100)+'%"></div></div>';
    root.innerHTML = '<div class="pm-root">'+barHtml+
      '<div class="pm-study-card" style="cursor:default;"><div class="pm-mode-tag">🎧 Duydugun kelimenin anlami ne?</div><div class="pm-word" style="font-size:34px;">🎙️</div><div class="pm-speak-row"><div class="pm-speak-btn" id="pmRabbit" title="Hizli tekrar dinle">🐰</div><div class="pm-speak-btn" id="pmTurtle" title="Yavas tekrar dinle">🐢</div></div></div>'+
      '<div class="pm-options" id="pmOptions"></div></div>';
    const playFast = () => pmSpeak(v.w, LANGS[v.lang].voice, false);
    const playSlow = () => pmSpeak(v.w, LANGS[v.lang].voice, true);
    document.getElementById('pmRabbit').onclick = playFast;
    document.getElementById('pmTurtle').onclick = playSlow;
    playFast();
    const wrap = document.getElementById('pmOptions');
    opts.forEach(o=>{
      const b = document.createElement('button');
      b.className = 'pm-opt'; b.textContent = o;
      b.onclick = () => {
        if(currentAnswered) return;
        currentAnswered = true;
        const ok = (o === v.tr);
        batchResult[item.key].listenOk = ok;
        document.querySelectorAll('#pmOptions .pm-opt').forEach(x=>{
          x.disabled = true;
          if(x.textContent === v.tr) x.classList.add('correct');
          else if(x===b && !ok) x.classList.add('wrong');
        });
        setTimeout(()=>{ listenIdx++; renderListenPhase(); }, 650);
      };
      wrap.appendChild(b);
    });
  }

  function finalizeBatch(){
    meta.studySessionCount = (meta.studySessionCount||0) + 1;
    const now = Date.now();
    batch.forEach(item => {
      const v = item.v, key = item.key;
      const res = batchResult[key];
      const bothOk = res.quizOk === true && res.listenOk === true;
      let rec = wordProgress[key] || { seen:0, correct:0, wrong:0, known:false, retryAfterSession:null, lang:v.lang, level:v.level, cat:v.cat };
      rec.seen = (rec.seen||0) + 1;
      sessionStats.total++;
      if(bothOk){
        rec.correct = (rec.correct||0) + 1;
        if(!rec.known){
          rec.known = true;
          rec.retryAfterSession = null;
          rec.learnedDate = todayStr();
          sessionStats.newKnown++;
          meta.todayCount = (meta.todayCount||0) + 1;
          meta.xp = (meta.xp||0) + XP_PER_NEW_WORD;
        }
        sessionStats.correct++;
      } else {
        rec.wrong = (rec.wrong||0) + 1;
        rec.known = false;
        rec.retryAfterSession = meta.studySessionCount + RETRY_SESSION_GAP;
        sessionStats.wrong++;
        sessionStats.mistakes.push({ word:v.w, tr:v.tr });
      }
      rec.lastSeen = now;
      wordProgress[key] = rec;
    });
    persistLocalMirror();
    batch.forEach(item => {
      const ref = dbRef('progress/'+currentKey+'/words/'+item.key);
      if(ref) ref.set(wordProgress[item.key]).catch(()=>{});
    });
    markStudyToday();
    checkThresholdTasks();
    checkBadges();
    sessionStats.xp = sessionStats.newKnown * XP_PER_NEW_WORD;
    persistMeta();
    renderSessionSummary();
  }

  function renderSessionSummary(){
    const s = sessionStats;
    let html = '<div class="pm-root">';
    html += '<div class="pm-head"><div class="pm-eyebrow">Oturum Tamamlandı</div><div class="pm-title">🎉 Harika İş!</div><div class="pm-sub">'+s.newKnown+' yeni kelime öğrendin - +'+s.xp+' XP</div></div>';
    html += '<div class="pm-card"><h4>Sonuç</h4><div class="pm-stat-grid"><div class="pm-stat-box"><div class="pm-stat-num">'+s.newKnown+'</div><div class="pm-stat-label">Yeni öğrenilen</div></div><div class="pm-stat-box"><div class="pm-stat-num">'+s.wrong+'</div><div class="pm-stat-label">Tekrar gerekiyor</div></div></div></div>';
    if(s.newBadges.length){
      html += '<div class="pm-card"><h4>Yeni Rozetler</h4><div class="pm-weak-meta">'+s.newBadges.map(t=>'🏅 '+t+' kelime rozeti').join('<br>')+'</div></div>';
    }
    if(s.mistakes.length){
      html += '<button class="pm-btn small" id="pmSeeMistakes">Tekrar Gereken Kelimeleri Gor ('+s.mistakes.length+')</button>';
    }
    html += '<button class="pm-btn primary" id="pmBackHomeBtn">Ana Sayfaya Dön</button></div>';
    root.innerHTML = html;
    document.getElementById('pmBackHomeBtn').onclick = renderHome;
    if(s.mistakes.length){
      document.getElementById('pmSeeMistakes').onclick = () => {
        let h2 = '<div class="pm-root"><div class="pm-head"><div class="pm-title">Tekrar Gereken Kelimeler</div><div class="pm-sub">Bir sonraki oturumu atlayıp, ondan sonrasında tekrar karşına çıkacaklar.</div></div>';
        s.mistakes.forEach(m=>{
          h2 += '<div class="pm-weak-item"><div class="pm-weak-word">'+escapeHtml(m.word)+'</div><div class="pm-weak-meta">Doğrusu: '+escapeHtml(m.tr)+'</div></div>';
        });
        h2 += '<button class="pm-btn primary" id="pmBackSummary">Geri Don</button></div>';
        root.innerHTML = h2;
        document.getElementById('pmBackSummary').onclick = renderSessionSummary;
      };
    }
  }

  function startGeneralReview(groupName){
    const group = levelGroups().find(g=>g.name===groupName);
    if(!group) return;
    const list = poolForActiveLang().filter(v=>group.levels.includes(v.level));
    const known = list.filter(v=>{ const r=getRecord(v); return r && r.known; });
    if(known.length === 0){
      root.innerHTML = '<div class="pm-root"><div class="pm-empty">Bu grupta henüz bilinen kelime yok. Önce biraz çalışman gerekiyor.</div><span class="pm-back-link" id="pmBackHome">← Ana sayfaya dön</span></div>';
      document.getElementById('pmBackHome').onclick = renderHome;
      return;
    }
    shuffle(known);
    reviewMode = { kind:'level', group: groupName, order: known, idx: 0, stats: { total:known.length, correct:0, wrong:0 } };
    renderReviewCard();
  }

  function renderReviewCard(){
    if(reviewMode.idx >= reviewMode.order.length){ finalizeReview(); return; }
    currentAnswered = false;
    const v = reviewMode.order[reviewMode.idx];
    const distractors = pickDistractors(v, 3);
    const opts = shuffle([v.tr].concat(distractors.map(d=>d.tr)));
    const barHtml = '<div class="pm-session-bar"><span>Genel Tekrar ('+reviewMode.group+')</span><span>'+(reviewMode.idx+1)+' / '+reviewMode.order.length+'</span></div><div class="pm-bar" style="margin-bottom:14px;"><div class="pm-bar-fill" style="width:'+Math.round((reviewMode.idx/reviewMode.order.length)*100)+'%"></div></div>';
    root.innerHTML = '<div class="pm-root">'+barHtml+
      '<div class="pm-study-card" style="cursor:default;"><div class="pm-mode-tag">Bu kelimenin anlami nedir?</div><div class="pm-word" dir="'+LANGS[v.lang].dir+'">'+escapeHtml(v.w)+'</div><div class="pm-word-sub">'+escapeHtml(v.pos||'')+'</div><div class="pm-speak-row"><div class="pm-speak-btn" id="pmRabbit">🐰</div><div class="pm-speak-btn" id="pmTurtle">🐢</div></div></div>'+
      '<div class="pm-options" id="pmOptions"></div></div>';
    document.getElementById('pmRabbit').onclick = () => pmSpeak(v.w, LANGS[v.lang].voice, false);
    document.getElementById('pmTurtle').onclick = () => pmSpeak(v.w, LANGS[v.lang].voice, true);
    const wrap = document.getElementById('pmOptions');
    opts.forEach(o=>{
      const b = document.createElement('button');
      b.className = 'pm-opt'; b.textContent = o;
      b.onclick = () => {
        if(currentAnswered) return;
        currentAnswered = true;
        const ok = (o === v.tr);
        const key = wordKeyFor(v);
        let rec = wordProgress[key];
        if(rec){
          rec.seen = (rec.seen||0)+1;
          if(ok){ rec.correct=(rec.correct||0)+1; reviewMode.stats.correct++; }
          else {
            rec.wrong=(rec.wrong||0)+1;
            rec.known = false;
            rec.retryAfterSession = null;
            reviewMode.stats.wrong++;
          }
          wordProgress[key] = rec;
        }
        document.querySelectorAll('#pmOptions .pm-opt').forEach(x=>{
          x.disabled = true;
          if(x.textContent === v.tr) x.classList.add('correct');
          else if(x===b && !ok) x.classList.add('wrong');
        });
        setTimeout(()=>{ reviewMode.idx++; renderReviewCard(); }, 650);
      };
      wrap.appendChild(b);
    });
  }

  function finalizeReview(){
    persistLocalMirror();
    reviewMode.order.forEach(v=>{
      const key = wordKeyFor(v);
      const ref = dbRef('progress/'+currentKey+'/words/'+key);
      if(ref) ref.set(wordProgress[key]).catch(()=>{});
    });
    const stats = reviewMode.stats;
    const isDaily = reviewMode.kind === 'daily';
    if(isDaily){
      awardTask4(stats.total);
    }
    persistMeta();
    const titleEyebrow = isDaily ? 'Günlük Tekrar Tamamlandı' : 'Genel Tekrar Tamamlandı';
    const titleIcon = isDaily ? '📋' : '🔁';
    let html = '<div class="pm-root"><div class="pm-head"><div class="pm-eyebrow">'+titleEyebrow+'</div><div class="pm-title">'+titleIcon+' '+reviewMode.group+'</div><div class="pm-sub">'+stats.correct+' / '+stats.total+' doğru'+(isDaily ? (' · +'+(stats.total*2)+' XP') : '')+'</div></div>';
    if(stats.wrong>0){
      html += '<div class="pm-weak-meta" style="text-align:center;margin-bottom:14px;">'+stats.wrong+' kelime bilinmiyor listesine geri döndü, normal çalışmada tekrar karşına çıkacak.</div>';
    }
    html += '<button class="pm-btn primary" id="pmBackHomeBtn">Ana Sayfaya Dön</button></div>';
    root.innerHTML = html;
    document.getElementById('pmBackHomeBtn').onclick = renderHome;
    reviewMode = null;
  }

  function renderKnownWords(){
    const list = poolForActiveLang().filter(v=>{ const r=getRecord(v); return r && r.known; });
    let html = '<div class="pm-root"><div class="pm-head"><div class="pm-title">✅ Öğrendiğin Kelimeler</div><div class="pm-sub">'+list.length+' kelime ('+LANGS[activeLang].label+')</div></div>';
    if(list.length===0){
      html += '<div class="pm-empty">Henüz öğrenilmiş kelime yok - çalışmaya başla!</div>';
    } else {
      list.slice(0,300).forEach(v=>{
        html += '<div class="pm-known-item" dir="'+LANGS[v.lang].dir+'"><b>'+escapeHtml(v.w)+'</b><span>'+escapeHtml(v.tr)+'</span></div>';
      });
      if(list.length>300) html += '<div class="pm-weak-meta" style="text-align:center;">...ve '+(list.length-300)+' kelime daha</div>';
    }
    html += '<button class="pm-btn primary" id="pmBackHomeBtn" style="margin-top:14px;">Ana Sayfaya Dön</button></div>';
    root.innerHTML = html;
    document.getElementById('pmBackHomeBtn').onclick = renderHome;
  }

  function renderWeakWords(){
    const entries = Object.keys(wordProgress)
      .map(k=>({key:k, rec:wordProgress[k]}))
      .filter(e => e.rec.lang === activeLang && (e.rec.wrong||0) > 0)
      .sort((a,b)=> (b.rec.wrong||0) - (a.rec.wrong||0))
      .slice(0, 30);

    const lookup = {};
    VOCAB.forEach(v=>{ lookup[wordKeyFor(v)] = v; });

    let html = '<div class="pm-root"><div class="pm-head"><div class="pm-title">📉 Hata Yaptığın Kelimeler</div><div class="pm-sub">En çok yanlış yaptığın kelimeler</div></div>';
    if(entries.length===0){
      html += '<div class="pm-empty">Hic hata yapmamissin - harika! 🎉</div>';
    } else {
      entries.forEach(e=>{
        const v = lookup[e.key];
        if(!v) return;
        const status = e.rec.known ? '✅ Su an bilinen kelimeler arasinda' : '⏳ Tekrar bekliyor';
        html += '<div class="pm-weak-item"><div class="pm-weak-word" dir="'+LANGS[v.lang].dir+'">'+escapeHtml(v.w)+' <span style="color:var(--pm-accent);font-size:12px;">- '+escapeHtml(v.tr)+'</span></div><div class="pm-weak-meta">❌ Yanlış: '+(e.rec.wrong||0)+' - ✅ Doğru: '+(e.rec.correct||0)+' - 👁 Görülme: '+(e.rec.seen||0)+'<br>'+status+'</div></div>';
      });
    }
    html += '<button class="pm-btn primary" id="pmBackHomeBtn2">Ana Sayfaya Dön</button></div>';
    root.innerHTML = html;
    document.getElementById('pmBackHomeBtn2').onclick = renderHome;
  }

  function openPersonalMode(){
    if(!root) return;
    injectStyles();
    const name = window.LB_getUserName ? window.LB_getUserName() : '';
    if(!name){
      root.innerHTML = '<div class="pm-root"><div class="pm-empty">Kişisel alanı kullanmak için önce adını girmen gerekiyor.</div><button class="pm-btn primary" id="pmAskNameBtn">Adımı Gir</button></div>';
      document.getElementById('pmAskNameBtn').onclick = () => { if(window.LB_checkName) window.LB_checkName(); };
      return;
    }
    if(dataLoaded && currentName === name){ renderHome(); return; }
    root.innerHTML = '<div class="pm-root"><div class="pm-loading">Kişisel alan yükleniyor...</div></div>';
    loadUserData(name, renderHome);
  }

  window.LB_onNameReady = function(name){
    if(root && root.style.display !== 'none'){ loadUserData(name, renderHome); }
  };

  window.PM_open = openPersonalMode;
})();
