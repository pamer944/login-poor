const express = require('express');
const {
    pool, initDB, mwos, gsb,
    getZambiaTime, TWENTY_FOUR_HOURS_MS,
    LOCK_HOUR, LOCK_MINUTE, UNLOCK_HOUR, UNLOCK_MINUTE,
    REMOVE_PASSWORD, HEARTBEAT_TIMEOUT_MS, TIMEZONE
} = require('./accounts');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

function pad(n) {
    return String(n).padStart(2, '0');
}

function checkLockStatus(hour, minute) {
    const t = hour * 60 + minute;
    const start = LOCK_HOUR * 60 + LOCK_MINUTE;
    const end = UNLOCK_HOUR * 60 + UNLOCK_MINUTE;
    const locked = start <= end
        ? t >= start && t < end
        : t >= start || t < end;

    return {
        shouldLock: locked,
        isWorkingHours: !locked,
        isLowAccounts: false
    };
}

const HEARTBEAT_SILENCE_TIMEOUT_MS = 3 * 60 * 60 * 1000;

function registerAddAccount(path) {
    app.post(path, async (req, res) => {
        try {
            const { phone, password } = req.body;
            if (!phone || !password) {
                return res.json({ success: false, error: 'Phone and password required.' });
            }

            const inMwos = (await mwos.getAccounts()).some(a => a.phone === phone);
            const inGsb = (await gsb.getAccounts()).some(a => a.phone === phone);

            if (inMwos && inGsb) {
                return res.json({ success: false, error: 'Account already exists.' });
            }

            if (!inMwos) await mwos.addAccount(phone, password);
            if (!inGsb) await gsb.addAccount(phone, password);

            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });
}

registerAddAccount('/add-account');
registerAddAccount('/gsb/add-account');

async function setupPool(name, base, store, alertsTable) {
    let poolLocked = false;
    let poolLockedReason = '';

    // Automatically return accounts to FREE after 24 hours.
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
            console.error('Auto-free error:', e);
        }
    }, 60000);

    // Heartbeat timeout: only after a real heartbeat has arrived.
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
                    const { hour, minute } = getZambiaTime();

                    await store.updateAccount(acc.phone, {
                        logoutTime: Date.now(),
                        logoutTimeStr: pad(hour) + ':' + pad(minute) + ' (tab closed)',
                        inUseSince: null,
                        tabId: null
                    });
                }
            }
        } catch (e) {
            console.error('Heartbeat check error:', e);
        }
    }, 10000);

    // Three-hour no-heartbeat fallback.
    setInterval(async () => {
        try {
            const accounts = await store.getAccounts();
            const now = Date.now();

            for (const acc of accounts) {
                if (
                    acc.status === 'IN-USE' &&
                    !acc.logoutTime &&
                    acc.lastHeartbeat &&
                    now - acc.lastHeartbeat > HEARTBEAT_SILENCE_TIMEOUT_MS
                ) {
                    const { hour, minute } = getZambiaTime();

                    await store.updateAccount(acc.phone, {
                        logoutTime: Date.now(),
                        logoutTimeStr: pad(hour) + ':' + pad(minute) + ' (3h no heartbeat)',
                        inUseSince: null,
                        tabId: null
                    });
                }
            }
        } catch (e) {
            console.error('Timeout check error:', e);
        }
    }, 60000);

    // Scheduled lock and unlock.
    setInterval(async () => {
        try {
            const { hour, minute } = getZambiaTime();
            const { shouldLock } = checkLockStatus(hour, minute);

            if (shouldLock && !poolLocked) {
                poolLocked = true;
                poolLockedReason = 'Locked at 20:00. Unlocks at 04:00.';
                console.log('[' + name + '] Pool locked.');
            } else if (!shouldLock && poolLocked) {
                poolLocked = false;
                poolLockedReason = '';
                console.log('[' + name + '] Pool unlocked.');
            }
        } catch (e) {
            console.error('Lock check error:', e);
        }
    }, 10000);

    // 21:00 sweep: move active accounts into Waiting.
    let lastSweepDate = null;

    setInterval(async () => {
        try {
            const { hour } = getZambiaTime();
            if (hour !== 21) return;

            const today = new Date().toLocaleDateString('en-CA', {
                timeZone: TIMEZONE
            });

            if (lastSweepDate === today) return;

            const accounts = await store.getAccounts();
            const { hour: h, minute: m } = getZambiaTime();
            const timeStr = pad(h) + ':' + pad(m);
            let moved = 0;

            for (const acc of accounts) {
                if (acc.status === 'IN-USE' && !acc.logoutTime) {
                    await store.updateAccount(acc.phone, {
                        logoutTime: Date.now(),
                        logoutTimeStr: timeStr + ' (21:00 sweep)',
                        lastHeartbeat: null,
                        inUseSince: null,
                        tabId: null
                    });
                    moved++;
                }
            }

            lastSweepDate = today;
            console.log('[' + name + '] 21:00 sweep moved ' + moved + ' account(s).');
        } catch (e) {
            console.error('Sweep error:', e);
        }
    }, 30000);

    // API endpoints continue in Part 2.
