/**
 * Forecast: prediksi 4 hari ke depan dengan LSTM (TensorFlow.js, dilatih di browser).
 * Masukan = deret harian lebar daun REAL (+ tahap tumbuh dari kelas CNN yang valid bila semua hari punya kelas).
 * Tanpa penyuntikan data sintetis/interpolasi ke histori real.
 * Hasil prediksi hanya boleh ditampilkan di bagian Prediksi LSTM.
 */
(function (window) {
    'use strict';

    const TF_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
    const MIN_DAYS = 8;   // minimal hari pengamatan nyata
    const WINDOW = 3;     // panjang jendela sekuens LSTM (hari pengamatan)
    const HORIZON = 4;    // prediksi 4 hari ke depan
    const DAY_MS = 86400000;

    let tfPromise = null;
    function loadTF() {
        if (window.tf) return Promise.resolve(window.tf);
        if (!tfPromise) {
            tfPromise = new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = TF_URL;
                s.async = true;
                s.crossOrigin = 'anonymous';
                s.onload = () => (window.tf ? resolve(window.tf) : reject(new Error('TensorFlow.js gagal dimuat')));
                s.onerror = () => {
                    tfPromise = null;
                    reject(new Error('Tidak dapat memuat TensorFlow.js. Periksa koneksi internet.'));
                };
                document.head.appendChild(s);
            });
        }
        return tfPromise;
    }

    /**
     * Memfilter dan mengurutkan hanya hari pengamatan nyata yang valid (tanpa interpolasi/data sintetis).
     */
    function validateRealDaily(daily) {
        if (!Array.isArray(daily)) return [];
        const byTime = new Map();
        daily.forEach(d => {
            if (!d || typeof d !== 'object') return;
            if (d.interpolated === true || d.synthetic === true || d.predicted === true) return;
            const t = Number(d.t);
            const w = Number(d.width);
            if (!Number.isFinite(t) || t < 0 || !Number.isFinite(w) || w <= 0) return;
            const st = (d.stage === 0 || d.stage === 1 || d.stage === 2) ? d.stage : null;
            byTime.set(t, {
                day: d.day || new Date(t).toISOString().slice(0, 10),
                t: t,
                width: w,
                stage: st,
                n: Number(d.n) > 0 ? Number(d.n) : 1
            });
        });
        return Array.from(byTime.values()).sort((a, b) => a.t - b.t);
    }

    async function run(daily) {
        const realDays = validateRealDaily(daily);
        if (realDays.length < MIN_DAYS) {
            return { ok: false, have: realDays.length, need: MIN_DAYS, history: realDays };
        }

        const useStage = realDays.every(d => d.stage !== null);
        const maxW = Math.max.apply(null, realDays.map(d => d.width)) * 1.25 || 1;
        const seq = realDays.map(d => (useStage ? [d.width / maxW, d.stage / 2] : [d.width / maxW]));
        const F = useStage ? 2 : 1;

        const xs = [];
        const ys = [];
        for (let i = 0; i + WINDOW < seq.length; i++) {
            xs.push(seq.slice(i, i + WINDOW));
            ys.push(seq[i + WINDOW]);
        }

        const tf = await loadTF();
        const X = tf.tensor3d(xs);
        const Y = tf.tensor2d(ys);
        const model = tf.sequential();
        const lstmCfg = { units: 16, inputShape: [WINDOW, F] };
        const denseCfg = { units: F };
        if (tf.initializers && typeof tf.initializers.glorotUniform === 'function') {
            lstmCfg.kernelInitializer = tf.initializers.glorotUniform({ seed: 42 });
            denseCfg.kernelInitializer = tf.initializers.glorotUniform({ seed: 42 });
        }
        if (tf.initializers && typeof tf.initializers.orthogonal === 'function') {
            lstmCfg.recurrentInitializer = tf.initializers.orthogonal({ seed: 42 });
        }
        model.add(tf.layers.lstm(lstmCfg));
        model.add(tf.layers.dense(denseCfg));
        model.compile({ optimizer: tf.train.adam(0.01), loss: 'meanSquaredError' });

        try {
            const hist = await model.fit(X, Y, {
                epochs: 160,
                batchSize: Math.min(8, xs.length),
                shuffle: false,
                verbose: 0
            });
            const loss = hist.history.loss[hist.history.loss.length - 1];

            let win = seq.slice(-WINDOW);
            const last = realDays[realDays.length - 1];
            const forecast = [];
            for (let k = 1; k <= HORIZON; k++) {
                const input = tf.tensor3d([win]);
                const output = model.predict(input);
                const next = Array.from(output.dataSync());
                input.dispose();
                output.dispose();
                win = win.slice(1).concat([next]);
                forecast.push({
                    t: last.t + k * DAY_MS,
                    width: Math.max(0, next[0]) * maxW,
                    stage: useStage ? Math.round(Math.max(0, Math.min(2, next[1] * 2))) : null
                });
            }
            return {
                ok: true,
                history: realDays,
                forecast: forecast,
                loss: loss,
                samples: xs.length,
                useStage: useStage
            };
        } finally {
            X.dispose();
            Y.dispose();
            model.dispose();
        }
    }

    window.Forecast = {
        MIN_DAYS: MIN_DAYS,
        WINDOW: WINDOW,
        HORIZON: HORIZON,
        run: run,
        validateRealDaily: validateRealDaily
    };
})(window);
