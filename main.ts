import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { crypto } from "https://deno.land/std@0.177.0/crypto/mod.ts";

const kv = await Deno.openKv();

// --- HELPERS ---
async function hashPassword(p: string, s: string) {
  const data = new TextEncoder().encode(p + s);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function generateId() { return crypto.randomUUID(); }

// --- CRON JOB ---
Deno.cron("Save History", "*/5 * * * *", async () => {
  try {
    const res = await fetch("https://api.thaistock2d.com/live");
    const data = await res.json();
    const now = new Date();
    const mmDate = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Yangon" }));
    const dateKey = mmDate.getFullYear() + "-" + String(mmDate.getMonth() + 1).padStart(2, '0') + "-" + String(mmDate.getDate()).padStart(2, '0');
    if (mmDate.getDay() === 0 || mmDate.getDay() === 6) return; 

    let m = "--", e = "--";
    if (data.result) {
        if (data.result[1] && data.result[1].twod) m = data.result[1].twod;
        const ev = data.result[3] || data.result[2];
        if (ev && ev.twod) e = ev.twod;
    }
    if (m !== "--" || e !== "--") {
        const ex = await kv.get(["history", dateKey]);
        const old = ex.value as any || { morning: "--", evening: "--" };
        await kv.set(["history", dateKey], { morning: m!=="--"?m:old.morning, evening: e!=="--"?e:old.evening, date: dateKey });
    }
  } catch (e) {}
});

serve(async (req) => {
  const url = new URL(req.url);

  // --- PWA MANIFEST (NEW: Make it Full Screen) ---
  if (url.pathname === "/manifest.json") {
      return new Response(JSON.stringify({
          name: "VIP 2D",
          short_name: "VIP 2D",
          start_url: "/",
          display: "standalone", // This hides the browser bar
          background_color: "#0f172a",
          theme_color: "#0f172a",
          icons: [
              { src: "https://img.icons8.com/color/192/shop.png", sizes: "192x192", type: "image/png" },
              { src: "https://img.icons8.com/color/512/shop.png", sizes: "512x512", type: "image/png" }
          ]
      }), { headers: { "content-type": "application/json" } });
  }
  
  // --- AUTH ---
  if (req.method === "POST" && url.pathname === "/register") {
    const form = await req.formData();
    const u = form.get("username")?.toString().trim(); 
    const p = form.get("password")?.toString();
    const remember = form.get("remember");

    if (!u || !p) return Response.redirect(url.origin + "/?error=missing");
    const check = await kv.get(["users", u]);
    if (check.value) return Response.redirect(url.origin + "/?error=exists");
    
    const salt = generateId();
    const hash = await hashPassword(p, salt);
    await kv.set(["users", u], { passwordHash: hash, salt, balance: 0, joined: new Date().toISOString() });
    
    const h = new Headers({ "Location": "/" });
    let cookieStr = `user=${encodeURIComponent(u)}; Path=/; HttpOnly; SameSite=Lax`;
    if(remember) cookieStr += "; Max-Age=1296000"; 
    h.set("Set-Cookie", cookieStr);
    return new Response(null, { status: 303, headers: h });
  }

  if (req.method === "POST" && url.pathname === "/login") {
    const form = await req.formData();
    const u = form.get("username")?.toString().trim();
    const p = form.get("password")?.toString();
    const remember = form.get("remember");

    const entry = await kv.get(["users", u]);
    const data = entry.value as any;
    if (!data) return Response.redirect(url.origin + "/?error=invalid");
    const inputHash = await hashPassword(p, data.salt || "");
    const valid = data.passwordHash ? (inputHash === data.passwordHash) : (p === data.password);
    if (!valid) return Response.redirect(url.origin + "/?error=invalid");
    
    const h = new Headers({ "Location": "/" });
    let cookieStr = `user=${encodeURIComponent(u)}; Path=/; HttpOnly; SameSite=Lax`;
    if(remember) cookieStr += "; Max-Age=1296000"; 
    h.set("Set-Cookie", cookieStr);
    return new Response(null, { status: 303, headers: h });
  }

  if (url.pathname === "/logout") {
    const h = new Headers({ "Location": "/" });
    h.set("Set-Cookie", `user=; Path=/; Max-Age=0`);
    return new Response(null, { status: 303, headers: h });
  }

  const cookies = req.headers.get("Cookie") || "";
  const userCookie = cookies.split(";").find(c => c.trim().startsWith("user="));
  const currentUser = userCookie ? decodeURIComponent(userCookie.split("=")[1].trim()) : null;
  const isAdmin = currentUser === "admin"; 

  // --- ACTIONS ---
  if (currentUser && req.method === "POST") {
    if (url.pathname === "/update_avatar") {
        const form = await req.formData();
        const img = form.get("avatar")?.toString();
        if(img) {
            const u = await kv.get(["users", currentUser]);
            await kv.set(["users", currentUser], { ...u.value as any, avatar: img });
            return new Response(JSON.stringify({status:"ok"}));
        }
    }
    if (url.pathname === "/change_password") {
        const form = await req.formData();
        const p = form.get("new_password")?.toString();
        if(p) {
            const u = await kv.get(["users", currentUser]);
            const s = generateId();
            const h = await hashPassword(p, s);
            await kv.set(["users", currentUser], { ...u.value as any, passwordHash: h, salt: s });
            return Response.redirect(url.origin + "/profile?msg=pass_ok");
        }
    }
    if (url.pathname === "/clear_history") {
        const iter = kv.list({ prefix: ["bets"] });
        for await (const e of iter) {
            const b = e.value as any;
            if(b.user === currentUser && b.status !== "PENDING") await kv.delete(e.key);
        }
        return new Response(JSON.stringify({status:"ok"}));
    }
    if (url.pathname === "/delete_transaction") {
        const form = await req.formData();
        const id = form.get("id")?.toString();
        if(id) {
            await kv.delete(["transactions", id]);
            return new Response(JSON.stringify({status:"ok"}));
        }
    }

    // BETTING
    if (url.pathname === "/bet") {
        const now = new Date();
        const mmString = now.toLocaleString("en-US", { timeZone: "Asia/Yangon", hour12: false });
        const [h, m] = mmString.split(", ")[1].split(":").map(Number);
        const mins = h * 60 + m;
        const isClosed = (mins >= 710 && mins < 735) || (mins >= 950 || mins < 480);
        if (isClosed) return new Response(JSON.stringify({ status: "closed" }));

        const form = await req.formData();
        const nums = (form.get("number")?.toString() || "").split(",").map(n=>n.trim()).filter(n=>n);
        const amt = parseInt(form.get("amount")?.toString() || "0");
        if (!nums.length || amt < 50 || amt > 100000) return new Response(JSON.stringify({ status: "invalid_amt" }));

        for (const n of nums) {
            const b = await kv.get(["blocks", n]);
            if (b.value) return new Response(JSON.stringify({ status: "blocked", num: n }));
        }

        const cost = nums.length * amt;
        const userKey = ["users", currentUser];
        const userRes = await kv.get(userKey);
        const userData = userRes.value as any;

        if (!userData || (userData.balance || 0) < cost) return new Response(JSON.stringify({ status: "no_balance" }));

        let atomic = kv.atomic().check(userRes).set(userKey, { ...userData, balance: userData.balance - cost });
        
        const txTime = now.toLocaleString("en-US", { timeZone: "Asia/Yangon", hour12: true });
        const txDate = now.toLocaleString("en-US", { timeZone: "Asia/Yangon", day: 'numeric', month: 'short', year: 'numeric' });
        const batchId = Date.now().toString().slice(-6);

        for (const n of nums) {
            const betId = Date.now().toString() + Math.random().toString().slice(2,5);
            atomic = atomic.set(["bets", betId], { 
                user: currentUser, number: n, amount: amt, status: "PENDING", 
                time: txTime, rawMins: mins, batchId, date: txDate 
            });
        }
        
        const commit = await atomic.commit();
        if (!commit.ok) return new Response(JSON.stringify({ status: "retry" }));

        return new Response(JSON.stringify({ 
            status: "success", 
            voucher: { id: batchId, user: currentUser, date: txDate, time: txTime, nums, amt, total: cost } 
        }));
    }
  }

  // --- ADMIN ACTIONS ---
  if (isAdmin && req.method === "POST") {
      const form = await req.formData();
      
      if (url.pathname === "/admin/topup") {
          const u = form.get("username")?.toString().trim();
          const a = parseInt(form.get("amount")?.toString() || "0");
          if(u && a) {
              const res = await kv.get(["users", u]);
              if (res.value) {
                  await kv.set(["users", u], { ...res.value as any, balance: (res.value as any).balance + a });
                  await kv.set(["transactions", Date.now().toString()], { user: u, amount: a, type: "TOPUP", time: new Date().toLocaleString("en-US", { timeZone: "Asia/Yangon" }) });
                  return new Response(JSON.stringify({status:"success"}));
              }
          }
          return new Response(JSON.stringify({status:"error"}));
      }
      
      if (url.pathname === "/admin/payout") {
          const win = form.get("win_number")?.toString();
          const sess = form.get("session")?.toString(); 
          const rate = (await kv.get(["system", "rate"])).value as number || 80;
          const iter = kv.list({ prefix: ["bets"] });
          let winners = [];

          for await (const e of iter) {
              const b = e.value as any;
              if (b.status === "PENDING") {
                  const isM = b.rawMins < 735;
                  if ((sess === "MORNING" && isM) || (sess === "EVENING" && !isM)) {
                      if (b.number === win) {
                          const winAmt = b.amount * rate;
                          const uRes = await kv.get(["users", b.user]);
                          if (uRes.value) await kv.set(["users", b.user], { ...uRes.value as any, balance: (uRes.value as any).balance + winAmt });
                          await kv.set(["bets", e.key[1]], { ...b, status: "WIN", winAmount: winAmt });
                          winners.push({user: b.user, amount: winAmt});
                      } else {
                          await kv.set(["bets", e.key[1]], { ...b, status: "LOSE" });
                      }
                  }
              }
          }
          return new Response(JSON.stringify({status:"success", winners: winners}));
      }
      
      if (url.pathname === "/admin/reset_pass") {
          const u = form.get("username")?.toString().trim();
          const p = form.get("password")?.toString();
          if(u && p) {
              const res = await kv.get(["users", u]);
              if(res.value) {
                  const s = generateId();
                  const h = await hashPassword(p, s);
                  await kv.set(["users", u], { ...res.value as any, passwordHash: h, salt: s });
                  return new Response(JSON.stringify({status:"success"}));
              }
          }
          return new Response(JSON.stringify({status:"error"}));
      }
      
      if (url.pathname === "/admin/settings") {
         if(form.has("rate")) await kv.set(["system", "rate"], parseInt(form.get("rate")?.toString()||"80"));
         if(form.has("tip")) await kv.set(["system", "tip"], form.get("tip")?.toString());
         const kn = form.get("kpay_no"); const wn = form.get("wave_no");
         if(kn !== null || wn !== null) {
             const c = {
                 kpay_no: form.get("kpay_no") || "", kpay_name: form.get("kpay_name") || "",
                 wave_no: form.get("wave_no") || "", wave_name: form.get("wave_name") || "",
                 tele_link: form.get("tele_link") || ""
             };
             await kv.set(["system", "contact"], c);
         }
         return new Response(JSON.stringify({status:"success"}));
      }
      
      if (url.pathname === "/admin/block") {
          const act = form.get("action");
          const val = form.get("val");
          const type = form.get("type");
          if (act === "clear") { for await (const e of kv.list({ prefix: ["blocks"] })) await kv.delete(e.key); }
          else if (act === "del" && val) await kv.delete(["blocks", val]);
          else if (act === "add" && val) {
              let nums = [];
              if (type === "direct") nums.push(val.padStart(2,'0'));
              if (type === "head") for(let i=0;i<10;i++) nums.push(val+i);
              if (type === "tail") for(let i=0;i<10;i++) nums.push(i+val);
              for(const n of nums) if(n.length===2) await kv.set(["blocks", n], true);
          }
          return new Response(JSON.stringify({status:"success"}));
      }
      
      if (url.pathname === "/admin/add_history") {
          const d = form.get("date")?.toString();
          const m = form.get("morning")?.toString();
          const e = form.get("evening")?.toString();
          if(d) {
              await kv.set(["history", d], { date: d, morning: m, evening: e });
              return new Response(JSON.stringify({status:"success"}));
          }
          return new Response(JSON.stringify({status:"error"}));
      }

      if (url.pathname === "/admin/delete_bet") {
          const id = form.get("id")?.toString();
          if(id) {
              await kv.delete(["bets", id]);
              return new Response(JSON.stringify({status:"success"}));
          }
          return new Response(JSON.stringify({status:"error"}));
      }
  }

  // --- UI TEMPLATE ---
  const commonHead = `
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#0f172a">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
  <script src="https://html2canvas.hertzen.com/dist/html2canvas.min.js"></script>
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;700&family=Roboto+Mono:wght@500&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Poppins', sans-serif; background: #0f172a; color: #e2e8f0; -webkit-tap-highlight-color: transparent; padding-bottom: 80px; }
    .font-mono { font-family: 'Roboto Mono', monospace; }
    .glass { background: rgba(30, 41, 59, 0.7); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.05); }
    .gold-text { background: linear-gradient(to right, #bf953f, #fcf6ba, #b38728, #fbf5b7, #aa771c); -webkit-background-clip: text; color: transparent; }
    .gold-bg { background: linear-gradient(to bottom right, #bf953f, #aa771c); color: #000; }
    .input-dark { background: #1e293b; border: 1px solid #334155; color: white; border-radius: 0.5rem; padding: 0.5rem; width: 100%; }
    .input-dark:focus { outline: none; border-color: #eab308; }
    .loader { border: 3px solid #f3f3f3; border-top: 3px solid #eab308; border-radius: 50%; width: 24px; height: 24px; animation: spin 1s linear infinite; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    .slide-up { animation: slideUp 0.3s ease-out; }
    @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
    .nav-item.active { color: #eab308; }
    .nav-item.active i { transform: translateY(-5px); transition: 0.3s; }
  </style>
  <script>
    function showLoad() { document.getElementById('loader').classList.remove('hidden'); }
    function hideLoad() { document.getElementById('loader').classList.add('hidden'); }
    function doLogout() { showLoad(); setTimeout(() => window.location.href = '/logout', 800); }
    
    // Refresh Loading Listener
    window.addEventListener('beforeunload', () => showLoad());

    async function adminSubmit(e) {
        e.preventDefault(); showLoad();
        const f = e.target, fd = new FormData(f), u = f.getAttribute('action');
        try {
            const r = await fetch(u, {method:'POST', body:fd});
            const d = await r.json();
            hideLoad();
            if(d.status === 'success') {
                if(d.winners && d.winners.length > 0) {
                    const list = d.winners.map(w => \`<div class="flex justify-between border-b border-gray-600 py-1"><span>\${w.user}</span><span class="text-yellow-400">\${w.amount}</span></div>\`).join('');
                    Swal.fire({title:'Payout Winners', html: \`<div class="text-left text-sm max-h-40 overflow-y-auto">\${list}</div>\`, icon:'success', background:'#1e293b', color:'#fff'}).then(()=>location.reload());
                } else if(d.winners) {
                    Swal.fire({title:'No Winners', text:'No one won this round.', icon:'info', background:'#1e293b', color:'#fff'}).then(()=>location.reload());
                } else {
                    Swal.fire({icon:'success', title:'Success', timer:1500, showConfirmButton:false, background:'#1e293b', color:'#fff'}).then(()=>location.reload());
                }
            } else Swal.fire({icon:'error', title:'Failed', background:'#1e293b', color:'#fff'});
        } catch(e) { hideLoad(); Swal.fire({icon:'error', title:'Error', background:'#1e293b', color:'#fff'}); }
    }
    function delBet(id) {
        Swal.fire({title:'Delete Bet?', icon:'warning', showCancelButton:true, confirmButtonColor:'#d33', background:'#1e293b', color:'#fff'}).then(r => {
            if(r.isConfirmed) {
                showLoad(); const fd = new FormData(); fd.append('id', id);
                fetch('/admin/delete_bet', {method:'POST', body:fd}).then(res=>res.json()).then(d=>{
                    hideLoad(); if(d.status==='success') location.reload(); else Swal.fire('Error','Failed','error');
                });
            }
        });
    }
  </script>`;

  const loaderHTML = `<div id="loader" class="fixed inset-0 bg-black/90 z-[9999] hidden flex items-center justify-center"><div class="loader w-10 h-10"></div></div>`;
  const navHTML = `
  <div class="fixed bottom-0 w-full glass border-t border-white/10 pb-safe flex justify-around items-center h-16 z-40">
      <a href="/" onclick="showLoad()" class="nav-item ${url.pathname==='/'?'active':''} flex flex-col items-center text-gray-400 hover:text-yellow-500"><i class="fas fa-home text-lg"></i><span class="text-[10px] mt-1">Home</span></a>
      <a href="/history" onclick="showLoad()" class="nav-item ${url.pathname==='/history'?'active':''} flex flex-col items-center text-gray-400 hover:text-yellow-500"><i class="fas fa-calendar-alt text-lg"></i><span class="text-[10px] mt-1">History</span></a>
      <a href="/profile" onclick="showLoad()" class="nav-item ${url.pathname==='/profile'?'active':''} flex flex-col items-center text-gray-400 hover:text-yellow-500"><i class="fas fa-user-circle text-lg"></i><span class="text-[10px] mt-1">Profile</span></a>
  </div>`;

  // --- LOGIN PAGE ---
  if (!currentUser) {
    return new Response(`<!DOCTYPE html><html><head><title>Login</title>${commonHead}</head><body class="flex items-center justify-center min-h-screen bg-[url('https://images.unsplash.com/photo-1605218427360-36390f8584b0')] bg-cover bg-center">
    <div class="absolute inset-0 bg-black/80"></div>${loaderHTML}
    <div class="relative z-10 w-full max-w-sm p-6">
      <div class="text-center mb-8"><i class="fas fa-crown text-5xl gold-text mb-2"></i><h1 class="text-3xl font-bold text-white tracking-widest">VIP 2D</h1><p class="text-gray-400 text-xs uppercase tracking-[0.2em]">Premium Betting</p></div>
      <div class="glass rounded-2xl p-6 shadow-2xl border-t border-white/10">
        <div class="flex mb-6 bg-slate-800/50 rounded-lg p-1">
           <button onclick="switchTab('login')" id="tabLogin" class="flex-1 py-2 text-sm font-bold rounded-md bg-slate-700 text-white transition-all">LOGIN</button>
           <button onclick="switchTab('reg')" id="tabReg" class="flex-1 py-2 text-sm font-bold rounded-md text-gray-400 hover:text-white transition-all">REGISTER</button>
        </div>
        <form id="loginForm" action="/login" method="POST" onsubmit="showLoad()">
           <div class="space-y-4">
               <div class="relative"><i class="fas fa-user absolute left-3 top-3.5 text-gray-500"></i><input name="username" placeholder="Username" class="w-full pl-10 p-3 rounded-xl input-dark" required></div>
               <div class="relative"><i class="fas fa-lock absolute left-3 top-3.5 text-gray-500"></i><input name="password" type="password" placeholder="Password" class="w-full pl-10 p-3 rounded-xl input-dark" required></div>
               <label class="flex items-center text-xs text-gray-400"><input type="checkbox" name="remember" class="mr-2" checked> Remember Me (15 Days)</label>
               <button class="w-full py-3 rounded-xl gold-bg font-bold shadow-lg text-black">LOGIN NOW</button>
           </div>
        </form>
        <form id="regForm" action="/register" method="POST" class="hidden" onsubmit="showLoad()">
            <div class="space-y-4">
                <div class="relative"><i class="fas fa-user-plus absolute left-3 top-3.5 text-gray-500"></i><input name="username" placeholder="Create Username" class="w-full pl-10 p-3 rounded-xl input-dark" required></div>
                <div class="relative"><i class="fas fa-key absolute left-3 top-3.5 text-gray-500"></i><input name="password" type="password" placeholder="Create Password" class="w-full pl-10 p-3 rounded-xl input-dark" required></div>
                <label class="flex items-center text-xs text-gray-400"><input type="checkbox" name="remember" class="mr-2" checked> Remember Me (15 Days)</label>
                <button class="w-full py-3 rounded-xl bg-slate-700 text-white font-bold hover:bg-slate-600">CREATE ACCOUNT</button>
            </div>
        </form>
      </div>
    </div>
    <script>
      function switchTab(t) { const l=document.getElementById('loginForm'),r=document.getElementById('regForm'),tl=document.getElementById('tabLogin'),tr=document.getElementById('tabReg'); if(t==='login'){l.classList.remove('hidden');r.classList.add('hidden');tl.className="flex-1 py-2 text-sm font-bold rounded-md bg-slate-700 text-white shadow";tr.className="flex-1 py-2 text-sm font-bold rounded-md text-gray-400";}else{l.classList.add('hidden');r.classList.remove('hidden');tr.className="flex-1 py-2 text-sm font-bold rounded-md bg-slate-700 text-white shadow";tl.className="flex-1 py-2 text-sm font-bold rounded-md text-gray-400";} }
      const u=new URLSearchParams(location.search); if(u.get('error')) Swal.fire({icon:'error',title:'Error',text:'Invalid Login or Exists',background:'#1e293b',color:'#fff'});
    </script></body></html>`, { headers: { "content-type": "text/html" } });
  }

  // --- FETCH DATA ---
  const uKey = ["users", currentUser];
  const uData = (await kv.get(uKey)).value as any;
  const balance = uData?.balance || 0;
  const avatar = uData?.avatar || "";
  const dateStr = new Date().toLocaleString("en-US", {timeZone:"Asia/Yangon", day:'numeric', month:'short', year:'numeric'});

  // --- PROFILE ---
  if (url.pathname === "/profile") {
      const txs = [];
      for await (const e of kv.list({prefix:["transactions"]}, {reverse:true, limit:50})) { if(e.value.user===currentUser) { const t = e.value; t.id=e.key[1]; txs.push(t); } }
      const contact = (await kv.get(["system", "contact"])).value as any || {};
      
      let todayWin = 0, todayLose = 0;
      const bIter = kv.list({ prefix: ["bets"] });
      for await (const e of bIter) { 
          const b = e.value as any; 
          if(b.user === currentUser && b.date === dateStr) {
             if(b.status === 'WIN') todayWin += (b.winAmount || 0);
             if(b.status === 'LOSE') todayLose += b.amount;
          }
      }

      return new Response(`<!DOCTYPE html><html><head><title>Profile</title>${commonHead}</head><body>${loaderHTML}${navHTML}
      <div class="p-6 max-w-md mx-auto space-y-4 pb-24">
         <div class="glass p-6 rounded-3xl text-center relative mt-4">
            <div class="relative w-24 h-24 mx-auto mb-3">
                <div class="w-24 h-24 rounded-full border-4 border-yellow-500 overflow-hidden relative bg-slate-800 flex items-center justify-center">
                    ${avatar ? `<img src="${avatar}" class="w-full h-full object-cover">` : `<i class="fas fa-user text-4xl text-gray-500"></i>`}
                </div>
                <button onclick="document.getElementById('fIn').click()" class="absolute bottom-0 right-0 bg-white text-black rounded-full p-2 border-2 border-slate-900"><i class="fas fa-camera text-xs"></i></button>
                <input type="file" id="fIn" hidden accept="image/*" onchange="upAv(this)">
            </div>
            <h1 class="text-xl font-bold text-white uppercase">${currentUser}</h1>
            <div class="text-yellow-500 font-mono font-bold text-lg">${balance.toLocaleString()} Ks</div>
         </div>

         <div class="grid grid-cols-2 gap-2 text-center">
            <div class="glass p-3 rounded-xl border-l-2 border-green-500">
                <div class="text-xs text-gray-400">Today Win</div>
                <div class="font-bold text-green-400 text-sm">+${todayWin.toLocaleString()}</div>
            </div>
            <div class="glass p-3 rounded-xl border-l-2 border-red-500">
                <div class="text-xs text-gray-400">Today Loss</div>
                <div class="font-bold text-red-400 text-sm">-${todayLose.toLocaleString()}</div>
            </div>
         </div>
         
         <div class="glass p-4 rounded-xl space-y-3">
            <h3 class="text-xs font-bold text-gray-400 uppercase">Contact Admin</h3>
            <div class="grid grid-cols-2 gap-2">
                <div class="bg-blue-900/40 p-2 rounded border border-blue-500/30 text-center"><div class="text-blue-400 text-xs">KPay</div><div class="font-bold select-all text-sm">${contact.kpay_no||'-'}</div><div class="text-[10px] text-gray-500">${contact.kpay_name||''}</div></div>
                <div class="bg-yellow-900/40 p-2 rounded border border-yellow-500/30 text-center"><div class="text-yellow-400 text-xs">Wave</div><div class="font-bold select-all text-sm">${contact.wave_no||'-'}</div><div class="text-[10px] text-gray-500">${contact.wave_name||''}</div></div>
            </div>
            <a href="${contact.tele_link||'#'}" target="_blank" class="block w-full bg-blue-600 text-white text-center py-2 rounded font-bold"><i class="fab fa-telegram"></i> Telegram Channel</a>
         </div>

         <form action="/change_password" method="POST" class="glass p-4 rounded-xl flex gap-2" onsubmit="showLoad()">
            <input type="password" name="new_password" placeholder="New Password" class="input-dark text-sm" required>
            <button class="bg-yellow-600 text-white px-4 rounded font-bold text-xs">CHANGE</button>
         </form>

         <div class="glass rounded-xl p-4">
            <h3 class="text-xs font-bold text-gray-400 uppercase mb-3">Top-Up History</h3>
            <div class="space-y-2 h-48 overflow-y-auto">
                ${txs.length?txs.map(t=>`
                <div class="flex justify-between items-center p-2 bg-slate-800 rounded border-l-2 border-green-500" onclick="showTx('${t.time}', '${t.amount}', '${t.type}')">
                    <div><span class="text-xs text-gray-400 block">${t.time}</span><span class="text-[10px] text-blue-400 font-bold">Admin Top-up</span></div>
                    <div class="flex items-center gap-2">
                        <span class="font-bold text-green-400">+${t.amount}</span>
                        <button onclick="delTx(event, '${t.id}')" class="text-gray-600 hover:text-red-500"><i class="fas fa-trash text-xs"></i></button>
                    </div>
                </div>`).join(''):'<div class="text-center text-xs text-gray-500">No transactions</div>'}
            </div>
         </div>
         <button onclick="doLogout()" class="block w-full text-center text-red-400 text-sm font-bold py-4">LOGOUT</button>
      </div>
      <script>
        function upAv(i){ if(i.files&&i.files[0]){ const r=new FileReader(); r.onload=function(e){ const im=new Image(); im.src=e.target.result; im.onload=function(){ const c=document.createElement('canvas'); const x=c.getContext('2d'); c.width=150;c.height=150; x.drawImage(im,0,0,150,150); showLoad(); const fd=new FormData(); fd.append('avatar',c.toDataURL('image/jpeg',0.7)); fetch('/update_avatar',{method:'POST',body:fd}).then(res=>res.json()).then(d=>{hideLoad();location.reload();}); }}; r.readAsDataURL(i.files[0]); }}
        const u=new URLSearchParams(location.search); if(u.get('msg')==='pass_ok') Swal.fire({icon:'success',title:'Password Changed',background:'#1e293b',color:'#fff'});
        
        function showTx(t, a, type) {
            Swal.fire({ title: 'Transaction', html: \`<div class="text-left">Type: <b>\${type}</b><br>Amount: <b class="text-green-400">\${a} Ks</b><br>Time: \${t}</div>\`, background:'#1e293b', color:'#fff' });
        }
        function delTx(e, id) {
            e.stopPropagation();
            Swal.fire({title:'Delete Record?', icon:'warning', showCancelButton:true, confirmButtonColor:'#d33', background:'#1e293b', color:'#fff'}).then(r => {
                if(r.isConfirmed) {
                    const fd = new FormData(); fd.append('id', id);
                    fetch('/delete_transaction', {method:'POST', body:fd}).then(res=>res.json()).then(d=>{ if(d.status==='ok') location.reload(); });
                }
            });
        }
      </script></body></html>`, { headers: {"content-type": "text/html"} });
  }

  // --- 2D HISTORY ---
  if (url.pathname === "/history") {
      const hList = [];
      for await (const e of kv.list({prefix:["history"]}, {reverse:true, limit:31})) hList.push(e.value);
      return new Response(`<!DOCTYPE html><html><head><title>2D History</title>${commonHead}</head><body>${loaderHTML}${navHTML}
      <div class="p-4 max-w-md mx-auto pt-4 pb-20">
         <h2 class="text-xl font-bold text-white mb-4 text-center">Past Results</h2>
         <div class="glass rounded-xl overflow-hidden">
            <div class="grid grid-cols-3 bg-slate-800 p-3 text-xs font-bold text-gray-400 text-center uppercase"><div>Date</div><div>12:01</div><div>04:30</div></div>
            <div class="divide-y divide-gray-700">
               ${hList.map(h=>`<div class="grid grid-cols-3 p-3 text-center items-center"><div class="text-xs text-gray-400">${h.date}</div><div class="font-bold text-lg text-white">${h.morning}</div><div class="font-bold text-lg text-yellow-500">${h.evening}</div></div>`).join('')}
            </div>
         </div>
      </div></body></html>`, { headers: {"content-type": "text/html"} });
  }

  // --- DASHBOARD ---
  const sys = {
      rate: (await kv.get(["system", "rate"])).value || 80,
      tip: (await kv.get(["system", "tip"])).value || ""
  };
  const bets = [];
  const bIter = kv.list({ prefix: ["bets"] }, { reverse: true, limit: isAdmin ? 100 : 50 });
  for await (const e of bIter) { 
      const val = e.value as any;
      val.id = e.key[1]; 
      if (isAdmin || val.user === currentUser) bets.push(val); 
  }
  const blocks = []; for await (const e of kv.list({ prefix: ["blocks"] })) blocks.push(e.key[1]);

  let stats = { sale: 0, payout: 0 };
  if (isAdmin) {
      const all = kv.list({ prefix: ["bets"] });
      for await (const e of all) {
          const b = e.value as any;
          const d = new Date(parseInt(e.key[1])).toLocaleString("en-US", { timeZone: "Asia/Yangon", day: 'numeric', month: 'short', year: 'numeric' });
          if (d === dateStr) { stats.sale += b.amount; if(b.status==="WIN") stats.payout += b.winAmount; }
      }
  }

  return new Response(`
    <!DOCTYPE html><html><head><title>Home</title>${commonHead}</head><body>${loaderHTML}
    <nav class="glass fixed top-0 w-full z-50 px-4 py-3 flex justify-between items-center shadow-lg">
        <div class="flex items-center gap-2">
           <div class="w-8 h-8 rounded-full gold-bg flex items-center justify-center font-bold text-black text-sm border-2 border-white overflow-hidden">
               ${avatar ? `<img src="${avatar}" class="w-full h-full object-cover">` : currentUser[0].toUpperCase()}
           </div>
           <div><div class="text-[10px] text-gray-400 uppercase">Balance</div><div class="text-sm font-bold text-white font-mono">${balance.toLocaleString()} Ks</div></div>
        </div>
        ${isAdmin ? '<span class="bg-red-600 text-[10px] px-2 py-1 rounded font-bold">ADMIN</span>' : ''}
    </nav>

    <div class="pt-20 px-4 pb-24 max-w-md mx-auto space-y-6">
        <div class="glass rounded-3xl p-6 text-center relative overflow-hidden group">
            <div class="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-yellow-500 to-transparent opacity-50"></div>
            <div class="flex justify-between text-xs text-gray-400 mb-2 font-mono"><span id="live_date">--</span><span class="text-red-500 animate-pulse font-bold">● LIVE</span></div>
            <div class="py-2"><div id="live_twod" class="text-7xl font-bold gold-text font-mono drop-shadow-lg tracking-tighter">--</div><div class="text-xs text-gray-500 mt-2 font-mono">Updated: <span id="live_time">--:--:--</span></div></div>
            <div class="grid grid-cols-2 gap-2 mt-4 pt-4 border-t border-white/5"><div class="bg-black/20 rounded-lg p-2"><div class="text-[10px] text-gray-500">12:01 PM</div><div class="font-bold text-lg" id="res_12">--</div></div><div class="bg-black/20 rounded-lg p-2"><div class="text-[10px] text-gray-500">04:30 PM</div><div class="font-bold text-lg" id="res_430">--</div></div></div>
        </div>

        ${sys.tip ? `<div class="glass p-4 rounded-xl border-l-4 border-yellow-500 flex items-center gap-3"><div class="bg-yellow-500/20 p-2 rounded-full"><i class="fas fa-lightbulb text-yellow-500"></i></div><div class="flex-1"><div class="flex justify-between items-center text-[10px] text-gray-400 uppercase font-bold"><span>Daily Tip</span><span>${dateStr}</span></div><div class="font-bold text-sm text-white">${sys.tip}</div></div></div>` : ''}

        ${!isAdmin ? `<button onclick="openBet()" class="w-full gold-bg p-4 rounded-2xl shadow-lg shadow-yellow-600/20 flex items-center justify-center gap-2 active:scale-95 transition-transform"><i class="fas fa-plus-circle text-xl"></i><span class="font-bold">BET NOW (ထိုးမည်)</span></button>` : ''}

        ${isAdmin ? `
        <div class="space-y-4">
            <div class="grid grid-cols-3 gap-2 text-center text-xs">
                <div class="glass p-2 rounded"><div class="text-green-400">Sale</div><div class="font-mono font-bold">${stats.sale.toLocaleString()}</div></div>
                <div class="glass p-2 rounded"><div class="text-red-400">Payout</div><div class="font-mono font-bold">${stats.payout.toLocaleString()}</div></div>
                <div class="glass p-2 rounded"><div class="text-blue-400">Profit</div><div class="font-mono font-bold">${(stats.sale-stats.payout).toLocaleString()}</div></div>
            </div>
            <div class="glass p-4 rounded-xl space-y-4">
                <h3 class="text-xs font-bold text-gray-400 uppercase">Management</h3>
                <form action="/admin/payout" method="POST" onsubmit="adminSubmit(event)" class="flex gap-2"><select name="session" class="input-dark text-xs"><option value="MORNING">12:01 PM</option><option value="EVENING">04:30 PM</option></select><input name="win_number" placeholder="Win" class="input-dark w-16 text-center"><button class="bg-red-600 text-white text-xs px-3 rounded font-bold">PAY</button></form>
                <form action="/admin/topup" method="POST" onsubmit="adminSubmit(event)" class="flex gap-2"><input name="username" placeholder="User" class="input-dark text-xs"><input name="amount" type="number" placeholder="Amt" class="input-dark w-20 text-xs"><button class="bg-green-600 text-white text-xs px-3 rounded font-bold">TOP</button></form>
                <form action="/admin/block" method="POST" onsubmit="adminSubmit(event)" class="flex gap-2"><input type="hidden" name="action" value="add"><select name="type" class="input-dark text-xs w-20"><option value="direct">One</option><option value="head">Head</option><option value="tail">Tail</option></select><input name="val" placeholder="Num" class="input-dark w-16 text-xs text-center"><button class="bg-gray-600 text-white text-xs px-2 rounded font-bold">BLK</button><button onclick="this.form.action.value='clear'" class="bg-red-900 text-white text-xs px-2 rounded font-bold">CLR</button></form>
                <form action="/admin/settings" method="POST" onsubmit="adminSubmit(event)" class="space-y-2 border-t border-gray-700 pt-2"><div class="flex gap-2"><input name="rate" placeholder="Rate (80)" class="input-dark text-xs"><input name="tip" placeholder="Daily Tip" class="input-dark text-xs"></div><div class="flex gap-2"><input name="kpay_no" placeholder="Kpay" class="input-dark text-xs"><input name="kpay_name" placeholder="Kname" class="input-dark text-xs"></div><div class="flex gap-2"><input name="wave_no" placeholder="Wave" class="input-dark text-xs"><input name="wave_name" placeholder="Wname" class="input-dark text-xs"></div><input name="tele_link" placeholder="Tele Link" class="input-dark text-xs"><button class="w-full bg-blue-600 text-white text-xs py-2 rounded font-bold">UPDATE SETTINGS</button></form>
                <form action="/admin/reset_pass" method="POST" onsubmit="adminSubmit(event)" class="flex gap-2 border-t border-gray-700 pt-2"><input name="username" placeholder="User" class="input-dark text-xs"><input name="password" placeholder="New Pass" class="input-dark text-xs"><button class="bg-yellow-600 text-white text-xs px-2 rounded font-bold">RESET</button></form>
                <form action="/admin/add_history" method="POST" onsubmit="adminSubmit(event)" class="flex gap-2 border-t border-gray-700 pt-2"><input type="date" name="date" class="input-dark text-xs w-1/3"><input name="morning" placeholder="12:01" class="input-dark text-xs w-1/4"><input name="evening" placeholder="04:30" class="input-dark text-xs w-1/4"><button class="bg-purple-600 text-white text-xs px-2 rounded font-bold">ADD</button></form>
                <div class="flex flex-wrap gap-1 mt-2">${blocks.map(b=>`<span class="text-[10px] bg-red-500/20 text-red-400 px-2 py-1 rounded">${b}</span>`).join('')}</div>
            </div>
        </div>` : ''}

        <div class="glass rounded-xl p-4">
             <div class="flex justify-between items-center mb-3">
                <h3 class="font-bold text-gray-300 text-sm">Betting History</h3>
                <div class="flex gap-2">
                    <input id="searchBet" onkeyup="filterBets()" placeholder="Search Num..." class="bg-black/30 border border-gray-600 text-white text-xs rounded px-2 py-1 w-24 focus:outline-none focus:border-yellow-500">
                    ${!isAdmin?`<button onclick="clrH()" class="text-xs text-red-400 px-1"><i class="fas fa-trash"></i></button>`:''}
                </div>
             </div>
             <div class="space-y-2 max-h-60 overflow-y-auto pr-1" id="betListContainer">
                 ${bets.length === 0 ? '<div class="text-center text-gray-500 text-xs py-4">No data</div>' : ''}
                 ${bets.map(b => `<div class="bet-item flex justify-between items-center p-3 rounded-lg bg-black/20 border-l-2 ${b.status==='WIN'?'border-green-500':b.status==='LOSE'?'border-red-500':'border-yellow-500'}" data-num="${b.number}" data-id="${b.id}" data-date="${b.date}" data-status="${b.status}" data-win="${b.winAmount||0}" data-user="${b.user}"><div><div class="font-mono font-bold text-lg ${b.status==='WIN'?'text-green-400':b.status==='LOSE'?'text-red-400':'text-white'}">${b.number}</div><div class="text-[10px] text-gray-500">${b.time}</div></div><div class="flex items-center gap-2"><div class="text-right"><div class="font-mono text-sm font-bold">${b.amount.toLocaleString()}</div><div class="text-[10px] font-bold ${b.status==='WIN'?'text-green-500':b.status==='LOSE'?'text-red-500':'text-yellow-500'}">${b.status}</div></div>${isAdmin?`<button onclick="delBet('${b.id}')" class="text-red-500 text-xs bg-red-500/10 p-2 rounded hover:bg-red-500 hover:text-white"><i class="fas fa-trash"></i></button>`:''}</div></div>`).join('')}
             </div>
        </div>
    </div>
    ${navHTML}

    <div id="betModal" class="fixed inset-0 z-[100] hidden"><div class="absolute inset-0 bg-black/80 backdrop-blur-sm" onclick="document.getElementById('betModal').classList.add('hidden')"></div><div class="absolute bottom-0 w-full bg-[#1e293b] rounded-t-3xl p-6 slide-up shadow-2xl border-t border-yellow-500/30">
          <div class="flex justify-between items-center mb-4"><h2 class="text-xl font-bold text-white">Place Bet</h2><button onclick="document.getElementById('betModal').classList.add('hidden')" class="text-gray-400 text-2xl">&times;</button></div>
          <div class="flex gap-2 mb-4 overflow-x-auto pb-2 no-scrollbar"><button onclick="setMode('direct')" class="px-4 py-1 bg-yellow-500 text-black text-xs font-bold rounded-full whitespace-nowrap">Direct</button><button onclick="quickInput('brake')" class="px-4 py-1 bg-slate-700 text-white text-xs font-bold rounded-full border border-slate-600">Brake</button><button onclick="quickInput('round')" class="px-4 py-1 bg-slate-700 text-white text-xs font-bold rounded-full border border-slate-600">Double</button><button onclick="quickInput('head')" class="px-4 py-1 bg-slate-700 text-white text-xs font-bold rounded-full border border-slate-600">Head</button><button onclick="quickInput('tail')" class="px-4 py-1 bg-slate-700 text-white text-xs font-bold rounded-full border border-slate-600">Tail</button></div>
          <form onsubmit="confirmBet(event)"><div class="bg-black/30 p-3 rounded-xl border border-white/5 mb-4"><textarea id="betNums" name="number" class="w-full bg-transparent text-lg font-mono font-bold text-white placeholder-gray-600 focus:outline-none resize-none h-20" placeholder="12, 34, 56..."></textarea></div><div class="mb-6"><label class="text-xs text-gray-400 uppercase font-bold">Amount</label><input type="number" name="amount" id="betAmt" class="w-full p-3 bg-black/30 text-white font-bold focus:outline-none rounded-xl mt-2 border border-white/5" placeholder="Min 50" required></div><button class="w-full py-4 rounded-xl gold-bg text-black font-bold text-lg">CONFIRM</button></form>
    </div></div>

    <div id="voucherModal" class="fixed inset-0 z-[110] hidden flex items-center justify-center p-6"><div class="absolute inset-0 bg-black/90" onclick="closeVoucher()"></div>
      <div class="relative w-full max-w-xs bg-white text-slate-900 rounded-lg overflow-hidden shadow-2xl slide-up">
         <div id="voucherCapture" class="bg-white">
             <div class="bg-slate-900 text-white p-3 text-center font-bold uppercase text-sm border-b-4 border-yellow-500">Success</div>
             <div class="p-4 font-mono text-sm" id="voucherContent"></div>
         </div>
         <div class="p-3 bg-gray-100 text-center flex gap-2">
             <button onclick="saveVoucher()" class="flex-1 bg-blue-600 text-white text-xs font-bold py-2 rounded shadow">Save Image</button>
             <button onclick="closeVoucher()" class="flex-1 text-xs font-bold text-slate-500 uppercase tracking-wide border border-slate-300 rounded py-2">Close</button>
         </div>
      </div>
    </div>

    <script>
        const API="https://api.thaistock2d.com/live";
        async function upL(){try{const r=await fetch(API);const d=await r.json();if(d.live){document.getElementById('live_twod').innerText=d.live.twod||"--";document.getElementById('live_time').innerText=d.live.time||"--:--:--";document.getElementById('live_date').innerText=d.live.date||"Today";}if(d.result){if(d.result[1])document.getElementById('res_12').innerText=d.result[1].twod||"--";const ev=d.result[3]||d.result[2];if(ev)document.getElementById('res_430').innerText=ev.twod||"--";}}catch(e){}}setInterval(upL,2000);upL();
        
        function filterBets() { const v = document.getElementById('searchBet').value.trim(); document.querySelectorAll('.bet-item').forEach(i => { i.style.display = i.getAttribute('data-num').includes(v) ? 'flex' : 'none'; }); }
        function closeVoucher() { showLoad(); setTimeout(() => location.reload(), 100); }
        function openBet(){document.getElementById('betModal').classList.remove('hidden');}
        function quickInput(m){Swal.fire({title:m.toUpperCase(),input:'number',background:'#1e293b',color:'#fff',confirmButtonColor:'#eab308'}).then(r=>{if(r.isConfirmed&&r.value){const v=r.value;let a=[];if(m==='round')for(let i=0;i<10;i++)a.push(i+""+i);if(m==='head')for(let i=0;i<10;i++)a.push(v+i);if(m==='tail')for(let i=0;i<10;i++)a.push(i+v);if(m==='brake'){if(v.length===2)a=v[0]===v[1]?[v]:[v,v[1]+v[0]];}const t=document.getElementById('betNums');let c=t.value.trim();if(c&&!c.endsWith(','))c+=',';t.value=c+a.join(',');}});}
        
        function confirmBet(e) {
            e.preventDefault();
            const n = document.getElementById('betNums').value;
            const a = document.getElementById('betAmt').value;
            const count = n.split(',').filter(x=>x.trim()).length;
            const total = count * parseInt(a);
            
            Swal.fire({
                title: 'Confirm Bet?',
                html: \`Numbers: <b>\${count}</b><br>Amount: <b>\${a}</b><br>Total: <b class="text-yellow-400">\${total.toLocaleString()} Ks</b>\`,
                icon: 'question',
                showCancelButton: true,
                confirmButtonText: 'Submit',
                confirmButtonColor: '#eab308',
                background: '#1e293b', color: '#fff'
            }).then((result) => {
                if (result.isConfirmed) {
                   submitBetData(e.target);
                }
            });
        }

        async function submitBetData(form) {
            showLoad();
            const fd=new FormData(form);
            try {
                const r=await fetch('/bet',{method:'POST',body:fd});
                const d=await r.json();
                hideLoad();
                if(d.status==='success'){
                    document.getElementById('betModal').classList.add('hidden');
                    const v=d.voucher;
                    document.getElementById('voucherContent').innerHTML=\`
                        <div class="text-center mb-2"><div class="font-bold">\${v.user}</div><div class="text-xs text-gray-500">\${v.time}</div></div>
                        <div class="border-y border-dashed border-gray-300 py-2 my-2 space-y-1 max-h-40 overflow-y-auto">
                            \${v.nums.map(n=>\`<div class="flex justify-between"><span>\${n}</span><span>\${v.amt}</span></div>\`).join('')}
                        </div>
                        <div class="flex justify-between font-bold text-lg"><span>Total</span><span>\${v.total}</span></div>
                        <div class="text-center text-xs font-bold text-yellow-600 mt-2">ကံကောင်းပါစေ (Good Luck)</div>
                    \`;
                    document.getElementById('voucherModal').classList.remove('hidden');
                } else Swal.fire('Error',d.status,'error');
            } catch(e){ hideLoad(); }
        }

        function saveVoucher() {
            const el = document.getElementById('voucherCapture');
            html2canvas(el).then(canvas => {
                const link = document.createElement('a');
                link.download = '2d_voucher_' + Date.now() + '.png';
                link.href = canvas.toDataURL();
                link.click();
            });
        }
        
        function clrH(){ Swal.fire({title:'Clear History?',text:'Only completed bets will be removed.',icon:'warning',showCancelButton:true,confirmButtonColor:'#d33',background:'#1e293b',color:'#fff'}).then(r=>{if(r.isConfirmed){showLoad();fetch('/clear_history',{method:'POST'}).then(res=>res.json()).then(d=>{hideLoad();Swal.fire({title:'Deleted!',icon:'success',timer:1500,showConfirmButton:false,background:'#1e293b',color:'#fff'}).then(()=>location.reload());});}}) }

        // WINNER ALERT
        window.onload = function() {
            const today = "${dateStr}";
            const currentUser = "${currentUser}";
            const bets = document.querySelectorAll('.bet-item');
            let totalWin = 0;
            bets.forEach(b => {
                if(b.dataset.status === "WIN" && b.dataset.date === today && b.dataset.user === currentUser) {
                    const id = b.dataset.id;
                    if(!localStorage.getItem('seen_win_'+id)) {
                        totalWin += parseInt(b.dataset.win);
                        localStorage.setItem('seen_win_'+id, 'true');
                    }
                }
            });
            
            if(totalWin > 0) {
                Swal.fire({
                    title: 'CONGRATULATIONS!',
                    text: 'You won ' + totalWin.toLocaleString() + ' Ks today!',
                    icon: 'success',
                    background: '#1e293b', color: '#fff',
                    confirmButtonColor: '#eab308',
                    backdrop: \`rgba(0,0,123,0.4) url("https://media.tenor.com/Confetti/confetti.gif") left top no-repeat\`
                });
            }
        };
    </script></body></html>`, { headers: {"content-type": "text/html"} });
});
