// Telegram WebApp frontend
const tg = window.Telegram.WebApp;
tg.expand();

const user = tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user : null;
document.getElementById('user-info').innerText = user ? `User: ${user.first_name} (${user.id})` : 'User not available (open from Bot Panel)';

async function api(path, method='GET', body=null){
  const initData = tg.initDataUnsafe || {};
  const fetchOpts = { method, headers: { 'Content-Type':'application/json' } };
  if (body) fetchOpts.body = JSON.stringify({...body, initDataUnsafe: initData});
  const res = await fetch(path, fetchOpts);
  return res.json();
}

async function refreshAccounts(){
  const out = document.getElementById('accounts');
  out.innerHTML = '<h2>Accounts</h2><div>Loading...</div>';
  const r = await api('/api/accounts');
  if (!r.ok) { out.innerHTML = 'Error fetching accounts'; return; }
  const list = r.accounts;
  if (!list.length) { out.innerHTML = '<h2>Accounts</h2><div>(no accounts)</div>'; return; }
  const html = ['<h2>Accounts</h2>'];
  list.forEach(a=>{
    html.push(`<div class="account" data-id="${a.id}">`);
    html.push(`<strong>${a.id}</strong> — status: ${a.runtimeStatus} ${a.config.warming?'<em>(warming)</em>':''}`);
    if (a.hasQr) html.push(`<div><img src="/api/qr/${a.id}" class="qr" /></div>`);
    html.push(`<div>targets: ${a.config.targets? a.config.targets.length : 0}</div>`);
    html.push(`<button data-act="open-qr" data-id="${a.id}">Show QR</button> `);
    html.push(`<button data-act="list-targets" data-id="${a.id}">List targets</button> `);
    html.push(`<button data-act="start" data-id="${a.id}">Start Warm</button> `);
    html.push(`<button data-act="stop" data-id="${a.id}">Stop Warm</button> `);
    html.push(`<input placeholder="phone" data-phone-input="${a.id}" /> <button data-act="addtarget" data-id="${a.id}">Add target</button>`);
    html.push(`</div>`);
  });
  out.innerHTML = html.join('');
}

document.getElementById('btn-refresh').addEventListener('click', refreshAccounts);
document.getElementById('btn-connect').addEventListener('click', async ()=>{
  const id = document.getElementById('new-account-id').value.trim();
  if (!id) return alert('Enter account id');
  const r = await api('/api/connect', 'POST', { accountId: id });
  if (!r.ok) return alert('Error: '+ (r.error || r.message || JSON.stringify(r)));
  log('Init client '+id);
  setTimeout(refreshAccounts, 1500);
});

document.getElementById('accounts').addEventListener('click', async (e)=>{
  const el = e.target;
  const act = el.dataset.act;
  const id = el.dataset.id;
  if (!act) return;
  if (act === 'open-qr'){
    // QR image already shown via /api/qr img tag; just refresh
    refreshAccounts();
  } else if (act === 'start'){
    const r = await api('/api/startwarm','POST',{ accountId: id });
    if (r.ok) log('Started warm '+id);
    else alert(JSON.stringify(r));
  } else if (act === 'stop'){
    const r = await api('/api/stopwarm','POST',{ accountId: id });
    if (r.ok) log('Stopped warm '+id);
    else alert(JSON.stringify(r));
  } else if (act === 'list-targets'){
    const r = await api('/api/listtargets/'+id);
    if (r.ok) alert('Targets:\\n'+r.targets.join('\\n'));
  } else if (act === 'addtarget'){
    const inp = document.querySelector(`[data-phone-input="${id}"]`);
    if (!inp) return;
    const phone = inp.value.trim();
    const r = await api('/api/addtarget','POST',{ accountId: id, phone });
    if (r.ok) { log('Added '+phone+' to '+id); refreshAccounts(); } else alert(JSON.stringify(r));
  }
});

function log(s){
  const l = document.getElementById('logs');
  const p = document.createElement('div'); p.innerText = `${new Date().toLocaleTimeString()} — ${s}`;
  l.prepend(p);
}

refreshAccounts();