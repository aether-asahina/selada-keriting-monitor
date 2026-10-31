/**
 * ==============================================================================
 * MODULE: FIREBASE CONFIG & RTDB EDGE CLIENT (serverless-ai-edge compliant)
 * Endpoint: https://selada-a9428-default-rtdb.asia-southeast1.firebasedatabase.app/
 * ==============================================================================
 */

(function (window) {
    'use strict';

    const CACHE_KEY = 'selada_telemetry_cache_v2';
    const SETTINGS_KEY = 'selada-dash-v3';

    const DEF_SETTINGS = {
        firebase: 'https://selada-a9428-default-rtdb.asia-southeast1.firebasedatabase.app/',
        poll: 2000,
        fetchN: 300,
        unit: 'C',
        clock: '24',
        theme: 'dark',
        forceDemo: false,
        dry: 65, // Selada Keriting normal 65-78%
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

            if (!this.S.firebase || this.S.firebase.includes('smart-farming-selada')) {
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

    // Firebase 20-char push ID alphabet for timestamp decoding
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

    class FirebaseClient {
        constructor() {
            this.listeners = [];
            this.statusListeners = [];
            this.isPolling = false;
            this.pollTimer = null;
            this.cachedData = [];
            this.connectionState = 'disconnected';
            this.demoState = { soil: 72, temp: 24.5, hum: 68, boost: 0 };
            this.loadCache();
        }

        loadCache() {
            try {
                const stored = localStorage.getItem(CACHE_KEY);
                if (stored) {
                    const parsed = JSON.parse(stored);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        this.cachedData = parsed;
                    }
                }
            } catch (err) {
                console.warn('[FirebaseClient] Offline cache read failed:', err);
            }
        }

        saveCache() {
            try {
                if (this.cachedData.length > 0) {
                    const sliceToSave = this.cachedData.slice(-600);
                    localStorage.setItem(CACHE_KEY, JSON.stringify(sliceToSave));
                }
            } catch (err) {
                console.warn('[FirebaseClient] Offline cache write failed:', err);
            }
        }

        normalizeRecord(obj, keyOrTimestamp) {
            const time = typeof keyOrTimestamp === 'number' 
                ? keyOrTimestamp 
                : (decodePushTimestamp(keyOrTimestamp) || Date.now());

            return {
                id: typeof keyOrTimestamp === 'string' ? keyOrTimestamp : 'rec_' + time,
                t: time,
                suhu: Number(obj.suhu !== undefined ? obj.suhu : 24.5),
                udara: Number(obj.kelembapan_udara !== undefined ? obj.kelembapan_udara : 68),
                tanah: Number(obj.kelembapan_tanah !== undefined ? obj.kelembapan_tanah : 72),
                statusRaw: obj.status || ''
            };
        }

        parseDatabaseResponse(json) {
            if (!json || typeof json !== 'object') return [];
            
            if (json.suhu !== undefined && json.kelembapan_tanah !== undefined) {
                return [this.normalizeRecord(json, Date.now())];
            }

            if (json.kelompok2 && typeof json.kelompok2 === 'object') {
                return this.parseDatabaseResponse(json.kelompok2);
            }

            const rows = [];
            const keys = Object.keys(json).sort();
            for (const key of keys) {
                const item = json[key];
                if (item && typeof item === 'object' && item.kelembapan_tanah !== undefined) {
                    const parsed = this.normalizeRecord(item, key);
                    if (Number.isFinite(parsed.tanah) && parsed.tanah >= 0) {
                        rows.push(parsed);
                    }
                }
            }
            return rows;
        }

        async fetchRows(url, n, signalMs = 6000) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), signalMs);
            const targetUrl = normalizeUrl(url || configManager.get().firebase);

            try {
                const query = `?orderBy=${encodeURIComponent('"$key"')}&limitToLast=${encodeURIComponent(n)}`;
                const response = await fetch(targetUrl + query, {
                    signal: controller.signal,
                    cache: 'no-store'
                });

                if (!response.ok) {
                    throw new Error(`Firebase RTDB HTTP ${response.status}`);
                }

                const json = await response.json();
                return this.parseDatabaseResponse(json);
            } finally {
                clearTimeout(timeoutId);
            }
        }

        async testConnection(url) {
            try {
                const rows = await this.fetchRows(url, 1, 6000);
                return {
                    ok: true,
                    count: rows.length,
                    latest: rows.length ? rows[rows.length - 1] : null
                };
            } catch (err) {
                return {
                    ok: false,
                    error: err.message
                };
            }
        }

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
                id: 'demo_' + t,
                t: t,
                suhu: Number(this.demoState.temp.toFixed(1)),
                udara: Math.round(this.demoState.hum),
                tanah: Math.round(this.demoState.soil),
                statusRaw: this.demoState.soil < S.dry ? 'Kering' : (this.demoState.soil > S.wet ? 'Basah' : 'Optimal')
            };
        }

        demoRows(n) {
            const now = Date.now(), rows = [];
            for (let i = n - 1; i >= 0; i--) {
                rows.push(this.demoStep(now - i * 1000));
            }
            return rows;
        }

        async pollCycle() {
            if (!this.isPolling) return;
            const S = configManager.get();

            if (S.forceDemo) {
                const rows = this.demoRows(Math.max(1, Math.round(S.poll / 1000)));
                this.mergeData(rows);
                this.connectionState = 'demo';
                this.notifyStatus('demo', 'Mode Data Contoh Aktif');
            } else {
                try {
                    const n = this.cachedData.length ? Math.min(600, Math.max(20, Math.ceil((Date.now() - this.getLatest().t) / 1000) + 6)) : S.fetchN;
                    const rows = await this.fetchRows(S.firebase, n);

                    if (rows.length > 0) {
                        this.mergeData(rows);
                        this.connectionState = 'connected';
                        this.notifyStatus('connected', 'Langsung dari Firebase RTDB');
                    } else if (this.cachedData.length === 0) {
                        // If completely empty, seed demo
                        const fallback = this.demoRows(60);
                        this.mergeData(fallback);
                        this.connectionState = 'demo';
                        this.notifyStatus('demo', 'Data contoh (Firebase kosong)');
                    }
                } catch (err) {
                    if (this.cachedData.length === 0) {
                        const fallback = this.demoRows(60);
                        this.mergeData(fallback);
                        this.connectionState = 'fallback';
                        this.notifyStatus('fallback', 'Data contoh (Firebase offline)');
                    } else {
                        this.connectionState = 'offline';
                        this.notifyStatus('offline', 'Firebase terputus · Menggunakan offline cache');
                        const sim = this.demoStep(Date.now());
                        this.mergeData([sim]);
                    }
                }
            }

            this.pollTimer = setTimeout(() => this.pollCycle(), S.poll);
        }

        mergeData(newRows) {
            if (!Array.isArray(newRows) || newRows.length === 0) return;

            const existingTimes = new Set(this.cachedData.map(r => r.t));
            let added = [];

            for (const row of newRows) {
                if (!existingTimes.has(row.t)) {
                    this.cachedData.push(row);
                    added.push(row);
                    existingTimes.add(row.t);
                }
            }

            this.cachedData.sort((a, b) => a.t - b.t);
            if (this.cachedData.length > 3600) {
                this.cachedData = this.cachedData.slice(-3600);
            }

            if (added.length > 0) {
                this.saveCache();
                this.notifyData(this.cachedData, added);
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
            if (this.pollTimer) {
                clearTimeout(this.pollTimer);
                this.pollTimer = null;
            }
        }

        restart() {
            this.stop();
            this.cachedData = [];
            this.start();
        }

        subscribe(callback) {
            if (typeof callback === 'function') {
                this.listeners.push(callback);
                if (this.cachedData.length > 0) {
                    callback(this.cachedData, [this.cachedData[this.cachedData.length - 1]]);
                }
            }
            return () => {
                this.listeners = this.listeners.filter(cb => cb !== callback);
            };
        }

        subscribeStatus(callback) {
            if (typeof callback === 'function') {
                this.statusListeners.push(callback);
                callback(this.connectionState, '');
            }
            return () => {
                this.statusListeners = this.statusListeners.filter(cb => cb !== callback);
            };
        }

        notifyData(allData, addedRows) {
            for (const listener of this.listeners) {
                try {
                    listener(allData, addedRows);
                } catch (e) {
                    console.error('[FirebaseClient] Listener error:', e);
                }
            }
        }

        notifyStatus(state, message) {
            for (const listener of this.statusListeners) {
                try {
                    listener(state, message);
                } catch (e) {
                    console.error('[FirebaseClient] Status listener error:', e);
                }
            }
        }

        getLatest() {
            return this.cachedData.length > 0 
                ? this.cachedData[this.cachedData.length - 1] 
                : null;
        }

        getAll() {
            return this.cachedData.slice();
        }
    }

    window.FirebaseEdgeClient = new FirebaseClient();

})(window);
