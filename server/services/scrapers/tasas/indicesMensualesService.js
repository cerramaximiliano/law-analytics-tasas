'use strict';
/**
 * Series mensuales → colección IndicesMensuales (backlog la-ads ítem 7, D3 etapa 2).
 *
 * Fuentes:
 *  - BCRA API v4: inflación mensual (variable 27, IPC INDEC), fecha = último día del mes.
 *  - datos.gob.ar (apis.datos.gob.ar/series): RIPTE, IPC nivel, SMVM, haber mínimo.
 *
 * Las series usables como tasa en un tramo (variacionMensual, indiceMensual) también tienen
 * TasasConfig, para que el hub las liste y elija la fórmula. Las de 'valor' (SMVM, haber
 * mínimo) son para topes y pisos (ART, previsional) y no se ofrecen como tasa.
 */

const axios = require('axios');
const https = require('https');
const moment = require('moment');
const IndicesMensuales = require('../../../models/indicesMensuales');
const logger = require('../../../utils/logger');

const SERIES_MENSUALES = {
	inflacionMensual: {
		origen: 'bcra', id: '27', tipo: 'variacion', tipoIndice: 'variacionMensual',
		descripcion: 'Inflación mensual (IPC INDEC, vía BCRA)', fuente: 'BCRA API variable 27', desde: '1943-01-01',
	},
	ripte: {
		origen: 'datosgob', id: '158.1_REPTE_0_0_5', tipo: 'nivel', tipoIndice: 'indiceMensual',
		descripcion: 'RIPTE (Remuneración Imponible Promedio de los Trabajadores Estables)',
		fuente: 'datos.gob.ar 158.1_REPTE_0_0_5', desde: '1994-07-01', provisoriosUltimos: 2,
	},
	ipc: {
		origen: 'datosgob', id: '148.3_INIVELNAL_DICI_M_26', tipo: 'nivel', tipoIndice: 'indiceMensual',
		descripcion: 'IPC nacional nivel general (INDEC, base dic-2016 = 100)',
		fuente: 'datos.gob.ar 148.3_INIVELNAL_DICI_M_26', desde: '2016-12-01',
	},
	smvm: {
		origen: 'datosgob', id: '57.1_SMVMM_0_M_34', tipo: 'valor', tipoIndice: 'valorMensual',
		descripcion: 'Salario mínimo, vital y móvil mensual', fuente: 'datos.gob.ar 57.1_SMVMM_0_M_34', desde: '1988-01-01',
	},
	haberMinimo: {
		origen: 'datosgob', id: '58.1_MP_0_M_24', tipo: 'valor', tipoIndice: 'valorMensual',
		descripcion: 'Haber mínimo previsional', fuente: 'datos.gob.ar 58.1_MP_0_M_24', desde: '1994-01-01',
	},
};

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function conReintentos(fn, intentos = 3) {
	let ultimo;
	for (let i = 1; i <= intentos; i++) {
		try {
			return await fn();
		} catch (e) {
			ultimo = e;
			if (i < intentos) await esperar(2000 * i);
		}
	}
	throw ultimo;
}

/** @returns {Array<{periodo:string, valor:number}>} */
async function leerBCRA(id, desde, hasta) {
	const url = `https://api.bcra.gob.ar/estadisticas/v4.0/monetarias/${id}?desde=${desde}&hasta=${hasta}&limit=3000`;
	const resp = await conReintentos(() => axios.get(url, { headers: { Accept: 'application/json' }, httpsAgent, timeout: 30000 }));
	const r = resp.data.results || [];
	const detalle = r.length && r[0].detalle ? r[0].detalle : [];
	return detalle.map((d) => ({ periodo: d.fecha.slice(0, 7), valor: parseFloat(d.valor) }));
}

/** @returns {Array<{periodo:string, valor:number}>} */
async function leerDatosGob(id, desde) {
	const url = `https://apis.datos.gob.ar/series/api/series?ids=${id}&start_date=${desde}&limit=5000&format=json`;
	const resp = await conReintentos(() => axios.get(url, { timeout: 30000 }));
	if (resp.data && resp.data.errors) throw new Error(JSON.stringify(resp.data.errors).slice(0, 300));
	return (resp.data.data || [])
		.filter((d) => d[1] !== null && d[1] !== undefined)
		.map((d) => ({ periodo: String(d[0]).slice(0, 7), valor: Number(d[1]) }));
}

/**
 * Trae y guarda una serie mensual. Por defecto relee los últimos 12 meses (las fuentes
 * corrigen valores provisorios).
 */
async function actualizarSerieMensual(serie, opciones = {}) {
	const cfg = SERIES_MENSUALES[serie];
	if (!cfg) return { status: 'error', message: `Serie mensual desconocida: ${serie}` };
	const hoy = moment.utc().startOf('day');
	const desde = opciones.desde || hoy.clone().subtract(12, 'months').startOf('month').format('YYYY-MM-DD');
	try {
		const datos = cfg.origen === 'bcra'
			? await leerBCRA(cfg.id, desde, hoy.format('YYYY-MM-DD'))
			: await leerDatosGob(cfg.id, desde);
		const validos = datos.filter((d) => /^\d{4}-\d{2}$/.test(d.periodo) && Number.isFinite(d.valor)).sort((a, b) => (a.periodo < b.periodo ? -1 : 1));
		if (!validos.length) return { status: 'warning', message: `${serie}: sin datos desde ${desde}` };

		const provisorios = new Set(cfg.provisoriosUltimos ? validos.slice(-cfg.provisoriosUltimos).map((d) => d.periodo) : []);
		if (!opciones.dryRun) {
			await IndicesMensuales.bulkWrite(
				validos.map((d) => ({
					updateOne: {
						filter: { serie, periodo: d.periodo },
						update: {
							$set: { valor: d.valor, tipo: cfg.tipo, fuente: cfg.fuente, provisorio: provisorios.has(d.periodo), publicadoEn: new Date() },
						},
						upsert: true,
					},
				})),
				{ ordered: false }
			);
			await sincronizarConfig(serie);
		}
		logger.info(`${serie}: ${validos.length} meses (${validos[0].periodo} → ${validos[validos.length - 1].periodo})`);
		return { status: 'success', message: `${serie}: ${validos.length} meses`, data: { meses: validos.length, primero: validos[0].periodo, ultimo: validos[validos.length - 1].periodo } };
	} catch (error) {
		logger.error(`Error al actualizar serie mensual ${serie}: ${error.message}`);
		return { status: 'error', message: error.message };
	}
}

/** TasasConfig de las series usables como tasa: la arma verificarFechasFaltantes con el catálogo. */
async function sincronizarConfig(serie) {
	const cfg = SERIES_MENSUALES[serie];
	if (cfg.tipoIndice === 'valorMensual') return;
	const { verificarFechasFaltantes } = require('../../../controllers/tasasConfigController');
	await verificarFechasFaltantes(serie);
}

async function actualizarTodas(opciones = {}) {
	const resultados = {};
	for (const serie of Object.keys(SERIES_MENSUALES)) {
		resultados[serie] = await actualizarSerieMensual(serie, opciones);
	}
	return resultados;
}

module.exports = { SERIES_MENSUALES, actualizarSerieMensual, actualizarTodas, leerBCRA, leerDatosGob };
