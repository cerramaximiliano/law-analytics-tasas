'use strict';
/**
 * Sincronización de la colección `datosprevisionales` (un documento por mes, `fecha` = día 1 UTC)
 * desde fuentes oficiales publicadas en InfoLeg.
 *
 * Fuentes:
 *  1. Resoluciones mensuales de ANSES (movilidad DNU 274/24, desde abril de 2024): haber mínimo y
 *     máximo, bases imponibles mínima y máxima, PBU, PUAM y % de movilidad. Se listan desde los
 *     vínculos del DNU 274/24 (InfoLeg id 397577) y de la ley 24.241 (id 639): ninguna de las dos
 *     listas está completa por sí sola (p. ej. la Res. 66/2025 solo figura en la de la ley 24.241).
 *     El mes de vigencia sale del texto ("vigente a partir del mes de X"), no de la publicación.
 *  2. Bonos: decretos PEN "BONO EXTRAORDINARIO PREVISIONAL" (desde Dec. 552/24), "AYUDA ECONÓMICA
 *     PREVISIONAL" (Dec. 116/23 y 81, 177, 268, 340, 440/24), "REFUERZO DE INGRESO PREVISIONAL"
 *     (2022–23) y "SUBSIDIO EXTRAORDINARIO" (vínculos de la ley 24.241). Se guarda el monto máximo,
 *     que es el que cobra quien percibe hasta el haber mínimo.
 *  3. SMVM: resoluciones del Consejo Nacional del Empleo, la Productividad y el SMVM (búsqueda de
 *     InfoLeg por dependencia 3333). Cada resolución fija tramos "a partir del 1° de <mes>".
 *     Ojo: la serie de datos.gob.ar (IndicesMensuales.smvm) tiene meses mal rellenados.
 *
 * Reglas derivadas (verificadas contra los datos cargados a mano 2018–2026):
 *  - haberMinimoPension = haberMinimoJubilacion; haberMaximoPension = haberMaximoJubilacion.
 *  - maximoImponible = base imponible máxima (art. 3).
 *  - movilidadGeneral = 1 + %/100 (4 decimales). Si la resolución no trae el % (abril 2024), se
 *    deriva del cociente de haberes mínimos con el mes anterior.
 *  - topePC = topePC del mes anterior × movilidadGeneral, redondeado a centavos.
 *  - suplemento82SMVM = max(0, 0,82 × SMVM − haber mínimo): es el suplemento a pagar (ley 27.426
 *    art. 2), no el 82 % del SMVM.
 *
 * La sincronización hace upsert por `fecha` solo de los campos que trae la norma. Un valor ya
 * cargado y distinto NO se pisa (queda como conflicto en el informe) salvo con `forzar`. Con
 * `aplicar`, cada cambio queda en `datosprevisionales-sincronizaciones` para poder revertirlo.
 */

const axios = require('axios');
const cheerio = require('cheerio');
const moment = require('moment');
const mongoose = require('mongoose');
const logger = require('../../../utils/logger');

const INFOLEG = 'https://servicios.infoleg.gob.ar/infolegInternet';
const LISTAS_VINCULOS = { dnu274: 397577, ley24241: 639 };
// Consejo del Salario: 3333 (desde 2014 aprox.) y 18 (nombre viejo, usado aún en 2022)
const DEPENDENCIAS_CONSEJO_SMVM = [3333, 18];
const DESDE_SUPLEMENTO_82 = '2018-01'; // ley 27.426, art. 2
// Decretos de bono previsional: además de los vínculos, InfoLeg se busca por texto (tipo Decreto) año por año.
// Algunos no aparecen ni así (Dec. 309/20, título "EMERGENCIA SANITARIA"): van fijos.
const TEXTOS_BUSQUEDA_BONO = ['ingreso previsional', 'subsidio extraordinario', 'bono extraordinario previsional', 'ayuda economica previsional'];
const DECRETOS_BONO_FIJOS = [{ id: 335821, texto: 'Decreto 309 / 2020 PODER EJECUTIVO NACIONAL (P.E.N.) EMERGENCIA SANITARIA SUBSIDIO EXTRAORDINARIO' }];
const COLECCION = 'datosprevisionales';
const COLECCION_AUDITORIA = 'datosprevisionales-sincronizaciones';
const INICIO_MOVILIDAD_DNU274 = '2024-04';

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MESES_CORTOS = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, oct: 10, nov: 11, dic: 12 };

// Campos que escribe la sincronización y tolerancia para considerarlos iguales
const CAMPOS = {
	movilidadGeneral: 1e-6,
	haberMinimoJubilacion: 0.005,
	haberMinimoPension: 0.005,
	haberMaximoJubilacion: 0.005,
	haberMaximoPension: 0.005,
	maximoImponible: 0.005,
	baseImponibleMinima: 0.005,
	pbu: 0.005,
	puam: 0.005,
	topePC: 0.005,
	bono: 0.005,
	bonoNorma: null,
	bonoEscalones: null,
	salarioMVM: 0.005,
	suplemento82SMVM: 0.005,
	normaSMVM: null,
	norma: null,
	links: null,
	fuentes: null,
};

// Valores fijos de un mes nuevo (los mismos que tienen cargados los meses 2024–2026)
const DEFAULTS_MES_NUEVO = {
	estado: true,
	moneda: 'pesos',
	valorAMPOoMOPRE: 0,
	suplemento82SMVM: 0,
	salarioMVM: 0,
	minimoFerroviario406: 0,
	minimoFerroviario662: 0,
	haberGeneralBrigada: 0,
	referenciaDiferencialMin: 0,
	referenciaDiferencialMax: 0,
	movilidadDiferencial: 1,
	adicionales: 0,
	SupMovilidad: false,
};

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const mesSiguiente = (p, n = 1) => moment.utc(p, 'YYYY-MM').add(n, 'month').format('YYYY-MM');
const fechaDeMes = (p) => moment.utc(p, 'YYYY-MM').startOf('month').toDate();

// ─── Parseo (funciones puras) ────────────────────────────────────────────────

/** HTML de InfoLeg → texto plano en una línea (sin scripts ni estilos). */
function htmlATexto(html) {
	const $ = cheerio.load(html);
	$('script, style').remove();
	return $.root().text().replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * "403.317,99" | "180.000.-" | "1105,26" → número. "50.124.26" (errata de la Res. ANSES 260/2022, "CON VEINTISEIS
 * CENTAVOS"): sin coma, un último grupo de 2 dígitos tras el punto son centavos (los de miles tienen 3).
 */
function parsearMonto(s) {
	if (s === undefined || s === null) return null;
	let limpio = String(s).replace(/[^\d.,]/g, '').replace(/[.,]+$/, '');
	if (!limpio) return null;
	if (!limpio.includes(',')) limpio = limpio.replace(/\.(\d{2})$/, ',$1');
	const m = limpio.match(/^(.*?)(?:,(\d{1,2}))?$/);
	const entero = m[1].replace(/[.,]/g, '');
	const n = Number(`${entero}.${m[2] || '0'}`);
	return Number.isFinite(n) ? n : null;
}

/** "(2,58%)" | "11,01" → 2.58 */
function parsearPorcentaje(s) {
	const n = Number(String(s).replace(/\s/g, '').replace(',', '.'));
	return Number.isFinite(n) ? n : null;
}

function numeroMes(nombre) {
	const i = MESES.indexOf(String(nombre).toLowerCase().replace('setiembre', 'septiembre'));
	return i >= 0 ? i + 1 : null;
}

function periodo(nombreMes, anio) {
	const m = numeroMes(nombreMes);
	return m ? `${anio}-${String(m).padStart(2, '0')}` : null;
}

/** Montos "($ 1.234,56)" de un fragmento, en orden. */
function montosEntreParentesis(texto) {
	return [...texto.matchAll(/\(\s*\$\s*([\d.]+(?:,\d{1,2})?)[^)]*\)/g)].map((m) => parsearMonto(m[1]));
}

/** Divide la parte dispositiva en artículos: [{numero, texto}] */
function articulos(texto) {
	const i = texto.search(/\b(RESUELVE|DECRETA)\s*:/i);
	const parte = i >= 0 ? texto.slice(i) : texto;
	// Encabezados de artículo: "ARTÍCULO 3°.-", "ARTICULO 1º -", "Artículo 2° —". Las citas en el
	// cuerpo ("el artículo 9° de la Ley") no llevan guion y no cortan.
	const re = /(?:ART[IÍ]CULO|Art[ií]culo)\s+(\d+)\s*[°º]?\s*(?:BIS|bis)?\s*\.?\s*[-–—]+/g;
	const cortes = [...parte.matchAll(re)];
	return cortes.map((m, k) => ({
		numero: Number(m[1]),
		texto: parte.slice(m.index + m[0].length, k + 1 < cortes.length ? cortes[k + 1].index : undefined).trim(),
	}));
}

/** Filas (id + texto) de una lista de vínculos o de una búsqueda de InfoLeg. */
function parsearListaInfoleg(html) {
	const filas = [];
	const vistos = new Set();
	for (const fila of String(html).split(/<tr/i)) {
		// El href puede traer ";jsessionid=..." antes del "?id="
		const m = fila.match(/verNorma\.do[^"'?]*\?(?:[^"']*&)?id=(\d+)/);
		if (!m || vistos.has(m[1])) continue;
		vistos.add(m[1]);
		const texto = htmlATexto(`<div${fila}`);
		const f = texto.match(/(\d{2})-([a-z]{3})-(\d{4})/i);
		const publicacion = f && MESES_CORTOS[f[2].toLowerCase()]
			? `${f[3]}-${String(MESES_CORTOS[f[2].toLowerCase()]).padStart(2, '0')}-${f[1]}`
			: null;
		filas.push({ id: Number(m[1]), texto, publicacion });
	}
	return filas;
}

/** Clasifica una fila: 'anses' (resolución de haberes/movilidad), 'bono', 'smvm' o null. */
function clasificarFila(fila) {
	const t = fila.texto.toUpperCase();
	if (/RESOLUCI[OÓ]N\s+\d+\s*\/\s*\d+\s+ADMINISTRACION NACIONAL DE LA SEGURIDAD SOCIAL/.test(t)
		&& /HABER|VALOR MOVILIDAD|BASES IMPONIBLES|PBU/.test(t)
		&& !/ASIGNACIONES FAMILIARES|CONJUNTA|CALENDARIO/.test(t)) return 'anses';
	if (/DECRETO/.test(t) && /BONO EXTRAORDINARIO PREVISIONAL|AYUDA ECONOMICA PREVISIONAL|REFUERZO DE INGRESO PREVISIONAL|REFUERZO - OTORGASE|SUBSIDIO EXTRAORDINARIO/.test(t)) return 'bono';
	// Incluye rectificaciones y modificaciones (la Res. 6/2022 adelantó tramos de la 4/2022): si no
	// traen tramos se ignoran sin alertar (ver esModificatoria). "PRESIDENTE" no excluye: la Res. 1/2019
	// ("... DEL ENTONCES PRESIDENTE DEL ...") adelantó el tramo de 03/2019 de la 3/2018
	if (/CONSEJO NAC/.test(t) && /SALARIO M[IÍ]NIMO|SUMAS - FIJANSE|FIJ[EA]SE|RECTIF|MODIFICACION/.test(t) && !/CONVOCA|DESIGNACI|INTEGRACION/.test(t)) return 'smvm';
	return null;
}

const esModificatoria = (fila) => /RECTIF|MODIFICACION/i.test(fila.texto);

function nombreNorma(texto, tipo) {
	const m = texto.match(new RegExp(`${tipo}\\s+(?:E\\s+)?(\\d+)(?:\\s*-\\s*E)?\\s*/\\s*(\\d{4})`, 'i')); // "3-E/2017"
	return m ? `${tipo === 'Decreto' ? 'Decreto' : 'Resolución'} ${m[1]}/${m[2]}` : null;
}

/**
 * Resolución mensual de ANSES → valores del mes.
 * @returns {{norma, mes, movilidadPct, movilidadFuente, haberMinimo, haberMaximo, baseImponibleMinima,
 *   baseImponibleMaxima, pbu, puam, errores: string[]}}
 */
function parsearResolucionAnses(html) {
	const texto = htmlATexto(html);
	const r = {
		norma: nombreNorma(texto, 'Resoluci[oó]n'),
		mes: null, movilidadPct: null, movilidadFuente: null,
		haberMinimo: null, haberMaximo: null, baseImponibleMinima: null, baseImponibleMaxima: null, pbu: null, puam: null,
		errores: [],
	};

	// Mes de vigencia: el más repetido entre las fórmulas de vigencia (la Res. 188/24 tiene un "mayo" errado en el art. 2)
	const candidatos = [
		...texto.matchAll(/(?:vigente|aplicable)s? a partir del mes de (\w+) de (\d{4})/gi),
		...texto.matchAll(/per[ií]odo devengado (\w+) de (\d{4})/gi),
		...texto.matchAll(/valores del mes de (\w+) de (\d{4})/gi),
	].map((m) => periodo(m[1], m[2])).filter(Boolean);
	const conteo = candidatos.reduce((acc, p) => ((acc[p] = (acc[p] || 0) + 1), acc), {});
	r.mes = Object.keys(conteo).sort((a, b) => conteo[b] - conteo[a] || (a < b ? 1 : -1))[0] || null;

	// % de movilidad
	const dnu = texto.match(/incremento previsto para el mes de (\w+) de (\d{4}).{0,300}?274\/24, es de [^(]{0,150}\(\s*(\d+[,.]\d+)\s*%\s*\)/i);
	if (dnu) {
		r.movilidadPct = parsearPorcentaje(dnu[3]);
		r.movilidadFuente = 'incremento DNU 274/24';
		if (!r.mes) r.mes = periodo(dnu[1], dnu[2]);
	} else {
		const m = texto.match(/movilidad a considerar[^%]{0,400}?\(\s*(\d+[,.]\d+)\s*%\s*\)/i)
			|| texto.match(/movilidad a considerar[^%]{0,200}?(\d+,\d+)\s*%/i);
		if (m) {
			r.movilidadPct = parsearPorcentaje(m[1]);
			r.movilidadFuente = 'considerandos';
		}
	}

	// Montos: por contenido del artículo, no por su número
	for (const art of articulos(texto)) {
		const t = art.texto;
		const montos = montosEntreParentesis(t);
		if (!montos.length) continue;
		if (/haber m[ií]nimo garantizado/i.test(t) && r.haberMinimo === null) r.haberMinimo = montos[0];
		else if (/haber m[aá]ximo/i.test(t) && r.haberMaximo === null) r.haberMaximo = montos[0];
		else if (/bases? imponibles? m[ií]nima y m[aá]xima/i.test(t) && montos.length >= 2) {
			r.baseImponibleMinima = montos[0];
			r.baseImponibleMaxima = montos[1];
		} else if (/Prestaci[oó]n B[aá]sica Universal/i.test(t) && r.pbu === null) r.pbu = montos[0];
		else if (/Pensi[oó]n Universal para el Adulto Mayor/i.test(t) && r.puam === null) r.puam = montos[0];
	}

	if (!r.norma) r.errores.push('no se encontró el número de resolución');
	if (!r.mes) r.errores.push('no se encontró el mes de vigencia');
	if (r.haberMinimo === null && r.movilidadPct === null) r.errores.push('sin haber mínimo ni % de movilidad');
	return r;
}

/** Lista de meses en orden, con el año que los sigue: "diciembre de 2022 y enero y febrero de 2023". */
function mesesConAnio(fragmento) {
	const out = [];
	let pendientes = [];
	const re = new RegExp(`\\b(${MESES.join('|')}|setiembre)\\b|\\b(\\d{4})\\b`, 'gi');
	for (const m of fragmento.matchAll(re)) {
		if (m[1]) pendientes.push(m[1]);
		else {
			for (const mes of pendientes) out.push(periodo(mes, m[2]));
			pendientes = [];
		}
	}
	return out.filter(Boolean);
}

/**
 * Decreto de bono / ayuda / refuerzo / subsidio → pagos por mes.
 * @returns {{norma, tipo, pagos: Array<{mes, monto}>, escalonado: boolean, errores: string[]}}
 */
function parsearDecretoBono(html) {
	const texto = htmlATexto(html);
	const r = { norma: nombreNorma(texto, 'Decreto'), tipo: null, pagos: [], escalonado: false, previsional: false, errores: [] };
	const arts = articulos(texto);
	const art1 = (arts.find((a) => a.numero === 1) || {}).texto || '';
	const t1 = art1 || texto;
	r.tipo = /bono extraordinario/i.test(t1) ? 'bono extraordinario previsional'
		: /ayuda econ[oó]mica/i.test(t1) ? 'ayuda económica previsional'
			: /refuerzo/i.test(t1) ? 'refuerzo de ingreso previsional'
				: /subsidio/i.test(t1) ? 'subsidio extraordinario' : null;
	// Los subsidios de la AUH (Dec. 594/19) usan el mismo título: solo cuentan los que alcanzan a jubilados
	const art2 = (arts.find((a) => a.numero === 2) || {}).texto || '';
	r.previsional = /24\.241|PREVISIONAL|SIPA/i.test(art1 + art2);

	// Cada "($ X) ... que se abonará(n) [por única vez] en el/los mes(es) de ..." define montos y meses
	const montos = montosEntreParentesis(t1);
	const idxAbono = t1.search(/abonar[aá]n?\s+(?:por [uú]nica vez\s+)?en/i);
	const meses = mesesConAnio(idxAbono >= 0 ? t1.slice(idxAbono) : t1);
	// "se abonará por única vez en el mes de …": un solo pago (el Dec. 309/20 sigue con la AUH, que cita marzo)
	if (/abonar[aá]n?\s+por [uú]nica vez/i.test(t1) && meses.length && montos.length) r.pagos.push({ mes: meses[0], monto: montos[0] });
	else if (montos.length === meses.length) meses.forEach((mes, i) => r.pagos.push({ mes, monto: montos[i] }));
	else if (montos.length === 1) meses.forEach((mes) => r.pagos.push({ mes, monto: montos[0] }));
	else if (montos.length > 1 && meses.length && montos.length % meses.length === 0) {
		// Varias cláusulas con el mismo monto por mes (Dec. 73/19, 218/21): uno por mes, en orden
		meses.forEach((mes, i) => r.pagos.push({ mes, monto: montos[i] }));
	}
	// Montos escalonados según el haber (refuerzos 2022–23): art. 3 con incisos a) y b)
	const art3 = (arts.find((a) => a.numero === 3) || {}).texto || '';
	r.escalonado = /\ba[.)]\s*(?:PESOS|\(\s*\$)/i.test(art3) && /\bb[.)]\s*(?:PESOS|\(\s*\$)/i.test(art3);
	const resto = arts.filter((a) => a.numero > 1).map((a) => a.texto).join(' ');
	for (const pago of r.pagos) pago.escalones = escalonesBono(resto, pago);

	if (!r.norma) r.errores.push('no se encontró el número de decreto');
	if (!r.pagos.length) r.errores.push(`no se pudieron emparejar montos (${montos.length}) y meses (${meses.length})`);
	return r;
}

/** Primer monto "($ X)" a partir de una posición. */
function montoDesde(texto, i) {
	const m = /\(\s*\$\s*([\d.]+(?:,\d{1,2})?)[^)]*\)/.exec(texto.slice(i));
	return m ? { valor: parsearMonto(m[1]), fin: i + m.index + m[0].length } : null;
}

/**
 * Escalones del bono de un mes: [{hasta, monto}]. Quien cobra hasta `hasta` recibe `monto`; por encima,
 * lo necesario para llegar a `hasta + monto` (así lo redactan todos los decretos desde 2019).
 * `hasta: null` = el haber mínimo del art. 125 de la ley 24.241 vigente en el mes.
 * Si el decreto fija montos distintos por mes (Dec. 282/23), se usa el bloque "correspondiente al mes de …".
 */
function escalonesBono(texto, pago) {
	let bloque = texto;
	const marcas = [...texto.matchAll(new RegExp(`(?:correspondiente al|para el) mes (?:de )?(${MESES.join('|')}|setiembre) de (\\d{4})`, 'gi'))];
	const propias = marcas.filter((m) => periodo(m[1], m[2]) === pago.mes);
	if (propias.length) {
		const ini = propias[0].index;
		const sig = marcas.find((m) => m.index > ini && periodo(m[1], m[2]) !== pago.mes);
		bloque = texto.slice(ini, sig ? sig.index : undefined);
	}
	const umbral = (desde) => {
		const k = bloque.slice(desde).search(/menor o igual a|de hasta|hasta (?=PESOS|\(\s*\$)/i);
		return k >= 0 ? montoDesde(bloque, desde + k) : null;
	};
	const out = [];
	for (const letra of ['a', 'b']) {
		const k = bloque.search(new RegExp(`\\b${letra}[.)]\\s*(?:PESOS|\\(\\s*\\$)`, 'i'));
		if (k < 0) continue;
		const monto = montoDesde(bloque, k);
		const hasta = monto && umbral(monto.fin);
		if (monto && hasta) out.push({ hasta: hasta.valor, monto: monto.valor });
	}
	if (out.length) return out;
	const h = umbral(0);
	// "hasta el haber mínimo" sin importe (Dec. 73/19 y desde el 552/24): el umbral es el mínimo del mes
	const hastaValor = h && h.valor > pago.monto ? h.valor : null;
	return [{ hasta: hastaValor, monto: pago.monto }];
}

/**
 * Resolución del Consejo del Salario → tramos del SMVM mensual (trabajadores mensualizados).
 * Redacciones: "A partir del 1° de agosto de 2013, en PESOS …", "1° de Enero del año 2014", "1° octubre de 2020",
 * "1° abril de 2021 en PESOS", "de PESOS … ($ 1840)". Hasta 2011 el primer tramo no lleva fecha ("Fíjase … un SALARIO
 * MINIMO, VITAL Y MOVIL … en PESOS … ($ 2300) para los trabajadores mensualizados"): rige desde el "mes de <mes>" que
 * nombre la resolución o, si no nombra ninguno, desde el mes siguiente a la publicación (Res. 2/2011, BO 30/08/2011 →
 * 09/2011, como la serie 57.1_SMVMM_0_M_34 de datos.gob.ar).
 * @param {string} html
 * @param {object} [o]
 * @param {string} [o.publicacion] - fecha de publicación 'YYYY-MM-DD' (para el primer tramo sin fecha)
 * @returns {{norma, tramos: Array<{mes, monto}>, errores: string[]}}
 */
function parsearResolucionSmvm(html, { publicacion } = {}) {
	const completo = htmlATexto(html);
	const r = { norma: nombreNorma(completo, 'Resoluci[oó]n'), tramos: [], errores: [] };
	// Solo la parte resolutiva: los considerandos citan propuestas con otros montos (Res. 3-E/2017)
	const k = completo.search(/RESUELVE\s*:/);
	const texto = k >= 0 ? completo.slice(k) : completo;
	const re = /A partir del (?:1\s*[°º]?|primero)(?: de)? (\w+)(?: del?)?(?: año)? (\d{4}),? (?:en|de) (?:la suma de )?PESOS[^($]{0,250}\(\s*\$\s*([\d.]+(?:,\d{1,2})?)/gi;
	for (const m of texto.matchAll(re)) {
		const mes = periodo(m[1], m[2]);
		if (mes && !r.tramos.some((x) => x.mes === mes)) r.tramos.push({ mes, monto: parsearMonto(m[3]) });
	}
	const inicial = /F[ií]jase[^$]{0,600}?SALARIO M[IÍ]NIMO,? VITAL Y M[OÓ]VIL excluidas las asignaciones familiares,[^$]{0,250}?(?:en|de) PESOS[^($]{0,250}\(\s*\$\s*([\d.]+(?:,\d{1,2})?)[^)]*\) para (?:todos )?los trabajadores mensualizados/i.exec(texto);
	if (inicial && !/A partir del (?:1|primero)/i.test(inicial[0])) {
		const anio = (publicacion || '').slice(0, 4);
		const explicito = new RegExp(`haberes correspondientes al mes de (${MESES.join('|')}|setiembre)`, 'i').exec(texto);
		const mes = explicito && anio ? periodo(explicito[1], anio) : publicacion ? mesSiguiente(publicacion.slice(0, 7)) : null;
		if (mes && !r.tramos.some((x) => x.mes === mes)) r.tramos.push({ mes, monto: parsearMonto(inicial[1]) });
		else if (!mes) r.errores.push('tramo sin fecha y sin fecha de publicación');
	}
	// Un tramo de más de 3 meses antes de la publicación es una errata: la Res. 4/2021 dice "1° abril de 2020" por 2021
	// (la 5/2021 la rectifica). Ninguna resolución fijó el SMVM con más retroactividad.
	if (publicacion) r.tramos = r.tramos.filter((t) => t.mes >= mesSiguiente(publicacion.slice(0, 7), -3));
	r.tramos.sort((a, b) => (a.mes < b.mes ? -1 : 1));
	if (!r.norma) r.errores.push('no se encontró el número de resolución');
	if (!r.tramos.length) r.errores.push('no se encontraron tramos "A partir del 1° de <mes>"');
	return r;
}

/**
 * Suma los tramos de una resolución nueva (las normas se recorren por id, de la más vieja a la más nueva).
 * Una resolución que fija el SMVM reemplaza todos los tramos anteriores desde su primer mes (la 11/2021 deja sin
 * efecto los 11/2021 y 02/2022 de la 5/2021). Una modificatoria o rectificatoria solo pisa los meses que nombra (la
 * 1/2019 sustituye el inciso de 03/2019 de la 3/2018 y deja el de 06/2019; la 5/2021 corrige el 06/2021 de la 4/2021).
 */
function reemplazarTramos(previos, nuevos, { modificatoria = false } = {}) {
	const desde = nuevos.reduce((min, t) => (t.mes < min ? t.mes : min), nuevos[0].mes);
	const meses = new Set(nuevos.map((t) => t.mes));
	return [...previos.filter((t) => (modificatoria ? !meses.has(t.mes) : t.mes < desde)), ...nuevos].sort((a, b) => (a.mes < b.mes ? -1 : 1));
}

/** SMVM vigente en un mes: el último tramo con mes ≤ p. */
function smvmVigente(tramos, p) {
	let vigente = null;
	for (const t of tramos) if (t.mes <= p && (!vigente || t.mes >= vigente.mes)) vigente = t;
	return vigente;
}

/**
 * Arma los valores propuestos por mes (función pura).
 * @param {object} p
 * @param {Array} p.resoluciones - parsearResolucionAnses + {id, url}
 * @param {Array} p.bonos - parsearDecretoBono + {id, url}
 * @param {Array} p.smvm - tramos [{mes, monto, norma, url}]
 * @param {Object<string, object>} p.existentes - docs actuales por 'YYYY-MM'
 * @param {string} p.desde - 'YYYY-MM'
 * @param {string} [p.hasta] - por defecto, el último mes con resolución de ANSES
 * @returns {{meses: Array<{mes, propuesto, avisos: string[]}>, avisos: string[]}}
 */
function construirPropuesta({ resoluciones, bonos, smvm, existentes = {}, desde, hasta }) {
	const avisos = [];
	const porMes = {};
	for (const r of resoluciones) {
		if (!r.mes) continue;
		(porMes[r.mes] = porMes[r.mes] || []).push(r);
	}
	const mesesAnses = Object.keys(porMes).sort();
	const fin = hasta || mesesAnses[mesesAnses.length - 1];
	if (!fin) return { meses: [], avisos: ['no hay resoluciones de ANSES con mes de vigencia'] };

	const pagosPorMes = {};
	for (const b of bonos) {
		if (b.previsional === false) continue;
		for (const p of b.pagos) (pagosPorMes[p.mes] = pagosPorMes[p.mes] || []).push({ ...p, norma: b.norma, url: b.url, tipo: b.tipo, escalonado: b.escalonado });
	}
	const tramos = [...smvm].sort((a, b) => (a.mes < b.mes ? -1 : 1));
	const primerBono = Object.keys(pagosPorMes).sort()[0];

	const meses = [];
	let anterior = existentes[mesSiguiente(desde, -1)] || null;
	for (let p = desde; p <= fin; p = mesSiguiente(p)) {
		const res = (porMes[p] || []).sort((a, b) => a.id - b.id);
		const prop = {};
		const avisosMes = [];
		const fuentes = {};
		const unir = (campo) => {
			const v = res.map((r) => r[campo]).filter((x) => x !== null && x !== undefined);
			if (new Set(v).size > 1) avisosMes.push(`${campo}: valores distintos entre ${res.map((r) => r.norma).join(' y ')} (${v.join(' / ')})`);
			return v.length ? v[v.length - 1] : null;
		};

		if (res.length) {
			const min = unir('haberMinimo');
			const max = unir('haberMaximo');
			const pct = unir('movilidadPct');
			const baseMin = unir('baseImponibleMinima');
			const baseMax = unir('baseImponibleMaxima');
			const pbu = unir('pbu');
			const puam = unir('puam');
			if (pct !== null) prop.movilidadGeneral = round(1 + pct / 100, 4);
			else if (min !== null && anterior && anterior.haberMinimoJubilacion > 0) {
				prop.movilidadGeneral = round(min / anterior.haberMinimoJubilacion, 4);
				avisosMes.push(`movilidadGeneral derivada del cociente de haberes mínimos (${prop.movilidadGeneral}); la resolución no trae el %`);
			}
			if (min !== null) prop.haberMinimoJubilacion = prop.haberMinimoPension = min;
			if (max !== null) prop.haberMaximoJubilacion = prop.haberMaximoPension = max;
			if (baseMax !== null) prop.maximoImponible = baseMax;
			if (baseMin !== null) prop.baseImponibleMinima = baseMin;
			if (pbu !== null) prop.pbu = pbu;
			if (puam !== null) prop.puam = puam;
			// Control cruzado: el haber mínimo debe moverse con la movilidad
			if (pct !== null && min !== null && anterior && anterior.haberMinimoJubilacion > 0 && p > INICIO_MOVILIDAD_DNU274) {
				const ratio = min / anterior.haberMinimoJubilacion;
				if (Math.abs(ratio - prop.movilidadGeneral) > 0.0015) {
					avisosMes.push(`haber mínimo / anterior = ${ratio.toFixed(4)} no coincide con la movilidad ${prop.movilidadGeneral}`);
				}
			}
			if (prop.movilidadGeneral && anterior && anterior.topePC > 0) prop.topePC = round(anterior.topePC * prop.movilidadGeneral, 2);
			prop.norma = res.map((r) => r.norma).join(' y ');
			prop.links = res.map((r) => r.url).filter(Boolean);
			fuentes.anses = prop.links;
		} else if (p >= INICIO_MOVILIDAD_DNU274) {
			avisosMes.push('sin resolución de ANSES para el mes');
		}

		// Bono del mes (0 si en el rango cubierto por los decretos no hubo ninguno)
		const pagos = pagosPorMes[p] || [];
		if (pagos.length) {
			prop.bono = round(pagos.reduce((s, x) => s + x.monto, 0), 2);
			prop.bonoNorma = pagos.map((x) => `${x.norma} (${x.tipo}${x.escalonado ? '; escalonado según el haber: monto para quien cobra hasta el haber mínimo' : ''})`).join(' + ');
			fuentes.bono = pagos.map((x) => x.url).filter(Boolean);
			const minimoMes = prop.haberMinimoJubilacion !== undefined ? prop.haberMinimoJubilacion : (existentes[p] || {}).haberMinimoJubilacion;
			prop.bonoEscalones = pagos.flatMap((x) => (x.escalones || [{ hasta: null, monto: x.monto }]).map((e, i) => {
				// El Dec. 268/24 (abril 2024) cita el mínimo de marzo: se toma el del mes, como lo liquidan los peritos
				if (i === 0 && e.hasta && anterior && Math.abs(e.hasta - anterior.haberMinimoJubilacion) < 0.01 && minimoMes > e.hasta) {
					avisosMes.push(`${x.norma}: el umbral ${e.hasta} es el haber mínimo del mes anterior; se toma el mínimo vigente`);
					return { hasta: null, monto: e.monto, norma: x.norma };
				}
				return { hasta: e.hasta, monto: e.monto, norma: x.norma };
			}));
		} else if (primerBono && p >= primerBono) {
			prop.bono = 0;
			prop.bonoNorma = '';
			prop.bonoEscalones = [];
		}

		// SMVM vigente y suplemento 82 %
		const s = smvmVigente(tramos, p);
		if (s) {
			prop.salarioMVM = s.monto;
			prop.normaSMVM = s.mes === p ? s.norma : `${s.norma} (tramo de ${s.mes}, vigente)`;
			fuentes.smvm = [s.url].filter(Boolean);
			const min = prop.haberMinimoJubilacion !== undefined ? prop.haberMinimoJubilacion : (existentes[p] || {}).haberMinimoJubilacion;
			// El suplemento existe desde la ley 27.426 (BO 28/12/2017): antes no se propone
			if (min > 0 && p >= DESDE_SUPLEMENTO_82) prop.suplemento82SMVM = round(Math.max(0, 0.82 * s.monto - min), 2);
		}
		if (Object.keys(fuentes).length) prop.fuentes = fuentes;

		meses.push({ mes: p, propuesto: prop, avisos: avisosMes });
		// El mes siguiente encadena sobre lo propuesto (si se aplica) o lo existente
		anterior = { ...(existentes[p] || {}), ...prop };
	}
	return { meses, avisos };
}

function vacio(v) {
	return v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
}

function iguales(campo, a, b) {
	const tol = CAMPOS[campo];
	if (typeof tol === 'number') return Math.abs(Number(a) - Number(b)) <= tol;
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Diff campo a campo entre lo propuesto y lo existente (función pura).
 * Estados: 'nuevo' (no había valor), 'igual', 'conflicto' (había otro valor; no se pisa sin forzar).
 * Un 0 en un campo numérico cuenta como vacío salvo en suplemento82SMVM y bono, donde 0 es un valor.
 */
function diffMes(existente, propuesto) {
	const cambios = [];
	for (const [campo, nuevo] of Object.entries(propuesto)) {
		if (!(campo in CAMPOS)) continue;
		const actual = existente ? existente[campo] : undefined;
		const ceroEsValor = campo === 'suplemento82SMVM' || campo === 'bono';
		// bono 0 sin norma = "no se conocía decreto" (el decreto puede salir después que la resolución de ANSES)
		const bonoSinNorma = campo === 'bono' && actual === 0 && existente && vacio(existente.bonoNorma);
		const actualVacio = vacio(actual) || bonoSinNorma || (!ceroEsValor && typeof actual === 'number' && actual === 0);
		let estado;
		if (!existente || actualVacio) estado = iguales(campo, actual, nuevo) ? 'igual' : 'nuevo';
		else estado = iguales(campo, actual, nuevo) ? 'igual' : 'conflicto';
		// suplemento82SMVM derivado de un SMVM en 0 (cargado como "sin dato"): se recalcula
		if (estado === 'conflicto' && campo === 'suplemento82SMVM' && existente && !(existente.salarioMVM > 0)) estado = 'nuevo';
		cambios.push({ campo, actual: actual === undefined ? null : actual, propuesto: nuevo, estado });
	}
	return cambios;
}

// ─── Descarga ────────────────────────────────────────────────────────────────

async function descargar(url, { metodo = 'get', datos, intentos = 3 } = {}) {
	let ultimo;
	for (let i = 1; i <= intentos; i++) {
		try {
			const resp = await axios({
				method: metodo, url, data: datos, responseType: 'arraybuffer', timeout: 60000,
				headers: { 'User-Agent': 'Mozilla/5.0 (law-analytics)', ...(datos ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
			});
			return Buffer.from(resp.data).toString('latin1'); // InfoLeg sirve ISO-8859-1
		} catch (e) {
			ultimo = e;
			if (i < intentos) await esperar(2000 * i);
		}
	}
	throw ultimo;
}

const urlNorma = (id) => {
	const base = Math.floor(id / 5000) * 5000;
	return `${INFOLEG}/anexos/${base}-${base + 4999}/${id}/norma.htm`;
};

async function listarVinculos(id) {
	return parsearListaInfoleg(await descargar(`${INFOLEG}/verVinculos.do?modo=2&id=${id}`));
}

/**
 * Búsqueda de InfoLeg por dependencia y rango de publicación. InfoLeg rechaza rangos largos
 * ("Debe realizar una consulta más específica") y fechas "hasta" futuras: se consulta año por año.
 */
async function buscarPorDependencia(dependencia, desde, hasta = moment()) {
	const fin = moment.min(moment(hasta), moment()).startOf('day');
	const filas = [];
	for (let d = moment(desde).startOf('day'); d.isSameOrBefore(fin); d = d.clone().add(1, 'year').startOf('year')) {
		const h = moment.min(d.clone().endOf('year').startOf('day'), fin);
		const datos = new URLSearchParams({
			tipoNorma: '', numero: '', anioSancion: '', texto: '', dependencia: String(dependencia),
			diaPubDesde: d.format('DD'), mesPubDesde: d.format('MM'), anioPubDesde: d.format('YYYY'),
			diaPubHasta: h.format('DD'), mesPubHasta: h.format('MM'), anioPubHasta: h.format('YYYY'),
		}).toString();
		const html = await descargar(`${INFOLEG}/buscarNormas.do`, { metodo: 'post', datos });
		if (/consulta m[aá]s espec[ií]fica/i.test(htmlATexto(html))) {
			throw new Error(`InfoLeg rechazó la búsqueda de la dependencia ${dependencia} (${d.format('YYYY-MM-DD')} a ${h.format('YYYY-MM-DD')}): pide una consulta más específica`);
		}
		filas.push(...parsearListaInfoleg(html));
	}
	return filas;
}

/** Decretos de bono previsional por búsqueda de texto en InfoLeg (tipo Decreto), año por año desde `desde`. */
async function buscarDecretosBono(desde, hasta = moment()) {
	const filas = new Map();
	for (let anio = moment(desde).year(); anio <= moment(hasta).year(); anio++) {
		for (const texto of TEXTOS_BUSQUEDA_BONO) {
			const datos = new URLSearchParams({ tipoNorma: '2', numero: '', anioSancion: String(anio), texto, dependencia: '' }).toString();
			const html = await descargar(`${INFOLEG}/buscarNormas.do`, { metodo: 'post', datos });
			for (const f of parsearListaInfoleg(html)) if (clasificarFila(f) === 'bono') filas.set(f.id, f);
			await esperar(150);
		}
	}
	return [...filas.values()];
}

/**
 * Descarga y parsea todas las normas relevantes publicadas desde `desdePublicacion` ('YYYY-MM-DD').
 * @returns {{resoluciones, bonos, smvm, errores: Array<{id, norma, url, errores}>}}
 */
async function obtenerNormas({ desdePublicacion, desdeSmvm, pausaMs = 300 } = {}) {
	const filas = new Map();
	for (const lista of Object.values(LISTAS_VINCULOS)) {
		for (const f of await listarVinculos(lista)) filas.set(f.id, f);
	}
	const erroresLista = [];
	try {
		for (const f of await buscarDecretosBono(desdePublicacion)) filas.set(f.id, f);
	} catch (e) {
		erroresLista.push({ id: null, url: `${INFOLEG}/buscarNormas.do`, norma: 'búsqueda de decretos de bono', clase: 'bono', errores: [e.message] });
	}
	for (const f of DECRETOS_BONO_FIJOS) if (!filas.has(f.id)) filas.set(f.id, { ...f, publicacion: null });
	let filasSmvm = 0;
	for (const dep of DEPENDENCIAS_CONSEJO_SMVM) {
		try {
			for (const f of await buscarPorDependencia(dep, desdeSmvm || desdePublicacion)) {
				filas.set(f.id, f);
				filasSmvm++;
			}
		} catch (e) {
			erroresLista.push({ id: null, url: `${INFOLEG}/buscarNormas.do`, norma: `búsqueda SMVM (dependencia ${dep})`, clase: 'smvm', errores: [e.message] });
		}
	}
	if (!filasSmvm) erroresLista.push({ id: null, url: `${INFOLEG}/buscarNormas.do`, norma: 'búsqueda SMVM', clase: 'smvm', errores: ['la búsqueda del Consejo del Salario no devolvió normas'] });

	const resoluciones = [];
	const bonos = [];
	let smvm = [];
	const errores = [...erroresLista];
	const candidatas = [...filas.values()]
		.map((f) => ({ ...f, clase: clasificarFila(f) }))
		.filter((f) => f.clase && (!f.publicacion || f.publicacion >= (f.clase === 'smvm' ? (desdeSmvm || desdePublicacion) : desdePublicacion)))
		.sort((a, b) => a.id - b.id);

	for (const f of candidatas) {
		const url = urlNorma(f.id);
		let html;
		try {
			html = await descargar(url);
		} catch (e) {
			errores.push({ id: f.id, url, norma: f.texto.slice(0, 80), errores: [`descarga: ${e.message}`] });
			continue;
		}
		const parser = { anses: parsearResolucionAnses, bono: parsearDecretoBono, smvm: parsearResolucionSmvm }[f.clase];
		const r = { ...parser(html, { publicacion: f.publicacion }), id: f.id, url, publicacion: f.publicacion };
		if (f.clase === 'smvm' && esModificatoria(f) && !r.tramos.length) r.errores = []; // p. ej. Res. 14/2024 (solo vigencia)
		if (f.clase === 'bono' && r.previsional === false) r.errores = []; // subsidios de la AUH: se ignoran
		if (r.errores.length) errores.push({ id: f.id, url, norma: r.norma || f.texto.slice(0, 80), clase: f.clase, mes: r.mes || null, publicacion: f.publicacion, errores: r.errores });
		if (f.clase === 'anses' && r.mes) resoluciones.push(r);
		if (f.clase === 'bono' && r.pagos.length && r.previsional) bonos.push(r);
		if (f.clase === 'smvm' && r.tramos.length) smvm = reemplazarTramos(smvm, r.tramos.map((t) => ({ ...t, norma: r.norma, url })), { modificatoria: esModificatoria(f) });
		await esperar(pausaMs);
	}
	return { resoluciones, bonos, smvm, errores };
}

// ─── Sincronización ──────────────────────────────────────────────────────────

const coleccion = () => mongoose.connection.collection(COLECCION);
const auditoria = () => mongoose.connection.collection(COLECCION_AUDITORIA);

async function leerExistentes(desde, hasta) {
	const docs = await coleccion()
		.find({ fecha: { $gte: fechaDeMes(mesSiguiente(desde, -1)), ...(hasta ? { $lte: fechaDeMes(hasta) } : {}) } })
		.toArray();
	return Object.fromEntries(docs.map((d) => [moment.utc(d.fecha).format('YYYY-MM'), d]));
}

/**
 * @param {object} o
 * @param {string} o.desde - 'YYYY-MM' (por defecto, 3 meses atrás)
 * @param {string} [o.hasta]
 * @param {boolean} [o.aplicar=false] - escribe 'nuevo' (y 'conflicto' solo con forzar)
 * @param {boolean} [o.forzar=false]
 * @param {string} [o.corrida]
 * @param {object} [o.normas] - normas ya obtenidas (tests / reuso)
 */
async function sincronizarDatosPrevisionales({ desde, hasta, aplicar = false, forzar = false, corrida, normas, verbose = false, campos = null } = {}) {
	const CORRIDA = corrida || `datosprev-${moment.utc().format('YYYYMMDD-HHmmss')}`;
	// Sin `desde`: 3 meses atrás, o el mes siguiente al último cargado si quedó un hueco mayor
	let inicio = desde;
	if (!inicio) {
		inicio = moment.utc().subtract(3, 'months').format('YYYY-MM');
		const ultimo = await coleccion().find({}).sort({ fecha: -1 }).limit(1).project({ fecha: 1 }).next();
		if (ultimo) inicio = [inicio, mesSiguiente(moment.utc(ultimo.fecha).format('YYYY-MM'))].sort()[0];
	}
	const log = (...a) => (verbose ? console.log(...a) : logger.info(a.join(' ')));

	const n = normas || await obtenerNormas({
		desdePublicacion: moment.utc(inicio, 'YYYY-MM').subtract(3, 'months').format('YYYY-MM-DD'),
		desdeSmvm: moment.utc(inicio, 'YYYY-MM').subtract(30, 'months').format('YYYY-MM-DD'),
	});
	// Errores de normas de meses anteriores al rango (p. ej. resoluciones de la ley 27.609) no alertan
	n.errores = n.errores.filter((e) => (e.mes ? e.mes >= inicio : !e.publicacion || e.publicacion >= moment.utc(inicio, 'YYYY-MM').subtract(1, 'month').format('YYYY-MM-DD')));
	const existentes = await leerExistentes(inicio, hasta);
	const { meses, avisos } = construirPropuesta({ ...n, existentes, desde: inicio, hasta });

	const resultado = { corrida: CORRIDA, aplicado: aplicar, desde: inicio, normas: n, meses: [], errores: n.errores, avisos, resumen: { nuevos: 0, camposNuevos: 0, conflictos: 0, escritos: 0 } };
	for (const m of meses) {
		const existente = existentes[m.mes];
		const propuesto = campos ? Object.fromEntries(Object.entries(m.propuesto).filter(([c]) => campos.includes(c))) : m.propuesto;
		const cambios = diffMes(existente, propuesto);
		const aEscribir = cambios.filter((c) => c.estado === 'nuevo' || (forzar && c.estado === 'conflicto'));
		resultado.meses.push({ mes: m.mes, docNuevo: !existente, cambios, avisos: m.avisos });
		if (!existente) resultado.resumen.nuevos++;
		resultado.resumen.camposNuevos += cambios.filter((c) => c.estado === 'nuevo').length;
		resultado.resumen.conflictos += cambios.filter((c) => c.estado === 'conflicto').length;

		if (!aplicar || !aEscribir.length) continue;
		if (!existente && propuesto.haberMinimoJubilacion === undefined) continue; // no crear meses sin resolución
		const $set = Object.fromEntries(aEscribir.map((c) => [c.campo, c.propuesto]));
		const fecha = fechaDeMes(m.mes);
		if (!existente) {
			const insert = { fecha, ...DEFAULTS_MES_NUEVO, ...$set };
			await coleccion().insertOne(insert);
			await auditoria().insertOne({ corrida: CORRIDA, fecha, campo: '__documento__', docNuevo: true, creado: new Date() });
		} else {
			await coleccion().updateOne({ _id: existente._id }, { $set });
			await auditoria().insertMany(aEscribir.map((c) => ({ corrida: CORRIDA, fecha, campo: c.campo, valorAnterior: c.actual, valorNuevo: c.propuesto, existia: existente[c.campo] !== undefined, creado: new Date() })));
		}
		resultado.resumen.escritos += aEscribir.length;
		existentes[m.mes] = { ...(existente || {}), ...$set };
	}
	log(`[datosPrevisionales] ${CORRIDA} · ${aplicar ? 'APLICAR' : 'PRUEBA'} · ${meses.length} meses desde ${inicio} · nuevos ${resultado.resumen.nuevos} · campos nuevos ${resultado.resumen.camposNuevos} · conflictos ${resultado.resumen.conflictos} · errores de parseo ${n.errores.length}`);
	return resultado;
}

/** Deshace una corrida aplicada: borra los meses creados y restaura los campos. */
async function revertir(corrida) {
	if (!corrida) throw new Error('revertir: falta la corrida');
	const cambios = await auditoria().find({ corrida, revertido: { $ne: true } }).toArray();
	for (const c of cambios) {
		if (c.campo === '__documento__') await coleccion().deleteOne({ fecha: c.fecha });
		else await coleccion().updateOne({ fecha: c.fecha }, c.existia ? { $set: { [c.campo]: c.valorAnterior } } : { $unset: { [c.campo]: '' } });
		await auditoria().updateOne({ _id: c._id }, { $set: { revertido: true, revertidoEn: new Date() } });
	}
	logger.info(`[datosPrevisionales] Revertidos ${cambios.length} cambios de la corrida ${corrida}`);
	return cambios.length;
}

function textoInforme(r) {
	const lineas = [];
	for (const m of r.meses) {
		const cs = m.cambios.filter((c) => c.estado !== 'igual');
		if (!cs.length && !m.avisos.length) continue;
		lineas.push(`${m.mes}${m.docNuevo ? ' (mes nuevo)' : ''}`);
		for (const c of cs) lineas.push(`  ${c.estado.padEnd(9)} ${c.campo}: ${JSON.stringify(c.actual)} → ${JSON.stringify(c.propuesto)}`);
		for (const a of m.avisos) lineas.push(`  aviso     ${a}`);
	}
	for (const e of r.errores) lineas.push(`ERROR de parseo ${e.norma} (${e.url}): ${e.errores.join('; ')}`);
	return lineas.join('\n');
}

/** Último mes ('YYYY-MM') de una lista de tramos o resoluciones leídas. */
const ultimoMes = (xs) => (xs || []).map((x) => x.mes).filter(Boolean).sort().pop() || null;

/** Clave estable de un error de parseo, para no repetir el aviso en cada corrida. */
const claveError = (e) => `${e.id ?? e.norma}|${(e.errores || []).join(';')}`;

/** Asunto del email: meses nuevos primero (es lo que se espera ver), después el resto. */
function asuntoAviso(r, erroresNuevos) {
	const meses = r.meses.filter((m) => m.docNuevo && m.cambios.some((c) => c.estado === 'nuevo')).map((m) => m.mes);
	const partes = [];
	if (meses.length) partes.push(`mes nuevo ${meses.join(', ')}`);
	partes.push(`${r.resumen.escritos} campos escritos`, `${r.resumen.conflictos} conflictos`, `${r.errores.length} errores de parseo${erroresNuevos ? ` (${erroresNuevos} nuevos)` : ''}`);
	return `[datosprevisionales] ${partes.join(' · ')}`;
}

/**
 * Tarea programada (dos veces por día): sincroniza los últimos 3 meses en modo "solo completar"
 * (escribe meses nuevos y campos vacíos; los conflictos no se pisan) y avisa por email si escribió
 * algo o si aparece un error de parseo que no se avisó antes. Los errores ya avisados y los
 * conflictos persisten entre corridas: solos no disparan el email (quedan en el log). Lo avisado
 * se guarda en `datosprevisionales-sincronizaciones` (documento `_id: 'ultimo-aviso'`, sin campo
 * `corrida`: `revertir` exige una y no lo toca).
 */
async function runTareaSincronizacion({ destinatario = 'soporte@lawanalytics.app' } = {}) {
	try {
		const r = await sincronizarDatosPrevisionales({ aplicar: true });
		if (r.resumen.conflictos) logger.warn(`[datosPrevisionales] ${r.resumen.conflictos} conflictos sin aplicar (ver modo prueba del script)`);
		if (r.errores.length) logger.error(`[datosPrevisionales] ${r.errores.length} normas no parsearon: ${r.errores.map((e) => e.norma).join(', ')}`);
		const claves = r.errores.map(claveError);
		const previo = await auditoria().findOne({ _id: 'ultimo-aviso' });
		const avisadas = new Set(previo?.errores || []);
		const erroresNuevos = claves.filter((k) => !avisadas.has(k)).length;
		if (r.resumen.escritos || erroresNuevos) {
			const { sendEmail } = require('../../aws_ses/aws_sesService');
			const cuerpo = `Corrida ${r.corrida} (desde ${r.desde}).\nPara revertir: node scripts/sincronizarDatosPrevisionales.js --revertir=${r.corrida}\n\n${textoInforme(r)}`;
			try {
				await sendEmail(destinatario, asuntoAviso(r, erroresNuevos), `<pre style="font-family:monospace">${cuerpo.replace(/</g, '&lt;')}</pre>`, cuerpo, []);
			} catch (e) {
				logger.error(`[datosPrevisionales] Error enviando email: ${e.message}`);
			}
		}
		// Se guardan los errores vigentes: uno que se resuelve y vuelve a aparecer se avisa de nuevo
		await auditoria().updateOne({ _id: 'ultimo-aviso' }, { $set: { errores: claves, erroresNormas: r.errores.map((e) => e.norma).slice(0, 10), resumen: r.resumen, smvmHasta: ultimoMes(r.normas.smvm), ansesHasta: ultimoMes(r.normas.resoluciones), ultimaCorrida: r.corrida, actualizado: new Date() } }, { upsert: true });
		return { success: true, corrida: r.corrida, resumen: r.resumen, errores: r.errores.length, erroresNuevos };
	} catch (e) {
		logger.error(`[datosPrevisionales] Error: ${e.message}`);
		return { success: false, error: e.message };
	}
}

module.exports = {
	// puras
	htmlATexto, parsearMonto, parsearListaInfoleg, clasificarFila, parsearResolucionAnses, parsearDecretoBono,
	parsearResolucionSmvm, reemplazarTramos, mesesConAnio, smvmVigente, construirPropuesta, diffMes, textoInforme, urlNorma,
	// red / base
	escalonesBono, obtenerNormas, buscarPorDependencia, buscarDecretosBono, listarVinculos, sincronizarDatosPrevisionales, revertir, runTareaSincronizacion, claveError, asuntoAviso,
	CAMPOS, DEFAULTS_MES_NUEVO,
};
