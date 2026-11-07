const express = require('express');

const {
    pool,
    initDB,
    mwos,
    gsb,
    getZambiaTime,
    TWENTY_FOUR_HOURS_MS,
    LOCK_HOUR,
    LOCK_MINUTE,
    UNLOCK_HOUR,
    UNLOCK_MINUTE,
    REMOVE_PASSWORD,
    HEARTBEAT_TIMEOUT_MS,
    TIMEZONE
} = require('./accounts');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

function pad(n) {
    return String(n).padStart(2, '0');
}

function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[c]);
}

function checkLockStatus(hour, minute) {
    const now = hour * 60 + minute;
    const start = LOCK_HOUR * 60 + LOCK_MINUTE;
    const end = UNLOCK_HOUR * 60 + UNLOCK_MINUTE;

    const locked = start <= end
        ? now >= start && now < end
        : now >= start || now < end;

    return { shouldLock: locked };
}

// Add an account to both pools.
app.post('/add-account', addAccount);
app.post('/gsb/add-account', addAccount);

async function addAccount(req, res) {
    try {
        const phone = String(req.body.phone || '').trim();
        const password = String(req.body.password || '');

        if (!phone || !password) {
            return res.json({
                success: false,
                error: 'Phone and password required.'
            });
        }

        const mwosAccounts = await mwos.getAccounts();
        const gsbAccounts = await gsb.getAccounts();

        if (
            mwosAccounts.some(a => a.phone === phone) ||
            gsbAccounts.some(a => a.phone === phone)
        ) {
            return res.json({
                success: false,
                error: 'Account already exists.'
            });
        }

        await mwos.addAccount(phone, password);
        await gsb.addAccount(phone, password);

        res.json({ success: true });
    } catch (e) {
        console.error('Add account:', e);
        res.status(500).json({ success: false, error: e.message });
    }
}

// Set up one independent pool.
async function setupPool(name, base, store, alertsTable) {
    let poolLocked = false;
    let poolLockedReason = '';

    // Automatically free accounts after 24 hours.
    setInterval(async () => {
        try {
            const accounts = await store.getAccounts();
            const now = Date.now();

            for (const acc of accounts) {
                if (
                    acc.status === 'IN-USE' &&
                    acc.logoutTime &&
                    now - acc.logoutTime >= TWENTY_FOUR_HOURS_MS
                ) {
                    await store.updateAccount(acc.phone, {
                        status: 'FREE',
                        logoutTime: null,
                        logoutTimeStr: null,
                        lastHeartbeat: null,
                        inUseSince: null,
                        tabId: null,
                        freedAt: now
                    });
                }
            }
        } catch (e) {
            console.error(name + ' auto-free:', e);
        }
    }, 60000);

    // Five-minute heartbeat timeout, after a real heartbeat.
    setInterval(async () => {
        try {
            const accounts = await store.getAccounts();
            const now = Date.now();

            for (const acc of accounts) {
                if (
                    acc.status === 'IN-USE' &&
                    !acc.logoutTime &&
                    acc.lastHeartbeat &&
                    acc.inUseSince &&
                    acc.lastHeartbeat > acc.inUseSince &&
                    now - acc.lastHeartbeat > HEARTBEAT_TIMEOUT_MS
                ) {
                    const t = getZambiaTime();

                    await store.updateAccount(acc.phone, {
                        logoutTime: now,
                        logoutTimeStr: pad(t.hour) + ':' + pad(t.minute) + ' (tab closed)',
                        lastHeartbeat: null,
                        inUseSince: null,
                        tabId: null
                    });
                }
            }
        } catch (e) {
            console.error(name + ' heartbeat timeout:', e);
        }
    }, 10000);

    // Three-hour fallback after the last heartbeat.
    setInterval(async () => {
        try {
            const accounts = await store.getAccounts();
            const now = Date.now();

            for (const acc of accounts) {
                if (
                    acc.status === 'IN-USE' &&
                    !acc.logoutTime &&
                    acc.lastHeartbeat &&
                    now - acc.lastHeartbeat >= 3 * 60 * 60 * 1000
                ) {
                    const t = getZambiaTime();

                    await store.updateAccount(acc.phone, {
                        logoutTime: now,
                        logoutTimeStr: pad(t.hour) + ':' + pad(t.minute) + ' (3h no heartbeat)',
                        lastHeartbeat: null,
                        inUseSince: null,
                        tabId: null
                    });
                }
            }
        } catch (e) {
            console.error(name + ' three-hour timeout:', e);
        }
    }, 60000);

    // Lock and unlock at the configured Zambia times.
    setInterval(() => {
        const t = getZambiaTime();
        const result = checkLockStatus(t.hour, t.minute);

        if (result.shouldLock && !poolLocked) {
            poolLocked = true;
            poolLockedReason = 'Locked at 20:00. Unlocks at 04:00.';
            console.log(name + ' locked.');
        } else if (!result.shouldLock && poolLocked) {
            poolLocked = false;
            poolLockedReason = '';
            console.log(name + ' unlocked.');
        }
    }, 10000);

    // 21:00 daily sweep.
    let lastSweepDate = '';

    setInterval(async () => {
        try {
            const t = getZambiaTime();
            if (t.hour !== 21) return;

            const today = new Date().toLocaleDateString('en-CA', {
                timeZone: TIMEZONE
            });

            if (lastSweepDate === today) return;

            const accounts = await store.getAccounts();
            let moved = 0;

            for (const acc of accounts) {
                if (acc.status === 'IN-USE' && !acc.logoutTime) {
                    await store.updateAccount(acc.phone, {
                        logoutTime: Date.now(),
                        logoutTimeStr: pad(t.hour) + ':' + pad(t.minute) + ' (21:00 sweep)',
                        lastHeartbeat: null,
                        inUseSince: null,
                        tabId: null
                    });
                    moved++;
                }
            }

            lastSweepDate = today;
            console.log(name + ' sweep moved ' + moved + ' accounts.');
        } catch (e) {
            console.error(name + ' sweep:', e);
        }
    }, 30000);

    // ---------------- STATS ----------------

    app.get(base + '/stats', async (req, res) => {
        try {
            const accounts = await store.getAccounts();
            const bad = await store.getBadPasswordAccounts();

            res.json({
                free: accounts.filter(a => a.status === 'FREE').length,
                inUse: accounts.filter(a => a.status === 'IN-USE' && !a.logoutTime).length,
                waiting: accounts.filter(a => a.status === 'IN-USE' && a.logoutTime).length,
                badPassword: bad.length,
                locked: poolLocked,
                reason: poolLockedReason
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get(base + '/inuse-stats', async (req, res) => {
        try {
            const accounts = await store.getAccounts();

            res.json(
                accounts
                    .filter(a => a.status === 'IN-USE' && !a.logoutTime)
                    .sort((a, b) => {
                        const an = a.tabId ? parseInt(a.tabId.replace('TAB-', '')) : 9999;
                        const bn = b.tabId ? parseInt(b.tabId.replace('TAB-', '')) : 9999;
                        return an - bn;
                    })
                    .map(a => ({
                        phone: a.phone,
                        lastHeartbeat: a.lastHeartbeat,
                        tabId: a.tabId
                    }))
            );
        } catch (e) {
            res.status(500).json([]);
        }
    });

    // ---------------- LOGIN ----------------

    app.post(base + '/request-login', async (req, res) => {
        try {
            const tabId = String(req.body.tabId || '').trim();

            if (!tabId) {
                return res.json({ success: false, error: 'Tab ID required.' });
            }

            if (poolLocked) {
                const held = await store.getAccountByTabId(tabId);

                if (held) {
                    const t = getZambiaTime();

                    await store.updateAccount(held.phone, {
                        logoutTime: Date.now(),
                        logoutTimeStr: pad(t.hour) + ':' + pad(t.minute) + ' (pool locked)',
                        lastHeartbeat: null,
                        inUseSince: null,
                        tabId: null
                    });
                }

                return res.json({
                    success: false,
                    error: 'Pool locked. ' + poolLockedReason
                });
            }

            const t = getZambiaTime();

            const claimed = await store.reLoginForTab(
                tabId,
                Date.now(),
                pad(t.hour) + ':' + pad(t.minute)
            );

            if (!claimed) {
                return res.json({
                    success: false,
                    error: 'No free accounts available.'
                });
            }

            res.json({
                success: true,
                phone: claimed.phone,
                password: claimed.password
            });
        } catch (e) {
            console.error(name + ' login:', e);
            res.status(500).json({ success: false, error: 'Server error.' });
        }
    });

    app.post(base + '/heartbeat', async (req, res) => {
        try {
            const phone = String(req.body.phone || '');
            const accounts = await store.getAccounts();
            const account = accounts.find(a => a.phone === phone);

            if (!account || account.status !== 'IN-USE' || account.logoutTime) {
                return res.json({
                    success: false,
                    error: 'Account not found or not in use.'
                });
            }

            await store.updateAccount(phone, {
                lastHeartbeat: Date.now()
            });

            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    app.post(base + '/tab-closed', async (req, res) => {
        try {
            const phone = String(req.body.phone || '');
            if (!phone) return res.json({ success: false });

            const accounts = await store.getAccounts();
            const account = accounts.find(a => a.phone === phone);

            if (account && account.status === 'IN-USE' && !account.logoutTime) {
                const t = getZambiaTime();

                await store.updateAccount(phone, {
                    logoutTime: Date.now(),
                    logoutTimeStr: pad(t.hour) + ':' + pad(t.minute) + ' (tab closed)',
                    lastHeartbeat: null,
                    inUseSince: null,
                    tabId: null
                });
            }

            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    app.post(base + '/logout', async (req, res) => {
        try {
            const phone = String(req.body.phone || '');
            const accounts = await store.getAccounts();
            const account = accounts.find(a => a.phone === phone);

            if (!account) {
                return res.json({ success: false, error: 'Account not found.' });
            }

            await store.updateAccount(phone, {
                logoutTime: Date.now(),
                logoutTimeStr: String(req.body.logoutTime || ''),
                lastHeartbeat: null,
                inUseSince: null,
                tabId: null
            });

            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    // ---------------- BAD PASSWORD ----------------

    app.post(base + '/wrong-password', async (req, res) => {
        try {
            const phone = String(req.body.phone || '');
            if (!phone) return res.json({ success: false });

            const t = getZambiaTime();
            const accounts = await store.getAccounts();
            const account = accounts.find(a => a.phone === phone);

            if (account) {
                await store.removeAccount(phone);

                await store.addBadPasswordAccount(
                    phone,
                    account.password,
                    pad(t.hour) + ':' + pad(t.minute)
                );
            }

            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    // ---------------- REMOVE ACCOUNTS ----------------

    app.post(base + '/remove-account', async (req, res) => {
        try {
            const { phone, pin } = req.body || {};

            if (pin !== REMOVE_PASSWORD) {
                return res.json({ success: false, error: 'Incorrect password.' });
            }

            await store.removeAccount(String(phone || ''));
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    app.post(base + '/remove-bad-password', async (req, res) => {
        try {
            const { phone, pin } = req.body || {};

            if (pin !== REMOVE_PASSWORD) {
                return res.json({ success: false, error: 'Incorrect password.' });
            }

            await store.removeBadPasswordAccount(String(phone || ''));
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    // ---------------- ALERTS ----------------

    app.post(base + '/cashout', async (req, res) => {
        try {
            const { tabId, amount, timestamp } = req.body || {};

            if (!tabId || !String(tabId).startsWith('ID:')) {
                return res.json({ ok: false, error: 'Invalid tabId.' });
            }

            await pool.query(
                `INSERT INTO ${alertsTable} (tab_id, amount, timestamp)
                 VALUES ($1, $2, $3)`,
                [
                    String(tabId),
                    Number(amount) || 0,
                    Number(timestamp) || Date.now()
                ]
            );

            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false });
        }
    });

    app.get(base + '/alerts', async (req, res) => {
        try {
            const { rows } = await pool.query(
                `SELECT * FROM ${alertsTable} ORDER BY id ASC`
            );

            res.json(rows.map(r => ({
                tabId: r.tab_id,
                amount: Number(r.amount),
                timestamp: Number(r.timestamp)
            })));
        } catch (e) {
            res.status(500).json([]);
        }
    });

    // PIN is now checked on the server.
    app.post(base + '/clear-alerts', async (req, res) => {
        try {
            if (!req.body || req.body.pin !== REMOVE_PASSWORD) {
                return res.status(403).json({
                    ok: false,
                    error: 'Incorrect PIN.'
                });
            }

            await pool.query(`DELETE FROM ${alertsTable}`);
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false });
        }
    });

    // ---------------- RESET / WIPE ----------------

    app.post(base + '/reset', async (req, res) => {
        try {
            if (!req.body || req.body.pin !== REMOVE_PASSWORD) {
                return res.status(403).json({
                    success: false,
                    error: 'Incorrect PIN.'
                });
            }

            await store.resetAllAccounts();

            const t = getZambiaTime();
            poolLocked = checkLockStatus(t.hour, t.minute).shouldLock;
            poolLockedReason = poolLocked
                ? 'Locked at 20:00. Unlocks at 04:00.'
                : '';

            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    app.post(base + '/wipe-all-accounts', async (req, res) => {
        try {
            if (!req.body || req.body.pin !== REMOVE_PASSWORD) {
                return res.status(403).json({
                    success: false,
                    error: 'Incorrect PIN.'
                });
            }

            await store.deleteAllAccounts();
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    // ---------------- LIST PAGE ----------------

    function listPage(title, subtitle, rows, removeEndpoint) {
        return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHTML(title)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;background:#04060a;padding:20px;min-height:100vh}
.page{background:#0d1117;border-radius:16px;max-width:520px;margin:auto;overflow:hidden}
.ph{padding:16px 20px;border-bottom:1px solid #21262d}
.back{color:#8b949e;text-decoration:none;font-size:12px}
.pt{font-size:15px;color:#e6edf3;margin-top:10px}
.ps{font-size:11px;color:#8b949e;margin-top:4px}
.sw{padding:14px 20px;border-bottom:1px solid #21262d}
.si{width:100%;background:#161b22;border:1px solid #30363d;color:white;padding:10px;border-radius:8px}
.row{display:flex;align-items:center;padding:12px 20px;border-bottom:1px solid #21262d;gap:10px}
.rn{color:#8b949e;font-size:12px;width:25px}
.ri{flex:1;min-width:0}
.rp{color:#e6edf3;font-size:14px;overflow-wrap:anywhere}
.rs{color:#8b949e;font-size:11px;margin-top:4px}
.rb{background:#7f1d1d;color:#fff;border:0;padding:7px 12px;border-radius:6px;cursor:pointer}
.empty{padding:35px;text-align:center;color:#8b949e}
.hidden{display:none}
</style>
</head>
<body>
<div class="page">
<div class="ph">
<a class="back" href="${base}/">← Back</a>
<div class="pt">${escapeHTML(title)}</div>
<div class="ps">${escapeHTML(subtitle)}</div>
</div>
<div class="sw">
<input class="si" id="search" placeholder="Search phone number">
</div>
<div id="list">${rows || '<div class="empty">No accounts</div>'}</div>
</div>

<script>
const REMOVE_ENDPOINT=${JSON.stringify(base + '/' + removeEndpoint)};

document.getElementById('search').addEventListener('input',function(){
 const q=this.value.toLowerCase();
 document.querySelectorAll('.row').forEach(row=>{
  row.style.display=row.dataset.phone.toLowerCase().includes(q)?'flex':'none';
 });
});

async function removeAccount(phone){
 const pin=prompt('Enter removal PIN:');
 if(pin===null)return;

 try{
  const response=await fetch(REMOVE_ENDPOINT,{
   method:'POST',
   headers:{'Content-Type':'application/json'},
   body:JSON.stringify({phone,pin})
  });

  const result=await response.json();

  if(result.success){
   const row=Array.from(document.querySelectorAll('.row'))
    .find(el=>el.dataset.phone===phone);
   if(row)row.remove();
  }else{
   alert(result.error||'Could not remove account.');
  }
 }catch(e){
  alert('Network error.');
 }
}
</script>
</body>
</html>`;
    }

    // Free accounts.
    app.get(base + '/view/free', async (req, res) => {
        try {
            const list = (await store.getAccounts())
                .filter(a => a.status === 'FREE')
                .sort((a, b) => {
                    if (a.freedAt && b.freedAt) return a.freedAt - b.freedAt;
                    if (a.freedAt) return -1;
                    if (b.freedAt) return 1;
                    return 0;
                });

            const rows = list.map((a, i) => `
                <div class="row" data-phone="${escapeHTML(a.phone)}">
                    <div class="rn">${i + 1}.</div>
                    <div class="ri">
                        <div class="rp">${escapeHTML(a.phone)}</div>
                        <div class="rs">${escapeHTML(a.password)}</div>
                    </div>
                    <button class="rb" onclick="removeAccount(${JSON.stringify(a.phone)})">Remove</button>
                </div>
            `).join('');

            res.send(listPage(
                'Free Accounts',
                list.length + ' ready',
                rows,
                'remove-account'
            ));
        } catch (e) {
            res.status(500).send('Error loading accounts.');
        }
    });

    // In-use accounts.
    app.get(base + '/view/inuse', async (req, res) => {
        try {
            const list = (await store.getAccounts())
                .filter(a => a.status === 'IN-USE' && !a.logoutTime)
                .sort((a, b) => {
                    const an = a.tabId ? parseInt(a.tabId.replace('TAB-', '')) : 9999;
                    const bn = b.tabId ? parseInt(b.tabId.replace('TAB-', '')) : 9999;
                    return an - bn;
                });

            const rows = list.map((a, i) => `
                <div class="row" data-phone="${escapeHTML(a.phone)}">
                    <div class="rn">${i + 1}.</div>
                    <div class="ri">
                        <div class="rp">${escapeHTML(a.phone)}</div>
                        <div class="rs" id="hb-${i}">Checking heartbeat...</div>
                    </div>
                </div>
            `).join('');

            res.send(listPage('In Use', list.length + ' accounts', rows, 'remove-account')
                .replace('</body>', `
<script>
async function updateHeartbeat(){
 try{
  const data=await (await fetch('${base}/inuse-stats')).json();
  data.forEach((a,i)=>{
   const el=document.getElementById('hb-'+i);
   if(!el)return;
   if(!a.lastHeartbeat){
    el.textContent='Waiting for heartbeat';
    el.style.color='#fbbf24';
    return;
   }
   const seconds=Math.floor((Date.now()-a.lastHeartbeat)/1000);
   el.textContent='Heartbeat: '+seconds+'s ago';
   el.style.color=seconds<30?'#3fb950':'#fbbf24';
  });
 }catch(e){}
}
updateHeartbeat();
setInterval(updateHeartbeat,3000);
</script>
</body>`));
        } catch (e) {
            res.status(500).send('Error loading accounts.');
        }
    });

    // Waiting accounts.
    app.get(base + '/view/waiting', async (req, res) => {
        try {
            const list = (await store.getAccounts())
                .filter(a => a.status === 'IN-USE' && a.logoutTime)
                .map(a => ({
                    phone: a.phone,
                    freeAt: a.logoutTime + TWENTY_FOUR_HOURS_MS,
                    logoutTimeStr: a.logoutTimeStr
                }))
                .sort((a, b) => a.freeAt - b.freeAt);

            const data = JSON.stringify(list.map((a, i) => ({
                id: i,
                freeAt: a.freeAt
            })));

            const rows = list.map((a, i) => `
                <div class="row" data-phone="${escapeHTML(a.phone)}">
                    <div class="rn">${i + 1}.</div>
                    <div class="ri">
                        <div class="rp">${escapeHTML(a.phone)}</div>
                        <div class="rs" id="cd-${i}">Calculating...</div>
                        <div class="rs">${escapeHTML(a.logoutTimeStr || '')}</div>
                    </div>
                </div>
            `).join('');

            res.send(listPage('Waiting 24h', list.length + ' accounts', rows, 'remove-account')
                .replace('</body>', `
<script>
const waitingData=${data};
function updateCountdown(){
 waitingData.forEach(item=>{
  const el=document.getElementById('cd-'+item.id);
  if(!el)return;
  const diff=item.freeAt-Date.now();
  if(diff<=0){
   el.textContent='Ready';
   el.style.color='#3fb950';
  }else{
   const h=Math.floor(diff/3600000);
   const m=Math.floor(diff%3600000/60000);
   const s=Math.floor(diff%60000/1000);
   el.textContent='Free in: '+h+'h '+m+'m '+s+'s';
  }
 });
}
updateCountdown();
setInterval(updateCountdown,1000);
</script>
</body>`));
        } catch (e) {
            res.status(500).send('Error loading accounts.');
        }
    });

    // Bad-password accounts: use the correct remove endpoint.
    app.get(base + '/view/bad', async (req, res) => {
        try {
            const list = await store.getBadPasswordAccounts();

            const rows = list.map((a, i) => `
                <div class="row" data-phone="${escapeHTML(a.phone)}">
                    <div class="rn">${i + 1}.</div>
                    <div class="ri">
                        <div class="rp">${escapeHTML(a.phone)}</div>
                        <div class="rs">${escapeHTML(a.password || '')}</div>
                        <div class="rs">${escapeHTML(a.reportedAt || '')}</div>
                    </div>
                    <button class="rb" onclick="removeAccount(${JSON.stringify(a.phone)})">Remove</button>
                </div>
            `).join('');

            res.send(listPage(
                'Bad Password',
                list.length + ' accounts',
                rows,
                'remove-bad-password'
            ));
        } catch (e) {
            res.status(500).send('Error loading bad-password accounts.');
        }
    });

    // ---------------- DASHBOARD ----------------

    app.get(base || '/', async (req, res) => {
        try {
            const accounts = await store.getAccounts();
            const bad = await store.getBadPasswordAccounts();

            const free = accounts.filter(a => a.status === 'FREE').length;
            const inUse = accounts.filter(a => a.status === 'IN-USE' && !a.logoutTime).length;
            const waiting = accounts.filter(a => a.status === 'IN-USE' && a.logoutTime).length;

            res.send(`<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} Pool</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>
<style>
*{box-sizing:border-box}
body{font-family:Arial;background:#04060a;color:#e6edf3;padding:20px}
.db{max-width:760px;margin:auto;background:#080b10;border-radius:20px;padding:22px}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}
.title{font-size:18px;font-weight:bold}
.pill{padding:7px 14px;border-radius:20px;font-size:12px}
.live{background:#0d4429;color:#3fb950}
.locked{background:#4b1111;color:#f87171}
.tabs{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:18px}
.tabs a{padding:12px;text-align:center;text-decoration:none;color:white;background:#161b22;border-radius:9px}
.tabs .active{background:#1a3a6e}
.boxes{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.box{padding:15px;border-radius:12px;background:#111827}
.box h3{font-size:10px;color:#8b949e}
.num{font-size:40px;margin:12px 0}
.box a{display:block;text-align:center;background:#26364e;color:white;padding:9px;border-radius:7px;text-decoration:none;font-size:12px}
.bad{margin-top:10px}
.add,.alerts{margin-top:18px;padding:16px;background:#111827;border-radius:12px}
input{padding:11px;background:#161b22;border:1px solid #30363d;color:white;border-radius:7px}
.add input{width:100%;margin:5px 0}
button{padding:11px 14px;background:#1a3a6e;color:white;border:0;border-radius:7px;cursor:pointer}
.clear{background:#7f1d1d}
.message{font-size:12px;margin-top:8px}
.alert-item{padding:9px;border-bottom:1px solid #30363d}
.footer{margin-top:18px;color:#8b949e;font-size:11px;display:flex;justify-content:space-between}
#alert-list{margin-top:12px}
.note{position:fixed;left:-9999px;top:0;width:400px;background:white;color:#111;padding:25px}
@media(max-width:520px){.db{padding:12px}.boxes{gap:6px}.box{padding:9px}.num{font-size:28px}}
</style>
</head>
<body>
<div class="db">
<div class="top">
<div class="title">${name} Pool</div>
<div class="pill ${poolLocked ? 'locked' : 'live'}" id="status">${poolLocked ? 'LOCKED' : 'LIVE'}</div>
</div>

<div class="tabs">
<a href="/" class="${base ? '' : 'active'}">Mwos</a>
<a href="/gsb" class="${base ? 'active' : ''}">GSB</a>
</div>

<div class="boxes">
<div class="box">
<h3>FREE</h3><div class="num" id="free">${free}</div>
<a href="${base}/view/free">View free</a>
</div>
<div class="box">
<h3>IN USE</h3><div class="num" id="inuse">${inUse}</div>
<a href="${base}/view/inuse">View in use</a>
</div>
<div class="box">
<h3>WAITING 24H</h3><div class="num" id="waiting">${waiting}</div>
<a href="${base}/view/waiting">View waiting</a>
</div>
</div>

<div class="box bad">
<h3>BAD PASSWORD</h3>
<div class="num" id="bad">${bad.length}</div>
<a href="${base}/view/bad">View bad passwords</a>
</div>

<div class="add">
<h3>Add account to both pools</h3>
<input id="phone" placeholder="Phone number">
<input id="password" placeholder="Password">
<button id="add-btn">Add account</button>
<div class="message" id="message"></div>
</div>

<div class="alerts">
<h3>Deposit / Cashout Alerts</h3>
<button id="view-alerts">View IDs & Numbers</button>
<button class="clear" id="clear-alerts">Clear alerts</button>
<div id="alert-list"></div>
</div>

<div class="footer">
<span id="clock">Zambia time</span>
<span>PostgreSQL · ${name}</span>
</div>
</div>

<div class="note" id="printable">
<h3 id="print-title"></h3>
<p id="print-date"></p>
<div id="print-rows"></div>
</div>

<script>
const base=${JSON.stringify(base)};

function updateClock(){
 document.getElementById('clock').textContent=
 new Date().toLocaleTimeString('en-GB',{timeZone:'Africa/Lusaka'})+' CAT';
}
updateClock();
setInterval(updateClock,1000);

async function refreshStats(){
 try{
  const d=await (await fetch(base+'/stats')).json();
  document.getElementById('free').textContent=d.free;
  document.getElementById('inuse').textContent=d.inUse;
  document.getElementById('waiting').textContent=d.waiting;
  document.getElementById('bad').textContent=d.badPassword;
  const status=document.getElementById('status');
  status.textContent=d.locked?'LOCKED':'LIVE';
  status.className='pill '+(d.locked?'locked':'live');
 }catch(e){}
}
refreshStats();
setInterval(refreshStats,2000);

document.getElementById('add-btn').addEventListener('click',async()=>{
 const phone=document.getElementById('phone').value.trim();
 const password=document.getElementById('password').value;
 const msg=document.getElementById('message');

 if(!phone||!password){msg.textContent='Enter phone and password.';return;}

 try{
  const d=await (await fetch(base+'/add-account',{
   method:'POST',
   headers:{'Content-Type':'application/json'},
   body:JSON.stringify({phone,password})
  })).json();

  msg.textContent=d.success?'Account added to both pools.':d.error;
  if(d.success){
   document.getElementById('phone').value='';
   document.getElementById('password').value='';
   refreshStats();
  }
 }catch(e){msg.textContent='Network error.';}
});

let alertBoxes=[];

function parseId(tabId){
 const m=String(tabId).match(/ID:\\\\s*(\\\\S+)\\\\s*\\\\(([^)]+)\\\\)/);
 if(m)return {id:m[1],phone:m[2].replace(/^\\\\+260/,'')};
 const fallback=String(tabId).replace(/^ID:\\\\s*/,'');
 return {id:fallback,phone:''};
}

async function loadAlerts(){
 try{
  const data=await (await fetch(base+'/alerts')).json();
  const unique=[];
  const seen=new Set();

  data.forEach(a=>{
   if(!seen.has(a.tabId)){seen.add(a.tabId);unique.push(a);}
  });

  alertBoxes=[];
  for(let i=0;i<unique.length;i+=30){
   alertBoxes.push(unique.slice(i,i+30));
  }

  const container=document.getElementById('alert-list');
  container.innerHTML='';

  if(!unique.length){
   container.textContent='No alerts.';
   return;
  }

  alertBoxes.forEach((box,index)=>{
   const section=document.createElement('div');
   section.className='alert-item';

   const heading=document.createElement('h4');
   heading.textContent='BOX '+(index+1)+' - '+box.length+'/30';
   section.appendChild(heading);

   box.forEach((a,i)=>{
    const p=parseId(a.tabId);
    const line=document.createElement('div');
    line.textContent=(i+1)+'. '+p.id+(p.phone?' | '+p.phone:'');
    section.appendChild(line);
   });

   if(box.length===30){
    const save=document.createElement('button');
    save.textContent='Save IDs & Numbers';
    save.addEventListener('click',()=>saveBox(index,'both'));
    section.appendChild(save);

    const saveIds=document.createElement('button');
    saveIds.textContent='Save IDs Only';
    saveIds.addEventListener('click',()=>saveBox(index,'id'));
    section.appendChild(saveIds);
   }

   container.appendChild(section);
  });
 }catch(e){
  document.getElementById('alert-list').textContent='Could not load alerts.';
 }
}

document.getElementById('view-alerts').addEventListener('click',loadAlerts);

document.getElementById('clear-alerts').addEventListener('click',async()=>{
 const pin=prompt('Enter PIN to clear alerts:');
 if(pin===null)return;

 try{
  const d=await (await fetch(base+'/clear-alerts',{
   method:'POST',
   headers:{'Content-Type':'application/json'},
   body:JSON.stringify({pin})
  })).json();

  if(d.ok){
   document.getElementById('alert-list').textContent='No alerts.';
   alert('Alerts cleared.');
  }else{
   alert(d.error||'Incorrect PIN.');
  }
 }catch(e){alert('Network error.');}
});

function saveBox(index,mode){
 const box=alertBoxes[index];
 if(!box)return;

 if(typeof html2canvas==='undefined'){
  alert('Image saving library did not load.');
  return;
 }

 const rows=document.getElementById('print-rows');
 rows.innerHTML='';

 box.forEach((a,i)=>{
  const p=parseId(a.tabId);
  const line=document.createElement('div');
  line.style.padding='7px';
  line.style.borderBottom='1px solid #ddd';

  line.textContent=(i+1)+'. '+(mode==='id'?p.id:
   mode==='phone'?p.phone:p.id+' | '+p.phone);

  rows.appendChild(line);
 });

 document.getElementById('print-title').textContent='BOX '+(index+1);
 document.getElementById('print-date').textContent=new Date().toLocaleString();

 html2canvas(document.getElementById('printable'),{
  scale:2,
  backgroundColor:'#ffffff'
 }).then(canvas=>{
  const link=document.createElement('a');
  link.download='box-'+(index+1)+'-'+mode+'.png';
  link.href=canvas.toDataURL('image/png');
  link.click();
 }).catch(e=>alert('Save failed: '+e.message));
}
</script>
</body>
</html>`);
        } catch (e) {
            console.error(name + ' dashboard:', e);
            res.status(500).send('Dashboard error.');
        }
    });

    const t = getZambiaTime();
    poolLocked = checkLockStatus(t.hour, t.minute).shouldLock;
    poolLockedReason = poolLocked
        ? 'Locked at 20:00. Unlocks at 04:00.'
        : '';

    console.log(name + ' pool ready.');
}

// ---------------- START ----------------

initDB().then(async () => {
    await setupPool('Mwos', '', mwos, 'alerts');
    await setupPool('GSB', '/gsb', gsb, 'gsb_alerts');

    app.listen(PORT, '0.0.0.0', () => {
        console.log('Location 2 server running on port ' + PORT);
        console.log('Timezone: Africa/Lusaka');
    });
}).catch(err => {
    console.error('Database startup error:', err);
    process.exit(1);
});
