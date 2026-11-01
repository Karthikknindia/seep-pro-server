/**
 * SEEP Pro V2 — Cloud Connected API Bridge
 * Directly connected to your live MongoDB Atlas Cluster0!
 */

const http = require("http");
const path = require("path");
let MongoClient;
try {
    MongoClient = require("mongodb").MongoClient;
} catch (e) {
    MongoClient = require(path.resolve(__dirname, "../scripts/node_modules/mongodb")).MongoClient;
}

const PORT = 3000;
const MONGODB_URI = "mongodb+srv://geminikk1997_db_user:l3bsf4VPSPzIqTDp@cluster0.gxqnv0s.mongodb.net/?retryWrites=true&w=majority";
const ADMIN_SECRET_KEY = "BheemPhoto_Secret_2026!";

let db;

// Connect to MongoDB Atlas
async function initMongo() {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db("seep_pro");
    console.log("✅ API Server connected to MongoDB Atlas (Cluster0 - seep_pro)");
}

// Helpers
function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With"
    });
    res.end(JSON.stringify(data));
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (err) {
                resolve({});
            }
        });
        req.on("error", reject);
    });
}

function generateLicenseKey() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const segment = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    return `SEEP-${segment()}-${segment()}-${segment()}-${segment()}`;
}

async function requestHandler(req, res) {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With"
        });
        return res.end();
    }

    const url = req.url.split("?")[0];
    const data = await parseBody(req);

    try {
        // ==========================================
        // 1. PLUGIN ENDPOINTS
        // ==========================================

        // Validate License
        if (url === "/validateLicense" && req.method === "POST") {
            const { license_key, machine_id } = data;
            const config = await db.collection("plugin_config").findOne({ _id: "global_config" });

            if (config && config.maintenance_mode) {
                return sendJson(res, 200, { valid: false, reason: "maintenance", message: "Server is under maintenance." });
            }

            const lic = await db.collection("licenses").findOne({ license_key });
            if (!lic) {
                return sendJson(res, 200, { valid: false, message: "Invalid license key." });
            }

            if (lic.status !== "active") {
                return sendJson(res, 200, { valid: false, message: `License is ${lic.status}.` });
            }

            if (lic.expires_at && new Date(lic.expires_at) < new Date()) {
                await db.collection("licenses").updateOne({ _id: lic._id }, { $set: { status: "expired" } });
                return sendJson(res, 200, { valid: false, message: "License has expired." });
            }

            const isBound = lic.bound_machines && lic.bound_machines.some(m => m.machine_id === machine_id);
            if (!isBound) {
                return sendJson(res, 200, { valid: false, message: "This machine is not bound to this license." });
            }

            // Update last_seen
            await db.collection("licenses").updateOne(
                { license_key, "bound_machines.machine_id": machine_id },
                { $set: { "bound_machines.$.last_seen": new Date() } }
            );

            await db.collection("users").updateOne(
                { machine_id },
                { $set: { last_seen: new Date() }, $inc: { total_sessions: 1 } },
                { upsert: false }
            );

            return sendJson(res, 200, {
                valid: true,
                status: "active",
                plan: lic.plan || "standard",
                config: config || {},
                message: "License validated successfully."
            });
        }

        // Activate License
        if (url === "/activateLicense" && req.method === "POST") {
            const { license_key, machine_id, machine_name, os_info, ps_version, plugin_version } = data;

            const lic = await db.collection("licenses").findOne({ license_key });
            if (!lic) {
                return sendJson(res, 200, { success: false, message: "Invalid license key." });
            }
            if (lic.status !== "active") {
                return sendJson(res, 200, { success: false, message: `License is ${lic.status}.` });
            }
            if (lic.expires_at && new Date(lic.expires_at) < new Date()) {
                return sendJson(res, 200, { success: false, message: "License has expired." });
            }

            const bound = lic.bound_machines || [];
            const isAlreadyBound = bound.some(m => m.machine_id === machine_id);

            if (!isAlreadyBound) {
                const max = lic.max_machines || 2;
                if (bound.length >= max) {
                    return sendJson(res, 200, { success: false, message: `Seat limit reached (${bound.length}/${max} machines). Contact admin for additional seats.` });
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

                await db.collection("licenses").updateOne(
                    { license_key },
                    { $set: { bound_machines: bound } }
                );
            }

            // Upsert User
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

            const config = await db.collection("plugin_config").findOne({ _id: "global_config" });

            return sendJson(res, 200, {
                success: true,
                message: "Activated successfully!",
                plan: lic.plan || "standard",
                config: config || {}
            });
        }

        // Heartbeat
        if (url === "/heartbeat" && req.method === "POST") {
            const { license_key, machine_id } = data;
            if (machine_id) {
                await db.collection("users").updateOne({ machine_id }, { $set: { last_seen: new Date() } });
            }
            return sendJson(res, 200, { ok: true });
        }

        // Get Config
        if (url === "/getPluginConfig" && req.method === "POST") {
            const config = await db.collection("plugin_config").findOne({ _id: "global_config" });
            return sendJson(res, 200, { config: config || {} });
        }

        // Log Usage
        if (url === "/logUsage" && req.method === "POST") {
            const { license_key, machine_id, action, details } = data;
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

            return sendJson(res, 200, { ok: true });
        }

        // ==========================================
        // 2. ADMIN ENDPOINTS
        // ==========================================

        // Check Admin Auth
        if (url.startsWith("/admin/")) {
            if (data.admin_key !== ADMIN_SECRET_KEY) {
                return sendJson(res, 403, { error: "Invalid Admin Secret Key" });
            }
        }

        // Admin Dashboard Stats
        if (url === "/admin/dashboard" && req.method === "POST") {
            const totalUsers = await db.collection("users").countDocuments();
            const activeLic = await db.collection("licenses").countDocuments({ status: "active" });
            const inactiveLic = await db.collection("licenses").countDocuments({ status: { $ne: "active" } });

            const photoAgg = await db.collection("users").aggregate([
                { $group: { _id: null, total: { $sum: "$total_photos_placed" } } }
            ]).toArray();
            const totalPhotos = photoAgg[0]?.total || 0;

            const recentLogs = await db.collection("usage_logs").find().sort({ timestamp: -1 }).limit(10).toArray();

            return sendJson(res, 200, {
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
        }

        // Admin Users List
        if (url === "/admin/users" && req.method === "POST") {
            const users = await db.collection("users").find().sort({ last_seen: -1 }).toArray();
            return sendJson(res, 200, {
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
        }

        // Admin Licenses List
        if (url === "/admin/licenses" && req.method === "POST") {
            const lics = await db.collection("licenses").find().sort({ created_at: -1 }).toArray();
            return sendJson(res, 200, {
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
        }

        // Admin Update License Status
        if (url === "/admin/license/update" && req.method === "POST") {
            const { license_key, status } = data;
            await db.collection("licenses").updateOne({ license_key }, { $set: { status } });
            return sendJson(res, 200, { success: true });
        }

        // Admin Create License
        if (url === "/admin/license/create" && req.method === "POST") {
            const { plan, owner, email, max_machines, expires_at, notes } = data;
            const newKey = generateLicenseKey();

            await db.collection("licenses").insertOne({
                license_key: newKey,
                status: "active",
                plan: plan || "pro",
                owner_name: owner || "Client",
                owner_email: email || "",
                max_machines: parseInt(max_machines, 10) || 2,
                bound_machines: [],
                created_at: new Date(),
                expires_at: expires_at ? new Date(expires_at) : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
                notes: notes || ""
            });

            return sendJson(res, 200, { success: true, license_key: newKey });
        }

        // Admin Usage Logs
        if (url === "/admin/usage" && req.method === "POST") {
            const logs = await db.collection("usage_logs").find().sort({ timestamp: -1 }).limit(100).toArray();
            return sendJson(res, 200, {
                logs: logs.map(l => ({
                    timestamp: l.timestamp,
                    machine_name: l.machine_id,
                    license_key: l.license_key,
                    action: l.action,
                    details: JSON.stringify(l.details || {})
                }))
            });
        }

        // Admin Settings Get
        if (url === "/admin/settings" && req.method === "POST") {
            const config = await db.collection("plugin_config").findOne({ _id: "global_config" });
            return sendJson(res, 200, { config: config || {} });
        }

        // Admin Settings Update
        if (url === "/admin/settings/update" && req.method === "POST") {
            const { config } = data;
            config.updated_at = new Date();
            await db.collection("plugin_config").replaceOne({ _id: "global_config" }, { _id: "global_config", ...config }, { upsert: true });
            return sendJson(res, 200, { success: true });
        }

        // 404
        return sendJson(res, 404, { error: "Endpoint not found" });

    } catch (err) {
        console.error("API Error:", err);
        return sendJson(res, 500, { error: err.message });
    }
}

const server = http.createServer(requestHandler);

// Vercel / Serverless Export
module.exports = async (req, res) => {
    if (!db) await initMongo();
    return requestHandler(req, res);
};

// Direct Node.js Execution
if (require.main === module || !process.env.VERCEL) {
    initMongo().then(() => {
        const port = process.env.PORT || PORT;
        server.listen(port, () => {
            console.log(`\n==================================================`);
            console.log(`🚀 SEEP PRO API SERVER IS LIVE ON PORT ${port}!`);
            console.log(`URL: http://localhost:${port}`);
            console.log(`Admin Secret Key: ${ADMIN_SECRET_KEY}`);
            console.log(`==================================================\n`);
        });
    }).catch(err => {
        console.error("Failed to connect to MongoDB:", err);
    });
}
