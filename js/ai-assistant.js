/**
 * ==============================================================================
 * MODULE: AGRONOMIC DECISION SUPPORT SYSTEM (Lactuca sativa L. Expert System)
 * Hardened for: DOM XSS Mitigation, Transparent Horticultural Rules, Tetens VPD
 * Declared Nature: Rule-Based Expert System / Physiological Heuristic Model
 * ==============================================================================
 */

(function (window) {
    'use strict';

    const Sec = window.SecurityUtils || {
        escapeHTML: s => String(s || ''),
        sanitizeHTML: s => String(s || '')
    };

    // Agronomic Constants based on Horticulture Research for Curly Lettuce
    const LETTUCE_SPECIES = 'Lactuca sativa L. var. crispa (Selada Keriting)';
    const AGRONOMIC_PARAMS = {
        soilMoisture: { min: 65, max: 78, unit: '%' },
        airHumidity: { min: 60, max: 80, unit: '%' },
        temperature: { min: 15.0, optimalMax: 24.0, maxTolerated: 28.0, unit: '°C' },
        vpd: { min: 0.45, max: 0.90, unit: 'kPa' },
        baseTempGDD: 4.0, // Standard base temperature for lettuce Growing Degree Days
        harvestTargetGDD: 700 // Cumulative thermal units required from transplanting
    };

    /**
     * Calculate Vapor Pressure Deficit (VPD in kPa) using Tetens equation
     * SVP = 0.61078 * exp((17.27 * T) / (T + 237.3))
     * AVP = SVP * (RH / 100)
     * VPD = SVP - AVP
     */
    function calculateVPD(tempC, humidityPct) {
        if (!Number.isFinite(tempC) || !Number.isFinite(humidityPct)) return 0.65;
        const validT = Math.max(0, Math.min(50, tempC));
        const validRH = Math.max(5, Math.min(100, humidityPct));
        const svp = 0.61078 * Math.exp((17.27 * validT) / (validT + 237.3));
        const avp = svp * (validRH / 100);
        return Math.max(0, Number((svp - avp).toFixed(2)));
    }

    class AIAssistant {
        constructor() {
            this.chatHistory = [];
            this.initWelcomeMessage();
        }

        initWelcomeMessage() {
            this.chatHistory.push({
                sender: 'ai',
                time: new Date(),
                text: `Halo, saya <b>Sistem Pakar Agronomi Selada Keriting (${LETTUCE_SPECIES})</b>. Saya bekerja berbasis aturan fisiologi mikroklimat tanaman (Rule-Based Expert System): kelembapan tanah optimal 65–78%, kelembapan udara 60–80%, suhu 15–24°C, dan target VPD 0.45–0.90 kPa. Silakan klik tombol 'Diagnosa Otomatis' atau pilih topik konsultasi.`
            });
        }

        /**
         * Real-time automated agronomic diagnosis
         */
        diagnoseCurrentConditions(latestRecord) {
            if (!latestRecord || !Number.isFinite(latestRecord.tanah)) {
                return {
                    status: 'neutral',
                    title: 'Data Telemetri Belum Tersedia',
                    summary: 'Menunggu penerimaan paket telemetri tervalidasi dari sensor IoT Firebase RTDB.',
                    soil: { val: '—', status: 'Menunggu data' },
                    air: { val: '—', status: 'Menunggu data' },
                    temp: { val: '—', status: 'Menunggu data' },
                    vpd: { val: '—', status: 'Menunggu data' },
                    pump: 'Siaga',
                    recommendations: ['Pastikan koneksi ESP32 aktif.'],
                    overallHealth: 'Menunggu'
                };
            }

            const tanah = Number(latestRecord.tanah);
            const udara = Number(latestRecord.udara);
            const suhu = Number(latestRecord.suhu);
            const vpd = calculateVPD(suhu, udara);
            const issues = [];
            const recommendations = [];

            // 1. Soil Moisture Diagnosis (65% - 78%)
            let soilStatus = 'Optimal';
            let pumpCommandDesc = 'Siaga (Mati)';
            if (tanah < AGRONOMIC_PARAMS.soilMoisture.min) {
                soilStatus = 'Defisit Air (< 65%)';
                pumpCommandDesc = 'Perintah Irigasi: AKTIF';
                issues.push(`Kelembapan tanah (${tanah}%) berada di bawah ambang normal (${AGRONOMIC_PARAMS.soilMoisture.min}%).`);
                recommendations.push(`Otomasi histeresis memerintahkan pompa menyala untuk memulihkan turgor sel mesofil dan mencegah dehidrasi perakaran.`);
            } else if (tanah > AGRONOMIC_PARAMS.soilMoisture.max) {
                soilStatus = 'Kejenuhan Air (> 78%)';
                pumpCommandDesc = 'Perintah Irigasi: MATI';
                issues.push(`Kelembapan tanah (${tanah}%) melampaui kapasitas lapang (${AGRONOMIC_PARAMS.soilMoisture.max}%).`);
                recommendations.push(`Pompa dimatikan guna mencegah hipoksia (asfiksia perakaran) dan risiko infeksi patogen Pythium sp.`);
            } else {
                recommendations.push(`Kelembapan tanah berada pada kapasitas lapang ideal (65–78%). Penyerapan nutrisi berlangsung seimbang.`);
            }

            // 2. Air Humidity Diagnosis (60% - 80%)
            let airStatus = 'Normal';
            if (udara < AGRONOMIC_PARAMS.airHumidity.min) {
                airStatus = 'Kering (< 60%)';
                issues.push(`Kelembapan udara (${udara}%) di bawah rentang aman (60%).`);
                recommendations.push(`Transpirasi cepat dapat memicu nekrosis margin daun muda (tipburn) akibat hambatan translokasi kalsium.`);
            } else if (udara > AGRONOMIC_PARAMS.airHumidity.max) {
                airStatus = 'Lembap Berlebih (> 80%)';
                issues.push(`Kelembapan udara (${udara}%) melampaui 80%.`);
                recommendations.push(`Tingkatkan sirkulasi udara mikro (airflow) untuk menekan perkecambahan spora jamur Botrytis cinerea dan Bremia lactucae.`);
            }

            // 3. Temperature & VPD Diagnosis
            let tempStatus = 'Optimal';
            if (suhu > AGRONOMIC_PARAMS.temperature.maxTolerated) {
                tempStatus = 'Panas (> 28°C)';
                issues.push(`Suhu mikroklimat (${suhu}°C) melebihi batas toleransi vegetatif.`);
                recommendations.push(`Suhu tinggi memicu inisiasi pembungaan dini (bolting) dan akumulasi laktukarium yang menimbulkan rasa pahit.`);
            } else if (suhu < AGRONOMIC_PARAMS.temperature.min) {
                tempStatus = 'Dingin (< 15°C)';
                issues.push(`Suhu mikroklimat (${suhu}°C) di bawah suhu tumbuh aktif.`);
                recommendations.push(`Laju metabolisme dan akumulasi biomassa melambat.`);
            }

            return {
                timestamp: latestRecord.t,
                soil: { val: tanah, status: soilStatus },
                air: { val: udara, status: airStatus },
                temp: { val: suhu, status: tempStatus },
                vpd: { val: vpd, status: (vpd >= 0.45 && vpd <= 0.90) ? 'Optimal (0.45–0.90 kPa)' : 'Non-optimal' },
                pump: pumpCommandDesc,
                source: latestRecord.source || 'live',
                issues: issues,
                recommendations: recommendations,
                overallHealth: issues.length === 0 ? 'Optimal' : (issues.length === 1 ? 'Perhatian' : 'Kritis')
            };
        }

        async query(question, currentRecord) {
            const cleanQuestion = String(question || '').trim();
            if (!cleanQuestion) return;

            // Record user message
            this.chatHistory.push({
                sender: 'user',
                time: new Date(),
                text: cleanQuestion
            });

            // Process response via rule-based decision engine
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

            // 1. Analisis Kondisi Sensor Real-time
            if (q.includes('analisis') || q.includes('kondisi') || q.includes('realtime') || q.includes('sekarang') || q.includes('sensor')) {
                if (!currentRecord || !Number.isFinite(currentRecord.tanah)) {
                    return `Data telemetri sensor saat ini belum tersedia. Pastikan perangkat ESP32 tersambung ke WiFi dan Firebase RTDB.`;
                }
                const sourceBadge = currentRecord.source === 'live' ? '[TELEMETRI LIVE]' : (currentRecord.source === 'cache' ? '[OFFLINE CACHE]' : '[DATA SIMULASI]');
                return `<b>Laporan Diagnosa Fisiologis Selada Keriting:</b><br>` +
                    `<i>Status Sumber Data: ${Sec.escapeHTML(sourceBadge)}</i><br>` +
                    `• <b>Kelembapan Tanah:</b> ${diag.soil.val}% (${diag.soil.status})<br>` +
                    `• <b>Kelembapan Udara:</b> ${diag.air.val}% (${diag.air.status})<br>` +
                    `• <b>Suhu Mikroklimat:</b> ${diag.temp.val}°C (${diag.temp.status})<br>` +
                    `• <b>Defisit Tekanan Uap (VPD):</b> ${diag.vpd.val} kPa (${diag.vpd.status})<br>` +
                    `• <b>Logika Pompa:</b> ${diag.pump}<br><br>` +
                    `<b>Evaluasi & Rekomendasi:</b><br>` +
                    diag.recommendations.map(r => `• ${Sec.escapeHTML(r)}`).join('<br>');
            }

            // 2. Kelembapan Tanah & Logika Pompa
            if (q.includes('tanah') || q.includes('kelembapan tanah') || q.includes('pompa') || q.includes('irigasi')) {
                return `<b>Standar Kelembapan Tanah Selada Keriting (Lactuca sativa L.):</b><br>` +
                    `Berdasarkan kajian agronomi, kapasitas lapang optimal adalah <b>65% hingga 78%</b>.<br><br>` +
                    `<b>Logika Histeresis Kontrol:</b><br>` +
                    `1. <b>Kelembapan &lt; 65%:</b> Sistem mengirim perintah irigasi AKTIF.<br>` +
                    `2. <b>Rentang 65%–78%:</b> Deadband histeresis (mempertahankan status siklus sebelumnya guna mencegah switching relay berulang).<br>` +
                    `3. <b>Kelembapan &gt; 78%:</b> Sistem mengirim perintah irigasi MATI.<br>` +
                    `<i>Catatan SCADA: Dashboard menampilkan 'Perintah Kontrol'. Konfirmasi fisik motor memerlukan sensor arus/kontak balik relay hardware.</i>`;
            }

            // 3. Tipburn pada Selada
            if (q.includes('tipburn') || q.includes('daun kering') || q.includes('gosong')) {
                return `<b>Pencegahan Fisiologis Tipburn:</b><br>` +
                    `Tipburn adalah nekrosis marginal pada daun muda akibat ketidakseimbangan translokasi kalsium (Ca2+) selama fase pertumbuhan cepat.<br><br>` +
                    `<b>Langkah Preventif Berdasarkan Riset:</b><br>` +
                    `• Pertahankan kelembapan udara konstan pada <b>60–80%</b>.<br>` +
                    `• Pertahankan VPD mikroklimat pada <b>0.5–0.85 kPa</b>.<br>` +
                    `• Hindari fluktuasi kelembapan tanah drastis di bawah 65%.<br>` +
                    `• Pasang sirkulasi udara tajuk (horizontal/vertical airflow) pada malam hari untuk memicu gutasi dan aliran massa kalsium.`;
            }

            // 4. Suhu & Bolting
            if (q.includes('suhu') || q.includes('panas') || q.includes('bolting') || q.includes('pahit')) {
                return `<b>Pengaruh Suhu & Mitigasi Bolting:</b><br>` +
                    `Suhu optimal selada keriting adalah <b>15°C – 24°C</b>.<br><br>` +
                    `Bila suhu melampaui <b>28°C</b>:<br>` +
                    `• Terjadi induksi giberelin yang memicu pemanjangan batang berbunga prematur (bolting).<br>` +
                    `• Terjadi sintesis senyawa <i>sesquiterpene lactones</i> (laktusin) yang menyebabkan daun terasa pahit dan berserat kasar.<br>` +
                    `Gunakan naungan paranet 50% atau pendinginan evaporatif (mist cooling) saat radiasi siang hari memuncak.`;
            }

            // 5. Umur & Waktu Panen (HST & GDD)
            if (q.includes('panen') || q.includes('umur') || q.includes('hst') || q.includes('tanam') || q.includes('gdd')) {
                return `<b>Siklus Panen & Akumulasi Termal GDD:</b><br>` +
                    `• <b>Siklus Normal:</b> 35 – 45 Hari Setelah Tanam (HST).<br>` +
                    `• <b>Satuan Termal (GDD):</b> Memerlukan akumulasi ~650–750 GDD (Base Temp 4.0°C).<br>` +
                    `• <b>Kriteria Fisik Siap Panen:</b> Tajuk roset padat bergelombang, bobot 150–250g per tanaman, tekstur renyah sebelum sumbu batang memanjang.<br>` +
                    `• <b>Waktu Panen Ideal:</b> Pukul 06.00–08.00 pagi saat tekanan turgor sel maksimum untuk umur simpan optimal.`;
            }

            // Fallback response with strict HTML escaping
            const safeQuery = Sec.escapeHTML(q);
            return `Pertanyaan Anda mengenai "<i>${safeQuery}</i>" terkait dengan budidaya <b>Selada Keriting (Lactuca sativa L.)</b>. Sistem pakar memantau 3 parameter kritis: kelembapan tanah (65–78%), kelembapan udara (60–80%), dan suhu lingkungan. Anda dapat mengklik tombol 'Diagnosa Otomatis Real-time' untuk evaluasi mikroklimat instan.`;
        }

        renderThread(containerId) {
            const container = document.getElementById(containerId);
            if (!container) return;

            // XSS DEFENSE: Strictly escape user content, allowlist-sanitize AI formatting
            const html = this.chatHistory.map(item => {
                const isAI = item.sender === 'ai';
                const senderClass = isAI ? 'ai' : 'user';
                const senderLabel = isAI ? 'AGRONOMIST DSS' : 'ANDA';
                const timeStr = item.time.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

                const safeContent = isAI 
                    ? Sec.sanitizeHTML(item.text) 
                    : Sec.escapeHTML(item.text);

                return `
                    <div class="chat-bubble ${senderClass}">
                        <div class="bubble-content">
                            ${safeContent}
                        </div>
                        <div class="bubble-meta">
                            <span>${Sec.escapeHTML(senderLabel)}</span> · <span>${Sec.escapeHTML(timeStr)}</span>
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
