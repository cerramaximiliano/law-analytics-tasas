/**
 * Carga histórica de las 3 tasas Banco Provincia desde CPACF.
 *
 * Para cada tasa, extrae datos desde la fecha más antigua disponible en CPACF
 * hasta hoy, procesando en chunks de 1 año para evitar errores 500.
 * Guarda cada día en Tasas e inicializa TasasConfig.
 *
 * Uso:
 *   node scripts/loadBPHistorico.js
 *   node scripts/loadBPHistorico.js --tasa=tasaPasivaBP
 *   node scripts/loadBPHistorico.js --tasa=tasaPasivaBP --desde=01/01/2020
 *   node scripts/loadBPHistorico.js --dry-run   (solo muestra chunks, no scrapea)
 */

'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const moment = require('moment');

const TASAS_BP = [
	{
		tipoTasa:    'tasaPasivaBP',
		rateId:      '4',
		label:       'Tasa Pasiva Banco Provincia',
		minDateFrom: '1991-04-01',
	},
	{
		tipoTasa:    'tasaActivaBPDolares',
		rateId:      '14',
		label:       'Tasa Activa Banco Provincia en Dólares',
		minDateFrom: '1992-10-13',
	},
	{
		tipoTasa:    'tasaPasivaBPDolares',
		rateId:      '15',
		label:       'Tasa Pasiva Banco Provincia en Dólares',
		minDateFrom: '1992-11-02',
	},
];

const CHUNK_MESES = 12; // tamaño del chunk: 1 año
const PAUSA_MS    = 5000; // pausa entre chunks
const PAUSA_TASA_MS = 8000; // pausa entre tasas

// ─── Parsear argumentos ───────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN  = args.includes('--dry-run');
const tasaArg  = args.find(a => a.startsWith('--tasa='));
const desdeArg = args.find(a => a.startsWith('--desde='));

const SOLO_TASA  = tasaArg  ? tasaArg.split('=')[1]  : null;
const DESDE_OVERRIDE = desdeArg ? desdeArg.split('=')[1] : null; // formato DD/MM/YYYY

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildChunks(fechaInicioStr, fechaFinStr) {
	// fechaInicioStr y fechaFinStr en formato YYYY-MM-DD
	const chunks = [];
	let cursor = moment.utc(fechaInicioStr, 'YYYY-MM-DD').startOf('day');
	const fin  = moment.utc(fechaFinStr,   'YYYY-MM-DD').startOf('day');

	while (cursor.isBefore(fin) || cursor.isSame(fin)) {
		const chunkFin = cursor.clone().add(CHUNK_MESES, 'months').subtract(1, 'days');
		const chunkFinReal = chunkFin.isAfter(fin) ? fin.clone() : chunkFin;

		chunks.push({
			desde: cursor.format('DD/MM/YYYY'),
			hasta: chunkFinReal.format('DD/MM/YYYY'),
		});

		cursor = chunkFinReal.clone().add(1, 'days');
	}
	return chunks;
}

// ─── Carga por tasa ───────────────────────────────────────────────────────────

async function cargarTasa({ tipoTasa, rateId, label, minDateFrom }) {
	// Importar aquí para que mongoose ya esté conectado
	const { main } = require('../server/services/scrapers/tasas/colegioService');
	const TasasConfig = require('../server/models/tasasConfig');

	console.log(`\n${'─'.repeat(60)}`);
	console.log(`[${tipoTasa}] ${label}`);
	console.log(`${'─'.repeat(60)}`);

	// Determinar fecha de inicio
	let fechaInicioStr = minDateFrom; // YYYY-MM-DD

	if (DESDE_OVERRIDE) {
		// El override se pasa en DD/MM/YYYY
		const m = moment.utc(DESDE_OVERRIDE, 'DD/MM/YYYY');
		if (!m.isValid()) {
			console.error(`  ❌ Fecha --desde inválida: ${DESDE_OVERRIDE} (usar DD/MM/YYYY)`);
			return;
		}
		fechaInicioStr = m.format('YYYY-MM-DD');
		console.log(`  Usando fecha de inicio override: ${fechaInicioStr}`);
	} else {
		// Verificar si ya hay datos en TasasConfig para esta tasa
		const config = await TasasConfig.findOne({ tipoTasa });
		if (config && config.fechaUltima) {
			// Continuar desde el día siguiente al último registrado
			const siguienteDia = moment.utc(config.fechaUltima).add(1, 'days').format('YYYY-MM-DD');
			const hoy = moment.utc().format('YYYY-MM-DD');
			if (siguienteDia > hoy) {
				console.log(`  ✅ Ya está al día (fechaUltima: ${moment.utc(config.fechaUltima).format('YYYY-MM-DD')}). Sin nada que cargar.`);
				return;
			}
			fechaInicioStr = siguienteDia;
			console.log(`  Continuando desde ${fechaInicioStr} (último dato: ${moment.utc(config.fechaUltima).format('YYYY-MM-DD')})`);
		} else {
			console.log(`  Sin datos previos. Cargando desde ${fechaInicioStr}`);
		}
	}

	const fechaFinStr = moment.utc().format('YYYY-MM-DD');
	const chunks = buildChunks(fechaInicioStr, fechaFinStr);

	console.log(`  Rango: ${fechaInicioStr} → ${fechaFinStr}`);
	console.log(`  Chunks de ${CHUNK_MESES} meses: ${chunks.length} total\n`);

	if (DRY_RUN) {
		chunks.forEach((c, i) => console.log(`  [chunk ${i + 1}/${chunks.length}] ${c.desde} → ${c.hasta}`));
		return;
	}

	let procesados = 0;
	let errores    = 0;

	for (let i = 0; i < chunks.length; i++) {
		const { desde, hasta } = chunks[i];
		console.log(`  [chunk ${i + 1}/${chunks.length}] ${desde} → ${hasta} ...`);

		try {
			await main({
				dni:        process.env.DU_01,
				tomo:       process.env.TREG_01,
				folio:      process.env.FREG_01,
				tasaId:     rateId,
				fechaDesde: desde,
				fechaHasta: hasta,
				capital:    100000,
				screenshot: false,
				tipoTasa,
			});
			procesados++;
			console.log(`    ✅ Chunk ${i + 1} guardado`);
		} catch (err) {
			errores++;
			console.error(`    ❌ Error en chunk ${i + 1}: ${err.message}`);
			// Continuar con el siguiente chunk — no abortar todo por un error puntual
		}

		if (i < chunks.length - 1) {
			await new Promise(r => setTimeout(r, PAUSA_MS));
		}
	}

	console.log(`\n  Resumen [${tipoTasa}]: ${procesados} chunks OK, ${errores} con error`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
	await mongoose.connect(process.env.URLDB);
	console.log('Conectado a MongoDB');

	if (DRY_RUN) console.log('\n⚠️  Modo DRY-RUN: solo muestra chunks, no scrapea\n');

	const tasas = SOLO_TASA
		? TASAS_BP.filter(t => t.tipoTasa === SOLO_TASA)
		: TASAS_BP;

	if (tasas.length === 0) {
		console.error(`Tasa "${SOLO_TASA}" no encontrada. Opciones: ${TASAS_BP.map(t => t.tipoTasa).join(', ')}`);
		await mongoose.disconnect();
		process.exit(1);
	}

	console.log(`\n${'='.repeat(60)}`);
	console.log('Carga histórica — Tasas Banco Provincia');
	console.log(`${'='.repeat(60)}`);
	console.log(`Tasas a procesar: ${tasas.map(t => t.tipoTasa).join(', ')}`);

	for (let i = 0; i < tasas.length; i++) {
		await cargarTasa(tasas[i]);
		if (i < tasas.length - 1) {
			console.log(`\nPausa de ${PAUSA_TASA_MS / 1000}s entre tasas...`);
			await new Promise(r => setTimeout(r, PAUSA_TASA_MS));
		}
	}

	console.log(`\n${'='.repeat(60)}`);
	console.log('Carga histórica completada.');

	await mongoose.disconnect();
}

run().catch(err => {
	console.error('Error fatal:', err.message);
	mongoose.disconnect();
	process.exit(1);
});
