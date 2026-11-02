const express = require("express");
const cors = require("cors");
const path = require("path");
const { MongoClient } = require("mongodb");
const { randomInt } = require('node:crypto');
const { handleProcessing, licenseFailure, publicConfig } = require('../processing');

const app = express();
app.use('/admin-panel', express.static(path.join(__dirname, '../../admin-panel')));

// Middleware
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY;

let cachedClient = null;
let cachedDb = null;

async function getDatabase() {
    if (!MONGODB_URI) throw new Error('Database is not configured.');
    if (cachedDb) return cachedDb;

    const client = new MongoClient(MONGODB_URI, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000
    });
    await client.connect();
    cachedClient = client;
    cachedDb = client.db("seep_pro");
    return cachedDb;
}

function generateLicenseKey() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const segment = () => Array.from({ length: 4 }, () => chars[randomInt(chars.length)]).join("");
    return `SEEP-${segment()}-${segment()}-${segment()}-${segment()}`;
}

// ==========================================
// 1. HEALTH CHECK & TEST ROUTES
// ==========================================
app.get("/", (req, res) => {
    res.json({
        status: "online",
        service: "SEEP Pro Cloud API",
        database: "MongoDB Atlas (Cluster0)",
        version: "2.0.0",
        message: "Cloud server is live and accepting license requests 24/7!"
    });
});

app.get("/api", (req, res) => {
    res.json({
        status: "online",
        service: "SEEP Pro Cloud API",
        database: "MongoDB Atlas (Cluster0)",
        version: "2.0.0",
        message: "Cloud server is live and accepting license requests 24/7!"
    });
});

app.get("/test-db", checkAdminAuth, async (req, res) => {
    try {
        const db = await getDatabase();
        const licCount = await db.collection("licenses").countDocuments();
        res.json({ status: "connected", licenses_count: licCount });
    } catch (err) {
        res.status(503).json({ status: "error", error: 'Database service unavailable.' });
    }
});

// ==========================================
// 2. PLUGIN ENDPOINTS
// ==========================================

// Validate License
// Reject query objects and malformed identifiers before any MongoDB query.
app.use((req, res, next) => {
    // Match Express's default case-insensitive and trailing-slash route behavior.
    const endpoint = req.path.replace(/^\/api\//i, '/').replace(/\/+$/, '').toLowerCase();
    if (!['/validatelicense', '/activatelicense', '/heartbeat', '/getpluginconfig', '/logusage'].includes(endpoint)) return next();
    res.set('Cache-Control', 'no-store');
    const { license_key, machine_id } = req.body || {};
    const validString = (s, max) => typeof s === 'string' && s.trim().length > 0 && s.length <= max;
    if (!validString(license_key, 100) || (endpoint !== '/getpluginconfig' && !validString(machine_id, 200))) {
        return res.status(400).json({ valid: false, success: false, ok: false, message: 'Valid license and device identifiers required.' });
    }
    next();
});

app.post(["/validateLicense", "/api/validateLicense"], async (req, res) => {
    try {
        const db = await getDatabase();
        const { license_key, machine_id } = req.body || {};

        const config = await db.collection("plugin_config").findOne({ _id: "global_config" });
        if (config && config.maintenance_mode) {
            return res.json({ valid: false, reason: "maintenance", message: "Server is under maintenance." });
        }

        const lic = await db.collection("licenses").findOne({ license_key });
        if (!lic) {
            return res.json({ valid: false, message: "Invalid license key." });
        }

        if (lic.status !== "active") {
            return res.json({ valid: false, message: `License is ${lic.status}.` });
        }

        if (lic.expires_at && (!Number.isFinite(new Date(lic.expires_at).getTime()) || new Date(lic.expires_at) <= new Date())) {
            await db.collection("licenses").updateOne({ _id: lic._id }, { $set: { status: "expired" } });
            return res.json({ valid: false, message: "License has expired." });
        }

        const isBound = Array.isArray(lic.bound_machines) && lic.bound_machines.some(m => m && m.machine_id === machine_id);
        if (!isBound) {
            return res.json({ valid: false, message: "This machine is not bound to this license." });
        }

        await db.collection("licenses").updateOne(
            { license_key, "bound_machines.machine_id": machine_id },
            { $set: { "bound_machines.$.last_seen": new Date() } }
        );

        await db.collection("users").updateOne(
            { machine_id },
            { $set: { last_seen: new Date() }, $inc: { total_sessions: 1 } },
            { upsert: false }
        );

        return res.json({
            valid: true,
            status: "active",
            plan: lic.plan || "standard",
            config: publicConfig(config || {}),
            message: "License validated successfully."
        });
    } catch (err) {
        return res.status(503).json({ valid: false, message: 'License service unavailable.' });
    }
});

// Activate License
app.post(["/activateLicense", "/api/activateLicense"], async (req, res) => {
    try {
        const db = await getDatabase();
        const { license_key, machine_id, machine_name, os_info, ps_version, plugin_version } = req.body || {};
        if ([machine_name, os_info, ps_version, plugin_version].some(v => v != null && (typeof v !== 'string' || v.length > 200))) return res.status(400).json({ success: false, message: 'Invalid device metadata.' });
        const config = await db.collection('plugin_config').findOne({ _id: 'global_config' });
        if (config && config.maintenance_mode) return res.json({ success: false, message: 'Server is under maintenance.' });

        const lic = await db.collection("licenses").findOne({ license_key });
        if (!lic) {
            return res.json({ success: false, message: "Invalid license key." });
        }
        if (lic.status !== "active") {
            return res.json({ success: false, message: `License is ${lic.status}.` });
        }
        if (lic.expires_at && (!Number.isFinite(new Date(lic.expires_at).getTime()) || new Date(lic.expires_at) <= new Date())) {
            return res.json({ success: false, message: "License has expired." });
        }

        const bound = Array.isArray(lic.bound_machines) ? [...lic.bound_machines] : [];
        const isAlreadyBound = bound.some(m => m.machine_id === machine_id);

        if (!isAlreadyBound) {
            const max = lic.max_machines || 2;
            if (bound.length >= max) {
                return res.json({ success: false, message: `Seat limit reached (${bound.length}/${max} machines). Contact admin for additional seats.` });
            }

            bound.push({
                machine_id,
                machine_name: machine_name || "Unknown",
                os: os_info || "Unknown",
                ps_version: ps_version || "Unknown",
                plugin_version: plugin_version || "2.0.0",
                activated_at: new Date(),
                last_seen: new Date()
            });

            // Compare-and-swap prevents concurrent activations from overwriting seats.
            const claimed = await db.collection("licenses").updateOne(
                { license_key, status: 'active', expires_at: lic.expires_at === undefined ? { $exists: false } : lic.expires_at,
                    bound_machines: lic.bound_machines === undefined ? { $exists: false } : lic.bound_machines },
                { $set: { bound_machines: bound } }
            );
            if (!claimed.matchedCount) return res.json({ success: false, message: 'License changed during activation. Please retry.' });
        }

        await db.collection("users").updateOne(
            { machine_id },
            {
                $set: {
                    machine_name: machine_name || "Unknown",
                    os_info: os_info || "Unknown",
                    ps_version: ps_version || "Unknown",
                    plugin_version: plugin_version || "2.0.0",
                    license_key,
                    last_seen: new Date()
                },
                $setOnInsert: {
                    first_seen: new Date(),
                    total_sessions: 1,
                    total_batches_run: 0,
                    total_photos_placed: 0
                }
            },
            { upsert: true }
        );

        return res.json({
            success: true,
            message: "Activated successfully!",
            plan: lic.plan || "standard",
            config: publicConfig(config || {})
        });
    } catch (err) {
        return res.status(503).json({ success: false, message: 'Activation service unavailable.' });
    }
});

// Heartbeat
app.post(["/heartbeat", "/api/heartbeat"], async (req, res) => {
    try {
        const db = await getDatabase();
        const { license_key, machine_id } = req.body || {};
        const license = await db.collection('licenses').findOne({ license_key });
        const failure = licenseFailure(license, machine_id);
        if (failure) return res.json({ ok: false, message: failure });
        const config = await db.collection('plugin_config').findOne({ _id: 'global_config' });
        if (config && config.maintenance_mode) return res.json({ ok: false, message: 'Server is under maintenance.' });
        if (machine_id) {
            await db.collection("users").updateOne({ machine_id, license_key }, { $set: { last_seen: new Date() } });
        }
        return res.json({ ok: true });
    } catch (err) {
        return res.status(503).json({ ok: false, message: 'Heartbeat service unavailable.' });
    }
});

// Get Config
app.post(["/getPluginConfig", "/api/getPluginConfig"], async (req, res) => {
    try {
        const db = await getDatabase();
        const license = await db.collection('licenses').findOne({ license_key: req.body.license_key });
        if (licenseFailure(license)) return res.status(403).json({ message: 'Active license required.' });
        const config = await db.collection("plugin_config").findOne({ _id: "global_config" });
        return res.json({ config: publicConfig(config || {}) });
    } catch (err) {
        return res.status(503).json({ error: 'Configuration service unavailable.' });
    }
});

// Log Usage
app.post(["/logUsage", "/api/logUsage"], async (req, res) => {
    try {
        const db = await getDatabase();
        const { license_key, machine_id, action, details } = req.body || {};
        if (licenseFailure(await db.collection('licenses').findOne({ license_key }), machine_id)) return res.status(403).json({ ok: false, message: 'Active bound license required.' });
        if (!['plugin_open', 'license_activated', 'dry_run', 'batch_run'].includes(action) ||
            (details != null && (typeof details !== 'object' || Array.isArray(details)))) return res.status(400).json({ ok: false, message: 'Invalid usage event.' });
        await db.collection("usage_logs").insertOne({
            license_key,
            machine_id,
            action,
            details: details || {},
            timestamp: new Date()
        });

        if (action === "batch_run" && machine_id) {
            const photos = (details && details.photos_placed) ? details.photos_placed : 0;
            await db.collection("users").updateOne(
                { machine_id },
                { $inc: { total_batches_run: 1, total_photos_placed: photos } }
            );
        }

        return res.json({ ok: true });
    } catch (err) {
        return res.status(503).json({ ok: false, message: 'Usage service unavailable.' });
    }
});

// ==========================================
// 3. ADMIN PANEL ENDPOINTS
// ==========================================

function checkAdminAuth(req, res, next) {
    const adminKey = req.body?.admin_key || req.headers["authorization"]?.replace("Bearer ", "");
    if (!ADMIN_SECRET_KEY || typeof adminKey !== 'string' || adminKey !== ADMIN_SECRET_KEY) {
        return res.status(403).json({ error: "Invalid Admin Secret Key" });
    }
    next();
};

app.post(["/admin/dashboard", "/api/admin/dashboard"], checkAdminAuth, async (req, res) => {
    try {
        const db = await getDatabase();
        const totalUsers = await db.collection("users").countDocuments();
        const activeLic = await db.collection("licenses").countDocuments({ status: "active" });
        const inactiveLic = await db.collection("licenses").countDocuments({ status: { $ne: "active" } });
        const photoAgg = await db.collection("users").aggregate([
            { $group: { _id: null, total: { $sum: "$total_photos_placed" } } }
        ]).toArray();
        const totalPhotos = photoAgg[0]?.total || 0;
        const recentLogs = await db.collection("usage_logs").find().sort({ timestamp: -1 }).limit(10).toArray();

        return res.json({
            stats: {
                total_users: totalUsers,
                active_licenses: activeLic,
                inactive_licenses: inactiveLic,
                total_photos: totalPhotos
            },
            recent_activity: recentLogs.map(l => ({
                action: l.action,
                machine: l.machine_id,
                details: JSON.stringify(l.details || {}),
                time: l.timestamp
            }))
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.post(["/admin/users", "/api/admin/users"], checkAdminAuth, async (req, res) => {
    try {
        const db = await getDatabase();
        const users = await db.collection("users").find().sort({ last_seen: -1 }).toArray();
        return res.json({
            users: users.map(u => ({
                machine_name: u.machine_name || u.machine_id,
                os: u.os_info,
                ps_version: u.ps_version,
                plugin_version: u.plugin_version,
                license_key: u.license_key,
                last_seen: u.last_seen,
                total_sessions: u.total_sessions || 0,
                total_batches: u.total_batches_run || 0,
                total_photos: u.total_photos_placed || 0
            }))
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.post(["/admin/licenses", "/api/admin/licenses"], checkAdminAuth, async (req, res) => {
    try {
        const db = await getDatabase();
        const lics = await db.collection("licenses").find().sort({ created_at: -1 }).toArray();
        return res.json({
            licenses: lics.map(l => ({
                license_key: l.license_key,
                status: l.status,
                plan: l.plan,
                owner: l.owner_name,
                email: l.owner_email,
                machines_used: l.bound_machines?.length || 0,
                max_machines: l.max_machines || 2,
                created_at: l.created_at,
                expires_at: l.expires_at
            }))
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.post(["/admin/license/update", "/api/admin/license/update"], checkAdminAuth, async (req, res) => {
    try {
        const { license_key, status } = req.body || {};
        if (typeof license_key !== 'string' || !['active', 'inactive', 'revoked'].includes(status)) {
            return res.status(400).json({ error: 'A license key and valid status are required.' });
        }
        const db = await getDatabase();
        const result = await db.collection("licenses").updateOne({ license_key }, { $set: { status } });
        if (!result.matchedCount) return res.status(404).json({ error: 'License not found.' });
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.post(["/admin/license/reset-seats", "/api/admin/license/reset-seats"], checkAdminAuth, async (req, res) => {
    try {
        const { license_key } = req.body || {};
        if (typeof license_key !== 'string' || !license_key.trim()) return res.status(400).json({ error: 'A license key is required.' });
        const db = await getDatabase();
        const result = await db.collection("licenses").updateOne({ license_key }, { $set: { bound_machines: [] } });
        if (!result.matchedCount) return res.status(404).json({ error: 'License not found.' });
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.post(["/admin/license/delete", "/api/admin/license/delete"], checkAdminAuth, async (req, res) => {
    try {
        const db = await getDatabase();
        const { license_key } = req.body || {};
        await db.collection("licenses").deleteOne({ license_key });
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.post(["/admin/license/create", "/api/admin/license/create"], checkAdminAuth, async (req, res) => {
    try {
        const { plan, owner, email, max_machines, expires_at, notes } = req.body || {};
        if (!['pro', 'standard', 'trial'].includes(plan) || typeof owner !== 'string' || !owner.trim() ||
            typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
            !Number.isInteger(max_machines) || max_machines < 1 || max_machines > 10 ||
            typeof expires_at !== 'string' || !Number.isFinite(Date.parse(expires_at)) || Date.parse(expires_at) <= Date.now() ||
            (notes != null && typeof notes !== 'string')) {
            return res.status(400).json({ error: 'Enter a valid plan, client name, email, future expiry, and 1 to 10 seats.' });
        }
        const db = await getDatabase();
        const newKey = generateLicenseKey();

        await db.collection("licenses").insertOne({
            license_key: newKey,
            status: "active",
            plan: plan || "pro",
            owner_name: owner.trim(),
            owner_email: email.trim(),
            max_machines: parseInt(max_machines, 10) || 2,
            bound_machines: [],
            created_at: new Date(),
            expires_at: expires_at ? new Date(expires_at) : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
            notes: notes || ""
        });

        return res.json({ success: true, license_key: newKey });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.post(["/admin/usage", "/api/admin/usage"], checkAdminAuth, async (req, res) => {
    try {
        const db = await getDatabase();
        const { action, machine, date_from, date_to } = req.body || {};
        const page = Math.max(1, parseInt(req.body?.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.body?.limit, 10) || 50));
        const query = {};
        if (typeof action === 'string' && action) query.action = action;
        if (typeof machine === 'string' && machine) {
            const pattern = machine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const users = await db.collection('users').find({ machine_name: { $regex: pattern, $options: 'i' } }).toArray();
            query.$or = [{ machine_id: { $regex: pattern, $options: 'i' } }, { machine_id: { $in: users.map(u => u.machine_id) } }];
        }
        if (date_from || date_to) {
            query.timestamp = {};
            for (const [value, operator] of [[date_from, '$gte'], [date_to, '$lte']]) {
                if (!value) continue;
                const date = new Date(value);
                if (!Number.isFinite(date.getTime())) return res.status(400).json({ error: 'Invalid date filter.' });
                query.timestamp[operator] = date;
            }
        }
        const total = await db.collection('usage_logs').countDocuments(query);
        const logs = await db.collection("usage_logs").find(query).sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit).toArray();
        const machines = await db.collection('users').find({ machine_id: { $in: logs.map(l => l.machine_id) } }).toArray();
        const names = new Map(machines.map(u => [u.machine_id, u.machine_name]));
        return res.json({
            total, page, limit,
            logs: logs.map(l => ({
                timestamp: l.timestamp,
                machine_name: names.get(l.machine_id) || l.machine_id,
                license_key: l.license_key,
                action: l.action,
                details: JSON.stringify(l.details || {})
            }))
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.post(["/admin/settings", "/api/admin/settings"], checkAdminAuth, async (req, res) => {
    try {
        const db = await getDatabase();
        const config = await db.collection("plugin_config").findOne({ _id: "global_config" });
        return res.json({ config: config || {} });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.post(["/admin/settings/update", "/api/admin/settings/update"], checkAdminAuth, async (req, res) => {
    try {
        const { config } = req.body || {};
        if (!config || typeof config !== 'object' || Array.isArray(config) ||
            !['maintenance_mode', 'dynamic_routing', 'candid_mode'].every(k => typeof config[k] === 'boolean') ||
            typeof config.announcement !== 'string' || typeof config.min_plugin_version !== 'string' ||
            !/^\d+\.\d+\.\d+$/.test(config.min_plugin_version) ||
            !Number.isInteger(config.jpeg_quality) || config.jpeg_quality < 1 || config.jpeg_quality > 12 ||
            !Number.isInteger(config.max_batch_size) || config.max_batch_size < 50 || config.max_batch_size > 2000) {
            return res.status(400).json({ error: 'Enter a valid version, JPEG quality (1–12), and batch size (50–2000).' });
        }
        const db = await getDatabase();
        delete config._id;
        config.updated_at = new Date();
        await db.collection("plugin_config").replaceOne({ _id: "global_config" }, { _id: "global_config", ...config }, { upsert: true });
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Fallback 404
// Decisions run here; the client receives results, never executable source.
app.post(['/processing', '/api/processing'], (req, res) => handleProcessing(req, res, getDatabase));

app.use((req, res) => {
    res.status(404).json({ error: "Endpoint not found", path: req.path });
});

// Do not echo parser bodies or database/transport errors into public responses.
app.use((error, req, res, next) => {
    const status = error.status === 413 ? 413 : error.status === 400 ? 400 : 503;
    res.status(status).json({ ok: false, valid: false, success: false, message: 'Request could not be completed.' });
});

module.exports = app;
