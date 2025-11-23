import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { crypto } from "https://deno.land/std@0.177.0/crypto/mod.ts";

const kv = await Deno.openKv();

// --- UTILS ---
async function hashPassword(p: string, s: string) {
  const data = new TextEncoder().encode(p + s);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function generateId() { return crypto.randomUUID(); }

// --- CRON: AUTO HISTORY ---
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
  } catch (e) { console.error(e); }
});

serve(async (req) => {
  const url = new URL(req.url);
  const cookieOptions = "; Path=/; HttpOnly; Max-Age=1296000; SameSite=Lax"; 

  // --- AUTH HANDLERS ---
  if (req.method === "POST" && url.pathname === "/register") {
    const form = await req.formData();
    const u = form.get("username")?.toString().trim().toLowerCase();
    const p = form.get("password")?.toString();
    if (!u || !p) return Response.redirect(url.origin + "/?error=missing");
    const check = await kv.get(["users", u]);
    if (check.value) return Response.redirect(url.origin + "/?error=exists");
    const salt = generateId();
    const hash = await hashPassword(p, salt);
    await kv.set(["users", u], { passwordHash: hash, salt, balance: 0, joined: new Date().toISOString() });
    const h = new Headers({ "Location": "/" });
    h.set("Set-Cookie", `user=${encodeURIComponent(u)}${cookieOptions}`);
    return new Response(null, { status: 303, headers: h });
  }

  if (req.method === "POST" && url.pathname === "/login") {
    const form = await req.formData();
    const u = form.get("username")?.toString().trim().toLowerCase();
    const p = form.get("password")?.toString();
    const entry = await kv.get(["users", u]);
    const data = entry.value as any;
    if (!data) return Response.redirect(url.origin + "/?error=invalid");
    
    const inputHash = await hashPassword(p, data.salt || "");
    const valid = data.passwordHash ? (inputHash === data.passwordHash) : (p === data.password); // Legacy support
    if (!valid) return Response.redirect(url.origin + "/?error=invalid");

    const h = new Headers({ "Location": "/" });
    h.set("Set-Cookie", `user=${encodeURIComponent(u)}${cookieOptions}`);
    return new Response(null, { status: 303, headers: h });
  }

  if (url.pathname === "/logout") {
    const h = new Headers({ "Location": "/" });
    h.set("Set-Cookie", `user=; Path=/; Max-Age=0`);
    return new Response(null, { status: 303, headers: h });
  }

  // --- SESSION CHECK ---
  const cookies = req.headers.get("Cookie") || "";
  const userCookie = cookies.split(";").find(c => c.trim().startsWith("user="));
  const currentUser = userCookie ? decodeURIComponent(userCookie.split("=")[1].trim()) : null;
  const isAdmin = currentUser === "admin";

  // --- API / ACTIONS ---
  if (currentUser && req.method === "POST") {
    // 1. ATOMIC BETTING (CRITICAL FIX)
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

        // ATOMIC TRANSACTION
        let atomic = kv.atomic().check(userRes).set(userKey, { ...userData, balance: userData.balance - cost });
        
        const txTime = now.toLocaleString("en-US", { timeZone: "Asia/Yangon", hour12: true });
        const txDate = now.toLocaleString("en-US", { timeZone: "Asia/Yangon", day: 'numeric', month: 'short', year: 'numeric' });
        const batchId = Date.now().toString().slice(-6);

        for (const n of nums) {
            const betId = Date.now().toString() + Math.random().toString().slice(2,5);
            atomic = atomic.set(["bets", betId], { 
                user: currentUser, number: n, amount: amt, status: "PENDING", 
                time: txTime, rawMins: mins, batchId 
            });
        }
        
        const commit = await atomic.commit();
        if (!commit.ok) return new Response(JSON.stringify({ status: "retry" }));

        return new Response(JSON.stringify({ 
            status: "success", 
            voucher: { id: batchId, user: currentUser, date: txDate, time: txTime, nums, amt, total: cost } 
        }));
    }

    // 2. CHANGE PASSWORD
    if (url.pathname === "/change_pass") {
        const form = await req.formData();
        const newP = form.get("new_pass")?.toString();
        if (newP) {
            const u = await kv.get(["users", currentUser]);
            const s = generateId();
            const h = await hashPassword(newP, s);
            await kv.set(["users", currentUser], { ...u.value as any, passwordHash: h, salt: s });
            return new Response(JSON.stringify({ status: "ok" }));
        }
    }

    // 3. CLEAR HISTORY
    if (url.pathname === "/clear_history") {
        const iter = kv.list({ prefix: ["bets"] });
        for await (const e of iter) {
            const b = e.value as any;
            if (b.user === currentUser && b.status !== "PENDING") await kv.delete(e.key);
        }
        return new Response(JSON.stringify({ status: "ok" }));
    }
  }

  // --- ADMIN ACTIONS ---
  if (isAdmin && req.method === "POST") {
      const form = await req.formData();
      if (url.pathname === "/admin/topup") {
          const u = form.get("username")?.toString().trim();
          const a = parseInt(form.get("amount")?.toString() || "0");
          const res = await kv.get(["users", u]);
          if (res.value) {
              await kv.set(["users", u], { ...res.value as any, balance: (res.value as any).balance + a });
              await kv.set(["transactions", Date.now().toString()], { user: u, amount: a, type: "TOPUP", time: new Date().toLocaleString("en-US", { timeZone: "Asia/Yangon" }) });
          }
      }
      if (url.pathname === "/admin/payout") {
          const win = form.get("win_number")?.toString();
          const sess = form.get("session")?.toString(); // MORNING or EVENING
          const rate = (await kv.get(["system", "rate"])).value as number || 80;
          const iter = kv.list({ prefix: ["bets"] });
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
                      } else {
                          await kv.set(["bets", e.key[1]], { ...b, status: "LOSE" });
                      }
                  }
              }
          }
      }
      if (url.pathname === "/admin/settings") { // Consolidated settings
         if(form.has("rate")) await kv.set(["system", "rate"], parseInt(form.get("rate")?.toString()||"80"));
         if(form.has("tip")) await kv.set(["system", "tip"], form.get("tip")?.toString());
         if(form.has("contact")) await kv.set(["system", "contact"], JSON.parse(form.get("contact")?.toString()||"{}"));
      }
      if (url.pathname === "/admin/block") {
          const act = form.get("action");
          const val = form.get("val");
          if (act === "clear") { for await (const e of kv.list({ prefix: ["blocks"] })) await kv.delete(e.key); }
          else if (act === "add" && val) await kv.set(["blocks", val], true);
          else if (act === "del" && val) await kv.delete(["blocks", val]);
      }
      return new Response(null, { status: 303, headers: { "Location": "/" } });
  }

  // --- UI RENDERING ---
  const head = `
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Myanmar 2D VIP</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;500;700&family=Roboto+Mono:wght@500&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Poppins', sans-serif; background: #0f172a; color: #e2e8f0; -webkit-tap-highlight-color: transparent; padding-bottom: 80px; }
    .font-mono { font-family: 'Roboto Mono', monospace; }
    .glass { background: rgba(30, 41, 59, 0.7); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.05); }
    .gold-text { background: linear-gradient(to right, #bf953f, #fcf6ba, #b38728, #fbf5b7, #aa771c); -webkit-background-clip: text; color: transparent; }
    .gold-bg { background: linear-gradient(to bottom right, #bf953f, #aa771c); color: #000; }
    .neon-glow { box-shadow: 0 0 10px rgba(234, 179, 8, 0.3); }
    .input-dark { background: #1e293b; border: 1px solid #334155; color: white; }
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
    const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 3000 });
  </script>
  `;

  const loader = `<div id="loader" class="fixed inset-0 bg-black/90 z-[9999] hidden flex items-center justify-center"><div class="loader w-10 h-10"></div></div>`;

  // --- LOGIN / REGISTER UI ---
  if (!currentUser) {
    return new Response(`<!DOCTYPE html><html><head>${head}</head><body class="flex items-center justify-center min-h-screen bg-[url('https://images.unsplash.com/photo-1605218427360-36390f8584b0?q=80&w=1000&auto=format&fit=crop')] bg-cover bg-center">
    <div class="absolute inset-0 bg-black/80"></div>
    ${loader}
    <div class="relative z-10 w-full max-w-sm p-6">
      <div class="text-center mb-8">
        <i class="fas fa-crown text-5xl gold-text mb-2"></i>
        <h1 class="text-3xl font-bold text-white tracking-widest">VIP 2D</h1>
        <p class="text-gray-400 text-xs uppercase tracking-[0.2em]">Premium Betting</p>
      </div>
      <div class="glass rounded-2xl p-6 shadow-2xl border-t border-white/10">
        <div class="flex mb-6 bg-slate-800/50 rounded-lg p-1">
           <button onclick="switchTab('login')" id="tabLogin" class="flex-1 py-2 text-sm font-bold rounded-md bg-slate-700 text-white transition-all">LOGIN</button>
           <button onclick="switchTab('reg')" id="tabReg" class="flex-1 py-2 text-sm font-bold rounded-md text-gray-400 hover:text-white transition-all">REGISTER</button>
        </div>
        <form id="loginForm" action="/login" method="POST" onsubmit="showLoad()">
           <div class="space-y-4">
             <div class="relative"><i class="fas fa-user absolute left-3 top-3.5 text-gray-500"></i><input name="username" placeholder="Username" class="w-full pl-10 p-3 rounded-xl input-dark" required></div>
             <div class="relative"><i class="fas fa-lock absolute left-3 top-3.5 text-gray-500"></i><input name="password" type="password" placeholder="Password" class="w-full pl-10 p-3 rounded-xl input-dark" required></div>
             <button class="w-full py-3 rounded-xl gold-bg font-bold shadow-lg shadow-yellow-900/20">LOGIN NOW</button>
           </div>
        </form>
        <form id="regForm" action="/register" method="POST" class="hidden" onsubmit="showLoad()">
           <div class="space-y-4">
             <div class="relative"><i class="fas fa-user-plus absolute left-3 top-3.5 text-gray-500"></i><input name="username" placeholder="Create Username" class="w-full pl-10 p-3 rounded-xl input-dark" required></div>
             <div class="relative"><i class="fas fa-key absolute left-3 top-3.5 text-gray-500"></i><input name="password" type="password" placeholder="Create Password" class="w-full pl-10 p-3 rounded-xl input-dark" required></div>
             <button class="w-full py-3 rounded-xl bg-slate-700 text-white font-bold border border-slate-600 hover:bg-slate-600">CREATE ACCOUNT</button>
           </div>
        </form>
      </div>
    </div>
    <script>
      function switchTab(t) {
         const l=document.getElementById('loginForm'), r=document.getElementById('regForm'), tl=document.getElementById('tabLogin'), tr=document.getElementById('tabReg');
         if(t==='login'){ l.classList.remove('hidden'); r.classList.add('hidden'); tl.className="flex-1 py-2 text-sm font-bold rounded-md bg-slate-700 text-white shadow"; tr.className="flex-1 py-2 text-sm font-bold rounded-md text-gray-400"; }
         else { l.classList.add('hidden'); r.classList.remove('hidden'); tr.className="flex-1 py-2 text-sm font-bold rounded-md bg-slate-700 text-white shadow"; tl.className="flex-1 py-2 text-sm font-bold rounded-md text-gray-400"; }
      }
      const u = new URLSearchParams(location.search);
      if(u.get('error')==='invalid') Swal.fire({icon:'error',title:'Login Failed',text:'Wrong username or password',background:'#1e293b',color:'#fff'});
      if(u.get('error')==='exists') Swal.fire({icon:'error',title:'Taken',text:'Username already exists',background:'#1e293b',color:'#fff'});
    </script></body></html>`, { headers: { "content-type": "text/html" } });
  }

  // --- MAIN APP UI ---
  // Data fetching
  const userKey = ["users", currentUser];
  const uData = (await kv.get(userKey)).value as any;
  const balance = uData?.balance || 0;
  const sys = {
      rate: (await kv.get(["system", "rate"])).value || 80,
      tip: (await kv.get(["system", "tip"])).value || "",
      contact: (await kv.get(["system", "contact"])).value || {}
  };
  
  // History Fetching
  const bets = [];
  const bIter = kv.list({ prefix: ["bets"] }, { reverse: true, limit: isAdmin ? 100 : 50 });
  for await (const e of bIter) { if (isAdmin || e.value.user === currentUser) bets.push(e.value); }

  const blocks = [];
  for await (const e of kv.list({ prefix: ["blocks"] })) blocks.push(e.key[1]);

  // Admin Stats
  let stats = { sale: 0, payout: 0 };
  if (isAdmin) {
      const today = new Date().toLocaleString("en-US", { timeZone: "Asia/Yangon", day: 'numeric', month: 'short', year: 'numeric' });
      const all = kv.list({ prefix: ["bets"] });
      for await (const e of all) {
          const b = e.value as any;
          const d = new Date(parseInt(e.key[1])).toLocaleString("en-US", { timeZone: "Asia/Yangon", day: 'numeric', month: 'short', year: 'numeric' });
          if (d === today) { stats.sale += b.amount; if(b.status==="WIN") stats.payout += b.winAmount; }
      }
  }

  return new Response(`
    <!DOCTYPE html>
    <html lang="en">
    <head>${head}</head>
    <body>
      ${loader}
      
      <nav class="glass fixed top-0 w-full z-50 px-4 py-3 flex justify-between items-center shadow-lg">
        <div class="flex items-center gap-2">
           <div class="w-8 h-8 rounded-full gold-bg flex items-center justify-center font-bold text-sm">${currentUser[0].toUpperCase()}</div>
           <div>
             <div class="text-[10px] text-gray-400 uppercase">Balance</div>
             <div class="text-sm font-bold text-white font-mono">${balance.toLocaleString()} Ks</div>
           </div>
        </div>
        <div class="flex gap-3">
           ${isAdmin ? '<span class="bg-red-600 text-[10px] px-2 py-1 rounded font-bold">ADMIN</span>' : ''}
           <a href="/logout" class="text-gray-400 hover:text-white"><i class="fas fa-power-off"></i></a>
        </div>
      </nav>

      <div class="pt-20 px-4 pb-20 max-w-md mx-auto space-y-6" id="mainContent">
        
        <div class="glass rounded-3xl p-6 text-center relative overflow-hidden group">
            <div class="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-yellow-500 to-transparent opacity-50"></div>
            <div class="flex justify-between text-xs text-gray-400 mb-2 font-mono">
                <span id="live_date">--</span>
                <span class="text-red-500 animate-pulse font-bold">● LIVE</span>
            </div>
            <div class="py-2">
                <div id="live_twod" class="text-7xl font-bold gold-text font-mono drop-shadow-lg tracking-tighter">--</div>
                <div class="text-xs text-gray-500 mt-2 font-mono">Updated: <span id="live_time">--:--:--</span></div>
            </div>
            
            <div class="grid grid-cols-2 gap-2 mt-4 pt-4 border-t border-white/5">
                <div class="bg-black/20 rounded-lg p-2">
                    <div class="text-[10px] text-gray-500">12:01 PM</div>
                    <div class="font-bold text-lg" id="res_12">--</div>
                </div>
                <div class="bg-black/20 rounded-lg p-2">
                    <div class="text-[10px] text-gray-500">04:30 PM</div>
                    <div class="font-bold text-lg" id="res_430">--</div>
                </div>
            </div>
        </div>

        ${sys.tip ? `<div class="glass p-4 rounded-xl border-l-4 border-yellow-500 flex items-center gap-3">
            <div class="bg-yellow-500/20 p-2 rounded-full"><i class="fas fa-lightbulb text-yellow-500"></i></div>
            <div><div class="text-[10px] text-gray-400 uppercase font-bold">Daily Tip</div><div class="font-bold text-sm text-white">${sys.tip}</div></div>
        </div>` : ''}

        ${!isAdmin ? `<div class="grid grid-cols-2 gap-3">
            <button onclick="openBet()" class="gold-bg p-4 rounded-2xl shadow-lg shadow-yellow-600/20 flex flex-col items-center gap-2 active:scale-95 transition-transform">
                <i class="fas fa-plus-circle text-2xl"></i>
                <span class="font-bold text-sm">Bet Now (ထိုးမည်)</span>
            </button>
            <button onclick="showHistory()" class="glass p-4 rounded-2xl flex flex-col items-center gap-2 text-gray-300 hover:text-white active:scale-95 transition-transform">
                <i class="fas fa-list-alt text-2xl"></i>
                <span class="font-bold text-sm">My Ledger</span>
            </button>
        </div>` : ''}

        ${isAdmin ? `
        <div class="space-y-4">
            <div class="grid grid-cols-3 gap-2 text-center">
                <div class="glass p-2 rounded"><div class="text-[10px] text-green-400">Sale</div><div class="font-mono text-sm font-bold">${stats.sale.toLocaleString()}</div></div>
                <div class="glass p-2 rounded"><div class="text-[10px] text-red-400">Payout</div><div class="font-mono text-sm font-bold">${stats.payout.toLocaleString()}</div></div>
                <div class="glass p-2 rounded"><div class="text-[10px] text-blue-400">Profit</div><div class="font-mono text-sm font-bold">${(stats.sale - stats.payout).toLocaleString()}</div></div>
            </div>
            
            <div class="glass p-4 rounded-xl">
                <h3 class="text-xs font-bold text-gray-400 uppercase mb-3">System Control</h3>
                <div class="space-y-3">
                    <form action="/admin/payout" method="POST" onsubmit="showLoad()" class="flex gap-2">
                         <select name="session" class="bg-slate-800 text-white text-xs rounded p-2 border border-slate-600"><option value="MORNING">12:01 PM</option><option value="EVENING">04:30 PM</option></select>
                         <input name="win_number" placeholder="Win No" class="w-16 bg-slate-800 text-white text-center rounded border border-slate-600">
                         <button class="bg-red-600 text-white text-xs px-3 rounded font-bold">PAYOUT</button>
                    </form>
                    <form action="/admin/topup" method="POST" onsubmit="showLoad()" class="flex gap-2">
                         <input name="username" placeholder="User" class="flex-1 bg-slate-800 text-white text-xs rounded p-2 border border-slate-600">
                         <input name="amount" type="number" placeholder="Amt" class="w-20 bg-slate-800 text-white text-xs rounded p-2 border border-slate-600">
                         <button class="bg-green-600 text-white text-xs px-3 rounded font-bold">ADD</button>
                    </form>
                     <form action="/admin/block" method="POST" onsubmit="showLoad()" class="flex gap-2">
                         <input type="hidden" name="action" value="add">
                         <input name="val" placeholder="Block Num" class="flex-1 bg-slate-800 text-white text-xs rounded p-2 border border-slate-600">
                         <button class="bg-gray-600 text-white text-xs px-3 rounded font-bold">BLOCK</button>
                         <button type="submit" name="action" value="clear" class="bg-red-900 text-white text-xs px-3 rounded font-bold">CLEAR ALL</button>
                    </form>
                </div>
                <div class="mt-3 flex flex-wrap gap-1">
                    ${blocks.map(b => `<span class="text-[10px] bg-red-500/20 text-red-400 px-2 py-1 rounded border border-red-500/30">${b}</span>`).join('')}
                </div>
            </div>
        </div>` : ''}

        <div class="glass rounded-xl p-4">
             <div class="flex justify-between items-center mb-3">
                 <h3 class="font-bold text-gray-300 text-sm">Recent Bets</h3>
                 ${!isAdmin ? `<button onclick="clearHistory()" class="text-xs text-red-400"><i class="fas fa-trash"></i> Clear Win/Lose</button>`:''}
             </div>
             <div class="space-y-2 max-h-60 overflow-y-auto pr-1" id="betList">
                 ${bets.length === 0 ? '<div class="text-center text-gray-500 text-xs py-4">No betting history</div>' : ''}
                 ${bets.map(b => `
                    <div class="flex justify-between items-center p-3 rounded-lg bg-black/20 border-l-2 ${b.status==='WIN'?'border-green-500':b.status==='LOSE'?'border-red-500':'border-yellow-500'}">
                        <div>
                            <div class="font-mono font-bold text-lg ${b.status==='WIN'?'text-green-400':b.status==='LOSE'?'text-red-400':'text-white'}">${b.number}</div>
                            <div class="text-[10px] text-gray-500">${b.time}</div>
                        </div>
                        <div class="text-right">
                            <div class="font-mono text-sm font-bold">${b.amount.toLocaleString()}</div>
                            <div class="text-[10px] font-bold ${b.status==='WIN'?'text-green-500':b.status==='LOSE'?'text-red-500':'text-yellow-500'}">${b.status}</div>
                        </div>
                    </div>
                 `).join('')}
             </div>
        </div>

      </div>

      <div class="fixed bottom-0 w-full glass border-t border-white/10 pb-safe flex justify-around items-center h-16 z-40">
          <button onclick="location.reload()" class="nav-item active flex flex-col items-center text-gray-400 hover:text-yellow-500"><i class="fas fa-home text-lg"></i><span class="text-[10px] mt-1">Home</span></button>
          <button onclick="showContact()" class="nav-item flex flex-col items-center text-gray-400 hover:text-yellow-500"><i class="fas fa-headset text-lg"></i><span class="text-[10px] mt-1">Contact</span></button>
          <button onclick="showProfile()" class="nav-item flex flex-col items-center text-gray-400 hover:text-yellow-500"><i class="fas fa-user-cog text-lg"></i><span class="text-[10px] mt-1">Profile</span></button>
      </div>

      <div id="betModal" class="fixed inset-0 z-[100] hidden">
          <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" onclick="closeBet()"></div>
          <div class="absolute bottom-0 w-full bg-[#1e293b] rounded-t-3xl p-6 slide-up shadow-2xl border-t border-yellow-500/30">
              <div class="flex justify-between items-center mb-4">
                  <h2 class="text-xl font-bold text-white">Place Bet</h2>
                  <button onclick="closeBet()" class="text-gray-400 text-2xl">&times;</button>
              </div>
              
              <div class="flex gap-2 mb-4 overflow-x-auto pb-2 no-scrollbar">
                  <button onclick="setMode('direct')" class="px-4 py-1 bg-yellow-500 text-black text-xs font-bold rounded-full whitespace-nowrap">Direct</button>
                  <button onclick="quickInput('brake')" class="px-4 py-1 bg-slate-700 text-white text-xs font-bold rounded-full whitespace-nowrap border border-slate-600">Brake (R)</button>
                  <button onclick="quickInput('round')" class="px-4 py-1 bg-slate-700 text-white text-xs font-bold rounded-full whitespace-nowrap border border-slate-600">Round (အပူး)</button>
                  <button onclick="quickInput('head')" class="px-4 py-1 bg-slate-700 text-white text-xs font-bold rounded-full whitespace-nowrap border border-slate-600">Head (ထိပ်)</button>
                  <button onclick="quickInput('tail')" class="px-4 py-1 bg-slate-700 text-white text-xs font-bold rounded-full whitespace-nowrap border border-slate-600">Tail (နောက်)</button>
              </div>

              <form onsubmit="submitBet(event)">
                  <div class="bg-black/30 p-3 rounded-xl border border-white/5 mb-4">
                      <textarea id="betNums" name="number" class="w-full bg-transparent text-lg font-mono font-bold text-white placeholder-gray-600 focus:outline-none resize-none h-20" placeholder="12, 34, 56..."></textarea>
                  </div>
                  <div class="mb-6">
                      <label class="text-xs text-gray-400 uppercase font-bold">Amount (Per Number)</label>
                      <div class="flex items-center mt-2 bg-black/30 rounded-xl border border-white/5 overflow-hidden">
                          <span class="pl-4 text-yellow-500 font-bold">Ks</span>
                          <input type="number" name="amount" class="w-full p-3 bg-transparent text-white font-bold focus:outline-none" placeholder="Min 50" required>
                      </div>
                  </div>
                  <button class="w-full py-4 rounded-xl gold-bg text-black font-bold text-lg shadow-lg shadow-yellow-900/20">CONFIRM BET</button>
              </form>
          </div>
      </div>

      <div id="voucherModal" class="fixed inset-0 z-[110] hidden flex items-center justify-center p-6">
           <div class="absolute inset-0 bg-black/90" onclick="location.reload()"></div>
           <div class="relative w-full max-w-xs bg-white text-slate-900 rounded-lg overflow-hidden shadow-2xl slide-up">
               <div class="bg-slate-900 text-white p-3 text-center font-bold uppercase text-sm border-b-4 border-yellow-500">Success</div>
               <div class="p-4 font-mono text-sm" id="voucherContent"></div>
               <div class="p-3 bg-gray-100 text-center">
                   <button onclick="location.reload()" class="text-xs font-bold text-slate-500 uppercase tracking-wide">Close & Refresh</button>
               </div>
           </div>
      </div>

      <script>
        // --- LOGIC ---
        const API_URL = "https://api.thaistock2d.com/live";
        async function updateLive() {
            try {
                const r = await fetch(API_URL);
                const d = await r.json();
                if(d.live) {
                    document.getElementById('live_twod').innerText = d.live.twod || "--";
                    document.getElementById('live_time').innerText = d.live.time || "--:--:--";
                    document.getElementById('live_date').innerText = d.live.date || "Today";
                }
                if(d.result && d.result[1]) {
                   document.getElementById('res_12').innerText = d.result[1].twod || "--";
                }
                if(d.result && (d.result[3] || d.result[2])) {
                   const ev = d.result[3] || d.result[2];
                   document.getElementById('res_430').innerText = ev.twod || "--";
                }
            } catch(e) {}
        }
        setInterval(updateLive, 2000); updateLive();

        function openBet() { document.getElementById('betModal').classList.remove('hidden'); }
        function closeBet() { document.getElementById('betModal').classList.add('hidden'); }
        
        function quickInput(mode) {
            Swal.fire({
                title: mode.toUpperCase(),
                input: 'number',
                inputPlaceholder: 'Enter digit...',
                background: '#1e293b', color: '#fff',
                confirmButtonColor: '#eab308'
            }).then((res) => {
                if(res.isConfirmed && res.value) {
                    const v = res.value;
                    let arr = [];
                    if(mode==='round') for(let i=0;i<10;i++) arr.push(i+""+i);
                    if(mode==='head') for(let i=0;i<10;i++) arr.push(v+i);
                    if(mode==='tail') for(let i=0;i<10;i++) arr.push(i+v);
                    if(mode==='brake') { if(v.length===2) arr = v[0]===v[1] ? [v] : [v, v[1]+v[0]]; }
                    
                    const area = document.getElementById('betNums');
                    let cur = area.value.trim();
                    if(cur && !cur.endsWith(',')) cur += ',';
                    area.value = cur + arr.join(',');
                }
            });
        }

        async function submitBet(e) {
            e.preventDefault();
            showLoad();
            const fd = new FormData(e.target);
            try {
                const req = await fetch('/bet', { method: 'POST', body: fd });
                const res = await req.json();
                hideLoad();
                if(res.status==='success') {
                    closeBet();
                    const v = res.voucher;
                    const h = \`<div class="flex justify-between mb-2"><span>ID: \${v.id}</span><span>\${v.time}</span></div>
                    <div class="border-y border-dashed border-gray-300 py-2 my-2 space-y-1 max-h-40 overflow-y-auto">
                       \${v.nums.map(n=>\`<div class="flex justify-between"><span>\${n}</span><span>\${v.amt}</span></div>\`).join('')}
                    </div>
                    <div class="flex justify-between font-bold text-lg mt-2"><span>TOTAL</span><span>\${v.total.toLocaleString()}</span></div>\`;
                    document.getElementById('voucherContent').innerHTML = h;
                    document.getElementById('voucherModal').classList.remove('hidden');
                } else if(res.status==='retry') Swal.fire('Error','Please try again','error');
                else if(res.status==='no_balance') Swal.fire('Error','Insufficient Balance','error');
                else if(res.status==='blocked') Swal.fire('Closed','Number '+res.num+' is blocked','warning');
                else if(res.status==='closed') Swal.fire('Market Closed','Betting time is over','warning');
                else Swal.fire('Error','Invalid Data','error');
            } catch(e) { hideLoad(); Swal.fire('Error','Connection Failed','error'); }
        }

        function showContact() {
            Swal.fire({
                title: 'Contact Us',
                html: '<div class="text-left space-y-3 text-sm"><div class="p-2 bg-blue-900/30 rounded border border-blue-500/30"><div class="text-blue-400 text-xs">KPay</div><div class="font-bold text-white select-all">${sys.contact.kpay_no || "-"}</div></div><div class="p-2 bg-yellow-900/30 rounded border border-yellow-500/30"><div class="text-yellow-400 text-xs">Wave</div><div class="font-bold text-white select-all">${sys.contact.wave_no || "-"}</div></div><a href="${sys.contact.tele_link||"#"}" class="block text-center bg-blue-600 text-white py-2 rounded font-bold">Telegram Channel</a></div>',
                background: '#1e293b', color: '#fff', showConfirmButton: false
            });
        }
        
        function showProfile() {
            Swal.fire({
                title: 'Change Password',
                html: '<input id="newP" type="password" placeholder="New Password" class="swal2-input">',
                background: '#1e293b', color: '#fff',
                confirmButtonText: 'Save', confirmButtonColor: '#eab308',
                preConfirm: () => {
                    const p = document.getElementById('newP').value;
                    if(!p) Swal.showValidationMessage('Password required');
                    return p;
                }
            }).then((res) => {
                if(res.isConfirmed) {
                    const fd = new FormData(); fd.append('new_pass', res.value);
                    fetch('/change_pass', {method:'POST', body:fd}).then(()=>{ Swal.fire('Success','Password Changed','success') });
                }
            });
        }

        function clearHistory() {
             Swal.fire({ title:'Clear History?', text:'Only finished bets will be removed.', icon:'warning', showCancelButton:true, confirmButtonColor:'#d33', background:'#1e293b', color:'#fff' }).then(r=>{
                 if(r.isConfirmed) fetch('/clear_history',{method:'POST'}).then(()=>location.reload());
             });
        }
      </script>
    </body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
});
