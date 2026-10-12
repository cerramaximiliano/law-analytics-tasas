'use strict';
/**
 * Carga histórica de las series nuevas del BCRA (backlog la-ads ítem 7, D3 etapa 2):
 *   - uva (31), uvi (32): índices diarios → `indexado`.
 *   - tasaBADLAR (7), tasaTAMAR (44), tasaTM20 (8): TNA de días hábiles de bancos privados,
 *     guardadas como TNA/365 por día con relleno de días sin publicación → `interesDiario`.
 *
 * Consulta por años; los años sin datos se saltean. Al final sincroniza TasasConfig.
 *
 * Uso:
 *   node scripts/backfillSeriesBCRA.js --dry-run
 *   node scripts/backfillSeriesBCRA.js
 *   node scripts/backfillSeriesBCRA.js --serie=tasaTAMAR --desde=2020-01-01
 */

require('dotenv').config();
const axios = require('axios');
const https = require('https');
const moment = require('moment');

const database = require('../server/utils/database');
const Tasas = require('../server/models/tasas');
const { verificarFechasFaltantes } = require('../server/controllers/tasasConfigController');
const { actualizarSerieTNA } = require('../server/services/scrapers/tasas/bcraService');
const { expandirDiasHabiles } = require('../server/services/scrapers/tasas/seriesTNA');

const SERIES = {
	uva: { idVariable: '31', desde: '2016-03-31' },
	uvi: { idVariable: '32', desde: '2016-03-31' },
	tasaBADLAR: { idVariable: '7', desde: '1995-01-01', tna: true },
	tasaTAMAR: { idVariable: '44', desde: '1995-01-01', tna: true },
	tasaTM20: { idVariable: '8', desde: '1995-01-01', tna: true },
};

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const arg = (k) => (args.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1];
const SOLO = arg('serie');
const DESDE = arg('desde');
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

async function consultar(idVariable, desde, hasta) {
	const url = `https://api.bcra.gob.ar/estadisticas/v4.0/monetarias/${idVariable}?desde=${desde}&hasta=${hasta}&limit=3000`;
	const resp = await axios.get(url, { headers: { Accept: 'application/json' }, httpsAgent, timeout: 30000 });
	const r = resp.data.results || [];
	return r.length && r[0].detalle ? r[0].detalle : [];
}

function rangosAnuales(desde, hasta) {
	const out = [];
	let c = moment.utc(desde).startOf('day');
	const fin = moment.utc(hasta).startOf('day');
	while (c.isSameOrBefore(fin)) {
		const h = moment.min(c.clone().endOf('year').startOf('day'), fin);
		out.push({ desde: c.format('YYYY-MM-DD'), hasta: h.format('YYYY-MM-DD') });
		c = h.clone().add(1, 'day');
	}
	return out;
}

async function cargarIndice(tipoTasa, serie, desde, hoy) {
	let total = 0;
	for (const r of rangosAnuales(desde, hoy)) {
		const datos = await consultar(serie.idVariable, r.desde, r.hasta);
		total += datos.length;
		process.stdout.write(`  ${r.desde.slice(0, 4)}: ${datos.length} `);
		if (DRY_RUN || !datos.length) continue;
		const ops = datos
			.filter((d) => !isNaN(parseFloat(d.valor)))
			.map((d) => ({
				updateOne: {
					filter: { fecha: moment.utc(d.fecha, 'YYYY-MM-DD').startOf('day').toDate() },
					update: { $set: { [tipoTasa]: parseFloat(d.valor), [`fuentes.${tipoTasa}`]: 'BCRA API' } },
					upsert: true,
				},
			}));
		await Tasas.bulkWrite(ops, { ordered: false });
		await new Promise((res) => setTimeout(res, 500));
	}
	return total;
}

async function cargarTNA(tipoTasa, serie, desde, hoy) {
	let total = 0;
	for (const r of rangosAnuales(desde, hoy)) {
		if (DRY_RUN) {
			const datos = await consultar(serie.idVariable, r.desde, r.hasta);
			const dias = expandirDiasHabiles(datos, { hasta: r.hasta });
			total += dias.length;
			process.stdout.write(`  ${r.desde.slice(0, 4)}: ${datos.length}→${dias.length} `);
		} else {
			// Cada año arranca 7 días antes: así se completan los días sin publicación del cierre
			// del año anterior (31/12), que quedan entre dos consultas.
			const desdeSolapado = moment.utc(r.desde).subtract(7, 'days').format('YYYY-MM-DD');
			const res = await actualizarSerieTNA(tipoTasa, { desde: desdeSolapado, hasta: r.hasta });
			const n = res.data ? res.data.dias : 0;
			total += n;
			process.stdout.write(`  ${r.desde.slice(0, 4)}: ${n} `);
		}
		await new Promise((res) => setTimeout(res, 500));
	}
	return total;
}

async function sincronizarConfig(tipoTasa) {
	// Crea o actualiza TasasConfig con el catálogo (periodicidad, fuente, unidades, atraso) y
	// recalcula rango y huecos.
	const r = await verificarFechasFaltantes(tipoTasa);
	console.log(`  TasasConfig: ${moment.utc(r.fechaInicio).format('YYYY-MM-DD')} → ${moment.utc(r.fechaUltima).format('YYYY-MM-DD')}, faltantes ${r.diasFaltantes}`);
}

async function run() {
	console.log(`\n=== Carga histórica series BCRA (${DRY_RUN ? 'DRY-RUN' : 'WRITE'}) ===`);
	await database.connect();
	const hoy = moment.utc().startOf('day').format('YYYY-MM-DD');
	for (const [tipoTasa, serie] of Object.entries(SERIES)) {
		if (SOLO && SOLO !== tipoTasa) continue;
		console.log(`\n${tipoTasa} (variable ${serie.idVariable})`);
		const desde = DESDE || serie.desde;
		const total = serie.tna ? await cargarTNA(tipoTasa, serie, desde, hoy) : await cargarIndice(tipoTasa, serie, desde, hoy);
		console.log(`\n  total: ${total} días`);
		if (!DRY_RUN) await sincronizarConfig(tipoTasa);
	}
	await database.disconnect();
}

run().catch((err) => {
	console.error('Error fatal:', err);
	process.exit(1);
});
