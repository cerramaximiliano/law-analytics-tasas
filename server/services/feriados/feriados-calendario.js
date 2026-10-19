// COPIA de pjn-models/src/utils/feriados-calendario.js (v1.66.0). No editar acá: cambiar en pjn-models y recopiar.
'use strict';

/**
 * feriados-calendario.js — Generación anual y control de cobertura del
 * calendario de días inhábiles judiciales (colección `feriados-judiciales`).
 *
 * Lo comparten:
 *   - el control diario y la generación automática del año siguiente
 *     (repo admin, `law-analytics-tasas`, crons con aviso por correo);
 *   - el botón "Generar año" y las alertas de la admin (pjn-api);
 *   - plazos-worker, que no entrega plazos fuera de la cobertura.
 *
 * Reglas de generación de un año (las mismas del seed original,
 * scripts/maintenance/seed-feriados-judiciales.js):
 *   - inamovibles de la ley 27.399, carnaval y Viernes Santo (Pascua de Meeus)
 *     y Jueves Santo (no laborable) → verificado: true;
 *   - feria de enero (1–31/1) → verificado: true;
 *   - trasladables (17/6, 17/8, 12/10, 20/11) con la regla del art. 6
 *     → verificado: false (el decreto anual puede alterarlo);
 *   - feria de julio ESTIMADA: las dos semanas que terminan el último viernes
 *     de julio (2026: 20–31/7) → verificado: false (la fija la acordada CSJN);
 *   - los puentes turísticos no se estiman: se cargan a mano con el decreto.
 *
 * generarAnio solo INSERTA los días que faltan: nunca modifica ni borra uno
 * existente (las correcciones manuales de la admin sobreviven).
 *
 * Funciones sobre la colección: reciben la Collection del driver nativo (o un
 * modelo Mongoose, se usa su .collection), así sirven para cualquier base.
 */

const { addDays, dow } = require('./dias-habiles');

const COLECCION = 'feriados-judiciales';

// Pascua (algoritmo de Meeus/Jones/Butcher) → 'YYYY-MM-DD'.
function pascua(year) {
	const a = year % 19;
	const b = Math.floor(year / 100);
	const c = year % 100;
	const d = Math.floor(b / 4);
	const e = b % 4;
	const f = Math.floor((b + 8) / 25);
	const g = Math.floor((b - f + 1) / 3);
	const h = (19 * a + b - d - g + 15) % 30;
	const i = Math.floor(c / 4);
	const k = c % 4;
	const l = (32 + 2 * e + 2 * i - h - k) % 7;
	const m = Math.floor((a + 11 * h + 22 * l) / 451);
	const month = Math.floor((h + l - 7 * m + 114) / 31);
	const day = ((h + l - 7 * m + 114) % 31) + 1;
	return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Traslado del art. 6 ley 27.399: mar/mié → lunes anterior; jue/vie → lunes
// siguiente; sáb/dom/lun → queda donde cae.
function trasladar(day) {
	const d = dow(day);
	if (d === 2) return addDays(day, -1);
	if (d === 3) return addDays(day, -2);
	if (d === 4) return addDays(day, 4);
	if (d === 5) return addDays(day, 3);
	return day;
}

// Feria de julio estimada: del lunes de la penúltima semana al último viernes.
function feriaJulioEstimada(year) {
	let hasta = `${year}-07-31`;
	while (dow(hasta) !== 5) hasta = addDays(hasta, -1);
	return [addDays(hasta, -11), hasta];
}

/**
 * Días inhábiles de un año, sin tocar la base. Primer escritor gana: los
 * feriados tienen precedencia sobre los días de feria.
 * @param {number} year
 * @param {Object} [opts]
 * @param {[string,string]} [opts.feriaJulio] — rango real si ya se conoce (acordada)
 * @returns {Array<{fecha, ambito, tipo, descripcion, fuente, verificado, notas}>}
 */
function entradasDelAnio(year, { feriaJulio = null } = {}) {
	const y = Number(year);
	if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new Error(`Año inválido: ${year}`);
	const map = new Map();
	const put = (fecha, entry) => {
		if (!map.has(fecha)) map.set(fecha, { fecha, ambito: 'nacional', notas: '', ...entry });
	};
	const pas = pascua(y);

	const inamovibles = [
		[`${y}-01-01`, 'Año Nuevo'],
		[addDays(pas, -48), 'Carnaval (lunes)'],
		[addDays(pas, -47), 'Carnaval (martes)'],
		[`${y}-03-24`, 'Día Nacional de la Memoria por la Verdad y la Justicia'],
		[`${y}-04-02`, 'Día del Veterano y de los Caídos en la Guerra de Malvinas'],
		[addDays(pas, -2), 'Viernes Santo'],
		[`${y}-05-01`, 'Día del Trabajador'],
		[`${y}-05-25`, 'Día de la Revolución de Mayo'],
		[`${y}-06-20`, 'Paso a la Inmortalidad del Gral. Manuel Belgrano'],
		[`${y}-07-09`, 'Día de la Independencia'],
		[`${y}-12-08`, 'Inmaculada Concepción de María'],
		[`${y}-12-25`, 'Navidad'],
	];
	for (const [fecha, descripcion] of inamovibles) {
		put(fecha, { tipo: 'feriado_nacional', descripcion, fuente: 'Ley 27.399', verificado: true });
	}
	put(addDays(pas, -3), {
		tipo: 'dia_no_laborable',
		descripcion: 'Jueves Santo',
		fuente: 'Ley 27.399 art. 7',
		verificado: true,
		notas: 'Día no laborable — sin actividad tribunalicia (inhábil a los fines procesales).',
	});
	const trasladables = [
		[`${y}-06-17`, 'Paso a la Inmortalidad del Gral. Martín Miguel de Güemes'],
		[`${y}-08-17`, 'Paso a la Inmortalidad del Gral. José de San Martín'],
		[`${y}-10-12`, 'Día del Respeto a la Diversidad Cultural'],
		[`${y}-11-20`, 'Día de la Soberanía Nacional'],
	];
	for (const [nominal, descripcion] of trasladables) {
		const efectivo = trasladar(nominal);
		put(efectivo, {
			tipo: 'feriado_trasladable',
			descripcion: `${descripcion}${efectivo !== nominal ? ` (trasladado del ${nominal})` : ''}`,
			fuente: 'Ley 27.399 art. 6',
			verificado: false,
			notas: 'Traslado computado por la regla general — CONFIRMAR contra el decreto anual de feriados.',
		});
	}
	for (let d = `${y}-01-01`; d <= `${y}-01-31`; d = addDays(d, 1)) {
		put(d, { tipo: 'feria_enero', descripcion: 'Feria judicial de verano', fuente: 'RJN — feria de enero', verificado: true });
	}
	const [desde, hasta] = feriaJulio || feriaJulioEstimada(y);
	for (let d = desde; d <= hasta; d = addDays(d, 1)) {
		put(d, {
			tipo: 'feria_julio',
			descripcion: `Feria judicial de invierno ${y}`,
			fuente: 'Acordada CSJN (anual)',
			verificado: !!feriaJulio,
			notas: feriaJulio ? '' : 'Rango ESTIMADO — confirmar contra la acordada de feria de la CSJN del año.',
		});
	}
	return [...map.values()].sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
}

const col = (c) => (c && c.collection && typeof c.collection.find === 'function' ? c.collection : c);
const makeId = (fecha, ambito = 'nacional') => `${fecha}|${ambito}`;

/**
 * Carga los días que faltan de un año. No modifica ni borra los existentes.
 * @param {Collection|Model} coleccion
 * @param {number} year
 * @param {Object} [opts] — { aplicar = false, feriaJulio }
 * @returns {Promise<{anio, total, agregan: string[], existentes: number, sinVerificar: number, aplicado}>}
 */
async function generarAnio(coleccion, year, { aplicar = false, feriaJulio = null } = {}) {
	const c = col(coleccion);
	const entradas = entradasDelAnio(year, { feriaJulio });
	const ids = entradas.map((e) => makeId(e.fecha, e.ambito));
	const ya = new Set((await c.find({ _id: { $in: ids } }, { projection: { _id: 1 } }).toArray()).map((d) => d._id));
	const nuevas = entradas.filter((e) => !ya.has(makeId(e.fecha, e.ambito)));
	if (aplicar && nuevas.length) {
		const now = new Date();
		await c.bulkWrite(
			nuevas.map((e) => ({
				updateOne: {
					filter: { _id: makeId(e.fecha, e.ambito) },
					update: { $setOnInsert: { ...e, habilitado: true, createdAt: now, updatedAt: now } },
					upsert: true,
				},
			})),
			{ ordered: false }
		);
	}
	return {
		anio: Number(year),
		total: entradas.length,
		agregan: nuevas.map((e) => e.fecha),
		existentes: entradas.length - nuevas.length,
		sinVerificar: nuevas.filter((e) => !e.verificado).length,
		aplicado: !!aplicar,
	};
}

/**
 * Hasta qué fecha llega el calendario: último año con su Navidad cargada
 * (último inamovible) y su feria de enero completa. Antes de esa fecha los
 * vencimientos son confiables; después, el cálculo no conoce los inhábiles.
 * @returns {Promise<{hasta: string|null, ultimoAnio: number|null, diasRestantes: number|null, aniosIncompletos: number[]}>}
 */
async function cobertura(coleccion, { ambito = 'nacional', hoy = new Date() } = {}) {
	const c = col(coleccion);
	const filas = await c.aggregate([
		// Enero completo (feria; el 1.º queda como Año Nuevo) y Navidad.
		{ $match: { ambito, habilitado: { $ne: false }, fecha: { $regex: '-(01-\\d\\d|12-25)$' } } },
		{ $group: { _id: { $substr: ['$fecha', 0, 4] }, enero: { $sum: { $cond: [{ $eq: [{ $substr: ['$fecha', 5, 2] }, '01'] }, 1, 0] } }, navidad: { $sum: { $cond: [{ $eq: [{ $substr: ['$fecha', 5, 5] }, '12-25'] }, 1, 0] } } } },
	]).toArray();
	const completos = new Set(filas.filter((f) => f.enero >= 31 && f.navidad >= 1).map((f) => Number(f._id)));
	const hoyY = Number(new Date(hoy.getTime() - 3 * 3600e3).toISOString().slice(0, 4));
	// Cobertura continua desde el año actual.
	let ultimoAnio = null;
	for (let y = hoyY; completos.has(y); y++) ultimoAnio = y;
	const hoyDia = new Date(hoy.getTime() - 3 * 3600e3).toISOString().slice(0, 10);
	const hasta = ultimoAnio ? `${ultimoAnio}-12-31` : null;
	const diasRestantes = hasta ? Math.round((Date.parse(hasta) - Date.parse(hoyDia)) / 864e5) : null;
	const aniosIncompletos = filas.map((f) => Number(f._id)).filter((y) => y >= hoyY && !completos.has(y)).sort();
	return { hasta, ultimoAnio, diasRestantes, aniosIncompletos };
}

/**
 * Días inhábiles habilitados SIN verificar entre hoy y hoy + N días.
 * @returns {Promise<Array<{fecha, tipo, descripcion}>>}
 */
async function sinVerificarProximos(coleccion, { dias = 90, ambito = 'nacional', hoy = new Date() } = {}) {
	const c = col(coleccion);
	const desde = new Date(hoy.getTime() - 3 * 3600e3).toISOString().slice(0, 10);
	const hasta = addDays(desde, dias);
	return c.find(
		{ ambito, habilitado: { $ne: false }, verificado: { $ne: true }, fecha: { $gte: desde, $lte: hasta } },
		{ projection: { _id: 0, fecha: 1, tipo: 1, descripcion: 1 } }
	).sort({ fecha: 1 }).toArray();
}

module.exports = { COLECCION, pascua, trasladar, feriaJulioEstimada, entradasDelAnio, generarAnio, cobertura, sinVerificarProximos };
