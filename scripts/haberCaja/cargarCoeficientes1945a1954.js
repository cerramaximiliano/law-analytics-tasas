#!/usr/bin/env node
/**
 * Carga en `indicesmensuales` los índices de actualización de remuneraciones del haber de caja ANTERIORES a 1/1955
 * (el resto lo carga `cargarIndicesRemuneraciones.js` desde haber-caja.json), con la data de
 * server/data/previsional/coeficientes-1945-1954.json:
 *  - `remRes135`   1/1945–12/1954: Res. ANSES 135/09 Anexo I (empalme de las Res. 140/95 y 298/08), extraído del PDF de
 *                  Infoleg y verificado contra 1/1955 (−2,3e-10) y el salto de 2/1956.
 *  - `remRes140`   1/1945–12/1954: derivado con los mismos cocientes que la Res. 135/09 (la Res. 140/95 no está en línea;
 *                  de 1955 a 2004 las dos series tienen los mismos cocientes). Se carga como provisorio.
 *  - `remLey27260` 1/1950–12/1954: Res. ANSES 298/2016, Anexo (valores anuales, copia del CPCE Salta sin contrastar con
 *                  el BO; 1955 coincide con la serie cargada). Se carga como provisorio.
 * Cubren las constancias con remuneraciones anteriores a 1955 que el evaluador manda a insumo («remuneraciones anteriores
 * a la tabla de coeficientes (1/1955)»).
 *
 * DRY-RUN POR DEFAULT. `--apply` escribe (upsert por serie + período) y guarda los documentos previos en `--backup`
 * (default ./carga-coeficientes-1945-1954-<fecha>.json), que se deshace con `--revertir <archivo> --apply`.
 *
 *   node scripts/haberCaja/cargarCoeficientes1945a1954.js
 *   node scripts/haberCaja/cargarCoeficientes1945a1954.js --apply
 *   node scripts/haberCaja/cargarCoeficientes1945a1954.js --revertir carga-coeficientes-1945-1954-20261125-2200.json --apply
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
const BACKUP = opt('--backup') || `carga-coeficientes-1945-1954-${sello}.json`;
const ARCHIVO = opt('--archivo') || path.join(__dirname, '../../server/data/previsional/coeficientes-1945-1954.json');
const SERIES = ['remRes135', 'remRes140', 'remLey27260'];
const HASTA = '1954-12';

const iguales = (a, b) => Math.abs(a - b) <= Math.max(1e-30, Math.abs(b) * 1e-12);

async function main() {
	await mongoose.connect(process.env.URLDB);
	const destino = mongoose.connection.db.collection('indicesmensuales');

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

	const datos = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8'));
	const filas = [];
	for (const serie of SERIES) {
		for (const [periodo, valor] of Object.entries(datos[serie] || {})) {
			if (!/^\d{4}-\d{2}$/.test(periodo) || periodo > HASTA) throw new Error(`${serie}: período fuera de rango ${periodo}`);
			if (!(typeof valor === 'number' && valor > 0)) throw new Error(`${serie} ${periodo}: valor inválido`);
			filas.push({ serie, periodo, valor, norma: datos.normas[serie], fuente: datos.fuentes[serie], provisorio: !!datos.provisorio[serie] });
		}
	}

	// empalme con lo cargado: el primer mes cargado (1955-01) debe existir y no se toca
	for (const serie of SERIES) {
		const primero = await destino.find({ serie }).sort({ periodo: 1 }).limit(1).toArray();
		console.log(`${serie}: hoy desde ${primero[0] ? primero[0].periodo : '—'}`);
		if (!primero[0] || primero[0].periodo !== '1955-01') throw new Error(`${serie}: se esperaba que la serie cargada empiece en 1955-01`);
	}

	const existentes = await destino.find({ serie: { $in: SERIES }, periodo: { $lte: HASTA } }).toArray();
	const porClave = new Map(existentes.map((d) => [`${d.serie}|${d.periodo}`, d]));
	const resumen = {};
	const ops = [];
	const previos = [];
	const ahora = new Date();
	for (const f of filas) {
		const r = (resumen[f.serie] = resumen[f.serie] || { filas: 0, nuevas: 0, iguales: 0, distintas: 0, desde: f.periodo, hasta: f.periodo });
		r.filas++;
		if (f.periodo < r.desde) r.desde = f.periodo;
		if (f.periodo > r.hasta) r.hasta = f.periodo;
		const prev = porClave.get(`${f.serie}|${f.periodo}`);
		if (prev && iguales(prev.valor, f.valor)) { r.iguales++; continue; }
		if (prev) { r.distintas++; previos.push(prev); } else r.nuevas++;
		ops.push({
			updateOne: {
				filter: { serie: f.serie, periodo: f.periodo },
				update: { $set: { valor: f.valor, tipo: 'nivel', fuente: f.fuente, norma: f.norma, provisorio: f.provisorio, updatedAt: ahora }, $setOnInsert: { createdAt: ahora } },
				upsert: true,
			},
		});
	}
	for (const [serie, r] of Object.entries(resumen)) console.log(`${serie}: ${r.filas} meses ${r.desde} → ${r.hasta} · nuevas ${r.nuevas} · iguales ${r.iguales} · distintas ${r.distintas}`);
	if (!APPLY) {
		console.log(`DRY-RUN: ${ops.length} filas para escribir. Agregá --apply.`);
		return mongoose.disconnect();
	}
	fs.writeFileSync(BACKUP, JSON.stringify({ previos, cargados: ops.map((o) => o.updateOne.filter) }));
	const res = ops.length ? await destino.bulkWrite(ops, { ordered: false }) : null;
	console.log(`Escritas: ${res ? res.upsertedCount + res.modifiedCount : 0}. Respaldo: ${BACKUP} (node scripts/haberCaja/cargarCoeficientes1945a1954.js --revertir ${BACKUP} --apply)`);
	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e.message || e);
	process.exit(1);
});
