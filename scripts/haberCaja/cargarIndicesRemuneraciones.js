#!/usr/bin/env node
/**
 * Carga en `indicesmensuales` (una fila por serie y mes) los índices de actualización de remuneraciones del haber de caja
 * (art. 24 inc. a ley 24.241), que hasta ahora vivían solo en server/data/previsional/haber-caja.json y en el fixture del
 * motor, y migra las series ISBIC de la colección histórica `indices`:
 *  - `remRes140`   Res. D.E.-A ANSES 140/95: coeficiente por mes de la remuneración (FAD hasta 2/2009; 1 desde 3/1991).
 *  - `remRes135`   cadena de la Res. ANSES 135/09 y la movilidad (FAD desde 3/2009 con alta hasta 7/2016).
 *  - `remLey27260` Dec. 807/16, Res. ANSES 298/16 y actualización trimestral por RIPTE (alta desde 9/2016).
 *  - `isbicNC`, `isbicC` Salario Básico de la Industria y la Construcción (no calificado / calificado), de `indices`
 *    (haber reajustado; sin validar contra liquidaciones).
 * `remRes135` y `remLey27260` son niveles: el coeficiente es índice(ancla) / índice(mes). `remRes140` ya es el
 * coeficiente del mes. No se migra `indices.indice807`: tiene 108 meses mal (3/2009–2/2018) y lo reemplaza `remLey27260`.
 * Ninguna de estas series es una tasa: no se agregan al catálogo de indicesMensualesService ni a TasasConfig.
 *
 * DRY-RUN POR DEFAULT. `--apply` escribe (upsert por serie + período) y guarda los documentos previos en `--backup`
 * (default ./carga-indices-remuneraciones-<fecha>.json), que se deshace con `--revertir <archivo>`.
 *
 *   node scripts/haberCaja/cargarIndicesRemuneraciones.js
 *   node scripts/haberCaja/cargarIndicesRemuneraciones.js --apply
 *   node scripts/haberCaja/cargarIndicesRemuneraciones.js --revertir carga-indices-remuneraciones-20261018-1200.json
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const opt = (n) => {
	const i = args.indexOf(n);
	return i >= 0 ? args[i + 1] : undefined;
};
const APPLY = args.includes('--apply');
const REVERTIR = opt('--revertir');
const sello = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
const BACKUP = opt('--backup') || `carga-indices-remuneraciones-${sello}.json`;
const ARCHIVO = opt('--archivo') || path.join(__dirname, '../../server/data/previsional/haber-caja.json');
const FUENTE_JSON = 'server/data/previsional/haber-caja.json (investigación del haber de caja, 12/10/2026)';

const DESDE_JSON = [
	{ serie: 'remRes140', campo: 'indicesRemuneraciones.res140', normaDefecto: 'Res. D.E.-A ANSES 140/95' },
	{ serie: 'remRes135', campo: 'indicesRemuneraciones.res135', normaDefecto: 'Res. ANSES 135/09 y movilidad (ley 26.417)' },
	{ serie: 'remLey27260', campo: 'indicesRemuneraciones.ley27260', normaDefecto: 'Dec. 807/16, Res. ANSES 298/16 y RIPTE trimestral' },
];
const DESDE_INDICES = [
	{ serie: 'isbicNC', campo: 'ISBICNC', fuente: 'Colección histórica `indices` (ISBICNC)', norma: 'Salario Básico de la Industria y la Construcción, no calificado' },
	{ serie: 'isbicC', campo: 'ISBICC', fuente: 'Colección histórica `indices` (ISBICC)', norma: 'Salario Básico de la Industria y la Construcción, calificado' },
];

const iguales = (a, b) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-12);

async function main() {
	await mongoose.connect(process.env.URLDB);
	const db = mongoose.connection.db;
	const destino = db.collection('indicesmensuales');

	if (REVERTIR) {
		const { previos, cargados } = JSON.parse(fs.readFileSync(REVERTIR, 'utf8'));
		console.log(`Revertir ${REVERTIR}: ${cargados.length} filas cargadas, ${previos.length} previas a restaurar`);
		if (APPLY) {
			if (cargados.length) await destino.deleteMany({ $or: cargados.map((c) => ({ serie: c.serie, periodo: c.periodo })) });
			if (previos.length) await destino.insertMany(previos.map(({ _id, ...d }) => ({ _id: new mongoose.Types.ObjectId(_id), ...d })));
			console.log('Revertido.');
		} else console.log('DRY-RUN: agregá --apply para revertir.');
		return mongoose.disconnect();
	}

	// filas a cargar: { serie, periodo, valor, fuente, norma }
	const filas = [];
	const { meses } = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8'));
	for (const s of DESDE_JSON) {
		for (const m of meses) {
			const v = m.campos[s.campo];
			if (!(typeof v === 'number' && v > 0)) continue;
			filas.push({ serie: s.serie, periodo: m.periodo, valor: v, fuente: FUENTE_JSON, norma: (m.normas && m.normas[s.campo]) || s.normaDefecto });
		}
	}
	const historicos = await db.collection('indices').find({}, { projection: { fecha: 1, ISBICNC: 1, ISBICC: 1 } }).toArray();
	for (const s of DESDE_INDICES) {
		for (const d of historicos) {
			const v = Number(d[s.campo]);
			if (!(v > 0) || !(d.fecha instanceof Date)) continue;
			filas.push({ serie: s.serie, periodo: d.fecha.toISOString().slice(0, 7), valor: v, fuente: s.fuente, norma: s.norma });
		}
	}

	const series = [...new Set(filas.map((f) => f.serie))];
	const existentes = await destino.find({ serie: { $in: series } }).toArray();
	const porClave = new Map(existentes.map((d) => [`${d.serie}|${d.periodo}`, d]));
	const resumen = {};
	const ops = [];
	const previos = [];
	const ahora = new Date();
	for (const f of filas) {
		const r = (resumen[f.serie] = resumen[f.serie] || { filas: 0, nuevas: 0, iguales: 0, distintas: 0, desde: f.periodo, hasta: f.periodo, ejemplos: [] });
		r.filas++;
		if (f.periodo < r.desde) r.desde = f.periodo;
		if (f.periodo > r.hasta) r.hasta = f.periodo;
		const prev = porClave.get(`${f.serie}|${f.periodo}`);
		if (prev && iguales(prev.valor, f.valor)) { r.iguales++; continue; }
		if (prev) { r.distintas++; previos.push(prev); if (r.ejemplos.length < 3) r.ejemplos.push(`${f.periodo}: ${prev.valor} → ${f.valor}`); } else r.nuevas++;
		ops.push({
			updateOne: {
				filter: { serie: f.serie, periodo: f.periodo },
				update: { $set: { valor: f.valor, tipo: 'nivel', fuente: f.fuente, norma: f.norma, provisorio: false, updatedAt: ahora }, $setOnInsert: { createdAt: ahora } },
				upsert: true,
			},
		});
	}
	for (const [serie, r] of Object.entries(resumen)) console.log(`${serie}: ${r.filas} meses ${r.desde} → ${r.hasta} · nuevas ${r.nuevas} · iguales ${r.iguales} · distintas ${r.distintas}${r.ejemplos.length ? ` (${r.ejemplos.join(' | ')})` : ''}`);
	if (!APPLY) {
		console.log(`DRY-RUN: ${ops.length} filas para escribir. Agregá --apply.`);
		return mongoose.disconnect();
	}
	fs.writeFileSync(BACKUP, JSON.stringify({ previos, cargados: ops.map((o) => o.updateOne.filter) }));
	const res = ops.length ? await destino.bulkWrite(ops, { ordered: false }) : null;
	console.log(`Escritas: ${res ? res.upsertedCount + res.modifiedCount : 0}. Respaldo: ${BACKUP} (node scripts/haberCaja/cargarIndicesRemuneraciones.js --revertir ${BACKUP} --apply)`);
	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
