/**
 * AI Assistant: sistem pakar berbasis aturan untuk selada keriting (Lactuca sativa L. var. crispa).
 * Membaca data REAL (sensor + lebar daun). Prediksi hanya dirujuk dari hasil LSTM yang sudah dihitung.
 */
(function (window) {
    'use strict';

    const Sec = window.SecurityUtils;
    const P = {
        soil: { min: 65, max: 78 },
        air: { min: 60, max: 80 },
        temp: { min: 15, max: 24, tolerated: 28 }
    };

    const esc = s => Sec.escapeHTML(s);

    class AIAssistant {
        constructor() {
            this.history = [{
                sender: 'ai',
                time: new Date(),
                text: 'Halo, saya asisten agronomi <b>Selada Keriting</b>. Saya membaca data sensor dan lebar daun yang tercatat, lalu menjawab berdasarkan aturan budidaya. Pilih topik di bawah atau ketik pertanyaan.'
            }];
        }

        diagnose(sensor) {
            if (!sensor || !Number.isFinite(sensor.tanah)) return null;
            const issues = [];
            const tips = [];
            if (sensor.tanah < P.soil.min) {
                issues.push(`Tanah kering (${sensor.tanah}%, batas ${P.soil.min}%).`);
                tips.push('Irigasi perlu menyala agar turgor sel dan perakaran terjaga.');
            } else if (sensor.tanah > P.soil.max) {
                issues.push(`Tanah terlalu basah (${sensor.tanah}%, batas ${P.soil.max}%).`);
                tips.push('Hentikan irigasi untuk mencegah akar kekurangan oksigen dan penyakit Pythium.');
            }
            if (sensor.udara < P.air.min) {
                issues.push(`Udara kering (${sensor.udara}%, batas ${P.air.min}%).`);
                tips.push('Udara kering memicu tipburn pada daun muda.');
            } else if (sensor.udara > P.air.max) {
                issues.push(`Udara terlalu lembap (${sensor.udara}%, batas ${P.air.max}%).`);
                tips.push('Tingkatkan sirkulasi udara untuk menekan jamur Botrytis dan Bremia.');
            }
            if (sensor.suhu > P.temp.tolerated) {
                issues.push(`Suhu terlalu tinggi (${sensor.suhu}°C, toleransi ${P.temp.tolerated}°C).`);
                tips.push('Suhu tinggi memicu bolting dan rasa pahit. Beri naungan.');
            } else if (sensor.suhu > P.temp.max) {
                issues.push(`Suhu hangat di atas rentang ideal (${sensor.suhu}°C, ideal ${P.temp.min}–${P.temp.max}°C).`);
                tips.push('Tingkatkan ventilasi atau pasang paranet agar suhu tidak melewati batas toleransi 28°C.');
            } else if (sensor.suhu < P.temp.min) {
                issues.push(`Suhu rendah (${sensor.suhu}°C, minimal ${P.temp.min}°C).`);
                tips.push('Pertumbuhan melambat pada suhu rendah.');
            }
            return { issues: issues, tips: tips };
        }

        async query(question, ctx) {
            const text = String(question || '').trim();
            if (!text) return null;
            this.history.push({ sender: 'user', time: new Date(), text: text });
            const reply = this.answer(text, ctx || {});
            this.history.push({ sender: 'ai', time: new Date(), text: reply });
            return reply;
        }

        answer(rawQuestion, ctx) {
            const q = String(rawQuestion || '').toLowerCase();
            const has = (...w) => w.some(x => q.includes(x));
            const sensor = ctx.sensor;
            const leaf = ctx.leaf;
            const GS = window.GrowthStore;
            const classes = GS.CLASSES;

            // 1. Prediksi LSTM 4 hari ke depan
            if (has('prediksi', 'lstm', 'ramal', 'besok', '4 hari')) {
                const f = ctx.forecast;
                if (!f || !f.ok) {
                    return 'Prediksi LSTM belum tersedia. Model butuh minimal 8 hari data lebar daun valid dari kamera. Buka menu <b>Prediksi LSTM</b> untuk melihat progresnya.';
                }
                const lines = f.forecast.map((d, i) => {
                    const stage = d.stage === null ? '' : ' · ' + esc(this.stageLabel(d.stage));
                    return `• Hari +${i + 1}: <b>${d.width.toFixed(1)} px</b>${stage}`;
                });
                return '<b>Prediksi lebar daun 4 hari ke depan (LSTM):</b><br>' + lines.join('<br>') +
                    '<br><i>Ini perkiraan model, bukan pengukuran observasi nyata.</i>';
            }

            // 2. Klasifikasi CNN 4 kelas & status model
            if (has('cnn', 'kelas', 'klasifikasi', 'bukan selada', 'model', 'colab')) {
                const c = GS.classCounts();
                const m = typeof GS.getModelStatus === 'function' ? GS.getModelStatus() : { available: false, status: 'BELUM ADA MODEL' };
                const ws = typeof GS.widthStats === 'function' ? GS.widthStats() : null;
                const modelLine = m.available
                    ? `${esc(m.status)} (${esc(m.model_version || m.binary_file || 'model_selada_v2.h5')} · ${esc(m.architecture || 'CNN')})`
                    : esc(m.status || 'BELUM ADA MODEL');
                return `<b>Klasifikasi CNN (Status Model: ${modelLine})</b><br>` +
                    'Sistem mempertahankan 4 kelas antarmuka sesuai spesifikasi dosen, dengan integrasi inference <code>model_selada_v2.h5</code> (3 kelas aktif):<br>' +
                    `• Siap Panen (Aktif): ${c.siap_panen}<br>• Mendekati Panen (Aktif): ${c.mendekati_panen}<br>` +
                    `• Masa Pertumbuhan (Aktif): ${c.masa_pertumbuhan}<br>• Bukan Selada: <b>BELUM TERSEDIA</b> (elemen UI informatif tanpa probabilitas palsu)<br>` +
                    `• Belum diklasifikasi: ${c.belum}` +
                    (ws && ws.count ? `<br><br>Rata-rata lebar daun valid saat ini: <b>${ws.avg.toFixed(1)} px</b> (${ws.count} citra).` : '');
            }

            // 3. Fisiologi Tipburn (diprioritaskan sebelum kata umum 'daun'/'tanah')
            if (has('tipburn', 'gosong', 'ujung daun')) {
                return '<b>Tipburn</b> adalah ujung daun muda yang mengering akibat kalsium tidak terdistribusi. ' +
                    `Jaga kelembapan udara ${P.air.min}–${P.air.max}%, hindari tanah kering di bawah ${P.soil.min}%, dan pastikan ada aliran udara.`;
            }

            // 4. Diagnosa kondisi real-time (diprioritaskan sebelum kata umum 'tanah'/'suhu')
            if (has('kondisi', 'analisis', 'sekarang', 'diagnosa', 'real-time', 'realtime')) {
                const d = this.diagnose(sensor);
                if (!d) return 'Data sensor belum tersedia. Pastikan ESP32 menyala dan tersambung ke Wi-Fi.';
                const head = `<b>Kondisi terakhir:</b> tanah ${sensor.tanah}%, udara ${sensor.udara}%, suhu ${sensor.suhu}°C.` +
                    (leaf && leaf.width ? ` Lebar daun terakhir: <b>${leaf.width.toFixed(1)} px</b>.` : '') + '<br><br>';
                if (!d.issues.length) return head + 'Semua parameter berada di rentang optimal.';
                return head + d.issues.map(i => '• ' + esc(i)).join('<br>') + '<br><br><b>Saran:</b><br>' + d.tips.map(t => '• ' + esc(t)).join('<br>');
            }

            // 5. Suhu & risiko bolting
            if (has('suhu', 'panas', 'bolting', 'pahit')) {
                return `<b>Suhu ideal ${P.temp.min}–${P.temp.max}°C.</b> Di atas ${P.temp.tolerated}°C selada rawan bolting dan terasa pahit. ` +
                    'Gunakan paranet 50% atau pendinginan saat siang.' + (sensor ? `<br><br>Suhu terakhir: <b>${sensor.suhu}°C</b>.` : '');
            }

            // 6. Kelembapan tanah & kontrol histeresis pompa
            if (has('tanah', 'pompa', 'irigasi', 'siram')) {
                return `<b>Kelembapan tanah optimal ${P.soil.min}–${P.soil.max}%.</b><br>` +
                    `• Di bawah ${P.soil.min}%: pompa menyala.<br>• Di atas ${P.soil.max}%: pompa mati.<br>` +
                    '• Di antaranya: status pompa dipertahankan (histeresis) agar relay tidak bolak-balik.' +
                    (sensor ? `<br><br>Pembacaan terakhir: <b>${sensor.tanah}%</b>.` : '');
            }

            // 7. Panen & Lebar Daun
            if (has('panen', 'daun', 'lebar', 'umur', 'hst', 'tumbuh')) {
                let msg = '<b>Panen selada keriting:</b> siklus normal 35–45 HST. Panen terbaik pagi hari (06.00–08.00) saat turgor sel maksimum.<br>';
                if (leaf && leaf.width) {
                    const st = typeof GS.getModelStatus === 'function' ? GS.getModelStatus().status : 'BELUM ADA MODEL';
                    msg += `<br>Lebar daun terakhir tercatat <b>${leaf.width.toFixed(1)} px</b>` +
                        (leaf.cls ? ` (kelas CNN: ${esc(classes[leaf.cls].label)})` : ` (status CNN: ${esc(st)})`) + '.';
                } else {
                    msg += '<br>Belum ada citra valid yang tercatat.';
                }
                return msg;
            }

            // 8. Pertanyaan "kering" umum yang tidak menyebut tanah/daun spesifik
            if (has('kering')) {
                return '<b>Penanganan kondisi kering:</b> jaga kelembapan tanah pada rentang <b>65–78%</b> dan kelembapan udara <b>60–80%</b> untuk mencegah layu serta tipburn.';
            }

            return `Saya belum paham pertanyaan "<i>${esc(rawQuestion)}</i>". Coba tanyakan soal kondisi sensor, tanah dan pompa, suhu, panen dan lebar daun, klasifikasi CNN, atau prediksi LSTM.`;
        }

        stageLabel(ord) {
            const C = window.GrowthStore.CLASSES;
            const key = Object.keys(C).find(k => C[k].ord === ord);
            return key ? C[key].label : '—';
        }

        render(container) {
            if (!container) return;
            container.textContent = '';
            this.history.forEach(m => {
                const wrap = document.createElement('div');
                wrap.className = 'bubble ' + (m.sender === 'ai' ? 'ai' : 'user');
                const body = document.createElement('div');
                body.className = 'bubble-body';
                body.innerHTML = m.sender === 'ai' ? Sec.sanitizeHTML(m.text) : esc(m.text);
                const meta = document.createElement('div');
                meta.className = 'bubble-meta';
                meta.textContent = (m.sender === 'ai' ? 'Asisten' : 'Anda') + ' · ' +
                    m.time.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
                wrap.appendChild(body);
                wrap.appendChild(meta);
                container.appendChild(wrap);
            });
            container.scrollTop = container.scrollHeight;
        }
    }

    window.AIAssistant = new AIAssistant();
})(window);
