/**
 * ==============================================================================
 * MODULE: AI AGRONOMIST ASSISTANT (Lactuca sativa L. Expert System)
 * Grounded in peer-reviewed scientific literature on crisphead/looseleaf lettuce
 * Integrates real-time telemetry diagnostics and conversational Q&A
 * ==============================================================================
 */

(function (window) {
    'use strict';

    // Agronomic Knowledge Constants based on Horticulture & Agronomy Journals
    const LETTUCE_SPECIES = 'Lactuca sativa L. var. crispa (Selada Keriting)';
    const AGRONOMIC_PARAMS = {
        soilMoisture: { min: 65, max: 78, unit: '%' },
        airHumidity: { min: 60, max: 80, unit: '%' },
        temperature: { min: 15.0, optimalMax: 24.0, maxTolerated: 28.0, unit: '°C' },
        vpd: { min: 0.45, max: 0.90, unit: 'kPa' },
        harvestCycle: { minDays: 35, maxDays: 45, unit: 'HST' }
    };

    // Calculate Vapor Pressure Deficit (VPD in kPa) using Tetens equation
    function calculateVPD(tempC, humidityPct) {
        if (!Number.isFinite(tempC) || !Number.isFinite(humidityPct)) return 0.65;
        // Saturation Vapor Pressure (kPa)
        const svp = 0.61078 * Math.exp((17.27 * tempC) / (tempC + 237.3));
        // Actual Vapor Pressure (kPa)
        const avp = svp * (Math.max(0, Math.min(100, humidityPct)) / 100);
        return Math.max(0, Number((svp - avp).toFixed(2)));
    }

    class AIAssistant {
        constructor() {
            this.chatHistory = [];
            this.edgeProxyUrl = null; // Configurable for serverless-ai-edge Cloudflare Worker
            this.initWelcomeMessage();
        }

        initWelcomeMessage() {
            this.chatHistory.push({
                sender: 'ai',
                time: new Date(),
                text: `Halo, saya Asisten Agronomi AI spesialis budidaya <b>Selada Keriting (${LETTUCE_SPECIES})</b>. Saya memonitor sensor telemetri secara real-time berdasarkan parameter ilmiah: kelembapan tanah 65–78%, kelembapan udara 60–80%, dan suhu 15–24°C. Klik tombol diagnosa atau tanyakan kondisi tanaman Anda.`
            });
        }

        /**
         * Real-time automated diagnosis of current sensor conditions
         */
        diagnoseCurrentConditions(latestRecord) {
            if (!latestRecord) {
                return {
                    status: 'neutral',
                    title: 'Data Telemetri Belum Tersedia',
                    summary: 'Menunggu penerimaan paket data dari sensor IoT Firebase RTDB.'
                };
            }

            const { tanah, udara, suhu } = latestRecord;
            const vpd = calculateVPD(suhu, udara);
            const issues = [];
            const recommendations = [];

            // 1. Analisis Kelembapan Tanah (Threshold: 65% - 78%)
            let soilStatus = 'Optimal';
            let pumpStatus = 'Mati';
            if (tanah < AGRONOMIC_PARAMS.soilMoisture.min) {
                soilStatus = 'Kritis (Defisit Air)';
                pumpStatus = 'Aktif (Irigasi Menyala)';
                issues.push(`Kelembapan tanah (${tanah}%) berada di bawah ambang batas normal (${AGRONOMIC_PARAMS.soilMoisture.min}%).`);
                recommendations.push(`Sistem otomasi mengaktifkan pompa irigasi. Pasokan air diperlukan segera untuk mencegah penurunan laju ekspansi sel mesofil dan stres osmotik.`);
            } else if (tanah > AGRONOMIC_PARAMS.soilMoisture.max) {
                soilStatus = 'Jenuh (Kelebihan Air)';
                pumpStatus = 'Mati (Proteksi Akar)';
                issues.push(`Kelembapan tanah (${tanah}%) melampaui kapasitas lapang (${AGRONOMIC_PARAMS.soilMoisture.max}%).`);
                recommendations.push(`Pompa dimatikan otomatis. Batasi penyiraman tambahan untuk menghindari asfiksia perakaran (hipoksia) dan serangan patogen tular tanah (Pythium sp.).`);
            } else {
                recommendations.push(`Kelembapan tanah berada pada kapasitas lapang optimal (65–78%). Difusi oksigen dan penyerapan hara berlangsung seimbang.`);
            }

            // 2. Analisis Kelembapan Udara (Threshold: 60% - 80%)
            let airStatus = 'Optimal';
            if (udara < AGRONOMIC_PARAMS.airHumidity.min) {
                airStatus = 'Kering';
                issues.push(`Kelembapan udara (${udara}%) di bawah batas minimum (60%).`);
                recommendations.push(`Laju transpirasi berisiko terlalu tinggi. Waspadai defisiensi translokasi kalsium lokal yang memicu fisiologis tipburn pada ujung daun muda.`);
            } else if (udara > AGRONOMIC_PARAMS.airHumidity.max) {
                airStatus = 'Lembap Berlebih';
                issues.push(`Kelembapan udara (${udara}%) melebihi 80%.`);
                recommendations.push(`Udara jenuh mengurangi evapotranspirasi alami tanaman. Tingkatkan ventilasi sirkulasi udara (airflow) guna mencegah spora jamur embun tepung (Bremia lactucae) dan busuk daun (Botrytis cinerea).`);
            }

            // 3. Analisis Suhu & VPD
            let tempStatus = 'Optimal';
            if (suhu > AGRONOMIC_PARAMS.temperature.maxTolerated) {
                tempStatus = 'Tinggi';
                issues.push(`Suhu mikroklimat (${suhu}°C) melebihi batas toleransi vegetatif (${AGRONOMIC_PARAMS.temperature.maxTolerated}°C).`);
                recommendations.push(`Suhu tinggi memicu translokasi hormon giberelin yang mengakibatkan bolting (pembungaan dini) dan akumulasi senyawa laktukarium yang menimbulkan rasa pahit.`);
            }

            return {
                timestamp: latestRecord.t,
                soil: { val: tanah, status: soilStatus },
                air: { val: udara, status: airStatus },
                temp: { val: suhu, status: tempStatus },
                vpd: { val: vpd, status: (vpd >= 0.45 && vpd <= 0.9) ? 'Ideal' : 'Non-ideal' },
                pump: pumpStatus,
                issues: issues,
                recommendations: recommendations,
                overallHealth: issues.length === 0 ? 'Optimal' : (issues.length === 1 ? 'Perhatian' : 'Kritis')
            };
        }

        /**
         * Handle conversational consultation query
         */
        async query(question, currentRecord) {
            const cleanQuestion = String(question || '').trim();
            if (!cleanQuestion) return;

            // Record user message
            this.chatHistory.push({
                sender: 'user',
                time: new Date(),
                text: cleanQuestion
            });

            // Perform agronomic analysis
            const reply = this.processKnowledgeBase(cleanQuestion.toLowerCase(), currentRecord);

            this.chatHistory.push({
                sender: 'ai',
                time: new Date(),
                text: reply
            });

            return reply;
        }

        processKnowledgeBase(q, currentRecord) {
            const diag = this.diagnoseCurrentConditions(currentRecord);

            // 1. Pertanyaan seputar Analisis Kondisi / Sensor Real-Time
            if (q.includes('analisis') || q.includes('kondisi') || q.includes('realtime') || q.includes('sekarang') || q.includes('sensor')) {
                if (!currentRecord) {
                    return `Data telemetri sensor saat ini belum masuk ke sistem. Mohon pastikan perangkat IoT ESP32 terhubung ke jaringan internet dan Firebase RTDB.`;
                }
                return `<b>Laporan Diagnosa Real-time Selada Keriting:</b><br>` +
                    `• <b>Kelembapan Tanah:</b> ${diag.soil.val}% (${diag.soil.status})<br>` +
                    `• <b>Kelembapan Udara:</b> ${diag.air.val}% (${diag.air.status})<br>` +
                    `• <b>Suhu Udara:</b> ${diag.temp.val}°C (${diag.temp.status})<br>` +
                    `• <b>Vapor Pressure Deficit (VPD):</b> ${diag.vpd.val} kPa (${diag.vpd.status})<br>` +
                    `• <b>Status Pompa:</b> ${diag.pump}<br><br>` +
                    `<b>Rekomendasi Agronomi:</b><br>` +
                    diag.recommendations.map(r => `• ${r}`).join('<br>');
            }

            // 2. Pertanyaan Kelembapan Tanah & Logika Pompa
            if (q.includes('tanah') || q.includes('kelembapan tanah') || q.includes('pompa') || q.includes('irigasi')) {
                return `<b>Standar Kelembapan Tanah Selada Keriting:</b><br>` +
                    `Berdasarkan literatur fisiologi tanaman, batas optimal kelembapan tanah untuk <i>Lactuca sativa L.</i> adalah <b>65% hingga 78%</b>.<br><br>` +
                    `<b>Logika Otomasi Sistem:</b><br>` +
                    `1. <b>Kelembapan < 65%:</b> Tanah terdeteksi kering. Pompa air menyala secara otomatis untuk mengembalikan kelembapan lapang.<br>` +
                    `2. <b>Kelembapan > 78%:</b> Tanah mencapai batas jenuh. Pompa mati secara otomatis guna mencegah pembusukan akar dan hipoksia media tanam.<br>` +
                    `Nilai sensor saat ini: <b>${currentRecord ? currentRecord.tanah + '%' : 'N/A'}</b> (${diag.pump}).`;
            }

            // 3. Tipburn pada Selada
            if (q.includes('tipburn') || q.includes('daun kering') || q.includes('gosong')) {
                return `<b>Pencegahan Fisiologis Tipburn (Ujung Daun Terbakar):</b><br>` +
                    `Tipburn pada selada keriting merupakan nekrosis marginal akibat defisiensi translokasi kalsium (Ca) pada jaringan daun muda yang tumbuh cepat.<br><br>` +
                    `<b>Langkah Preventif:</b><br>` +
                    `1. Jaga kelembapan udara konstan pada rentang <b>60–80%</b> agar transpirasi laminar tidak terhambat.<br>` +
                    `2. Pertahankan target VPD mikroklimat pada <b>0.5–0.85 kPa</b>.<br>` +
                    `3. Hindari fluktuasi kelembapan tanah yang ekstrem di bawah 65%.<br>` +
                    `4. Gunakan sirkulasi udara vertikal di tajuk tanaman saat malam hari.`;
            }

            // 4. Suhu & Bolting
            if (q.includes('suhu') || q.includes('panas') || q.includes('bolting') || q.includes('pahit')) {
                return `<b>Pengaruh Suhu terhadap Kualitas Selada Keriting:</b><br>` +
                    `Suhu ideal untuk pertumbuhan vegetatif selada adalah <b>15°C – 24°C</b>.<br><br>` +
                    `Jika suhu melampaui <b>28°C</b> secara berkepanjangan:<br>` +
                    `• Terjadi <i>bolting</i> (pemanjangan batang berbunga prematur), menghentikan pembentukan roset daun.<br>` +
                    `• Terjadi sintesis senyawa <i>sesquiterpene lactones</i> (laktusin) yang membuat daun selada terasa sangat pahit dan teksturnya alot.<br>` +
                    `Suhu saat ini terukur <b>${currentRecord ? currentRecord.suhu + '°C' : 'N/A'}</b>.`;
            }

            // 5. Umur & Waktu Panen (HST)
            if (q.includes('panen') || q.includes('umur') || q.includes('hst') || q.includes('tanam')) {
                return `<b>Panduan Siklus Panen Selada Keriting (Lactuca sativa L.):</b><br>` +
                    `• <b>Siklus Tanam:</b> 35 – 45 Hari Setelah Tanam (HST).<br>` +
                    `• <b>Ciri Siap Panen:</b> Daun bergelombang lebat, tajuk roset kompak, bobot rata-rata 150–250 gram per tanaman, daun masih renyah sebelum batang meninggi.<br>` +
                    `• <b>Waktu Panen Terbaik:</b> Pagi hari sebelum pukul 08.00 saat turgor sel berada pada titik tertinggi agar kesegaran daun pascapanen bertahan lebih lama.`;
            }

            // Fallback general response
            return `Pertanyaan Anda mengenai "<i>${this.escapeHTML(q)}</i>" relevan dengan budidaya <b>Selada Keriting (Lactuca sativa L.)</b>. Sistem telemetri memantau 3 parameter kritis: kelembapan tanah (65–78%), kelembapan udara (60–80%), dan suhu lingkungan. Anda dapat mengklik tombol 'Diagnosa Otomatis' untuk analisis mikroklimat instan.`;
        }

        escapeHTML(str) {
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        renderThread(containerId) {
            const container = document.getElementById(containerId);
            if (!container) return;

            const html = this.chatHistory.map(item => {
                const isAI = item.sender === 'ai';
                const senderClass = isAI ? 'ai' : 'user';
                const senderLabel = isAI ? 'AGRONOMIST AI' : 'ANDA';
                const timeStr = item.time.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

                return `
                    <div class="chat-bubble ${senderClass}">
                        <div class="bubble-content">
                            ${item.text}
                        </div>
                        <div class="bubble-meta">
                            <span>${senderLabel}</span> · <span>${timeStr}</span>
                        </div>
                    </div>
                `;
            }).join('');

            container.innerHTML = html;
            container.scrollTop = container.scrollHeight;
        }
    }

    window.AIAssistant = new AIAssistant();

})(window);
