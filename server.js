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

function escapeJS(value) {
    return JSON.stringify(String(value ?? ''));
}

function checkLockStatus(hour, minute) {
    const now = hour * 60 + minute;
    const start = LOCK_HOUR * 60 + LOCK_MINUTE;
    const end = UNLOCK_HOUR * 60 + UNLOCK_MINUTE;

    const locked = start < end
        ? now >= start && now < end
        : now >= start || now < end;

    return { shouldLock: locked };
}

// Adding through either dashboard adds the account to both pools.
function registerAddAccount(path) {
    app.post(path, async (req, res) => {
        try {
            const phone = String(req.body.phone || '').trim();
            const password = String(req.body.password || '');

            if (!phone || !password) {
                return res.json({
                    success: false,
                    error: 'Phone and password required.'
                });
            }

            const a = (await mwos.getAccounts()).some(x => x.phone === phone);
            const b = (await gsb.getAccounts()).some(x => x.phone === phone);

            if (a || b) {
                return res.json({
                    success: false,
                    error: 'Account already exists in one of the pools.'
                });
            }

            await mwos.addAccount(phone, password);
            await gsb.addAccount(phone, password);

            res.json({ success: true });
        } catch (e) {
            console.error('Add account error:', e);
            res.status(500).json({ success: false, error: e.message });
        }
    });
}

registerAddAccount('/add-account');
registerAddAccount('/gsb/add-account');

async function setupPool(name, base, store, alertsTable) {
    let poolLocked = false;
    let poolLockedReason = '';

    // 24-hour waiting period.
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
            console.error(name + ' auto-free error:', e);
        }
    }, 60000);

    // Heartbeat timeout: five minutes after a real heartbeat.
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
                        logoutTimeStr: pad(t.hour) + ':' + pad(t.minute) + ' (heartbeat timeout)',
                        lastHeartbeat: null,
                        inUseSince: null,
                        tabId: null
                    });
                }
            }
        } catch (e) {
            console.error(name + ' heartbeat error:', e);
        }
    }, 10000);

    // Three-hour fallback timeout.
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
            console.error(name + ' three-hour timeout error:', e);
        }
    }, 60000);

    // Lock and unlock schedule.
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

    // 21:00 sweep, once per Zambia calendar day.
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
            console.log(name + ' 21:00 sweep moved ' + moved + ' account(s).');
        } catch (e) {
            console.error(name + ' sweep error:', e);
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

    // ---------------- LOGIN AND HEARTBEAT ----------------

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

            const account = await store.reLoginForTab(
                tabId,
                Date.now(),
                pad(t.hour) + ':' + pad(t.minute)
            );

            if (!account) {
                return res.json({
                    success: false,
                    error: 'No free accounts available.'
                });
            }

            res.json({
                success: true,
                phone: account.phone,
                password: account.password
            });
        } catch (e) {
            console.error(name + ' request-login error:', e);
            res.status(500).json({ success: false, error: 'Server error.' });
        }
    });

    app.post(base + '/heartbeat', async (req, res) => {
        try {
            const phone = String(req.body.phone || '');
            const accounts = await store.getAccounts();
            const account = accounts.find(a => a.phone === phone);

            if (!account || account.status !== 'IN-USE' || account.logoutTime) {
                return res.json({ success: false, error: 'Account not active.' });
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

    // ---------------- BAD PASSWORD AND REMOVE ----------------

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

    app.post(base + '/remove-account', async (req, res) => {
        try {
            if (req.body.pin !== REMOVE_PASSWORD) {
                return res.json({ success: false, error: 'Incorrect PIN.' });
            }

            await store.removeAccount(String(req.body.phone || ''));
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    app.post(base + '/remove-bad-password', async (req, res) => {
        try {
            if (req.body.pin !== REMOVE_PASSWORD) {
                return res.json({ success: false, error: 'Incorrect PIN.' });
            }

            await store.removeBadPasswordAccount(String(req.body.phone || ''));
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    // ---------------- ALERTS ----------------

    app.post(base + '/cashout', async (req, res) => {
        try {
            const tabId = String(req.body.tabId || '');

            if (!tabId.startsWith('ID:')) {
                return res.json({ ok: false, error: 'Invalid tabId.' });
            }

            await pool.query(
                `INSERT INTO ${alertsTable} (tab_id,amount,timestamp)
                 VALUES ($1,$2,$3)`,
                [
                    tabId,
                    Number(req.body.amount || 0),
                    Number(req.body.timestamp || Date.now())
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

    app.post(base + '/clear-alerts', async (req, res) => {
        try {
            if (req.body.pin !== REMOVE_PASSWORD) {
                return res.status(403).json({ ok: false, error: 'Incorrect PIN.' });
            }

            await pool.query(`DELETE FROM ${alertsTable}`);
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false });
        }
    });

    // ---------------- RESET AND DELETE ----------------

    app.post(base + '/reset', async (req, res) => {
        try {
            if (req.body.pin !== REMOVE_PASSWORD) {
                return res.status(403).json({ success: false, error: 'Incorrect PIN.' });
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
            if (req.body.pin !== REMOVE_PASSWORD) {
                return res.status(403).json({ success: false, error: 'Incorrect PIN.' });
            }

            await store.deleteAllAccounts();
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    // ---------------- ACCOUNT LIST PAGES ----------------

    function listPage(title, subtitle, rows, endpoint) {
        return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHTML(title)}</title>
<style>
*{box-sizing:border-box}
body{font-family:Arial;background:#04060a;color:#e6edf3;padding:20px}
.page{max-width:550px;margin:auto;background:#0d1117;border-radius:15px;overflow:hidden}
header{padding:18px;border-bottom:1px solid #30363d}
a{color:#8b949e;text-decoration:none}
input{width:100%;padding:12px;background:#161b22;color:white;border:1px solid #30363d;border-radius:8px;margin-top:12px}
.row{display:flex;align-items:center;gap:12px;padding:14px;border-bottom:1px solid #21262d}
.info{flex:1;min-width:0;overflow-wrap:anywhere}
.phone{font-weight:bold}.password{font-size:12px;color:#8b949e;margin-top:4px}
button{background:#7f1d1d;color:#fff;border:0;padding:8px 12px;border-radius:7px}
.empty{padding:30px;text-align:center;color:#8b949e}
</style>
</head>
<body>
<div class="page">
<header>
<a href="${base}/">← Back</a>
<h3>${escapeHTML(title)}</h3>
<small>${escapeHTML(subtitle)}</small>
<input id="search" placeholder="Search phone number">
</header>
<div id="list">${rows || '<div class="empty">No accounts</div>'}</div>
</div>
<script>
document.getElementById('search').addEventListener('input',function(){
 const q=this.value.toLowerCase();
 document.querySelectorAll('.row').forEach(r=>{
  r.style.display=r.dataset.phone.toLowerCase().includes(q)?'flex':'none';
 });
});
async function removeAccount(phone){
 const pin=prompt('Enter removal PIN:');
 if(pin===null)return;
 const response=await fetch('${base}/${endpoint}',{
  method:'POST',
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify({phone,pin})
 });
 const result=await response.json();
 if(result.success){
  const row=document.querySelector('[data-phone="'+CSS.escape(phone)+'"]');
  if(row)row.remove();
 }else{
  alert(result.error||'Could not remove account.');
 }
}
</script>
</body>
</html>`;
    }

    app.get(base + '/view/free', async (req, res) => {
        try {
            const list = (await store.getAccounts())
                .filter(a => a.status === 'FREE')
                .sort((a, b) => (a.freedAt || 0) - (b.freedAt || 0));

            const rows = list.map(a => `
                <div class="row" data-phone="${escapeHTML(a.phone)}">
                    <div class="info">
                        <div class="phone">${escapeHTML(a.phone)}</div>
                        <div class="password">${escapeHTML(a.password)}</div>
                    </div>
                    <button onclick="removeAccount(${escapeJS(a.phone)})">Remove</button>
                </div>
            `).join('');

            res.send(listPage('Free Accounts', list.length + ' ready', rows, 'remove-account'));
        } catch (e) {
            res.status(500).send('Error loading accounts.');
        }
    });

    app.get(base + '/view/inuse', async (req, res) => {
        try {
            const list = (await store.getAccounts())
                .filter(a => a.status === 'IN-USE' && !a.logoutTime);

            const rows = list.map(a => `
                <div class="row" data-phone="${escapeHTML(a.phone)}">
                    <div class="info">
                        <div class="phone">${escapeHTML(a.phone)}</div>
                        <div class="password">Tab: ${escapeHTML(a.tabId || 'Not assigned')}</div>
                    </div>
                </div>
            `).join('');

            res.send(listPage('In Use', list.length + ' accounts', rows, 'remove-account'));
        } catch (e) {
            res.status(500).send('Error loading accounts.');
        }
    });

    app.get(base + '/view/waiting', async (req, res) => {
        try {
            const list = (await store.getAccounts())
                .filter(a => a.status === 'IN-USE' && a.logoutTime)
                .sort((a, b) => a.logoutTime - b.logoutTime);

            const rows = list.map(a => {
                const freeAt = a.logoutTime + TWENTY_FOUR_HOURS_MS;

                return `
                    <div class="row" data-phone="${escapeHTML(a.phone)}">
                        <div class="info">
                            <div class="phone">${escapeHTML(a.phone)}</div>
                            <div class="password">${escapeHTML(a.logoutTimeStr || '')}</div>
                            <div class="password" data-freeat="${freeAt}">Calculating...</div>
                        </div>
                    </div>
                `;
            }).join('');

            res.send(listPage('Waiting 24h', list.length + ' accounts', rows, 'remove-account').replace(
                '</body>',
                `<script>
                function updateWaiting(){
                    document.querySelectorAll('[data-freeat]').forEach(el=>{
                        const diff=Number(el.dataset.freeat)-Date.now();
                        if(diff<=0){el.textContent='Ready';return;}
                        const h=Math.floor(diff/3600000);
                        const m=Math.floor(diff%3600000/60000);
                        const s=Math.floor(diff%60000/1000);
                        el.textContent='Free in: '+h+'h '+m+'m '+s+'s';
                    });
                }
                updateWaiting();setInterval(updateWaiting,1000);
                </script></body>`
            ));
        } catch (e) {
            res.status(500).send('Error loading waiting accounts.');
        }
    });

    app.get(base + '/view/bad', async (req, res) => {
        try {
            const list = await store.getBadPasswordAccounts();

            const rows = list.map(a => `
                <div class="row" data-phone="${escapeHTML(a.phone)}">
                    <div class="info">
                        <div class="phone">${escapeHTML(a.phone)}</div>
                        <div class="password">${escapeHTML(a.password || '')}</div>
                        <div class="password">${escapeHTML(a.reportedAt || '')}</div>
                    </div>
                    <button onclick="removeAccount(${escapeJS(a.phone)})">Remove</button>
                </div>
            `).join('');

            res.send(listPage('Bad Password', list.length + ' accounts', rows, 'remove-bad-password'));
        } catch (e) {
            res.status(500).send('Error loading bad-password accounts.');
        }
    });

    // ---------------- DASHBOARD ----------------

    app.get(base || '/', async (req, res) => {
        try {
            const accounts = await store.getAccounts();
            const free = accounts.filter(a => a.status === 'FREE').length;
            const inUse = accounts.filter(a => a.status === 'IN-USE' && !a.logoutTime).length;
            const waiting = accounts.filter(a => a.status === 'IN-USE' && a.logoutTime).length;
            const bad = (await store.getBadPasswordAccounts()).length;

            res.send(`<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} Location 2 Pool</title>
<style>
*{box-sizing:border-box}
body{font-family:Arial;background:#04060a;color:#e6edf3;padding:20px}
.dashboard{max-width:760px;margin:auto;background:#080b10;border-radius:18px;padding:20px}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}
h2{font-size:20px}
.status{padding:7px 13px;border-radius:20px;background:${poolLocked ? '#4b1111' : '#0d4429'};color:${poolLocked ? '#f87171' : '#3fb950'}}
.tabs{display:flex;gap:10px;margin-bottom:18px}
.tabs a{flex:1;text-align:center;padding:12px;background:#161b22;border-radius:9px;color:#fff;text-decoration:none}
.tabs a.active{background:#1a3a6e}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.card{padding:15px;border-radius:12px;background:#111827;min-width:0}
.card h3{font-size:11px;color:#8b949e}
.number{font-size:36px;margin:12px 0}
.card a{display:block;text-align:center;background:#26364e;color:#fff;text-decoration:none;padding:9px;border-radius:7px;font-size:12px}
.add{margin-top:20px;padding:15px;background:#111827;border-radius:12px}
input{padding:12px;background:#161b22;border:1px solid #30363d;color:white;border-radius:7px;min-width:0}
.add input{width:100%;margin:5px 0}
button{padding:11px 15px;border:0;border-radius:7px;background:#1a3a6e;color:white;cursor:pointer}
.message{font-size:13px;margin-top:10px}
.alerts{margin-top:18px;padding:15px;background:#111827;border-radius:12px}
.alert-item{padding:9px;border-bottom:1px solid #30363d;overflow-wrap:anywhere}
.footer{margin-top:18px;color:#8b949e;font-size:11px;display:flex;justify-content:space-between}
@media(max-width:520px){.dashboard{padding:12px}.cards{gap:6px}.card{padding:10px}.number{font-size:27px}.card h3{font-size:9px}}
</style>
</head>
<body>
<div class="dashboard">
<div class="top">
<h2>${name} Pool - Location 2</h2>
<div class="status" id="status">${poolLocked ? 'LOCKED' : 'LIVE'}</div>
</div>

<div class="tabs">
<a href="/" class="${base ? '' : 'active'}">Mwos</a>
<a href="/gsb" class="${base ? 'active' : ''}">GSB</a>
</div>

<div class="cards">
<div class="card">
<h3>FREE</h3><div class="number" id="free">${free}</div>
<a href="${base}/view/free">View free</a>
</div>
<div class="card">
<h3>IN USE</h3><div class="number" id="inuse">${inUse}</div>
<a href="${base}/view/inuse">View in use</a>
</div>
<div class="card">
<h3>WAITING 24H</h3><div class="number" id="waiting">${waiting}</div>
<a href="${base}/view/waiting">View waiting</a>
</div>
</div>

<div class="card" style="margin-top:10px">
<h3>BAD PASSWORD</h3><div class="number">${bad}</div>
<a href="${base}/view/bad">View bad passwords</a>
</div>

<div class="add">
<h3>Add account</h3>
<input id="phone" placeholder="Phone number">
<input id="password" placeholder="Password">
<button id="add">Add account to both pools</button>
<div class="message" id="message"></div>
</div>

<div class="alerts">
<h3>Deposit / Cashout Alerts</h3>
<button id="show-alerts">View IDs and Numbers</button>
<button id="clear-alerts" style="background:#7f1d1d">Clear alerts</button>
<div id="alert-list"></div>
</div>

<div class="footer">
<span id="clock">Zambia time</span>
<span>PostgreSQL · Location 2</span>
</div>
</div>

<script>
const base=${JSON.stringify(base)};
const pinPrompt=()=>prompt('Enter PIN:');

function clock(){
 document.getElementById('clock').textContent=
 new Date().toLocaleTimeString('en-GB',{timeZone:'Africa/Lusaka'})+' CAT';
}
clock();setInterval(clock,1000);

async function refresh(){
 try{
  const r=await fetch(base+'/stats');
  const d=await r.json();
  document.getElementById('free').textContent=d.free;
  document.getElementById('inuse').textContent=d.inUse;
  document.getElementById('waiting').textContent=d.waiting;
  document.getElementById('status').textContent=d.locked?'LOCKED':'LIVE';
 }catch(e){}
}
refresh();setInterval(refresh,3000);

document.getElementById('add').addEventListener('click',async()=>{
 const phone=document.getElementById('phone').value.trim();
 const password=document.getElementById('password').value;
 const message=document.getElementById('message');

 if(!phone||!password){message.textContent='Enter phone and password.';return;}

 try{
  const r=await fetch(base+'/add-account',{
   method:'POST',
   headers:{'Content-Type':'application/json'},
   body:JSON.stringify({phone,password})
  });
  const d=await r.json();
  message.textContent=d.success?'Account added to both pools.':d.error;
  if(d.success){
   document.getElementById('phone').value='';
   document.getElementById('password').value='';
   refresh();
  }
 }catch(e){message.textContent='Network error.';}
});

async function loadAlerts(){
 const r=await fetch(base+'/alerts');
 const data=await r.json();
 const list=document.getElementById('alert-list');
 list.innerHTML='';

 const seen=new Set();
 data.forEach(a=>{
  if(seen.has(a.tabId))return;
  seen.add(a.tabId);
  const item=document.createElement('div');
  item.className='alert-item';
  item.textContent=a.tabId+' | '+a.amount;
  list.appendChild(item);
 });
 if(!data.length)list.textContent='No alerts.';
}

document.getElementById('show-alerts').addEventListener('click',loadAlerts);

document.getElementById('clear-alerts').addEventListener('click',async()=>{
 const pin=pinPrompt();
 if(pin===null)return;

 const r=await fetch(base+'/clear-alerts',{
  method:'POST',
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify({pin})
 });
 const d=await r.json();

 if(d.ok){await loadAlerts();alert('Alerts cleared.');}
 else alert(d.error||'Could not clear alerts.');
});
</script>
</body>
</html>`);
        } catch (e) {
            console.error(name + ' dashboard error:', e);
            res.status(500).send('Dashboard error.');
        }
    });

    const t = getZambiaTime();
    poolLocked = checkLockStatus(t.hour, t.minute).shouldLock;
    poolLockedReason = poolLocked
        ? 'Locked at 20:00. Unlocks at 04:00.'
        : '';

    console.log(name + ' pool initialized.');
}

// ---------------- START SERVER ----------------

initDB().then(async () => {
    await setupPool('Mwos', '', mwos, 'alerts');
    await setupPool('GSB', '/gsb', gsb, 'gsb_alerts');

    app.listen(PORT, '0.0.0.0', () => {
        console.log('Location 2 Pool Manager listening on port ' + PORT);
        console.log('Timezone: Africa/Lusaka');
    });
}).catch(err => {
    console.error('Location 2 startup failed:', err);
    process.exit(1);
});
