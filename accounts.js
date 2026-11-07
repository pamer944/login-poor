const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const FREE_ACCOUNT_LOCK_THRESHOLD = 50;
// Time lock: both pools are always locked 20:00 -> 04:00 (Zambia), regardless of free count.
// The window crosses midnight; checkLockStatus in server.js handles the wrap.
const LOCK_HOUR = 20;
const LOCK_MINUTE = 0;
const UNLOCK_HOUR = 4;
const UNLOCK_MINUTE = 0;
const REMOVE_PASSWORD = '1234';
const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;
const TIMEZONE = 'Africa/Lusaka';

async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS accounts (
            phone TEXT PRIMARY KEY,
            password TEXT NOT NULL,
            status TEXT DEFAULT 'FREE',
            logout_time BIGINT DEFAULT NULL,
            logout_time_str TEXT DEFAULT NULL,
            last_heartbeat BIGINT DEFAULT NULL,
            in_use_since BIGINT DEFAULT NULL,
            tab_id TEXT DEFAULT NULL,
            freed_at BIGINT DEFAULT NULL
        );
    `);
    await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS in_use_since BIGINT DEFAULT NULL;`);
    await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS tab_id TEXT DEFAULT NULL;`);
    await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS freed_at BIGINT DEFAULT NULL;`);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS alerts (
            id SERIAL PRIMARY KEY,
            tab_id TEXT,
            amount NUMERIC DEFAULT 0,
            timestamp BIGINT,
            created_at TIMESTAMP DEFAULT NOW()
        );
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS bad_password_accounts (
            phone TEXT PRIMARY KEY,
            password TEXT,
            reported_at TEXT,
            status TEXT DEFAULT 'BAD_PASSWORD'
        );
    `);

    // GSB pool: same structure as Mwos, its own tables
    await pool.query(`
        CREATE TABLE IF NOT EXISTS gsb_accounts (
            phone TEXT PRIMARY KEY,
            password TEXT NOT NULL,
            status TEXT DEFAULT 'FREE',
            logout_time BIGINT DEFAULT NULL,
            logout_time_str TEXT DEFAULT NULL,
            last_heartbeat BIGINT DEFAULT NULL,
            in_use_since BIGINT DEFAULT NULL,
            tab_id TEXT DEFAULT NULL,
            freed_at BIGINT DEFAULT NULL
        );
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS gsb_alerts (
            id SERIAL PRIMARY KEY,
            tab_id TEXT,
            amount NUMERIC DEFAULT 0,
            timestamp BIGINT,
            created_at TIMESTAMP DEFAULT NOW()
        );
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS gsb_bad_password_accounts (
            phone TEXT PRIMARY KEY,
            password TEXT,
            reported_at TEXT,
            status TEXT DEFAULT 'BAD_PASSWORD'
        );
    `);

    const { rowCount } = await pool.query('SELECT 1 FROM accounts LIMIT 1');
    if (rowCount === 0) {
        const phoneList = [
        ];
        const values = [];
        const placeholders = [];
        phoneList.forEach(([phone, password], i) => {
            placeholders.push(`($${i * 2 + 1}, $${i * 2 + 2})`);
            values.push(phone, password);
        });
        if (placeholders.length > 0) {
            await pool.query(
                `INSERT INTO accounts (phone, password) VALUES ${placeholders.join(', ')} ON CONFLICT DO NOTHING`,
                values
            );
        }
        console.log('Accounts seeded into database.');
    }
}

// Each pool (Mwos, GSB) gets the same functions, pointed at its own tables.
// T = accounts table, B = bad-password table.
function makeStore(T, B) {
    async function getAccounts() {
        const { rows } = await pool.query(`SELECT * FROM ${T} ORDER BY phone ASC`);
        return rows.map(r => ({
            phone: r.phone,
            password: r.password,
            status: r.status,
            logoutTime: r.logout_time ? Number(r.logout_time) : null,
            logoutTimeStr: r.logout_time_str,
            lastHeartbeat: r.last_heartbeat ? Number(r.last_heartbeat) : null,
            inUseSince: r.in_use_since ? Number(r.in_use_since) : null,
            tabId: r.tab_id || null,
            freedAt: r.freed_at ? Number(r.freed_at) : null,
        }));
    }

    // Find an IN-USE account currently held by a specific tab ID
    async function getAccountByTabId(tabId) {
        const { rows } = await pool.query(
            `SELECT * FROM ${T} WHERE tab_id = $1 AND status = 'IN-USE' AND logout_time IS NULL LIMIT 1`,
            [tabId]
        );
        if (rows.length === 0) return null;
        const r = rows[0];
        return {
            phone: r.phone, password: r.password, status: r.status,
            logoutTime: r.logout_time ? Number(r.logout_time) : null,
            logoutTimeStr: r.logout_time_str,
            lastHeartbeat: r.last_heartbeat ? Number(r.last_heartbeat) : null,
            inUseSince: r.in_use_since ? Number(r.in_use_since) : null,
            tabId: r.tab_id || null,
            freedAt: r.freed_at ? Number(r.freed_at) : null,
        };
    }

    // Single-transaction: move old account to Waiting and claim a new one atomically
    async function reLoginForTab(tabId, heartbeatNow, logoutTimeStr) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            if (tabId) {
                const { rows: oldRows } = await client.query(
                    `SELECT phone FROM ${T} WHERE tab_id = $1 AND status = 'IN-USE' AND logout_time IS NULL LIMIT 1 FOR UPDATE SKIP LOCKED`,
                    [tabId]
                );
                if (oldRows.length > 0) {
                    await client.query(
                        `UPDATE ${T} SET logout_time = $2, logout_time_str = $3, last_heartbeat = NULL, in_use_since = NULL, tab_id = NULL WHERE phone = $1`,
                        [oldRows[0].phone, heartbeatNow, logoutTimeStr + ' (re-login)']
                    );
                }
            }
            const { rows: newRows } = await client.query(
                `SELECT phone, password FROM ${T} WHERE status = 'FREE' ORDER BY freed_at ASC NULLS LAST LIMIT 1 FOR UPDATE SKIP LOCKED`
            );
            if (newRows.length === 0) { await client.query('ROLLBACK'); return null; }
            const { phone, password } = newRows[0];
            await client.query(
                `UPDATE ${T} SET status = 'IN-USE', logout_time = NULL, logout_time_str = NULL, last_heartbeat = $2, in_use_since = $2, tab_id = $3, freed_at = NULL WHERE phone = $1`,
                [phone, heartbeatNow, tabId || null]
            );
            await client.query('COMMIT');
            return { phone, password };
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    // ATOMIC CLAIM: picks ONE free account and marks it IN-USE in a single SQL
    // statement. Orders by freed_at ASC NULLS LAST - accounts free longest go first.
    async function claimFreeAccount(heartbeatNow, tabId) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { rows } = await client.query(`
                SELECT phone, password FROM ${T}
                WHERE status = 'FREE'
                ORDER BY freed_at ASC NULLS LAST
                LIMIT 1
                FOR UPDATE SKIP LOCKED
            `);
            if (rows.length === 0) {
                await client.query('ROLLBACK');
                return null;
            }
            const { phone, password } = rows[0];
            await client.query(
                `UPDATE ${T} SET status = 'IN-USE', logout_time = NULL, logout_time_str = NULL, last_heartbeat = $2, in_use_since = $2, tab_id = $3, freed_at = NULL WHERE phone = $1`,
                [phone, heartbeatNow, tabId || null]
            );
            await client.query('COMMIT');
            return { phone, password };
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    async function updateAccount(phone, fields) {
        const map = { logoutTime: 'logout_time', logoutTimeStr: 'logout_time_str', lastHeartbeat: 'last_heartbeat', status: 'status', inUseSince: 'in_use_since', tabId: 'tab_id', freedAt: 'freed_at' };
        const keys = Object.keys(fields);
        const setClauses = keys.map((k, i) => `${map[k]} = $${i + 1}`).join(', ');
        const values = [...keys.map(k => fields[k]), phone];
        await pool.query(`UPDATE ${T} SET ${setClauses} WHERE phone = $${values.length}`, values);
    }

    async function addAccount(phone, password) {
        await pool.query(
            `INSERT INTO ${T} (phone, password, status) VALUES ($1, $2, 'FREE')`,
            [phone, password]
        );
    }

    async function removeAccount(phone) {
        await pool.query(`DELETE FROM ${T} WHERE phone = $1`, [phone]);
    }

    async function resetAllAccounts() {
        await pool.query(`UPDATE ${T} SET status = 'FREE', logout_time = NULL, logout_time_str = NULL, last_heartbeat = NULL`);
    }

    async function deleteAllAccounts() {
        await pool.query(`DELETE FROM ${T}`);
    }

    async function getBadPasswordAccounts() {
        const { rows } = await pool.query(`SELECT * FROM ${B}`);
        return rows.map(r => ({ phone: r.phone, password: r.password, reportedAt: r.reported_at, status: r.status }));
    }

    async function addBadPasswordAccount(phone, password, reportedAt) {
        await pool.query(
            `INSERT INTO ${B} (phone, password, reported_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [phone, password, reportedAt]
        );
    }

    async function removeBadPasswordAccount(phone) {
        await pool.query(`DELETE FROM ${B} WHERE phone = $1`, [phone]);
    }

    return { getAccounts, getAccountByTabId, reLoginForTab, claimFreeAccount, updateAccount, addAccount, removeAccount, resetAllAccounts, deleteAllAccounts, getBadPasswordAccounts, addBadPasswordAccount, removeBadPasswordAccount };
}

const mwos = makeStore('accounts', 'bad_password_accounts');
const gsb = makeStore('gsb_accounts', 'gsb_bad_password_accounts');


function getZambiaTime() {
    const now = new Date();
    const zambiaStr = now.toLocaleString('en-GB', { timeZone: TIMEZONE });
    const [datePart, timePart] = zambiaStr.split(', ');
    const [hours, minutes, seconds] = timePart.split(':').map(Number);
    return { hour: hours, minute: minutes, second: seconds };
}

module.exports = {
    pool,
    initDB,
    mwos,
    gsb,
    getAccounts: mwos.getAccounts,
    getAccountByTabId: mwos.getAccountByTabId,
    claimFreeAccount: mwos.claimFreeAccount,
    reLoginForTab: mwos.reLoginForTab,
    updateAccount: mwos.updateAccount,
    addAccount: mwos.addAccount,
    removeAccount: mwos.removeAccount,
    resetAllAccounts: mwos.resetAllAccounts,
    deleteAllAccounts: mwos.deleteAllAccounts,
    getBadPasswordAccounts: mwos.getBadPasswordAccounts,
    addBadPasswordAccount: mwos.addBadPasswordAccount,
    removeBadPasswordAccount: mwos.removeBadPasswordAccount,
    getZambiaTime,
    TWENTY_FOUR_HOURS_MS,
    FREE_ACCOUNT_LOCK_THRESHOLD,
    LOCK_HOUR,
    LOCK_MINUTE,
    UNLOCK_HOUR,
    UNLOCK_MINUTE,
    REMOVE_PASSWORD,
    HEARTBEAT_TIMEOUT_MS,
    TIMEZONE,
};
