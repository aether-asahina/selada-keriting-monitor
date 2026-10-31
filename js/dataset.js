/**
 * ==============================================================================
 * MODULE: DATASET STORE, HISTORY TABLE & STATISTICAL ENGINE
 * Handles historical records, zone distribution, column sorting, and CSV export
 * ==============================================================================
 */

(function (window) {
    'use strict';

    class DatasetStore {
        constructor() {
            this.records = [];
            this.maxBufferSize = 3600;
            this.H = {
                page: 1,
                per: 15,
                k: 't',
                dir: -1,
                status: 'all',
                range: 0,
                agg: false
            };
        }

        setRecords(records) {
            if (Array.isArray(records)) {
                this.records = records.slice(-this.maxBufferSize);
            }
        }

        addRecord(record) {
            if (!record || typeof record.t !== 'number') return;
            this.records.push(record);
            if (this.records.length > this.maxBufferSize) {
                this.records.shift();
            }
        }

        getAll() {
            return this.records.slice();
        }

        getRecent(n = 10) {
            return this.records.slice(-n);
        }

        getLatest() {
            return this.records.length ? this.records[this.records.length - 1] : null;
        }

        clearHistory() {
            const l = this.getLatest();
            this.records = l ? [l] : [];
            this.H.page = 1;
        }

        // Zone determination based on user configured dry & wet limits
        getZone(soilVal) {
            const S = window.ConfigStore ? window.ConfigStore.get() : { dry: 65, wet: 78 };
            if (soilVal < S.dry) return 'dry';
            if (soilVal > S.wet) return 'wet';
            return 'ok';
        }

        getZoneLabel(z) {
            if (z === 'dry') return 'Kering';
            if (z === 'wet') return 'Basah';
            return 'Normal';
        }

        getZoneHint(z) {
            const S = window.ConfigStore ? window.ConfigStore.get() : { dry: 65, wet: 78 };
            if (z === 'dry') return `Tanah kering (< ${S.dry}%). Pompa menyala otomatis.`;
            if (z === 'ok') return `Dalam rentang optimal (${S.dry}–${S.wet}%). Pompa siaga.`;
            return `Tanah basah (> ${S.wet}%). Pompa mati untuk proteksi akar.`;
        }

        // Compute percentage of time in each zone
        calculateZoneShare(rows) {
            if (!rows || rows.length === 0) return { dry: 0, ok: 100, wet: 0 };
            const counts = { dry: 0, ok: 0, wet: 0 };
            for (const r of rows) {
                const z = this.getZone(r.tanah);
                counts[z]++;
            }
            const total = rows.length;
            return {
                dry: Math.round((counts.dry / total) * 100),
                ok: Math.round((counts.ok / total) * 100),
                wet: Math.round((counts.wet / total) * 100)
            };
        }

        // Detailed statistical analysis for a numeric sensor field
        calculateStats(rows, getter, threshold = 0.5) {
            if (!rows || rows.length === 0) {
                return { cur: 0, avg: 0, min: 0, max: 0, d: 0, tr: 'Stabil' };
            }
            const vals = rows.map(getter);
            const n = vals.length;
            const cur = vals[n - 1];
            const sum = vals.reduce((a, b) => a + b, 0);
            const avg = sum / n;
            const min = Math.min(...vals);
            const max = Math.max(...vals);

            const m = Math.min(n, Math.max(3, Math.floor(n / 4)));
            const v0 = vals.slice(0, m).reduce((a, b) => a + b, 0) / m;
            const v1 = vals.slice(-m).reduce((a, b) => a + b, 0) / m;
            const d = v1 - v0;

            let tr = 'Stabil';
            if (n >= 10 && Math.abs(d) >= threshold) {
                tr = d > 0 ? 'Naik' : 'Turun';
            }

            return { cur, avg, min, max, d, tr };
        }

        generateStatHTML(st, unit, dec = 0) {
            const fmt = (v) => Number(v).toFixed(dec);
            const sign = (v) => (v > 0 ? '+' : '') + fmt(v);

            function item(label, val, sub) {
                return `
                    <div class="stat">
                        <span class="label">${label}</span>
                        <b>${val}</b>
                        <small>${sub || '&nbsp;'}</small>
                    </div>
                `;
            }

            return item('Sekarang', fmt(st.cur), unit) +
                item('Rata-rata', fmt(st.avg), unit) +
                item('Terendah', fmt(st.min), unit) +
                item('Tertinggi', fmt(st.max), unit) +
                item('Tren', st.tr, st.tr === 'Stabil' ? 'Stabil' : `${sign(st.d)} ${unit}`);
        }

        // Pump cycle calculations
        calculatePumpStats(rows) {
            const S = window.ConfigStore ? window.ConfigStore.get() : { dry: 65, wet: 78 };
            let cycles = 0, onMs = 0, prevDry = false;

            rows.forEach((r, i) => {
                const d = r.tanah < S.dry;
                if (d && !prevDry) cycles++;
                if (i > 0 && prevDry) onMs += Math.min(r.t - rows[i - 1].t, 5000);
                prevDry = d;
            });

            return { cycles, onMs };
        }

        // Filter and aggregate rows for History view
        getFilteredHistoryRows() {
            let list = this.records.slice();
            const now = Date.now();

            if (this.H.range > 0) {
                const cutoff = now - this.H.range * 1000;
                list = list.filter(r => r.t >= cutoff);
            }

            if (this.H.status !== 'all') {
                list = list.filter(r => this.getZone(r.tanah) === this.H.status);
            }

            if (this.H.agg) {
                const buckets = {};
                for (const r of list) {
                    const minKey = Math.floor(r.t / 60000) * 60000;
                    if (!buckets[minKey]) buckets[minKey] = [];
                    buckets[minKey].push(r);
                }
                list = Object.keys(buckets).sort().map(k => {
                    const group = buckets[k];
                    const avg = key => group.reduce((a, b) => a + Number(b[key]), 0) / group.length;
                    return {
                        t: Number(k),
                        suhu: Number(avg('suhu').toFixed(1)),
                        udara: Math.round(avg('udara')),
                        tanah: Math.round(avg('tanah')),
                        id: 'agg_' + k
                    };
                });
            }

            // Sort
            const k = this.H.k;
            const dir = this.H.dir;
            list.sort((a, b) => {
                const va = a[k], vb = b[k];
                return va < vb ? -dir : (va > vb ? dir : 0);
            });

            return list;
        }

        formatTime(t, short = false) {
            const d = new Date(t);
            const S = window.ConfigStore ? window.ConfigStore.get() : { clock: '24' };
            if (S.clock === '12') {
                return d.toLocaleTimeString('en-US', {
                    hour12: true,
                    hour: '2-digit',
                    minute: '2-digit',
                    second: short ? undefined : '2-digit'
                });
            }
            return d.toLocaleTimeString('id-ID', {
                hour12: false,
                hour: '2-digit',
                minute: '2-digit',
                second: short ? undefined : '2-digit'
            });
        }

        // Render full History Table on #p-riwayat
        renderRiwayat() {
            const tbody = document.getElementById('hbody');
            const hsum = document.getElementById('hsum');
            const hinfo = document.getElementById('hinfo');
            const btnPrev = document.getElementById('hPrev');
            const btnNext = document.getElementById('hNext');

            if (!tbody) return;

            const rows = this.getFilteredHistoryRows();
            const total = rows.length;
            const maxPage = Math.max(1, Math.ceil(total / this.H.per));
            if (this.H.page > maxPage) this.H.page = maxPage;
            if (this.H.page < 1) this.H.page = 1;

            const start = (this.H.page - 1) * this.H.per;
            const pageRows = rows.slice(start, start + this.H.per);

            // Summary bar
            if (hsum) {
                const S = window.ConfigStore ? window.ConfigStore.get() : { unit: 'C' };
                const tUnit = S.unit === 'F' ? '°F' : '°C';
                const convTemp = S.unit === 'F' ? (v => (v * 9 / 5) + 32) : (v => v);

                const tanahSt = this.calculateStats(rows, r => r.tanah);
                const suhuSt = this.calculateStats(rows, r => convTemp(r.suhu));
                const udaraSt = this.calculateStats(rows, r => r.udara);

                hsum.innerHTML = `
                    <div class="stat"><span class="label">Total baris</span><b>${total}</b><small>sesuai filter</small></div>
                    <div class="stat"><span class="label">Rata-rata tanah</span><b>${tanahSt.avg.toFixed(0)}%</b><small>rentang ${tanahSt.min}–${tanahSt.max}%</small></div>
                    <div class="stat"><span class="label">Rata-rata suhu</span><b>${suhuSt.avg.toFixed(1)}${tUnit}</b><small>rentang ${suhuSt.min.toFixed(1)}–${suhuSt.max.toFixed(1)}</small></div>
                    <div class="stat"><span class="label">Rata-rata udara</span><b>${udaraSt.avg.toFixed(0)}%</b><small>rentang ${udaraSt.min}–${udaraSt.max}%</small></div>
                `;
            }

            // Table rows
            if (pageRows.length === 0) {
                tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--text-muted)">Tidak ada data yang cocok dengan filter saat ini.</td></tr>`;
            } else {
                tbody.innerHTML = pageRows.map(r => {
                    const z = this.getZone(r.tanah);
                    const badgeClass = z === 'dry' ? 'alert' : (z === 'wet' ? 'warn' : 'ok');
                    const badgeText = this.getZoneLabel(z);

                    return `
                        <tr>
                            <td class="tabular-nums" style="color:var(--text-secondary);">${this.formatTime(r.t)}</td>
                            <td class="tabular-nums">${r.suhu}°C</td>
                            <td class="tabular-nums">${r.udara}%</td>
                            <td class="tabular-nums" style="font-weight:600;">${r.tanah}%</td>
                            <td><span class="metric-badge ${badgeClass}">${badgeText}</span></td>
                        </tr>
                    `;
                }).join('');
            }

            // Pager
            if (hinfo) {
                hinfo.textContent = total > 0 
                    ? `Menampilkan ${start + 1}–${Math.min(total, start + this.H.per)} dari ${total} baris (Halaman ${this.H.page}/${maxPage})`
                    : 'Tidak ada data';
            }
            if (btnPrev) btnPrev.disabled = this.H.page <= 1;
            if (btnNext) btnNext.disabled = this.H.page >= maxPage;

            // Update column header sort arrows
            document.querySelectorAll('#p-riwayat th[data-k]').forEach(th => {
                if (th.dataset.k === this.H.k) {
                    th.setAttribute('aria-sort', this.H.dir > 0 ? 'ascending' : 'descending');
                } else {
                    th.removeAttribute('aria-sort');
                }
            });
        }

        // CSV String Generator
        generateCSV() {
            const rows = this.getFilteredHistoryRows();
            const S = window.ConfigStore ? window.ConfigStore.get() : { dry: 65, wet: 78 };
            const headers = ['Waktu', 'Suhu', 'Kelembapan_Udara', 'Kelembapan_Tanah', 'Zona', 'Status_Pompa'];
            const lines = [headers.join(',')];

            for (const r of rows) {
                const z = this.getZone(r.tanah);
                const pump = r.tanah < S.dry ? 'MENYALA' : 'MATI';
                const timeStr = new Date(r.t).toISOString();
                lines.push([timeStr, r.suhu, r.udara, r.tanah, this.getZoneLabel(z), pump].join(','));
            }

            return lines.join('\n');
        }

        renderSnippetTable(containerId, count = 8) {
            const container = document.getElementById(containerId);
            if (!container) return;

            const recentRows = this.getRecent(count).reverse();
            if (recentRows.length === 0) {
                container.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-muted)">Memuat data telemetri dari Firebase...</td></tr>`;
                return;
            }

            const S = window.ConfigStore ? window.ConfigStore.get() : { dry: 65, wet: 78 };
            container.innerHTML = recentRows.map(row => {
                const isPumpOn = row.tanah < S.dry;
                const soilBadgeClass = row.tanah < S.dry ? 'alert' : (row.tanah > S.wet ? 'warn' : 'ok');
                const soilStatusText = row.tanah < S.dry ? 'Kering' : (row.tanah > S.wet ? 'Basah' : 'Optimal');

                const pumpBadgeClass = isPumpOn ? 'warn' : 'ok';
                const pumpText = isPumpOn ? 'Menyala (Irigasi)' : 'Mati (Siaga)';

                return `
                    <tr>
                        <td class="tabular-nums" style="color:var(--text-secondary);">${this.formatTime(row.t)}</td>
                        <td class="tabular-nums" style="font-weight:600;">${row.tanah}%</td>
                        <td class="tabular-nums">${row.udara}%</td>
                        <td class="tabular-nums">${row.suhu}°C</td>
                        <td><span class="metric-badge ${soilBadgeClass}">${soilStatusText}</span></td>
                        <td><span class="metric-badge ${pumpBadgeClass}">${pumpText}</span></td>
                    </tr>
                `;
            }).join('');
        }
    }

    window.DatasetStore = new DatasetStore();

})(window);
