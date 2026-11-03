/**
 * Kontroler UI: navigasi, grafik SVG, kamera, hasil CNN, prediksi LSTM, AI assistant.
 * Semua angka di luar halaman Prediksi berasal dari data real (Firebase + pipeline CV).
 */
(function () {
    'use strict';

    const Sec = window.SecurityUtils;
    const Cfg = window.ConfigStore;
    const FB = window.FirebaseEdgeClient;
    const DS = window.DatasetStore;
    const GS = window.GrowthStore;
    const FC = window.Forecast;
    const AI = window.AIAssistant;
    const CLASSES = GS.CLASSES;

    const $ = (sel, root) => (root || document).querySelector(sel);
    const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
    const esc = Sec.escapeHTML;

    const PAGES = {
        dashboard: { title: 'Dashboard', sub: 'Sensor, pompa, dan lebar daun secara real-time' },
        kamera: { title: 'Kamera & CNN', sub: 'Pantauan kamera dan klasifikasi tahap tumbuh' },
        prediksi: { title: 'Prediksi LSTM', sub: 'Perkiraan lebar daun 4 hari ke depan' },
        ai: { title: 'AI Assistant', sub: 'Tanya jawab agronomi selada keriting' }
    };

    let activePage = 'dashboard';
    let teleMetric = 'tanah';
    let teleWindow = 0;
    let lastForecast = null;

    // ======================================================================
    // Format waktu (WIB)
    // ======================================================================
    const TZ = 'Asia/Jakarta';
    const fmtClock = t => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: TZ });
    const fmtHM = t => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });
    const fmtDay = t => new Date(t).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', timeZone: TZ });
    const fmtDayTime = t => fmtDay(t) + ' ' + fmtHM(t);

    // ======================================================================
    // Util UI
    // ======================================================================
    function setBadge(el, text, tone) {
        if (!el) return;
        el.textContent = text;
        el.className = 'badge ' + (tone || 'muted');
    }

    let toastTimer = null;
    function toast(msg) {
        const el = $('#toast');
        el.textContent = msg;
        el.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
    }

    function setSeg(seg, value) {
        $$('button', seg).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === String(value))));
    }

    function renderStatBar(el, items) {
        if (!el) return;
        el.textContent = '';
        items.forEach(it => {
            const box = document.createElement('div');
            box.className = 'stat-item';
            const sm = document.createElement('small');
            sm.textContent = it[0];
            const b = document.createElement('b');
            b.textContent = it[1];
            box.appendChild(sm);
            box.appendChild(b);
            el.appendChild(box);
        });
    }

    function downsample(pts, max) {
        if (pts.length <= max) return pts;
        const step = pts.length / max;
        const out = [];
        for (let i = 0; i < max; i++) out.push(pts[Math.floor(i * step)]);
        out.push(pts[pts.length - 1]);
        return out;
    }

    // ======================================================================
    // Grafik SVG
    // cfg: { series:[{label,color,pts:[[x,y]],dash,step}], yMin,yMax,yTicks,xFmt,yFmt,empty,readout,defaultReadout }
    // ======================================================================
    function drawChart(host, cfg) {
        host.textContent = '';
        const all = [];
        cfg.series.forEach(s => s.pts.forEach(p => all.push(p)));
        if (!all.length) {
            const e = document.createElement('div');
            e.className = 'empty';
            e.textContent = cfg.empty || 'NO DATA';
            host.appendChild(e);
            if (cfg.readout) cfg.readout.textContent = '';
            return;
        }

        const W = Math.max(260, host.clientWidth || 320);
        const H = 220;
        const pad = { t: 12, r: 14, b: 26, l: 44 };
        const iw = W - pad.l - pad.r;
        const ih = H - pad.t - pad.b;

        let x0 = Infinity, x1 = -Infinity, ymin = Infinity, ymax = -Infinity;
        all.forEach(p => {
            if (p[0] < x0) x0 = p[0];
            if (p[0] > x1) x1 = p[0];
            if (p[1] < ymin) ymin = p[1];
            if (p[1] > ymax) ymax = p[1];
        });
        if (x1 === x0) { x0 -= 1; x1 += 1; }
        let y0 = cfg.yMin !== undefined ? cfg.yMin : ymin;
        let y1 = cfg.yMax !== undefined ? cfg.yMax : ymax;
        if (cfg.yMin === undefined || cfg.yMax === undefined) {
            const span = (y1 - y0) || Math.max(1, Math.abs(y1) * 0.1);
            if (cfg.yMin === undefined) y0 -= span * 0.12;
            if (cfg.yMax === undefined) y1 += span * 0.12;
            if (cfg.floor0 && y0 < 0) y0 = 0;
        }
        const yr = (y1 - y0) || 1;
        const X = v => pad.l + ((v - x0) / (x1 - x0)) * iw;
        const Y = v => pad.t + (1 - (v - y0) / yr) * ih;
        const yFmt = cfg.yFmt || (v => String(Math.round(v * 10) / 10));
        const xFmt = cfg.xFmt || String;

        let svg = '';
        const ticks = cfg.yTicks || [0, 1, 2, 3].map(i => y0 + (yr * i) / 3);
        ticks.forEach(v => {
            const y = Y(v).toFixed(1);
            svg += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}"/>` +
                `<text class="axis" x="${pad.l - 6}" y="${(Number(y) + 3.5).toFixed(1)}" text-anchor="end">${esc(yFmt(v))}</text>`;
        });
        [0, 1, 2, 3].forEach(i => {
            const v = x0 + ((x1 - x0) * i) / 3;
            const anchor = i === 0 ? 'start' : (i === 3 ? 'end' : 'middle');
            svg += `<text class="axis" x="${X(v).toFixed(1)}" y="${H - 7}" text-anchor="${anchor}">${esc(xFmt(v))}</text>`;
        });

        cfg.series.forEach(s => {
            if (!s.pts.length) return;
            const pts = s.pts;
            let d = '';
            pts.forEach((p, i) => {
                const px = X(p[0]).toFixed(1);
                const py = Y(p[1]).toFixed(1);
                if (i === 0) d += `M${px},${py}`;
                else if (s.step) d += `H${px}V${py}`;
                else d += `L${px},${py}`;
            });
            svg += `<path d="${d}" fill="none" style="stroke:${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${s.dash ? ' stroke-dasharray="6 5"' : ''}/>`;
            if (pts.length <= 40) {
                pts.forEach(p => { svg += `<circle cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="3" style="fill:${s.color}"/>`; });
            }
        });
        svg += `<line class="cross" x1="0" x2="0" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/>`;
        svg += `<rect class="hit" x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}" fill="transparent"/>`;
        host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(cfg.label || 'Grafik')}">${svg}</svg>`;

        const ro = cfg.readout;
        const defaultText = cfg.defaultReadout || '';
        if (ro) ro.textContent = defaultText;

        const hit = $('.hit', host);
        const cross = $('.cross', host);
        const svgEl = $('svg', host);
        const nearest = (s, xv) => {
            let best = s.pts[0];
            let bd = Math.abs(best[0] - xv);
            for (let i = 1; i < s.pts.length; i++) {
                const dd = Math.abs(s.pts[i][0] - xv);
                if (dd < bd) { bd = dd; best = s.pts[i]; }
            }
            return best;
        };
        const onMove = ev => {
            const r = svgEl.getBoundingClientRect();
            const px = ((ev.clientX - r.left) / r.width) * W;
            const xv = x0 + ((px - pad.l) / iw) * (x1 - x0);
            const parts = [];
            let cx = null;
            cfg.series.forEach(s => {
                if (!s.pts.length) return;
                const p = nearest(s, xv);
                if (cx === null) cx = X(p[0]);
                parts.push(`${s.label}: ${yFmt(p[1])}${cfg.unit || ''} (${xFmt(p[0])})`);
            });
            cross.setAttribute('x1', cx);
            cross.setAttribute('x2', cx);
            cross.setAttribute('visibility', 'visible');
            if (ro) ro.textContent = parts.join('  ·  ');
        };
        const onLeave = () => {
            cross.setAttribute('visibility', 'hidden');
            if (ro) ro.textContent = defaultText;
        };
        hit.addEventListener('pointermove', onMove);
        hit.addEventListener('pointerdown', onMove);
        hit.addEventListener('pointerleave', onLeave);
    }

    // ======================================================================
    // Status koneksi
    // ======================================================================
    const CONN = {
        connecting: ['Menghubungkan…', 'muted'],
        connected: ['Live', 'ok'],
        stale: ['ESP32 offline', 'warn'],
        empty: ['Belum ada data', 'warn'],
        offline: ['Cache offline', 'warn'],
        disconnected: ['Terputus', 'err']
    };

    function onConnStatus(state, msg) {
        if (state === 'disconnected' && !FB.isPolling) return;
        const m = CONN[state] || CONN.connecting;
        const el = $('#connBadge');
        setBadge(el, m[0], m[1]);
        el.title = msg || '';
    }

    // ======================================================================
    // Dashboard
    // ======================================================================
    function renderKPIs() {
        const r = DS.getLatest();
        const has = !!r;
        $('#vSoil').textContent = has ? r.tanah : '—';
        $('#vTemp').textContent = has ? r.suhu.toFixed(1) : '—';
        $('#vAir').textContent = has ? r.udara : '—';

        if (has) {
            const z = DS.zoneOf(r.tanah);
            setBadge($('#bSoil'), DS.zoneLabel(z), z === 'ok' ? 'ok' : 'warn');
            const S = Cfg.get();
            $('#sSoil').textContent = `Target ${S.dry}–${S.wet}%`;
            setBadge($('#bTemp'), r.suhu < 15 ? 'Dingin' : (r.suhu > 24 ? (r.suhu > 28 ? 'Panas' : 'Hangat') : 'Optimal'),
                r.suhu >= 15 && r.suhu <= 24 ? 'ok' : 'warn');
            setBadge($('#bAir'), r.udara < 60 ? 'Kering' : (r.udara > 80 ? 'Lembap' : 'Optimal'),
                r.udara >= 60 && r.udara <= 80 ? 'ok' : 'warn');

            const pump = $('#vPump');
            if (typeof r.relayActual === 'boolean') {
                pump.textContent = r.relayActual ? 'ON' : 'OFF';
                setBadge($('#bPump'), r.relayActual ? 'Irigasi aktif' : 'Siaga', r.relayActual ? 'info' : 'ok');
            } else {
                pump.textContent = '—';
                setBadge($('#bPump'), 'Tanpa feedback', 'muted');
            }
        } else {
            setBadge($('#bSoil'), 'NO DATA', 'muted');
            setBadge($('#bTemp'), 'NO DATA', 'muted');
            setBadge($('#bAir'), 'NO DATA', 'muted');
            setBadge($('#bPump'), 'NO DATA', 'muted');
            $('#vPump').textContent = '—';
        }

        const leaf = GS.latest();
        const modelSt = GS.getModelStatus();
        if (leaf && leaf.cls !== 'bukan_selada' && leaf.width !== null) {
            $('#vLeaf').textContent = leaf.width.toFixed(1);
            const c = leaf.cls ? CLASSES[leaf.cls] : null;
            const confTxt = leaf.conf !== null && Number.isFinite(leaf.conf) ? ` (${Math.round(leaf.conf * 100)}%)` : '';
            setBadge($('#bLeaf'), c ? `${c.label}${confTxt}` : 'CNN: ' + modelSt.status, c ? c.tone : 'muted');
            const verTxt = leaf.modelVersion ? ` · ${leaf.modelVersion}` : '';
            $('#sLeaf').textContent = (leaf.hst ? `HST ke-${leaf.hst} · ` : '') + fmtDayTime(leaf.t) + verTxt;
        } else if (leaf && leaf.cls === 'bukan_selada') {
            $('#vLeaf').textContent = '—';
            setBadge($('#bLeaf'), 'Bukan Selada · BELUM TERSEDIA', 'muted');
            $('#sLeaf').textContent = fmtDayTime(leaf.t);
        } else {
            $('#vLeaf').textContent = '—';
            setBadge($('#bLeaf'), 'NO DATA', 'muted');
            $('#sLeaf').textContent = 'Belum ada citra valid';
        }
    }

    const TELE = {
        tanah: { label: 'Tanah', unit: '%', color: 'var(--accent)', get: r => r.tanah, yMin: 0, yMax: 100 },
        udara: { label: 'Udara', unit: '%', color: 'var(--blue)', get: r => r.udara, yMin: 0, yMax: 100 },
        suhu: { label: 'Suhu', unit: '°C', color: 'var(--amber)', get: r => r.suhu },
        pompa: { label: 'Pompa', unit: '', color: 'var(--rose)', get: r => (typeof r.relayActual === 'boolean' ? (r.relayActual ? 1 : 0) : null), yMin: 0, yMax: 1, step: true }
    };

    function renderTeleChart() {
        const m = TELE[teleMetric];
        const rows = DS.getWindow(teleWindow);
        const rawPts = rows.map(r => [r.t, m.get(r)]).filter(p => p[1] !== null && Number.isFinite(p[1]));
        const isPump = teleMetric === 'pompa';
        if (isPump) {
            const onCnt = rawPts.filter(p => p[1] >= 0.5).length;
            const offCnt = rawPts.length - onCnt;
            const lastRaw = rawPts.length ? rawPts[rawPts.length - 1] : null;
            renderStatBar($('#teleStatBar'), [
                ['Sampel', String(rawPts.length)],
                ['Siklus ON', onCnt + ' sampel'],
                ['Siklus OFF', offCnt + ' sampel'],
                ['Status Terakhir', lastRaw ? (lastRaw[1] >= 0.5 ? 'ON' : 'OFF') : '—']
            ]);
        } else {
            let min = Infinity, max = -Infinity, sum = 0;
            rawPts.forEach(p => {
                if (p[1] < min) min = p[1];
                if (p[1] > max) max = p[1];
                sum += p[1];
            });
            const avg = rawPts.length ? (sum / rawPts.length) : null;
            const fmtNum = v => (Math.round(v * 10) / 10) + m.unit;
            renderStatBar($('#teleStatBar'), [
                ['Sampel', String(rawPts.length)],
                ['Minimum', rawPts.length ? fmtNum(min) : '—'],
                ['Rata-rata', avg !== null ? fmtNum(avg) : '—'],
                ['Maksimum', rawPts.length ? fmtNum(max) : '—']
            ]);
        }
        const pts = downsample(rawPts, 500);
        const last = pts.length ? pts[pts.length - 1] : null;
        const fmt = isPump ? (v => (v >= 0.5 ? 'ON' : 'OFF')) : undefined;
        drawChart($('#chTele'), {
            label: 'Grafik ' + m.label,
            series: [{ label: m.label, color: m.color, pts: pts, step: m.step }],
            yMin: m.yMin, yMax: m.yMax,
            yTicks: isPump ? [0, 1] : undefined,
            yFmt: fmt,
            unit: m.unit,
            xFmt: fmtHM,
            empty: isPump ? 'Belum ada feedback relay dari ESP32' : 'NO DATA · menunggu telemetri sensor',
            readout: $('#roTele'),
            defaultReadout: last ? `Terakhir: ${fmt ? fmt(last[1]) : last[1]}${m.unit} · ${fmtClock(last[0])}` : ''
        });
    }

    function renderLeafChart() {
        const st = GS.widthStats();
        renderStatBar($('#leafStatBar'), [
            ['Citra Valid', String(st.count)],
            ['Rata-rata', st.avg !== null ? st.avg.toFixed(1) + ' px' : '—'],
            ['Minimum', st.min !== null ? st.min.toFixed(1) + ' px' : '—'],
            ['Maksimum', st.max !== null ? st.max.toFixed(1) + ' px' : '—']
        ]);
        const pts = downsample(GS.lettuceRecords().map(r => [r.t, r.width]), 500);
        const last = pts.length ? pts[pts.length - 1] : null;
        drawChart($('#chLeaf'), {
            label: 'Grafik lebar daun',
            series: [{ label: 'Lebar daun', color: 'var(--accent)', pts: pts }],
            floor0: true,
            unit: ' px',
            xFmt: fmtDay,
            empty: 'NO DATA · belum ada citra valid dengan lebar daun',
            readout: $('#roLeaf'),
            defaultReadout: last ? `Terakhir: ${last[1].toFixed(1)} px · ${fmtDayTime(last[0])}` : ''
        });
    }

    function renderLog() {
        const body = $('#logBody');
        body.textContent = '';
        const q = DS.queryHistory({
            search: $('#logSearch') ? $('#logSearch').value : '',
            status: $('#logZone') ? $('#logZone').value : 'all',
            range: $('#logRange') ? Number($('#logRange').value) : 0,
            agg: $('#logAgg') ? $('#logAgg').value === '1' : false,
            per: 10
        });
        const pageInfo = $('#logPageInfo');
        if (pageInfo) pageInfo.textContent = `Halaman ${q.page} dari ${q.totalPages} (${q.total} baris)`;
        if ($('#logPrev')) $('#logPrev').disabled = q.page <= 1;
        if ($('#logNext')) $('#logNext').disabled = q.page >= q.totalPages;

        if (!q.rows.length) {
            const tr = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = 6;
            td.className = 'empty-row';
            td.textContent = DS.getAll().length ? 'Tidak ada rekaman yang cocok dengan filter.' : 'Belum ada telemetri.';
            tr.appendChild(td);
            body.appendChild(tr);
            return;
        }
        q.rows.forEach(r => {
            const tr = document.createElement('tr');
            const relay = typeof r.relayActual === 'boolean' ? (r.relayActual ? 'ON' : 'OFF') : '—';
            const timeLbl = r.samples ? `${fmtDayTime(r.t)} (${r.samples}x)` : fmtClock(r.t);
            [timeLbl, r.tanah + '%', r.udara + '%', r.suhu.toFixed(1) + '°C', DS.zoneLabel(DS.zoneOf(r.tanah)), relay].forEach(v => {
                const td = document.createElement('td');
                td.textContent = v;
                tr.appendChild(td);
            });
            body.appendChild(tr);
        });
    }

    function syncConfigForm() {
        const S = Cfg.get();
        if ($('#cfgFirebase')) $('#cfgFirebase').value = S.firebase || '';
        if ($('#cfgPoll')) $('#cfgPoll').value = S.poll || 2000;
        if ($('#cfgOffline')) $('#cfgOffline').value = S.offlineSec || 15;
        if ($('#cfgDry')) $('#cfgDry').value = S.dry || 65;
        if ($('#cfgWet')) $('#cfgWet').value = S.wet || 78;
    }

    function renderDashboard() {
        renderKPIs();
        renderTeleChart();
        renderLeafChart();
        renderLog();
        syncConfigForm();
    }

    function bindDashboard() {
        setSeg($('#segMetric'), teleMetric);
        setSeg($('#segWindow'), teleWindow);
        $('#segMetric').addEventListener('click', e => {
            const b = e.target.closest('button');
            if (!b) return;
            teleMetric = b.dataset.v;
            setSeg($('#segMetric'), teleMetric);
            renderTeleChart();
        });
        $('#segWindow').addEventListener('click', e => {
            const b = e.target.closest('button');
            if (!b) return;
            teleWindow = Number(b.dataset.v);
            setSeg($('#segWindow'), teleWindow);
            renderTeleChart();
        });

        const resetLogPageAndRender = () => {
            DS.H.page = 1;
            renderLog();
        };
        if ($('#logSearch')) $('#logSearch').addEventListener('input', resetLogPageAndRender);
        if ($('#logZone')) $('#logZone').addEventListener('change', resetLogPageAndRender);
        if ($('#logRange')) $('#logRange').addEventListener('change', resetLogPageAndRender);
        if ($('#logAgg')) $('#logAgg').addEventListener('change', resetLogPageAndRender);
        if ($('#logPrev')) $('#logPrev').addEventListener('click', () => { DS.H.page = Math.max(1, DS.H.page - 1); renderLog(); });
        if ($('#logNext')) $('#logNext').addEventListener('click', () => { DS.H.page += 1; renderLog(); });

        $('#btnCsv').addEventListener('click', () => {
            const q = DS.queryHistory();
            if (!q.allFiltered.length) { toast('Belum ada data untuk diunduh'); return; }
            const blob = new Blob([DS.toCSV(q.allFiltered)], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'telemetri_kelompok5.csv';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        });
        $('#btnCopy').addEventListener('click', async () => {
            const q = DS.queryHistory();
            const rows = q.allFiltered.slice(0, 100);
            if (!rows.length) { toast('Belum ada data untuk disalin'); return; }
            try {
                await navigator.clipboard.writeText(JSON.stringify(rows, null, 2));
                toast('JSON disalin');
            } catch (_) {
                toast('Browser menolak akses clipboard');
            }
        });

        // Pengelolaan Konfigurasi Sistem & Koneksi Firebase RTDB (Non-Destruktif)
        syncConfigForm();
        if ($('#btnCfgSave')) {
            $('#btnCfgSave').addEventListener('click', () => {
                const rawUrl = ($('#cfgFirebase').value || '').trim();
                if (!Sec.isValidFirebaseUrl(rawUrl)) {
                    $('#cfgFirebase').classList.add('is-invalid');
                    $('#cfgStatus').textContent = 'URL Firebase tidak valid. Harus memakai https:// dan domain .firebaseio.com atau .firebasedatabase.app.';
                    return;
                }
                $('#cfgFirebase').classList.remove('is-invalid');
                const poll = Sec.validateNumber($('#cfgPoll').value, 1000, 60000, 2000);
                const off = Sec.validateNumber($('#cfgOffline').value, 5, 300, 15);
                const dry = Sec.validateNumber($('#cfgDry').value, 10, 90, 65);
                const wet = Sec.validateNumber($('#cfgWet').value, 15, 98, 78);
                if (dry >= wet) {
                    $('#cfgStatus').textContent = 'Batas Kering (%) harus lebih kecil daripada Batas Basah (%).';
                    return;
                }
                const S = Cfg.get();
                S.firebase = rawUrl;
                S.poll = poll;
                S.offlineSec = off;
                S.dry = dry;
                S.wet = wet;
                Cfg.save();
                FB.restart();
                GS.load();
                renderDashboard();
                $('#cfgStatus').textContent = 'Konfigurasi disimpan dan koneksi Firebase RTDB diperbarui tanpa mengubah data lama.';
                toast('Konfigurasi disimpan');
            });
        }
        if ($('#btnCfgTest')) {
            $('#btnCfgTest').addEventListener('click', async () => {
                const rawUrl = ($('#cfgFirebase').value || '').trim();
                $('#cfgStatus').textContent = 'Menguji koneksi ke Firebase RTDB…';
                const res = await FB.testConnection(rawUrl);
                if (res.ok) {
                    const lastInfo = res.latest ? ` · data terakhir ${fmtDayTime(res.latest.t)}` : '';
                    $('#cfgStatus').textContent = `Koneksi Firebase RTDB berhasil (${res.count} sampel terbaca${lastInfo}).`;
                    toast('Koneksi RTDB berhasil');
                } else {
                    $('#cfgStatus').textContent = `Gagal terhubung ke Firebase RTDB: ${res.error}`;
                    toast('Uji koneksi gagal');
                }
            });
        }
        if ($('#btnCfgSync')) {
            $('#btnCfgSync').addEventListener('click', async () => {
                $('#cfgStatus').textContent = 'Menyinkronkan data sensor, metadata pertumbuhan, dan dataset CNN…';
                FB.restart();
                await GS.load();
                renderDashboard();
                $('#cfgStatus').textContent = 'Sinkronisasi selesai.';
                toast('Data disinkronkan');
            });
        }
        if ($('#btnCfgReset')) {
            $('#btnCfgReset').addEventListener('click', () => {
                Cfg.reset();
                syncConfigForm();
                FB.restart();
                GS.load();
                renderDashboard();
                $('#cfgStatus').textContent = 'Pengaturan tampilan lokal dikembalikan ke default Kelompok 5 (data database tetap utuh).';
                toast('Pengaturan default diterapkan');
            });
        }
    }

    // ======================================================================
    // Kamera & CNN + CNN Dataset Manager
    // ======================================================================
    const cam = { running: false, mode: 'stream', timer: null, statusTimer: null, node: null };
    let dsQueue = [];
    let galPage = 1;

    function renderCamNodeMeta() {
        const n = cam.node;
        renderStatBar($('#camNodeMeta'), [
            ['Status Node', n ? (n.reachable ? 'ONLINE' : 'OFFLINE') : 'Belum terhubung'],
            ['Sinyal Wi-Fi', n && n.rssi !== null ? n.rssi + ' dBm' : '—'],
            ['Slot Terakhir', n && n.lastSlot ? n.lastSlot : '—'],
            ['Foto Terunggah', n && n.uploaded !== null ? String(n.uploaded) : '—']
        ]);
    }

    async function pollCamNodeStatus(host) {
        if (!host || location.protocol === 'https:') return;
        try {
            const ctrl = new AbortController();
            const tid = setTimeout(() => ctrl.abort(), 3500);
            const resp = await fetch(`http://${host}/status?t=${Date.now()}`, { signal: ctrl.signal });
            clearTimeout(tid);
            if (resp && resp.ok) {
                const d = await resp.json();
                cam.node = {
                    reachable: true,
                    rssi: Number.isFinite(Number(d.rssi)) ? Number(d.rssi) : null,
                    lastSlot: d.last_slot ? String(d.last_slot) : '',
                    uploaded: Number.isFinite(Number(d.uploaded)) ? Number(d.uploaded) : null
                };
            } else {
                cam.node = { reachable: false, rssi: null, lastSlot: '', uploaded: null };
            }
        } catch {
            cam.node = { reachable: false, rssi: null, lastSlot: '', uploaded: null };
        }
        renderCamNodeMeta();
    }

    function camShow(msg) {
        $('#camMsg').textContent = msg;
        $('#camMsg').hidden = false;
        $('#camImg').hidden = true;
    }

    function setCamError(msg) {
        const errEl = $('#camError');
        const ipEl = $('#camIp');
        if (errEl) {
            errEl.textContent = msg || '';
            errEl.hidden = !msg;
        }
        if (ipEl) ipEl.classList.toggle('is-invalid', Boolean(msg));
    }

    function camStop(msg) {
        cam.running = false;
        clearTimeout(cam.timer);
        clearInterval(cam.statusTimer);
        const img = $('#camImg');
        img.onload = null;
        img.onerror = null;
        img.removeAttribute('src');
        $('#camOff').hidden = true;
        $('#camGo').hidden = false;
        setBadge($('#camBadge'), 'Terputus', 'muted');
        camShow(msg || 'Masukkan IP kamera lalu tekan Hubungkan.');
        renderCamNodeMeta();
    }

    function camStart() {
        const raw = $('#camIp').value;
        const host = Sec.isValidCameraHost(raw);
        if (!host) {
            setBadge($('#camBadge'), 'IP tidak valid', 'err');
            setCamError('Format IP/host tidak valid. Gunakan contoh: 192.168.1.50 atau esp32cam.local');
            camShow('Alamat IP/host kamera tidak valid.');
            return;
        }
        setCamError('');
        const name = host.split(':')[0];
        const streamHost = host.includes(':') ? host : name + ':81';
        Cfg.get().camIp = host;
        Cfg.save();

        camStop();
        cam.running = true;
        $('#camOff').hidden = false;
        $('#camGo').hidden = true;
        setBadge($('#camBadge'), 'Menghubungkan…', 'warn');
        camShow('Menghubungkan ke kamera…');
        pollCamNodeStatus(host);
        cam.statusTimer = setInterval(() => pollCamNodeStatus(host), 15000);

        const img = $('#camImg');
        const fail = () => {
            if (!cam.running) return;
            cam.running = false;
            clearTimeout(cam.timer);
            $('#camOff').hidden = true;
            $('#camGo').hidden = false;
            setBadge($('#camBadge'), 'Gagal', 'err');
            camShow('Kamera tidak merespons. Pastikan ESP32-CAM menyala, satu jaringan Wi-Fi, dan hanya satu klien yang membuka stream.');
        };
        const live = () => {
            if (!cam.running) return;
            setBadge($('#camBadge'), 'Live', 'ok');
            $('#camMsg').hidden = true;
            img.hidden = false;
        };

        if (cam.mode === 'stream') {
            img.onload = live;
            img.onerror = fail;
            img.src = `http://${streamHost}/stream?t=${Date.now()}`;
        } else {
            const tick = () => {
                if (!cam.running) return;
                img.onload = () => { live(); cam.timer = setTimeout(tick, 3000); };
                img.onerror = fail;
                img.src = `http://${host}/capture?t=${Date.now()}`;
            };
            tick();
        }
    }

    function renderClasses() {
        const counts = GS.classCounts();
        const st = GS.widthStats();
        const total = GS.validRecords().length;
        const modelSt = GS.getModelStatus();
        const latestRec = GS.latest();
        const hasModel = modelSt.available;
        const statusLabel = modelSt.status || GS.CNN_SPEC.noModelLabel;

        renderStatBar($('#cnnSupportMeta'), [
            ['Citra Valid', String(total)],
            ['Rata-rata Lebar Daun', st.avg !== null ? st.avg.toFixed(1) + ' px' : '—'],
            ['Rentang Lebar Daun', st.min !== null ? st.min.toFixed(1) + '–' + st.max.toFixed(1) + ' px' : '—'],
            ['Status Model', statusLabel]
        ]);

        if ($('#cnnModelMeta')) {
            const verArch = hasModel
                ? `${modelSt.model_version} · ${modelSt.architecture} (${modelSt.format.toUpperCase()})`
                : '— (Belum dipasang)';
            const shapePrep = hasModel && modelSt.input_shape && modelSt.preprocessing
                ? `${modelSt.input_shape.join('×')} · ${modelSt.preprocessing.color_mode} · ${modelSt.preprocessing.normalization}`
                : '—';
            const evalTxt = hasModel && modelSt.evaluation
                ? `Akurasi ${(modelSt.evaluation.accuracy * 100).toFixed(1)}% · F1 ${(modelSt.evaluation.f1_macro * 100).toFixed(1)}%`
                : '—';
            let lastInferTxt = '—';
            if (latestRec && latestRec.cls && CLASSES[latestRec.cls] && latestRec.cls !== 'bukan_selada') {
                const cPct = latestRec.conf !== null && Number.isFinite(latestRec.conf) ? ` (${(latestRec.conf * 100).toFixed(1)}%)` : '';
                const cTime = latestRec.classifiedAt ? fmtDayTime(latestRec.classifiedAt) : fmtDayTime(latestRec.t);
                lastInferTxt = `${CLASSES[latestRec.cls].label}${cPct} · ${cTime}`;
            }
            renderStatBar($('#cnnModelMeta'), [
                ['Model & Format', hasModel ? `${modelSt.binary_file || 'model_selada_v2.h5'} (${modelSt.model_version})` : 'model_selada_v2.h5 (Belum Ada)'],
                ['Kelas Output', '3 Aktif · 1 BELUM TERSEDIA'],
                ['Input & Preprocessing', shapePrep],
                ['Inferensi Terakhir', lastInferTxt]
            ]);
        }

        const list = $('#classList');
        list.textContent = '';
        const rows = [
            ['siap_panen', 'Siap Panen', counts.siap_panen, 'ok', true],
            ['mendekati_panen', 'Mendekati Panen', counts.mendekati_panen, 'warn', true],
            ['masa_pertumbuhan', 'Masa Pertumbuhan', counts.masa_pertumbuhan, 'info', true],
            ['bukan_selada', 'Bukan Selada', 0, 'muted', false]
        ];
        rows.forEach(r => {
            const [k, lbl, count, tone, isActive] = r;
            const pct = (isActive && total) ? Math.round((count / total) * 100) : 0;
            const clsStat = st.byClass && st.byClass[k] ? st.byClass[k] : null;
            const widthInfo = (isActive && clsStat && clsStat.avg !== null) ? ` · rata-rata ${clsStat.avg.toFixed(1)} px` : '';
            const row = document.createElement('div');
            row.className = 'class-row' + (isActive ? '' : ' is-unavailable');
            const top = document.createElement('div');
            top.className = 'class-top';

            const nameWrap = document.createElement('span');
            nameWrap.style.display = 'inline-flex';
            nameWrap.style.alignItems = 'center';
            nameWrap.style.gap = '6px';
            const name = document.createElement('span');
            name.textContent = lbl;
            nameWrap.appendChild(name);

            const badge = document.createElement('span');
            badge.className = 'badge ' + (isActive ? (tone === 'ok' ? 'ok' : (tone === 'warn' ? 'warn' : 'info')) : 'muted');
            badge.style.fontSize = '0.66rem';
            badge.style.padding = '1px 5px';
            badge.textContent = isActive ? 'AKTIF' : 'BELUM TERSEDIA';
            nameWrap.appendChild(badge);

            const val = document.createElement('b');
            if (isActive) {
                val.textContent = `${count} (${pct}%)${widthInfo}`;
            } else {
                val.textContent = 'Elemen UI informatif (belum tersedia pada model_selada_v2.h5)';
                val.style.color = 'var(--text-muted)';
                val.style.fontWeight = '400';
                val.style.fontSize = '.78rem';
            }

            top.appendChild(nameWrap);
            top.appendChild(val);
            const bar = document.createElement('div');
            bar.className = 'bar';
            const fill = document.createElement('span');
            fill.className = isActive ? (tone === 'ok' ? '' : tone) : 'muted';
            fill.style.width = pct + '%';
            if (!isActive) fill.style.opacity = '0';
            bar.appendChild(fill);
            row.appendChild(top);
            row.appendChild(bar);
            list.appendChild(row);
        });

        const badgeTone = !hasModel ? 'muted' : (modelSt.is_test_model ? 'warn' : 'ok');
        const badgeText = hasModel
            ? (modelSt.is_test_model ? `MODEL PENGUJIAN · ${modelSt.model_version}` : `AKTIF · ${modelSt.model_version}`)
            : statusLabel;
        setBadge($('#cnnBadge'), badgeText, badgeTone);
        $('#cnnHint').textContent = hasModel
            ? `Model Colab ${modelSt.model_version} (${modelSt.architecture || 'model_selada_v2.h5'}) aktif${modelSt.is_test_model ? ' [MODEL PENGUJIAN TEKNIS - BUKAN MODEL PRODUKSI]' : ''}. 3 kelas output terhubung ke inferensi nyata; kelas Bukan Selada berstatus BELUM TERSEDIA sebagai elemen informatif UI.`
            : (total
                ? `${total} citra valid dengan pengukuran lebar daun tercatat. Status model saat ini: ${statusLabel} (tempatkan berkas model_selada_v2.h5 di direktori models/).`
                : `Belum ada citra valid. Status model saat ini: ${statusLabel}.`);
    }

    function renderDatasetStats() {
        const ds = GS.datasetClassStats();
        const split = GS.buildTrainValTestSplit();
        setBadge($('#dsTotalBadge'), `${ds.total} Gambar Dataset`, ds.total > 0 ? 'info' : 'muted');
        renderStatBar($('#dsStatBar'), [
            ['Total Dataset', String(ds.total)],
            ['Split Training (70%)', String(split.counts.train)],
            ['Split Validation (15%)', String(split.counts.validation)],
            ['Split Testing (15%)', String(split.counts.test)]
        ]);

        const list = $('#dsClassList');
        if (!list) return;
        list.textContent = '';
        ['siap_panen', 'mendekati_panen', 'masa_pertumbuhan', 'bukan_selada'].forEach(k => {
            const c = ds.byClass[k];
            const isInactiveInModel = k === 'bukan_selada';
            const widthInfo = c.avgWidth !== null ? ` · rata-rata lebar ${c.avgWidth.toFixed(1)} px` : '';
            const row = document.createElement('div');
            row.className = 'class-row';
            const top = document.createElement('div');
            top.className = 'class-top';

            const nameWrap = document.createElement('span');
            nameWrap.style.display = 'inline-flex';
            nameWrap.style.alignItems = 'center';
            nameWrap.style.gap = '6px';
            const name = document.createElement('span');
            name.textContent = c.label;
            nameWrap.appendChild(name);

            if (isInactiveInModel) {
                const noteBadge = document.createElement('span');
                noteBadge.className = 'badge muted';
                noteBadge.style.fontSize = '0.66rem';
                noteBadge.style.padding = '1px 5px';
                noteBadge.textContent = 'Inference: BELUM TERSEDIA';
                nameWrap.appendChild(noteBadge);
            }

            const val = document.createElement('b');
            val.textContent = `${c.count} (${c.pct}%)${widthInfo}`;
            top.appendChild(nameWrap);
            top.appendChild(val);
            const bar = document.createElement('div');
            bar.className = 'bar';
            const fill = document.createElement('span');
            fill.className = c.tone === 'ok' ? '' : c.tone;
            fill.style.width = c.pct + '%';
            bar.appendChild(fill);
            row.appendChild(top);
            row.appendChild(bar);
            list.appendChild(row);
        });
    }

    function revalidateQueue() {
        const seen = new Set();
        dsQueue.forEach(item => {
            item.validation = GS.validateCandidateFile(item, seen);
        });
    }

    function renderPreviewQueue() {
        revalidateQueue();
        const listEl = $('#dsPreviewList');
        const barEl = $('#dsQueueBar');
        const cntEl = $('#dsQueueCount');
        const btnUp = $('#dsBtnUpload');
        if (!listEl || !barEl) return;

        listEl.textContent = '';
        if (!dsQueue.length) {
            barEl.hidden = true;
            return;
        }
        barEl.hidden = false;
        const validCount = dsQueue.filter(it => it.validation && it.validation.ok).length;
        cntEl.textContent = `${dsQueue.length} file dipilih (${validCount} siap diunggah, ${dsQueue.length - validCount} ditolak)`;
        if (btnUp) btnUp.disabled = validCount === 0;

        dsQueue.forEach((item, idx) => {
            const card = document.createElement('div');
            card.className = 'ds-prev-card';

            const thumb = document.createElement('div');
            thumb.className = 'ds-prev-thumb';
            if (item.previewUrl && !item.corrupt) {
                const im = document.createElement('img');
                im.src = item.previewUrl;
                im.alt = item.fileName;
                thumb.appendChild(im);
            } else {
                thumb.textContent = 'Rusak';
            }

            const info = document.createElement('div');
            info.className = 'ds-prev-info';
            const title = document.createElement('b');
            title.textContent = item.fileName;
            const meta = document.createElement('small');
            const kb = (item.fileSize / 1024).toFixed(1) + ' KB';
            const dim = item.width && item.height ? ` · ${item.width}×${item.height}px` : '';
            const hashStr = item.validation && item.validation.fnv1a ? ` · ${item.validation.fnv1a}` : '';
            meta.textContent = `${kb}${dim}${hashStr}`;

            const stBadge = document.createElement('span');
            if (item.validation && item.validation.ok) {
                setBadge(stBadge, `Siap (${item.validation.format})`, 'ok');
            } else {
                setBadge(stBadge, item.validation ? item.validation.error : 'Tidak valid', 'err');
            }

            const act = document.createElement('div');
            act.className = 'ds-prev-actions';
            const sel = document.createElement('select');
            [
                ['masa_pertumbuhan', 'Masa Pertumbuhan'],
                ['mendekati_panen', 'Mendekati Panen'],
                ['siap_panen', 'Siap Panen'],
                ['bukan_selada', 'Bukan Selada']
            ].forEach(opt => {
                const o = document.createElement('option');
                o.value = opt[0];
                o.textContent = opt[1];
                if (item.label === opt[0]) o.selected = true;
                sel.appendChild(o);
            });
            sel.addEventListener('change', e => {
                item.label = e.target.value;
                renderPreviewQueue();
            });

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'btn sm danger';
            delBtn.textContent = 'Batal';
            delBtn.addEventListener('click', () => {
                if (item.previewUrl && typeof URL.revokeObjectURL === 'function') {
                    try { URL.revokeObjectURL(item.previewUrl); } catch {}
                }
                dsQueue.splice(idx, 1);
                renderPreviewQueue();
            });

            act.appendChild(sel);
            act.appendChild(delBtn);

            info.appendChild(title);
            info.appendChild(meta);
            info.appendChild(stBadge);
            info.appendChild(act);

            card.appendChild(thumb);
            card.appendChild(info);
            listEl.appendChild(card);
        });
    }

    function readImageDimensions(blobUrl) {
        return new Promise(resolve => {
            if (typeof Image === 'undefined' || !blobUrl) {
                resolve({ width: 200, height: 200, corrupt: false });
                return;
            }
            const img = new Image();
            img.onload = () => resolve({ width: img.naturalWidth || img.width || 200, height: img.naturalHeight || img.height || 200, corrupt: false });
            img.onerror = () => resolve({ width: 0, height: 0, corrupt: true });
            img.src = blobUrl;
        });
    }

    async function handleFilesSelected(fileList) {
        const files = Array.from(fileList || []);
        if (!files.length) return;
        const defaultLabel = $('#dsLabelSelect') ? $('#dsLabelSelect').value : 'masa_pertumbuhan';
        const hstVal = $('#dsHstInput') && $('#dsHstInput').value ? Number($('#dsHstInput').value) : null;
        const notesVal = $('#dsNotesInput') ? $('#dsNotesInput').value : '';

        for (const f of files) {
            let bytes = new Uint8Array(0);
            try {
                if (typeof f.arrayBuffer === 'function') {
                    const ab = await f.arrayBuffer();
                    bytes = new Uint8Array(ab);
                } else if (f.bytes instanceof Uint8Array) {
                    bytes = f.bytes;
                }
            } catch {
                bytes = new Uint8Array(0);
            }
            const fmtCheck = GS.detectImageFormat(bytes);
            let previewUrl = '';
            let dim = { width: Number(f.width) || 200, height: Number(f.height) || 200, corrupt: Boolean(f.corrupt) };
            if (fmtCheck.ok && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && typeof Blob !== 'undefined') {
                try {
                    previewUrl = URL.createObjectURL(new Blob([bytes], { type: fmtCheck.contentType }));
                    if (!f.width && !f.height && typeof window !== 'undefined' && window.Image) {
                        dim = await readImageDimensions(previewUrl);
                    }
                } catch {
                    previewUrl = '';
                }
            } else if (!fmtCheck.ok && bytes.length >= 12) {
                dim.corrupt = Boolean(f.corrupt);
            }
            dsQueue.push({
                fileName: f.name || f.fileName || 'gambar.jpg',
                fileSize: bytes.length,
                bytes,
                width: dim.width,
                height: dim.height,
                corrupt: dim.corrupt,
                label: f.label || defaultLabel,
                hst: f.hst !== undefined ? f.hst : hstVal,
                notes: f.notes !== undefined ? f.notes : notesVal,
                previewUrl
            });
        }
        renderPreviewQueue();
    }

    async function runDatasetUpload() {
        revalidateQueue();
        const validItems = dsQueue.filter(it => it.validation && it.validation.ok);
        if (!validItems.length) {
            $('#dsUploadMsg').textContent = 'Tidak ada file valid untuk diunggah. Periksa status validasi pada antrean.';
            return;
        }
        const token = $('#dsTokenInput') ? $('#dsTokenInput').value.trim() : '';
        if (token && typeof sessionStorage !== 'undefined') {
            try { sessionStorage.setItem('selada_capture_token', token); } catch {}
        }

        const progWrap = $('#dsProgressWrap');
        const progBar = $('#dsProgressBar');
        const progTxt = $('#dsProgressText');
        const btnUp = $('#dsBtnUpload');
        if (progWrap) progWrap.hidden = false;
        if (btnUp) btnUp.disabled = true;

        const batchRes = await GS.uploadDatasetBatch(validItems, {
            token,
            onProgress(p) {
                if (progBar) progBar.style.width = p.percent + '%';
                if (progTxt) progTxt.textContent = `Mengunggah (${p.completed}/${p.total}): ${p.fileName} (${p.percent}%)`;
            }
        });

        // Hapus item yang berhasil diunggah dari antrean
        const uploadedHashes = new Set(
            batchRes.results.filter(r => r.ok && r.record).map(r => r.record.fnv1a)
        );
        dsQueue = dsQueue.filter(it => {
            if (it.validation && uploadedHashes.has(it.validation.fnv1a)) {
                if (it.previewUrl && typeof URL.revokeObjectURL === 'function') {
                    try { URL.revokeObjectURL(it.previewUrl); } catch {}
                }
                return false;
            }
            return true;
        });

        renderPreviewQueue();
        renderDatasetStats();
        renderGallery();

        const summary = `Upload selesai: ${batchRes.successCount} berhasil, ${batchRes.failCount} gagal` +
            (batchRes.dupCount ? ` (${batchRes.dupCount} duplikat ditolak)` : '') + '.';
        if ($('#dsUploadMsg')) $('#dsUploadMsg').textContent = summary;
        toast(summary);
    }

    function exportDatasetSplit() {
        const split = GS.buildTrainValTestSplit();
        if (!split.total) {
            toast('Belum ada gambar di dataset CNN untuk diekspor');
            return;
        }
        const blob = new Blob([JSON.stringify(split, null, 2)], { type: 'application/json;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'cnn_dataset_split_kelompok5.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast(`Manifest split diekspor (${split.counts.train} train / ${split.counts.validation} val / ${split.counts.test} test)`);
    }

    function renderGallery() {
        const g = $('#gallery');
        g.textContent = '';
        const filter = $('#galFilter') ? $('#galFilter').value : 'all';
        const source = $('#galSource') ? $('#galSource').value : 'all';
        const search = $('#galSearch') ? $('#galSearch').value : '';
        const q = GS.queryGallery({ label: filter, source, search, page: galPage, per: 8 });
        galPage = q.page;

        if ($('#galPageInfo')) $('#galPageInfo').textContent = `Halaman ${q.page} dari ${q.totalPages} (${q.total} gambar)`;
        if ($('#galPrev')) $('#galPrev').disabled = q.page <= 1;
        if ($('#galNext')) $('#galNext').disabled = q.page >= q.totalPages;

        if (!q.rows.length) {
            const p = document.createElement('p');
            p.className = 'gallery-empty';
            p.textContent = (GS.validRecords().length || GS.datasetRecords().length)
                ? 'Tidak ada citra yang cocok dengan filter atau pencarian.'
                : 'NO DATA · belum ada citra dataset maupun hasil capture.';
            g.appendChild(p);
            return;
        }

        q.rows.forEach(r => {
            const url = r.overlay || r.image || r.mask;
            const card = document.createElement('div');
            card.className = 'shot';

            const box = document.createElement(url ? 'a' : 'div');
            box.className = 'shot-img';
            if (url) {
                box.href = r.image || url;
                box.target = '_blank';
                box.rel = 'noopener noreferrer';
                const im = document.createElement('img');
                im.loading = 'lazy';
                im.alt = 'Citra ' + fmtDayTime(r.t);
                im.src = url;
                box.appendChild(im);
            } else {
                box.textContent = 'Tanpa pratinjau';
            }

            const meta = document.createElement('div');
            meta.className = 'shot-meta';
            const w = document.createElement('b');
            w.textContent = r.width !== null ? `Lebar Daun: ${r.width.toFixed(1)} px` : (r.label === 'bukan_selada' ? 'Bukan Selada (0 px)' : 'Lebar Daun: —');

            const fInfo = document.createElement('span');
            fInfo.textContent = r.fileName + (r.fnv1a ? ` · #${r.fnv1a}` : '');

            const t = document.createElement('span');
            t.textContent = (r.hst ? `HST ${r.hst} · ` : '') + fmtDayTime(r.t);

            const badge = document.createElement('span');
            const cKey = r.label || r.cls;
            const c = cKey ? CLASSES[cKey] : null;
            const confStr = r.conf !== null && r.conf !== undefined && Number.isFinite(r.conf) ? ` (${(r.conf * 100).toFixed(1)}%)` : '';
            if (r.isDataset) {
                setBadge(badge, c ? `Label: ${c.label}` : 'Belum dilabeli', c ? c.tone : 'muted');
            } else {
                setBadge(badge, c ? `${c.label}${confStr}` : 'CNN: ' + (r.cnnStatus || GS.CNN_SPEC.noModelLabel), c ? c.tone : 'muted');
            }

            meta.appendChild(w);
            meta.appendChild(fInfo);
            meta.appendChild(t);
            meta.appendChild(badge);

            if (r.cls && CLASSES[r.cls]) {
                const inferEl = document.createElement('span');
                inferEl.className = 'hint';
                const vTxt = r.modelVersion ? ` · ${r.modelVersion}` : '';
                const cAt = r.classifiedAt ? ` · ${fmtClock(r.classifiedAt)}` : '';
                inferEl.textContent = `Prediksi CNN: ${CLASSES[r.cls].label}${confStr}${vTxt}${cAt}`;
                meta.appendChild(inferEl);
            }

            if (r.notes) {
                const nEl = document.createElement('span');
                nEl.className = 'hint';
                nEl.textContent = r.notes;
                meta.appendChild(nEl);
            }

            // Kontrol ubah label & hapus dengan konfirmasi untuk item dataset CNN
            if (r.isDataset) {
                const actWrap = document.createElement('div');
                actWrap.className = 'shot-actions';
                const row = document.createElement('div');
                row.className = 'shot-actions-row';

                const sel = document.createElement('select');
                sel.setAttribute('aria-label', 'Ubah label kelas CNN');
                [
                    ['masa_pertumbuhan', 'Masa Pertumbuhan'],
                    ['mendekati_panen', 'Mendekati Panen'],
                    ['siap_panen', 'Siap Panen'],
                    ['bukan_selada', 'Bukan Selada']
                ].forEach(opt => {
                    const o = document.createElement('option');
                    o.value = opt[0];
                    o.textContent = opt[1];
                    if (r.label === opt[0]) o.selected = true;
                    sel.appendChild(o);
                });

                const confirmBox = document.createElement('div');
                confirmBox.className = 'shot-confirm';
                confirmBox.hidden = true;
                const confText = document.createElement('span');
                confText.textContent = 'Hapus permanen?';
                const confBtns = document.createElement('div');
                confBtns.className = 'controls';
                const yesBtn = document.createElement('button');
                yesBtn.type = 'button';
                yesBtn.className = 'btn sm danger';
                yesBtn.textContent = 'Ya, Hapus';
                const noBtn = document.createElement('button');
                noBtn.type = 'button';
                noBtn.className = 'btn sm';
                noBtn.textContent = 'Batal';
                confBtns.appendChild(yesBtn);
                confBtns.appendChild(noBtn);
                confirmBox.appendChild(confText);
                confirmBox.appendChild(confBtns);

                sel.addEventListener('change', async e => {
                    const nextLbl = e.target.value;
                    const tok = $('#dsTokenInput') ? $('#dsTokenInput').value.trim() : '';
                    const res = await GS.updateDatasetLabel(r.id, nextLbl, undefined, { token: tok });
                    if (res.ok) {
                        renderDatasetStats();
                        renderGallery();
                        toast(`Label diperbarui ke ${CLASSES[nextLbl].label}`);
                    } else {
                        toast(res.error || 'Gagal mengubah label');
                    }
                });

                const delBtn = document.createElement('button');
                delBtn.type = 'button';
                delBtn.className = 'btn sm danger';
                delBtn.textContent = 'Hapus';
                delBtn.addEventListener('click', () => {
                    confirmBox.hidden = false;
                });
                noBtn.addEventListener('click', () => {
                    confirmBox.hidden = true;
                });
                yesBtn.addEventListener('click', async () => {
                    const tok = $('#dsTokenInput') ? $('#dsTokenInput').value.trim() : '';
                    const res = await GS.deleteDatasetRecord(r.id, { token: tok });
                    if (res.ok) {
                        renderDatasetStats();
                        renderGallery();
                        toast('Gambar dihapus dari dataset');
                    } else {
                        toast(res.error || 'Gagal menghapus gambar');
                    }
                });

                row.appendChild(sel);
                row.appendChild(delBtn);
                actWrap.appendChild(row);
                actWrap.appendChild(confirmBox);
                meta.appendChild(actWrap);
            }

            card.appendChild(box);
            card.appendChild(meta);
            g.appendChild(card);
        });
    }

    function renderCamera() {
        renderCamNodeMeta();
        renderClasses();
        renderDatasetStats();
        renderPreviewQueue();
        renderGallery();
    }

    function bindCamera() {
        $('#camIp').value = Cfg.get().camIp || '';
        setSeg($('#segCam'), cam.mode);
        if (location.protocol === 'https:') $('#camHint').hidden = false;
        $('#camGo').addEventListener('click', camStart);
        $('#camOff').addEventListener('click', () => camStop());
        $('#camIp').addEventListener('input', () => setCamError(''));
        $('#camIp').addEventListener('keydown', e => { if (e.key === 'Enter') camStart(); });
        $('#segCam').addEventListener('click', e => {
            const b = e.target.closest('button');
            if (!b) return;
            cam.mode = b.dataset.v;
            setSeg($('#segCam'), cam.mode);
            if (cam.running) camStart();
        });
        if ($('#camSnap')) {
            $('#camSnap').addEventListener('click', () => {
                cam.mode = 'foto';
                setSeg($('#segCam'), cam.mode);
                camStart();
            });
        }
        if ($('#camFull')) {
            $('#camFull').addEventListener('click', () => {
                const v = $('#camView');
                if (v && typeof v.requestFullscreen === 'function') {
                    v.requestFullscreen().catch(() => {});
                }
            });
        }

        // CNN Dataset Manager bindings
        if ($('#dsTokenInput') && typeof sessionStorage !== 'undefined') {
            try {
                const savedTok = sessionStorage.getItem('selada_capture_token');
                if (savedTok) $('#dsTokenInput').value = savedTok;
            } catch {}
        }
        if ($('#dsFileInput')) {
            $('#dsFileInput').addEventListener('change', async e => {
                await handleFilesSelected(e.target.files);
                e.target.value = '';
            });
        }
        if ($('#dsDropzone')) {
            const dz = $('#dsDropzone');
            dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
            dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
            dz.addEventListener('drop', async e => {
                e.preventDefault();
                dz.classList.remove('dragover');
                if (e.dataTransfer && e.dataTransfer.files) {
                    await handleFilesSelected(e.dataTransfer.files);
                }
            });
        }
        if ($('#dsBtnClearQueue')) {
            $('#dsBtnClearQueue').addEventListener('click', () => {
                dsQueue.forEach(it => {
                    if (it.previewUrl && typeof URL.revokeObjectURL === 'function') {
                        try { URL.revokeObjectURL(it.previewUrl); } catch {}
                    }
                });
                dsQueue = [];
                renderPreviewQueue();
            });
        }
        if ($('#dsBtnUpload')) $('#dsBtnUpload').addEventListener('click', runDatasetUpload);
        if ($('#dsBtnExportSplit')) $('#dsBtnExportSplit').addEventListener('click', exportDatasetSplit);

        // Registrasi & validasi paket model hasil ekspor Google Colab
        if ($('#btnCnnReloadModel')) {
            $('#btnCnnReloadModel').addEventListener('click', async () => {
                if ($('#cnnModelMsg')) $('#cnnModelMsg').textContent = 'Memeriksa berkas model di direktori models/…';
                const st = await GS.loadModelFromModelsDir();
                renderClasses();
                renderKPIs();
                renderGallery();
                if (st.available) {
                    const tag = st.is_test_model ? ' [MODEL PENGUJIAN]' : '';
                    if ($('#cnnModelMsg')) $('#cnnModelMsg').textContent = `Model ${st.model_version} (${st.architecture}) aktif dari models/${tag}.`;
                    toast(`Model ${st.model_version} aktif`);
                } else {
                    if ($('#cnnModelMsg')) $('#cnnModelMsg').textContent = st.last_error
                        ? `Validasi models/ ditolak: ${st.last_error}`
                        : 'Status: BELUM ADA MODEL di direktori models/.';
                    toast('BELUM ADA MODEL di models/');
                }
            });
        }
        if ($('#btnCnnValidateModel')) {
            $('#btnCnnValidateModel').addEventListener('click', async () => {
                const inputEl = $('#cnnModelFilesInput');
                const files = inputEl && inputEl.files ? Array.from(inputEl.files) : [];
                if (!files.length) {
                    if ($('#cnnModelMsg')) $('#cnnModelMsg').textContent = 'Pilih berkas hasil ekspor Colab (model.tflite/model.keras, class_names.json, metadata.json, evaluation.json) terlebih dahulu.';
                    toast('Pilih berkas model Colab terlebih dahulu');
                    return;
                }
                const bundle = {};
                for (const f of files) {
                    const fname = (f.name || '').trim();
                    if (typeof f.arrayBuffer === 'function') {
                        const ab = await f.arrayBuffer();
                        bundle[fname] = new Uint8Array(ab);
                    } else if (f.bytes instanceof Uint8Array) {
                        bundle[fname] = f.bytes;
                    }
                }
                const res = GS.registerOrImportModel(bundle);
                renderClasses();
                renderKPIs();
                renderGallery();
                if (res.ok) {
                    const m = res.activeModel;
                    const testNotice = m.is_test_model ? ' (MODEL PENGUJIAN - BUKAN MODEL PRODUKSI)' : '';
                    if ($('#cnnModelMsg')) {
                        $('#cnnModelMsg').textContent = `Validasi berhasil: ${m.model_version} · ${m.architecture} · Input ${m.input_shape.join('×')} · Normalisasi ${m.preprocessing.normalization}${testNotice}.`;
                    }
                    toast(`Model ${m.model_version} diaktifkan`);
                } else {
                    const rollbackNote = res.rolledBackToPrevious && res.activeModel && res.activeModel.available
                        ? ` Model aktif sebelumnya (${res.activeModel.model_version}) tetap dipertahankan.`
                        : ' Status tetap BELUM ADA MODEL.';
                    if ($('#cnnModelMsg')) {
                        $('#cnnModelMsg').textContent = `Registrasi model ditolak (${res.stage}): ${res.error}.${rollbackNote}`;
                    }
                    toast('Validasi model gagal');
                }
            });
        }

        const resetGalAndRender = () => { galPage = 1; renderGallery(); };
        if ($('#galFilter')) $('#galFilter').addEventListener('change', resetGalAndRender);
        if ($('#galSource')) $('#galSource').addEventListener('change', resetGalAndRender);
        if ($('#galSearch')) $('#galSearch').addEventListener('input', resetGalAndRender);
        if ($('#galPrev')) $('#galPrev').addEventListener('click', () => { galPage = Math.max(1, galPage - 1); renderGallery(); });
        if ($('#galNext')) $('#galNext').addEventListener('click', () => { galPage += 1; renderGallery(); });
    }

    // ======================================================================
    // Prediksi LSTM (satu-satunya tempat data prediksi tampil)
    // ======================================================================
    let fcToken = 0;
    let fcSig = '';

    function renderForecastCards(list) {
        const wrap = $('#fcCards');
        wrap.textContent = '';
        for (let i = 0; i < FC.HORIZON; i++) {
            const d = list ? list[i] : null;
            const card = document.createElement('div');
            card.className = 'fc';
            const title = document.createElement('small');
            title.textContent = d ? `Hari +${i + 1} · ${fmtDay(d.t)}` : `Hari +${i + 1}`;
            const val = document.createElement('b');
            val.textContent = d ? d.width.toFixed(1) + ' px' : '—';
            const stage = document.createElement('span');
            const label = d && d.stage !== null ? AI.stageLabel(d.stage) : null;
            const key = label ? Object.keys(CLASSES).find(k => CLASSES[k].ord === d.stage) : null;
            setBadge(stage, label || 'Menunggu', key ? CLASSES[key].tone : 'muted');
            card.appendChild(title);
            card.appendChild(val);
            card.appendChild(stage);
            wrap.appendChild(card);
        }
    }

    function setProgress(have, text) {
        const pct = Math.min(100, Math.round((have / FC.MIN_DAYS) * 100));
        $('#fcProgress').style.width = pct + '%';
        $('#fcProgressText').textContent = text;
    }

    function drawForecastChart(res, daily) {
        const host = $('#chForecast');
        if (!res || !res.ok) {
            const pts = daily.map(d => [d.t, d.width]);
            drawChart(host, {
                label: 'Riwayat lebar daun harian',
                series: [{ label: 'Lebar daun', color: 'var(--accent)', pts: pts }],
                floor0: true, unit: ' px', xFmt: fmtDay,
                empty: 'NO DATA · belum ada deret harian lebar daun',
                readout: $('#roForecast')
            });
            return;
        }
        const hist = res.history.map(d => [d.t, d.width]);
        const lastH = hist[hist.length - 1];
        const fut = [lastH].concat(res.forecast.map(d => [d.t, d.width]));
        drawChart(host, {
            label: 'Riwayat dan prediksi lebar daun',
            series: [
                { label: 'Riwayat', color: 'var(--accent)', pts: hist },
                { label: 'Prediksi', color: 'var(--amber)', pts: fut, dash: true }
            ],
            floor0: true, unit: ' px', xFmt: fmtDay,
            readout: $('#roForecast'),
            defaultReadout: 'Garis solid = observasi nyata · garis putus-putus = prediksi LSTM'
        });
    }

    async function renderForecast(force) {
        const daily = GS.daily();
        const sig = JSON.stringify(daily.map(d => [d.day, Math.round(d.width * 10), d.stage]));
        const have = daily.length;
        const btnRetrain = $('#fcRetrain');

        if (have < FC.MIN_DAYS) {
            fcToken++;
            fcSig = '';
            lastForecast = null;
            if (btnRetrain) btnRetrain.disabled = true;
            setBadge($('#fcBadge'), 'Menunggu data', 'muted');
            setProgress(have, `Data lebar daun harian: ${have} dari minimal ${FC.MIN_DAYS} hari.`);
            $('#fcProgressWrap').hidden = false;
            renderForecastCards(null);
            drawForecastChart(null, daily);
            $('#fcMeta').textContent = 'Prediksi dihitung otomatis begitu data harian nyata mencukupi. Data prediksi tidak pernah digabungkan ke histori observasi.';
            return;
        }

        if (!force && sig === fcSig && lastForecast && lastForecast.ok) {
            if (btnRetrain) btnRetrain.disabled = false;
            drawForecastChart(lastForecast, daily);
            return;
        }

        const token = ++fcToken;
        fcSig = sig;
        if (btnRetrain) btnRetrain.disabled = true;
        setBadge($('#fcBadge'), 'Melatih model…', 'warn');
        setProgress(FC.MIN_DAYS, 'Melatih LSTM di browser dari histori nyata, tunggu beberapa detik…');
        $('#fcProgressWrap').hidden = false;
        renderForecastCards(null);
        drawForecastChart(null, daily);

        try {
            const res = await FC.run(daily);
            if (token !== fcToken) return;
            lastForecast = res;
            if (btnRetrain) btnRetrain.disabled = false;
            $('#fcProgressWrap').hidden = true;
            setBadge($('#fcBadge'), 'Siap', 'ok');
            renderForecastCards(res.forecast);
            drawForecastChart(res, daily);
            $('#fcMeta').textContent =
                `Dilatih dari ${res.history.length} hari observasi nyata (${res.samples} sampel, tanpa interpolasi sintetis) · galat latih MSE ${res.loss.toFixed(4)} · ` +
                (res.useStage ? 'masukan: lebar daun + tahap CNN.' : 'masukan: lebar daun (kelas CNN belum lengkap).');
        } catch (err) {
            if (token !== fcToken) return;
            fcSig = '';
            lastForecast = null;
            if (btnRetrain) btnRetrain.disabled = false;
            setBadge($('#fcBadge'), 'Gagal', 'err');
            $('#fcProgressWrap').hidden = true;
            $('#fcMeta').textContent = 'Prediksi gagal: ' + (err && err.message ? err.message : 'kesalahan tidak diketahui');
        }
    }

    function bindForecast() {
        const btn = $('#fcRetrain');
        if (btn) {
            btn.addEventListener('click', () => {
                if (GS.daily().length >= FC.MIN_DAYS) renderForecast(true);
            });
        }
    }

    // ======================================================================
    // AI Assistant
    // ======================================================================
    function aiContext() {
        const leaf = GS.latest();
        return { sensor: DS.getLatest(), leaf: leaf, forecast: lastForecast };
    }

    async function aiAsk(text) {
        const q = String(text || '').trim();
        if (!q) return;
        // Pastikan prediksi sudah dihitung bila ditanyakan dan datanya cukup.
        if (/prediksi|lstm|ramal|besok/i.test(q) && !lastForecast && GS.daily().length >= FC.MIN_DAYS) {
            await renderForecast(false);
        }
        await AI.query(q, aiContext());
        AI.render($('#aiThread'));
    }

    function bindAI() {
        AI.render($('#aiThread'));
        $('#aiChips').addEventListener('click', e => {
            const b = e.target.closest('.chip');
            if (b) aiAsk(b.dataset.q);
        });
        $('#aiDiag').addEventListener('click', () => aiAsk('Analisis kondisi real-time'));
        $('#aiForm').addEventListener('submit', e => {
            e.preventDefault();
            const input = $('#aiInput');
            const v = input.value;
            input.value = '';
            aiAsk(v);
        });
    }

    // ======================================================================
    // Navigasi
    // ======================================================================
    function renderPage(id) {
        if (id === 'dashboard') renderDashboard();
        else if (id === 'kamera') renderCamera();
        else if (id === 'prediksi') renderForecast(false);
        else if (id === 'ai') AI.render($('#aiThread'));
    }

    function showPage(id) {
        if (!PAGES[id]) id = 'dashboard';
        activePage = id;
        Object.keys(PAGES).forEach(k => { $('#p-' + k).hidden = k !== id; });
        $$('.nav-link').forEach(a => {
            const on = a.dataset.page === id;
            a.classList.toggle('active', on);
            if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
        });
        $('#ptitle').textContent = PAGES[id].title;
        $('#psub').textContent = PAGES[id].sub;
        document.title = PAGES[id].title + ' · Selada Keriting Monitor';
        renderPage(id);
        window.scrollTo(0, 0);
    }

    function route() {
        showPage((location.hash || '#dashboard').replace(/^#/, ''));
    }

    // ======================================================================
    // Inisialisasi
    // ======================================================================
    function init() {
        bindDashboard();
        bindCamera();
        bindForecast();
        bindAI();

        DS.onChange(() => {
            if (activePage === 'dashboard') { renderKPIs(); renderTeleChart(); renderLog(); }
        });
        GS.onChange(() => {
            if (activePage === 'dashboard') { renderKPIs(); renderLeafChart(); }
            else if (activePage === 'kamera') renderCamera();
            else if (activePage === 'prediksi') renderForecast(false);
        });

        let resizeTimer = null;
        const rerender = () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                if (activePage === 'dashboard') { renderTeleChart(); renderLeafChart(); }
                else if (activePage === 'prediksi' && lastForecast) drawForecastChart(lastForecast, GS.daily());
                else if (activePage === 'prediksi') drawForecastChart(null, GS.daily());
            }, 150);
        };
        // Gambar ulang grafik tiap kali lebar kontainernya berubah (rotasi, tampil dari tersembunyi, dsb.)
        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(rerender);
            ['#chTele', '#chLeaf', '#chForecast'].forEach(s => ro.observe($(s)));
        } else {
            window.addEventListener('resize', rerender);
        }
        window.addEventListener('hashchange', route);

        route();
        FB.subscribeStatus(onConnStatus);
        FB.start();
        GS.start();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
