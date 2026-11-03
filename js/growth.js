/**
 * GrowthStore: data lebar daun REAL hasil pipeline CV (data/growth_metadata.json).
 * Hanya lebar daun yang dipakai. Kelas CNN (cnn_class) diisi pipeline setelah model dilatih.
 */
(function (window) {
    'use strict';

    const DATA_URL = 'data/growth_metadata.json';
    const DATASET_LOCAL_URL = 'data/cnn_dataset_metadata.json';
    const DATASET_API_URL = '/api/kelompok5/dataset';
    const DATASET_CACHE_KEY = 'selada-cnn-dataset-cache-v1';
    const REFRESH_MS = 60000;
    const WIB_MS = 7 * 3600 * 1000;
    const MIN_FILE_BYTES = 100;
    const MAX_FILE_BYTES = 4500000;
    const MIN_IMG_DIM = 64;
    const MAX_IMG_DIM = 4096;

    // Empat kelas CNN sesuai spesifikasi dosen.
    // Tiga kelas pertama aktif pada model_selada_v2.h5; kelas bukan_selada hanya elemen UI informatif (BELUM TERSEDIA).
    const CLASSES = {
        masa_pertumbuhan: {
            label: 'Masa Pertumbuhan',
            ord: 0,
            tone: 'info',
            activeInModel: true,
            statusBadge: 'AKTIF',
            desc: 'Fase vegetatif aktif pembentukan helai daun keriting'
        },
        mendekati_panen: {
            label: 'Mendekati Panen',
            ord: 1,
            tone: 'warn',
            activeInModel: true,
            statusBadge: 'AKTIF',
            desc: 'Roset daun berkembang pesat mendekati ukuran panen'
        },
        siap_panen: {
            label: 'Siap Panen',
            ord: 2,
            tone: 'ok',
            activeInModel: true,
            statusBadge: 'AKTIF',
            desc: 'Lebar daun dan kepadatan roset siap dipanen'
        },
        bukan_selada: {
            label: 'Bukan Selada',
            ord: null,
            tone: 'err',
            activeInModel: false,
            statusBadge: 'BELUM TERSEDIA',
            desc: 'Elemen UI informatif sesuai spesifikasi 4 kelas (belum didukung oleh model_selada_v2.h5 3-kelas)'
        }
    };

    // Spesifikasi integrasi model CNN (4 kelas UI sesuai spesifikasi dosen; 3 kelas output aktif pada model_selada_v2.h5).
    const CNN_SPEC = {
        modelId: 'model_selada_v2',
        defaultModelFile: 'model_selada_v2.h5',
        trainingSource: 'google_colab',
        modelsDir: 'models',
        requiredFiles: ['class_names.json', 'metadata.json', 'evaluation.json'],
        binaryCandidates: ['model_selada_v2.h5', 'model.h5', 'model.keras', 'model.tflite'],
        classes: ['siap_panen', 'mendekati_panen', 'masa_pertumbuhan', 'bukan_selada'],
        uiClasses: ['siap_panen', 'mendekati_panen', 'masa_pertumbuhan', 'bukan_selada'],
        activeClasses: ['siap_panen', 'mendekati_panen', 'masa_pertumbuhan'],
        unavailableClasses: ['bukan_selada'],
        unavailableBadge: 'BELUM TERSEDIA',
        supportedFormats: ['h5', 'keras', 'tflite'],
        supportedNormalizations: ['rescale_0_1', 'mobilenet_v2_-1_1', 'imagenet_mean_std', 'raw_0_255'],
        supportedResizeModes: ['bilinear', 'nearest', 'bicubic', 'lanczos'],
        supportingMeasurement: 'leaf_width_px',
        noModelLabel: 'BELUM ADA MODEL',
        untrainedLabel: 'BELUM ADA MODEL'
    };

    function normClass(v) {
        if (v === null || v === undefined) return null;
        const k = String(v).trim().toLowerCase().replace(/[\s-]+/g, '_');
        return Object.prototype.hasOwnProperty.call(CLASSES, k) ? k : null;
    }

    /** Hanya URL http(s) atau path relatif situs ini; data: Base64 ditolak tegas. */
    function safeUrl(u) {
        if (typeof u !== 'string') return '';
        const s = u.trim();
        if (!s || /^data:/i.test(s)) return '';
        if (/^https?:\/\//i.test(s)) return s;
        if (/^(\.\/|data\/|\/(?!\/))/.test(s)) return s;
        return '';
    }

    function toUint8(inputBytes) {
        if (!inputBytes) return null;
        if (inputBytes instanceof Uint8Array) return inputBytes;
        if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(inputBytes)) {
            return new Uint8Array(inputBytes.buffer, inputBytes.byteOffset, inputBytes.byteLength);
        }
        if (inputBytes instanceof ArrayBuffer) return new Uint8Array(inputBytes);
        if (typeof inputBytes.length === 'number') return Uint8Array.from(inputBytes);
        return null;
    }

    /** Hitung checksum 32-bit FNV-1a (8 hex char) identik dengan backend Python & ESP32-CAM. */
    function computeFnv1aHex(inputBytes) {
        const bytes = toUint8(inputBytes) || new Uint8Array(0);
        let h = 0x811c9dc5;
        for (let i = 0; i < bytes.length; i++) {
            h ^= bytes[i];
            h = Math.imul(h, 0x01000193) >>> 0;
        }
        return ('00000000' + h.toString(16)).slice(-8);
    }

    /** Validasi magic bytes JPG/JPEG, PNG, dan WEBP; tolak tegas Base64 data URI. */
    function detectImageFormat(inputBytes) {
        const b = toUint8(inputBytes);
        if (!b || b.length < 12) {
            return { ok: false, error: 'File gambar kosong atau terlalu kecil (< 12 byte)' };
        }
        // Tolak string ASCII "data:" (Base64 URI)
        if (b[0] === 0x64 && b[1] === 0x61 && b[2] === 0x74 && b[3] === 0x61 && b[4] === 0x3a) {
            return { ok: false, error: 'Penyimpanan gambar Base64 dilarang; gunakan file biner JPG/PNG/WEBP' };
        }
        if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
            return { ok: true, ext: 'jpg', format: 'JPG', contentType: 'image/jpeg' };
        }
        if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
            b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
            return { ok: true, ext: 'png', format: 'PNG', contentType: 'image/png' };
        }
        if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
            b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
            return { ok: true, ext: 'webp', format: 'WEBP', contentType: 'image/webp' };
        }
        return { ok: false, error: 'Format file tidak didukung (hanya JPG, JPEG, PNG, atau WEBP)' };
    }

    function wibDayKey(t) {
        return new Date(t + WIB_MS).toISOString().slice(0, 10);
    }

    function softmax1d(logits) {
        const arr = Array.from(logits || []).map(Number);
        if (!arr.length || arr.some(v => !Number.isFinite(v))) return null;
        const maxV = Math.max.apply(null, arr);
        const exps = arr.map(v => Math.exp(v - maxV));
        const sum = exps.reduce((a, b) => a + b, 0);
        if (!Number.isFinite(sum) || sum <= 0) return null;
        return exps.map(v => v / sum);
    }

    /**
     * Preprocessing piksel RGB [0..255] yang 100% identik dengan fungsi Python
     * `preprocess_image_tensor()` pada `scripts/cnn_inference_adapter.py` dan Google Colab.
     */
    function preprocessImagePixels(rgbBytes, srcW, srcH, inputShape, preprocessingCfg) {
        const targetH = Number(inputShape[0]);
        const targetW = Number(inputShape[1]);
        const channels = Number(inputShape[2]);
        if (channels !== 3 || targetH < 64 || targetW < 64) {
            throw new Error('input_shape tidak valid untuk preprocessing RGB');
        }
        const raw = toUint8(rgbBytes);
        if (!raw || raw.length < srcW * srcH * 3) {
            throw new Error('Buffer piksel RGB tidak mencukupi dimensi sumber');
        }
        const resizeMode = String((preprocessingCfg && preprocessingCfg.resize_mode) || 'bilinear').toLowerCase();
        const normMode = String((preprocessingCfg && preprocessingCfg.normalization) || 'rescale_0_1').toLowerCase();
        const out = new Float32Array(targetH * targetW * 3);

        for (let y = 0; y < targetH; y++) {
            const sy = targetH > 1 ? (y * (srcH - 1)) / (targetH - 1) : 0;
            const y0 = Math.floor(sy);
            const y1 = Math.min(srcH - 1, y0 + 1);
            const wy = sy - y0;
            for (let x = 0; x < targetW; x++) {
                const sx = targetW > 1 ? (x * (srcW - 1)) / (targetW - 1) : 0;
                const x0 = Math.floor(sx);
                const x1 = Math.min(srcW - 1, x0 + 1);
                const wx = sx - x0;
                const dstIdx = (y * targetW + x) * 3;

                for (let c = 0; c < 3; c++) {
                    let val;
                    if (resizeMode === 'nearest' || (srcW === targetW && srcH === targetH)) {
                        const ny = Math.round(sy);
                        const nx = Math.round(sx);
                        val = raw[(ny * srcW + nx) * 3 + c];
                    } else {
                        const v00 = raw[(y0 * srcW + x0) * 3 + c];
                        const v01 = raw[(y0 * srcW + x1) * 3 + c];
                        const v10 = raw[(y1 * srcW + x0) * 3 + c];
                        const v11 = raw[(y1 * srcW + x1) * 3 + c];
                        val = (1 - wy) * ((1 - wx) * v00 + wx * v01) + wy * ((1 - wx) * v10 + wx * v11);
                    }

                    if (normMode === 'rescale_0_1') {
                        val = val / 255.0;
                    } else if (normMode === 'mobilenet_v2_-1_1') {
                        val = (val / 127.5) - 1.0;
                    } else if (normMode === 'imagenet_mean_std') {
                        const mean = c === 0 ? 0.485 : (c === 1 ? 0.456 : 0.406);
                        const std = c === 0 ? 0.229 : (c === 1 ? 0.224 : 0.225);
                        val = ((val / 255.0) - mean) / std;
                    } else if (normMode !== 'raw_0_255') {
                        throw new Error(`Mode normalisasi '${normMode}' tidak didukung`);
                    }
                    out[dstIdx + c] = val;
                }
            }
        }
        return { tensor: out, shape: [1, targetH, targetW, 3] };
    }

    function extractSpatialFeatures(tensorFloat32, h, w) {
        const mean = [0, 0, 0];
        const sq = [0, 0, 0];
        const qSum = [
            [0, 0, 0], [0, 0, 0],
            [0, 0, 0], [0, 0, 0]
        ];
        const qCnt = [0, 0, 0, 0];
        const h2 = Math.max(1, Math.floor(h / 2));
        const w2 = Math.max(1, Math.floor(w / 2));
        const totalPx = h * w;

        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const idx = (y * w + x) * 3;
                const qi = (y < h2 ? 0 : 2) + (x < w2 ? 0 : 1);
                qCnt[qi]++;
                for (let c = 0; c < 3; c++) {
                    const v = tensorFloat32[idx + c];
                    mean[c] += v;
                    sq[c] += v * v;
                    qSum[qi][c] += v;
                }
            }
        }
        for (let c = 0; c < 3; c++) mean[c] /= totalPx;
        const std = [0, 0, 0];
        for (let c = 0; c < 3; c++) {
            std[c] = Math.sqrt(Math.max(0, sq[c] / totalPx - mean[c] * mean[c]));
        }
        const feats = mean.concat(std);
        for (let qi = 0; qi < 4; qi++) {
            const cnt = Math.max(1, qCnt[qi]);
            feats.push(qSum[qi][0] / cnt, qSum[qi][1] / cnt, qSum[qi][2] / cnt);
        }
        return feats;
    }

    function decodePortableTfliteWeights(binBytes) {
        const b = toUint8(binBytes);
        if (!b || b.length < 32) return null;
        const marker = '__SELADA_PORTABLE_WEIGHTS_JSON__:';
        let text = '';
        try {
            if (typeof TextDecoder !== 'undefined') {
                text = new TextDecoder('utf-8', { fatal: false }).decode(b);
            } else {
                for (let i = 0; i < b.length; i++) text += String.fromCharCode(b[i]);
            }
        } catch {
            return null;
        }
        const idx = text.indexOf(marker);
        if (idx < 0) return null;
        try {
            return JSON.parse(text.slice(idx + marker.length));
        } catch {
            return null;
        }
    }

    /**
     * Validasi 7 kriteria wajib paket model CNN hasil ekspor Google Colab:
     * 1. Kelengkapan file (model.keras/model.tflite, class_names.json, metadata.json, evaluation.json)
     * 2. Empat kelas wajib (siap_panen, mendekati_panen, masa_pertumbuhan, bukan_selada)
     * 3. Konsistensi urutan label
     * 4. Validitas input_shape ([H, W, 3])
     * 5. Validitas preprocessing & normalisasi
     * 6. Validitas arsitektur, versi, sumber Colab & metrik evaluasi
     * 7. Integritas header biner & kompatibilitas runtime
     */
    function validateModelBundle(filesMap) {
        if (!filesMap || typeof filesMap !== 'object') {
            return { ok: false, stage: 'files', error: 'Paket model harus berupa objek berisi berkas hasil ekspor Colab' };
        }
        const missing = [];
        CNN_SPEC.requiredFiles.forEach(f => {
            if (filesMap[f] === undefined || filesMap[f] === null || filesMap[f] === '') {
                missing.push(f);
            }
        });
        const hasBin = CNN_SPEC.binaryCandidates.some(b => filesMap[b] && (filesMap[b].length || filesMap[b].byteLength));
        if (!hasBin) {
            missing.push('model_selada_v2.h5 (atau model.keras / model.tflite)');
        }
        if (missing.length) {
            return {
                ok: false,
                stage: 'files',
                missingFiles: missing,
                error: `File model belum lengkap. File yang kurang: ${missing.join(', ')}`
            };
        }

        const parseJsonFile = (name) => {
            const raw = filesMap[name];
            if (raw && typeof raw === 'object' && !(raw instanceof Uint8Array) && !(raw instanceof ArrayBuffer)) {
                return { ok: true, data: raw };
            }
            try {
                let str = '';
                const u8 = toUint8(raw);
                if (u8 && typeof TextDecoder !== 'undefined') {
                    str = new TextDecoder('utf-8').decode(u8);
                } else {
                    str = String(raw);
                }
                return { ok: true, data: JSON.parse(str) };
            } catch (err) {
                return { ok: false, error: `File ${name} bukan JSON valid: ${err.message || err}` };
            }
        };

        const cRes = parseJsonFile('class_names.json');
        if (!cRes.ok) return { ok: false, stage: 'json_parse', error: cRes.error };
        const mRes = parseJsonFile('metadata.json');
        if (!mRes.ok) return { ok: false, stage: 'json_parse', error: mRes.error };
        const eRes = parseJsonFile('evaluation.json');
        if (!eRes.ok) return { ok: false, stage: 'json_parse', error: eRes.error };

        // Validasi 3 kelas output aktif pada model_selada_v2.h5 (jangan memaksakan 4 kelas dan jangan mengubah urutan output model)
        const rawClasses = Array.isArray(cRes.data)
            ? cRes.data
            : (cRes.data && Array.isArray(cRes.data.class_names) ? cRes.data.class_names : null);
        if (!Array.isArray(rawClasses) || rawClasses.length !== 3) {
            return {
                ok: false,
                stage: 'classes',
                error: `class_names.json wajib berisi tepat 3 kelas aktif (${CNN_SPEC.activeClasses.join(', ')}) sesuai output model_selada_v2.h5`
            };
        }
        const classNames = rawClasses.map(c => String(c).trim());
        const uniqueSet = new Set(classNames);
        const hasAllActive = CNN_SPEC.activeClasses.every(req => uniqueSet.has(req));
        if (uniqueSet.size !== 3 || !hasAllActive) {
            return {
                ok: false,
                stage: 'classes',
                error: `Tiga kelas output model tidak sesuai. Wajib memuat: ${CNN_SPEC.activeClasses.join(', ')} (kelas bukan_selada hanya elemen UI informatif)`
            };
        }

        const metadata = mRes.data;
        const evaluation = eRes.data;
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
            return { ok: false, stage: 'metadata', error: 'metadata.json harus berupa objek JSON' };
        }

        // Urutan label harus identik dengan urutan output asli model (tanpa mengubah urutan)
        const metaClasses = Array.isArray(metadata.class_names) ? metadata.class_names.map(c => String(c).trim()) : null;
        if (!metaClasses || metaClasses.length !== 3 || metaClasses.some((c, i) => c !== classNames[i])) {
            return {
                ok: false,
                stage: 'label_order',
                error: 'Urutan label pada metadata.json tidak cocok dengan class_names.json'
            };
        }
        if (evaluation && Array.isArray(evaluation.class_names)) {
            const evalClasses = evaluation.class_names.map(c => String(c).trim());
            if (evalClasses.length !== 3 || evalClasses.some((c, i) => c !== classNames[i])) {
                return {
                    ok: false,
                    stage: 'label_order',
                    error: 'Urutan label pada evaluation.json tidak cocok dengan class_names.json'
                };
            }
        }

        // Validasi input_shape
        const rawShape = metadata.input_shape;
        if (!Array.isArray(rawShape) || (rawShape.length !== 3 && rawShape.length !== 4)) {
            return { ok: false, stage: 'input_shape', error: 'input_shape pada metadata.json harus [H, W, 3] atau [1, H, W, 3]' };
        }
        if (rawShape.length === 4 && rawShape[0] !== 1 && rawShape[0] !== null) {
            return { ok: false, stage: 'input_shape', error: 'Dimensi batch input_shape harus 1 atau null' };
        }
        const shape3d = rawShape.length === 4 ? rawShape.slice(1) : rawShape;
        const inH = Number(shape3d[0]);
        const inW = Number(shape3d[1]);
        const inC = Number(shape3d[2]);
        if (!Number.isInteger(inH) || !Number.isInteger(inW) || inC !== 3 || inH < 64 || inH > 1024 || inW < 64 || inW > 1024) {
            return {
                ok: false,
                stage: 'input_shape',
                error: `input_shape [${inH}, ${inW}, ${inC}] tidak valid (wajib 64..1024 px dan 3 channel RGB)`
            };
        }

        // Validasi preprocessing & normalisasi
        const prep = metadata.preprocessing;
        if (!prep || typeof prep !== 'object') {
            return { ok: false, stage: 'preprocessing', error: 'metadata.json wajib memiliki objek preprocessing' };
        }
        const colorMode = String(prep.color_mode || '').trim().toUpperCase();
        if (colorMode !== 'RGB') {
            return { ok: false, stage: 'preprocessing', error: `preprocessing.color_mode '${colorMode}' tidak didukung (wajib 'RGB')` };
        }
        const resizeMode = String(prep.resize_mode || '').trim().toLowerCase();
        if (!CNN_SPEC.supportedResizeModes.includes(resizeMode)) {
            return { ok: false, stage: 'preprocessing', error: `preprocessing.resize_mode '${resizeMode}' tidak didukung` };
        }
        const normMode = String(prep.normalization || '').trim().toLowerCase();
        if (!CNN_SPEC.supportedNormalizations.includes(normMode)) {
            return { ok: false, stage: 'normalization', error: `preprocessing.normalization '${normMode}' tidak didukung` };
        }
        if (prep.target_size !== undefined) {
            if (!Array.isArray(prep.target_size) || prep.target_size.length !== 2 ||
                Number(prep.target_size[0]) !== inH || Number(prep.target_size[1]) !== inW) {
                return { ok: false, stage: 'preprocessing', error: 'preprocessing.target_size tidak cocok dengan input_shape' };
            }
        }

        // Validasi arsitektur, versi, format, sumber Colab, dan metrik evaluasi
        const modelVersion = String(metadata.model_version || '').trim();
        const architecture = String(metadata.architecture || '').trim();
        const format = String(metadata.format || '').trim().toLowerCase();
        const trainingSource = String(metadata.training_source || metadata.exported_from || 'google_colab').trim().toLowerCase();
        if (!modelVersion) return { ok: false, stage: 'architecture', error: 'metadata.json wajib memiliki model_version' };
        if (!architecture) return { ok: false, stage: 'architecture', error: 'metadata.json wajib memiliki architecture' };
        if (!CNN_SPEC.supportedFormats.includes(format)) {
            return { ok: false, stage: 'architecture', error: `Format model '${format}' tidak didukung (wajib 'tflite' atau 'keras')` };
        }
        if (trainingSource !== 'google_colab') {
            return { ok: false, stage: 'architecture', error: `Sumber training '${trainingSource}' ditolak (wajib 'google_colab')` };
        }

        for (const mKey of ['accuracy', 'precision_macro', 'recall_macro', 'f1_macro']) {
            const val = Number(evaluation && evaluation[mKey]);
            if (!Number.isFinite(val) || val < 0 || val > 1) {
                return { ok: false, stage: 'evaluation', error: `Metrik evaluasi '${mKey}' pada evaluation.json tidak valid` };
            }
        }
        if (!Array.isArray(evaluation.confusion_matrix) || evaluation.confusion_matrix.length !== 3 ||
            evaluation.confusion_matrix.some(r => !Array.isArray(r) || r.length !== 3)) {
            return { ok: false, stage: 'evaluation', error: 'evaluation.json wajib memiliki confusion_matrix 3x3 sesuai 3 kelas output model_selada_v2.h5' };
        }

        // Validasi biner model & kompatibilitas runtime
        const preferredFile = String(metadata.model_file || metadata.binary_file || '').trim();
        let expectedBin = null;
        if (preferredFile && filesMap[preferredFile]) {
            expectedBin = preferredFile;
        } else if (format === 'tflite') {
            expectedBin = 'model.tflite';
        } else if (format === 'h5') {
            expectedBin = ['model_selada_v2.h5', 'model.h5', 'model.keras'].find(k => Boolean(filesMap[k])) || 'model_selada_v2.h5';
        } else {
            expectedBin = ['model.keras', 'model_selada_v2.h5', 'model.h5'].find(k => Boolean(filesMap[k])) || 'model.keras';
        }
        const binBytes = toUint8(filesMap[expectedBin]);
        if (!binBytes || binBytes.length < 16) {
            return { ok: false, stage: 'runtime', error: `File biner ${expectedBin} sesuai format '${format}' tidak ditemukan atau kosong` };
        }

        let portableWeights = null;
        if (format === 'tflite') {
            if (binBytes.length < 32 ||
                binBytes[4] !== 0x54 || binBytes[5] !== 0x46 || binBytes[6] !== 0x4c || binBytes[7] !== 0x33) {
                return { ok: false, stage: 'runtime', error: "Header biner model.tflite tidak valid (magic 'TFL3' tidak ditemukan)" };
            }
            portableWeights = decodePortableTfliteWeights(binBytes);
        } else {
            const isZip = binBytes[0] === 0x50 && binBytes[1] === 0x4b && binBytes[2] === 0x03 && binBytes[3] === 0x04;
            const isHdf5 = binBytes[0] === 0x89 && binBytes[1] === 0x48 && binBytes[2] === 0x44 && binBytes[3] === 0x46;
            if (!isZip && !isHdf5) {
                return { ok: false, stage: 'runtime', error: `Header biner ${expectedBin} tidak valid (bukan berkas HDF5 .h5 atau Keras .keras)` };
            }
            if (isHdf5) {
                portableWeights = decodePortableTfliteWeights(binBytes);
            }
            if (!portableWeights && filesMap['portable_weights.json']) {
                const pwRes = parseJsonFile('portable_weights.json');
                if (pwRes.ok) portableWeights = pwRes.data;
            }
        }

        let runnerFn = null;
        if (portableWeights && Array.isArray(portableWeights.kernel) && Array.isArray(portableWeights.bias)) {
            const kernel = portableWeights.kernel;
            const bias = portableWeights.bias.map(Number);
            if (bias.length !== 3 || !kernel.length || kernel.some(row => !Array.isArray(row) || row.length !== 3)) {
                return { ok: false, stage: 'runtime', error: 'Dimensi bobot model portabel tidak kompatibel dengan 3 kelas output model_selada_v2.h5' };
            }
            runnerFn = (preprocResult) => {
                const feats = extractSpatialFeatures(preprocResult.tensor, inH, inW);
                const logits = [bias[0], bias[1], bias[2]];
                const fLen = Math.min(feats.length, kernel.length);
                for (let i = 0; i < fLen; i++) {
                    for (let c = 0; c < 3; c++) {
                        logits[c] += feats[i] * Number(kernel[i][c]);
                    }
                }
                return softmax1d(logits);
            };
        }

        const isTestModel = Boolean(metadata.is_test_model);
        const statusLabel = isTestModel ? 'MODEL PENGUJIAN' : 'AKTIF';

        return {
            ok: true,
            model: {
                available: true,
                status: statusLabel,
                cnn_status: statusLabel,
                model_version: modelVersion,
                architecture: architecture,
                format: format,
                binary_file: expectedBin,
                binary_size_bytes: binBytes.length,
                class_names: classNames,
                ui_classes: CNN_SPEC.uiClasses.slice(),
                unavailable_classes: { bukan_selada: CNN_SPEC.unavailableBadge },
                input_shape: [inH, inW, inC],
                preprocessing: {
                    color_mode: colorMode,
                    resize_mode: resizeMode,
                    normalization: normMode,
                    target_size: [inH, inW]
                },
                evaluation: {
                    accuracy: Number(evaluation.accuracy),
                    precision_macro: Number(evaluation.precision_macro),
                    recall_macro: Number(evaluation.recall_macro),
                    f1_macro: Number(evaluation.f1_macro),
                    test_samples: Number(evaluation.test_samples) || 0,
                    confusion_matrix: evaluation.confusion_matrix
                },
                training_source: trainingSource,
                exported_at: String(metadata.exported_at || ''),
                is_test_model: isTestModel,
                notes: String(metadata.notes || ''),
                _runner: runnerFn
            }
        };
    }

    class GrowthStore {
        constructor() {
            this.records = []; // urut naik menurut waktu (capture observasi)
            this.rtdbMap = {}; // rekaman dari Firebase RTDB /kelompok5/growth_metadata
            this.localList = []; // rekaman dari data/growth_metadata.json
            this.datasetMap = {}; // rekaman dataset CNN berlabel (/kelompok5/cnn_dataset)
            this.activeModel = null; // state model CNN hasil ekspor Google Colab yang aktif
            this.lastModelError = null;
            this.listeners = [];
            this.sig = '';
            this.loaded = false;
            this.loadDatasetCache();
        }

        /** Mengembalikan status model CNN hasil ekspor Colab saat ini (fallback: BELUM ADA MODEL). */
        getModelStatus() {
            if (!this.activeModel) {
                return {
                    available: false,
                    status: CNN_SPEC.noModelLabel,
                    cnn_status: CNN_SPEC.noModelLabel,
                    model_version: null,
                    architecture: null,
                    format: null,
                    binary_file: CNN_SPEC.defaultModelFile,
                    class_names: CNN_SPEC.activeClasses.slice(),
                    ui_classes: CNN_SPEC.uiClasses.slice(),
                    unavailable_classes: { bukan_selada: CNN_SPEC.unavailableBadge },
                    input_shape: null,
                    preprocessing: null,
                    evaluation: null,
                    training_source: CNN_SPEC.trainingSource,
                    is_test_model: false,
                    last_error: this.lastModelError
                };
            }
            const m = this.activeModel;
            return {
                available: true,
                status: m.status,
                cnn_status: m.status,
                model_version: m.model_version,
                architecture: m.architecture,
                format: m.format,
                binary_file: m.binary_file,
                binary_size_bytes: m.binary_size_bytes,
                class_names: m.class_names.slice(),
                ui_classes: CNN_SPEC.uiClasses.slice(),
                unavailable_classes: { bukan_selada: CNN_SPEC.unavailableBadge },
                input_shape: m.input_shape.slice(),
                preprocessing: Object.assign({}, m.preprocessing),
                evaluation: Object.assign({}, m.evaluation),
                training_source: m.training_source,
                exported_at: m.exported_at,
                is_test_model: Boolean(m.is_test_model),
                notes: m.notes || '',
                last_error: this.lastModelError
            };
        }

        /**
         * Validasi & registrasikan paket model CNN hasil ekspor Google Colab secara atomik.
         * Jika validasi gagal, model aktif sebelumnya TETAP DIPERTAHANKAN (atomic rollback).
         */
        registerOrImportModel(filesMap) {
            const v = validateModelBundle(filesMap);
            if (!v.ok) {
                this.lastModelError = v.error;
                return {
                    ok: false,
                    stage: v.stage,
                    error: v.error,
                    rolledBackToPrevious: Boolean(this.activeModel),
                    activeModel: this.getModelStatus()
                };
            }
            this.activeModel = v.model;
            this.lastModelError = null;
            this._rebuildAndNotify(true);
            return {
                ok: true,
                status: v.model.status,
                rolledBackToPrevious: false,
                activeModel: this.getModelStatus()
            };
        }

        clearActiveModel() {
            this.activeModel = null;
            this.lastModelError = null;
            this._rebuildAndNotify(true);
            return this.getModelStatus();
        }

        /**
         * Jalankan inferensi melalui adapter terpisah.
         * Jika belum ada model aktif, mengembalikan status jujur `BELUM ADA MODEL`
         * tanpa mengarang hasil prediksi.
         */
        runInference(imageInput, opts = {}) {
            const leafWidthPx = opts.leafWidthPx !== undefined ? opts.leafWidthPx : null;
            const nowMs = Number(opts.timestampMs) > 0 ? Number(opts.timestampMs) : Date.now();
            if (!this.activeModel) {
                return {
                    cnn_status: CNN_SPEC.noModelLabel,
                    cnn_class: null,
                    cnn_confidence: null,
                    cnn_probabilities: null,
                    model_version: null,
                    model_architecture: null,
                    classified_at: null,
                    is_test_model: false,
                    supporting_leaf_width_px: leafWidthPx
                };
            }
            const m = this.activeModel;
            if (!imageInput || !imageInput.rgbBytes || !imageInput.width || !imageInput.height || typeof m._runner !== 'function') {
                return {
                    cnn_status: m.status,
                    cnn_class: null,
                    cnn_confidence: null,
                    cnn_probabilities: null,
                    model_version: m.model_version,
                    model_architecture: m.architecture,
                    classified_at: null,
                    is_test_model: Boolean(m.is_test_model),
                    supporting_leaf_width_px: leafWidthPx
                };
            }
            const prep = preprocessImagePixels(
                imageInput.rgbBytes,
                Number(imageInput.width),
                Number(imageInput.height),
                m.input_shape,
                m.preprocessing
            );
            const probs = m._runner(prep);
            if (!Array.isArray(probs) || probs.length !== 3) {
                return {
                    cnn_status: m.status,
                    cnn_class: null,
                    cnn_confidence: null,
                    cnn_probabilities: null,
                    model_version: m.model_version,
                    model_architecture: m.architecture,
                    classified_at: null,
                    is_test_model: Boolean(m.is_test_model),
                    supporting_leaf_width_px: leafWidthPx
                };
            }
            let topIdx = 0;
            for (let i = 1; i < 3; i++) {
                if (probs[i] > probs[topIdx]) topIdx = i;
            }
            const predClass = m.class_names[topIdx];
            const conf = Math.round(probs[topIdx] * 10000) / 10000;
            // Hanya 3 kelas aktif model_selada_v2.h5 yang masuk cnn_probabilities;
            // kelas bukan_selada TIDAK diberi probabilitas buatan atau confidence palsu.
            const probsMap = {};
            m.class_names.forEach((cName, idx) => {
                probsMap[cName] = Math.round(probs[idx] * 10000) / 10000;
            });
            return {
                cnn_status: m.status,
                cnn_class: predClass,
                cnn_confidence: conf,
                cnn_probabilities: probsMap,
                unavailable_classes: { bukan_selada: CNN_SPEC.unavailableBadge },
                model_version: m.model_version,
                model_architecture: m.architecture,
                classified_at: nowMs,
                is_test_model: Boolean(m.is_test_model),
                supporting_leaf_width_px: leafWidthPx
            };
        }

        async loadModelFromModelsDir(fetchImpl) {
            const fetchFn = fetchImpl || (typeof fetch === 'function' ? fetch : null);
            if (!fetchFn) return this.getModelStatus();
            try {
                // 1. Cek endpoint backend model_status bila tersedia
                const apiResp = await fetchFn(`${DATASET_API_URL}?action=model_status`, { cache: 'no-store' });
                if (apiResp && apiResp.ok) {
                    const apiData = await apiResp.json();
                    if (apiData && apiData.ok && apiData.model && apiData.model.available) {
                        this.activeModel = Object.assign({}, apiData.model, {
                            status: apiData.model.cnn_status || (apiData.model.is_test_model ? 'MODEL PENGUJIAN' : 'AKTIF')
                        });
                        this.lastModelError = null;
                        this._rebuildAndNotify(true);
                        return this.getModelStatus();
                    }
                }
            } catch {
                // Lanjutkan pengecekan direktori models/ statis
            }

            try {
                const metaResp = await fetchFn('models/metadata.json', { cache: 'no-store' });
                if (!metaResp || !metaResp.ok) {
                    return this.getModelStatus();
                }
                const metadata = await metaResp.json();
                const clsResp = await fetchFn('models/class_names.json', { cache: 'no-store' });
                const evalResp = await fetchFn('models/evaluation.json', { cache: 'no-store' });
                if (!clsResp || !clsResp.ok || !evalResp || !evalResp.ok) {
                    this.lastModelError = 'File class_names.json atau evaluation.json tidak ditemukan di models/';
                    return this.getModelStatus();
                }
                const classNames = await clsResp.json();
                const evaluation = await evalResp.json();
                const fmt = String((metadata && metadata.format) || 'h5').toLowerCase();
                const binName = String((metadata && (metadata.model_file || metadata.binary_file)) || (fmt === 'tflite' ? 'model.tflite' : (fmt === 'keras' ? 'model.keras' : 'model_selada_v2.h5')));
                const binResp = await fetchFn('models/' + binName, { cache: 'no-store' });
                if (!binResp || !binResp.ok) {
                    this.lastModelError = `File biner models/${binName} tidak ditemukan`;
                    return this.getModelStatus();
                }
                const binBuf = await binResp.arrayBuffer();
                const bundle = {
                    'class_names.json': classNames,
                    'metadata.json': metadata,
                    'evaluation.json': evaluation
                };
                bundle[binName] = new Uint8Array(binBuf);
                this.registerOrImportModel(bundle);
            } catch {
                // Tidak ada model di models/ -> tetap BELUM ADA MODEL
            }
            return this.getModelStatus();
        }

        loadDatasetCache() {
            try {
                if (typeof localStorage === 'undefined') return;
                const raw = localStorage.getItem(DATASET_CACHE_KEY);
                if (!raw) return;
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') {
                    Object.keys(parsed).forEach(k => {
                        const norm = this.normalizeDatasetRecord(parsed[k]);
                        if (norm) this.datasetMap[norm.id] = norm;
                    });
                }
            } catch (e) {
                console.warn('[GrowthStore] gagal membaca cache dataset:', e);
            }
        }

        saveDatasetCache() {
            try {
                if (typeof localStorage === 'undefined') return;
                localStorage.setItem(DATASET_CACHE_KEY, JSON.stringify(this.datasetMap));
            } catch (e) {
                console.warn('[GrowthStore] gagal menyimpan cache dataset:', e);
            }
        }

        onChange(fn) {
            if (typeof fn === 'function') this.listeners.push(fn);
        }

        normalize(raw) {
            if (!raw || typeof raw !== 'object') return null;
            const t = Number(raw.captured_at || raw.created_at);
            if (!Number.isFinite(t) || t < 1e11) return null;
            const width = Number(raw.leaf_width_px);
            const widthMm = Number(raw.leaf_width_mm);
            const area = Number(raw.leaf_area_px);
            const areaMm2 = Number(raw.leaf_area_mm2);
            const conf = Number(raw.cnn_confidence);
            const cls = normClass(raw.cnn_class !== undefined ? raw.cnn_class : raw.stage);
            const datasetLabel = normClass(raw.label !== undefined ? raw.label : raw.dataset_label);
            const classifiedAt = Number(raw.classified_at);
            const rawStatus = raw.cnn_status ? String(raw.cnn_status).replace(/_/g, ' ') : '';
            return {
                id: String(raw.image_id || raw.dataset_id || raw.slot_key || ('img_' + t)),
                slotKey: String(raw.slot_key || ''),
                plantId: String(raw.plant_id || 'SLD-01'),
                t: t,
                hst: Number(raw.hst_day) > 0 ? Number(raw.hst_day) : null,
                width: Number.isFinite(width) && width > 0 ? width : null,
                widthMm: Number.isFinite(widthMm) && widthMm > 0 ? widthMm : null,
                area: Number.isFinite(area) && area >= 0 ? area : null,
                areaMm2: Number.isFinite(areaMm2) && areaMm2 > 0 ? areaMm2 : null,
                valid: String(raw.quality_status || 'VALID').toUpperCase() === 'VALID',
                qualityStatus: String(raw.quality_status || 'VALID').toUpperCase(),
                qualityDetail: String(raw.quality_detail || ''),
                cls: cls,
                datasetLabel: datasetLabel,
                cnnStatus: rawStatus && rawStatus !== 'BELUM DILATIH'
                    ? rawStatus
                    : (cls ? (raw.is_test_model ? 'MODEL PENGUJIAN' : 'AKTIF') : CNN_SPEC.noModelLabel),
                conf: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : null,
                probabilities: raw.cnn_probabilities && typeof raw.cnn_probabilities === 'object' ? raw.cnn_probabilities : null,
                modelVersion: raw.model_version ? String(raw.model_version) : null,
                modelArchitecture: raw.model_architecture ? String(raw.model_architecture) : null,
                classifiedAt: Number.isFinite(classifiedAt) && classifiedAt > 0 ? classifiedAt : null,
                isTestModel: Boolean(raw.is_test_model),
                image: safeUrl(raw.image_url),
                mask: safeUrl(raw.mask_url),
                overlay: safeUrl(raw.overlay_url),
                fnv1a: String(raw.fnv1a || raw.checksum_fnv1a || '').toLowerCase(),
                fileSize: Number(raw.file_size) > 0 ? Number(raw.file_size) : null,
                fileName: String(raw.file_name || ''),
                fileFormat: String(raw.file_format || ''),
                notes: String(raw.notes || ''),
                source: String(raw.source || raw.capture_source || 'camera_capture')
            };
        }

        normalizeDatasetRecord(raw) {
            if (!raw || typeof raw !== 'object') return null;
            const id = String(raw.dataset_id || raw.id || raw.image_id || '').trim();
            if (!id) return null;
            const label = normClass(raw.label || raw.dataset_label || raw.datasetLabel);
            if (!label) return null;
            // Tolak tegas apabila field URL mengandung Base64 data:
            if ([raw.image_url, raw.image, raw.mask_url, raw.mask, raw.overlay_url, raw.overlay].some(u => typeof u === 'string' && /^data:/i.test(u.trim()))) {
                return null;
            }
            const t = Number(raw.created_at || raw.captured_at || raw.t) || Date.now();
            const width = Number(raw.leaf_width_px !== undefined ? raw.leaf_width_px : raw.width);
            const area = Number(raw.leaf_area_px !== undefined ? raw.leaf_area_px : raw.area);
            const predCls = normClass(raw.cnn_class !== undefined ? raw.cnn_class : raw.cls);
            const conf = Number(raw.cnn_confidence !== undefined ? raw.cnn_confidence : raw.conf);
            const classifiedAt = Number(raw.classified_at !== undefined ? raw.classified_at : raw.classifiedAt);
            const rawStatus = raw.cnn_status ? String(raw.cnn_status).replace(/_/g, ' ') : '';
            return {
                id: id,
                dataset_id: id,
                t: t,
                created_at: t,
                updated_at: Number(raw.updated_at) || t,
                hst: Number(raw.hst_day || raw.hst) > 0 ? Number(raw.hst_day || raw.hst) : null,
                label: label,
                labelDisplay: CLASSES[label] ? CLASSES[label].label : label,
                cls: predCls,
                conf: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : null,
                modelVersion: raw.model_version || raw.modelVersion || null,
                classifiedAt: Number.isFinite(classifiedAt) && classifiedAt > 0 ? classifiedAt : null,
                isTestModel: Boolean(raw.is_test_model || raw.isTestModel),
                cnnStatus: rawStatus && rawStatus !== 'BELUM DILATIH'
                    ? rawStatus
                    : (predCls ? 'AKTIF' : CNN_SPEC.noModelLabel),
                width: Number.isFinite(width) && width > 0 ? width : null,
                area: Number.isFinite(area) && area >= 0 ? area : null,
                valid: String(raw.quality_status || 'VALID').toUpperCase() === 'VALID',
                qualityStatus: String(raw.quality_status || 'VALID').toUpperCase(),
                fileName: String(raw.file_name || raw.fileName || id),
                fileFormat: String(raw.file_format || raw.fileFormat || 'JPG').toUpperCase(),
                fileSize: Number(raw.file_size || raw.fileSize) || 0,
                widthPx: Number(raw.width_px || raw.widthPx) || 0,
                heightPx: Number(raw.height_px || raw.heightPx) || 0,
                fnv1a: String(raw.fnv1a || '').toLowerCase(),
                notes: String(raw.notes || ''),
                storageProvider: String(raw.storage_provider || raw.storageProvider || 'vercel_blob'),
                image: safeUrl(raw.image_url !== undefined ? raw.image_url : raw.image),
                mask: safeUrl(raw.mask_url !== undefined ? raw.mask_url : raw.mask),
                overlay: safeUrl(raw.overlay_url !== undefined ? raw.overlay_url : raw.overlay),
                source: 'dataset_upload'
            };
        }

        _rebuildAndNotify(forceNotify = false) {
            const byId = new Map();
            const addRaw = (raw) => {
                const n = this.normalize(raw);
                if (n) byId.set(n.id, n);
            };
            (this.localList || []).forEach(addRaw);
            Object.keys(this.rtdbMap || {}).forEach(k => addRaw(this.rtdbMap[k]));

            const rows = Array.from(byId.values()).sort((a, b) => a.t - b.t);
            const last = rows[rows.length - 1];
            const dsKeys = Object.keys(this.datasetMap || {}).sort();
            const dsSig = dsKeys.map(k => {
                const d = this.datasetMap[k];
                return k + ':' + d.label + ':' + d.updated_at;
            }).join('|');
            const sig = rows.length + ':' + (last ? last.t + ':' + last.cls + ':' + last.width : '') + '#' + dsSig;
            if (forceNotify || !this.loaded || sig !== this.sig) {
                this.records = rows;
                this.sig = sig;
                this.loaded = true;
                this.listeners.forEach(fn => {
                    try { fn(this); } catch (e) { console.error('[GrowthStore] listener error:', e); }
                });
            }
        }

        /** Menerima objek map growth_metadata dari Firebase RTDB (/kelompok5/growth_metadata). */
        ingestFromRTDB(mapOrArray) {
            if (!mapOrArray || typeof mapOrArray !== 'object') return;
            if (Array.isArray(mapOrArray)) {
                mapOrArray.forEach((item, idx) => {
                    if (item && typeof item === 'object') {
                        this.rtdbMap[item.image_id || item.slot_key || ('rtdb_' + idx)] = item;
                    }
                });
            } else {
                Object.keys(mapOrArray).forEach(k => {
                    if (mapOrArray[k] && typeof mapOrArray[k] === 'object') {
                        this.rtdbMap[k] = mapOrArray[k];
                    }
                });
            }
            this._rebuildAndNotify();
        }

        /** Menerima objek map cnn_dataset dari Firebase RTDB (/kelompok5/cnn_dataset) tanpa menghapus data lama. */
        ingestDatasetFromRTDB(mapOrArray) {
            if (!mapOrArray || typeof mapOrArray !== 'object') return;
            const list = Array.isArray(mapOrArray) ? mapOrArray : Object.values(mapOrArray);
            list.forEach(item => {
                const norm = this.normalizeDatasetRecord(item);
                if (norm) {
                    const prev = this.datasetMap[norm.id];
                    if (!prev || norm.updated_at >= prev.updated_at) {
                        this.datasetMap[norm.id] = norm;
                    }
                }
            });
            this.saveDatasetCache();
            this._rebuildAndNotify();
        }

        _getFirebaseBaseUrl() {
            const Cfg = window.ConfigStore;
            const Sec = window.SecurityUtils;
            if (!Cfg || !Sec || typeof Cfg.get !== 'function') return '';
            const fbBase = (Cfg.get().firebase || '').trim()
                .replace(/\/+$/, '')
                .replace(/\/kelompok5\.json$/i, '')
                .replace(/\/\.json$/i, '');
            return Sec.isValidFirebaseUrl(fbBase) ? fbBase : '';
        }

        async load() {
            try {
                const resp = await fetch(DATA_URL, { cache: 'no-store' });
                if (resp && resp.ok) {
                    const data = await resp.json();
                    if (Array.isArray(data)) {
                        this.localList = data;
                    }
                }
            } catch (err) {
                console.warn('[GrowthStore] gagal memuat ' + DATA_URL + ':', err);
            }

            // Muat dataset CNN lokal bila ada (mode dev)
            try {
                const dsResp = await fetch(DATASET_LOCAL_URL, { cache: 'no-store' });
                if (dsResp && dsResp.ok) {
                    const dsData = await dsResp.json();
                    if (dsData && typeof dsData === 'object') {
                        this.ingestDatasetFromRTDB(dsData);
                    }
                }
            } catch {
                // Abaikan bila file lokal belum ada
            }

            // Muat dataset dari API /api/kelompok5/dataset bila tersedia
            try {
                const apiResp = await fetch(DATASET_API_URL, { cache: 'no-store' });
                if (apiResp && apiResp.ok) {
                    const apiJson = await apiResp.json();
                    if (apiJson && apiJson.ok) {
                        if (Array.isArray(apiJson.records)) {
                            this.ingestDatasetFromRTDB(apiJson.records);
                        }
                        if (apiJson.cnn_model && apiJson.cnn_model.available) {
                            this.activeModel = Object.assign({}, apiJson.cnn_model, {
                                status: apiJson.cnn_model.cnn_status || (apiJson.cnn_model.is_test_model ? 'MODEL PENGUJIAN' : 'AKTIF')
                            });
                            this.lastModelError = null;
                        }
                    }
                }
            } catch {
                // Abaikan bila berjalan pada static server murni
            }

            // Cek berkas model hasil ekspor Google Colab pada direktori models/ bila belum aktif
            if (!this.activeModel) {
                await this.loadModelFromModelsDir();
            }

            // Sinkronisasi tambahan dari Firebase RTDB /kelompok5/growth_metadata.json & /kelompok5/cnn_dataset.json
            try {
                const fbBase = this._getFirebaseBaseUrl();
                if (fbBase) {
                    const gmResp = await fetch(fbBase + '/kelompok5/growth_metadata.json', { cache: 'no-store' });
                    if (gmResp && gmResp.ok) {
                        const gmJson = await gmResp.json();
                        if (gmJson && typeof gmJson === 'object') {
                            Object.keys(gmJson).forEach(k => {
                                if (gmJson[k] && typeof gmJson[k] === 'object') {
                                    this.rtdbMap[k] = gmJson[k];
                                }
                            });
                        }
                    }
                    const dsRtdbResp = await fetch(fbBase + '/kelompok5/cnn_dataset.json', { cache: 'no-store' });
                    if (dsRtdbResp && dsRtdbResp.ok) {
                        const dsRtdbJson = await dsRtdbResp.json();
                        if (dsRtdbJson && typeof dsRtdbJson === 'object') {
                            this.ingestDatasetFromRTDB(dsRtdbJson);
                        }
                    }
                }
            } catch {
                // Abaikan bila offline atau node belum ada
            }

            this._rebuildAndNotify();
        }

        start() {
            this.load();
            setInterval(() => this.load(), REFRESH_MS);
        }

        /** Citra lolos QC (valid). */
        validRecords() { return this.records.filter(r => r.valid); }

        /** Citra valid yang benar-benar selada dan punya lebar daun. */
        lettuceRecords() {
            return this.records.filter(r => r.valid && r.cls !== 'bukan_selada' && r.width !== null);
        }

        latest() {
            const v = this.validRecords();
            return v.length ? v[v.length - 1] : null;
        }

        classCounts() {
            const c = {
                masa_pertumbuhan: 0,
                mendekati_panen: 0,
                siap_panen: 0,
                bukan_selada: 0,
                belum: 0,
                activeTotal: 0,
                unavailable: { bukan_selada: CNN_SPEC.unavailableBadge }
            };
            this.validRecords().forEach(r => {
                // Kelas bukan_selada hanya elemen UI informatif (BELUM TERSEDIA), tidak dihitung sebagai output inferensi
                if (r.cls && CNN_SPEC.activeClasses.includes(r.cls)) {
                    c[r.cls]++;
                    c.activeTotal++;
                } else if (!r.cls) {
                    c.belum++;
                }
            });
            return c;
        }

        /** Statistik lebar daun pendukung untuk 3 kelas aktif CNN dan penanda kelas belum tersedia. */
        widthStats() {
            const lettuce = this.lettuceRecords();
            const byClass = {
                siap_panen: { count: 0, sumWidth: 0, avgWidth: null, active: true, status: 'AKTIF' },
                mendekati_panen: { count: 0, sumWidth: 0, avgWidth: null, active: true, status: 'AKTIF' },
                masa_pertumbuhan: { count: 0, sumWidth: 0, avgWidth: null, active: true, status: 'AKTIF' },
                bukan_selada: { count: 0, sumWidth: 0, avgWidth: null, active: false, status: CNN_SPEC.unavailableBadge },
                belum: { count: 0, sumWidth: 0, avgWidth: null, active: true, status: 'BELUM DIKLASIFIKASI' }
            };
            this.validRecords().forEach(r => {
                if (r.cls === 'bukan_selada') return; // Tidak dihitung ke statistik inferensi
                const k = (r.cls && CNN_SPEC.activeClasses.includes(r.cls)) ? r.cls : 'belum';
                byClass[k].count++;
                if (r.width !== null && Number.isFinite(r.width)) {
                    byClass[k].sumWidth += r.width;
                }
            });
            ['siap_panen', 'mendekati_panen', 'masa_pertumbuhan', 'belum'].forEach(k => {
                const b = byClass[k];
                const withWidth = this.validRecords().filter(r => ((r.cls && CNN_SPEC.activeClasses.includes(r.cls)) ? r.cls : 'belum') === k && r.cls !== 'bukan_selada' && r.width !== null).length;
                b.avgWidth = withWidth > 0 ? b.sumWidth / withWidth : null;
                b.avg = b.avgWidth;
            });
            byClass.bukan_selada.avg = null;

            if (!lettuce.length) {
                return { count: 0, min: null, max: null, avg: null, latest: null, byClass: byClass };
            }
            let min = Infinity, max = -Infinity, sum = 0;
            lettuce.forEach(r => {
                if (r.width < min) min = r.width;
                if (r.width > max) max = r.width;
                sum += r.width;
            });
            return {
                count: lettuce.length,
                min: min,
                max: max,
                avg: sum / lettuce.length,
                latest: lettuce[lettuce.length - 1],
                byClass: byClass
            };
        }

        hasClassified() {
            return this.validRecords().some(r => r.cls !== null);
        }

        /** Rata-rata lebar daun per hari (WIB) + kelas dominan CNN hari itu. */
        daily() {
            const days = new Map();
            this.lettuceRecords().forEach(r => {
                const k = wibDayKey(r.t);
                if (!days.has(k)) days.set(k, { sum: 0, n: 0, cls: {} });
                const d = days.get(k);
                d.sum += r.width;
                d.n++;
                if (r.cls && CLASSES[r.cls].ord !== null) d.cls[r.cls] = (d.cls[r.cls] || 0) + 1;
            });
            return Array.from(days.keys()).sort().map(k => {
                const d = days.get(k);
                const top = Object.keys(d.cls).sort((a, b) => d.cls[b] - d.cls[a])[0];
                return {
                    day: k,
                    t: Date.parse(k + 'T00:00:00Z'),
                    width: d.sum / d.n,
                    stage: top ? CLASSES[top].ord : null,
                    n: d.n
                };
            });
        }

        // ======================================================================
        // CNN DATASET MANAGER (4 Kelas, Tanpa Base64, Persistensi RTDB + Blob)
        // ======================================================================
        datasetRecords() {
            return Object.values(this.datasetMap || {}).sort((a, b) => b.created_at - a.created_at);
        }

        hasHash(fnv1aHex) {
            if (!fnv1aHex) return null;
            const h = String(fnv1aHex).trim().toLowerCase();
            const foundDs = this.datasetRecords().find(r => r.fnv1a === h);
            if (foundDs) return foundDs.id;
            const foundCap = this.records.find(r => r.fnv1a === h);
            if (foundCap) return foundCap.id;
            return null;
        }

        /**
         * Validasi kandidat gambar sebelum diunggah:
         * - Label 4 kelas wajib valid
         * - Format JPG/JPEG/PNG/WEBP via magic bytes (bukan Base64)
         * - Ukuran file 100 B .. 4.5 MB
         * - Dimensi 64x64 .. 4096x4096 px & tidak rusak (corrupt)
         * - Deteksi duplikasi via checksum FNV-1a terhadap dataset & antrean
         */
        validateCandidateFile(cand, seenHashes = new Set()) {
            if (!cand || typeof cand !== 'object') {
                return { ok: false, code: 'INVALID_INPUT', error: 'Data file tidak valid' };
            }
            const label = normClass(cand.label);
            if (!label) {
                return { ok: false, code: 'INVALID_LABEL', error: 'Pilih salah satu dari 4 label kelas CNN' };
            }
            if (cand.corrupt) {
                return { ok: false, code: 'CORRUPT_IMAGE', error: 'File gambar rusak atau gagal didekode' };
            }
            const bytes = toUint8(cand.bytes);
            if (!bytes || !bytes.length) {
                return { ok: false, code: 'EMPTY_FILE', error: 'File kosong' };
            }
            if (bytes.length < MIN_FILE_BYTES) {
                return { ok: false, code: 'FILE_TOO_SMALL', error: `Ukuran file (${bytes.length} B) terlalu kecil (min ${MIN_FILE_BYTES} B)` };
            }
            if (bytes.length > MAX_FILE_BYTES) {
                return { ok: false, code: 'FILE_TOO_LARGE', error: `Ukuran file melebihi batas maksimal 4.5 MB` };
            }
            const fmt = detectImageFormat(bytes);
            if (!fmt.ok) {
                return { ok: false, code: 'INVALID_FORMAT', error: fmt.error };
            }
            const w = Number(cand.width);
            const h = Number(cand.height);
            if (Number.isFinite(w) && Number.isFinite(h) && (w > 0 || h > 0)) {
                if (w < MIN_IMG_DIM || h < MIN_IMG_DIM) {
                    return { ok: false, code: 'DIM_TOO_SMALL', error: `Dimensi ${w}×${h} px terlalu kecil (min ${MIN_IMG_DIM}×${MIN_IMG_DIM} px)` };
                }
                if (w > MAX_IMG_DIM || h > MAX_IMG_DIM) {
                    return { ok: false, code: 'DIM_TOO_LARGE', error: `Dimensi ${w}×${h} px melebihi batas ${MAX_IMG_DIM}×${MAX_IMG_DIM} px` };
                }
            }
            const fnv1a = computeFnv1aHex(bytes);
            if (seenHashes && seenHashes.has(fnv1a)) {
                return { ok: false, code: 'DUPLICATE_IN_QUEUE', fnv1a, error: `Duplikat di antrean (FNV-1a: ${fnv1a})` };
            }
            const existingId = this.hasHash(fnv1a);
            if (existingId) {
                return { ok: false, code: 'DUPLICATE_IN_DB', fnv1a, existingId, error: `Gambar sudah ada di dataset (${existingId})` };
            }
            if (seenHashes) seenHashes.add(fnv1a);
            return {
                ok: true,
                code: 'VALID',
                fnv1a,
                label,
                ext: fmt.ext,
                format: fmt.format,
                contentType: fmt.contentType,
                fileSize: bytes.length
            };
        }

        /** Statistik jumlah gambar per kelas pada dataset CNN berlabel + lebar daun pendukung. */
        datasetClassStats() {
            const all = this.datasetRecords();
            const total = all.length;
            const stats = {};
            CNN_SPEC.classes.forEach(k => {
                stats[k] = {
                    key: k,
                    label: CLASSES[k].label,
                    tone: CLASSES[k].tone,
                    count: 0,
                    pct: 0,
                    sumWidth: 0,
                    widthCount: 0,
                    avgWidth: null
                };
            });
            all.forEach(r => {
                const s = stats[r.label];
                if (!s) return;
                s.count++;
                if (r.width !== null && Number.isFinite(r.width) && r.width > 0) {
                    s.sumWidth += r.width;
                    s.widthCount++;
                }
            });
            CNN_SPEC.classes.forEach(k => {
                const s = stats[k];
                s.pct = total > 0 ? Math.round((s.count / total) * 100) : 0;
                s.avgWidth = s.widthCount > 0 ? s.sumWidth / s.widthCount : null;
            });
            return {
                total,
                cnnStatus: CNN_SPEC.untrainedLabel,
                byClass: stats
            };
        }

        /**
         * Query gabungan untuk Galeri Dataset & Capture dengan filter kelas, filter sumber,
         * pencarian teks, dan pagination.
         */
        queryGallery(opts = {}) {
            const labelFilter = opts.label || 'all';
            const sourceFilter = opts.source || 'all'; // 'all' | 'dataset' | 'capture'
            const search = String(opts.search || '').trim().toLowerCase();
            const per = Math.max(1, Number(opts.per) || 8);
            let page = Math.max(1, Number(opts.page) || 1);

            let items = [];
            if (sourceFilter === 'all' || sourceFilter === 'dataset') {
                this.datasetRecords().forEach(r => {
                    items.push({
                        id: r.id,
                        isDataset: true,
                        t: r.created_at,
                        hst: r.hst,
                        label: r.label,
                        cls: r.cls,
                        conf: r.conf,
                        modelVersion: r.modelVersion,
                        classifiedAt: r.classifiedAt,
                        isTestModel: r.isTestModel,
                        cnnStatus: r.cnnStatus,
                        width: r.width,
                        area: r.area,
                        fileName: r.fileName,
                        fileFormat: r.fileFormat,
                        fileSize: r.fileSize,
                        widthPx: r.widthPx,
                        heightPx: r.heightPx,
                        fnv1a: r.fnv1a,
                        notes: r.notes,
                        image: r.image,
                        mask: r.mask,
                        overlay: r.overlay,
                        storageProvider: r.storageProvider
                    });
                });
            }
            if (sourceFilter === 'all' || sourceFilter === 'capture') {
                this.validRecords().slice().reverse().forEach(r => {
                    if (this.datasetMap[r.id]) return;
                    items.push({
                        id: r.id,
                        isDataset: false,
                        t: r.t,
                        hst: r.hst,
                        label: r.datasetLabel || r.cls || null,
                        cls: r.cls,
                        conf: r.conf,
                        modelVersion: r.modelVersion,
                        classifiedAt: r.classifiedAt,
                        isTestModel: r.isTestModel,
                        cnnStatus: r.cnnStatus,
                        width: r.width,
                        area: r.area,
                        fileName: r.fileName || r.id,
                        fileFormat: r.fileFormat || 'JPG',
                        fileSize: r.fileSize || 0,
                        widthPx: 0,
                        heightPx: 0,
                        fnv1a: r.fnv1a || '',
                        notes: r.notes || '',
                        image: r.image,
                        mask: r.mask,
                        overlay: r.overlay,
                        storageProvider: 'cv_pipeline'
                    });
                });
            }

            items.sort((a, b) => b.t - a.t);

            if (labelFilter !== 'all') {
                if (labelFilter === 'belum') {
                    items = items.filter(it => !it.label && !it.cls);
                } else {
                    items = items.filter(it => (it.label || it.cls) === labelFilter);
                }
            }

            if (search) {
                items = items.filter(it => {
                    const lblKey = it.label || it.cls || '';
                    const lblText = (lblKey && CLASSES[lblKey] ? CLASSES[lblKey].label : 'belum dilabeli').toLowerCase();
                    const dateStr = new Date(it.t).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }).toLowerCase();
                    return it.id.toLowerCase().includes(search) ||
                        it.fileName.toLowerCase().includes(search) ||
                        it.fnv1a.toLowerCase().includes(search) ||
                        it.notes.toLowerCase().includes(search) ||
                        lblText.includes(search) ||
                        dateStr.includes(search) ||
                        (it.hst !== null && ('hst ' + it.hst).includes(search));
                });
            }

            const total = items.length;
            const totalPages = Math.max(1, Math.ceil(total / per));
            page = Math.min(totalPages, Math.max(1, page));
            const start = (page - 1) * per;
            return {
                rows: items.slice(start, start + per),
                allFiltered: items,
                total,
                page,
                per,
                totalPages
            };
        }

        /**
         * Unggah satu item gambar ke backend /api/kelompok5/dataset dan sinkronkan
         * metadata ke Firebase RTDB (/kelompok5/cnn_dataset/<id>) tanpa Base64.
         */
        async uploadDatasetItem(cand, opts = {}) {
            const v = this.validateCandidateFile(cand, opts.seenHashes || null);
            if (!v.ok) {
                return { ok: false, status: 422, code: v.code, error: v.error, fnv1a: v.fnv1a };
            }
            const bytes = toUint8(cand.bytes) || new Uint8Array(0);
            const token = String(opts.token || '').trim();
            const headers = {
                'Content-Type': v.contentType,
                'X-Dataset-Label': v.label,
                'X-File-Name': encodeURIComponent(cand.fileName || ('selada.' + v.ext)),
                'X-File-Size': String(bytes.length),
                'X-Checksum-FNV1A': v.fnv1a
            };
            if (token) {
                headers.Authorization = 'Bearer ' + token;
                headers['X-Capture-Token'] = token;
            }
            if (cand.hst && Number(cand.hst) > 0) {
                headers['X-HST-Day'] = String(Math.round(Number(cand.hst)));
            }
            if (cand.notes) {
                headers['X-Notes'] = encodeURIComponent(String(cand.notes).trim().slice(0, 200));
            }

            const fetchFn = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
            let serverRec = null;
            let lastErr = null;
            let status = 0;

            if (fetchFn) {
                try {
                    const resp = await fetchFn(opts.endpoint || DATASET_API_URL, {
                        method: 'POST',
                        headers,
                        body: bytes
                    });
                    status = resp.status;
                    let data = null;
                    try { data = await resp.json(); } catch { data = null; }
                    if (resp.status === 200 && data && data.ok && data.record) {
                        serverRec = data.record;
                    } else if (resp.status === 401 || resp.status === 403 || resp.status === 409 || resp.status === 413 || resp.status === 422) {
                        return {
                            ok: false,
                            status: resp.status,
                            duplicate: Boolean(data && data.duplicate),
                            error: (data && data.error) ? data.error : `Server menolak upload (HTTP ${resp.status})`
                        };
                    } else {
                        lastErr = (data && data.error) ? data.error : `Endpoint ${DATASET_API_URL} mengembalikan HTTP ${resp.status}`;
                    }
                } catch (err) {
                    lastErr = err && err.message ? err.message : String(err);
                }
            }

            // Bila backend API mengembalikan rekaman valid, simpan ke store & sinkronkan ke RTDB
            if (serverRec) {
                const norm = this.normalizeDatasetRecord(serverRec);
                if (!norm) {
                    return { ok: false, status: 500, error: 'Respons server mengandung format metadata tidak valid' };
                }
                this.datasetMap[norm.id] = norm;
                this.saveDatasetCache();
                this._rebuildAndNotify(true);
                return { ok: true, status: 200, record: norm };
            }

            // Fallback non-destruktif untuk mode static server / pengujian terisolasi bila diizinkan
            if (opts.allowDirectRtdbFallback !== false) {
                const nowMs = Date.now();
                const dtStr = new Date(nowMs + WIB_MS).toISOString().replace(/[-:T]/g, '').slice(0, 15);
                const dsId = `ds_${dtStr}_${v.fnv1a}`;
                const safeName = String(cand.fileName || (dsId + '.' + v.ext)).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
                // Hanya simpan path/URL file biner, TIDAK PERNAH Base64 data:
                const binUrl = safeUrl(cand.externalUrl) || `data/cnn_dataset_images/${dsId}_orig.${v.ext}`;
                const fallbackRaw = {
                    kelompok: 'Kelompok 5',
                    dataset_id: dsId,
                    image_id: dsId,
                    file_name: safeName,
                    file_format: v.format,
                    content_type: v.contentType,
                    file_size: bytes.length,
                    width_px: Number(cand.width) || 0,
                    height_px: Number(cand.height) || 0,
                    fnv1a: v.fnv1a,
                    label: v.label,
                    label_display: CLASSES[v.label].label,
                    cnn_class: null,
                    cnn_confidence: null,
                    cnn_status: this.getModelStatus().status,
                    leaf_width_px: Number(cand.leafWidthPx) > 0 ? Number(cand.leafWidthPx) : null,
                    hst_day: Number(cand.hst) > 0 ? Number(cand.hst) : null,
                    quality_status: 'VALID',
                    notes: String(cand.notes || '').replace(/[<>]/g, '').slice(0, 200),
                    source: 'dataset_upload',
                    storage_provider: 'rtdb_metadata',
                    image_url: binUrl,
                    mask_url: '',
                    overlay_url: '',
                    created_at: nowMs,
                    updated_at: nowMs,
                    captured_at: nowMs
                };

                const fbBase = this._getFirebaseBaseUrl();
                if (fbBase && fetchFn) {
                    try {
                        await fetchFn(`${fbBase}/kelompok5/cnn_dataset/${encodeURIComponent(dsId)}.json`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(fallbackRaw)
                        });
                    } catch {
                        // Tetap simpan di cache lokal bila jaringan offline
                    }
                }
                const norm = this.normalizeDatasetRecord(fallbackRaw);
                this.datasetMap[norm.id] = norm;
                this.saveDatasetCache();
                this._rebuildAndNotify(true);
                return { ok: true, status: 200, record: norm, fallback: true };
            }

            return { ok: false, status: status || 502, error: lastErr || 'Gagal mengunggah gambar ke server' };
        }

        /** Unggah satu atau banyak gambar sekaligus dengan laporan progress per file. */
        async uploadDatasetBatch(candidates, opts = {}) {
            const list = Array.isArray(candidates) ? candidates : [];
            const total = list.length;
            const results = [];
            const seenHashes = new Set();
            let successCount = 0;
            let failCount = 0;
            let dupCount = 0;

            for (let i = 0; i < total; i++) {
                const cand = list[i];
                if (typeof opts.onProgress === 'function') {
                    opts.onProgress({
                        phase: 'uploading',
                        index: i,
                        completed: i,
                        total,
                        percent: Math.round((i / total) * 100),
                        fileName: cand && cand.fileName ? cand.fileName : `File #${i + 1}`
                    });
                }
                const res = await this.uploadDatasetItem(cand, Object.assign({}, opts, { seenHashes }));
                results.push(res);
                if (res.ok) successCount++;
                else {
                    failCount++;
                    if (res.duplicate || (res.code && res.code.startsWith('DUPLICATE'))) dupCount++;
                }
                if (typeof opts.onProgress === 'function') {
                    opts.onProgress({
                        phase: i + 1 === total ? 'done' : 'uploading',
                        index: i,
                        completed: i + 1,
                        total,
                        percent: Math.round(((i + 1) / total) * 100),
                        fileName: cand && cand.fileName ? cand.fileName : `File #${i + 1}`,
                        lastResult: res
                    });
                }
            }

            return {
                ok: failCount === 0 && successCount > 0,
                total,
                successCount,
                failCount,
                dupCount,
                results
            };
        }

        /** Ubah label (dan catatan opsional) pada item dataset & simpan ke API + Firebase RTDB. */
        async updateDatasetLabel(datasetId, newLabel, notes, opts = {}) {
            const cleanId = String(datasetId || '').trim();
            const labelKey = normClass(newLabel);
            if (!cleanId || !labelKey) {
                return { ok: false, error: 'ID gambar atau label kelas CNN tidak valid' };
            }
            const existing = this.datasetMap[cleanId];
            if (!existing) {
                return { ok: false, error: `Data gambar ${cleanId} tidak ditemukan` };
            }

            const nowMs = Date.now();
            const updatedNotes = notes !== undefined ? String(notes).replace(/[<>]/g, '').slice(0, 200) : existing.notes;
            const fetchFn = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
            const token = String(opts.token || '').trim();

            if (fetchFn) {
                try {
                    const headers = { 'Content-Type': 'application/json' };
                    if (token) {
                        headers.Authorization = 'Bearer ' + token;
                        headers['X-Capture-Token'] = token;
                    }
                    const resp = await fetchFn(opts.endpoint || DATASET_API_URL, {
                        method: 'PATCH',
                        headers,
                        body: JSON.stringify({ dataset_id: cleanId, label: labelKey, notes: updatedNotes })
                    });
                    if (resp && resp.ok) {
                        const data = await resp.json();
                        if (data && data.ok && data.record) {
                            const norm = this.normalizeDatasetRecord(data.record);
                            if (norm) {
                                this.datasetMap[cleanId] = norm;
                                this.saveDatasetCache();
                                this._rebuildAndNotify(true);
                                return { ok: true, record: norm };
                            }
                        }
                    }
                } catch {
                    // Lanjutkan ke sinkronisasi RTDB & cache lokal
                }
            }

            existing.label = labelKey;
            existing.labelDisplay = CLASSES[labelKey].label;
            existing.notes = updatedNotes;
            existing.updated_at = nowMs;
            this.datasetMap[cleanId] = existing;
            this.saveDatasetCache();

            const fbBase = this._getFirebaseBaseUrl();
            if (fbBase && fetchFn) {
                try {
                    await fetchFn(`${fbBase}/kelompok5/cnn_dataset/${encodeURIComponent(cleanId)}.json`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            label: labelKey,
                            label_display: CLASSES[labelKey].label,
                            notes: updatedNotes,
                            updated_at: nowMs
                        })
                    });
                } catch {
                    // Tetap tersimpan di cache lokal
                }
            }

            this._rebuildAndNotify(true);
            return { ok: true, record: existing };
        }

        /** Hapus item dataset dari API, Vercel Blob, Firebase RTDB, dan cache lokal. */
        async deleteDatasetRecord(datasetId, opts = {}) {
            const cleanId = String(datasetId || '').trim();
            const existing = this.datasetMap[cleanId];
            if (!cleanId || !existing) {
                return { ok: false, error: `Data gambar ${cleanId} tidak ditemukan` };
            }

            const fetchFn = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
            const token = String(opts.token || '').trim();

            if (fetchFn) {
                try {
                    const headers = { 'Content-Type': 'application/json' };
                    if (token) {
                        headers.Authorization = 'Bearer ' + token;
                        headers['X-Capture-Token'] = token;
                    }
                    await fetchFn(`${opts.endpoint || DATASET_API_URL}?dataset_id=${encodeURIComponent(cleanId)}`, {
                        method: 'DELETE',
                        headers
                    });
                } catch {
                    // Lanjutkan penghapusan di RTDB & cache
                }
            }

            const fbBase = this._getFirebaseBaseUrl();
            if (fbBase && fetchFn) {
                try {
                    await fetchFn(`${fbBase}/kelompok5/cnn_dataset/${encodeURIComponent(cleanId)}.json`, {
                        method: 'DELETE'
                    });
                    if (existing.fnv1a) {
                        await fetchFn(`${fbBase}/kelompok5/cnn_dataset_hashes/${encodeURIComponent(existing.fnv1a)}.json`, {
                            method: 'DELETE'
                        });
                    }
                } catch {
                    // Abaikan bila offline
                }
            }

            delete this.datasetMap[cleanId];
            this.saveDatasetCache();
            this._rebuildAndNotify(true);
            return { ok: true, deletedId: cleanId };
        }

        /**
         * Siapkan pembagian dataset terstratifikasi per kelas (Training / Validation / Testing)
         * untuk pelatihan CNN berikutnya. Status model saat ini tetap BELUM_DILATIH.
         */
        buildTrainValTestSplit(ratios = { train: 0.7, val: 0.15, test: 0.15 }) {
            const train = [];
            const validation = [];
            const test = [];
            const byClassSummary = {};

            CNN_SPEC.classes.forEach(clsKey => {
                const items = this.datasetRecords()
                    .filter(r => r.label === clsKey)
                    .sort((a, b) => (a.fnv1a || a.id).localeCompare(b.fnv1a || b.id));
                const n = items.length;
                const nTrain = n > 0 ? Math.max(1, Math.round(n * (ratios.train || 0.7))) : 0;
                const rem = Math.max(0, n - nTrain);
                const nVal = rem > 1 ? Math.max(1, Math.round(n * (ratios.val || 0.15))) : 0;

                const cTrain = items.slice(0, nTrain);
                const cVal = items.slice(nTrain, nTrain + nVal);
                const cTest = items.slice(nTrain + nVal);

                const fmtRec = (r, splitName) => ({
                    dataset_id: r.id,
                    split: splitName,
                    label: r.label,
                    label_display: r.labelDisplay,
                    leaf_width_px: r.width,
                    hst_day: r.hst,
                    file_name: r.fileName,
                    file_format: r.fileFormat,
                    fnv1a: r.fnv1a,
                    image_url: r.image,
                    mask_url: r.mask,
                    overlay_url: r.overlay,
                    created_at: r.created_at
                });

                cTrain.forEach(r => train.push(fmtRec(r, 'train')));
                cVal.forEach(r => validation.push(fmtRec(r, 'validation')));
                cTest.forEach(r => test.push(fmtRec(r, 'test')));

                byClassSummary[clsKey] = {
                    total: n,
                    train: cTrain.length,
                    validation: cVal.length,
                    test: cTest.length
                };
            });

            const modelSt = this.getModelStatus();
            return {
                schema_version: 'selada-cnn-dataset-v2',
                training_target: 'google_colab',
                model_id: CNN_SPEC.modelId,
                model_status: modelSt.status,
                generated_at: new Date().toISOString(),
                supporting_feature: CNN_SPEC.supportingMeasurement,
                classes: CNN_SPEC.classes.slice(),
                colab_export_contract: {
                    models_dir: CNN_SPEC.modelsDir,
                    default_model_file: CNN_SPEC.defaultModelFile,
                    required_files: ['model_selada_v2.h5 (atau model.keras / model.tflite)', 'class_names.json', 'metadata.json', 'evaluation.json'],
                    ui_classes: CNN_SPEC.uiClasses.slice(),
                    active_inference_classes: CNN_SPEC.activeClasses.slice(),
                    unavailable_ui_classes: { bukan_selada: CNN_SPEC.unavailableBadge },
                    class_names_template: CNN_SPEC.activeClasses.slice(),
                    metadata_template: {
                        model_id: CNN_SPEC.modelId,
                        model_file: CNN_SPEC.defaultModelFile,
                        model_version: 'v2.0.0-colab',
                        architecture: 'MobileNetV2',
                        format: 'h5',
                        training_source: 'google_colab',
                        is_test_model: false,
                        input_shape: [224, 224, 3],
                        class_names: CNN_SPEC.activeClasses.slice(),
                        preprocessing: {
                            color_mode: 'RGB',
                            resize_mode: 'bilinear',
                            target_size: [224, 224],
                            normalization: 'rescale_0_1'
                        },
                        supporting_measurement: CNN_SPEC.supportingMeasurement
                    }
                },
                total: train.length + validation.length + test.length,
                counts: {
                    train: train.length,
                    validation: validation.length,
                    test: test.length
                },
                by_class: byClassSummary,
                splits: {
                    train,
                    validation,
                    test
                }
            };
        }
    }

    const store = new GrowthStore();
    store.CLASSES = CLASSES;
    store.CNN_SPEC = CNN_SPEC;
    store.safeUrl = safeUrl;
    store.computeFnv1aHex = computeFnv1aHex;
    store.detectImageFormat = detectImageFormat;
    store.validateModelBundle = validateModelBundle;
    store.preprocessImagePixels = preprocessImagePixels;
    window.GrowthStore = store;
})(window);
