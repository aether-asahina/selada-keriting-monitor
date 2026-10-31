/**
 * ==============================================================================
 * MODULE: DASHBOARD CONTROLLER & APPLICATION ORCHESTRATOR
 * Hardened for: DOM XSS Defense, SCADA Pump Command vs Actual Relay Feedback,
 * Real Physiological GDD (Growing Degree Days), ESP32-CAM SSRF & Resource Safety
 * ==============================================================================
 */

(function (window) {
    'use strict';

    const $ = (s, r) => (r || document).querySelector(s);
    const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));

    const Sec = window.SecurityUtils || {
        escapeHTML: s => String(s || ''),
        sanitizeHTML: s => String(s || ''),
        isValidCameraHost: raw => String(raw || '').trim()
    };

    // Nav Pages Definition (7 Tabs)
    const PAGES = [
        { id: 'ringkasan', name: 'Ringkasan', sub: 'Kondisi mikroklimat kebun selada saat ini', ic: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>' },
        { id: 'sensor', name: 'Sensor', sub: 'Detail dan tren tiap sensor secara mendalam', ic: '<path d="M3 12h4l3-8 4 16 3-8h4"/>' },
        { id: 'kamera', name: 'Kamera', sub: 'Pantau tanaman langsung dari ESP32-CAM', ic: '<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>' },
        { id: 'riwayat', name: 'Riwayat', sub: 'Semua pembacaan telemetri yang diterima sesi ini', ic: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>' },
        { id: 'peringatan', name: 'Peringatan', sub: 'Aturan otomatis dan kejadian yang terdeteksi', ic: '<path d="M6 16v-5a6 6 0 1 1 12 0v5l2 2H4z"/><path d="M10 21a2 2 0 0 0 4 0"/>' },
        { id: 'pengaturan', name: 'Pengaturan', sub: 'Koneksi Firebase, kalibrasi batas, dan tampilan', ic: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>' },
        { id: 'panduan', name: 'Panduan', sub: 'Pemasangan ESP32, pinout, dan pemecahan masalah', ic: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/>' }
    ];

    // Alert Rule Definitions
    const ALERT_RULES = [
        { id: 'dry', name: 'Tanah kering', desc: 'Kelembapan tanah di bawah ambang batas kering.', fixed: () => `< ${window.ConfigStore.get().dry} %` },
        { id: 'wet', name: 'Tanah terlalu basah', desc: 'Kelembapan tanah di atas batas basah optimal.', fixed: () => `> ${window.ConfigStore.get().wet} %` },
        { id: 'tmax', name: 'Suhu tinggi', desc: 'Suhu mikroklimat melampaui batas toleransi vegetatif.', unit: '°C', step: 1 },
        { id: 'tmin', name: 'Suhu rendah', desc: 'Suhu udara di bawah batas minimum.', unit: '°C', step: 1 },
        { id: 'hmin', name: 'Udara terlalu kering', desc: 'Kelembapan udara di bawah batas normal.', unit: '%', step: 1 },
        { id: 'off', name: 'Perangkat offline', desc: 'Tidak ada data baru selama batas waktu.', unit: 'detik', step: 5 }
    ];

    class DashboardController {
        constructor() {
            this.activePage = 'ringkasan';
            this.activeChartMetric = 'tanah';
            this.chartTimeWindowSec = 300;
            this.sensorWinSec = 60;
            this.plantAgeHST = 24;
            this.harvestTargetHST = 40;

            // SCADA Pump States: Distinction between controller command setpoint and physical relay confirmation
            this.lastPumpCommand = false;

            // Camera engine state & resource handles
            this.cam = {
                mode: 'stream',
                interval: 3000,
                run: false,
                want: false,
                timer: null,
                lastFrame: null
            };
            this.viewTransform = { z: 1, x: 0, y: 0 };
            this.gallery = [];

            // Alerts engine state
            this.alerts = [];
            this.alertFilter = 'all';
            this.ruleStates = {};
            this.alertIdCounter = 0;

            // Timer handles for memory leak prevention
            this.offlineTimer = null;
        }

        init() {
            this.buildNavigation();
            this.initRouter();
            this.bindEvents();
            this.bindCameraEngine();
            this.buildRulesUI();
            this.fillSettingsForm();
            this.applySavedTheme();

            // Firebase Edge Client Subscription
            window.FirebaseEdgeClient.subscribe((allRecords, addedRows, source) => {
                window.DatasetStore.setRecords(allRecords, source);
                if (addedRows && addedRows.length > 0) {
                    addedRows.forEach(r => this.evalAlertRules(r));
                }
                this.renderAllViews();
            });

            window.FirebaseEdgeClient.subscribeStatus((state, message, source) => {
                this.updateConnectionBadge(state, message, source);
            });

            window.FirebaseEdgeClient.start();

            // Periodic offline check with tracked timer
            this.offlineTimer = setInterval(() => this.checkDeviceOffline(), 3000);

            console.log('[DashboardController] Hardened dashboard controller operational.');
        }

        // ================= ROUTING & NAVIGATION =================
        buildNavigation() {
            const nav = $('#nav');
            if (!nav) return;

            nav.innerHTML = PAGES.map(p => `
                <a href="#${Sec.escapeHTML(p.id)}" class="nav-link ${p.id === this.activePage ? 'active' : ''}" data-p="${Sec.escapeHTML(p.id)}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">${p.ic}</svg>
                    <span>${Sec.escapeHTML(p.name)}</span>
                    ${p.id === 'peringatan' ? '<span class="count" id="navAlertCount" hidden>0</span>' : ''}
                </a>
            `).join('');
        }

        initRouter() {
            const handleHash = () => {
                const hash = (location.hash || '#ringkasan').replace(/^#/, '');
                const found = PAGES.some(p => p.id === hash);
                this.switchPage(found ? hash : 'ringkasan');
            };

            window.addEventListener('hashchange', handleHash);
            handleHash();
        }

        switchPage(pageId) {
            this.activePage = pageId;

            PAGES.forEach(p => {
                const section = $(`#p-${p.id}`);
                if (section) {
                    section.hidden = (p.id !== pageId);
                }
            });

            $$('#nav .nav-link').forEach(a => {
                if (a.dataset.p === pageId) {
                    a.classList.add('active');
                    a.setAttribute('aria-current', 'page');
                } else {
                    a.classList.remove('active');
                    a.removeAttribute('aria-current');
                }
            });

            const cur = PAGES.find(p => p.id === pageId) || PAGES[0];
            const ptitle = $('#ptitle');
            const psub = $('#psub');
            if (ptitle) ptitle.textContent = cur.name;
            if (psub) psub.textContent = cur.sub;

            this.closeMobileSidebar();
            this.renderAllViews();
        }

        closeMobileSidebar() {
            const sidebar = $('#sidebar');
            const overlay = $('#sidebarOverlay');
            if (sidebar) sidebar.classList.remove('open');
            if (overlay) overlay.style.display = 'none';
        }

        // ================= EVENT BINDINGS =================
        bindEvents() {
            const menuToggle = $('#menuToggle');
            const sideclose = $('#sideclose');
            const sidebar = $('#sidebar');
            const overlay = $('#sidebarOverlay');

            const openMenu = () => {
                if (sidebar) sidebar.classList.add('open');
                if (overlay) overlay.style.display = 'block';
            };

            if (menuToggle) menuToggle.addEventListener('click', openMenu);
            if (sideclose) sideclose.addEventListener('click', () => this.closeMobileSidebar());
            if (overlay) overlay.addEventListener('click', () => this.closeMobileSidebar());

            // Metric & window selector buttons
            $$('[data-chart-metric]').forEach(btn => {
                btn.addEventListener('click', () => {
                    $$('[data-chart-metric]').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    this.activeChartMetric = btn.dataset.chartMetric;
                    this.renderOverviewChart();
                });
            });

            $$('[data-chart-window]').forEach(btn => {
                btn.addEventListener('click', () => {
                    $$('[data-chart-window]').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    this.chartTimeWindowSec = parseInt(btn.dataset.chartWindow, 10);
                    this.renderOverviewChart();
                });
            });

            const winSeg = $('#winSeg');
            if (winSeg) {
                winSeg.addEventListener('click', (e) => {
                    const b = e.target.closest('button');
                    if (!b) return;
                    this.sensorWinSec = Number(b.dataset.n);
                    $$('#winSeg button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
                    this.renderSensorPage();
                });
            }

            // History tab events
            const fStatus = $('#fStatus');
            const fRange = $('#fRange');
            const fAgg = $('#fAgg');
            if (fStatus) fStatus.addEventListener('change', (e) => { window.DatasetStore.H.status = e.target.value; window.DatasetStore.H.page = 1; window.DatasetStore.renderRiwayat(); });
            if (fRange) fRange.addEventListener('change', (e) => { window.DatasetStore.H.range = Number(e.target.value); window.DatasetStore.H.page = 1; window.DatasetStore.renderRiwayat(); });
            if (fAgg) fAgg.addEventListener('change', (e) => { window.DatasetStore.H.agg = (e.target.value === '1'); window.DatasetStore.H.page = 1; window.DatasetStore.renderRiwayat(); });

            const thead = $('#p-riwayat thead');
            if (thead) {
                thead.addEventListener('click', (e) => {
                    const th = e.target.closest('th[data-k]');
                    if (!th) return;
                    const H = window.DatasetStore.H;
                    if (H.k === th.dataset.k) H.dir = -H.dir;
                    else { H.k = th.dataset.k; H.dir = -1; }
                    window.DatasetStore.renderRiwayat();
                });
            }

            const hPrev = $('#hPrev');
            const hNext = $('#hNext');
            if (hPrev) hPrev.addEventListener('click', () => { window.DatasetStore.H.page--; window.DatasetStore.renderRiwayat(); });
            if (hNext) hNext.addEventListener('click', () => { window.DatasetStore.H.page++; window.DatasetStore.renderRiwayat(); });

            const hClear = $('#hClear');
            if (hClear) {
                hClear.addEventListener('click', () => {
                    window.DatasetStore.clearHistory();
                    window.DatasetStore.renderRiwayat();
                    this.toast('Riwayat telemetri sesi dibersihkan.', 'emerald');
                });
            }

            const csvCopy = $('#csvCopy');
            if (csvCopy) {
                csvCopy.addEventListener('click', () => {
                    const txt = window.DatasetStore.generateCSV();
                    navigator.clipboard.writeText(txt).then(() => {
                        this.toast('CSV berhasil disalin (Formula Injection Protected).', 'emerald');
                    }).catch(() => {
                        const box = $('#csvbox');
                        if (box) { box.hidden = false; box.value = txt; box.focus(); box.select(); }
                    });
                });
            }

            const csvDl = $('#csvDl');
            if (csvDl) {
                csvDl.addEventListener('click', () => {
                    const txt = window.DatasetStore.generateCSV();
                    const blob = new Blob([txt], { type: 'text/csv;charset=utf-8;' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `telemetri-selada-${new Date().toISOString().slice(0, 10)}.csv`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    URL.revokeObjectURL(url);
                    this.toast('File CSV berhasil diunduh secara aman.', 'emerald');
                });
            }

            // Alerts page events
            const alSeg = $('#alSeg');
            if (alSeg) {
                alSeg.addEventListener('click', (e) => {
                    const b = e.target.closest('button');
                    if (!b) return;
                    this.alertFilter = b.dataset.f;
                    $$('#alSeg button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
                    this.renderAlertsPage();
                });
            }

            const alRead = $('#alRead');
            if (alRead) {
                alRead.addEventListener('click', () => {
                    this.alerts.forEach(a => { a.read = true; });
                    this.renderAlertsPage();
                    this.updateAlertCountBadge();
                    this.toast('Semua peringatan ditandai dibaca.', 'emerald');
                });
            }

            const alClear = $('#alClear');
            if (alClear) {
                alClear.addEventListener('click', () => {
                    this.alerts = [];
                    this.renderAlertsPage();
                    this.updateAlertCountBadge();
                    this.toast('Daftar peringatan dibersihkan.', 'emerald');
                });
            }

            // Settings page events
            const setUrl = $('#setUrl');
            const setPoll = $('#setPoll');
            const setFetchN = $('#setFetchN');
            const setDemo = $('#setDemo');
            const setUnit = $('#setUnit');
            const setClock = $('#setClock');
            const setTheme = $('#setTheme');
            const setReset = $('#setReset');
            const testBtn = $('#testBtn');

            if (setUrl) setUrl.addEventListener('change', (e) => {
                const val = e.target.value.trim();
                if (!Sec.isValidFirebaseUrl(val)) {
                    setUrl.classList.add('input-invalid');
                    this.toast('URL Firebase tidak valid atau domain tidak diizinkan.', 'rose');
                    return;
                }
                setUrl.classList.remove('input-invalid');
                const S = window.ConfigStore.get();
                S.firebase = val;
                window.ConfigStore.save();
                window.FirebaseEdgeClient.restart();
            });

            if (setPoll) setPoll.addEventListener('change', (e) => {
                const S = window.ConfigStore.get();
                S.poll = Number(e.target.value);
                window.ConfigStore.save();
            });

            if (setFetchN) setFetchN.addEventListener('change', (e) => {
                const S = window.ConfigStore.get();
                S.fetchN = Number(e.target.value);
                window.ConfigStore.save();
                window.FirebaseEdgeClient.restart();
            });

            if (setDemo) setDemo.addEventListener('change', (e) => {
                const S = window.ConfigStore.get();
                S.forceDemo = e.target.checked;
                window.ConfigStore.save();
                window.FirebaseEdgeClient.restart();
            });

            if (setUnit) setUnit.addEventListener('change', (e) => {
                const S = window.ConfigStore.get();
                S.unit = e.target.value;
                window.ConfigStore.save();
                this.renderAllViews();
            });

            if (setClock) setClock.addEventListener('change', (e) => {
                const S = window.ConfigStore.get();
                S.clock = e.target.value;
                window.ConfigStore.save();
                this.renderAllViews();
            });

            if (setTheme) setTheme.addEventListener('change', (e) => {
                const S = window.ConfigStore.get();
                S.theme = e.target.value;
                window.ConfigStore.save();
                this.applySavedTheme();
            });

            if (setReset) setReset.addEventListener('click', () => {
                window.ConfigStore.reset();
                this.fillSettingsForm();
                this.applySavedTheme();
                this.buildRulesUI();
                window.FirebaseEdgeClient.restart();
                this.toast('Pengaturan dikembalikan ke bawaan.', 'emerald');
            });

            if (testBtn) testBtn.addEventListener('click', async () => {
                const testMsg = $('#testMsg');
                const urlInput = $('#setUrl');
                if (!testMsg) return;
                testMsg.className = 'msg';
                testMsg.textContent = 'Menguji koneksi ke endpoint Firebase RTDB…';
                const url = urlInput ? urlInput.value.trim() : '';

                const res = await window.FirebaseEdgeClient.testConnection(url);
                if (res.ok) {
                    testMsg.className = 'msg good';
                    testMsg.textContent = res.count > 0 
                        ? `Tersambung aman. Data terakhir diterima pukul ${window.DatasetStore.formatTime(res.latest.t)}.`
                        : `Tersambung, namun node database kosong.`;
                } else {
                    testMsg.className = 'msg err';
                    testMsg.textContent = `Gagal terhubung: ${Sec.escapeHTML(res.error)}`;
                }
            });

            // Soil zone limits validation
            const setDry = $('#setDry');
            const setWet = $('#setWet');
            const handleZoneChange = () => {
                const d = Number(setDry.value);
                const w = Number(setWet.value);
                const msg = $('#zoneMsg');

                if (!Number.isFinite(d) || !Number.isFinite(w) || !(d >= 1 && w <= 99 && d < w)) {
                    if (setDry) setDry.classList.add('input-invalid');
                    if (setWet) setWet.classList.add('input-invalid');
                    if (msg) { msg.className = 'msg err'; msg.textContent = 'Batas kering harus lebih kecil dari batas basah (1–99%).'; }
                    return;
                }

                if (setDry) setDry.classList.remove('input-invalid');
                if (setWet) setWet.classList.remove('input-invalid');
                const S = window.ConfigStore.get();
                S.dry = d;
                S.wet = w;
                window.ConfigStore.save();
                if (msg) { msg.className = 'msg good'; msg.textContent = 'Batas zona tersimpan (Histeresis disesuaikan).'; }
                this.buildRulesUI();
                this.renderAllViews();
            };

            if (setDry) setDry.addEventListener('change', handleZoneChange);
            if (setWet) setWet.addEventListener('change', handleZoneChange);

            // AI Assistant bindings
            const btnDiagnose = $('#btnDiagnoseAI');
            if (btnDiagnose) {
                btnDiagnose.addEventListener('click', () => {
                    const latest = window.DatasetStore.getLatest();
                    window.AIAssistant.query('Lakukan analisis kondisi mikroklimat sensor saat ini secara mendalam.', latest);
                    window.AIAssistant.renderThread('aiChatThread');
                    this.toast('Diagnosa agronomi selada diperbarui.', 'blue');
                });
            }

            $$('.ai-chip').forEach(chip => {
                chip.addEventListener('click', () => {
                    const question = chip.textContent.trim();
                    const latest = window.DatasetStore.getLatest();
                    window.AIAssistant.query(question, latest);
                    window.AIAssistant.renderThread('aiChatThread');
                });
            });

            const aiInput = $('#aiChatInput');
            const btnSend = $('#btnSendQuery');
            const sendAI = () => {
                if (!aiInput || !aiInput.value.trim()) return;
                const text = aiInput.value.trim();
                aiInput.value = '';
                const latest = window.DatasetStore.getLatest();
                window.AIAssistant.query(text, latest);
                window.AIAssistant.renderThread('aiChatThread');
            };

            if (btnSend) btnSend.addEventListener('click', sendAI);
            if (aiInput) aiInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendAI(); });

            // Dashboard copy/download actions
            const btnCopyJSON = $('#btnCopyJSON');
            const btnDownloadCSV = $('#btnDownloadCSV');
            if (btnCopyJSON) btnCopyJSON.addEventListener('click', () => this.copyJSONDirect());
            if (btnDownloadCSV) btnDownloadCSV.addEventListener('click', () => $('#csvDl') ? $('#csvDl').click() : null);

            window.addEventListener('resize', () => {
                if (this.activePage === 'ringkasan') this.renderOverviewChart();
                else if (this.activePage === 'sensor') this.renderSensorPage();
            });
        }

        copyJSONDirect() {
            const rows = window.DatasetStore.getRecent(10);
            navigator.clipboard.writeText(JSON.stringify(rows, null, 2))
                .then(() => this.toast('10 data terakhir disalin ke clipboard.', 'emerald'))
                .catch(() => this.toast('Gagal menyalin data.', 'rose'));
        }

        // ================= CAMERA ENGINE (SSRF Protected) =================
        bindCameraEngine() {
            const camimg = $('#camimg');
            const camstate = $('#camstate');
            const livebadge = $('#livebadge');
            const camip = $('#camip');
            const camGo = $('#camGo');
            const useAp = $('#useAp');
            const camReload = $('#camReload');
            const camOff = $('#camOff');
            const camMode = $('#camMode');
            const camInt = $('#camInt');
            const camSnap = $('#camSnap');
            const galClear = $('#galClear');
            const viewReset = $('#viewReset');

            const S = window.ConfigStore.get();
            if (camip && S.camIp) camip.value = S.camIp;

            const camMsg = (title, text) => {
                if (!camstate) return;
                camstate.hidden = false;
                // DOM XSS DEFENSE: Use textContent via element creation
                camstate.textContent = '';
                const bEl = document.createElement('b');
                bEl.textContent = title;
                const pEl = document.createElement('p');
                pEl.textContent = text;
                camstate.appendChild(bEl);
                camstate.appendChild(pEl);
            };

            const camIdle = () => camMsg('Kamera belum terhubung', 'Masukkan IP ESP32-CAM (misal 192.168.1.23) atau pakai 192.168.4.1 saat tersambung ke WiFi ESP32-CAM-SELADA.');

            const camOk = () => {
                if (camimg) camimg.hidden = false;
                if (camstate) camstate.hidden = true;
                if (livebadge) livebadge.hidden = false;
                if (camOff) camOff.hidden = false;
            };

            const camFail = () => {
                this.cam.run = false;
                if (this.cam.timer) {
                    clearTimeout(this.cam.timer);
                    this.cam.timer = null;
                }
                if (camimg) camimg.hidden = true;
                if (livebadge) livebadge.hidden = true;
                camMsg('Video tidak bisa dimuat', location.protocol === 'https:'
                    ? 'Browser memblokir stream HTTP kamera di halaman HTTPS. Gunakan HTTP atau periksa IP ESP32-CAM.'
                    : 'Pastikan satu jaringan WiFi dengan ESP32-CAM, alamat IP valid, dan tidak ada tab lain yang membuka stream.');
            };

            if (camimg) {
                camimg.onload = camOk;
                camimg.onerror = camFail;
            }

            const camStop = () => {
                this.cam.run = false;
                if (this.cam.timer) {
                    clearTimeout(this.cam.timer);
                    this.cam.timer = null;
                }
                if (camimg) camimg.src = '';
                if (livebadge) livebadge.hidden = true;
            };

            const camStart = () => {
                const rawIp = camip ? camip.value : window.ConfigStore.get().camIp;
                const validatedHost = Sec.isValidCameraHost(rawIp);

                if (!validatedHost) {
                    if (camip) camip.classList.add('input-invalid');
                    camMsg('Format Alamat IP Tidak Valid', 'Gunakan format IPv4 lokal yang benar (contoh: 192.168.1.23 atau 192.168.4.1).');
                    return;
                }

                if (camip) camip.classList.remove('input-invalid');

                // Clear previous timer to prevent overlapping polling loops
                if (this.cam.timer) {
                    clearTimeout(this.cam.timer);
                    this.cam.timer = null;
                }

                this.cam.want = true;
                this.cam.run = true;
                camMsg('Menghubungkan ke kamera…', validatedHost);

                const getCamUrl = (path) => `http://${validatedHost}${path}${path.includes('?') ? '&' : '?'}t=${Date.now()}`;

                if (this.cam.mode === 'stream') {
                    if (camimg) camimg.src = getCamUrl(':81/stream');
                } else {
                    const tick = () => {
                        if (!this.cam.run) return;
                        if (camimg) camimg.src = getCamUrl('/capture');
                        this.cam.timer = setTimeout(tick, this.cam.interval);
                    };
                    tick();
                }
            };

            if (camGo) camGo.addEventListener('click', () => {
                const validatedHost = Sec.isValidCameraHost(camip ? camip.value : '');
                if (!validatedHost) {
                    if (camip) camip.classList.add('input-invalid');
                    this.toast('Alamat IP kamera tidak valid (harus IPv4 atau host lokal).', 'rose');
                    return;
                }
                if (camip) camip.classList.remove('input-invalid');
                const conf = window.ConfigStore.get();
                conf.camIp = validatedHost;
                window.ConfigStore.save();
                camStart();
            });

            if (useAp) useAp.addEventListener('click', () => {
                if (camip) camip.value = '192.168.4.1';
                if (camGo) camGo.click();
            });

            if (camReload) camReload.addEventListener('click', () => camStart());
            if (camOff) camOff.addEventListener('click', () => {
                this.cam.want = false;
                camStop();
                camIdle();
                camOff.hidden = true;
            });

            if (camMode) camMode.addEventListener('click', (e) => {
                const b = e.target.closest('button');
                if (!b) return;
                this.cam.mode = b.dataset.m;
                $$('#camMode button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
                const intRow = $('#intRow');
                if (intRow) intRow.hidden = (this.cam.mode !== 'foto');
                if (this.cam.run || this.cam.want) camStart();
            });

            if (camInt) camInt.addEventListener('change', (e) => {
                this.cam.interval = Number(e.target.value);
            });

            if (camSnap) camSnap.addEventListener('click', () => {
                if (!camimg || camimg.hidden || !camimg.naturalWidth) {
                    this.toast('Belum ada feed video untuk diambil foto.', 'amber');
                    return;
                }
                const canvas = document.createElement('canvas');
                canvas.width = camimg.naturalWidth;
                canvas.height = camimg.naturalHeight;
                try {
                    canvas.getContext('2d').drawImage(camimg, 0, 0);
                    const dataUrl = canvas.toDataURL('image/jpeg');
                    this.gallery.unshift({ url: dataUrl, t: Date.now() });
                    if (this.gallery.length > 12) this.gallery.pop();
                    this.renderGalleryUI();
                    this.toast('Foto tersimpan di galeri sesi.', 'emerald');
                } catch (err) {
                    this.toast('Gagal mengambil foto: batasan origin/CORS.', 'rose');
                }
            });

            if (galClear) galClear.addEventListener('click', () => {
                this.gallery = [];
                this.renderGalleryUI();
                this.toast('Galeri sesi dibersihkan.', 'emerald');
            });

            this.initCameraPanZoom();

            const applyFilters = () => {
                if (!camimg) return;
                const br = $('#vBr') ? $('#vBr').value : 100;
                const ct = $('#vCt') ? $('#vCt').value : 100;
                const mir = $('#vMir') && $('#vMir').checked;
                const rot = $('#vRot') && $('#vRot').checked;

                const sx = (mir ? -1 : 1) * this.viewTransform.z;
                const sy = this.viewTransform.z;
                const deg = rot ? 180 : 0;

                camimg.style.filter = `brightness(${br}%) contrast(${ct}%)`;
                camimg.style.transform = `translate(${this.viewTransform.x}px, ${this.viewTransform.y}px) scale(${sx}, ${sy}) rotate(${deg}deg)`;
            };

            ['vBr', 'vCt', 'vMir', 'vRot'].forEach(id => {
                const el = $(`#${id}`);
                if (el) el.addEventListener('input', applyFilters);
            });

            if (viewReset) viewReset.addEventListener('click', () => {
                if ($('#vBr')) $('#vBr').value = 100;
                if ($('#vCt')) $('#vCt').value = 100;
                if ($('#vZm')) $('#vZm').value = 100;
                if ($('#vMir')) $('#vMir').checked = false;
                if ($('#vRot')) $('#vRot').checked = false;
                this.viewTransform = { z: 1, x: 0, y: 0 };
                applyFilters();
            });

            camIdle();
        }

        initCameraPanZoom() {
            const v = $('#camview');
            const camimg = $('#camimg');
            if (!v) return;

            const applyTransform = () => {
                if (!camimg) return;
                const br = $('#vBr') ? $('#vBr').value : 100;
                const ct = $('#vCt') ? $('#vCt').value : 100;
                const mir = $('#vMir') && $('#vMir').checked;
                const rot = $('#vRot') && $('#vRot').checked;
                const sx = (mir ? -1 : 1) * this.viewTransform.z;
                const sy = this.viewTransform.z;
                const deg = rot ? 180 : 0;

                camimg.style.filter = `brightness(${br}%) contrast(${ct}%)`;
                camimg.style.transform = `translate(${this.viewTransform.x}px, ${this.viewTransform.y}px) scale(${sx}, ${sy}) rotate(${deg}deg)`;
                const zLvl = $('#zLvl');
                if (zLvl) zLvl.textContent = `${Math.round(this.viewTransform.z * 100)}%`;
            };

            const zoomTo = (newZ) => {
                this.viewTransform.z = Math.max(1, Math.min(4, newZ));
                if (this.viewTransform.z === 1) {
                    this.viewTransform.x = 0;
                    this.viewTransform.y = 0;
                }
                applyTransform();
            };

            const zIn = $('#zIn');
            const zOut = $('#zOut');
            const zLvl = $('#zLvl');
            const zFs = $('#zFs');
            const camFull = $('#camFull');
            const vZm = $('#vZm');

            if (zIn) zIn.addEventListener('click', () => zoomTo(this.viewTransform.z * 1.3));
            if (zOut) zOut.addEventListener('click', () => zoomTo(this.viewTransform.z / 1.3));
            if (zLvl) zLvl.addEventListener('click', () => zoomTo(1));
            if (vZm) vZm.addEventListener('input', (e) => zoomTo(Number(e.target.value) / 100));

            const toggleFullscreen = () => {
                if (!document.fullscreenElement) {
                    if (v.requestFullscreen) v.requestFullscreen();
                    else v.classList.toggle('pseudo-full');
                } else {
                    if (document.exitFullscreen) document.exitFullscreen();
                    v.classList.remove('pseudo-full');
                }
            };

            if (zFs) zFs.addEventListener('click', toggleFullscreen);
            if (camFull) camFull.addEventListener('click', toggleFullscreen);

            v.addEventListener('wheel', (e) => {
                if (camimg && !camimg.hidden) {
                    e.preventDefault();
                    zoomTo(this.viewTransform.z * Math.exp(-e.deltaY * 0.0015));
                }
            }, { passive: false });

            v.addEventListener('dblclick', () => {
                if (this.viewTransform.z > 1) zoomTo(1);
                else zoomTo(2.5);
            });
        }

        renderGalleryUI() {
            const container = $('#gallery');
            const emptyMsg = $('#galEmpty');
            if (!container) return;

            if (this.gallery.length === 0) {
                container.innerHTML = '';
                if (emptyMsg) emptyMsg.hidden = false;
                return;
            }

            if (emptyMsg) emptyMsg.hidden = true;
            container.innerHTML = this.gallery.map(item => `
                <img src="${item.url}" alt="Foto Selada" title="Diambil pukul ${new Date(item.t).toLocaleTimeString()}">
            `).join('');
        }

        // ================= ALERTS & RULES ENGINE =================
        buildRulesUI() {
            const rulesEl = $('#rules');
            if (!rulesEl) return;
            const S = window.ConfigStore.get();

            rulesEl.innerHTML = ALERT_RULES.map(r => {
                const conf = S.rules[r.id] || { on: true, v: 0 };
                const checked = conf.on ? 'checked' : '';
                const limitDisplay = r.fixed ? r.fixed() : '';
                const inputHtml = r.fixed ? `<span style="font-size:12px;font-family:var(--font-mono);">${Sec.escapeHTML(limitDisplay)}</span>` : `
                    <div class="ctl">
                        <input type="number" data-r="${Sec.escapeHTML(r.id)}" value="${Number(conf.v) || 0}" step="${r.step || 1}" style="width:70px;">
                        <span>${Sec.escapeHTML(r.unit || '')}</span>
                    </div>
                `;

                return `
                    <div class="rule">
                        <div class="rule-info">
                            <b>${Sec.escapeHTML(r.name)}</b>
                            <p>${Sec.escapeHTML(r.desc)}</p>
                        </div>
                        <div style="display:flex;align-items:center;gap:10px;">
                            ${inputHtml}
                            <input class="sw" type="checkbox" data-t="${Sec.escapeHTML(r.id)}" ${checked} aria-label="Aktifkan aturan ${Sec.escapeHTML(r.name)}">
                        </div>
                    </div>
                `;
            }).join('');

            rulesEl.addEventListener('change', (e) => {
                const t = e.target;
                const conf = window.ConfigStore.get();
                if (t.dataset.t) {
                    conf.rules[t.dataset.t].on = t.checked;
                    if (!t.checked) this.ruleStates[t.dataset.t] = false;
                }
                if (t.dataset.r) {
                    const v = Number(t.value);
                    if (Number.isFinite(v)) conf.rules[t.dataset.r].v = v;
                }
                window.ConfigStore.save();
            });
        }

        evalAlertRules(row) {
            if (!row || !Number.isFinite(row.tanah)) return;
            const S = window.ConfigStore.get();

            const check = (ruleId, condition, sev, msg) => {
                const rule = S.rules[ruleId];
                if (!rule || !rule.on) return;
                const wasActive = !!this.ruleStates[ruleId];

                if (condition && !wasActive) {
                    this.addAlert(sev, ruleId, msg, row.t);
                    this.ruleStates[ruleId] = true;
                } else if (!condition && wasActive) {
                    this.ruleStates[ruleId] = false;
                }
            };

            check('dry', row.tanah < S.dry, 'warn', `Kelembapan tanah ${row.tanah}% di bawah ambang normal (${S.dry}%). Perintah irigasi otomatis aktif.`);
            check('wet', row.tanah > S.wet, 'info', `Kelembapan tanah ${row.tanah}% melampaui batas lapang (${S.wet}%). Pompa siaga.`);
            check('tmax', row.suhu > S.rules.tmax.v, 'alert', `Suhu mikroklimat ${row.suhu}°C di atas batas aman (${S.rules.tmax.v}°C). Resiko bolting meningkat.`);
            check('tmin', row.suhu < S.rules.tmin.v, 'warn', `Suhu udara ${row.suhu}°C di bawah ambang minimum (${S.rules.tmin.v}°C).`);
            check('hmin', row.udara < S.rules.hmin.v, 'warn', `Kelembapan udara ${row.udara}% terlalu kering (< ${S.rules.hmin.v}%). Waspadai risiko tipburn.`);

            this.updateAlertCountBadge();
        }

        checkDeviceOffline() {
            const latest = window.DatasetStore.getLatest();
            if (!latest) return;
            const S = window.ConfigStore.get();
            const rule = S.rules.off;
            if (!rule || !rule.on) return;

            const isOffline = (Date.now() - latest.t) > (rule.v * 1000);
            const wasOffline = !!this.ruleStates.off;

            if (isOffline && !wasOffline) {
                this.addAlert('alert', 'off', `Perangkat offline: tidak ada transmisi telemetri selama lebih dari ${rule.v} detik.`, Date.now());
                this.ruleStates.off = true;
            } else if (!isOffline && wasOffline) {
                this.ruleStates.off = false;
            }
        }

        addAlert(sev, rule, msg, t) {
            this.alerts.unshift({
                id: ++this.alertIdCounter,
                t: t || Date.now(),
                sev: sev,
                rule: rule,
                msg: msg,
                read: false
            });
            if (this.alerts.length > 100) this.alerts.pop();
            this.toast(msg, sev === 'alert' ? 'rose' : (sev === 'warn' ? 'amber' : 'blue'));
            this.renderAlertsPage();
            this.updateAlertCountBadge();
        }

        updateAlertCountBadge() {
            const unread = this.alerts.filter(a => !a.read).length;
            const badge = $('#navAlertCount');
            if (badge) {
                badge.hidden = (unread === 0);
                badge.textContent = unread;
            }
        }

        renderAlertsPage() {
            const listEl = $('#alList');
            if (!listEl) return;

            let items = this.alerts;
            if (this.alertFilter === 'unread') {
                items = items.filter(a => !a.read);
            }

            if (items.length === 0) {
                listEl.innerHTML = `<p class="hint" style="text-align:center;padding:24px;">Tidak ada kejadian yang tercatat saat ini.</p>`;
                return;
            }

            // DOM XSS DEFENSE: Escape alert content
            listEl.innerHTML = items.map(a => `
                <div class="ev ${Sec.escapeHTML(a.sev)}" style="opacity:${a.read ? 0.75 : 1};">
                    <div class="ev-content">
                        <b>${Sec.escapeHTML(a.msg)}</b>
                        <p>Aturan: <span class="mono">${Sec.escapeHTML(a.rule)}</span></p>
                    </div>
                    <span class="ev-time">${Sec.escapeHTML(window.DatasetStore.formatTime(a.t))}</span>
                </div>
            `).join('');
        }

        // ================= SENSOR PAGE RENDERER (#p-sensor) =================
        renderSensorPage() {
            const allRows = window.DatasetStore.getAll();
            const now = Date.now();
            const winRows = allRows.filter(r => r.t >= (now - this.sensorWinSec * 1000));
            const rows = winRows.length >= 2 ? winRows : allRows.slice(-30);

            if (rows.length < 2) return;

            const S = window.ConfigStore.get();
            const tUnit = S.unit === 'F' ? '°F' : '°C';
            const convTemp = S.unit === 'F' ? (v => (v * 9 / 5) + 32) : (v => v);

            const stTanah = window.DatasetStore.calculateStats(rows, r => r.tanah);
            const stSuhu = window.DatasetStore.calculateStats(rows, r => convTemp(r.suhu), 0.2);
            const stUdara = window.DatasetStore.calculateStats(rows, r => r.udara);

            if ($('#st-tanah')) $('#st-tanah').innerHTML = window.DatasetStore.generateStatHTML(stTanah, '%', 0);
            if ($('#st-suhu')) $('#st-suhu').innerHTML = window.DatasetStore.generateStatHTML(stSuhu, tUnit, 1);
            if ($('#st-udara')) $('#st-udara').innerHTML = window.DatasetStore.generateStatHTML(stUdara, '%', 0);

            const last = rows[rows.length - 1];
            if ($('#ro-tanah')) $('#ro-tanah').innerHTML = `<b>${Math.round(last.tanah)}%</b> · Kelembapan Tanah · <span class="mono">${Sec.escapeHTML(window.DatasetStore.formatTime(last.t))}</span>`;
            if ($('#ro-suhu')) $('#ro-suhu').innerHTML = `<b>${convTemp(last.suhu).toFixed(1)}${Sec.escapeHTML(tUnit)}</b> · Suhu Mikroklimat · <span class="mono">${Sec.escapeHTML(window.DatasetStore.formatTime(last.t))}</span>`;
            if ($('#ro-udara')) $('#ro-udara').innerHTML = `<b>${Math.round(last.udara)}%</b> · Kelembapan Udara · <span class="mono">${Sec.escapeHTML(window.DatasetStore.formatTime(last.t))}</span>`;

            this.renderDetailedSVGChart('ch-tanah', rows, r => r.tanah, '%', [S.dry, S.wet], 40, 100, '#10b981');
            this.renderDetailedSVGChart('ch-suhu', rows, r => convTemp(r.suhu), tUnit, [convTemp(15), convTemp(24)], null, null, '#f59e0b');
            this.renderDetailedSVGChart('ch-udara', rows, r => r.udara, '%', [60, 80], 40, 100, '#3b82f6');

            const share = window.DatasetStore.calculateZoneShare(rows);
            const zoneShareEl = $('#zoneShare');
            if (zoneShareEl) {
                zoneShareEl.innerHTML = `
                    <div class="zones-bar">
                        <div class="zones-bar-seg" style="width:${share.dry}%;background:var(--accent-rose);" title="Kering: ${share.dry}%"></div>
                        <div class="zones-bar-seg" style="width:${share.ok}%;background:var(--accent-emerald);" title="Optimal: ${share.ok}%"></div>
                        <div class="zones-bar-seg" style="width:${share.wet}%;background:var(--accent-blue);" title="Basah: ${share.wet}%"></div>
                    </div>
                    <div class="zones-legend">
                        <span>Kering: <b>${share.dry}%</b></span>
                        <span>Optimal (${S.dry}–${S.wet}%): <b>${share.ok}%</b></span>
                        <span>Basah: <b>${share.wet}%</b></span>
                    </div>
                `;
            }

            this.renderScatterPlot('ch-scatter', rows);
        }

        renderDetailedSVGChart(elementId, rows, getter, unit, band, fixedMin, fixedMax, strokeColor) {
            const host = $(`#${elementId}`);
            if (!host) return;

            const w = Math.max(280, host.clientWidth || 600);
            const h = 220;
            const pad = { t: 16, r: 16, b: 24, l: 44 };
            const iw = w - pad.l - pad.r;
            const ih = h - pad.t - pad.b;

            const vals = rows.map(getter).filter(v => Number.isFinite(v));
            if (vals.length < 2) return;

            const minVal = fixedMin !== null ? fixedMin : Math.floor(Math.min(...vals) - 1);
            const maxVal = fixedMax !== null ? fixedMax : Math.ceil(Math.max(...vals) + 1);

            const t0 = rows[0].t;
            const t1 = rows[rows.length - 1].t;
            const tSpan = Math.max(t1 - t0, 10000);

            const X = t => pad.l + ((t - t0) / tSpan) * iw;
            const Y = v => pad.t + (1 - (v - minVal) / ((maxVal - minVal) || 1)) * ih;

            let gridHtml = '';
            for (let i = 0; i <= 3; i++) {
                const tv = minVal + i * ((maxVal - minVal) / 3);
                const y = Y(tv);
                gridHtml += `
                    <line class="grid-line" x1="${pad.l}" y1="${y}" x2="${w - pad.r}" y2="${y}" stroke="rgba(255,255,255,0.06)" />
                    <text class="axis-text" x="${pad.l - 6}" y="${y + 3}" text-anchor="end" fill="var(--text-muted)" font-size="10">${Math.round(tv)}${Sec.escapeHTML(unit)}</text>
                `;
            }

            let bandHtml = '';
            if (band && band.length === 2) {
                const y1 = Y(band[1]);
                const y0 = Y(band[0]);
                bandHtml = `
                    <rect x="${pad.l}" y="${Math.min(y1, y0)}" width="${iw}" height="${Math.abs(y0 - y1)}" fill="rgba(59,130,246,0.06)" />
                    <line x1="${pad.l}" y1="${y0}" x2="${w - pad.r}" y2="${y0}" stroke="rgba(244,63,94,0.4)" stroke-dasharray="3 3" />
                    <line x1="${pad.l}" y1="${y1}" x2="${w - pad.r}" y2="${y1}" stroke="rgba(244,63,94,0.4)" stroke-dasharray="3 3" />
                `;
            }

            const pts = rows.map((r, i) => [X(r.t), Y(vals[i])]);
            const pathD = 'M' + pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L');
            const lastPt = pts[pts.length - 1];

            host.innerHTML = `
                <svg viewBox="0 0 ${w} ${h}">
                    ${gridHtml}
                    ${bandHtml}
                    <path d="${pathD}" fill="none" stroke="${Sec.escapeHTML(strokeColor)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                    <circle cx="${lastPt[0]}" cy="${lastPt[1]}" r="4" fill="${Sec.escapeHTML(strokeColor)}" />
                </svg>
            `;
        }

        renderScatterPlot(containerId, rows) {
            const host = $(`#${containerId}`);
            if (!host) return;

            const w = Math.max(260, host.clientWidth || 340);
            const h = 220;
            const pad = { t: 16, r: 16, b: 28, l: 40 };
            const iw = w - pad.l - pad.r;
            const ih = h - pad.t - pad.b;

            const S = window.ConfigStore.get();
            const convTemp = S.unit === 'F' ? (v => (v * 9 / 5) + 32) : (v => v);

            const xs = rows.map(r => convTemp(r.suhu)).filter(v => Number.isFinite(v));
            const ys = rows.map(r => r.udara).filter(v => Number.isFinite(v));

            if (xs.length < 2 || ys.length < 2) return;

            const minX = Math.min(...xs), maxX = Math.max(...xs);
            const minY = Math.min(...ys), maxY = Math.max(...ys);

            const spanX = Math.max(maxX - minX, 2);
            const spanY = Math.max(maxY - minY, 5);

            const X = v => pad.l + ((v - minX) / spanX) * iw;
            const Y = v => pad.t + (1 - (v - minY) / spanY) * ih;

            // Pearson correlation coefficient r
            const n = xs.length;
            const meanX = xs.reduce((a, b) => a + b, 0) / n;
            const meanY = ys.reduce((a, b) => a + b, 0) / n;
            let num = 0, denX = 0, denY = 0;
            for (let i = 0; i < n; i++) {
                const dx = xs[i] - meanX, dy = ys[i] - meanY;
                num += dx * dy;
                denX += dx * dx;
                denY += dy * dy;
            }
            const r = (denX > 0 && denY > 0) ? (num / Math.sqrt(denX * denY)) : 0;

            const corrEl = $('#corr');
            if (corrEl) {
                corrEl.textContent = `Korelasi r = ${r.toFixed(2)} (${r < -0.3 ? 'Suhu naik, kelembapan turun' : 'Fluktuasi moderat'})`;
            }

            const dotsHtml = xs.map((xVal, i) => `
                <circle cx="${X(xVal).toFixed(1)}" cy="${Y(ys[i]).toFixed(1)}" r="3" fill="#3b82f6" opacity="0.65" />
            `).join('');

            host.innerHTML = `
                <svg viewBox="0 0 ${w} ${h}">
                    <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${h - pad.b}" stroke="rgba(255,255,255,0.1)" />
                    <line x1="${pad.l}" y1="${h - pad.b}" x2="${w - pad.r}" y2="${h - pad.b}" stroke="rgba(255,255,255,0.1)" />
                    <text x="${pad.l}" y="${pad.t - 4}" fill="var(--text-muted)" font-size="10">Udara (%)</text>
                    <text x="${w - pad.r}" y="${h - 8}" text-anchor="end" fill="var(--text-muted)" font-size="10">Suhu (${S.unit === 'F' ? '°F' : '°C'})</text>
                    ${dotsHtml}
                </svg>
            `;
        }

        // ================= RENDERING ORCHESTRATION =================
        renderAllViews() {
            const latest = window.DatasetStore.getLatest();
            this.updateHeaderMeta(latest);

            if (this.activePage === 'ringkasan') {
                this.updateMetricsCards(latest);
                this.renderPlantAgeBanner();
                this.updatePredictionCard(latest);
                this.renderOverviewChart();
                window.DatasetStore.renderSnippetTable('datasetTableBody', 8);
            } else if (this.activePage === 'sensor') {
                this.renderSensorPage();
            } else if (this.activePage === 'riwayat') {
                window.DatasetStore.renderRiwayat();
            } else if (this.activePage === 'peringatan') {
                this.renderAlertsPage();
            }
        }

        updateHeaderMeta(latest) {
            const freshEl = $('#fresh');
            if (freshEl) {
                freshEl.textContent = latest ? `${Math.max(0, Math.round((Date.now() - latest.t) / 1000))} detik lalu` : '—';
            }
        }

        updateConnectionBadge(state, message, source = 'live') {
            const dot = $('#sysStatusDot');
            const text = $('#sysStatusText');
            const sub = $('#sysStatusSub');

            let sourceLabel = 'Telemetri Live';
            let color = 'var(--accent-emerald)';

            if (source === 'simulated' || state === 'demo') {
                sourceLabel = 'Mode Simulasi (Data Demo)';
                color = 'var(--accent-blue)';
            } else if (source === 'cache' || state === 'offline') {
                sourceLabel = 'Offline Cache (Jaringan Terputus)';
                color = 'var(--accent-amber)';
            }

            if (dot) {
                dot.style.backgroundColor = color;
                dot.style.boxShadow = `0 0 8px ${color}`;
            }
            if (text) {
                text.textContent = sourceLabel;
            }
            if (sub) {
                sub.textContent = message || (state === 'connected' ? 'RTDB Asia-Southeast1 Aktif' : 'Penyimpanan Offline');
            }
        }

        renderPlantAgeBanner() {
            const ageNumber = $('#plantAgeNumber');
            const progressFill = $('#plantAgeProgressFill');
            const progressPct = $('#plantProgressPct');
            const daysLeft = $('#plantDaysLeft');

            const pct = Math.min(100, Math.round((this.plantAgeHST / this.harvestTargetHST) * 100));
            const remaining = Math.max(0, this.harvestTargetHST - this.plantAgeHST);

            if (ageNumber) ageNumber.textContent = this.plantAgeHST;
            if (progressFill) progressFill.style.width = `${pct}%`;
            if (progressPct) progressPct.textContent = `${pct}% Target Panen (${this.harvestTargetHST} HST)`;
            if (daysLeft) daysLeft.textContent = `${remaining} Hari Lagi Menuju Panen`;
        }

        updateMetricsCards(record) {
            if (!record || !Number.isFinite(record.tanah)) return;
            const S = window.ConfigStore.get();
            const tUnit = S.unit === 'F' ? '°F' : '°C';
            const convTemp = S.unit === 'F' ? (v => (v * 9 / 5) + 32) : (v => v);

            // 1. Soil Moisture Card
            const soilVal = $('#valSoilMoisture');
            const soilBadge = $('#badgeSoilStatus');
            const soilSub = $('#subSoilMoisture');
            if (soilVal) soilVal.textContent = Math.round(record.tanah);

            if (soilBadge) {
                if (record.tanah < S.dry) {
                    soilBadge.className = 'metric-badge alert';
                    soilBadge.textContent = `Kering (< ${S.dry}%)`;
                } else if (record.tanah > S.wet) {
                    soilBadge.className = 'metric-badge warn';
                    soilBadge.textContent = `Jenuh (> ${S.wet}%)`;
                } else {
                    soilBadge.className = 'metric-badge ok';
                    soilBadge.textContent = `Optimal (${S.dry}-${S.wet}%)`;
                }
            }

            if (soilSub) {
                soilSub.textContent = `Batas Histeresis: ${S.dry}% – ${S.wet}%`;
            }

            // 2. Air Humidity Card
            const airVal = $('#valAirHumidity');
            const airBadge = $('#badgeAirStatus');
            if (airVal) airVal.textContent = Math.round(record.udara);
            if (airBadge) {
                if (record.udara < 60) {
                    airBadge.className = 'metric-badge warn';
                    airBadge.textContent = 'Kering (< 60%)';
                } else if (record.udara > 80) {
                    airBadge.className = 'metric-badge alert';
                    airBadge.textContent = 'Lembap (> 80%)';
                } else {
                    airBadge.className = 'metric-badge ok';
                    airBadge.textContent = 'Normal (60-80%)';
                }
            }

            // 3. Temperature Card
            const tempVal = $('#valAirTemp');
            const tempBadge = $('#badgeTempStatus');
            const curT = convTemp(record.suhu);
            if (tempVal) tempVal.textContent = curT.toFixed(1);
            if (tempBadge) {
                if (record.suhu > 28) {
                    tempBadge.className = 'metric-badge alert';
                    tempBadge.textContent = 'Suhu Panas (> 28°C)';
                } else if (record.suhu < 15) {
                    tempBadge.className = 'metric-badge warn';
                    tempBadge.textContent = 'Suhu Dingin (< 15°C)';
                } else {
                    tempBadge.className = 'metric-badge ok';
                    tempBadge.textContent = `Optimal (15-24${tUnit})`;
                }
            }

            // 4. PUMP HYSTERESIS CONTROLLER (Separation of pumpCommand and pumpActualState)
            // Software set-point decision logic
            const prevCommand = this.lastPumpCommand;
            let pumpCommand = prevCommand;

            if (record.tanah < S.dry) {
                pumpCommand = true;
            } else if (record.tanah > S.wet) {
                pumpCommand = false;
            } else {
                pumpCommand = prevCommand;
            }

            const pumpVal = $('#valPumpStatus');
            const pumpBadge = $('#badgePumpStatus');
            const pumpPulse = $('#pumpPulseDot');
            const pumpSub = $('#subPumpStatus');

            // Explicitly distinguish set-point command vs hardware feedback
            if (pumpVal) {
                pumpVal.textContent = pumpCommand ? 'PERINTAH: ON' : 'PERINTAH: OFF';
            }

            if (pumpBadge) {
                pumpBadge.className = pumpCommand ? 'metric-badge alert' : 'metric-badge ok';
                pumpBadge.textContent = pumpCommand ? 'Irigasi Aktif' : 'Siaga Otomatis';
            }

            if (pumpPulse) {
                pumpPulse.style.backgroundColor = pumpCommand ? 'var(--accent-amber)' : 'var(--accent-emerald)';
                pumpPulse.style.boxShadow = `0 0 10px ${pumpCommand ? 'var(--accent-amber)' : 'var(--accent-emerald)'}`;
            }

            if (pumpSub) {
                let relayFeedbackText = 'Feedback Relay: Tidak Tersedia';
                if (record.relayActual === true) relayFeedbackText = 'Feedback Relay: Terkonfirmasi Aktif';
                else if (record.relayActual === false) relayFeedbackText = 'Feedback Relay: Terkonfirmasi Mati';

                if (pumpCommand) {
                    pumpSub.textContent = record.tanah < S.dry
                        ? `Tanah ${Math.round(record.tanah)}% < ${S.dry}% · ${relayFeedbackText}`
                        : `Tanah ${Math.round(record.tanah)}% (Histeresis ke > ${S.wet}%) · ${relayFeedbackText}`;
                } else {
                    pumpSub.textContent = record.tanah > S.wet
                        ? `Tanah ${Math.round(record.tanah)}% > ${S.wet}% · ${relayFeedbackText}`
                        : `Tanah ${Math.round(record.tanah)}% (Rentang Siaga) · ${relayFeedbackText}`;
                }
            }

            if (pumpCommand !== prevCommand) {
                this.toast(pumpCommand
                    ? `Perintah Irigasi Otomatis ON: Kelembapan tanah di bawah ${S.dry}%.`
                    : `Perintah Irigasi Otomatis OFF: Kelembapan tanah melampaui ${S.wet}%.`,
                    pumpCommand ? 'amber' : 'emerald'
                );
                this.lastPumpCommand = pumpCommand;
            }

            // Mini sparklines
            this.renderMiniSparkline('sparkSoil', 'tanah', record.tanah < S.dry ? '#f43f5e' : '#10b981');
            this.renderMiniSparkline('sparkAir', 'udara', '#3b82f6');
            this.renderMiniSparkline('sparkTemp', 'suhu', '#f59e0b');
        }

        renderMiniSparkline(elementId, field, strokeColor) {
            const el = $(`#${elementId}`);
            if (!el) return;
            const records = window.DatasetStore.getRecent(18);
            if (records.length < 2) { el.innerHTML = ''; return; }

            const vals = records.map(r => Number(r[field])).filter(v => Number.isFinite(v));
            if (vals.length < 2) return;

            const min = Math.min(...vals), max = Math.max(...vals);
            const range = (max - min) || 1;
            const width = 88, height = 28;

            const points = vals.map((v, i) => {
                const x = (i / (vals.length - 1)) * width;
                const y = height - ((v - min) / range) * (height - 6) - 3;
                return `${x.toFixed(1)},${y.toFixed(1)}`;
            }).join(' ');

            el.innerHTML = `
                <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
                    <polyline fill="none" stroke="${Sec.escapeHTML(strokeColor)}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" points="${points}" />
                </svg>
            `;
        }

        // ================= REAL GROWING DEGREE DAYS (GDD) FORECAST =================
        updatePredictionCard(latestRecord) {
            const container = $('#predictionForecastGrid');
            if (!container) return;

            // Grounded agronomic model: Lettuce Growing Degree Days (Base Temp = 4.0°C)
            const baseTemp = 4.0;
            const targetGDD = 700; // Typical cumulative GDD required for curly lettuce harvest
            const currentTemp = latestRecord && Number.isFinite(latestRecord.suhu) ? latestRecord.suhu : 24.5;
            const currentSoil = latestRecord && Number.isFinite(latestRecord.tanah) ? latestRecord.tanah : 72;

            // Daily thermal rate based on current microclimate: GDD_day = max(0, T_mean - 4.0)
            const dailyGDD = Math.max(0, currentTemp - baseTemp);

            // Cumulative thermal heat units estimate up to current HST (24)
            const estimatedCurrentGDD = Math.min(targetGDD, Math.round(this.plantAgeHST * dailyGDD));
            const baseMaturityPct = Math.min(98, Math.round((estimatedCurrentGDD / targetGDD) * 100));

            const forecastDays = [1, 2, 3, 4].map(offset => {
                const forecastDay = this.plantAgeHST + offset;
                const projectedGDD = Math.min(targetGDD, estimatedCurrentGDD + Math.round(offset * dailyGDD));
                let dayMaturity = Math.min(100, Math.round((projectedGDD / targetGDD) * 100));

                // Water stress penalty on vegetative expansion
                if (currentSoil < 65 || currentTemp > 28) {
                    dayMaturity = Math.max(0, dayMaturity - 1);
                }

                let statusText = 'Masa Pertumbuhan Vegetatif';
                let pillClass = 'veg';
                if (dayMaturity >= 90) { statusText = 'Siap Panen Optimal'; pillClass = 'ready'; }
                else if (dayMaturity >= 75) { statusText = 'Menjelang Panen'; pillClass = 'near'; }

                return {
                    dayOffset: offset,
                    dayHST: forecastDay,
                    projectedGDD: projectedGDD,
                    maturityPct: dayMaturity,
                    statusText: statusText,
                    pillClass: pillClass,
                    estimatedWeightGram: Math.round(110 + (dayMaturity / 100) * 120)
                };
            });

            // DOM XSS DEFENSE: Escape dynamic text and pills
            container.innerHTML = forecastDays.map(f => `
                <div class="forecast-item">
                    <div class="forecast-day-header">
                        <span>Hari ke+${f.dayOffset} (${f.dayHST} HST)</span>
                        <span class="forecast-state-pill ${Sec.escapeHTML(f.pillClass)}">${Sec.escapeHTML(f.statusText)}</span>
                    </div>
                    <div class="forecast-maturity">
                        <span class="forecast-pct tabular-nums">${f.maturityPct}%</span>
                        <span style="font-size: 11px; color: var(--text-muted);">(GDD: ${f.projectedGDD}/${targetGDD})</span>
                    </div>
                    <div style="font-size: 11px; color: var(--text-secondary); display: flex; justify-content: space-between;">
                        <span>Proyeksi Biomassa:</span>
                        <b class="tabular-nums" style="color: var(--text-primary);">${f.estimatedWeightGram}g / ph</b>
                    </div>
                </div>
            `).join('');
        }

        renderOverviewChart() {
            const wrap = $('#chartSvgWrap');
            if (!wrap) return;

            const allRecords = window.DatasetStore.getAll().filter(r => Number.isFinite(r.t));
            if (allRecords.length < 2) {
                wrap.innerHTML = `<div class="skeleton-shimmer" style="height:100%;"></div>`;
                return;
            }

            const now = Date.now();
            const minTime = now - (this.chartTimeWindowSec * 1000);
            let rows = allRecords.filter(r => r.t >= minTime);
            if (rows.length < 2) rows = allRecords.slice(-40);

            const S = window.ConfigStore.get();
            const metric = this.activeChartMetric;
            const w = wrap.clientWidth || 800;
            const h = 240;
            const pad = { top: 16, right: 24, bottom: 28, left: 44 };
            const innerW = Math.max(20, w - pad.left - pad.right);
            const innerH = Math.max(20, h - pad.top - pad.bottom);

            let yMin = 0, yMax = 100, unit = '%', band = null;
            if (metric === 'tanah') {
                yMin = 40; yMax = 100; unit = '%';
                band = [S.dry, S.wet];
            } else if (metric === 'udara') {
                yMin = 40; yMax = 100; unit = '%';
                band = [60, 80];
            } else if (metric === 'suhu') {
                const conv = S.unit === 'F' ? (v => (v * 9 / 5) + 32) : (v => v);
                const temps = rows.map(r => conv(r.suhu)).filter(v => Number.isFinite(v));
                yMin = Math.floor(Math.min(...temps) - 2);
                yMax = Math.ceil(Math.max(...temps) + 2);
                unit = S.unit === 'F' ? '°F' : '°C';
                band = [conv(15), conv(24)];
            }

            const t0 = rows[0].t;
            const t1 = rows[rows.length - 1].t;
            const timeSpan = Math.max(t1 - t0, 10000);

            const getX = t => pad.left + ((t - t0) / timeSpan) * innerW;
            const getY = val => pad.top + (1 - (val - yMin) / (yMax - yMin)) * innerH;

            let gridHtml = '';
            for (let i = 0; i <= 4; i++) {
                const tickVal = yMin + (i / 4) * (yMax - yMin);
                const y = getY(tickVal);
                gridHtml += `
                    <line class="grid-line" x1="${pad.left}" y1="${y}" x2="${w - pad.right}" y2="${y}" />
                    <text class="axis-text" x="${pad.left - 8}" y="${y + 3}" text-anchor="end">${Math.round(tickVal)}${Sec.escapeHTML(unit)}</text>
                `;
            }

            let bandHtml = '';
            if (band) {
                const yTop = getY(band[1]);
                const yBottom = getY(band[0]);
                bandHtml = `
                    <rect class="normal-band" x="${pad.left}" y="${Math.min(yTop, yBottom)}" width="${innerW}" height="${Math.abs(yBottom - yTop)}" />
                    <line class="threshold-line" x1="${pad.left}" y1="${yBottom}" x2="${w - pad.right}" y2="${yBottom}" />
                    <line class="threshold-line" x1="${pad.left}" y1="${yTop}" x2="${w - pad.right}" y2="${yTop}" />
                `;
            }

            let timeLabelsHtml = '';
            for (let k = 0; k < 4; k++) {
                const f = k / 3;
                const tx = t0 + f * timeSpan;
                const x = pad.left + f * innerW;
                const anchor = k === 0 ? 'start' : (k === 3 ? 'end' : 'middle');
                timeLabelsHtml += `<text class="axis-text" x="${x}" y="${h - 6}" text-anchor="${anchor}">${Sec.escapeHTML(window.DatasetStore.formatTime(tx, true))}</text>`;
            }

            const conv = (S.unit === 'F' && metric === 'suhu') ? (v => (v * 9 / 5) + 32) : (v => v);
            const points = rows.map(r => [getX(r.t), getY(conv(r[metric]))]);
            const pathD = 'M' + points.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L');
            const areaD = `${pathD} L${points[points.length - 1][0].toFixed(1)},${(pad.top + innerH).toFixed(1)} L${points[0][0].toFixed(1)},${(pad.top + innerH).toFixed(1)} Z`;
            const lastPt = points[points.length - 1];

            wrap.innerHTML = `
                <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
                    <defs>
                        <linearGradient id="blueGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.35" />
                            <stop offset="100%" stop-color="#3b82f6" stop-opacity="0.0" />
                        </linearGradient>
                    </defs>
                    ${gridHtml}
                    ${bandHtml}
                    ${timeLabelsHtml}
                    <path class="data-area" d="${areaD}" />
                    <path class="data-line" d="${pathD}" />
                    <circle class="data-dot" cx="${lastPt[0]}" cy="${lastPt[1]}" r="4.5" />
                </svg>
            `;
        }

        fillSettingsForm() {
            const S = window.ConfigStore.get();
            if ($('#setUrl')) $('#setUrl').value = S.firebase;
            if ($('#setPoll')) $('#setPoll').value = String(S.poll);
            if ($('#setFetchN')) $('#setFetchN').value = String(S.fetchN);
            if ($('#setDemo')) $('#setDemo').checked = !!S.forceDemo;
            if ($('#setDry')) $('#setDry').value = S.dry;
            if ($('#setWet')) $('#setWet').value = S.wet;
            if ($('#setUnit')) $('#setUnit').value = S.unit;
            if ($('#setClock')) $('#setClock').value = S.clock;
            if ($('#setTheme')) $('#setTheme').value = S.theme;
        }

        applySavedTheme() {
            const S = window.ConfigStore.get();
            const root = document.documentElement;
            if (S.theme === 'system') root.removeAttribute('data-theme');
            else root.setAttribute('data-theme', S.theme);
        }

        toast(message, variant = 'blue') {
            const container = $('#toastContainer');
            if (!container) return;

            const el = document.createElement('div');
            el.className = `toast ${Sec.escapeHTML(variant)}`;
            // DOM XSS DEFENSE: textContent
            el.textContent = message;
            container.appendChild(el);

            setTimeout(() => {
                el.style.opacity = '0';
                el.style.transform = 'translateY(10px)';
                setTimeout(() => el.remove(), 250);
            }, 3500);
        }

        destroy() {
            if (this.offlineTimer) {
                clearInterval(this.offlineTimer);
                this.offlineTimer = null;
            }
            if (this.cam && this.cam.timer) {
                clearTimeout(this.cam.timer);
                this.cam.timer = null;
            }
        }
    }

    window.DashboardUI = new DashboardController();
    document.addEventListener('DOMContentLoaded', () => window.DashboardUI.init());

})(window);
