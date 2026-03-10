'use strict';
// Script para rellenar fechas faltantes de tasaPasivaBCRA desde la API de BCRA

const database = require('../server/utils/database');
const TasasConfig = require('../server/models/tasasConfig');
const Tasas = require('../server/models/tasas');
const moment = require('moment');
const axios = require('axios');
const https = require('https');

async function run() {
	await database.connect();
	console.log('Conectado a MongoDB');

	const config = await TasasConfig.findOne({ tipoTasa: 'tasaPasivaBCRA' });
	if (!config) {
		console.log('No hay config para tasaPasivaBCRA');
		process.exit(0);
	}

	const faltantes = config.fechasFaltantes.map(f => moment.utc(f).format('YYYY-MM-DD'));
	console.log('Fechas faltantes en config:', faltantes);

	if (faltantes.length === 0) {
		console.log('No hay fechas faltantes.');
		process.exit(0);
	}

	const desde = faltantes[0];
	const hasta = faltantes[faltantes.length - 1];
	const url = `https://api.bcra.gob.ar/estadisticas/v4.0/monetarias/43?desde=${desde}&hasta=${hasta}`;
	console.log('Consultando BCRA:', url);

	const agent = new https.Agent({ rejectUnauthorized: false });
	const resp = await axios.get(url, { httpsAgent: agent });
	const rawResults = resp.data.results || [];
	const results = rawResults.length > 0 && rawResults[0].detalle ? rawResults[0].detalle : rawResults;
	console.log(`BCRA devolvió ${results.length} registros`);

	if (results.length === 0) {
		console.log('Sin datos del BCRA para ese rango.');
		process.exit(0);
	}

	let guardados = 0;
	for (const item of results) {
		const fecha = moment.utc(item.fecha, 'YYYY-MM-DD').startOf('day').toDate();
		const valor = parseFloat(item.valor);
		if (isNaN(valor)) continue;

		const existente = await Tasas.findOne({ fecha });
		if (existente) {
			existente.tasaPasivaBCRA = valor;
			if (!existente.fuentes) existente.fuentes = {};
			existente.fuentes.tasaPasivaBCRA = 'BCRA API';
			existente.markModified('fuentes');
			await existente.save();
			console.log(`Actualizado: ${moment.utc(fecha).format('YYYY-MM-DD')} = ${valor}`);
		} else {
			await Tasas.create({
				fecha,
				tasaPasivaBCRA: valor,
				fuentes: { tasaPasivaBCRA: 'BCRA API' },
			});
			console.log(`Creado: ${moment.utc(fecha).format('YYYY-MM-DD')} = ${valor}`);
		}
		guardados++;
	}
	console.log(`\nGuardados: ${guardados} registros`);

	// Recalcular TasasConfig desde cero con los datos actualizados
	const { verificarFechasFaltantes } = require('../server/controllers/tasasConfigController');
	const resultado = await verificarFechasFaltantes('tasaPasivaBCRA');
	console.log('\nConfig actualizada:');
	console.log('  fechaUltimaCompleta:', resultado.fechaUltimaCompleta);
	console.log('  fechaUltima:', resultado.fechaUltima);
	console.log('  diasFaltantes:', resultado.diasFaltantes);
	console.log('  faltantes restantes:', resultado.fechasFaltantes?.map(f => f.fechaFormateada));

	process.exit(0);
}

run().catch(e => { console.error('Error:', e.message); process.exit(1); });
