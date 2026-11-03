/**
 * Tes frontend Selada Keriting Monitor (Node.js, tanpa dependensi).
 * Jalankan: node tests/run-all-tests.js
 * Opsional: setel TFJS_PATH ke folder paket @tensorflow/tfjs untuk menguji pelatihan LSTM sungguhan.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0;
let fail = 0;
function test(name, fn) {
    return Promise.resolve().then(fn).then(
        () => { pass++; console.log('  ok   ' + name); },
        err => { fail++; console.log('  FAIL ' + name + '\n       ' + (err && err.message ? err.message : err)); }
    );
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'nilai berbeda') + `: ${a} !== ${b}`); }

// ---------------------------------------------------------------- sandbox
function makeSandbox() {
    const store = {};
    const win = {
        localStorage: {
            getItem: k => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
            removeItem: k => { delete store[k]; }
        },
        console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, URL, AbortController,
        fetch: async () => ({ ok: true, json: async () => [] }),
        DOMParser: undefined
    };
    win.window = win;
    vm.createContext(win);
    const load = f => vm.runInContext(read(f), win, { filename: f });
    return { win, load };
}

const DAY = 86400000;
const WIB = 7 * 3600 * 1000;
function rec(dayIdx, width, extra) {
    // Pukul 12:00 WIB pada hari ke-dayIdx sejak 2026-10-01
    const t = Date.parse('2026-10-01T05:00:00Z') + dayIdx * DAY;
    return Object.assign({ image_id: 'i' + dayIdx + '_' + width, captured_at: t, leaf_width_px: width, quality_status: 'VALID', hst_day: dayIdx + 1 }, extra || {});
}

(async function main() {
    console.log('\n== Struktur HTML & menu ==');
    const html = read('index.html');
    const appJs = read('js/app.js');

    await test('menu tepat 4 dan AI Assistant paling bawah', () => {
        const links = [...html.matchAll(/<a class="nav-link" href="#(\w+)"/g)].map(m => m[1]);
        eq(links.join(','), 'dashboard,kamera,prediksi,ai');
    });

    await test('tidak ada ID ganda di index.html', () => {
        const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
        const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
        eq(dup.length, 0, 'ID ganda: ' + dup.join(', '));
    });

    await test('setiap ID yang dipakai app.js ada di index.html', () => {
        const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
        const used = new Set([...appJs.matchAll(/\$\('#([A-Za-z0-9_-]+)'/g)].map(m => m[1]));
        const missing = [...used].filter(i => !ids.has(i) && !/^p-/.test(i));
        eq(missing.length, 0, 'ID hilang: ' + missing.join(', '));
        ['p-dashboard', 'p-kamera', 'p-prediksi', 'p-ai'].forEach(p => assert(ids.has(p), 'section hilang: ' + p));
    });

    await test('bagian yang diminta dihapus tidak ada lagi', () => {
        const banned = ['p-sensor', 'p-peringatan', 'p-pertumbuhan-daun', 'p-analisis-tanaman', 'p-panduan', 'p-riwayat',
            'p-otomasi', 'p-pengaturan', 'toastContainer', 'Notifikasi', 'Kanopi', 'Kalori', 'Tetens', 'GDD', 'VPD'];
        const all = html + appJs;
        banned.forEach(b => assert(!all.includes(b), 'masih ada: ' + b));
    });

    await test('script yang dimuat semuanya ada & urutannya benar', () => {
        const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
        eq(srcs.join(','), 'js/firebase-config.js,js/dataset.js,js/growth.js,js/forecast.js,js/ai-assistant.js,js/app.js');
        srcs.forEach(s => assert(fs.existsSync(path.join(root, s)), 'file tidak ada: ' + s));
        assert(fs.existsSync(path.join(root, 'css/app.css')), 'css/app.css tidak ada');
    });

    await test('data prediksi tidak dipakai di luar halaman Prediksi', () => {
        // lastForecast hanya boleh dibaca oleh fungsi prediksi, konteks AI, dan penghapus status
        const lines = appJs.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => l.includes('lastForecast'));
        const outside = lines.filter(([, l]) => /renderKPIs|renderTeleChart|renderLeafChart|renderLog/.test(l));
        eq(outside.length, 0);
        const dashFns = appJs.slice(appJs.indexOf('function renderKPIs'), appJs.indexOf('function bindDashboard'));
        assert(!dashFns.includes('forecast') && !dashFns.includes('Forecast'), 'dashboard menyentuh prediksi');
    });

    console.log('\n== GrowthStore (data lebar daun real) ==');
    const g = makeSandbox();
    g.load('js/firebase-config.js');
    g.load('js/dataset.js');
    g.load('js/growth.js');
    const GS = g.win.GrowthStore;

    await test('normalisasi: valid, kelas, URL aman', () => {
        const r = GS.normalize({ captured_at: 1790000000000, leaf_width_px: '120.5', quality_status: 'valid', cnn_class: 'Siap Panen', cnn_confidence: 0.93, image_url: 'javascript:alert(1)', overlay_url: 'data/growth_images/a.jpg' });
        eq(r.width, 120.5); eq(r.valid, true); eq(r.cls, 'siap_panen'); eq(r.image, ''); eq(r.overlay, 'data/growth_images/a.jpg');
    });

    await test('rekaman tanpa waktu valid ditolak', () => {
        eq(GS.normalize({ captured_at: 'x' }), null);
        eq(GS.normalize(null), null);
    });

    await test('bukan_selada dan citra gagal QC tidak masuk deret lebar daun', () => {
        GS.records = [
            GS.normalize(rec(0, 100)),
            GS.normalize(rec(0, 500, { cnn_class: 'bukan_selada' })),
            GS.normalize(rec(1, 140, { quality_status: 'INVALID_OFFLINE' })),
            GS.normalize(rec(1, 130))
        ];
        const d = GS.daily();
        eq(d.length, 2); eq(Math.round(d[0].width), 100); eq(Math.round(d[1].width), 130);
    });

    await test('rata-rata harian & kelas dominan (WIB)', () => {
        GS.records = [
            GS.normalize(rec(0, 100, { cnn_class: 'masa_pertumbuhan' })),
            GS.normalize(rec(0, 120, { cnn_class: 'masa_pertumbuhan' })),
            GS.normalize(rec(0, 110, { cnn_class: 'mendekati_panen' }))
        ];
        const d = GS.daily();
        eq(d.length, 1); eq(Math.round(d[0].width), 110); eq(d[0].stage, 0); eq(d[0].day, '2026-10-01');
    });

    await test('hitungan kelas, statistik lebar daun, & status CNN BELUM ADA MODEL', () => {
        eq(GS.CNN_SPEC.noModelLabel, 'BELUM ADA MODEL');
        eq(GS.CNN_SPEC.untrainedLabel, 'BELUM ADA MODEL');
        eq(GS.CNN_SPEC.supportingMeasurement, 'leaf_width_px');
        eq(GS.CNN_SPEC.classes.length, 4);
        GS.records = [GS.normalize(rec(0, 100)), GS.normalize(rec(1, 120, { cnn_class: 'siap_panen' }))];
        const c = GS.classCounts();
        eq(c.belum, 1); eq(c.siap_panen, 1); eq(GS.hasClassified(), true);
        const st = GS.widthStats();
        eq(st.count, 2); eq(st.min, 100); eq(st.max, 120); eq(st.avg, 110); eq(st.byClass.siap_panen.avg, 120);
        GS.records = [GS.normalize(rec(0, 100))];
        eq(GS.hasClassified(), false);
    });

    await test('sinkronisasi growth_metadata dari RTDB map tanpa duplikasi', () => {
        GS.records = [GS.normalize(rec(0, 100))];
        GS.ingestFromRTDB({
            slot1: rec(0, 100),
            slot2: rec(1, 135, { cnn_class: 'masa_pertumbuhan' })
        });
        eq(GS.records.length, 2);
        eq(GS.latest().width, 135);
    });

    console.log('\n== DatasetStore & Firebase client ==');
    const FB = g.win.FirebaseEdgeClient;
    const DS = g.win.DatasetStore;

    await test('normalisasi telemetri Kelompok 5 (skema Indonesia) & tolak timestamp tidak valid', () => {
        const r = FB.normalizeRecord({ suhu: 23.46, kelembapan_udara: 68.4, kelembapan_tanah: 72.2, relay: true, timestamp: Date.now() }, 'k1', 'live');
        eq(r.suhu, 23.5); eq(r.udara, 68); eq(r.tanah, 72); eq(r.relayActual, true);
        // Rekaman dengan timestamp 0 atau UNSYNCED_RTC harus ditolak agar tidak memalsukan status Live
        eq(FB.normalizeRecord({ suhu: 23.0, kelembapan_udara: 68, kelembapan_tanah: 72, timestamp: 0, waktu: 'UNSYNCED_RTC' }, 'k2', 'live'), null);
    });

    await test('normalizeUrl mengarahkan root RTDB ke /kelompok5.json & skip node non-telemetri', () => {
        const u = FB.normalizeUrl('https://esp32-lactuca-sativa-default-rtdb.asia-southeast1.firebasedatabase.app');
        assert(u.endsWith('/kelompok5.json'), 'harus mengarah ke /kelompok5.json: ' + u);
        const parsed = FB.parseDatabaseResponse({
            growth_metadata: { s1: rec(0, 115) },
            executed_slots: { s1: { status: 'CONFIRMED' } },
            rec_1: { suhu: 22.4, kelembapan_udara: 70, kelembapan_tanah: 71, timestamp: Date.now() }
        });
        eq(parsed.length, 1);
        eq(parsed[0].suhu, 22.4);
    });

    await test('telemetri di luar batas fisik ditolak', () => {
        eq(FB.normalizeRecord({ suhu: 99, kelembapan_udara: 50, kelembapan_tanah: 50 }, 'k', 'live'), null);
        eq(FB.normalizeRecord({ suhu: 20, kelembapan_udara: 50 }, 'k', 'live'), null);
    });

    await test('DatasetStore: zona, jendela waktu, statistik, agregasi menit, filter/pagination, & CSV aman', () => {
        const now = Date.now();
        DS.setRecords([
            { t: now - 120000, tanah: 50, udara: 70, suhu: 22, source: 'live', relayActual: true },
            { t: now - 30000, tanah: 70, udara: 71, suhu: 23, source: 'live', relayActual: false },
            { t: now - 20000, tanah: 74, udara: 73, suhu: 23.4, source: 'live', relayActual: false },
            { t: now, tanah: 90, udara: 72, suhu: 24, source: '=cmd', relayActual: null }
        ], 'live');
        eq(DS.zoneOf(50), 'dry'); eq(DS.zoneOf(70), 'ok'); eq(DS.zoneOf(90), 'wet');
        eq(DS.getWindow(60).length, 3); eq(DS.getWindow(0).length, 4);
        const zs = DS.calculateZoneShare();
        eq(zs.count, 4); eq(zs.ok, 50);
        const st = DS.calculateStats(DS.getAll(), r => r.tanah);
        eq(st.min, 50); eq(st.max, 90); eq(st.count, 4);
        const qDry = DS.queryHistory({ status: 'dry', page: 1, per: 10 });
        eq(qDry.total, 1); eq(qDry.rows[0].tanah, 50);
        const qAll = DS.queryHistory({ status: 'all', agg: false, search: '', page: 1, per: 2 });
        eq(qAll.total, 4); eq(qAll.totalPages, 2); eq(qAll.rows.length, 2);
        const csv = DS.toCSV().split('\n');
        eq(csv.length, 5);
        assert(csv[4].includes("'=cmd"), 'sumber berawalan = harus di-escape');
    });

    await test('CNN Dataset Manager: validasi JPG/PNG/WEBP, tolak Base64/rusak/duplikat, upload tunggal & massal, ubah label, hapus, persistensi reload, & split train/val/test', async () => {
        const s = makeSandbox();
        const rtdbStore = {};
        s.win.fetch = async (url, opts = {}) => {
            const m = (opts.method || 'GET').toUpperCase();
            if (url.includes('/kelompok5/cnn_dataset/')) {
                const key = decodeURIComponent(url.split('/kelompok5/cnn_dataset/')[1].replace(/\.json.*$/, ''));
                if (m === 'PUT') { rtdbStore[key] = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => rtdbStore[key] }; }
                if (m === 'PATCH') { Object.assign(rtdbStore[key] || {}, JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => rtdbStore[key] }; }
                if (m === 'DELETE') { delete rtdbStore[key]; return { ok: true, status: 200, json: async () => null }; }
            }
            if (url.endsWith('/kelompok5/cnn_dataset.json')) {
                return { ok: true, status: 200, json: async () => rtdbStore };
            }
            return { ok: false, status: 503, json: async () => ({ ok: false }) };
        };
        s.load('js/firebase-config.js');
        s.load('js/dataset.js');
        s.load('js/growth.js');
        const G = s.win.GrowthStore;

        // Buat sampel byte biner JPG, PNG, dan WEBP dengan magic bytes asli (> 100 byte)
        function makeBytes(header, seed) {
            const out = new Uint8Array(160);
            header.forEach((b, i) => { out[i] = b; });
            for (let i = header.length; i < out.length; i++) out[i] = (i * 31 + seed) & 0xff;
            return out;
        }
        const jpg1 = makeBytes([0xff, 0xd8, 0xff, 0xe0], 1);
        const png1 = makeBytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 2);
        const webp1 = makeBytes([0x52, 0x49, 0x46, 0x46, 0x90, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50], 3);
        const jpg2 = makeBytes([0xff, 0xd8, 0xff, 0xe0], 4);
        const base64Bytes = new Uint8Array(Buffer.from('data:image/jpeg;base64,' + 'A'.repeat(140)));

        // 1. Tolak Base64, file rusak, dan format tidak valid
        eq(G.detectImageFormat(base64Bytes).ok, false);
        eq(G.normalizeDatasetRecord({ dataset_id: 'bad1', label: 'siap_panen', image_url: 'data:image/png;base64,AAA' }), null);
        eq(G.validateCandidateFile({ bytes: jpg1, label: 'siap_panen', corrupt: true }).ok, false);
        eq(G.validateCandidateFile({ bytes: new Uint8Array(150), label: 'siap_panen' }).ok, false);

        // 2. Upload tunggal & massal (4 kelas) dengan progress callback
        const progressSteps = [];
        const batchRes = await G.uploadDatasetBatch([
            { fileName: 'panen.jpg', bytes: jpg1, width: 320, height: 240, label: 'siap_panen', leafWidthPx: 162, hst: 35 },
            { fileName: 'mendekati.png', bytes: png1, width: 320, height: 240, label: 'mendekati_panen', leafWidthPx: 138, hst: 28 },
            { fileName: 'tumbuh.webp', bytes: webp1, width: 320, height: 240, label: 'masa_pertumbuhan', leafWidthPx: 94, hst: 14 },
            { fileName: 'bukan.jpg', bytes: jpg2, width: 320, height: 240, label: 'bukan_selada', leafWidthPx: 0, hst: null }
        ], {
            onProgress: p => progressSteps.push(p.percent)
        });
        eq(batchRes.ok, true);
        eq(batchRes.successCount, 4);
        assert(progressSteps.includes(100), 'progress harus mencapai 100%');
        eq(G.datasetRecords().length, 4);

        // 3. Deteksi duplikasi FNV-1a menolak upload ulang gambar yang sama
        const dupRes = await G.uploadDatasetItem({ fileName: 'duplikat.jpg', bytes: jpg1, width: 320, height: 240, label: 'siap_panen' });
        eq(dupRes.ok, false);
        eq(dupRes.code, 'DUPLICATE_IN_DB');

        // 4. Statistik per kelas, pencarian, filter, & split Train/Val/Test
        const st = G.datasetClassStats();
        eq(st.total, 4);
        eq(st.byClass.siap_panen.count, 1);
        eq(st.byClass.siap_panen.avgWidth, 162);
        eq(st.cnnStatus, 'BELUM ADA MODEL');

        const split = G.buildTrainValTestSplit();
        eq(split.model_status, 'BELUM ADA MODEL');
        eq(split.training_target, 'google_colab');
        assert(split.colab_export_contract && Array.isArray(split.colab_export_contract.class_names_template), 'kontrak ekspor Colab wajib tersedia');
        eq(split.total, 4);

        const qSearch = G.queryGallery({ source: 'dataset', search: 'mendekati.png', page: 1, per: 8 });
        eq(qSearch.total, 1);
        eq(qSearch.rows[0].label, 'mendekati_panen');

        // 5. Ubah label & verifikasi persistensi di RTDB + localStorage setelah reload
        const targetId = qSearch.rows[0].id;
        const upRes = await G.updateDatasetLabel(targetId, 'siap_panen', 'Revisi label ke siap panen');
        eq(upRes.ok, true);
        eq(G.datasetClassStats().byClass.siap_panen.count, 2);
        eq(rtdbStore[targetId].label, 'siap_panen');

        // Simulasikan reload halaman (sandbox baru membaca dari localStorage & RTDB)
        const sReload = makeSandbox();
        sReload.win.localStorage.setItem('selada-cnn-dataset-cache-v1', s.win.localStorage.getItem('selada-cnn-dataset-cache-v1'));
        sReload.load('js/firebase-config.js');
        sReload.load('js/dataset.js');
        sReload.load('js/growth.js');
        const GReload = sReload.win.GrowthStore;
        eq(GReload.datasetRecords().length, 4);
        eq(GReload.datasetClassStats().byClass.siap_panen.count, 2);

        // 6. Hapus dengan konfirmasi & verifikasi terhapus dari RTDB + cache
        const delRes = await G.deleteDatasetRecord(targetId);
        eq(delRes.ok, true);
        eq(G.datasetRecords().length, 3);
        eq(rtdbStore[targetId], undefined);
    });

    await test('Registrasi Model CNN Colab: validasi 7 lapis, fallback BELUM ADA MODEL, atomic rollback, dan inference MODEL PENGUJIAN', () => {
        const s = makeSandbox();
        s.load('js/firebase-config.js');
        s.load('js/dataset.js');
        s.load('js/growth.js');
        const G = s.win.GrowthStore;

        // Default: BELUM ADA MODEL & tidak mengarang prediksi
        eq(G.getModelStatus().available, false);
        eq(G.getModelStatus().status, 'BELUM ADA MODEL');
        const noPred = G.runInference(null, { leafWidthPx: 140 });
        eq(noPred.cnn_status, 'BELUM ADA MODEL');
        eq(noPred.cnn_class, null);
        eq(noPred.cnn_confidence, null);

        const activeClasses = ['siap_panen', 'mendekati_panen', 'masa_pertumbuhan'];
        const uiClasses = ['siap_panen', 'mendekati_panen', 'masa_pertumbuhan', 'bukan_selada'];
        const makeBundle = (ver = 'v1.0.0-colab-test', overrides = {}) => {
            const meta = Object.assign({
                model_id: 'model_selada_v2',
                model_version: ver,
                architecture: 'MobileNetV2',
                format: 'h5',
                training_source: 'google_colab',
                is_test_model: true,
                input_shape: [64, 64, 3],
                class_names: activeClasses.slice(),
                preprocessing: {
                    color_mode: 'RGB',
                    resize_mode: 'bilinear',
                    target_size: [64, 64],
                    normalization: 'rescale_0_1'
                }
            }, overrides.metadata || {});
            const evaluation = Object.assign({
                accuracy: 0.94,
                precision_macro: 0.93,
                recall_macro: 0.93,
                f1_macro: 0.93,
                class_names: activeClasses.slice(),
                confusion_matrix: [[10, 0, 0], [0, 10, 0], [0, 0, 10]]
            }, overrides.evaluation || {});
            const weights = {
                kernel: [
                    [-0.4, 0.1, 0.2],
                    [2.5, 1.2, 0.4],
                    [-0.3, 0.1, 0.2],
                    [0.2, 0.1, 0.0],
                    [0.8, 0.3, 0.1],
                    [0.1, 0.1, 0.1]
                ],
                bias: [0.3, 0.1, -0.1]
            };
            const header = Buffer.from('\x89HDF\r\n\x1a\n\x00\x00\x00\x00\x00\x00\x00\x00', 'binary');
            const trailer = Buffer.from('__SELADA_PORTABLE_WEIGHTS_JSON__:' + JSON.stringify(weights), 'utf8');
            return {
                'class_names.json': overrides.classNames || activeClasses.slice(),
                'metadata.json': meta,
                'evaluation.json': evaluation,
                'model_selada_v2.h5': overrides.binBytes || new Uint8Array(Buffer.concat([header, trailer]))
            };
        };

        // 1. Tolak urutan kelas yang tidak sinkron antara class_names.json dan metadata.json
        const badOrder = G.registerOrImportModel(makeBundle('v0.1', {
            classNames: ['mendekati_panen', 'siap_panen', 'masa_pertumbuhan']
        }));
        eq(badOrder.ok, false);
        eq(badOrder.stage, 'label_order');
        eq(G.getModelStatus().status, 'BELUM ADA MODEL');

        // 2. Tolak pemaksaan 4 kelas pada model_selada_v2.h5 (model hanya 3 kelas aktif)
        const badFour = G.registerOrImportModel(makeBundle('v0.2', {
            classNames: ['siap_panen', 'mendekati_panen', 'masa_pertumbuhan', 'bukan_selada']
        }));
        eq(badFour.ok, false);
        eq(badFour.stage, 'classes');

        // 3. Aktifkan model_selada_v2.h5 pengujian teknis yang valid (ditandai MODEL PENGUJIAN)
        const okReg = G.registerOrImportModel(makeBundle('v2.0.0-test'));
        eq(okReg.ok, true);
        eq(G.getModelStatus().available, true);
        eq(G.getModelStatus().status, 'MODEL PENGUJIAN');
        eq(G.getModelStatus().model_version, 'v2.0.0-test');
        eq(G.getModelStatus().is_test_model, true);
        eq(G.getModelStatus().binary_file, 'model_selada_v2.h5');
        eq(G.CLASSES.bukan_selada.statusBadge, 'BELUM TERSEDIA');
        eq(G.CLASSES.bukan_selada.activeInModel, false);

        // 4. Atomic Rollback: gagal import model baru wajib mempertahankan model v2.0.0-test sebelumnya!
        const failedUpgrade = G.registerOrImportModel(makeBundle('v2.1.0-broken', {
            binBytes: new Uint8Array(Buffer.from('CORRUPT_HEADER_NOT_H5_AT_ALL_000000'))
        }));
        eq(failedUpgrade.ok, false);
        eq(failedUpgrade.rolledBackToPrevious, true);
        eq(G.getModelStatus().available, true);
        eq(G.getModelStatus().model_version, 'v2.0.0-test');

        // 5. Jalankan inferensi pada piksel RGB nyata & verifikasi output hanya 3 kelas aktif
        const rgb = new Uint8Array(80 * 80 * 3);
        for (let i = 0; i < rgb.length; i += 3) {
            rgb[i] = 45; rgb[i + 1] = 200; rgb[i + 2] = 55;
        }
        const pred = G.runInference({ rgbBytes: rgb, width: 80, height: 80 }, { leafWidthPx: 164, timestampMs: 1790000000000 });
        eq(pred.cnn_status, 'MODEL PENGUJIAN');
        assert(activeClasses.includes(pred.cnn_class), 'kelas prediksi wajib salah satu dari 3 kelas aktif');
        assert(pred.cnn_class !== 'bukan_selada', 'bukan_selada dilarang menjadi output prediksi model');
        assert(pred.cnn_confidence > 0 && pred.cnn_confidence <= 1, 'confidence wajib berada di (0, 1]');
        eq(pred.model_version, 'v2.0.0-test');
        eq(pred.classified_at, 1790000000000);
        eq(pred.is_test_model, true);
    });

    await test('pengaturan lama yang tidak dipakai diabaikan', () => {
        const s = makeSandbox();
        s.win.localStorage.setItem('selada-dash-v3', JSON.stringify({ theme: 'dark', rules: { off: { v: 1 } }, camIp: '10.0.0.5', dry: 60 }));
        s.load('js/firebase-config.js');
        const S = s.win.ConfigStore.get();
        eq(S.camIp, '10.0.0.5'); eq(S.dry, 60); eq(S.theme, undefined); eq(S.rules, undefined); eq(S.offlineSec, 15);
    });

    console.log('\n== Forecast (LSTM) ==');
    const f = makeSandbox();
    f.load('js/forecast.js');
    const FC = f.win.Forecast;

    await test('konfigurasi: 4 hari ke depan', () => eq(FC.HORIZON, 4));

    await test('data kurang dari minimum → tidak ada prediksi', async () => {
        const r = await FC.run([{ t: 0, width: 1, stage: null }]);
        eq(r.ok, false); eq(r.have, 1); eq(r.need, FC.MIN_DAYS);
    });

    await test('histori observasi nyata murni: tolak data sintetis/interpolasi/prediksi', () => {
        const out = FC.validateRealDaily([
            { day: '2026-10-01', t: 1000, width: 100, stage: 0 },
            { day: '2026-10-02', t: 2000, width: 110, stage: 0, interpolated: true },
            { day: '2026-10-03', t: 3000, width: 120, stage: 1, synthetic: true },
            { day: '2026-10-04', t: 4000, width: 130, stage: 1, predicted: true },
            { day: '2026-10-05', t: 5000, width: 140, stage: 1 }
        ]);
        eq(out.length, 2);
        eq(out[0].width, 100);
        eq(out[1].width, 140);
        eq(FC.fillGaps, undefined);
    });

    const tfPath = process.env.TFJS_PATH;
    if (tfPath) {
        await test('LSTM sungguhan: 4 prediksi finite & non-negatif', async () => {
            const tf = require(tfPath);
            f.win.tf = tf;
            const daily = [];
            for (let i = 0; i < 12; i++) daily.push({ day: 'd' + i, t: Date.parse('2026-10-01T00:00:00Z') + i * DAY, width: 80 + i * 6, stage: i < 5 ? 0 : (i < 9 ? 1 : 2) });
            const r = await FC.run(daily);
            assert(r.ok, 'run gagal');
            eq(r.forecast.length, 4);
            r.forecast.forEach(d => { assert(Number.isFinite(d.width) && d.width >= 0, 'lebar tidak valid'); assert([0, 1, 2].includes(d.stage), 'tahap tidak valid'); });
            eq(r.forecast[0].t, daily[11].t + DAY);
            assert(r.useStage, 'seharusnya memakai tahap CNN');
            console.log('       prediksi: ' + r.forecast.map(d => d.width.toFixed(1) + '/' + d.stage).join('  ') + '  MSE=' + r.loss.toFixed(5));
        });
        await test('LSTM tanpa kelas CNN: hanya lebar daun', async () => {
            const daily = [];
            for (let i = 0; i < 9; i++) daily.push({ day: 'd' + i, t: Date.parse('2026-10-01T00:00:00Z') + i * DAY, width: 90 + i * 5, stage: null });
            const r = await FC.run(daily);
            assert(r.ok && !r.useStage);
            r.forecast.forEach(d => eq(d.stage, null));
        });
    } else {
        console.log('  --   tes LSTM sungguhan dilewati (setel TFJS_PATH untuk menjalankannya)');
    }

    console.log('\n== AI Assistant ==');
    const a = makeSandbox();
    a.load('js/firebase-config.js');
    a.load('js/growth.js');
    a.load('js/ai-assistant.js');
    const AI = a.win.AIAssistant;

    await test('diagnosa: tanah kering + udara lembap + suhu hangat terdeteksi', () => {
        const d = AI.diagnose({ tanah: 50, udara: 90, suhu: 26 });
        eq(d.issues.length, 3);
        eq(AI.diagnose(null), null);
    });

    await test('prediksi belum tersedia dijawab jujur (termasuk pertanyaan dengan kata daun)', async () => {
        const r = await AI.query('Prediksi lebar daun 4 hari ke depan', { forecast: null, leaf: { width: 120, cls: null } });
        assert(/minimal 8 hari/.test(r), 'seharusnya menjawab status prediksi LSTM, bukan lebar daun: ' + r);
    });

    await test('pertanyaan tipburn tepi daun tidak salah masuk ke intent lebar daun', async () => {
        const r = await AI.query('Tipburn tepi daun', { sensor: { tanah: 70, udara: 70, suhu: 22 } });
        assert(/Tipburn.*ujung daun muda/i.test(r), 'seharusnya menjawab tipburn: ' + r);
    });

    await test('jawaban memakai prediksi LSTM bila ada', async () => {
        const fc = { ok: true, forecast: [{ width: 150, stage: 1 }, { width: 155, stage: 1 }, { width: 160, stage: 2 }, { width: 164, stage: 2 }] };
        const r = await AI.query('prediksi besok', { forecast: fc });
        assert(r.includes('150.0 px') && r.includes('Siap Panen'));
    });

    await test('desain & responsivitas CSS memenuhi standar Linear/Stripe dark palette', () => {
        const css = read('css/app.css');
        assert(css.includes('--bg: #090d16'), 'bg harus #090d16');
        assert(css.includes('--card: #111827'), 'card harus #111827');
        assert(css.includes('--accent: #10b981'), 'accent harus #10b981');
        assert(css.includes('--rose: #f43f5e'), 'rose harus #f43f5e');
        assert(css.includes('tabular-nums'), 'harus memakai tabular-nums');
        assert(css.includes('@media (min-width: 900px)'), 'harus ada media query responsive desktop >=900px');
    });

    console.log('\n== Integrasi Runtime DOM & Navigasi 4 Menu (app.js) ==');
    await test('simulasi penuh app.js: navigasi 4 menu, validasi inline kamera, CNN Belum Dilatih, & isolasi prediksi LSTM', async () => {
        const elements = {};
        const navLinks = [];
        function makeEl(id, tag = 'div', dataset = {}) {
            let _text = '';
            const el = {
                id,
                tagName: tag.toUpperCase(),
                get textContent() { return _text; },
                set textContent(v) { _text = String(v ?? ''); this.children = []; },
                innerHTML: '',
                value: '',
                hidden: false,
                disabled: false,
                title: '',
                className: '',
                clientWidth: 640,
                style: {},
                dataset: Object.assign({}, dataset),
                children: [],
                attrs: {},
                listeners: {},
                classList: {
                    _set: new Set(),
                    toggle(c, force) {
                        const on = force !== undefined ? Boolean(force) : !this._set.has(c);
                        if (on) this._set.add(c); else this._set.delete(c);
                    },
                    contains(c) { return this._set.has(c); }
                },
                setAttribute(k, v) { this.attrs[k] = String(v); },
                removeAttribute(k) { delete this.attrs[k]; },
                appendChild(ch) { this.children.push(ch); return ch; },
                addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
                dispatch(ev, payload) { (this.listeners[ev] || []).forEach(fn => fn(payload || { target: this, preventDefault() {} })); },
                querySelector(sel) {
                    if (sel === '.hit' || sel === '.cross' || sel === 'svg') return makeEl(sel);
                    return null;
                },
                querySelectorAll(sel) {
                    if (sel === 'button') return this.children;
                    return [];
                },
                closest(sel) { return this._closest || null; }
            };
            if (id) elements[id] = el;
            return el;
        }

        // Buat seluruh elemen ber-ID dari index.html
        const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
        htmlIds.forEach(id => makeEl(id));
        ['tanah', 'udara', 'suhu', 'pompa'].forEach(v => {
            const b = makeEl('', 'button', { v });
            b._closest = b;
            elements.segMetric.children.push(b);
        });
        ['0', '60', '300', '900'].forEach(v => {
            const b = makeEl('', 'button', { v });
            b._closest = b;
            elements.segWindow.children.push(b);
        });
        ['stream', 'snap'].forEach(v => {
            const b = makeEl('', 'button', { v });
            b._closest = b;
            elements.segCam.children.push(b);
        });
        ['dashboard', 'kamera', 'prediksi', 'ai'].forEach(page => {
            const a = makeEl('', 'a', { page });
            navLinks.push(a);
        });
        elements.galFilter.value = 'all';

        const domWin = makeSandbox();
        const w = domWin.win;
        w.location = { hash: '#dashboard', protocol: 'http:' };
        w.scrollTo = () => {};
        w.addEventListener = (ev, fn) => { (w._listeners = w._listeners || {})[ev] = fn; };
        w.document = {
            readyState: 'complete',
            title: '',
            body: makeEl('body'),
            createElement: tag => makeEl('', tag),
            querySelector: sel => (sel.startsWith('#') ? elements[sel.slice(1)] || null : null),
            querySelectorAll: sel => (sel === '.nav-link' ? navLinks : [])
        };
        global.document = w.document;
        global.location = w.location;
        vm.runInContext('var document = window.document; var location = window.location; var scrollTo = window.scrollTo; var addEventListener = window.addEventListener;', w);

        domWin.load('js/firebase-config.js');
        domWin.load('js/dataset.js');
        domWin.load('js/growth.js');
        domWin.load('js/forecast.js');
        domWin.load('js/ai-assistant.js');
        // Nonaktifkan polling jaringan latar belakang selama tes DOM
        w.FirebaseEdgeClient.start = () => {};
        w.GrowthStore.start = () => {};
        domWin.load('js/app.js');

        // 1. Verifikasi halaman awal Dashboard
        eq(elements['p-dashboard'].hidden, false);
        eq(elements['p-kamera'].hidden, true);
        eq(elements['p-prediksi'].hidden, true);
        eq(elements['p-ai'].hidden, true);

        // Masukkan data sensor & data lebar daun nyata (tanpa klasifikasi CNN)
        const now = Date.now();
        w.DatasetStore.setRecords([
            { t: now - 10000, tanah: 72, udara: 68, suhu: 22.5, relayActual: false, source: 'live' }
        ], 'live');
        w.GrowthStore.ingestFromRTDB([rec(0, 118.4), rec(1, 124.6)]);

        eq(elements.vSoil.textContent, '72');
        eq(elements.vLeaf.textContent, '124.6');
        eq(elements.bLeaf.textContent, 'CNN: BELUM ADA MODEL');
        eq(elements.teleStatBar.children.length, 4);
        eq(elements.leafStatBar.children.length, 4);

        // 2. Navigasi ke Kamera & CNN
        w.location.hash = '#kamera';
        w._listeners.hashchange();
        eq(elements['p-kamera'].hidden, false);
        eq(elements['p-dashboard'].hidden, true);
        eq(elements.cnnBadge.textContent, 'BELUM ADA MODEL');
        eq(elements.classList.children.length, 4);
        eq(elements.cnnSupportMeta.children.length, 4);
        eq(elements.cnnModelMeta.children.length, 4);

        // Uji validasi inline IP kamera tidak valid -> valid
        elements.camIp.value = 'http://bad_url/evil';
        elements.camGo.dispatch('click');
        eq(elements.camError.hidden, false);
        assert(elements.camIp.classList.contains('is-invalid'), 'input kamera harus ditandai is-invalid');

        elements.camIp.value = '192.168.1.50:8080';
        elements.camIp.dispatch('input');
        eq(elements.camError.hidden, true);
        assert(!elements.camIp.classList.contains('is-invalid'), 'is-invalid harus bersih saat input diubah');
        elements.camGo.dispatch('click');
        assert(elements.camImg.src.startsWith('http://192.168.1.50:8080/stream?t='), 'port kustom kamera harus dipertahankan: ' + elements.camImg.src);

        // 3. Navigasi ke Prediksi LSTM (data < 8 hari -> menunggu data, tombol retrain nonaktif)
        w.location.hash = '#prediksi';
        w._listeners.hashchange();
        eq(elements['p-prediksi'].hidden, false);
        eq(elements.fcBadge.textContent, 'Menunggu data');
        eq(elements.fcRetrain.disabled, true);

        // 4. Navigasi ke AI Assistant (paling bawah)
        w.location.hash = '#ai';
        w._listeners.hashchange();
        eq(elements['p-ai'].hidden, false);
        eq(elements['p-prediksi'].hidden, true);
    });

    console.log(`\n${pass} lulus, ${fail} gagal\n`);
    process.exit(fail ? 1 : 0);
})();
