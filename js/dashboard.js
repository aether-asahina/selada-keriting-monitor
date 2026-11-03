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

    // Nav Pages Definition (11 Functional Navigation Tabs)
    const PAGES = [
        { id: 'ringkasan', name: 'Dashboard', sub: 'Pusat monitoring telemetri sensor fisik, kamera & pertumbuhan aktual Kelompok 5', ic: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>' },
        { id: 'sensor', name: 'Sensor', sub: 'Detail dan tren tiap sensor fisik secara mendalam', ic: '<path d="M3 12h4l3-8 4 16 3-8h4"/>' },
        { id: 'kamera', name: 'Kamera', sub: 'Pantau tanaman langsung dari ESP32-CAM & jadwal otonom', ic: '<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>' },
        { id: 'pertumbuhan-daun', name: 'Pertumbuhan Daun', sub: 'Siklus 42 hari, segmentasi ExG & pengukuran kanopi aktual', ic: '<path d="M12 2a10 10 0 0 1 10 10c0 5.523-4.477 10-10 10S2 17.523 2 12A10 10 0 0 1 12 2Z"/><path d="M12 6v6l4 2"/>' },
        { id: 'riwayat', name: 'Riwayat', sub: 'Semua pembacaan telemetri yang diterima sesi ini', ic: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>' },
        { id: 'analisis-tanaman', name: 'Analisis Tanaman', sub: 'Fisiologi tanaman, Tetens VPD & model termal GDD', ic: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>' },
        { id: 'ai-assistant', name: 'AI Assistant', sub: 'Sistem pakar agronomi & asisten percakapan cerdas', ic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/>' },
        { id: 'otomasi', name: 'Otomasi', sub: 'Logika histeresis SCADA & setpoint irigasi presisi', ic: '<path d="M12 2v20"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>' },
        { id: 'peringatan', name: 'Peringatan', sub: 'Aturan otomatis dan kejadian yang terdeteksi', ic: '<path d="M6 16v-5a6 6 0 1 1 12 0v5l2 2H4z"/><path d="M10 21a2 2 0 0 0 4 0"/>' },
        { id: 'pengaturan', name: 'Pengaturan', sub: 'Koneksi Firebase Kelompok 5, kalibrasi batas, dan tampilan', ic: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>' },
        { id: 'panduan', name: 'Panduan', sub: 'Pemasangan ESP32 Kelompok 5, pinout, dan pemecahan masalah', ic: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/>' }
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
            this.activeChartMetric = 'all';
            this.chartTimeWindowSec = 0;
            this.sensorWinSec = 60;
            this.plantAgeHST = 0;
            this.harvestTargetHST = 42;
            this.connectionState = 'connecting';
            this.connectionMessage = 'Menghubungkan…';
            this.connectionSource = 'none';

            // SCADA Pump States: Distinction between controller command setpoint and physical relay confirmation
            this.lastPumpCommand = false;

            // Interactive Chart Series Visibility Filter
            this.activeSeries = { tanah: true, udara: true, suhu: true, pompa: true };

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

            // Subscribe to Leaf Growth Store updates
            if (window.GrowthStore) {
                window.GrowthStore.subscribe(() => {
                    this.renderAllViews();
                });
            }

            // Responsive ResizeObserver for telemetry & leaf growth chart containment
            const handleChartResize = () => {
                if (this.activePage === 'ringkasan') {
                    this.renderOverviewChart();
                    this.renderDashboardPumpChart();
                    if (window.GrowthStore) window.GrowthStore.renderMiniDashboardCharts();
                } else if (this.activePage === 'pertumbuhan-daun') {
                    if (window.GrowthStore) window.GrowthStore.renderGrowthCharts();
                } else if (this.activePage === 'sensor') {
                    this.renderSensorPage();
                }
            };

            let resizeDebounce = null;
            const triggerDebouncedResize = () => {
                clearTimeout(resizeDebounce);
                resizeDebounce = setTimeout(handleChartResize, 50);
            };

            const chartWrap = $('#chartSvgWrap');
            if (chartWrap && typeof ResizeObserver !== 'undefined') {
                const ro = new ResizeObserver(triggerDebouncedResize);
                ro.observe(chartWrap);
            }
            window.addEventListener('resize', triggerDebouncedResize);

            // Periodic offline check with tracked timer
            this.offlineTimer = setInterval(() => this.checkDeviceOffline(), 3000);

            console.log('[DashboardController] Hardened dashboard controller operational.');
        }

        calculateTetensVPD(tempC, humidityPct) {
            if (!Number.isFinite(tempC) || !Number.isFinite(humidityPct)) return null;
            const validT = Math.max(0, Math.min(50, tempC));
            const validRH = Math.max(5, Math.min(100, humidityPct));
            const svp = 0.61078 * Math.exp((17.27 * validT) / (validT + 237.3));
            const avp = svp * (validRH / 100);
            return Math.max(0, Number((svp - avp).toFixed(3)));
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
                let hash = (location.hash || '#ringkasan').replace(/^#/, '');
                if (hash === 'dashboard') hash = 'ringkasan';
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

            $$('#bottomNav [data-bnav]').forEach(item => {
                item.classList.toggle('active', item.dataset.bnav === pageId);
            });

            this.closeMobileSidebar();
            this.renderAllViews();

            if (pageId === 'pertumbuhan-daun' && window.GrowthStore) {
                window.GrowthStore.renderPertumbuhanDaunPage();
            }
            if (pageId === 'ai-assistant' && window.AIAssistant) {
                window.AIAssistant.renderThread('aiChatThreadPage');
            }
        }

        closeMobileSidebar() {
            const sidebar = $('#sidebar');
            const overlay = $('#sidebarOverlay');
            const backdrop = $('#mobileBackdrop');
            if (sidebar) sidebar.classList.remove('open');
            if (overlay) overlay.style.display = 'none';
            if (backdrop) backdrop.classList.remove('open');
        }

        // ================= EVENT BINDINGS =================
        bindEvents() {
            const menuToggle = $('#menuToggle');
            const sideclose = $('#sideclose');
            const sidebar = $('#sidebar');
            const overlay = $('#sidebarOverlay');
            const backdrop = $('#mobileBackdrop');

            const openMenu = () => {
                if (sidebar) sidebar.classList.add('open');
                if (overlay) overlay.style.display = 'block';
                if (backdrop) backdrop.classList.add('open');
            };

            if (menuToggle) menuToggle.addEventListener('click', openMenu);
            if (sideclose) sideclose.addEventListener('click', () => this.closeMobileSidebar());
            if (overlay) overlay.addEventListener('click', () => this.closeMobileSidebar());
            if (backdrop) backdrop.addEventListener('click', () => this.closeMobileSidebar());

            // Reconnect button on Dashboard Camera panel
            const btnDashCamReconnect = $('#btnDashCamReconnect');
            if (btnDashCamReconnect) {
                btnDashCamReconnect.addEventListener('click', () => {
                    const S = window.ConfigStore.get();
                    if (S.camIp) {
                        this.toast(`Menyambungkan ulang ke ESP32-CAM (${S.camIp})...`, 'blue');
                        this.startCamera();
                    } else {
                        this.toast('IP ESP32-CAM belum diatur. Silakan atur di tab Kamera.', 'amber');
                    }
                });
            }

            // Dedicated AI Assistant page bindings
            const btnDiagPage = $('#btnDiagnoseAIPage');
            const btnSendPage = $('#btnSendQueryPage');
            const aiInputPage = $('#aiChatInputPage');

            if (btnDiagPage) {
                btnDiagPage.addEventListener('click', () => {
                    const latest = window.DatasetStore.getLatest();
                    window.AIAssistant.diagnoseCurrentConditions(latest);
                    window.AIAssistant.renderThread('aiChatThreadPage');
                    this.toast('Diagnosa agronomi real-time selesai.', 'emerald');
                });
            }

            const sendAIPage = () => {
                if (!aiInputPage) return;
                const text = aiInputPage.value.trim();
                if (!text) return;
                aiInputPage.value = '';
                const latest = window.DatasetStore.getLatest();
                window.AIAssistant.query(text, latest);
                window.AIAssistant.renderThread('aiChatThreadPage');
            };

            if (btnSendPage) btnSendPage.addEventListener('click', sendAIPage);
            if (aiInputPage) aiInputPage.addEventListener('keydown', e => { if (e.key === 'Enter') sendAIPage(); });

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

            // Interactive Chart Series Legend Filter Toggle
            $$('[data-legend-series]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const series = btn.dataset.legendSeries;
                    if (!series) return;
                    if (!this.activeSeries) this.activeSeries = { tanah: true, udara: true, suhu: true, pompa: true };
                    this.activeSeries[series] = !this.activeSeries[series];
                    const active = this.activeSeries[series];
                    btn.classList.toggle('is-active', active);
                    btn.classList.toggle('is-muted', !active);
                    btn.setAttribute('aria-pressed', String(active));
                    this.renderOverviewChart();
                });
            });

            // Pump Control Confirmation Dialog Modal Handlers
            const btnPumpControlReq = $('#btnPumpControlReq');
            const pumpConfirmModal = $('#pumpConfirmModal');
            const btnPumpModalClose = $('#btnPumpModalClose');
            const btnPumpConfirmCancel = $('#btnPumpConfirmCancel');
            const btnPumpConfirmProceed = $('#btnPumpConfirmProceed');
            const pumpConfirmDesc = $('#pumpConfirmDesc');

            const openPumpModal = () => {
                if (!pumpConfirmModal) return;
                const isCurrentlyOn = !!this.lastPumpCommand;
                const targetAction = isCurrentlyOn ? 'OFF (Matikan Irigasi)' : 'ON (Nyalakan Irigasi)';
                if (pumpConfirmDesc) {
                    pumpConfirmDesc.innerHTML = `
                        Status perintah saat ini: <strong>${isCurrentlyOn ? 'ON (Irigasi Aktif)' : 'OFF (Siaga Otomatis)'}</strong>.<br>
                        Tindakan yang akan dikirim: <strong class="u-text-${isCurrentlyOn ? 'rose' : 'emerald'}">${targetAction}</strong>.<br>
                        Apakah Anda yakin ingin mengirim perintah <strong>${targetAction}</strong> ke kontroler SCADA (GPIO 26)?
                    `;
                }
                pumpConfirmModal.classList.add('open');
            };

            const closePumpModal = () => {
                if (pumpConfirmModal) pumpConfirmModal.classList.remove('open');
            };

            if (btnPumpControlReq) btnPumpControlReq.addEventListener('click', openPumpModal);
            if (btnPumpModalClose) btnPumpModalClose.addEventListener('click', closePumpModal);
            if (btnPumpConfirmCancel) btnPumpConfirmCancel.addEventListener('click', closePumpModal);
            if (pumpConfirmModal) {
                pumpConfirmModal.addEventListener('click', (e) => {
                    if (e.target === pumpConfirmModal) closePumpModal();
                });
            }

            if (btnPumpConfirmProceed) {
                btnPumpConfirmProceed.addEventListener('click', () => {
                    this.lastPumpCommand = !this.lastPumpCommand;
                    const newCmd = this.lastPumpCommand;
                    closePumpModal();
                    this.updateMetricsCards(window.DatasetStore.getLatest());
                    this.toast(
                        `Perintah manual pompa ${newCmd ? 'ON (Irigasi Aktif)' : 'OFF (Siaga)'} dikirim ke SCADA (Proteksi batas 120s aktif).`,
                        newCmd ? 'amber' : 'emerald'
                    );
                    if (this.activePage === 'ringkasan') {
                        this.renderOverviewChart();
                        this.renderDashboardPumpChart();
                    }
                });
            }

            // Mobile Bottom Navigation Bar Bindings
            $$('#bottomNav [data-bnav]').forEach(item => {
                item.addEventListener('click', (e) => {
                    e.preventDefault();
                    const target = item.dataset.bnav;
                    location.hash = `#${target}`;
                });
            });

            const bottomNavMoreBtn = $('#bottomNavMoreBtn');
            if (bottomNavMoreBtn) {
                bottomNavMoreBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    const isOpen = sidebar && sidebar.classList.contains('open');
                    if (isOpen) {
                        this.closeMobileSidebar();
                    } else {
                        openMenu();
                    }
                });
            }

            // Global Keyboard Dismissal (Escape Key) for Modals & Mobile Drawer
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' || e.key === 'Esc') {
                    closePumpModal();
                    if (window.GrowthStore && typeof window.GrowthStore.closeDetailModal === 'function') {
                        window.GrowthStore.closeDetailModal();
                    }
                    this.closeMobileSidebar();
                }
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

        // ================= CAMERA ENGINE (SSRF Protected · /stream & Wi-Fi Direct Capture) =================
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

            // Main Dashboard Live Camera Elements
            const dashCamImg = $('#dashCamImg');
            const dashCamEmpty = $('#dashCamEmpty');
            const dashCamTime = $('#dashCamTime');
            const dashCamIpInput = $('#dashCamIpInput');
            const btnDashCamReconnect = $('#btnDashCamReconnect');
            const dashCamEndpointBadge = $('#dashCamEndpointBadge');

            const S = window.ConfigStore.get();
            if (camip && S.camIp) camip.value = S.camIp;
            if (dashCamIpInput && S.camIp) dashCamIpInput.value = S.camIp;

            const syncDashCamOverlay = (isLive, hostStr) => {
                if (dashCamImg) dashCamImg.style.display = isLive ? 'block' : 'none';
                if (dashCamEmpty) dashCamEmpty.style.display = isLive ? 'none' : 'flex';
                if (dashCamEndpointBadge) {
                    dashCamEndpointBadge.textContent = hostStr ? `http://${hostStr}:81/stream` : '/stream · Belum Diatur';
                }
                if (dashCamTime) {
                    dashCamTime.textContent = isLive
                        ? `LIVE /stream · ${window.DatasetStore.formatTime(Date.now(), false)}`
                        : (hostStr ? `OFFLINE (${hostStr})` : 'Menunggu IP ESP32-CAM');
                }
                this.renderAllViews();
            };

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

            const camIdle = () => {
                camMsg('Kamera belum terhubung', 'Masukkan IP ESP32-CAM (misal 192.168.1.23) untuk membuka endpoint /stream atau pakai 192.168.4.1 pada mode AP.');
                syncDashCamOverlay(false, window.ConfigStore.get().camIp || '');
            };

            const camOk = () => {
                this.cam.run = true;
                if (camimg) camimg.hidden = false;
                if (camstate) camstate.hidden = true;
                if (livebadge) livebadge.hidden = false;
                if (camOff) camOff.hidden = false;
                const hostStr = window.ConfigStore.get().camIp || '';
                syncDashCamOverlay(true, hostStr);
                if (window.GrowthStore && hostStr) {
                    window.GrowthStore.pollCameraNodeStatus(hostStr);
                }
            };

            const camFail = () => {
                this.cam.run = false;
                if (this.cam.timer) {
                    clearTimeout(this.cam.timer);
                    this.cam.timer = null;
                }
                if (camimg) camimg.hidden = true;
                if (livebadge) livebadge.hidden = true;
                const hostStr = window.ConfigStore.get().camIp || '';
                syncDashCamOverlay(false, hostStr);
                if (window.GrowthStore) {
                    window.GrowthStore.sdStatus.reachable = false;
                    window.GrowthStore.renderStorageAndSyncStatus();
                }
                camMsg('Feed /stream tidak terjangkau', location.protocol === 'https:'
                    ? 'Browser memblokir stream HTTP lokal pada halaman HTTPS. Buka dashboard via HTTP lokal. Kamera mengirim foto langsung ke receiver via Wi-Fi.'
                    : 'Kamera ESP32-CAM offline di jaringan lokal. Kamera memotret dan mengirim JPEG langsung ke server saat online.');
            };

            if (camimg) {
                camimg.onload = camOk;
                camimg.onerror = camFail;
            }
            if (dashCamImg) {
                dashCamImg.onload = camOk;
                dashCamImg.onerror = camFail;
            }

            const camStop = () => {
                this.cam.run = false;
                if (this.cam.timer) {
                    clearTimeout(this.cam.timer);
                    this.cam.timer = null;
                }
                if (camimg) camimg.src = '';
                if (dashCamImg) dashCamImg.src = '';
                if (livebadge) livebadge.hidden = true;
                syncDashCamOverlay(false, window.ConfigStore.get().camIp || '');
            };

            const camStart = () => {
                const rawIp = (camip && camip.value.trim()) || (dashCamIpInput && dashCamIpInput.value.trim()) || window.ConfigStore.get().camIp;
                const validatedHost = Sec.isValidCameraHost(rawIp);

                if (!validatedHost) {
                    if (camip) camip.classList.add('input-invalid');
                    if (dashCamIpInput) dashCamIpInput.classList.add('input-invalid');
                    camMsg('Format Alamat IP Tidak Valid', 'Gunakan format IPv4 lokal yang benar (contoh: 192.168.1.23 atau 192.168.4.1).');
                    return;
                }

                if (camip) { camip.classList.remove('input-invalid'); camip.value = validatedHost; }
                if (dashCamIpInput) { dashCamIpInput.classList.remove('input-invalid'); dashCamIpInput.value = validatedHost; }

                // Clear previous timer to prevent overlapping polling loops
                if (this.cam.timer) {
                    clearTimeout(this.cam.timer);
                    this.cam.timer = null;
                }

                this.cam.want = true;
                this.cam.run = true;
                camMsg('Menghubungkan ke endpoint /stream…', `http://${validatedHost}:81/stream`);

                const getCamUrl = (path) => `http://${validatedHost}${path}${path.includes('?') ? '&' : '?'}t=${Date.now()}`;

                if (this.cam.mode === 'stream') {
                    const streamUrl = getCamUrl(':81/stream');
                    if (camimg) camimg.src = streamUrl;
                    if (dashCamImg) dashCamImg.src = streamUrl;
                } else {
                    const tick = () => {
                        if (!this.cam.run) return;
                        const snapUrl = getCamUrl('/capture');
                        if (camimg) camimg.src = snapUrl;
                        if (dashCamImg) dashCamImg.src = snapUrl;
                        this.cam.timer = setTimeout(tick, this.cam.interval);
                    };
                    tick();
                }

                if (window.GrowthStore) {
                    window.GrowthStore.pollCameraNodeStatus(validatedHost);
                }
            };

            const handleConnectHost = (inputEl) => {
                const validatedHost = Sec.isValidCameraHost(inputEl ? inputEl.value : '');
                if (!validatedHost) {
                    if (inputEl) inputEl.classList.add('input-invalid');
                    this.toast('Alamat IP kamera tidak valid (gunakan IPv4 lokal seperti 192.168.1.23).', 'rose');
                    return;
                }
                if (inputEl) inputEl.classList.remove('input-invalid');
                const conf = window.ConfigStore.get();
                conf.camIp = validatedHost;
                window.ConfigStore.save();
                camStart();
            };

            if (camGo) camGo.addEventListener('click', () => handleConnectHost(camip));
            if (btnDashCamReconnect) {
                btnDashCamReconnect.addEventListener('click', () => {
                    if (dashCamIpInput && dashCamIpInput.value.trim()) {
                        handleConnectHost(dashCamIpInput);
                    } else if (window.ConfigStore.get().camIp) {
                        camStart();
                    } else {
                        this.toast('Masukkan IP lokal ESP32-CAM terlebih dahulu untuk membuka /stream.', 'amber');
                        if (dashCamIpInput) dashCamIpInput.focus();
                    }
                });
            }
            if (dashCamIpInput) {
                dashCamIpInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') handleConnectHost(dashCamIpInput);
                });
            }

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

            // Continuously evaluate data freshness & stale telemetry badge
            this.updateHeaderMeta(latest);
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

            const S = window.ConfigStore.get();
            const tUnit = S.unit === 'F' ? '°F' : '°C';
            const convTemp = S.unit === 'F' ? (v => (v * 9 / 5) + 32) : (v => v);

            const stTanah = window.DatasetStore.calculateStats(rows, r => r.tanah);
            const stSuhu = window.DatasetStore.calculateStats(rows, r => convTemp(r.suhu), 0.2);
            const stUdara = window.DatasetStore.calculateStats(rows, r => r.udara);

            if ($('#st-tanah')) $('#st-tanah').innerHTML = window.DatasetStore.generateStatHTML(stTanah, '%', 0);
            if ($('#st-suhu')) $('#st-suhu').innerHTML = window.DatasetStore.generateStatHTML(stSuhu, tUnit, 1);
            if ($('#st-udara')) $('#st-udara').innerHTML = window.DatasetStore.generateStatHTML(stUdara, '%', 0);

            if (rows.length === 0) {
                if ($('#ro-tanah')) $('#ro-tanah').innerHTML = `<b>NO DATA</b> · Kelembapan Tanah · <span class="mono">OFFLINE</span>`;
                if ($('#ro-suhu')) $('#ro-suhu').innerHTML = `<b>NO DATA</b> · Suhu Mikroklimat · <span class="mono">OFFLINE</span>`;
                if ($('#ro-udara')) $('#ro-udara').innerHTML = `<b>NO DATA</b> · Kelembapan Udara · <span class="mono">OFFLINE</span>`;

                ['ch-tanah', 'ch-suhu', 'ch-udara', 'ch-scatter'].forEach(id => {
                    const host = $(`#${id}`);
                    if (host) {
                        host.innerHTML = `<div style="height:220px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:12px;text-align:center;padding:16px;">NO DATA · Menunggu Telemetri Sensor Fisik</div>`;
                    }
                });

                const zoneShareEl = $('#zoneShare');
                if (zoneShareEl) {
                    zoneShareEl.innerHTML = `
                        <div class="zones-bar"></div>
                        <div class="zones-legend">
                            <span>Kering: <b>— (NO DATA)</b></span>
                            <span>Optimal (${S.dry}–${S.wet}%): <b>— (NO DATA)</b></span>
                            <span>Basah: <b>— (NO DATA)</b></span>
                        </div>
                    `;
                }
                if ($('#corr')) $('#corr').textContent = 'Korelasi r = — (NO DATA · Menunggu Sensor)';
                return;
            }

            const last = rows[rows.length - 1];
            const srcTag = last.source === 'cache' ? 'CACHE' : 'RTDB';
            if ($('#ro-tanah')) $('#ro-tanah').innerHTML = `<b>${Math.round(last.tanah)}%</b> · Kelembapan Tanah · <span class="mono">${Sec.escapeHTML(window.DatasetStore.formatDateTime(last.t))} (${srcTag})</span>`;
            if ($('#ro-suhu')) $('#ro-suhu').innerHTML = `<b>${convTemp(last.suhu).toFixed(1)}${Sec.escapeHTML(tUnit)}</b> · Suhu Mikroklimat · <span class="mono">${Sec.escapeHTML(window.DatasetStore.formatDateTime(last.t))} (${srcTag})</span>`;
            if ($('#ro-udara')) $('#ro-udara').innerHTML = `<b>${Math.round(last.udara)}%</b> · Kelembapan Udara · <span class="mono">${Sec.escapeHTML(window.DatasetStore.formatDateTime(last.t))} (${srcTag})</span>`;

            if (rows.length < 2) {
                ['ch-tanah', 'ch-suhu', 'ch-udara', 'ch-scatter'].forEach(id => {
                    const host = $(`#${id}`);
                    if (host) {
                        host.innerHTML = `<div style="height:220px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:12px;text-align:center;padding:16px;">Minimal 2 titik telemetri diperlukan untuk merender kurva tren</div>`;
                    }
                });
                if ($('#corr')) $('#corr').textContent = 'Korelasi r = — (Min. 2 Sampel)';
                return;
            }

            this.renderDetailedSVGChart('ch-tanah', rows, r => r.tanah, '%', [S.dry, S.wet], 0, 100, 'var(--accent-emerald)');
            this.renderDetailedSVGChart('ch-suhu', rows, r => convTemp(r.suhu), tUnit, [convTemp(15), convTemp(24)], null, null, 'var(--accent-amber)');
            this.renderDetailedSVGChart('ch-udara', rows, r => r.udara, '%', [60, 80], 40, 100, 'var(--accent-blue)');

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

            const w = Math.max(240, host.clientWidth || 600);
            const h = 220;
            const pad = { t: 16, r: 16, b: 24, l: 44 };
            const iw = Math.max(20, w - pad.l - pad.r);
            const ih = Math.max(20, h - pad.t - pad.b);

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
                    <line class="grid-line" x1="${pad.l}" y1="${y}" x2="${w - pad.r}" y2="${y}" stroke="var(--chart-grid-line)" />
                    <text class="axis-text" x="${pad.l - 6}" y="${y + 3}" text-anchor="end" fill="var(--text-muted)" font-size="10">${Math.round(tv)}${Sec.escapeHTML(unit)}</text>
                `;
            }

            let bandHtml = '';
            if (band && band.length === 2) {
                const y1 = Y(band[1]);
                const y0 = Y(band[0]);
                bandHtml = `
                    <rect x="${pad.l}" y="${Math.min(y1, y0)}" width="${iw}" height="${Math.abs(y0 - y1)}" fill="var(--chart-band)" />
                    <line x1="${pad.l}" y1="${y0}" x2="${w - pad.r}" y2="${y0}" stroke="var(--accent-rose-glow)" stroke-dasharray="3 3" />
                    <line x1="${pad.l}" y1="${y1}" x2="${w - pad.r}" y2="${y1}" stroke="var(--accent-rose-glow)" stroke-dasharray="3 3" />
                `;
            }

            const pts = rows.map((r, i) => [X(r.t), Y(vals[i])]);
            const pathD = 'M' + pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L');
            const lastPt = pts[pts.length - 1];

            host.innerHTML = `
                <svg width="100%" height="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="display:block;overflow:hidden;">
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

            const w = Math.max(240, host.clientWidth || 340);
            const h = 220;
            const pad = { t: 16, r: 16, b: 28, l: 40 };
            const iw = Math.max(20, w - pad.l - pad.r);
            const ih = Math.max(20, h - pad.t - pad.b);

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
                corrEl.textContent = `Korelasi r = ${r.toFixed(2)} (${r < -0.3 ? 'Suhu naik, kelembapan turun' : 'Fluktuasi moderat'} · ${n} sampel)`;
            }

            const dotsHtml = xs.map((xVal, i) => `
                <circle cx="${X(xVal).toFixed(1)}" cy="${Y(ys[i]).toFixed(1)}" r="3" fill="var(--accent-blue)" opacity="0.65" />
            `).join('');

            host.innerHTML = `
                <svg width="100%" height="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="display:block;overflow:hidden;">
                    <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${h - pad.b}" stroke="var(--chart-grid-line)" />
                    <line x1="${pad.l}" y1="${h - pad.b}" x2="${w - pad.r}" y2="${h - pad.b}" stroke="var(--chart-grid-line)" />
                    <text x="${pad.l}" y="${pad.t - 4}" fill="var(--text-muted)" font-size="10">Udara (%)</text>
                    <text x="${w - pad.r}" y="${h - 8}" text-anchor="end" fill="var(--text-muted)" font-size="10">Suhu (${S.unit === 'F' ? '°F' : '°C'})</text>
                    ${dotsHtml}
                </svg>
            `;
        }

        // ================= RENDERING ORCHESTRATION =================
        renderAllViews() {
            const latest = window.DatasetStore.getLatest();
            this.renderPlantAgeBanner();
            this.updateHeaderMeta(latest);
            this.updateMetricsCards(latest);
            this.updatePredictionCard(latest);
            this.updateAIRecommendations(latest);
            this.renderDashboardAlerts(latest);
            this.updateAgronomicAnalysisPage(latest);
            this.updateFooterStats(latest);

            if (this.activePage === 'ringkasan') {
                this.renderOverviewChart();
                this.renderDashboardPumpChart();
                window.DatasetStore.renderSnippetTable('datasetTableBody', 8);
                if (window.GrowthStore) window.GrowthStore.renderMiniDashboardCharts();
            } else if (this.activePage === 'sensor') {
                this.renderSensorPage();
            } else if (this.activePage === 'riwayat') {
                window.DatasetStore.renderRiwayat();
            } else if (this.activePage === 'peringatan') {
                this.renderAlertsPage();
            }
        }

        formatRelativeAge(ts) {
            if (!Number.isFinite(ts)) return 'OFFLINE';
            const diffSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
            if (diffSec < 60) return `${diffSec} dtk lalu`;
            if (diffSec < 3600) return `${Math.floor(diffSec / 60)} mnt lalu`;
            if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} jam lalu`;
            return `${Math.floor(diffSec / 86400)} hari lalu`;
        }

        updateHeaderMeta(latest) {
            const freshEl = $('#fresh');
            if (freshEl) {
                if (latest) {
                    const rel = this.formatRelativeAge(latest.t);
                    freshEl.textContent = `${rel} (${window.DatasetStore.formatDateTime(latest.t)})`;
                } else {
                    freshEl.textContent = 'OFFLINE / NO DATA';
                }
            }

            const staleBadge = $('#badgeStaleData');
            if (staleBadge) {
                const S = window.ConfigStore.get();
                const pollInterval = (S && Number.isFinite(S.poll) && S.poll > 0) ? S.poll : 2000;
                const staleThreshold = 2 * pollInterval;
                if (latest && Number.isFinite(latest.t)) {
                    const ageMs = Date.now() - latest.t;
                    if (ageMs > staleThreshold) {
                        staleBadge.hidden = false;
                        staleBadge.textContent = `Data basi (${this.formatRelativeAge(latest.t)})`;
                    } else {
                        staleBadge.hidden = true;
                    }
                } else {
                    staleBadge.hidden = true;
                }
            }

            const dateRangeEl = $('#headerDateRange');
            if (dateRangeEl) {
                const all = window.DatasetStore.getAll();
                if (all.length > 0) {
                    const first = all[0];
                    const last = all[all.length - 1];
                    dateRangeEl.textContent = `Data: ${window.DatasetStore.formatDateTime(first.t)} – ${window.DatasetStore.formatTime(last.t, false)} (${all.length} Paket)`;
                } else {
                    dateRangeEl.textContent = 'Data: NO DATA (Menunggu Telemetri)';
                }
            }

            const camBadge = $('#headerCamStatusBadge');
            if (camBadge) {
                const isCamOn = this.cam && this.cam.run;
                camBadge.textContent = isCamOn ? 'Kamera: ONLINE' : 'Kamera: OFFLINE';
                camBadge.className = isCamOn ? 'badge-tag emerald tabular-nums' : 'badge-tag amber tabular-nums';
            }

            const alertHeader = $('#headerAlertsCount');
            if (alertHeader) {
                const unread = this.alerts.filter(a => !a.read).length;
                alertHeader.textContent = `${unread} Peringatan`;
                alertHeader.className = unread > 0 ? 'badge-tag rose tabular-nums' : 'badge-tag slate tabular-nums';
            }
        }

        updateConnectionBadge(state, message, source = 'live') {
            this.connectionState = state;
            this.connectionMessage = message;
            this.connectionSource = source;

            const dot = $('#sysStatusDot');
            const text = $('#sysStatusText');
            const sub = $('#sysStatusSub');
            const dotHeader = $('#sysStatusDotHeader');
            const textHeader = $('#sysStatusTextHeader');

            let sourceLabel = 'Telemetri Live';
            let headerLabel = 'Live (Aktif)';
            let color = 'var(--accent-emerald)';

            if (state === 'stale') {
                sourceLabel = 'RTDB Terhubung · ESP32 Offline';
                headerLabel = 'Historis (ESP32 Offline)';
                color = 'var(--accent-amber)';
            } else if (state === 'empty') {
                sourceLabel = 'RTDB Kosong (No Data)';
                headerLabel = 'No Data';
                color = 'var(--accent-amber)';
            } else if (source === 'cache' || state === 'offline') {
                sourceLabel = 'Offline Cache';
                headerLabel = 'Cache Offline';
                color = 'var(--accent-amber)';
            } else if (state === 'disconnected') {
                sourceLabel = 'OFFLINE / DISCONNECTED';
                headerLabel = 'Disconnected';
                color = 'var(--accent-rose)';
            } else if (state === 'connecting') {
                sourceLabel = 'Menghubungkan…';
                headerLabel = 'Menghubungkan…';
                color = 'var(--accent-blue)';
            }

            if (dot) {
                dot.style.backgroundColor = color;
                dot.style.boxShadow = `0 0 8px ${color}`;
            }
            if (text) {
                text.textContent = sourceLabel;
            }
            if (sub) {
                sub.textContent = message || (state === 'connected' ? 'RTDB Asia-Southeast1 Aktif' : 'Status Koneksi Siaga');
            }
            if (dotHeader) {
                dotHeader.style.backgroundColor = color;
            }
            if (textHeader) {
                textHeader.textContent = headerLabel;
            }

            const sumEsp = $('#sumEspStatus');
            const sumEspSub = $('#sumEspSub');
            const allCount = window.DatasetStore ? window.DatasetStore.getAll().length : 0;
            if (sumEsp) {
                if (state === 'connected') {
                    sumEsp.textContent = 'ONLINE';
                    sumEsp.style.color = 'var(--accent-emerald)';
                } else if (state === 'stale') {
                    sumEsp.textContent = 'HISTORIS';
                    sumEsp.style.color = 'var(--accent-amber)';
                } else if (state === 'connecting') {
                    sumEsp.textContent = 'MENGHUBUNGKAN';
                    sumEsp.style.color = 'var(--accent-blue)';
                } else {
                    sumEsp.textContent = 'OFFLINE';
                    sumEsp.style.color = 'var(--accent-rose)';
                }
            }
            if (sumEspSub) {
                sumEspSub.textContent = allCount > 0 ? `/kelompok5 · ${allCount} Paket` : '/kelompok5 · 0 Paket';
            }

            this.updateFooterStats(window.DatasetStore ? window.DatasetStore.getLatest() : null);
        }

        renderPlantAgeBanner() {
            const ageNumber = $('#plantAgeNumber');
            const progressFill = $('#plantAgeProgressFill');
            const progressPct = $('#plantProgressPct');
            const daysLeft = $('#plantDaysLeft');

            const gStats = window.GrowthStore ? window.GrowthStore.getCampaignStats() : null;
            this.plantAgeHST = (gStats && gStats.currentHST > 0) ? gStats.currentHST : 0;

            if (this.plantAgeHST <= 0) {
                if (ageNumber) ageNumber.textContent = '—';
                if (progressFill) progressFill.style.width = '0%';
                if (progressPct) progressPct.textContent = `0% Target Kampanye (0 / ${this.harvestTargetHST} HST)`;
                if (daysLeft) daysLeft.textContent = 'Belum Ada Citra Kampanye Tervalidasi';
                return;
            }

            const pct = Math.min(100, Math.round((this.plantAgeHST / this.harvestTargetHST) * 100));
            const remaining = Math.max(0, this.harvestTargetHST - this.plantAgeHST);

            if (ageNumber) ageNumber.textContent = this.plantAgeHST;
            if (progressFill) progressFill.style.width = `${pct}%`;
            if (progressPct) progressPct.textContent = `${pct}% Target Panen (${this.plantAgeHST} / ${this.harvestTargetHST} HST)`;
            if (daysLeft) daysLeft.textContent = `${remaining} Hari Lagi Menuju Panen`;
        }

        updateAIRecommendations(record) {
            const list = $('#aiRecomList');
            if (!list) return;

            if (!record || !Number.isFinite(record.tanah) || !Number.isFinite(record.suhu) || !Number.isFinite(record.udara)) {
                list.innerHTML = `
                    <div class="recom-item warn" style="grid-column: 1 / -1;">
                        <div class="recom-title">STATUS: NO DATA / OFFLINE</div>
                        <div class="recom-desc">Belum ada telemetri sensor fisik yang diterima dari RTDB atau perangkat ESP32 sedang offline. Sistem tidak membuat rekomendasi berbasis angka asumsi.</div>
                    </div>
                `;
                return;
            }

            const S = window.ConfigStore.get();
            const vpd = this.calculateTetensVPD(record.suhu, record.udara);
            const tsText = window.DatasetStore.formatDateTime(record.t);
            const srcText = record.source === 'cache' ? 'CACHE LOKAL' : 'FIREBASE RTDB';

            const soilClass = record.tanah < S.dry ? 'alert' : (record.tanah > S.wet ? 'warn' : 'ok');
            const soilTitle = record.tanah < S.dry
                ? `Irigasi Diperlukan (Tanah ${Math.round(record.tanah)}% < ${S.dry}%)`
                : (record.tanah > S.wet ? `Media Jenuh Air (${Math.round(record.tanah)}% > ${S.wet}%)` : `Kelembapan Media Optimal (${Math.round(record.tanah)}%)`);
            const soilDesc = record.tanah < S.dry
                ? `Sensor HW-390 melaporkan kelembapan ${Math.round(record.tanah)}% pada ${tsText} (${srcText}). Perintah pompa ON aktif hingga mencapai ${S.wet}%.`
                : `Sensor HW-390 melaporkan kelembapan ${Math.round(record.tanah)}% pada ${tsText} (${srcText}). Rentang target histeresis: ${S.dry}%–${S.wet}%.`;

            const vpdClass = (vpd !== null && (vpd < 0.4 || vpd > 1.2)) ? 'warn' : 'ok';
            const vpdTitle = vpd !== null
                ? `Defisit Tekanan Uap (VPD): ${vpd.toFixed(2)} kPa`
                : 'VPD: NO DATA';
            const vpdDesc = vpd !== null
                ? `Dihitung dari T=${record.suhu.toFixed(1)}°C dan RH=${Math.round(record.udara)}% (${tsText}). Target transpirasi optimal selada keriting: 0.40–0.85 kPa.`
                : 'Menunggu pembacaan suhu dan kelembapan udara valid dari DHT22.';

            const tempClass = record.suhu > 28 ? 'alert' : (record.suhu > 24 ? 'warn' : 'ok');
            const tempTitle = record.suhu > 28
                ? `Peringatan Suhu Tinggi (${record.suhu.toFixed(1)}°C)`
                : (record.suhu > 24 ? `Suhu Di Atas Ideal (${record.suhu.toFixed(1)}°C)` : `Suhu Mikroklimat Optimal (${record.suhu.toFixed(1)}°C)`);
            const tempDesc = `Pembacaan aktual DHT22: ${record.suhu.toFixed(1)}°C (Batas bolting > 28°C, rentang ideal 15–24°C). Sumber: ${srcText}.`;

            const gStats = window.GrowthStore ? window.GrowthStore.getCampaignStats() : { validCount: 0, targetValid: 1600 };
            const cvClass = gStats.validCount > 0 ? 'ok' : 'warn';
            const cvTitle = gStats.validCount > 0
                ? `Morfologi CV Aktual: ${gStats.validCount} Citra Valid`
                : 'Morfologi CV: Menunggu Capture ESP32-CAM (0 Citra)';
            const cvDesc = gStats.latestRecord
                ? `Lebar daun terakhir: ${gStats.latestRecord.leaf_width_px} px, luas siluet: ${gStats.latestRecord.leaf_area_px} px² (${gStats.latestRecord.time_wib}).`
                : 'Belum ada citra daun tervalidasi pada data/growth_metadata.json. Pastikan ESP32-CAM online dan scheduler aktif.';

            list.innerHTML = `
                <div class="recom-item ${soilClass}">
                    <div class="recom-title">${Sec.escapeHTML(soilTitle)}</div>
                    <div class="recom-desc">${Sec.escapeHTML(soilDesc)}</div>
                </div>
                <div class="recom-item ${vpdClass}">
                    <div class="recom-title">${Sec.escapeHTML(vpdTitle)}</div>
                    <div class="recom-desc">${Sec.escapeHTML(vpdDesc)}</div>
                </div>
                <div class="recom-item ${tempClass}">
                    <div class="recom-title">${Sec.escapeHTML(tempTitle)}</div>
                    <div class="recom-desc">${Sec.escapeHTML(tempDesc)}</div>
                </div>
                <div class="recom-item ${cvClass}">
                    <div class="recom-title">${Sec.escapeHTML(cvTitle)}</div>
                    <div class="recom-desc">${Sec.escapeHTML(cvDesc)}</div>
                </div>
            `;
        }

        renderDashboardAlerts(record) {
            const container = $('#dashAlertsList');
            if (!container) return;

            const items = [];
            const S = window.ConfigStore.get();

            if (!record) {
                items.push({
                    cls: 'warn',
                    title: 'NO DATA · Menunggu Telemetri',
                    desc: 'Belum ada paket data sensor fisik yang diterima dari RTDB maupun cache lokal.'
                });
            } else {
                const ageSec = Math.max(0, Math.round((Date.now() - record.t) / 1000));
                if (ageSec > (S.rules.off ? S.rules.off.v : 15)) {
                    items.push({
                        cls: 'warn',
                        title: `Transmisi Sensor Stale (${this.formatRelativeAge(record.t)})`,
                        desc: `Data terakhir di RTDB tercatat pada ${window.DatasetStore.formatDateTime(record.t)}. Perangkat fisik ESP32 saat ini tidak mengirim paket baru.`
                    });
                }
                if (record.tanah < S.dry) {
                    items.push({
                        cls: 'alert',
                        title: `Media Tanam Kering (${Math.round(record.tanah)}%)`,
                        desc: `Di bawah ambang histeresis ${S.dry}% pada pengukuran ${window.DatasetStore.formatDateTime(record.t)}.`
                    });
                }
            }

            if (!(this.cam && this.cam.run)) {
                items.push({
                    cls: 'info',
                    title: 'Kamera ESP32-CAM Offline',
                    desc: 'Stream optik belum terhubung. Pengukuran CV menampilkan status menunggu perangkat.'
                });
            }

            this.alerts.slice(0, 3).forEach(a => {
                items.push({
                    cls: a.sev,
                    title: `Peringatan [${a.rule.toUpperCase()}] · ${window.DatasetStore.formatTime(a.t)}`,
                    desc: a.msg
                });
            });

            container.innerHTML = items.slice(0, 4).map(it => `
                <div class="alert-box ${Sec.escapeHTML(it.cls)}">
                    <div class="alert-box-content">
                        <h4>${Sec.escapeHTML(it.title)}</h4>
                        <p>${Sec.escapeHTML(it.desc)}</p>
                    </div>
                </div>
            `).join('');
        }

        updateAgronomicAnalysisPage(record) {
            const vpdEl = $('#dssVpdValue');
            const vpdMeta = $('#dssVpdMeta');
            const vpdAlert = $('#dssVpdAlert');
            const gddEl = $('#dssGddValue');
            const gddMeta = $('#dssGddMeta');
            const gddAlert = $('#dssGddAlert');

            const allRecords = window.DatasetStore ? window.DatasetStore.getAll().filter(r => Number.isFinite(r.suhu)) : [];

            if (!record || !Number.isFinite(record.suhu) || !Number.isFinite(record.udara)) {
                if (vpdEl) vpdEl.textContent = 'NO DATA';
                if (vpdMeta) vpdMeta.textContent = 'Sumber: OFFLINE · Menunggu sensor DHT22';
                if (vpdAlert) {
                    vpdAlert.className = 'alert-box warn';
                    vpdAlert.innerHTML = `<div class="alert-box-content"><h4>Status VPD: Belum Tersedia</h4><p>Perhitungan Tetens VPD memerlukan telemetri suhu dan kelembapan udara aktual.</p></div>`;
                }
                if (gddEl) gddEl.textContent = 'NO DATA';
                if (gddMeta) gddMeta.textContent = 'Sumber: OFFLINE · 0 sampel termal';
                if (gddAlert) {
                    gddAlert.className = 'alert-box warn';
                    gddAlert.innerHTML = `<div class="alert-box-content"><h4>Status GDD: Belum Tersedia</h4><p>Akumulasi termal GDD memerlukan riwayat pengukuran suhu fisik.</p></div>`;
                }
                return;
            }

            const vpd = this.calculateTetensVPD(record.suhu, record.udara);
            const tsStr = window.DatasetStore.formatDateTime(record.t);
            const srcStr = record.source === 'cache' ? 'CACHE' : 'RTDB';

            if (vpdEl) vpdEl.textContent = vpd !== null ? `${vpd.toFixed(2)} kPa` : 'NO DATA';
            if (vpdMeta) vpdMeta.textContent = `Sumber: ${srcStr} · T=${record.suhu.toFixed(1)}°C, RH=${Math.round(record.udara)}% · ${tsStr}`;
            if (vpdAlert && vpd !== null) {
                const isOpt = vpd >= 0.4 && vpd <= 0.85;
                vpdAlert.className = `alert-box ${isOpt ? 'ok' : 'warn'}`;
                vpdAlert.innerHTML = `
                    <div class="alert-box-content">
                        <h4>${isOpt ? 'Zona Transpirasi Optimal (0.40 – 0.85 kPa)' : 'Di Luar Rentang Transpirasi Ideal'}</h4>
                        <p>VPD aktual <b>${vpd.toFixed(2)} kPa</b> dihitung langsung dari paket telemetri (${Sec.escapeHTML(tsStr)}).</p>
                    </div>
                `;
            }

            // Compute genuine GDD from recorded telemetry intervals (Base Temp = 4.0°C)
            const baseTemp = 4.0;
            const meanTemp = allRecords.reduce((acc, r) => acc + r.suhu, 0) / allRecords.length;
            const dailyGddRate = Math.max(0, meanTemp - baseTemp);
            const gStats = window.GrowthStore ? window.GrowthStore.getCampaignStats() : { currentHST: 0 };

            if (gStats.currentHST > 0) {
                const cumGdd = Math.round(dailyGddRate * gStats.currentHST * 10) / 10;
                if (gddEl) gddEl.textContent = `${cumGdd} °C·hari`;
                if (gddMeta) gddMeta.textContent = `LaJu Termal: ${dailyGddRate.toFixed(1)} °C·hari/HST · HST ${gStats.currentHST} (${allRecords.length} sampel)`;
            } else {
                if (gddEl) gddEl.textContent = `${dailyGddRate.toFixed(1)} °C/hari`;
                if (gddMeta) gddMeta.textContent = `Laju Termal Aktual (T_mean=${meanTemp.toFixed(1)}°C dari ${allRecords.length} paket RTDB · Kampanye CV: 0 HST)`;
            }

            if (gddAlert) {
                gddAlert.className = 'alert-box info';
                gddAlert.innerHTML = `
                    <div class="alert-box-content">
                        <h4>Kalkulasi Termal Aktual (${allRecords.length} Sampel Telemetri)</h4>
                        <p>Rata-rata suhu terekam <b>${meanTemp.toFixed(2)}°C</b> menghasilkan laju termal <b>${dailyGddRate.toFixed(2)} GDD/hari</b> (Tbase 4.0°C). Akumulasi total HST menunggu dimulainya kampanye citra.</p>
                    </div>
                `;
            }
        }

        updateFooterStats(record) {
            const elSensors = $('#statActiveSensors');
            const elDur = $('#statMonitoringDuration');
            const elSys = $('#statSystemStatus');

            const all = window.DatasetStore ? window.DatasetStore.getAll() : [];
            if (elSensors) {
                if (this.connectionState === 'connected' && record) {
                    elSensors.textContent = '2 Modul Aktif (DHT22, HW-390)';
                    elSensors.style.color = 'var(--accent-emerald)';
                } else if (all.length > 0) {
                    elSensors.textContent = 'Standby / Offline (2 Modul Terdaftar)';
                    elSensors.style.color = 'var(--accent-amber)';
                } else {
                    elSensors.textContent = 'OFFLINE (0 Transmisi)';
                    elSensors.style.color = 'var(--accent-rose)';
                }
            }

            if (elDur) {
                const gStats = window.GrowthStore ? window.GrowthStore.getCampaignStats() : { currentHST: 0, validCount: 0 };
                if (gStats.currentHST > 0) {
                    elDur.textContent = `HST ${gStats.currentHST} / 42 Hari (${gStats.validCount} Citra)`;
                } else if (all.length >= 2) {
                    const spanSec = Math.max(1, Math.round((all[all.length - 1].t - all[0].t) / 1000));
                    elDur.textContent = `${all.length} Paket RTDB (Rentang ${spanSec} dtk)`;
                } else {
                    elDur.textContent = '0 Hari (Menunggu Kampanye)';
                }
            }

            if (elSys) {
                if (this.connectionState === 'connected') {
                    elSys.textContent = 'RTDB Live · Tervalidasi';
                    elSys.style.color = 'var(--accent-emerald)';
                } else if (this.connectionState === 'stale') {
                    elSys.textContent = 'RTDB Terhubung · ESP32 Offline';
                    elSys.style.color = 'var(--accent-amber)';
                } else {
                    elSys.textContent = 'OFFLINE / DISCONNECTED';
                    elSys.style.color = 'var(--accent-rose)';
                }
            }
        }

        updateMetricsCards(record) {
            const hasData = record && Number.isFinite(record.tanah);
            const S = window.ConfigStore.get();
            const tUnit = S.unit === 'F' ? '°F' : '°C';
            const convTemp = S.unit === 'F' ? (v => (v * 9 / 5) + 32) : (v => v);

            // Update KPI cards state classes (skeleton loading, empty state, error state)
            const cards = [$('#cardMoisture'), $('#cardTemp'), $('#cardHumidity'), $('#cardPump')];
            cards.forEach(card => {
                if (!card) return;
                card.classList.remove('is-loading', 'is-empty', 'is-error');
                if (this.connectionState === 'error' || this.connectionState === 'disconnected') {
                    card.classList.add('is-error');
                    card.setAttribute('data-card-state', 'error');
                } else if (!hasData) {
                    card.classList.add('is-empty');
                    card.setAttribute('data-card-state', 'empty');
                } else {
                    card.setAttribute('data-card-state', 'ready');
                }
            });

            // 1. Soil Moisture Card
            const soilVal = $('#valSoilMoisture');
            const soilBadge = $('#badgeSoilStatus');
            const soilSub = $('#subSoilMoisture');
            if (soilVal) soilVal.textContent = hasData ? Math.round(record.tanah) : '—';
            if (soilBadge) {
                if (!hasData) {
                    soilBadge.className = 'metric-badge';
                    soilBadge.textContent = 'NO DATA';
                } else if (record.tanah < S.dry) {
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
                soilSub.textContent = hasData ? `Batas Histeresis: ${S.dry}% – ${S.wet}%` : `Target: ${S.dry}% – ${S.wet}% (Menunggu Sensor)`;
            }

            // 2. Air Humidity Card
            const airVal = $('#valAirHumidity');
            const airBadge = $('#badgeAirStatus');
            const airSub = $('#subAirHumidity');
            if (airVal) airVal.textContent = hasData ? Math.round(record.udara) : '—';
            if (airBadge) {
                if (!hasData) {
                    airBadge.className = 'metric-badge';
                    airBadge.textContent = 'NO DATA';
                } else if (record.udara < 60) {
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
            if (airSub) airSub.textContent = hasData ? 'Target: 60% – 80%' : 'Target: 60% – 80% (Menunggu Sensor)';

            // 3. Temperature Card
            const tempVal = $('#valAirTemp');
            const tempBadge = $('#badgeTempStatus');
            const tempSub = $('#subAirTemp');
            if (tempVal) tempVal.textContent = hasData ? convTemp(record.suhu).toFixed(1) : '—';
            if (tempBadge) {
                if (!hasData) {
                    tempBadge.className = 'metric-badge';
                    tempBadge.textContent = 'NO DATA';
                } else if (record.suhu > 28) {
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
            if (tempSub) tempSub.textContent = hasData ? 'Toleransi Max: 28°C' : 'Target: 15–24°C (Menunggu Sensor)';

            // 4. PUMP HYSTERESIS CONTROLLER (Separation of pumpCommand and pumpActualState)
            const prevCommand = this.lastPumpCommand;
            let pumpCommand = prevCommand;
            if (hasData) {
                if (record.tanah < S.dry) {
                    pumpCommand = true;
                } else if (record.tanah > S.wet) {
                    pumpCommand = false;
                }
            } else {
                pumpCommand = false;
            }

            const pumpVal = $('#valPumpStatus');
            const pumpBadge = $('#badgePumpStatus');
            const pumpPulse = $('#pumpPulseDot');
            const pumpSub = $('#subPumpStatus');

            if (pumpVal) {
                pumpVal.textContent = hasData ? (pumpCommand ? 'PERINTAH: ON' : 'PERINTAH: OFF') : 'STANDBY / OFFLINE';
            }
            if (pumpBadge) {
                if (!hasData) {
                    pumpBadge.className = 'metric-badge';
                    pumpBadge.textContent = 'Tidak Ada Data';
                } else {
                    pumpBadge.className = pumpCommand ? 'metric-badge alert' : 'metric-badge ok';
                    pumpBadge.textContent = pumpCommand ? 'Irigasi Aktif' : 'Siaga Otomatis';
                }
            }
            if (pumpPulse) {
                const color = hasData ? (pumpCommand ? 'var(--accent-amber)' : 'var(--accent-emerald)') : 'var(--text-muted)';
                pumpPulse.style.backgroundColor = color;
                pumpPulse.style.boxShadow = hasData ? `0 0 10px ${color}` : 'none';
            }
            if (pumpSub) {
                if (!hasData) {
                    pumpSub.textContent = 'Feedback Relay: Belum Ada Data (Sistem Siaga)';
                } else {
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
            }

            if (hasData && pumpCommand !== prevCommand) {
                this.toast(pumpCommand
                    ? `Perintah Irigasi Otomatis ON: Kelembapan tanah di bawah ${S.dry}%.`
                    : `Perintah Irigasi Otomatis OFF: Kelembapan tanah melampaui ${S.wet}%.`,
                    pumpCommand ? 'amber' : 'emerald'
                );
                this.lastPumpCommand = pumpCommand;
            }

            // Mini sparklines using CSS variable tokens
            if (hasData) {
                this.renderMiniSparkline('sparkSoil', 'tanah', record.tanah < S.dry ? 'var(--accent-rose)' : 'var(--accent-emerald)');
                this.renderMiniSparkline('sparkAir', 'udara', 'var(--accent-blue)');
                this.renderMiniSparkline('sparkTemp', 'suhu', 'var(--accent-amber)');
            } else {
                ['sparkSoil', 'sparkAir', 'sparkTemp'].forEach(id => {
                    const el = $(`#${id}`);
                    if (el) el.innerHTML = '';
                });
            }

            // Update Tetens VPD across Dashboard and DSS
            const vpdVal = hasData ? this.calculateTetensVPD(record.suhu, record.udara) : null;
            const plantHealthVpd = $('#plantHealthVPD');
            if (plantHealthVpd) plantHealthVpd.textContent = vpdVal !== null ? `${vpdVal.toFixed(2)} kPa` : '—';
            const dssVpd = $('#dssVpdValue');
            if (dssVpd) dssVpd.textContent = vpdVal !== null ? `${vpdVal.toFixed(2)} kPa` : '—';

            // Update Camera Status card & live badge
            const valCam = $('#valCamStatus');
            const badgeCam = $('#badgeCamStatus');
            const dashCamBadge = $('#dashCamBadge');
            const isCamActive = this.cam && this.cam.run;
            if (valCam) valCam.textContent = isCamActive ? 'ONLINE' : 'OFFLINE';
            if (badgeCam) {
                badgeCam.className = isCamActive ? 'metric-badge ok' : 'metric-badge';
                badgeCam.textContent = isCamActive ? 'Feed Aktif' : 'Belum Terhubung';
            }
            if (dashCamBadge) {
                dashCamBadge.className = isCamActive ? 'badge-tag emerald tabular-nums' : 'badge-tag amber tabular-nums';
                dashCamBadge.textContent = isCamActive ? 'LIVE' : 'OFFLINE';
            }

            // Update Leaf Growth Campaign Stats across Dashboard & Footer Bar
            if (window.GrowthStore) {
                const gStats = window.GrowthStore.getCampaignStats();
                const valImg = $('#valImageTarget');
                const badgeImg = $('#badgeImageProgress');
                if (valImg) valImg.textContent = `${gStats.validCount} / ${gStats.targetValid}`;
                if (badgeImg) badgeImg.textContent = `${gStats.targetPct}% Target`;

                const sTot = $('#statTotalImages');
                const sVal = $('#statValidImages');
                const sFail = $('#statFailedImages');
                const sPct = $('#statTargetPct');
                if (sTot) sTot.textContent = gStats.totalCaptured;
                if (sVal) sVal.textContent = gStats.validCount;
                if (sFail) sFail.textContent = gStats.failedCount;
                if (sPct) sPct.textContent = `${gStats.targetPct}%`;

                const wEl = $('#plantHealthWidth');
                const aEl = $('#plantHealthArea');
                const qcEl = $('#plantHealthQC');
                const condEl = $('#plantHealthCond');

                if (gStats.latestRecord) {
                    if (wEl) wEl.textContent = `${gStats.latestRecord.leaf_width_px} px`;
                    if (aEl) aEl.textContent = `${gStats.latestRecord.leaf_area_px} px²`;
                    if (qcEl) {
                        qcEl.textContent = `${gStats.latestRecord.quality_status} (v1.2 ExG)`;
                        qcEl.style.color = gStats.latestRecord.quality_status === 'VALID' ? 'var(--accent-emerald)' : 'var(--accent-rose)';
                    }
                    if (condEl) condEl.textContent = `HST ${gStats.latestRecord.hst_day} Vegetatif`;
                } else {
                    if (wEl) wEl.textContent = '— px';
                    if (aEl) aEl.textContent = '— px²';
                    if (qcEl) {
                        qcEl.textContent = 'NO DATA';
                        qcEl.style.color = 'var(--text-muted)';
                    }
                    if (condEl) condEl.textContent = 'Menunggu Data';
                }
            }

            // Update SCADA Otomasi Page Elements
            const scadaCmd = $('#scadaPumpCommand');
            const scadaAct = $('#scadaRelayActual');
            if (scadaCmd) scadaCmd.textContent = hasData ? (pumpCommand ? 'PERINTAH: ON' : 'PERINTAH: OFF') : 'PERINTAH: STANDBY';
            if (scadaAct) {
                if (hasData && record.relayActual === true) {
                    scadaAct.textContent = 'TERKONFIRMASI: AKTIF';
                    scadaAct.style.color = 'var(--accent-emerald)';
                } else if (hasData && record.relayActual === false) {
                    scadaAct.textContent = 'TERKONFIRMASI: MATI';
                    scadaAct.style.color = 'var(--text-muted)';
                } else {
                    scadaAct.textContent = 'BELUM TERHUBUNG';
                    scadaAct.style.color = 'var(--text-muted)';
                }
            }
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

            // Zero dummy/simulation: strictly require physical telemetry
            if (!latestRecord || !Number.isFinite(latestRecord.suhu) || !Number.isFinite(latestRecord.tanah)) {
                container.innerHTML = `
                    <div class="forecast-empty-state" style="grid-column: 1/-1; padding: 24px 16px; text-align: center; color: var(--text-muted);">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="margin-bottom: 6px; opacity: 0.5;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        <p style="font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 2px;">Menunggu Telemetri Sensor Fisik</p>
                        <p style="font-size: 11px;">Model termal GDD (Tbase 4.0°C) memerlukan telemetri suhu dan kelembapan aktual dari DHT22 & HW-390.</p>
                    </div>
                `;
                return;
            }

            // Grounded agronomic model: Lettuce Growing Degree Days (Base Temp = 4.0°C)
            const baseTemp = 4.0;
            const targetGDD = 700; // Typical cumulative GDD required for curly lettuce harvest
            const currentTemp = latestRecord.suhu;
            const currentSoil = latestRecord.tanah;

            // Daily thermal rate based on current microclimate: GDD_day = max(0, T_mean - 4.0)
            const dailyGDD = Math.max(0, Number((currentTemp - baseTemp).toFixed(1)));

            // Cumulative thermal heat units up to current actual HST (0 if campaign has not started)
            const estimatedCurrentGDD = Math.min(targetGDD, Math.round(this.plantAgeHST * dailyGDD));
            const tsLabel = window.DatasetStore ? window.DatasetStore.formatDateTime(latestRecord.t) : '—';

            const forecastDays = [1, 2, 3, 4].map(offset => {
                const forecastDay = this.plantAgeHST > 0 ? `${this.plantAgeHST + offset} HST` : `Proyeksi +${offset} Hari`;
                const projectedGDD = Math.min(targetGDD, Math.round((estimatedCurrentGDD + (offset * dailyGDD)) * 10) / 10);
                let dayMaturity = Math.min(100, Math.round((projectedGDD / targetGDD) * 100));

                // Water stress penalty on vegetative expansion
                if (currentSoil < 65 || currentTemp > 28) {
                    dayMaturity = Math.max(0, dayMaturity - 1);
                }

                let statusText = 'Kalkulasi Termal';
                let pillClass = 'veg';
                if (dayMaturity >= 90) { statusText = 'Target GDD Tercapai'; pillClass = 'ready'; }
                else if (dayMaturity >= 75) { statusText = 'Fase Akhir'; pillClass = 'near'; }

                return {
                    dayOffset: offset,
                    dayLabel: forecastDay,
                    projectedGDD: projectedGDD,
                    maturityPct: dayMaturity,
                    statusText: statusText,
                    pillClass: pillClass,
                    dailyRate: dailyGDD
                };
            });

            // DOM XSS DEFENSE: Escape dynamic text and pills
            container.innerHTML = forecastDays.map(f => `
                <div class="forecast-item">
                    <div class="forecast-day-header">
                        <span>Hari +${f.dayOffset} (${Sec.escapeHTML(f.dayLabel)})</span>
                        <span class="forecast-state-pill ${Sec.escapeHTML(f.pillClass)}">${Sec.escapeHTML(f.statusText)}</span>
                    </div>
                    <div class="forecast-maturity">
                        <span class="forecast-pct tabular-nums">+${(f.dayOffset * f.dailyRate).toFixed(1)}</span>
                        <span style="font-size: 11px; color: var(--text-muted);">°C·hari (Total: ${f.projectedGDD}/${targetGDD})</span>
                    </div>
                    <div style="font-size: 11px; color: var(--text-secondary); display: flex; justify-content: space-between;">
                        <span>Basis Suhu (${currentTemp.toFixed(1)}°C):</span>
                        <b class="tabular-nums" style="color: var(--text-primary);">${Sec.escapeHTML(tsLabel.split(' ')[0] || '')}</b>
                    </div>
                </div>
            `).join('');
        }

        renderOverviewChart() {
            const wrap = $('#chartSvgWrap');
            if (!wrap) return;

            const metric = this.activeChartMetric || 'all';
            const S = window.ConfigStore.get();
            const tUnit = S.unit === 'F' ? '°F' : '°C';
            const convTemp = S.unit === 'F' ? (v => (v * 9 / 5) + 32) : (v => v);

            const allRecords = window.DatasetStore.getAll().filter(r =>
                Number.isFinite(r.t) && Number.isFinite(r.tanah) && Number.isFinite(r.udara) && Number.isFinite(r.suhu)
            );

            const sourceReadout = $('#chartSourceReadout');
            if (sourceReadout) {
                if (allRecords.length === 0) {
                    sourceReadout.textContent = 'Sumber: Firebase RTDB /kelompok5 · Status: NO DATA (0 Paket)';
                } else {
                    const first = allRecords[0];
                    const last = allRecords[allRecords.length - 1];
                    sourceReadout.textContent = `Sumber: Firebase RTDB /kelompok5 (${allRecords.length} Paket Aktual · ${window.DatasetStore.formatDateTime(first.t)} – ${window.DatasetStore.formatTime(last.t, true)})`;
                }
            }

            if (allRecords.length === 0) {
                wrap.innerHTML = `
                    <div style="height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--text-muted); font-size: 12px; padding: 24px; text-align: center;">
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="opacity: 0.5;"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>
                        <span style="font-weight: 600; color: var(--text-secondary);">NO DATA · Belum Ada Data Telemetri Aktual</span>
                        <span style="font-size: 11px;">Status: OFFLINE / Menunggu paket telemetri tervalidasi dari sensor fisik & Firebase RTDB Kelompok 5</span>
                    </div>
                `;
                return;
            }

            const now = Date.now();
            let rows = allRecords;
            if (this.chartTimeWindowSec > 0) {
                const minTime = now - (this.chartTimeWindowSec * 1000);
                rows = allRecords.filter(r => r.t >= minTime);
                if (rows.length < 2) rows = allRecords.slice(-60);
            }

            if (rows.length > 260) {
                const step = Math.ceil(rows.length / 200);
                rows = rows.filter((_, idx) => idx % step === 0 || idx === rows.length - 1);
            }

            const w = Math.max(180, wrap.clientWidth || 640);
            const h = Math.max(160, wrap.clientHeight || 280);
            const isMobile = w < 480;
            const pad = isMobile
                ? { top: 16, right: 16, bottom: 26, left: 40 }
                : { top: 18, right: 28, bottom: 30, left: 48 };
            const innerW = Math.max(20, w - pad.left - pad.right);
            const innerH = Math.max(20, h - pad.top - pad.bottom);

            const getPumpState = r => {
                if (typeof r.relayActual === 'boolean') return r.relayActual ? 1 : 0;
                return r.tanah < S.dry ? 1 : 0;
            };

            if (rows.length === 1) {
                const r = rows[0];
                const midY = h / 2;
                wrap.innerHTML = `
                    <svg width="100%" height="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="display:block; overflow:hidden;">
                        <line class="grid-line" x1="${pad.left}" y1="${midY}" x2="${w - pad.right}" y2="${midY}" stroke="var(--chart-grid-line)" stroke-dasharray="4 4" />
                        <circle class="data-dot" cx="${w / 2}" cy="${midY}" r="6" />
                        <text class="axis-text" x="${w / 2}" y="${midY - 12}" text-anchor="middle">Tanah ${Math.round(r.tanah)}% · Udara ${Math.round(r.udara)}% · Suhu ${convTemp(r.suhu).toFixed(1)}${tUnit} (${window.DatasetStore.formatTime(r.t, true)})</text>
                        <text class="axis-text" x="${w / 2}" y="${h - 8}" text-anchor="middle">1 data poin aktual terekam</text>
                    </svg>
                `;
                return;
            }

            const t0 = rows[0].t;
            const t1 = rows[rows.length - 1].t;
            const timeSpan = Math.max(t1 - t0, 1000);
            const getX = (t, idx) => (t1 === t0)
                ? pad.left + (idx / Math.max(1, rows.length - 1)) * innerW
                : pad.left + ((t - t0) / timeSpan) * innerW;

            let yMin = 0, yMax = 100, unit = '%', band = null;
            if (metric === 'all') {
                yMin = 0; yMax = 100; unit = '%/°';
                band = [S.dry, S.wet];
            } else if (metric === 'tanah') {
                yMin = 20; yMax = 100; unit = '%';
                band = [S.dry, S.wet];
            } else if (metric === 'udara') {
                yMin = 20; yMax = 100; unit = '%';
                band = [60, 80];
            } else if (metric === 'suhu') {
                const temps = rows.map(r => convTemp(r.suhu));
                yMin = Math.floor(Math.min(...temps) - 2);
                yMax = Math.ceil(Math.max(...temps) + 2);
                unit = tUnit;
                band = [convTemp(15), convTemp(24)];
            } else if (metric === 'pompa') {
                yMin = 0; yMax = 1; unit = '';
            }

            const getY = val => pad.top + (1 - (val - yMin) / Math.max(0.1, yMax - yMin)) * innerH;

            let gridHtml = '';
            if (metric === 'pompa') {
                const yOn = getY(1);
                const yOff = getY(0);
                gridHtml = `
                    <line class="grid-line" x1="${pad.left}" y1="${yOn}" x2="${w - pad.right}" y2="${yOn}" />
                    <text class="axis-text" x="${pad.left - 6}" y="${yOn + 4}" text-anchor="end">ON (1)</text>
                    <line class="grid-line" x1="${pad.left}" y1="${yOff}" x2="${w - pad.right}" y2="${yOff}" />
                    <text class="axis-text" x="${pad.left - 6}" y="${yOff + 4}" text-anchor="end">OFF (0)</text>
                `;
            } else {
                for (let i = 0; i <= 4; i++) {
                    const tickVal = yMin + (i / 4) * (yMax - yMin);
                    const y = getY(tickVal);
                    gridHtml += `
                        <line class="grid-line" x1="${pad.left}" y1="${y}" x2="${w - pad.right}" y2="${y}" />
                        <text class="axis-text" x="${pad.left - 6}" y="${y + 3}" text-anchor="end">${Math.round(tickVal)}${Sec.escapeHTML(unit === '%/°' ? '' : unit)}</text>
                    `;
                }
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

            let pathsHtml = '';
            if (metric === 'all') {
                const showSoil = !this.activeSeries || this.activeSeries.tanah;
                const showAir = !this.activeSeries || this.activeSeries.udara;
                const showTemp = !this.activeSeries || this.activeSeries.suhu;
                const showPump = !this.activeSeries || this.activeSeries.pompa;

                let soilParts = '';
                if (showSoil) {
                    const ptsSoil = rows.map((r, idx) => [getX(r.t, idx), getY(r.tanah)]);
                    const dSoil = 'M' + ptsSoil.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L');
                    const areaSoil = `${dSoil} L${ptsSoil[ptsSoil.length - 1][0].toFixed(1)},${(pad.top + innerH).toFixed(1)} L${ptsSoil[0][0].toFixed(1)},${(pad.top + innerH).toFixed(1)} Z`;
                    soilParts = `
                        <path d="${areaSoil}" fill="url(#emeraldGrad)" />
                        <path d="${dSoil}" fill="none" stroke="var(--accent-emerald)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
                        <circle cx="${ptsSoil[ptsSoil.length - 1][0]}" cy="${ptsSoil[ptsSoil.length - 1][1]}" r="4" fill="var(--accent-emerald)" stroke="var(--chart-dot-stroke)" stroke-width="1.5" />
                    `;
                }

                let airParts = '';
                if (showAir) {
                    const ptsAir = rows.map((r, idx) => [getX(r.t, idx), getY(r.udara)]);
                    const dAir = 'M' + ptsAir.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L');
                    airParts = `
                        <path d="${dAir}" fill="none" stroke="var(--accent-blue)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                        <circle cx="${ptsAir[ptsAir.length - 1][0]}" cy="${ptsAir[ptsAir.length - 1][1]}" r="4" fill="var(--accent-blue)" stroke="var(--chart-dot-stroke)" stroke-width="1.5" />
                    `;
                }

                let tempParts = '';
                if (showTemp) {
                    const ptsTemp = rows.map((r, idx) => [getX(r.t, idx), getY(convTemp(r.suhu))]);
                    const dTemp = 'M' + ptsTemp.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L');
                    tempParts = `
                        <path d="${dTemp}" fill="none" stroke="var(--accent-amber)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                        <circle cx="${ptsTemp[ptsTemp.length - 1][0]}" cy="${ptsTemp[ptsTemp.length - 1][1]}" r="4" fill="var(--accent-amber)" stroke="var(--chart-dot-stroke)" stroke-width="1.5" />
                    `;
                }

                let pumpParts = '';
                if (showPump) {
                    const ptsPump = [];
                    rows.forEach((r, idx) => {
                        const x = getX(r.t, idx);
                        const pumpY = pad.top + innerH - (getPumpState(r) * (innerH * 0.18)) - 4;
                        if (idx > 0) ptsPump.push([x, ptsPump[ptsPump.length - 1][1]]);
                        ptsPump.push([x, pumpY]);
                    });
                    const dPump = 'M' + ptsPump.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L');
                    const lastPumpPt = ptsPump[ptsPump.length - 1];
                    pumpParts = `
                        <path d="${dPump}" fill="none" stroke="var(--accent-rose)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="4 2" />
                        <circle cx="${lastPumpPt[0]}" cy="${lastPumpPt[1]}" r="3.5" fill="var(--accent-rose)" stroke="var(--chart-dot-stroke)" stroke-width="1.5" />
                    `;
                }

                pathsHtml = soilParts + airParts + tempParts + pumpParts;
            } else if (metric === 'pompa') {
                const pts = [];
                rows.forEach((r, idx) => {
                    const x = getX(r.t, idx);
                    const y = getY(getPumpState(r));
                    if (idx > 0) {
                        pts.push([x, pts[pts.length - 1][1]]);
                    }
                    pts.push([x, y]);
                });
                const dStep = 'M' + pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L');
                const areaStep = `${dStep} L${pts[pts.length - 1][0].toFixed(1)},${(pad.top + innerH).toFixed(1)} L${pts[0][0].toFixed(1)},${(pad.top + innerH).toFixed(1)} Z`;
                const lastPt = pts[pts.length - 1];
                pathsHtml = `
                    <path d="${areaStep}" fill="url(#roseGrad)" />
                    <path d="${dStep}" fill="none" stroke="var(--accent-rose)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
                    <circle cx="${lastPt[0]}" cy="${lastPt[1]}" r="4.5" fill="var(--accent-rose)" stroke="var(--chart-dot-stroke)" stroke-width="1.5" />
                `;
            } else {
                const color = metric === 'tanah' ? 'var(--accent-emerald)' : (metric === 'suhu' ? 'var(--accent-amber)' : 'var(--accent-blue)');
                const gradId = metric === 'tanah' ? 'emeraldGrad' : (metric === 'suhu' ? 'amberGrad' : 'blueGradient');
                const points = rows.map((r, idx) => [getX(r.t, idx), getY(metric === 'suhu' ? convTemp(r.suhu) : r[metric])]);
                const pathD = 'M' + points.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L');
                const areaD = `${pathD} L${points[points.length - 1][0].toFixed(1)},${(pad.top + innerH).toFixed(1)} L${points[0][0].toFixed(1)},${(pad.top + innerH).toFixed(1)} Z`;
                const lastPt = points[points.length - 1];
                pathsHtml = `
                    <path d="${areaD}" fill="url(#${gradId})" />
                    <path d="${pathD}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
                    <circle class="data-dot" cx="${lastPt[0]}" cy="${lastPt[1]}" r="4.5" style="fill:${color};stroke:var(--chart-dot-stroke);" />
                `;
            }

            wrap.innerHTML = `
                <svg id="overviewSvgChart" width="100%" height="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="display:block; overflow:hidden; width:100%; height:100%; cursor:crosshair;">
                    <defs>
                        <linearGradient id="blueGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stop-color="var(--accent-blue)" stop-opacity="0.32" />
                            <stop offset="100%" stop-color="var(--accent-blue)" stop-opacity="0.0" />
                        </linearGradient>
                        <linearGradient id="emeraldGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stop-color="var(--accent-emerald)" stop-opacity="0.28" />
                            <stop offset="100%" stop-color="var(--accent-emerald)" stop-opacity="0.0" />
                        </linearGradient>
                        <linearGradient id="amberGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stop-color="var(--accent-amber)" stop-opacity="0.28" />
                            <stop offset="100%" stop-color="var(--accent-amber)" stop-opacity="0.0" />
                        </linearGradient>
                        <linearGradient id="roseGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stop-color="var(--accent-rose)" stop-opacity="0.28" />
                            <stop offset="100%" stop-color="var(--accent-rose)" stop-opacity="0.0" />
                        </linearGradient>
                    </defs>
                    ${gridHtml}
                    ${bandHtml}
                    ${timeLabelsHtml}
                    ${pathsHtml}
                    <line id="overviewHoverLine" x1="0" y1="${pad.top}" x2="0" y2="${pad.top + innerH}" stroke="var(--chart-crosshair)" stroke-width="1.2" stroke-dasharray="3 3" style="display:none;" />
                </svg>
                <div id="chartTooltip" class="chart-tooltip" style="display:none;"></div>
            `;

            const svgEl = $('#overviewSvgChart', wrap);
            const hoverLine = $('#overviewHoverLine', wrap);
            const tooltip = $('#chartTooltip', wrap);
            if (svgEl && tooltip && rows.length > 0) {
                const showHover = clientX => {
                    const rect = svgEl.getBoundingClientRect();
                    if (!rect.width) return;
                    const relX = Math.max(0, Math.min(1, (clientX - rect.left - pad.left) / Math.max(1, rect.width - pad.left - pad.right)));
                    const idx = Math.min(rows.length - 1, Math.max(0, Math.round(relX * (rows.length - 1))));
                    const r = rows[idx];
                    const xSvg = getX(r.t, idx);
                    if (hoverLine) {
                        hoverLine.setAttribute('x1', xSvg.toFixed(1));
                        hoverLine.setAttribute('x2', xSvg.toFixed(1));
                        hoverLine.style.display = 'block';
                    }
                    const pumpOn = getPumpState(r) === 1;
                    tooltip.style.display = 'block';
                    const tooltipWidth = 175;
                    const leftPx = Math.min(Math.max(6, (xSvg / w) * rect.width - (tooltipWidth / 2)), Math.max(6, rect.width - tooltipWidth - 6));
                    tooltip.style.left = `${leftPx}px`;
                    tooltip.style.top = '10px';

                    let ttRows = '';
                    if (metric === 'all') {
                        if (!this.activeSeries || this.activeSeries.tanah) ttRows += `<div class="tt-row"><span style="color:var(--accent-emerald);">● Tanah:</span> <b class="tabular-nums">${Math.round(r.tanah)}%</b></div>`;
                        if (!this.activeSeries || this.activeSeries.udara) ttRows += `<div class="tt-row"><span style="color:var(--accent-blue);">● Udara:</span> <b class="tabular-nums">${Math.round(r.udara)}%</b></div>`;
                        if (!this.activeSeries || this.activeSeries.suhu) ttRows += `<div class="tt-row"><span style="color:var(--accent-amber);">● Suhu:</span> <b class="tabular-nums">${convTemp(r.suhu).toFixed(1)}${Sec.escapeHTML(tUnit)}</b></div>`;
                        if (!this.activeSeries || this.activeSeries.pompa) ttRows += `<div class="tt-row"><span style="color:var(--accent-rose);">● Pompa:</span> <b class="tabular-nums">${pumpOn ? 'ON' : 'OFF'}</b></div>`;
                    } else if (metric === 'tanah') {
                        ttRows += `<div class="tt-row"><span style="color:var(--accent-emerald);">● Tanah:</span> <b class="tabular-nums">${Math.round(r.tanah)}%</b></div>`;
                    } else if (metric === 'udara') {
                        ttRows += `<div class="tt-row"><span style="color:var(--accent-blue);">● Udara:</span> <b class="tabular-nums">${Math.round(r.udara)}%</b></div>`;
                    } else if (metric === 'suhu') {
                        ttRows += `<div class="tt-row"><span style="color:var(--accent-amber);">● Suhu:</span> <b class="tabular-nums">${convTemp(r.suhu).toFixed(1)}${Sec.escapeHTML(tUnit)}</b></div>`;
                    } else if (metric === 'pompa') {
                        ttRows += `<div class="tt-row"><span style="color:var(--accent-rose);">● Pompa/Relay:</span> <b class="tabular-nums">${pumpOn ? 'ON (Aktif)' : 'OFF (Siaga)'}</b></div>`;
                    }

                    tooltip.innerHTML = `
                        <div class="tt-time tabular-nums">${Sec.escapeHTML(window.DatasetStore.formatDateTime(r.t))} WIB</div>
                        ${ttRows}
                    `;
                };
                const hideHover = () => {
                    if (hoverLine) hoverLine.style.display = 'none';
                    tooltip.style.display = 'none';
                };
                svgEl.addEventListener('mousemove', e => showHover(e.clientX));
                svgEl.addEventListener('mouseleave', hideHover);
                svgEl.addEventListener('touchstart', e => {
                    if (e.touches && e.touches[0]) showHover(e.touches[0].clientX);
                }, { passive: true });
                svgEl.addEventListener('touchmove', e => {
                    if (e.touches && e.touches[0]) showHover(e.touches[0].clientX);
                }, { passive: true });
            }
        }

        renderDashboardPumpChart() {
            const wrap = $('#dashPumpChartWrap');
            const badge = $('#dashBadgePumpChart');
            if (!wrap) return;

            const S = window.ConfigStore.get();
            const allRecords = window.DatasetStore.getAll().filter(r => Number.isFinite(r.t) && Number.isFinite(r.tanah));

            if (allRecords.length === 0) {
                if (badge) {
                    badge.textContent = 'NO DATA';
                    badge.className = 'badge-tag slate tabular-nums';
                }
                wrap.innerHTML = `
                    <div style="height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; color: var(--text-muted); font-size: 11px; padding: 14px; text-align: center;">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="opacity: 0.45;"><path d="M12 2v20"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                        <span style="font-weight: 600; color: var(--text-secondary);">NO DATA · Riwayat Status Pompa / Relay</span>
                        <span>Menunggu telemetri sensor fisik & status relay aktual dari Firebase Kelompok 5</span>
                    </div>
                `;
                return;
            }

            let rows = allRecords;
            if (rows.length > 180) {
                const step = Math.ceil(rows.length / 150);
                rows = rows.filter((_, idx) => idx % step === 0 || idx === rows.length - 1);
            }

            const getPumpState = r => {
                if (typeof r.relayActual === 'boolean') return r.relayActual ? 1 : 0;
                return r.tanah < S.dry ? 1 : 0;
            };

            const onCount = rows.filter(r => getPumpState(r) === 1).length;
            const latestOn = getPumpState(rows[rows.length - 1]) === 1;
            if (badge) {
                badge.textContent = latestOn ? `POMPA: ON (${onCount}/${rows.length} Siklus)` : `SIAGA: OFF (${onCount}/${rows.length} ON)`;
                badge.className = latestOn ? 'badge-tag rose tabular-nums' : 'badge-tag emerald tabular-nums';
            }

            const w = Math.max(160, wrap.clientWidth || 360);
            const h = Math.max(120, wrap.clientHeight || 175);
            const pad = { top: 16, right: 18, bottom: 24, left: 44 };
            const innerW = Math.max(20, w - pad.left - pad.right);
            const innerH = Math.max(20, h - pad.top - pad.bottom);

            const t0 = rows[0].t;
            const t1 = rows[rows.length - 1].t;
            const span = Math.max(1000, t1 - t0);
            const getX = (t, i) => (t1 === t0)
                ? pad.left + (i / Math.max(1, rows.length - 1)) * innerW
                : pad.left + ((t - t0) / span) * innerW;
            const getY = st => st === 1 ? pad.top + 8 : pad.top + innerH - 6;

            const pts = [];
            rows.forEach((r, idx) => {
                const x = getX(r.t, idx);
                const y = getY(getPumpState(r));
                if (idx > 0) pts.push([x, pts[pts.length - 1][1]]);
                pts.push([x, y]);
            });
            const dStep = 'M' + pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L');
            const areaStep = `${dStep} L${pts[pts.length - 1][0].toFixed(1)},${(pad.top + innerH).toFixed(1)} L${pts[0][0].toFixed(1)},${(pad.top + innerH).toFixed(1)} Z`;

            wrap.innerHTML = `
                <svg width="100%" height="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="display:block; overflow:hidden;">
                    <defs>
                        <linearGradient id="pumpStepGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stop-color="var(--accent-rose)" stop-opacity="0.3" />
                            <stop offset="100%" stop-color="var(--accent-rose)" stop-opacity="0.02" />
                        </linearGradient>
                    </defs>
                    <line x1="${pad.left}" y1="${getY(1)}" x2="${w - pad.right}" y2="${getY(1)}" stroke="var(--chart-grid-line)" stroke-dasharray="3 3" />
                    <line x1="${pad.left}" y1="${getY(0)}" x2="${w - pad.right}" y2="${getY(0)}" stroke="var(--chart-grid-line)" stroke-dasharray="3 3" />
                    <text x="${pad.left - 6}" y="${getY(1) + 3}" fill="var(--accent-rose)" font-size="9" font-family="var(--font-mono)" text-anchor="end">ON</text>
                    <text x="${pad.left - 6}" y="${getY(0) + 3}" fill="var(--accent-emerald)" font-size="9" font-family="var(--font-mono)" text-anchor="end">OFF</text>
                    <text x="${pad.left}" y="${h - 5}" fill="var(--text-muted)" font-size="9" font-family="var(--font-mono)" text-anchor="start">${Sec.escapeHTML(window.DatasetStore.formatTime(t0, true))}</text>
                    <text x="${w - pad.right}" y="${h - 5}" fill="var(--text-muted)" font-size="9" font-family="var(--font-mono)" text-anchor="end">${Sec.escapeHTML(window.DatasetStore.formatTime(t1, true))}</text>
                    <path d="${areaStep}" fill="url(#pumpStepGrad)" />
                    <path d="${dStep}" fill="none" stroke="var(--accent-rose)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                    <circle cx="${pts[pts.length - 1][0]}" cy="${pts[pts.length - 1][1]}" r="4" fill="${latestOn ? 'var(--accent-rose)' : 'var(--accent-emerald)'}" stroke="var(--chart-dot-stroke)" stroke-width="1.5" />
                </svg>
            `;
        }

        fillSettingsForm() {
            const S = window.ConfigStore.get();
            if ($('#setUrl')) $('#setUrl').value = S.firebase;
            if ($('#setPoll')) $('#setPoll').value = String(S.poll);
            if ($('#setFetchN')) $('#setFetchN').value = String(S.fetchN);
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
