'use strict';
/**
 * Carga histórica de las series mensuales en IndicesMensuales (backlog la-ads ítem 7, D3 etapa 2):
 * inflación mensual (BCRA 27), RIPTE, IPC nivel, SMVM y haber mínimo (datos.gob.ar).
 * Si datos.gob.ar no responde, esas series quedan con error y se pueden reintentar con --serie.
 *
 * Uso:
 *   node scripts/backfillIndicesMensuales.js --dry-run
 *   node scripts/backfillIndicesMensuales.js
 *   node scripts/backfillIndicesMensuales.js --serie=ripte
 */

require('dotenv').config();
const database = require('../server/utils/database');
const { SERIES_MENSUALES, actualizarSerieMensual } = require('../server/services/scrapers/tasas/indicesMensualesService');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SOLO = (args.find((a) => a.startsWith('--serie=')) || '').split('=')[1];

(async () => {
	console.log(`\n=== Carga histórica de series mensuales (${DRY_RUN ? 'DRY-RUN' : 'WRITE'}) ===`);
	await database.connect();
	for (const [serie, cfg] of Object.entries(SERIES_MENSUALES)) {
		if (SOLO && SOLO !== serie) continue;
		const r = await actualizarSerieMensual(serie, { desde: cfg.desde, dryRun: DRY_RUN });
		console.log(`${serie}: ${r.status} — ${r.message}${r.data ? ` (${r.data.primero} → ${r.data.ultimo})` : ''}`);
	}
	await database.disconnect();
})().catch((e) => {
	console.error('Error fatal:', e);
	process.exit(1);
});
