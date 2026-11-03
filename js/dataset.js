/**
 * DatasetStore: penampung telemetri sensor REAL dari Firebase RTDB.
 * Tidak ada data sintetis atau prediksi di sini.
 */
(function (window) {
    'use strict';

    const Sec = window.SecurityUtils;
    const MAX_ROWS = 3600;

    class DatasetStore {
        constructor() {
            this.rows = [];
            this.source = 'offline';
            this.listeners = [];
            this.H = {
                page: 1,
                per: 10,
                k: 't',
                dir: -1,
                status: 'all',
                range: 0,
                agg: false,
                search: ''
            };
        }

        onChange(fn) {
            if (typeof fn === 'function') this.listeners.push(fn);
        }

        _notify() {
            this.listeners.forEach(fn => {
                try { fn(this); } catch (e) { console.error('[DatasetStore] listener error:', e); }
            });
        }

        setRecords(rows, source) {
            this.rows = Array.isArray(rows) ? rows.slice(-MAX_ROWS) : [];
            this.source = source || 'offline';
            this._notify();
        }

        addRecord(record) {
            if (!record || typeof record.t !== 'number') return;
            this.rows.push(record);
            if (this.rows.length > MAX_ROWS) this.rows.shift();
            this._notify();
        }

        getAll() { return this.rows.slice(); }

        getLatest() { return this.rows.length ? this.rows[this.rows.length - 1] : null; }

        getRecent(n = 10) { return this.rows.slice(-n); }

        /** Baris dalam `sec` detik terakhir, relatif terhadap data terbaru (0 = semua). */
        getWindow(sec) {
            if (!sec || !this.rows.length) return this.rows.slice();
            const ref = this.rows[this.rows.length - 1].t;
            return this.rows.filter(r => r.t >= ref - sec * 1000);
        }

        zoneOf(soil) {
            const S = window.ConfigStore ? window.ConfigStore.get() : { dry: 65, wet: 78 };
            if (soil < S.dry) return 'dry';
            if (soil > S.wet) return 'wet';
            return 'ok';
        }

        getZone(soil) { return this.zoneOf(soil); }

        zoneLabel(z) {
            return z === 'dry' ? 'Kering' : (z === 'wet' ? 'Basah' : 'Optimal');
        }

        getZoneLabel(z) { return this.zoneLabel(z); }

        getZoneHint(z) {
            const S = window.ConfigStore ? window.ConfigStore.get() : { dry: 65, wet: 78 };
            if (z === 'dry') return `Tanah kering (< ${S.dry}%). Pompa otomatis diperintahkan menyala.`;
            if (z === 'ok') return `Dalam rentang optimal (${S.dry}–${S.wet}%). Pompa siaga.`;
            return `Tanah basah (> ${S.wet}%). Pompa mati untuk proteksi akar.`;
        }

        calculateZoneShare(rows) {
            const src = rows || this.rows;
            if (!src || !src.length) return { dry: 0, ok: 0, wet: 0, count: 0 };
            const counts = { dry: 0, ok: 0, wet: 0 };
            let validCount = 0;
            src.forEach(r => {
                if (Number.isFinite(r.tanah)) {
                    counts[this.zoneOf(r.tanah)]++;
                    validCount++;
                }
            });
            if (!validCount) return { dry: 0, ok: 0, wet: 0, count: 0 };
            return {
                dry: Math.round((counts.dry / validCount) * 100),
                ok: Math.round((counts.ok / validCount) * 100),
                wet: Math.round((counts.wet / validCount) * 100),
                count: validCount
            };
        }

        calculateStats(rows, getter, threshold = 0.5) {
            const src = rows || this.rows;
            if (!src || !src.length) {
                return { cur: 0, avg: 0, min: 0, max: 0, d: 0, tr: 'NO DATA', count: 0 };
            }
            const vals = src.map(getter).filter(v => Number.isFinite(v));
            if (!vals.length) {
                return { cur: 0, avg: 0, min: 0, max: 0, d: 0, tr: 'NO DATA', count: 0 };
            }
            const n = vals.length;
            const cur = vals[n - 1];
            const sum = vals.reduce((a, b) => a + b, 0);
            const avg = sum / n;
            const min = Math.min(...vals);
            const max = Math.max(...vals);
            const half = Math.max(1, Math.floor(n / 2));
            const firstHalf = vals.slice(0, half).reduce((a, b) => a + b, 0) / half;
            const lastHalf = vals.slice(-half).reduce((a, b) => a + b, 0) / half;
            const d = lastHalf - firstHalf;
            const tr = Math.abs(d) < threshold ? 'Stabil' : (d > 0 ? 'Naik' : 'Turun');
            return { cur, avg, min, max, d, tr, count: n };
        }

        aggregateByMinute(rows) {
            const buckets = new Map();
            (rows || []).forEach(r => {
                const m = Math.floor(r.t / 60000) * 60000;
                if (!buckets.has(m)) buckets.set(m, []);
                buckets.get(m).push(r);
            });
            const out = [];
            buckets.forEach((list, m) => {
                const n = list.length;
                const tanah = Math.round(list.reduce((a, x) => a + x.tanah, 0) / n);
                const udara = Math.round(list.reduce((a, x) => a + x.udara, 0) / n);
                const suhu = Number((list.reduce((a, x) => a + x.suhu, 0) / n).toFixed(1));
                const anyRelay = list.some(x => x.relayActual === true);
                const hasRelay = list.some(x => typeof x.relayActual === 'boolean');
                out.push({
                    id: 'agg_' + m,
                    t: m,
                    tanah,
                    udara,
                    suhu,
                    relayActual: hasRelay ? anyRelay : null,
                    source: list[n - 1].source,
                    samples: n
                });
            });
            return out.sort((a, b) => a.t - b.t);
        }

        queryHistory(opts = {}) {
            const st = Object.assign(this.H, opts);
            let list = this.rows.slice();
            if (st.range > 0 && list.length) {
                const ref = list[list.length - 1].t;
                list = list.filter(r => r.t >= ref - st.range * 1000);
            }
            if (st.agg) {
                list = this.aggregateByMinute(list);
            }
            if (st.status && st.status !== 'all') {
                list = list.filter(r => this.zoneOf(r.tanah) === st.status);
            }
            const q = String(st.search || '').trim().toLowerCase();
            if (q) {
                list = list.filter(r => {
                    const zLbl = this.zoneLabel(this.zoneOf(r.tanah)).toLowerCase();
                    const rel = typeof r.relayActual === 'boolean' ? (r.relayActual ? 'on' : 'off') : '';
                    const iso = new Date(r.t).toISOString().toLowerCase();
                    const wib = new Date(r.t).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }).toLowerCase();
                    return zLbl.includes(q) || rel.includes(q) || iso.includes(q) || wib.includes(q) ||
                        String(r.tanah).includes(q) || String(r.suhu).includes(q) || String(r.udara).includes(q);
                });
            }
            const k = st.k || 't';
            const dir = st.dir === 1 ? 1 : -1;
            list.sort((a, b) => ((a[k] || 0) - (b[k] || 0)) * dir);
            const total = list.length;
            const per = Math.max(1, Number(st.per) || 10);
            const totalPages = Math.max(1, Math.ceil(total / per));
            st.page = Math.min(totalPages, Math.max(1, Number(st.page) || 1));
            const start = (st.page - 1) * per;
            return {
                rows: list.slice(start, start + per),
                allFiltered: list,
                total,
                page: st.page,
                per,
                totalPages
            };
        }

        toCSV(customRows) {
            const target = Array.isArray(customRows) ? customRows : this.rows;
            const header = ['waktu_iso', 'tanah_pct', 'udara_pct', 'suhu_c', 'zona', 'relay', 'sumber'];
            const lines = [header.join(',')];
            target.forEach(r => {
                const relay = typeof r.relayActual === 'boolean' ? (r.relayActual ? 'ON' : 'OFF') : '';
                lines.push([
                    new Date(r.t).toISOString(),
                    r.tanah,
                    r.udara,
                    r.suhu,
                    this.zoneLabel(this.zoneOf(r.tanah)),
                    relay,
                    r.source
                ].map(Sec.escapeCSV).join(','));
            });
            return lines.join('\n');
        }
    }

    const store = new DatasetStore();
    window.DatasetStore = store;

    window.FirebaseEdgeClient.subscribe((all, _added, source) => store.setRecords(all, source));
})(window);
