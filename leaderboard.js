/* ================================================================
   LEADERBOARD.JS — Kalıcı, tüm cihazlarda tutarlı liderlik tablosu
   (Splash / giriş ekranının altında sabit, tıklama gerektirmez)
   ================================================================

   TEK YAPMAN GEREKEN ADIM (daha önce yapmadıysan):
   Bu tablo tüm ziyaretçiler arasında GERÇEKTEN paylaşılan/kalıcı olsun
   diye ücretsiz bir Firebase (Google) veritabanı kullanıyor.

   1) https://console.firebase.google.com > projenin var (Mhamzac).
   2) Realtime Database zaten oluşturuldu ve Rules'a
      { "rules": { "leaderboard": { ".read": true, ".write": true } } }
      yapıştırıldı.
   3) Project settings > Your apps > Web (</>) ile alınan 7 değeri
      aşağıdaki FIREBASE_CONFIG içine yapıştır.
================================================================ */

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBHgCtHuIunwlleLCxFCexErrjyZkuNYE0",
  authDomain: "mhamzac-ca73d.firebaseapp.com",
  databaseURL: "https://mhamzac-ca73d-default-rtdb.firebaseio.com",
  projectId: "mhamzac-ca73d",
  storageBucket: "mhamzac-ca73d.firebasestorage.app",
  messagingSenderId: "1002199445271",
  appId: "1:1002199445271:web:2c6620ff1db498c4679152"
};

function initLeaderboard(){
  try{
    const isConfigured = FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.apiKey.indexOf('BURAYA_YAPISTIR') === -1;
    let db = null;

    if(isConfigured && typeof firebase !== 'undefined'){
      try{
        firebase.initializeApp(FIREBASE_CONFIG);
        db = firebase.database();
      }catch(e){ console.warn('Firebase başlatılamadı:', e); }
    } else if(!isConfigured){
      console.warn('Liderlik tablosu: FIREBASE_CONFIG henüz doldurulmadı.');
    } else {
      console.warn('Liderlik tablosu: Firebase SDK yüklenemedi (script src hatası olabilir).');
    }

    /* ---------------- İSİM YÖNETİMİ ---------------- */
    const NAME_KEY = 'lb_user_name';
    function getStoredName(){ try{ return localStorage.getItem(NAME_KEY) || ''; }catch(e){ return ''; } }
    function setStoredName(n){ try{ localStorage.setItem(NAME_KEY, n); }catch(e){} }
    function sanitizeKey(name){
      return name.trim().toLowerCase().replace(/\s+/g, '_').slice(0,20).replace(/[.#$/\[\]]/g, '_');
    }
    // progress.js da AYNI anahtar üretimini kullanmak zorunda (aksi halde
    // ilerleme verisi farklı bir kullanıcı anahtarına yazılır). Fonksiyonu
    // dışa açıyoruz ki tek bir doğruluk kaynağı olsun.
    window.LB_sanitizeKey = sanitizeKey;

    const nameOverlay = document.getElementById('nameOverlay');
    const nameInput = document.getElementById('nameInput');
    const nameSubmit = document.getElementById('nameSubmit');

    function showNameModal(){ if(nameOverlay) nameOverlay.classList.add('open'); }
    function hideNameModal(){ if(nameOverlay) nameOverlay.classList.remove('open'); }

    if(nameSubmit && nameInput){
      nameSubmit.onclick = () => {
        const name = nameInput.value.trim();
        if(!name){ nameInput.focus(); return; }
        setStoredName(name);
        hideNameModal();
        startTracking(name);
      };
      nameInput.addEventListener('keydown', (e) => {
        if(e.key === 'Enter') nameSubmit.click();
      });
    } else {
      console.warn('Liderlik tablosu: isim formu elementleri bulunamadı.');
    }

    /* ---------------- SÜRE TAKİBİ (aktiflik bazlı, hile önleyici) ---------------- */
    let currentName = '';
    let heartbeatTimer = null;
    let creditedSeconds = 0;
    let activeAccumulated = 0;
    let lastActivity = Date.now();
    let lastTick = Date.now();
    const FLUSH_MS = 5000;
    const IDLE_MS = 60000;

    const ACTIVITY_EVENTS = ['click','touchstart','touchmove','mousemove','keydown','scroll','pointerdown'];
    ACTIVITY_EVENTS.forEach(evt => {
      window.addEventListener(evt, () => { lastActivity = Date.now(); }, { passive:true });
    });

    function tickActive(){
      const now = Date.now();
      const idleFor = now - lastActivity;
      if(idleFor < IDLE_MS){
        activeAccumulated += (now - lastTick) / 1000;
      }
      lastTick = now;
    }
    setInterval(tickActive, 1000);

    function isIdleNow(){
      return (Date.now() - lastActivity) >= IDLE_MS;
    }

    function legacyKey(name){
      return name.trim().slice(0,20).replace(/[.#$/\[\]]/g, '_');
    }

    function migrateLegacyIfNeeded(name){
      if(!db) return;
      const newKey = sanitizeKey(name);
      const oldKey = legacyKey(name);
      if(!newKey || !oldKey || newKey === oldKey) return;
      const newRef = db.ref('leaderboard/' + newKey);
      const oldRef = db.ref('leaderboard/' + oldKey);
      oldRef.once('value').then((oldSnap) => {
        const oldVal = oldSnap.val();
        const oldSeconds = oldVal && typeof oldVal.totalSeconds === 'number' ? oldVal.totalSeconds : 0;
        if(oldSeconds <= 0){
          return;
        }
        newRef.once('value').then((newSnap) => {
          const newVal = newSnap.val();
          const newHasData = newVal && typeof newVal.totalSeconds === 'number' && newVal.totalSeconds > 0;
          if(!newHasData){
            newRef.transaction((current) => {
              const prev = current && typeof current === 'object' ? current : { name: name, totalSeconds: 0 };
              return { name: name, totalSeconds: (prev.totalSeconds || 0) + oldSeconds, lastSeen: Date.now() };
            }).then(() => {
              oldRef.remove().catch(()=>{});
            });
          } else {
            oldRef.remove().catch(()=>{});
          }
        }).catch(()=>{});
      }).catch(()=>{});
    }

    function startTracking(name){
      currentName = name;
      migrateLegacyIfNeeded(name);
      listenOwnProfile(name);
      // progress.js (kişisel öğrenme modu) ismin hazır olduğu anı bekliyor;
      // burada haber veriyoruz ki kendi Firebase dinleyicilerini kursun.
      if(window.LB_onNameReady){
        try{ window.LB_onNameReady(name); }catch(e){}
      }
      if(!db) return;
      if(heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(flushElapsed, FLUSH_MS);
    }

    function listenOwnProfile(name){
      const el = document.getElementById('profileTimer');
      if(!el) return;
      if(!db){
        el.textContent = `👤 ${name} — profil henüz bağlanmadı`;
        return;
      }
      const key = sanitizeKey(name);
      if(!key) return;
      db.ref('leaderboard/' + key).on('value', (snap) => {
        const val = snap.val();
        const total = val && typeof val.totalSeconds === 'number' ? val.totalSeconds : 0;
        el.textContent = `👤 ${name} — Toplam süren: ${fmtTime(total)}`;
      });
    }

    function flushElapsed(useBeacon){
      tickActive();
      if(!currentName) return;
      const delta = activeAccumulated - creditedSeconds;
      if(delta >= 0.5){
        addSeconds(currentName, delta, useBeacon);
        creditedSeconds = activeAccumulated;
      }
    }

    function addSeconds(name, seconds, useBeacon){
      if(!name) return;
      const key = sanitizeKey(name);
      if(!key) return;
      if(useBeacon && FIREBASE_CONFIG.databaseURL && FIREBASE_CONFIG.databaseURL.indexOf('BURAYA_YAPISTIR') === -1){
        try{
          const url = FIREBASE_CONFIG.databaseURL.replace(/\/$/, '') + '/leaderboard/' + key + '/lastFlushAttempt.json';
          fetch(url, { method:'PUT', body: JSON.stringify(Date.now()), keepalive:true }).catch(()=>{});
        }catch(e){}
      }
      if(!db) return;
      const ref = db.ref('leaderboard/' + key);
      ref.transaction((current) => {
        const prev = current && typeof current === 'object' ? current : { name: name, totalSeconds: 0 };
        return { name: name, totalSeconds: (prev.totalSeconds || 0) + seconds, lastSeen: Date.now() };
      });
    }

    document.addEventListener('visibilitychange', () => {
      if(document.visibilityState === 'hidden'){
        flushElapsed(true);
      } else {
        flushElapsed();
      }
    });
    window.addEventListener('beforeunload', () => flushElapsed(true));
    window.addEventListener('pagehide', () => flushElapsed(true));

    /* ---------------- LİDERLİK TABLOSU GÖRÜNÜMÜ (splash içinde sabit) ---------------- */
    function fmtTime(totalSeconds){
      const s = Math.max(0, Math.floor(totalSeconds || 0));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      if(h > 0) return `${h}s ${m}dk`;
      if(m > 0) return `${m}dk`;
      return `${s}sn`;
    }

    function escapeHtml(s){
      return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    const MEDALS = ['🥇','🥈','🥉'];
    function renderLeaderboard(entries){
      const list = document.getElementById('splashLbList');
      if(!list) return;
      if(!db){
        list.innerHTML = '<div class="lb-empty">Tablo henüz bağlanmadı.</div>';
        return;
      }
      if(!entries.length){
        list.innerHTML = '<div class="lb-empty">Henüz kimse yok. İlk sen ol! 🎉</div>';
        return;
      }
      list.innerHTML = '';
      entries.forEach((e, i) => {
        const row = document.createElement('div');
        row.className = 'lb-row' + (e.name === currentName ? ' me' : '');
        const rankDisplay = MEDALS[i] || (i+1);
        row.innerHTML = `
          <div class="lb-rank">${rankDisplay}</div>
          <div class="lb-name">${escapeHtml(e.name)}${e.name===currentName ? ' (sen)' : ''}</div>
          <div class="lb-time">${fmtTime(e.totalSeconds)}</div>`;
        list.appendChild(row);
      });
    }

    function listenLeaderboard(){
      if(!db){ renderLeaderboard([]); return; }
      db.ref('leaderboard').on('value', (snap) => {
        const val = snap.val() || {};
        const entries = Object.values(val)
          .filter(v => v && v.name)
          .sort((a,b) => (b.totalSeconds||0) - (a.totalSeconds||0))
          .slice(0, 10);
        renderLeaderboard(entries);
      }, (err) => {
        console.warn('Liderlik verisi okunamadı:', err);
        renderLeaderboard([]);
      });
    }

    /* ---------------- BAŞLAT ---------------- */
    listenLeaderboard();

    const existing = getStoredName();
    if(existing){
      startTracking(existing);
    }

    window.LB_checkName = function(){
      if(!getStoredName()){
        showNameModal();
      }
    };
    window.LB_startTracking = startTracking;
    window.LB_getActiveSeconds = () => activeAccumulated;
    window.LB_isIdle = isIdleNow;
    // progress.js için ek dışa açımlar: aynı Firebase app/db örneğini ve
    // güncel kullanıcı adını tekrar kullanabilsin (yeni bir Firebase app
    // başlatmaya çalışıp "already exists" hatası almasın diye).
    window.LB_getDb = () => db;
    window.LB_getUserName = () => currentName || getStoredName();
    window.LB_getTotalSeconds = (name, cb) => {
      if(!db){ cb(0); return; }
      const key = sanitizeKey(name);
      db.ref('leaderboard/' + key).once('value').then(snap=>{
        const val = snap.val();
        cb(val && typeof val.totalSeconds === 'number' ? val.totalSeconds : 0);
      }).catch(()=>cb(0));
    };
  }catch(err){
    console.error('Liderlik tablosu başlatılırken hata oluştu:', err);
  }
}

if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', initLeaderboard);
} else {
  initLeaderboard();
}
