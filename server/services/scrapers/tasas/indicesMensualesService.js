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
const { CATALOGO_TASAS } = require('../../../utils/tasasIndices');
const { proximaPublicacion } = require('../../../utils/calendarioPublicacion');

const SERIES_MENSUALES = {
	inflacionMensual: {
		origen: 'bcra', id: '27', tipo: 'variacion', tipoIndice: 'variacionMensual',
		descripcion: 'Inflación mensual (IPC INDEC, vía BCRA)', fuente: 'BCRA API variable 27', desde: '1943-01-01',
	},
	ripte: {
		origen: 'datosgob', id: '158.1_REPTE_0_0_5', tipo: 'nivel', tipoIndice: 'indiceMensual',
		descripcion: 'RIPTE (Remuneración Imponible Promedio de los Trabajadores Estables)',
		fuente: 'datos.gob.ar 158.1_REPTE_0_0_5', desde: '1994-07-01', provisoriosUltimos: 2,
		// La serie de datos.gob.ar es una republicación: llega más tarde que la página de la
		// Secretaría de Trabajo y puede traer errores (el 23/11/2026 no tenía 9/2026 y repetía en
		// 8/2026 el valor de junio). Los meses que publica la página oficial mandan.
		oficial: 'ripteTrabajo',
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

/**
 * Series de 'valor' (monto vigente): completa los meses sin publicación repitiendo el último
 * valor, desde el primer período hasta el último publicado (puede ser futuro si ya se decretó).
 * @returns {Array<{periodo:string, valor:number, rellenoDesde?:string}>}
 */
function completarValoresVigentes(datos) {
	const orden = [...datos].sort((a, b) => (a.periodo < b.periodo ? -1 : 1));
	if (!orden.length) return [];
	const porPeriodo = new Map(orden.map((d) => [d.periodo, d]));
	const out = [];
	let vigente = orden[0];
	const ultimo = orden[orden.length - 1].periodo;
	for (let m = moment.utc(orden[0].periodo, 'YYYY-MM'); m.format('YYYY-MM') <= ultimo; m.add(1, 'month')) {
		const p = m.format('YYYY-MM');
		if (porPeriodo.has(p)) {
			vigente = porPeriodo.get(p);
			out.push({ periodo: p, valor: vigente.valor });
		} else {
			out.push({ periodo: p, valor: vigente.valor, rellenoDesde: vigente.periodo });
		}
	}
	return out;
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

const RIPTE_OFICIAL_URL = 'https://www.argentina.gob.ar/trabajo/seguridadsocial/ripte';
const FUENTE_RIPTE_OFICIAL = 'Secretaría de Trabajo, argentina.gob.ar/trabajo/seguridadsocial/ripte';
const MESES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };

/**
 * Tabla de la página oficial del RIPTE: filas "Setiembre/2026 | $ 2.022.244,09 | ...".
 * Función pura (se testea con el HTML guardado).
 * @returns {Array<{periodo:string, valor:number}>}
 */
function parsearTablaRipte(html) {
	const cheerio = require('cheerio');
	const $ = cheerio.load(html);
	const out = [];
	$('table tbody tr').each((_, tr) => {
		const celdas = $(tr).find('td').map((__, td) => $(td).text().replace(/\s+/g, ' ').trim()).get();
		if (celdas.length < 2) return;
		const m = /^([a-záéíóúñ]+)\s*\/\s*(\d{4})$/i.exec(celdas[0]);
		const mes = m && MESES[m[1].toLowerCase()];
		const valor = parseFloat(celdas[1].replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
		if (!mes || !Number.isFinite(valor) || valor <= 0) return;
		out.push({ periodo: `${m[2]}-${String(mes).padStart(2, '0')}`, valor });
	});
	return out.sort((a, b) => (a.periodo < b.periodo ? -1 : 1));
}

/** @returns {Array<{periodo:string, valor:number}>} últimos ~21 meses publicados por la Secretaría de Trabajo */
async function leerRipteOficial() {
	const resp = await conReintentos(() => axios.get(RIPTE_OFICIAL_URL, { timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' }, responseType: 'text' }));
	const datos = parsearTablaRipte(resp.data);
	if (!datos.length) throw new Error('la página oficial del RIPTE no trae la tabla esperada');
	return datos;
}

/**
 * Superpone lo que publica la fuente oficial primaria sobre la serie republicada: los meses de
 * la fuente oficial reemplazan o agregan. Devuelve además las diferencias, para el log.
 */
function superponerOficial(republicada, oficial, fuenteOficial) {
	const porPeriodo = new Map(republicada.map((d) => [d.periodo, { ...d }]));
	const diferencias = [];
	for (const o of oficial) {
		const previo = porPeriodo.get(o.periodo);
		if (!previo) diferencias.push({ periodo: o.periodo, republicada: null, oficial: o.valor });
		else if (Math.abs(previo.valor - o.valor) > 0.005) diferencias.push({ periodo: o.periodo, republicada: previo.valor, oficial: o.valor });
		porPeriodo.set(o.periodo, { periodo: o.periodo, valor: o.valor, fuente: fuenteOficial });
	}
	return { datos: [...porPeriodo.values()].sort((a, b) => (a.periodo < b.periodo ? -1 : 1)), diferencias };
}

/**
 * Compara lo leído con lo que ya estaba guardado: meses nuevos y meses que la fuente corrigió.
 * Función pura. Si no había nada guardado es la carga inicial y no hay novedades que avisar.
 * @param {Array<{periodo, valor, fuente?, rellenoDesde?}>} leidos  en orden cronológico
 * @param {Map<string, number>} previos  período → valor guardado
 * @param {'nivel'|'variacion'|'valor'} tipo
 */
function detectarNovedades(leidos, previos, tipo, fuenteDefault) {
	if (!previos || !previos.size) return [];
	const out = [];
	leidos.forEach((d, i) => {
		if (d.rellenoDesde) return;
		const fuente = d.fuente || fuenteDefault;
		if (!previos.has(d.periodo)) {
			const ant = i > 0 ? leidos[i - 1].valor : undefined;
			const variacion = tipo === 'nivel' && ant > 0 ? (d.valor / ant - 1) * 100 : undefined;
			out.push({ tipo: 'nuevo', periodo: d.periodo, valor: d.valor, variacion, fuente });
		} else if (Math.abs(previos.get(d.periodo) - d.valor) > 1e-6) {
			out.push({ tipo: 'revisado', periodo: d.periodo, valor: d.valor, anterior: previos.get(d.periodo), fuente });
		}
	});
	return out;
}

/**
 * Trae y guarda una serie mensual. Por defecto relee los últimos 12 meses (las fuentes
 * corrigen valores provisorios); con `completa: true` relee desde el inicio de la serie, que es
 * la única forma de recoger una revisión de la fuente sobre un mes más viejo.
 */
async function actualizarSerieMensual(serie, opciones = {}) {
	const cfg = SERIES_MENSUALES[serie];
	if (!cfg) return { status: 'error', message: `Serie mensual desconocida: ${serie}` };
	const hoy = moment.utc().startOf('day');
	const desde = opciones.desde || (opciones.completa ? cfg.desde : hoy.clone().subtract(12, 'months').startOf('month').format('YYYY-MM-DD'));
	try {
		const datos = cfg.origen === 'bcra'
			? await leerBCRA(cfg.id, desde, hoy.format('YYYY-MM-DD'))
			: await leerDatosGob(cfg.id, desde);
		let validos = datos.filter((d) => /^\d{4}-\d{2}$/.test(d.periodo) && Number.isFinite(d.valor)).sort((a, b) => (a.periodo < b.periodo ? -1 : 1));
		if (cfg.oficial === 'ripteTrabajo') {
			try {
				const r = superponerOficial(validos, (await leerRipteOficial()).filter((d) => d.periodo >= desde.slice(0, 7)), FUENTE_RIPTE_OFICIAL);
				validos = r.datos;
				for (const x of r.diferencias) logger.warn(`${serie} ${x.periodo}: la fuente oficial da ${x.oficial} y datos.gob.ar ${x.republicada === null ? 'no lo tiene' : x.republicada}; se guarda el oficial`);
			} catch (e) {
				logger.warn(`${serie}: no se pudo leer la fuente oficial (${e.message}); se sigue con datos.gob.ar`);
			}
		}
		if (cfg.tipo === 'valor') validos = completarValoresVigentes(validos);
		if (!validos.length) return { status: 'warning', message: `${serie}: sin datos desde ${desde}` };

		const previos = new Map((await IndicesMensuales.find({ serie, periodo: { $gte: validos[0].periodo } }).select('periodo valor').lean()).map((d) => [d.periodo, d.valor]));
		const novedades = detectarNovedades(validos, previos, cfg.tipo, cfg.fuente);
		const provisorios = new Set(cfg.provisoriosUltimos ? validos.slice(-cfg.provisoriosUltimos).map((d) => d.periodo) : []);
		if (!opciones.dryRun) {
			await IndicesMensuales.bulkWrite(
				validos.map((d) => ({
					updateOne: {
						filter: { serie, periodo: d.periodo },
						update: {
							$set: { valor: d.valor, tipo: cfg.tipo, fuente: d.fuente || cfg.fuente, provisorio: provisorios.has(d.periodo), publicadoEn: new Date(), ...(d.rellenoDesde ? { rellenoDesde: d.rellenoDesde } : {}) },
							...(d.rellenoDesde ? {} : { $unset: { rellenoDesde: '' } }),
						},
						upsert: true,
					},
				})),
				{ ordered: false }
			);
			await sincronizarConfig(serie);
		}
		logger.info(`${serie}: ${validos.length} meses (${validos[0].periodo} → ${validos[validos.length - 1].periodo})`);
		return { status: 'success', message: `${serie}: ${validos.length} meses`, data: { meses: validos.length, primero: validos[0].periodo, ultimo: validos[validos.length - 1].periodo, novedades } };
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

/**
 * Actualiza todas las series. Para las que tienen calendario de publicación en el catálogo
 * (IPC, RIPTE, inflación): avisa por correo los meses nuevos o corregidos y renueva la tarea de
 * seguimiento del admin, también cuando la fuente falló (así la tarea queda vencida a la vista).
 */
async function actualizarTodas(opciones = {}) {
	const resultados = {};
	const seguidas = [];
	for (const serie of Object.keys(SERIES_MENSUALES)) {
		const r = await actualizarSerieMensual(serie, opciones);
		resultados[serie] = r;
		const cat = CATALOGO_TASAS[serie];
		if (opciones.dryRun || !cat || !cat.publicacion) continue;
		try {
			const ultimo = await IndicesMensuales.findOne({ serie }).sort({ periodo: -1 }).select('periodo').lean();
			if (!ultimo) continue;
			const novedades = (r.data && r.data.novedades) || [];
			seguidas.push({ serie, descripcion: cat.descripcion, novedades, proximo: proximaPublicacion(cat.publicacion, ultimo.periodo) });
			if (!opciones.sinSeguimiento) {
				const { seguirSerieMensual } = require('../../seguimiento/seguimientoIndices');
				await seguirSerieMensual({ serie, descripcion: cat.descripcion, fuente: cat.fuente, regla: cat.publicacion, ultimoPeriodo: ultimo.periodo, novedades, aiSession: opciones.aiSession });
			}
		} catch (e) {
			logger.error(`${serie}: no se pudo registrar el seguimiento: ${e.message}`);
		}
	}
	if (!opciones.dryRun && !opciones.sinAviso) {
		const { notificarNovedades } = require('./avisoIndices');
		await notificarNovedades(seguidas);
	}
	return resultados;
}

module.exports = { SERIES_MENSUALES, actualizarSerieMensual, actualizarTodas, leerBCRA, leerDatosGob, completarValoresVigentes, parsearTablaRipte, leerRipteOficial, superponerOficial, detectarNovedades };
