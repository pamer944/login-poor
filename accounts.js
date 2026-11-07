const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is missing. Connect Location 2 to its own PostgreSQL database.');
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const LOCK_HOUR = 20;
const LOCK_MINUTE = 0;
const UNLOCK_HOUR = 4;
const UNLOCK_MINUTE = 0;
const REMOVE_PASSWORD = process.env.REMOVE_PASSWORD || '1234';
const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;
const TIMEZONE = 'Africa/Lusaka';

async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS accounts (
            phone TEXT PRIMARY KEY,
            password TEXT NOT NULL,
            status TEXT DEFAULT 'FREE',
            logout_time BIGINT,
            logout_time_str TEXT,
            last_heartbeat BIGINT,
            in_use_since BIGINT,
            tab_id TEXT,
            freed_at BIGINT
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS alerts (
            id SERIAL PRIMARY KEY,
            tab_id TEXT,
            amount NUMERIC DEFAULT 0,
            timestamp BIGINT,
            created_at TIMESTAMP DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS bad_password_accounts (
            phone TEXT PRIMARY KEY,
            password TEXT,
            reported_at TEXT,
            status TEXT DEFAULT 'BAD_PASSWORD'
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS gsb_accounts (
            phone TEXT PRIMARY KEY,
            password TEXT NOT NULL,
            status TEXT DEFAULT 'FREE',
            logout_time BIGINT,
            logout_time_str TEXT,
            last_heartbeat BIGINT,
            in_use_since BIGINT,
            tab_id TEXT,
            freed_at BIGINT
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS gsb_alerts (
            id SERIAL PRIMARY KEY,
            tab_id TEXT,
            amount NUMERIC DEFAULT 0,
            timestamp BIGINT,
            created_at TIMESTAMP DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS gsb_bad_password_accounts (
            phone TEXT PRIMARY KEY,
            password TEXT,
            reported_at TEXT,
            status TEXT DEFAULT 'BAD_PASSWORD'
        )
    `);

    for (const table of ['accounts', 'gsb_accounts']) {
        await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS in_use_since BIGINT`);
        await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS tab_id TEXT`);
        await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS freed_at BIGINT`);
    }

    console.log('Location 2 database initialized. Both pools are empty.');
}

function makeStore(table, badTable) {
    async function getAccounts() {
        const { rows } = await pool.query(
            `SELECT * FROM ${table} ORDER BY phone ASC`
        );

        return rows.map(r => ({
            phone: r.phone,
            password: r.password,
            status: r.status,
            logoutTime: r.logout_time == null ? null : Number(r.logout_time),
            logoutTimeStr: r.logout_time_str,
            lastHeartbeat: r.last_heartbeat == null ? null : Number(r.last_heartbeat),
            inUseSince: r.in_use_since == null ? null : Number(r.in_use_since),
            tabId: r.tab_id,
            freedAt: r.freed_at == null ? null : Number(r.freed_at)
        }));
    }

    async function getAccountByTabId(tabId) {
        const { rows } = await pool.query(
            `SELECT * FROM ${table}
             WHERE tab_id=$1 AND status='IN-USE' AND logout_time IS NULL
             LIMIT 1`,
            [tabId]
        );

        if (!rows.length) return null;
        const r = rows[0];

        return {
            phone: r.phone,
            password: r.password,
            status: r.status,
            logoutTime: r.logout_time == null ? null : Number(r.logout_time),
            logoutTimeStr: r.logout_time_str,
            lastHeartbeat: r.last_heartbeat == null ? null : Number(r.last_heartbeat),
            inUseSince: r.in_use_since == null ? null : Number(r.in_use_since),
            tabId: r.tab_id,
            freedAt: r.freed_at == null ? null : Number(r.freed_at)
        };
    }

    async function claimFreeAccount(tabId, now) {
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const { rows } = await client.query(
                `SELECT phone,password FROM ${table}
                 WHERE status='FREE'
                 ORDER BY freed_at ASC NULLS LAST
                 LIMIT 1 FOR UPDATE SKIP LOCKED`
            );

            if (!rows.length) {
                await client.query('ROLLBACK');
                return null;
            }

            const account = rows[0];

            await client.query(
                `UPDATE ${table}
                 SET status='IN-USE', logout_time=NULL, logout_time_str=NULL,
                     last_heartbeat=$2, in_use_since=$2, tab_id=$3, freed_at=NULL
                 WHERE phone=$1`,
                [account.phone, now, tabId]
            );

            await client.query('COMMIT');
            return account;
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    async function reLoginForTab(tabId, now, timeText) {
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            if (tabId) {
                const { rows: old } = await client.query(
                    `SELECT phone FROM ${table}
                     WHERE tab_id=$1 AND status='IN-USE' AND logout_time IS NULL
                     LIMIT 1 FOR UPDATE SKIP LOCKED`,
                    [tabId]
                );

                if (old.length) {
                    await client.query(
                        `UPDATE ${table}
                         SET logout_time=$2, logout_time_str=$3,
                             last_heartbeat=NULL, in_use_since=NULL, tab_id=NULL
                         WHERE phone=$1`,
                        [old[0].phone, now, timeText + ' (re-login)']
                    );
                }
            }

            const { rows } = await client.query(
                `SELECT phone,password FROM ${table}
                 WHERE status='FREE'
                 ORDER BY freed_at ASC NULLS LAST
                 LIMIT 1 FOR UPDATE SKIP LOCKED`
            );

            if (!rows.length) {
                await client.query('ROLLBACK');
                return null;
            }

            const account = rows[0];

            await client.query(
                `UPDATE ${table}
                 SET status='IN-USE', logout_time=NULL, logout_time_str=NULL,
                     last_heartbeat=$2, in_use_since=$2, tab_id=$3, freed_at=NULL
                 WHERE phone=$1`,
                [account.phone, now, tabId]
            );

            await client.query('COMMIT');
            return account;
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    async function updateAccount(phone, fields) {
        const columns = {
            status: 'status',
            logoutTime: 'logout_time',
            logoutTimeStr: 'logout_time_str',
            lastHeartbeat: 'last_heartbeat',
            inUseSince: 'in_use_since',
            tabId: 'tab_id',
            freedAt: 'freed_at'
        };

        const keys = Object.keys(fields);
        if (!keys.length) return;

        const sets = keys.map((key, i) => {
            if (!columns[key]) throw new Error('Invalid account field: ' + key);
            return `${columns[key]}=$${i + 1}`;
        });

        const values = keys.map(key => fields[key]);
        values.push(phone);

        await pool.query(
            `UPDATE ${table} SET ${sets.join(', ')} WHERE phone=$${values.length}`,
            values
        );
    }

    async function addAccount(phone, password) {
        await pool.query(
            `INSERT INTO ${table} (phone,password,status)
             VALUES ($1,$2,'FREE')`,
            [phone, password]
        );
    }

    async function removeAccount(phone) {
        await pool.query(`DELETE FROM ${table} WHERE phone=$1`, [phone]);
    }

    async function resetAllAccounts() {
        await pool.query(
            `UPDATE ${table}
             SET status='FREE', logout_time=NULL, logout_time_str=NULL,
                 last_heartbeat=NULL, in_use_since=NULL, tab_id=NULL, freed_at=NULL`
        );
    }

    async function deleteAllAccounts() {
        await pool.query(`DELETE FROM ${table}`);
    }

    async function getBadPasswordAccounts() {
        const { rows } = await pool.query(`SELECT * FROM ${badTable}`);
        return rows.map(r => ({
            phone: r.phone,
            password: r.password,
            reportedAt: r.reported_at,
            status: r.status
        }));
    }

    async function addBadPasswordAccount(phone, password, reportedAt) {
        await pool.query(
            `INSERT INTO ${badTable} (phone,password,reported_at)
             VALUES ($1,$2,$3) ON CONFLICT (phone) DO NOTHING`,
            [phone, password, reportedAt]
        );
    }

    async function removeBadPasswordAccount(phone) {
        await pool.query(`DELETE FROM ${badTable} WHERE phone=$1`, [phone]);
    }

    return {
        getAccounts,
        getAccountByTabId,
        claimFreeAccount,
        reLoginForTab,
        updateAccount,
        addAccount,
        removeAccount,
        resetAllAccounts,
        deleteAllAccounts,
        getBadPasswordAccounts,
        addBadPasswordAccount,
        removeBadPasswordAccount
    };
}

const mwos = makeStore('accounts', 'bad_password_accounts');
const gsb = makeStore('gsb_accounts', 'gsb_bad_password_accounts');

function getZambiaTime() {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: TIMEZONE,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(new Date());

    const get = type => Number(parts.find(p => p.type === type).value);

    return {
        hour: get('hour'),
        minute: get('minute'),
        second: get('second')
    };
}

module.exports = {
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
};
