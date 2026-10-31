/**
 * ==============================================================================
 * MODULE: FIREBASE CONFIG, SECURITY UTILS & RTDB EDGE CLIENT
 * Hardened for: Serverless Edge Security, Data Source Segregation, Input Sanitization
 * ==============================================================================
 */

(function (window) {
    'use strict';

    // ==============================================================================
    // 1. SECURITY & SANITIZATION UTILITIES (Zero-dependency defensive programming)
    // ==============================================================================
    const SecurityUtils = {
        /**
         * Escape HTML special characters to prevent DOM-based XSS
         */
        escapeHTML(str) {
            if (str === null || str === undefined) return '';
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        },

        /**
         * Allowlist HTML sanitizer for trusted formatting (b, i, em, strong, br, code, span)
         */
        sanitizeHTML(dirty) {
            if (!dirty || typeof dirty !== 'string') return '';
            if (typeof DOMParser !== 'undefined') {
                try {
                    const doc = new DOMParser().parseFromString(dirty, 'text/html');
                    const ALLOWED_TAGS = new Set(['B', 'I', 'EM', 'STRONG', 'BR', 'CODE', 'SPAN', 'P', 'UL', 'LI']);
                    const ALLOWED_ATTRS = new Set(['class']);

                    const cleanNode = (node) => {
                        const children = Array.from(node.childNodes);
                        for (const child of children) {
                            if (child.nodeType === 1) { // Element
                                if (!ALLOWED_TAGS.has(child.tagName)) {
                                    const textNode = doc.createTextNode(child.textContent || '');
                                    node.replaceChild(textNode, child);
                                } else {
                                    Array.from(child.attributes).forEach(attr => {
                                        if (!ALLOWED_ATTRS.has(attr.name.toLowerCase())) {
                                            child.removeAttribute(attr.name);
                                        }
                                    });
                                    cleanNode(child);
                                }
                            } else if (child.nodeType === 8) { // Comment
                                node.removeChild(child);
                            }
                        }
                    };

                    cleanNode(doc.body);
                    return doc.body.innerHTML;
                } catch {
                    return this.escapeHTML(dirty);
                }
            }
            // Fallback when DOMParser is unavailable: strip dangerous tags and script/javascript
            let clean = dirty
                .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                .replace(/on\w+\s*=/gi, '')
                .replace(/javascript:/gi, '');
            return clean;
        },

        /**
         * CSV Formula Injection mitigation (CWE-1236)
         * Prepends apostrophe if text starts with dangerous formula execution triggers
         */
        escapeCSV(field) {
            if (field === null || field === undefined) return '';
            let val = String(field);
            const DANGEROUS_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];
            if (DANGEROUS_PREFIXES.some(prefix => val.startsWith(prefix))) {
                val = `'` + val;
            } else if (DANGEROUS_PREFIXES.some(prefix => val.trim().startsWith(prefix))) {
                val = `'` + val.trim();
            }
            if (val.includes(',') || val.includes('"') || val.includes('\n') || val.includes('\r')) {
                val = `"` + val.replace(/"/g, '""') + `"`;
            }
            return val;
        },

        /**
         * Sensor numeric validation with physical range checks
         */
        validateNumber(val, min, max, defaultVal = null) {
            if (val === null || val === undefined || val === '') return defaultVal;
            const num = Number(val);
            if (!Number.isFinite(num) || Number.isNaN(num)) return defaultVal;
            if (num < min || num > max) return defaultVal;
            return num;
        },

        /**
         * Validate telemetry timestamps (must be between year 2020 and now + 60s)
         */
        validateTimestamp(t, fallback = Date.now()) {
            const num = Number(t);
            const MIN_VALID_TIME = 1577836800000; // 2020-01-01
            const MAX_VALID_TIME = Date.now() + 60000; // Allow 60s clock skew
            if (!Number.isFinite(num) || num < MIN_VALID_TIME || num > MAX_VALID_TIME) {
                return fallback;
            }
            return num;
        },

        /**
         * Validate Firebase RTDB URL to prevent SSRF and protocol manipulation
         */
        isValidFirebaseUrl(url) {
            if (!url || typeof url !== 'string') return false;
            try {
                const u = new URL(url.trim());
                if (u.protocol !== 'https:') return false;
                const host = u.hostname.toLowerCase();
                return host.endsWith('.firebaseio.com') || host.endsWith('.firebasedatabase.app');
            } catch {
                return false;
            }
        },

        /**
         * Validate camera IP/hostname to prevent SSRF and malicious protocol execution
         */
        isValidCameraHost(raw) {
            if (!raw || typeof raw !== 'string') return null;
            const trimmed = raw.trim();
            if (/^(javascript|data|file|ftp):/i.test(trimmed)) return null;
            if (/[<>";|&`$]/.test(trimmed)) return null;
            const host = trimmed.replace(/^https?:\/\//i, '').replace(/[\/?#].*$/, '');
            // Reject cloud metadata link-local address (169.254.x.x)
            if (/^169\.254\./.test(host)) return null;
            const ipv4Regex = /^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(:[0-9]{1,5})?$/;
            const hostnameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*(:[0-9]{1,5})?$/;
            if (ipv4Regex.test(host) || hostnameRegex.test(host)) {
                return host;
            }
            return null;
        }
    };

    window.SecurityUtils = SecurityUtils;

    // ==============================================================================
    // 2. CONFIGURATION STORE & PERSISTENCE
    // ==============================================================================
    const CACHE_KEY = 'selada_telemetry_live_cache_v3';
    const SETTINGS_KEY = 'selada-dash-v3';

    const DEF_SETTINGS = {
        firebase: 'https://selada-a9428-default-rtdb.asia-southeast1.firebasedatabase.app/',
        poll: 2000,
        fetchN: 300,
        unit: 'C',
        clock: '24',
        theme: 'dark',
        forceDemo: false,
        dry: 65, // Standard optimal range for Selada Keriting (65-78%)
        wet: 78,
        camIp: '',
        rules: {
            dry: { on: true },
            wet: { on: true },
            tmax: { on: true, v: 32 },
            tmin: { on: true, v: 15 },
            hmin: { on: true, v: 40 },
            off: { on: true, v: 15 }
        }
    };

    function clone(o) {
        return JSON.parse(JSON.stringify(o));
    }

    class ConfigStore {
        constructor() {
            this.S = clone(DEF_SETTINGS);
            this.load();
        }

        load() {
            this.S = clone(DEF_SETTINGS);
            try {
                const raw = localStorage.getItem(SETTINGS_KEY);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    Object.keys(parsed).forEach(k => {
                        if (k === 'rules' && typeof parsed.rules === 'object') {
                            Object.keys(parsed.rules).forEach(r => {
                                this.S.rules[r] = Object.assign({}, this.S.rules[r], parsed.rules[r]);
                            });
                        } else {
                            this.S[k] = parsed[k];
                        }
                    });
                }
            } catch (e) {
                console.warn('[ConfigStore] Failed to load settings from storage:', e);
            }

            if (!SecurityUtils.isValidFirebaseUrl(this.S.firebase)) {
                this.S.firebase = DEF_SETTINGS.firebase;
            }
            return this.S;
        }

        save() {
            try {
                localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.S));
            } catch (e) {
                console.warn('[ConfigStore] Failed to save settings:', e);
            }
        }

        reset() {
            const preservedIp = this.S.camIp;
            this.S = clone(DEF_SETTINGS);
            this.S.camIp = preservedIp;
            this.save();
            return this.S;
        }

        get() {
            return this.S;
        }
    }

    const configManager = new ConfigStore();
    window.ConfigStore = configManager;

    // Firebase 20-character push ID decoder
    const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

    function decodePushTimestamp(id) {
        if (typeof id !== 'string' || id.length !== 20) return 0;
        let timestamp = 0;
        for (let i = 0; i < 8; i++) {
            const charIndex = PUSH_CHARS.indexOf(id[i]);
            if (charIndex < 0) return 0;
            timestamp = timestamp * 64 + charIndex;
        }
        return timestamp > 1.4e12 ? timestamp : 0;
    }

    function normalizeUrl(url) {
        if (!url) return '';
        let u = url.trim();
        if (!u.endsWith('.json')) {
            u = u.replace(/\/+$/, '') + '/.json';
        }
        return u;
    }

    // ==============================================================================
    // 3. HARDENED FIREBASE EDGE CLIENT WITH STRICT DATA SEPARATION
    // ==============================================================================
    class FirebaseClient {
        constructor() {
            this.listeners = [];
            this.statusListeners = [];
            this.isPolling = false;
            this.isFetching = false; // Mutex to prevent overlapping network polls
            this.pollTimer = null;
            
            // SEPARATE DATA STREAMS: Never pollute live telemetry with synthetic demo data
            this.liveRecords = [];   // Actual verified data from Firebase RTDB
            this.demoRecords = [];   // Pure synthetic records for demo mode only
            this.currentSource = 'offline'; // 'live' | 'cache' | 'simulated'
            this.connectionState = 'disconnected'; // 'connected' | 'demo' | 'offline' | 'connecting'

            this.demoState = { soil: 72, temp: 24.5, hum: 68, boost: 0 };
            this.loadCache();
        }

        loadCache() {
            try {
                const stored = localStorage.getItem(CACHE_KEY);
                if (stored) {
                    const parsed = JSON.parse(stored);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        // Mark cached records with source 'cache'
                        this.liveRecords = parsed.map(r => Object.assign({}, r, { source: 'cache' }));
                        this.currentSource = 'cache';
                    }
                }
            } catch (err) {
                console.warn('[FirebaseClient] Offline cache read failed:', err);
            }
        }

        saveCache() {
            try {
                // ONLY persist genuine live records to offline cache
                const genuineRecords = this.liveRecords.filter(r => r.source === 'live' || r.source === 'cache');
                if (genuineRecords.length > 0) {
                    const sliceToSave = genuineRecords.slice(-600);
                    localStorage.setItem(CACHE_KEY, JSON.stringify(sliceToSave));
                }
            } catch (err) {
                console.warn('[FirebaseClient] Offline cache write failed:', err);
            }
        }

        /**
         * Validates and normalizes raw telemetry records
         */
        normalizeRecord(obj, keyOrTimestamp, source = 'live') {
            if (!obj || typeof obj !== 'object') return null;

            const decodedTime = typeof keyOrTimestamp === 'number'
                ? keyOrTimestamp
                : (decodePushTimestamp(keyOrTimestamp) || Date.now());
            const validatedTime = SecurityUtils.validateTimestamp(decodedTime, Date.now());

            // Sensor physical boundary checks for Selada Keriting (Lactuca sativa L.)
            const suhu = SecurityUtils.validateNumber(obj.suhu, 0, 55, null);
            const udara = SecurityUtils.validateNumber(obj.kelembapan_udara, 5, 100, null);
            const tanah = SecurityUtils.validateNumber(obj.kelembapan_tanah, 0, 100, null);

            // If key telemetry fields are missing/corrupted, reject to prevent chart/stat poisoning
            if (tanah === null || udara === null || suhu === null) {
                return null;
            }

            // Check if hardware provides relay verification feedback
            let relayFeedback = null;
            if (obj.relay !== undefined) relayFeedback = Boolean(obj.relay);
            else if (obj.pompa !== undefined) relayFeedback = Boolean(obj.pompa);
            else if (obj.status_relay !== undefined) relayFeedback = Boolean(obj.status_relay);

            return {
                id: typeof keyOrTimestamp === 'string' ? SecurityUtils.escapeHTML(keyOrTimestamp) : 'rec_' + validatedTime,
                t: validatedTime,
                suhu: Number(suhu.toFixed(1)),
                udara: Math.round(udara),
                tanah: Math.round(tanah),
                statusRaw: SecurityUtils.escapeHTML(obj.status || ''),
                source: source, // 'live' | 'cache' | 'simulated'
                relayActual: relayFeedback // Verified relay feedback or null if unmeasured
            };
        }

        parseDatabaseResponse(json, source = 'live') {
            if (!json || typeof json !== 'object') return [];

            // Single object payload
            if (json.suhu !== undefined && json.kelembapan_tanah !== undefined) {
                const norm = this.normalizeRecord(json, Date.now(), source);
                return norm ? [norm] : [];
            }

            // Nested inside 'kelompok2'
            if (json.kelompok2 && typeof json.kelompok2 === 'object') {
                return this.parseDatabaseResponse(json.kelompok2, source);
            }

            const rows = [];
            const keys = Object.keys(json).sort();
            for (const key of keys) {
                const item = json[key];
                if (item && typeof item === 'object') {
                    const parsed = this.normalizeRecord(item, key, source);
                    if (parsed) {
                        rows.push(parsed);
                    }
                }
            }
            return rows;
        }

        async fetchRows(url, n, signalMs = 6000) {
            const S = configManager.get();
            const target = url || S.firebase;

            if (!SecurityUtils.isValidFirebaseUrl(target)) {
                throw new Error('URL Firebase tidak valid atau domain tidak diizinkan');
            }

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), signalMs);
            const reqUrl = normalizeUrl(target);

            try {
                const query = `?orderBy=${encodeURIComponent('"$key"')}&limitToLast=${encodeURIComponent(n)}`;
                const response = await fetch(reqUrl + query, {
                    signal: controller.signal,
                    cache: 'no-store'
                });

                if (!response.ok) {
                    throw new Error(`Firebase RTDB HTTP ${response.status}`);
                }

                const json = await response.json();
                return this.parseDatabaseResponse(json, 'live');
            } finally {
                clearTimeout(timeoutId);
            }
        }

        async testConnection(url) {
            try {
                if (!SecurityUtils.isValidFirebaseUrl(url)) {
                    return { ok: false, error: 'URL Firebase harus berakhiran .firebaseio.com atau .firebasedatabase.app' };
                }
                const rows = await this.fetchRows(url, 1, 6000);
                return {
                    ok: true,
                    count: rows.length,
                    latest: rows.length ? rows[rows.length - 1] : null
                };
            } catch (err) {
                return {
                    ok: false,
                    error: SecurityUtils.escapeHTML(err.message)
                };
            }
        }

        // ==============================================================================
        // SYNTHETIC DEMO GENERATOR (Strictly isolated in demoRecords buffer)
        // ==============================================================================
        demoStep(t) {
            const S = configManager.get();
            const pump = this.demoState.soil < S.dry;
            if (pump) {
                this.demoState.soil += 1.0 + Math.random() * 0.5;
                this.demoState.boost = 8;
            } else if (this.demoState.boost > 0) {
                this.demoState.soil += 0.4;
                this.demoState.boost--;
            } else {
                this.demoState.soil -= 0.08 + Math.random() * 0.08;
            }
            this.demoState.soil = Math.max(20, Math.min(95, this.demoState.soil));
            this.demoState.temp += (Math.random() - 0.5) * 0.2 + (24.5 - this.demoState.temp) * 0.03;
            this.demoState.hum += (Math.random() - 0.5) * 0.5 + (68 - this.demoState.hum) * 0.03;

            return {
                id: 'sim_' + t,
                t: t,
                suhu: Number(this.demoState.temp.toFixed(1)),
                udara: Math.round(this.demoState.hum),
                tanah: Math.round(this.demoState.soil),
                statusRaw: this.demoState.soil < S.dry ? 'Kering' : (this.demoState.soil > S.wet ? 'Basah' : 'Optimal'),
                source: 'simulated',
                relayActual: pump // Simulated relay state
            };
        }

        demoRows(n) {
            const now = Date.now(), rows = [];
            for (let i = n - 1; i >= 0; i--) {
                rows.push(this.demoStep(now - i * 1000));
            }
            return rows;
        }

        // ==============================================================================
        // POLLING ENGINE WITH RACE-CONDITION MUTEX
        // ==============================================================================
        async pollCycle() {
            if (!this.isPolling) return;
            const S = configManager.get();

            // Prevent polling overlap if previous fetch takes longer than interval
            if (this.isFetching) {
                this.pollTimer = setTimeout(() => this.pollCycle(), S.poll);
                return;
            }

            this.isFetching = true;

            try {
                if (S.forceDemo) {
                    this.currentSource = 'simulated';
                    this.connectionState = 'demo';
                    const simRows = this.demoRows(Math.max(1, Math.round(S.poll / 1000)));
                    this.mergeDemoData(simRows);
                    this.notifyStatus('demo', 'Mode Simulasi (Data Sintetis/Demo)');
                } else {
                    const lastRec = this.getLatestGenuine();
                    const n = this.liveRecords.length ? Math.min(600, Math.max(20, Math.ceil((Date.now() - (lastRec ? lastRec.t : Date.now())) / 1000) + 6)) : S.fetchN;
                    
                    const rows = await this.fetchRows(S.firebase, n);

                    if (rows.length > 0) {
                        this.currentSource = 'live';
                        this.connectionState = 'connected';
                        this.mergeLiveData(rows);
                        this.notifyStatus('connected', 'Telemetri Live (Firebase RTDB)');
                    } else if (this.liveRecords.length === 0) {
                        // Firebase reachable but completely empty
                        this.currentSource = 'simulated';
                        this.connectionState = 'demo';
                        this.mergeDemoData(this.demoRows(60));
                        this.notifyStatus('demo', 'Data Simulasi (Firebase Kosong)');
                    }
                }
            } catch (err) {
                if (this.liveRecords.length > 0) {
                    // Fallback to genuine cached records
                    this.currentSource = 'cache';
                    this.connectionState = 'offline';
                    this.notifyStatus('offline', 'Offline Cache (Jaringan Terputus)');
                    // Trigger UI update using cached records
                    this.notifyData(this.liveRecords, []);
                } else {
                    // No cache at all: present simulation explicitly
                    this.currentSource = 'simulated';
                    this.connectionState = 'demo';
                    this.mergeDemoData(this.demoRows(60));
                    this.notifyStatus('demo', 'Data Simulasi (Firebase Offline)');
                }
            } finally {
                this.isFetching = false;
                if (this.isPolling) {
                    this.pollTimer = setTimeout(() => this.pollCycle(), S.poll);
                }
            }
        }

        mergeLiveData(newRows) {
            if (!Array.isArray(newRows) || newRows.length === 0) return;

            const existingTimes = new Set(this.liveRecords.map(r => r.t));
            let added = [];

            for (const row of newRows) {
                if (!existingTimes.has(row.t)) {
                    this.liveRecords.push(row);
                    existingTimes.add(row.t);
                    added.push(row);
                }
            }

            // Chronological sort
            this.liveRecords.sort((a, b) => a.t - b.t);
            if (this.liveRecords.length > 3600) {
                this.liveRecords = this.liveRecords.slice(-3600);
            }

            if (added.length > 0) {
                this.saveCache();
                this.notifyData(this.liveRecords, added);
            }
        }

        mergeDemoData(newRows) {
            if (!Array.isArray(newRows) || newRows.length === 0) return;

            const existingTimes = new Set(this.demoRecords.map(r => r.t));
            let added = [];

            for (const row of newRows) {
                if (!existingTimes.has(row.t)) {
                    this.demoRecords.push(row);
                    existingTimes.add(row.t);
                    added.push(row);
                }
            }

            this.demoRecords.sort((a, b) => a.t - b.t);
            if (this.demoRecords.length > 600) {
                this.demoRecords = this.demoRecords.slice(-600);
            }

            if (added.length > 0) {
                // NEVER save demoRecords to localStorage
                this.notifyData(this.demoRecords, added);
            }
        }

        start() {
            if (this.isPolling) return;
            this.isPolling = true;
            this.notifyStatus('connecting', 'Menghubungkan…');
            this.pollCycle();
        }

        stop() {
            this.isPolling = false;
            this.isFetching = false;
            if (this.pollTimer) {
                clearTimeout(this.pollTimer);
                this.pollTimer = null;
            }
        }

        restart() {
            this.stop();
            this.liveRecords = [];
            this.demoRecords = [];
            this.start();
        }

        subscribe(callback) {
            if (typeof callback === 'function') {
                this.listeners.push(callback);
                const currentData = this.currentSource === 'simulated' ? this.demoRecords : this.liveRecords;
                if (currentData.length > 0) {
                    callback(currentData, [currentData[currentData.length - 1]], this.currentSource);
                }
            }
            return () => {
                this.listeners = this.listeners.filter(cb => cb !== callback);
            };
        }

        subscribeStatus(callback) {
            if (typeof callback === 'function') {
                this.statusListeners.push(callback);
                callback(this.connectionState, '', this.currentSource);
            }
            return () => {
                this.statusListeners = this.statusListeners.filter(cb => cb !== callback);
            };
        }

        notifyData(allData, addedRows) {
            for (const listener of this.listeners) {
                try {
                    listener(allData, addedRows, this.currentSource);
                } catch (e) {
                    console.error('[FirebaseClient] Listener error:', e);
                }
            }
        }

        notifyStatus(state, message) {
            for (const listener of this.statusListeners) {
                try {
                    listener(state, message, this.currentSource);
                } catch (e) {
                    console.error('[FirebaseClient] Status listener error:', e);
                }
            }
        }

        getLatestGenuine() {
            return this.liveRecords.length > 0 ? this.liveRecords[this.liveRecords.length - 1] : null;
        }

        getLatest() {
            const data = this.currentSource === 'simulated' ? this.demoRecords : this.liveRecords;
            return data.length > 0 ? data[data.length - 1] : null;
        }

        getAll() {
            const data = this.currentSource === 'simulated' ? this.demoRecords : this.liveRecords;
            return data.slice();
        }

        getSource() {
            return this.currentSource;
        }
    }

    window.FirebaseEdgeClient = new FirebaseClient();

})(window);
