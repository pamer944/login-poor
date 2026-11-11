const express = require('express');
const {
    pool, initDB, bwinners,
    getAccounts, getAccountByTabId,
    claimFreeAccount, reLoginForTab, updateAccount,
    addAccount, removeAccount, resetAllAccounts, deleteAllAccounts,
    getBadPasswordAccounts, addBadPasswordAccount, removeBadPasswordAccount,
    getZambiaTime, ACCOUNT_LOCK_MS,
    REMOVE_PASSWORD, HEARTBEAT_TIMEOUT_MS, TIMEZONE
} = require('./accounts');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

function pad(n) {
    return String(n).padStart(2, '0');
}

const HEARTBEAT_SILENCE_TIMEOUT_MS = 3 * 60 * 60 * 1000;

// Pool lock: 22:00 until 14:00 Zambia time.
const POOL_LOCK_START_MINUTES = 22 * 60;
const POOL_UNLOCK_MINUTES = 14 * 60;

function isPoolTimeLocked(hour, minute) {
    const nowMinutes = hour * 60 + minute;

    return nowMinutes >= POOL_LOCK_START_MINUTES ||
           nowMinutes < POOL_UNLOCK_MINUTES;
}

app.post('/add-account', async (req, res) => {
    try {
        const { phone, password } = req.body || {};

        if (!phone || !password) {
            return res.json({
                success: false,
                error: 'Phone and password required.'
            });
        }

        const existing = (await bwinners.getAccounts())
            .some(a => a.phone === phone);

        if (existing) {
            return res.json({
                success: false,
                error: 'Account already exists.'
            });
        }

        await bwinners.addAccount(phone, password);
        res.json({ success: true });

    } catch (e) {
        res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

async function setupPool(name, base, store, alertsTable) {
    let poolLocked = false;
    let poolLockedReason = '';
    let lastSweepDate = '';

    // Pool schedule and daily 23:00 sweep.
    async function updatePoolSchedule() {
        const { hour, minute } = getZambiaTime();

        const lockedNow = isPoolTimeLocked(hour, minute);

        if (lockedNow && !poolLocked) {
            poolLocked = true;
            poolLockedReason =
                'Pool locked at 22:00. Unlocks at 14:00 (Zambia time).';

            console.log('[' + name + '] Pool locked:', poolLockedReason);

        } else if (!lockedNow && poolLocked) {
            poolLocked = false;
            poolLockedReason = '';

            console.log('[' + name + '] Pool unlocked at 14:00.');
        }

        const today = new Date().toLocaleDateString('en-CA', {
            timeZone: 'Africa/Lusaka',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        });

        // Sweep once per Zambia calendar day during 23:00.
        if (hour === 23 && lastSweepDate !== today) {
            lastSweepDate = today;

            const accounts = await store.getAccounts();
            const stamp =
                pad(hour) + ':' + pad(minute) + ' (23:00 sweep)';

            let swept = 0;

            for (const acc of accounts) {
                if (acc.status === 'IN-USE' && !acc.logoutTime) {
                    await store.updateAccount(acc.phone, {
                        logoutTime: Date.now(),
                        logoutTimeStr: stamp,
                        lastHeartbeat: null,
                        inUseSince: null,
                        tabId: null
                    });

                    swept++;
                }
            }

            console.log(
                '[' + name + '] 23:00 sweep completed. Accounts moved to Waiting:',
                swept
            );
        }
    }

    updatePoolSchedule().catch(e =>
        console.error('pool-schedule error:', e)
    );

    setInterval(() => {
        updatePoolSchedule().catch(e =>
            console.error('pool-schedule error:', e)
        );
    }, 10 * 1000);

    // Free accounts after their existing 24-hour lock.
    setInterval(async () => {
        try {
            const accounts = await store.getAccounts();
            const now = Date.now();

            for (const acc of accounts) {
                if (
                    acc.status === 'IN-USE' &&
                    acc.logoutTime &&
                    (now - acc.logoutTime >= ACCOUNT_LOCK_MS)
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
            console.error('auto-free error:', e);
        }
    }, 60 * 1000);

    // Heartbeat timeout.
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
                        logoutTimeStr:
                            pad(hour) + ':' + pad(minute) + ' (tab closed)',
                        inUseSince: null,
                        tabId: null
                    });
                }
            }

        } catch (e) {
            console.error('heartbeat-check error:', e);
        }
    }, 10 * 1000);

    // Three-hour heartbeat silence timeout.
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
                        logoutTimeStr:
                            pad(hour) + ':' + pad(minute) + ' (3h no heartbeat)',
                        inUseSince: null,
                        tabId: null
                    });
                }
            }

        } catch (e) {
            console.error('timeout-check error:', e);
        }
    }, 60 * 1000);

    // API ENDPOINTS

    app.get(base + '/stats', async (req, res) => {
        try {
            const accounts = await store.getAccounts();
            const badPasswordAccounts =
                await store.getBadPasswordAccounts();

            res.json({
                free: accounts.filter(a => a.status === 'FREE').length,
                inUse: accounts.filter(
                    a => a.status === 'IN-USE' && !a.logoutTime
                ).length,
                waiting: accounts.filter(
                    a => a.status === 'IN-USE' && a.logoutTime
                ).length,
                badPassword: badPasswordAccounts.length,
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

            const list = accounts
                .filter(a => a.status === 'IN-USE' && !a.logoutTime)
                .sort((a, b) => {
                    const aNum = a.tabId
                        ? parseInt(a.tabId.replace('TAB-', ''))
                        : 9999;

                    const bNum = b.tabId
                        ? parseInt(b.tabId.replace('TAB-', ''))
                        : 9999;

                    return aNum - bNum;
                })
                .map(a => ({
                    phone: a.phone,
                    lastHeartbeat: a.lastHeartbeat,
                    tabId: a.tabId
                }));

            res.json(list);

        } catch (e) {
            res.status(500).json([]);
        }
    });

    app.post(base + '/heartbeat', async (req, res) => {
        try {
            const { phone } = req.body;
            const accounts = await store.getAccounts();
            const account = accounts.find(a => a.phone === phone);

            if (
                account &&
                account.status === 'IN-USE' &&
                !account.logoutTime
            ) {
                await store.updateAccount(phone, {
                    lastHeartbeat: Date.now()
                });

                return res.json({ success: true });
            }

            res.json({
                success: false,
                error: 'Account not found or not in use.'
            });

        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    app.post(base + '/tab-closed', express.text({ type: '*/*' }), async (req, res) => {
        try {
            let phone;

            if (typeof req.body === 'string') {
                phone = JSON.parse(req.body).phone;
            } else if (req.body && req.body.phone) {
                phone = req.body.phone;
            }

            if (!phone) {
                return res.json({ success: false });
            }

            const accounts = await store.getAccounts();
            const account = accounts.find(a => a.phone === phone);

            if (
                account &&
                account.status === 'IN-USE' &&
                !account.logoutTime
            ) {
                const { hour, minute } = getZambiaTime();

                await store.updateAccount(phone, {
                    logoutTime: Date.now(),
                    logoutTimeStr:
                        pad(hour) + ':' + pad(minute) + ' (tab closed)'
                });
            }

            res.json({ success: true });

        } catch (e) {
            res.json({ success: false });
        }
    });

    app.post(base + '/request-login', async (req, res) => {
        try {
            const { tabId } = req.body;

            if (!tabId) {
                return res.json({
                    success: false,
                    error: 'Tab ID required.'
                });
            }

            if (poolLocked) {
                return res.json({
                    success: false,
                    error: 'Pool locked. ' + poolLockedReason
                });
            }

            const { hour, minute } = getZambiaTime();

            const claimed = await store.reLoginForTab(
                tabId,
                Date.now(),
                pad(hour) + ':' + pad(minute)
            );

            if (claimed) {
                return res.json({
                    success: true,
                    phone: claimed.phone,
                    password: claimed.password
                });
            }

            return res.json({
                success: false,
                error: 'No free accounts available'
            });

        } catch (e) {
            console.error('request-login error:', e);

            res.json({
                success: false,
                error: 'Server error'
            });
        }
    });
