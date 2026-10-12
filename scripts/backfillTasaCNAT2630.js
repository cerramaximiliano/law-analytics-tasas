'use strict';
/**
 * Carga la serie tasaActivaCNAT2630: 36 % nominal anual fijo (36/365 por día) del 23/03/2016
 * al 30/11/2017.
 *
 * El acta CNAT 2630 (27/04/2016) mantuvo el 36 % anual porque la tasa de préstamos personales
 * libre destino del BNA a 49-60 meses (acta 2601) dejó de publicarse el 22/03/2016. Rige hasta
 * el 30/11/2017; desde el 01/12/2017, acta 2658. Arranca el 23/03/2016 para empalmar sin hueco
 * con la 2601, como hace CPACF.
 *
 * Verificado el 11/10/2026 en CPACF (tasa 23, "Acta CNAT 2.764/22, incluye actas anteriores"):
 * 36 % anual (0,0986 % diario) del 15/03/2016 al 30/11/2017 y 29,32 % (acta 2658) desde el
 * 01/12/2017. La tasa 16 de CPACF (préstamos personales 49-60 meses) termina el 22/03/2016.
 * La serie tasaActivaCNAT2601 no se toca.
 *
 * Pendiente de revisión legal (backlog la-ads ítem 7, D3 b.5).
 *
 * Uso:
 *   node scripts/backfillTasaCNAT2630.js --dry-run
 *   node scripts/backfillTasaCNAT2630.js
 */

require('dotenv').config();
const moment = require('moment');

const database = require('../server/utils/database');
const Tasas = require('../server/models/tasas');
const TasasConfig = require('../server/models/tasasConfig');
const { verificarFechasFaltantes } = require('../server/controllers/tasasConfigController');

const TIPO_TASA = 'tasaActivaCNAT2630';
const TNA = 36;
const VALOR_DIARIO = TNA / 365;
const FUENTE = 'Acta CNAT 2630 (36 % anual) — verificado en CPACF tasa 23';
const DESDE = '2016-03-23';
const HASTA = '2017-11-30';

const DRY_RUN = process.argv.includes('--dry-run');

async function run() {
	console.log(`\n=== Carga ${TIPO_TASA} ${DESDE} → ${HASTA} (${TNA} % / 365 = ${VALOR_DIARIO}) ===`);
	console.log(`Modo: ${DRY_RUN ? 'DRY-RUN (no guarda)' : 'WRITE'}`);
	await database.connect();

	let nuevos = 0;
	let completados = 0;
	let iguales = 0;
	for (let d = moment.utc(DESDE); d.isSameOrBefore(moment.utc(HASTA)); d.add(1, 'day')) {
		const fecha = d.clone().startOf('day').toDate();
		const existente = await Tasas.findOne({ fecha }).lean();
		if (existente && existente[TIPO_TASA] === VALOR_DIARIO) {
			iguales++;
			continue;
		}
		if (!DRY_RUN) {
			await Tasas.updateOne(
				{ fecha },
				{ $set: { [TIPO_TASA]: VALOR_DIARIO, [`fuentes.${TIPO_TASA}`]: FUENTE } },
				{ upsert: true }
			);
		}
		existente ? completados++ : nuevos++;
	}
	console.log(`Días: ${nuevos} documentos nuevos · ${completados} documentos existentes completados · ${iguales} ya estaban`);

	if (DRY_RUN) {
		console.log('Dry-run: no se crea ni sincroniza TasasConfig.');
	} else {
		const r = await verificarFechasFaltantes(TIPO_TASA);
		await TasasConfig.updateOne(
			{ tipoTasa: TIPO_TASA },
			{
				$set: {
					descripcion: 'Tasa Activa Banco Nación - Acta 2630',
					tipoIndice: 'interesDiario',
					discontinuada: true,
					fechaFin: moment.utc(HASTA).startOf('day').toDate(),
				},
			}
		);
		console.log(`TasasConfig: ${moment.utc(r.fechaInicio).format('YYYY-MM-DD')} → ${moment.utc(r.fechaUltima).format('YYYY-MM-DD')}, faltantes ${r.diasFaltantes}`);
	}
	await database.disconnect();
}

run().catch((err) => {
	console.error('Error fatal:', err);
	process.exit(1);
});
