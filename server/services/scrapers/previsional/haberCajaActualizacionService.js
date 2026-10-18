/**
 * Actualización por fechas clave de los datos del haber de caja que no trae una norma mensual con el importe, a partir de
 * lo que ya cargó el sincronizador de InfoLeg en `datosprevisionales` (haber mínimo y movilidad del mes) y de la serie
 * RIPTE de `indicesmensuales`:
 *  - `rentasAutonomos` (mensual desde 5/2024, DNU 274/2024): renta(m−1) × movilidadGeneral(m), al centavo, por categoría.
 *  - `topePC` (mensual desde 3/2009): 0,208 × haberMinimoJubilacion(m), al centavo (Res. SSS 6/09, regl. art. 24/26 pto. 6).
 *  - `pcPctPorAnio`, `papPctPorAnio` (1,5 %, ley 26.222) y `factorSuplementoAltas` (1 desde 3/2009): los del mes anterior.
 *  - `indicesmensuales.remLey27260` (Dec. 807/16): en marzo, junio, septiembre y diciembre = índice(m−3) × RIPTE(m−3) /
 *    RIPTE(m−6) (verificado exacto en los 12 trimestres de 2023–2026); los demás meses repiten el valor vigente. Queda
 *    provisorio hasta que una resolución de ANSES cita la Disposición de la Subsecretaría de Seguridad Social del trimestre
 *    (`datosprevisionales.disposicionIndices`, lo lee el sincronizador).
 * Solo completa: un valor ya cargado que no coincide con el cálculo queda como conflicto, no se pisa. Cada cambio queda en
 * `datosprevisionales-sincronizaciones` (corrida `haberCaja-auto-<fecha>`) y se revierte con `revertir(corrida)`.
 */
const moment = require('moment');
const mongoose = require('mongoose');
const logger = require('../../../utils/logger');

const DESDE_RENTAS_MENSUALES = '2024-05';
const DESDE_TOPE_PC = '2009-03';
const FACTOR_TOPE_PC = 0.208;
const MESES_TRIMESTRE = new Set(['03', '06', '09', '12']);
const COPIAR_DEL_ANTERIOR = ['pcPctPorAnio', 'papPctPorAnio', 'factorSuplementoAltas'];

const red2 = (x) => Math.round(x * 100) / 100;
const mesDe = (d) => moment.utc(d).format('YYYY-MM');
const sumar = (p, k) => moment.utc(p, 'YYYY-MM').add(k, 'months').format('YYYY-MM');
const igual = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-9;
const vacio = (v) => v === undefined || v === null || (typeof v === 'number' && v === 0);

/**
 * Lo que corresponde a un mes a partir del anterior (pura).
 * @returns {{ campos: Record<string, any>, normas: Record<string, string> }}
 */
function calcularMes(p, doc, anterior) {
	const campos = {};
	const normas = {};
	if (p >= DESDE_TOPE_PC && doc.haberMinimoJubilacion > 0) {
		campos.topePC = red2(FACTOR_TOPE_PC * doc.haberMinimoJubilacion);
		if (anterior?.normas?.topePC) normas.topePC = anterior.normas.topePC;
	}
	if (p >= DESDE_TOPE_PC && anterior) for (const c of COPIAR_DEL_ANTERIOR) if (anterior[c] !== undefined && anterior[c] !== null) {
		campos[c] = anterior[c];
		if (anterior.normas?.[c]) normas[c] = anterior.normas[c];
	}
	if (p >= DESDE_RENTAS_MENSUALES && anterior?.rentasAutonomos && doc.movilidadGeneral > 0) {
		campos.rentasAutonomos = Object.fromEntries(Object.entries(anterior.rentasAutonomos).map(([cat, v]) => [cat, red2(v * doc.movilidadGeneral)]));
		normas.rentasAutonomos = `${doc.norma || 'Resolución ANSES del mes'} (ANSES, movilidad mensual DNU 274/2024: ${+((doc.movilidadGeneral - 1) * 100).toFixed(2)} %)`;
	}
	return { campos, normas };
}

/**
 * Índice remLey27260 de un mes a partir de la serie (pura). Devuelve null si falta RIPTE para un trimestre.
 * @param {Record<string, {valor:number, provisorio?:boolean}>} indice
 * @param {Record<string, {valor:number}>} ripte
 */
function indiceLey27260(p, indice, ripte) {
	if (!MESES_TRIMESTRE.has(p.slice(5, 7))) {
		const prev = indice[sumar(p, -1)];
		return prev ? { valor: prev.valor, provisorio: !!prev.provisorio, norma: prev.norma || 'Dec. 807/16 (valor vigente del trimestre)' } : null;
	}
	const base = indice[sumar(p, -3)];
	const r3 = ripte[sumar(p, -3)];
	const r6 = ripte[sumar(p, -6)];
	if (!base || !r3 || !r6) return null;
	return {
		valor: (base.valor * r3.valor) / r6.valor,
		provisorio: true,
		norma: `Dec. 807/16: índice(${sumar(p, -3)}) × RIPTE(${sumar(p, -3)}) / RIPTE(${sumar(p, -6)}); provisorio hasta la Disposición de la Subsecretaría de Seguridad Social`,
	};
}

/** Primer trimestre (marzo, junio, septiembre, diciembre) posterior a la fecha de la disposición: el que cubre. */
function trimestreDeDisposicion(fecha) {
	let p = sumar(String(fecha).slice(0, 7), 1);
	while (!MESES_TRIMESTRE.has(p.slice(5, 7))) p = sumar(p, 1);
	return p;
}

/**
 * Meses provisorios del índice remLey27260 que confirma una Disposición de la Subsecretaría de Seguridad Social citada por
 * una resolución de ANSES (pura). `disposiciones`: [{ texto: 'Disposición N/AAAA … (AAAA-MM-DD)', citadaEn }].
 * @returns {{ periodo: string, norma: string }[]}
 */
function confirmacionesLey27260(indice, disposiciones) {
	const porTrimestre = {};
	for (const d of disposiciones) {
		const m = /^(.*) \((\d{4}-\d{2}-\d{2})\)$/.exec(d.texto || '');
		if (m) porTrimestre[trimestreDeDisposicion(m[2])] = porTrimestre[trimestreDeDisposicion(m[2])] || { norma: m[1], citadaEn: d.citadaEn };
	}
	const out = [];
	for (const [p, v] of Object.entries(indice)) {
		if (!v || !v.provisorio) continue;
		let q = p;
		while (!MESES_TRIMESTRE.has(q.slice(5, 7))) q = sumar(q, -1);
		const d = porTrimestre[q];
		if (d) out.push({ periodo: p, norma: `${d.norma}${d.citadaEn ? `, citada en la ${d.citadaEn} de ANSES` : ''} (valor: índice(m−3) × RIPTE(m−3) / RIPTE(m−6))` });
	}
	return out.sort((a, b) => (a.periodo < b.periodo ? -1 : 1));
}

/**
 * @param {{ aplicar?: boolean, hasta?: string, db?: import('mongodb').Db }} [o]
 * @returns {Promise<{ corrida: string, escritos: number, cambios: object[], conflictos: object[], pendientes: string[] }>}
 */
async function actualizarHaberCaja({ aplicar = false, hasta = null, db = mongoose.connection.db } = {}) {
	const corrida = `haberCaja-auto-${moment.utc().format('YYYYMMDD-HHmmss')}`;
	const col = db.collection('datosprevisionales');
	const auditoria = db.collection('datosprevisionales-sincronizaciones');
	const im = db.collection('indicesmensuales');
	const docs = await col.find({ fecha: { $gte: moment.utc(sumar(DESDE_TOPE_PC, -1), 'YYYY-MM').toDate() } }).sort({ fecha: 1 }).toArray();
	const ultimo = hasta || (docs.length ? mesDe(docs[docs.length - 1].fecha) : null);
	const cambios = [];
	const conflictos = [];
	const pendientes = [];

	// 1. datosprevisionales mes a mes (cada mes calculado sirve de anterior al siguiente)
	let anterior = null;
	const disposiciones = docs.filter((d) => d.disposicionIndices).map((d) => ({ texto: d.disposicionIndices, citadaEn: d.norma }));
	for (const d of docs) {
		const p = mesDe(d.fecha);
		if (p > ultimo) break;
		const actual = { ...d, normas: { ...(d.normas || {}) } };
		if (anterior && p >= DESDE_TOPE_PC) {
			const { campos, normas } = calcularMes(p, d, anterior);
			const $set = {};
			for (const [campo, valor] of Object.entries(campos)) {
				const previo = d[campo];
				// lo que solo se arrastra del mes anterior completa vacíos: un valor cargado distinto viene de una norma
				if (COPIAR_DEL_ANTERIOR.includes(campo) && !vacio(previo)) continue;
				const coincide = campo === 'rentasAutonomos' ? previo && Object.entries(valor).every(([k, v]) => igual(previo[k], v)) : igual(previo, valor);
				if (coincide) continue;
				if (!vacio(previo)) {
					conflictos.push({ periodo: p, campo, cargado: previo, calculado: valor });
					continue;
				}
				$set[campo] = valor;
				actual[campo] = valor;
				if (normas[campo]) { $set[`normas.${campo}`] = normas[campo]; actual.normas[campo] = normas[campo]; }
				cambios.push({ periodo: p, campo, valor });
			}
			if (aplicar && Object.keys($set).length) {
				await col.updateOne({ _id: d._id }, { $set });
				const previoDe = (campo) => (campo.startsWith('normas.') ? d.normas?.[campo.slice(7)] : d[campo]);
				await auditoria.insertMany(Object.keys($set).map((campo) => ({ corrida, fecha: d.fecha, campo, valorAnterior: previoDe(campo) ?? null, valorNuevo: $set[campo], existia: previoDe(campo) !== undefined, creado: new Date() })));
			}
		}
		anterior = actual;
	}

	// 2. índice de la ley 27.260 hasta el último mes con datos
	const filas = await im.find({ serie: { $in: ['remLey27260', 'ripte'] } }).toArray();
	const indice = {};
	const ripte = {};
	for (const f of filas) (f.serie === 'ripte' ? ripte : indice)[f.periodo] = f;
	const ultimoIndice = Object.keys(indice).sort().pop();
	if (ultimoIndice && ultimo) {
		for (let p = sumar(ultimoIndice, 1); p <= ultimo; p = sumar(p, 1)) {
			const v = indiceLey27260(p, indice, ripte);
			if (!v) { pendientes.push(`remLey27260 ${p}: falta RIPTE de ${sumar(p, -6)} o ${sumar(p, -3)}`); break; }
			indice[p] = v;
			cambios.push({ periodo: p, campo: 'indicesmensuales.remLey27260', valor: v.valor, provisorio: v.provisorio });
			if (aplicar) {
				const ahora = new Date();
				await im.updateOne({ serie: 'remLey27260', periodo: p }, { $set: { valor: v.valor, tipo: 'nivel', fuente: 'haberCajaActualizacionService (RIPTE de indicesmensuales)', norma: v.norma, provisorio: v.provisorio, updatedAt: ahora }, $setOnInsert: { createdAt: ahora } }, { upsert: true });
				await auditoria.insertOne({ corrida, fecha: moment.utc(p, 'YYYY-MM').toDate(), campo: 'indicesmensuales.remLey27260', valorAnterior: null, valorNuevo: v.valor, existia: false, creado: ahora });
			}
		}
	}
	// 3. trimestres provisorios confirmados por la Disposición SSS que citan las resoluciones de ANSES
	for (const c of confirmacionesLey27260(indice, disposiciones)) {
		cambios.push({ periodo: c.periodo, campo: 'indicesmensuales.remLey27260', valor: indice[c.periodo].valor, confirmado: c.norma });
		if (aplicar) {
			const ahora = new Date();
			await im.updateOne({ serie: 'remLey27260', periodo: c.periodo }, { $set: { provisorio: false, norma: c.norma, updatedAt: ahora } });
			await auditoria.insertOne({ corrida, fecha: moment.utc(c.periodo, 'YYYY-MM').toDate(), campo: 'indicesmensuales.remLey27260.confirmacion', valorAnterior: { provisorio: true, norma: indice[c.periodo].norma || null }, valorNuevo: { provisorio: false, norma: c.norma }, existia: true, creado: ahora });
		}
	}
	const escritos = aplicar ? cambios.length : 0;
	if (cambios.length || conflictos.length || pendientes.length) logger.info(`[haberCaja] ${aplicar ? 'aplicado' : 'prueba'} ${corrida}: ${cambios.length} cambios, ${conflictos.length} conflictos, ${pendientes.length} pendientes`);
	return { corrida, escritos, cambios, conflictos, pendientes };
}

/** Deshace una corrida (datosprevisionales e indicesmensuales.remLey27260). */
async function revertir(corrida, { db = mongoose.connection.db } = {}) {
	if (!corrida) throw new Error('revertir: falta la corrida');
	const auditoria = db.collection('datosprevisionales-sincronizaciones');
	const cambios = await auditoria.find({ corrida, revertido: { $ne: true } }).toArray();
	for (const c of cambios) {
		if (c.campo === 'indicesmensuales.remLey27260') await db.collection('indicesmensuales').deleteOne({ serie: 'remLey27260', periodo: mesDe(c.fecha) });
		else if (c.campo === 'indicesmensuales.remLey27260.confirmacion') await db.collection('indicesmensuales').updateOne({ serie: 'remLey27260', periodo: mesDe(c.fecha) }, { $set: { provisorio: true, norma: c.valorAnterior?.norma ?? null } });
		else await db.collection('datosprevisionales').updateOne({ fecha: c.fecha }, c.existia ? { $set: { [c.campo]: c.valorAnterior } } : { $unset: { [c.campo]: '' } });
		await auditoria.updateOne({ _id: c._id }, { $set: { revertido: true, revertidoEn: new Date() } });
	}
	return cambios.length;
}

/** Texto para el email del sincronizador. */
function textoHaberCaja(r) {
	const l = [];
	for (const c of r.cambios) l.push(`  ${c.periodo} ${c.campo}: ${typeof c.valor === 'object' ? `${Object.keys(c.valor).length} categorías` : c.valor}${c.provisorio ? ' (provisorio)' : ''}${c.confirmado ? ` (confirmado: ${c.confirmado})` : ''}`);
	for (const c of r.conflictos) l.push(`  CONFLICTO ${c.periodo} ${c.campo}: cargado ${JSON.stringify(c.cargado)} · calculado ${JSON.stringify(c.calculado)}`);
	for (const p of r.pendientes) l.push(`  PENDIENTE ${p}`);
	return l.length ? `Haber de caja (corrida ${r.corrida}):\n${l.join('\n')}` : '';
}

module.exports = { calcularMes, indiceLey27260, trimestreDeDisposicion, confirmacionesLey27260, actualizarHaberCaja, revertir, textoHaberCaja, DESDE_RENTAS_MENSUALES };
