'use strict';
/**
 * Backfill histórico de la Tasa Pasiva BCRA Ley 27.802 art.55(a) (idVariable 1198).
 *
 * Consulta la API del BCRA por chunks anuales desde 1993-06-03 hasta hoy
 * y guarda los registros en la colección Tasas. Al finalizar, sincroniza
 * la TasasConfig (fechaInicio, fechaUltima, fechaUltimaCompleta, fechasFaltantes).
 *
 * Uso:
 *   node scripts/backfillTasaPasivaBCRA27802.js
 *   node scripts/backfillTasaPasivaBCRA27802.js --desde=2020-01-01
 *   node scripts/backfillTasaPasivaBCRA27802.js --dry-run
 */

require('dotenv').config();
const axios = require('axios');
const https = require('https');
const moment = require('moment');

const database = require('../server/utils/database');
const Tasas = require('../server/models/tasas');
const TasasConfig = require('../server/models/tasasConfig');
const { verificarFechasFaltantes } = require('../server/controllers/tasasConfigController');

const TIPO_TASA = 'tasaPasivaBCRA27802';
const ID_VARIABLE = '1198';
const FECHA_INICIO_SERIE = '1993-06-03';
const PAUSA_MS = 1000;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const desdeArg = args.find(a => a.startsWith('--desde='));
const FECHA_DESDE = desdeArg ? desdeArg.split('=')[1] : FECHA_INICIO_SERIE;

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

async function consultarChunk(desde, hasta) {
	const url = `https://api.bcra.gob.ar/estadisticas/v4.0/monetarias/${ID_VARIABLE}?desde=${desde}&hasta=${hasta}&limit=1000`;
	const resp = await axios.get(url, {
		headers: { Accept: 'application/json' },
		httpsAgent,
		timeout: 20000,
	});
	const results = resp.data.results || [];
	return results.length > 0 && results[0].detalle ? results[0].detalle : [];
}

async function guardarRegistros(registros) {
	let creados = 0;
	let actualizados = 0;
	let errores = 0;

	for (const item of registros) {
		try {
			const fecha = moment.utc(item.fecha, 'YYYY-MM-DD').startOf('day').toDate();
			const valor = parseFloat(item.valor);
			if (isNaN(valor)) {
				errores++;
				continue;
			}

			const existente = await Tasas.findOne({ fecha });
			if (existente) {
				if (existente[TIPO_TASA] === valor) continue;
				existente[TIPO_TASA] = valor;
				if (!existente.fuentes) existente.fuentes = {};
				existente.fuentes[TIPO_TASA] = 'BCRA API';
				existente.markModified('fuentes');
				await existente.save();
				actualizados++;
			} else {
				await Tasas.create({
					fecha,
					[TIPO_TASA]: valor,
					fuentes: { [TIPO_TASA]: 'BCRA API' },
				});
				creados++;
			}
		} catch (err) {
			if (err.message === 'MERGED_WITH_EXISTING') {
				actualizados++;
			} else {
				console.error(`  Error al guardar ${item.fecha}: ${err.message}`);
				errores++;
			}
		}
	}

	return { creados, actualizados, errores };
}

function generarRangosAnuales(fechaInicio, fechaFin) {
	const rangos = [];
	let cursor = moment.utc(fechaInicio).startOf('day');
	const fin = moment.utc(fechaFin).startOf('day');

	while (cursor.isSameOrBefore(fin)) {
		const finDeAnio = cursor.clone().endOf('year').startOf('day');
		const hasta = finDeAnio.isAfter(fin) ? fin : finDeAnio;
		rangos.push({
			desde: cursor.format('YYYY-MM-DD'),
			hasta: hasta.format('YYYY-MM-DD'),
		});
		cursor = hasta.clone().add(1, 'days');
	}
	return rangos;
}

async function run() {
	console.log(`\n=== Backfill ${TIPO_TASA} (idVariable ${ID_VARIABLE}) ===`);
	console.log(`Modo: ${DRY_RUN ? 'DRY-RUN (no guarda)' : 'WRITE'}`);
	console.log(`Desde: ${FECHA_DESDE}`);

	await database.connect();

	const fechaHoy = moment.utc().startOf('day').format('YYYY-MM-DD');
	const rangos = generarRangosAnuales(FECHA_DESDE, fechaHoy);
	console.log(`Rangos a consultar: ${rangos.length}\n`);

	const totales = { obtenidos: 0, creados: 0, actualizados: 0, errores: 0 };

	for (let i = 0; i < rangos.length; i++) {
		const { desde, hasta } = rangos[i];
		process.stdout.write(`[${i + 1}/${rangos.length}] ${desde} → ${hasta} ... `);

		try {
			const registros = await consultarChunk(desde, hasta);
			totales.obtenidos += registros.length;

			if (DRY_RUN) {
				console.log(`${registros.length} registros (dry-run)`);
			} else if (registros.length === 0) {
				console.log('0 registros');
			} else {
				const r = await guardarRegistros(registros);
				totales.creados += r.creados;
				totales.actualizados += r.actualizados;
				totales.errores += r.errores;
				console.log(`${registros.length} obtenidos · ${r.creados} creados · ${r.actualizados} actualizados · ${r.errores} errores`);
			}
		} catch (err) {
			console.log(`ERROR: ${err.message}`);
			totales.errores++;
		}

		if (i < rangos.length - 1) {
			await new Promise(r => setTimeout(r, PAUSA_MS));
		}
	}

	console.log(`\nTotales: ${totales.obtenidos} obtenidos · ${totales.creados} creados · ${totales.actualizados} actualizados · ${totales.errores} errores`);

	if (DRY_RUN) {
		console.log('\nDry-run, no se sincroniza TasasConfig.');
		await database.disconnect();
		return;
	}

	console.log('\nSincronizando TasasConfig...');
	const existeConfig = await TasasConfig.findOne({ tipoTasa: TIPO_TASA });
	if (!existeConfig) {
		const primerDoc = await Tasas.findOne({ [TIPO_TASA]: { $ne: null } }).sort({ fecha: 1 }).select('fecha').lean();
		const ultimoDoc = await Tasas.findOne({ [TIPO_TASA]: { $ne: null } }).sort({ fecha: -1 }).select('fecha').lean();
		if (!primerDoc || !ultimoDoc) {
			console.log('No se guardó ningún registro; no se crea TasasConfig.');
			await database.disconnect();
			return;
		}
		await TasasConfig.create({
			tipoTasa: TIPO_TASA,
			fechaInicio: moment.utc(primerDoc.fecha).startOf('day').toDate(),
			fechaUltima: moment.utc(ultimoDoc.fecha).startOf('day').toDate(),
			fechaUltimaCompleta: moment.utc(ultimoDoc.fecha).startOf('day').toDate(),
			fechasFaltantes: [],
			descripcion: 'Tasa Pasiva BCRA Ley 27.802 art.55(a)',
			ultimaVerificacion: new Date(),
		});
		console.log(`TasasConfig creado.`);
	}

	const resultado = await verificarFechasFaltantes(TIPO_TASA);
	console.log(`\nResultado verificarFechasFaltantes:`);
	console.log(`  fechaInicio:         ${moment.utc(resultado.fechaInicio).format('YYYY-MM-DD')}`);
	console.log(`  fechaUltima:         ${moment.utc(resultado.fechaUltima).format('YYYY-MM-DD')}`);
	console.log(`  fechaUltimaCompleta: ${resultado.fechaUltimaCompleta ? moment.utc(resultado.fechaUltimaCompleta).format('YYYY-MM-DD') : 'null'}`);
	console.log(`  totalDias:           ${resultado.totalDias}`);
	console.log(`  diasExistentes:      ${resultado.diasExistentes}`);
	console.log(`  diasFaltantes:       ${resultado.diasFaltantes}`);

	await database.disconnect();
}

run().catch(err => {
	console.error('Error fatal:', err);
	process.exit(1);
});
