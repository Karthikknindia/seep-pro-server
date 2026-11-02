// Private processing rules. Never copy this module into a plugin package.
'use strict';

function invalid(message) { const error = new Error(message); error.status = 400; throw error; }
function list(value) {
    if (!Array.isArray(value) || value.length > 5000) invalid('Expected an array of at most 5000 entries.');
    return value;
}
function bounds(value) {
    if (!value || !['left', 'right', 'top', 'bottom'].every(k => Number.isFinite(value[k]))) invalid('Invalid bounds.');
    if (value.right <= value.left || value.bottom <= value.top) invalid('Bounds must have positive dimensions.');
    return value;
}
function classify(layer, trad, candid) {
    if (!layer || typeof layer !== 'object') invalid('Invalid layer.');
    if (layer.kind === 'group') return null;
    if (typeof layer.name !== 'string' || layer.name.length > 1024) invalid('Invalid layer name.');
    const name = layer.name.trim(), upper = name.toUpperCase();
    if (candid.enabled && (candid.usePrefix ? upper.startsWith(candid.prefix) : /^C\d+$/i.test(upper))) return 'candid';
    if (trad.usePrefix ? upper.startsWith(trad.prefix) : /^\d{3,5}$/.test(name)) return 'trad';
    return null;
}
function signature(slots) {
    const p = slots.filter(s => s.bounds.bottom - s.bounds.top > s.bounds.right - s.bounds.left).length;
    const l = slots.length - p;
    return { p, l, text: [p ? `${p}P` : '', l ? `${l}L` : ''].filter(Boolean).join('_') || '0P_0L' };
}
function processDecision(operation, data, config = {}) {
    if (!data || typeof data !== 'object') invalid('Missing processing input.');
    const features = config.features || {};
    if (operation === 'authorize') {
        if (!Number.isSafeInteger(data.total) || data.total < 0) invalid('Invalid photo count.');
        if (features.max_batch_size && data.total > features.max_batch_size) invalid(`Batch size limit: ${features.max_batch_size} photos.`);
        if (data.dynamic && features.dynamic_routing === false) invalid('Dynamic routing is unavailable.');
        if (data.candid && features.candid_mode === false) invalid('Candid mode is unavailable.');
        return { jpegQuality: Number.isInteger(config.jpeg_quality) ? Math.max(0, Math.min(12, config.jpeg_quality)) : 10 };
    }
    if (operation === 'layers') {
        const trad = data.tradConfig || {}, candid = data.candidConfig || {};
        for (const c of [trad, candid]) if (c.usePrefix && (typeof c.prefix !== 'string' || !c.prefix || c.prefix.length > 128)) invalid('Invalid layer prefix.');
        if (candid.enabled && features.candid_mode === false) invalid('Candid mode is unavailable.');
        const layers = list(data.layers), kinds = layers.map(l => classify(l, trad, candid));
        const tradSlots = layers.filter((l, i) => kinds[i] === 'trad');
        const candidSlots = layers.filter((l, i) => kinds[i] === 'candid');
        [...tradSlots, ...candidSlots].forEach(l => bounds(l.bounds));
        const t = signature(tradSlots), c = signature(candidSlots);
        return { kinds, tradP: t.p, tradL: t.l, tradSignature: t.text, candidSignature: c.text };
    }
    if (operation === 'select') {
        if (features.dynamic_routing === false) invalid('Dynamic routing is unavailable.');
        const profiles = list(data.profiles), queue = list(data.queue);
        if (!profiles.length) invalid('No template profiles.');
        if (queue.some(o => o !== 'P' && o !== 'L')) invalid('Invalid orientation.');
        const ahead = queue.slice(0, 6), p = ahead.filter(o => o === 'P').length, l = ahead.length - p;
        let index = 0, best = -Infinity;
        profiles.forEach((profile, i) => {
            if (!profile || ![profile.tradP, profile.tradL].every(n => Number.isSafeInteger(n) && n >= 0)) invalid('Invalid template profile.');
            const score = (Math.min(profile.tradP, p) + Math.min(profile.tradL, l)) * 3 - Math.abs(profile.tradP - p) - Math.abs(profile.tradL - l);
            if (score > best) { best = score; index = i; }
        });
        return { index };
    }
    if (operation === 'slots') {
        const slots = list(data.slots);
        if (!['Traditional', 'Candid'].includes(data.category)) invalid('Invalid category.');
        if (data.category === 'Candid' && features.candid_mode === false) invalid('Candid mode is unavailable.');
        if (!Number.isSafeInteger(data.count) || data.count < 0) invalid('Invalid photo count.');
        slots.forEach(s => { if (!s || typeof s.name !== 'string') invalid('Invalid slot name.'); bounds(s.bounds); });
        return { indices: slots.map((_, i) => i).sort((a, b) => slots[a].name.localeCompare(slots[b].name, undefined, { numeric: true, sensitivity: 'base' })).slice(0, data.count), scaleMode: data.category === 'Candid' ? 'fill' : 'fit' };
    }
    if (operation === 'transform') {
        const original = bounds(data.original), current = bounds(data.current);
        if (!['fit', 'fill'].includes(data.mode)) invalid('Invalid scaling mode.');
        if (data.mode === 'fill' && features.candid_mode === false) invalid('Candid mode is unavailable.');
        const x = (original.right - original.left) / (current.right - current.left);
        const y = (original.bottom - original.top) / (current.bottom - current.top);
        const scalePercent = (data.mode === 'fill' ? Math.max(x, y) : Math.min(x, y)) * 100;
        return { scalePercent, deltaX: (original.left + original.right - current.left - current.right) / 2, deltaY: (original.top + original.bottom - current.top - current.bottom) / 2 };
    }
    invalid('Unknown processing operation.');
}

async function handleProcessing(req, res, getDatabase) {
    res.set('Cache-Control', 'no-store');
    try {
        const { license_key, machine_id, operation, data } = req.body || {};
        if (typeof license_key !== 'string' || license_key.length > 100 || typeof machine_id !== 'string' || !machine_id || machine_id.length > 200) return res.status(401).json({ error: 'License and device credentials required.' });
        const db = await getDatabase();
        const lic = await db.collection('licenses').findOne({ license_key });
        if (!lic || lic.status !== 'active' || (lic.expires_at && (!Number.isFinite(new Date(lic.expires_at).getTime()) || new Date(lic.expires_at) <= new Date())) || !Array.isArray(lic.bound_machines) || !lic.bound_machines.some(m => m.machine_id === machine_id)) return res.status(403).json({ error: 'An active license bound to this device is required.' });
        const config = await db.collection('plugin_config').findOne({ _id: 'global_config' }) || {};
        if (config.maintenance_mode) return res.status(503).json({ error: 'Processing is under maintenance.' });
        return res.json({ ok: true, result: processDecision(operation, data, config) });
    } catch (error) {
        return res.status(error.status || 503).json({ error: error.status === 400 ? error.message : 'Cloud processing unavailable. Try again later.' });
    }
}
module.exports = { processDecision, handleProcessing };
