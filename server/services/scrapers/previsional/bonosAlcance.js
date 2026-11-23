'use strict';
/**
 * Alcance de los bonos, subsidios y suplementos previsionales que no integran el haber.
 *
 * Cada escalón de `datosprevisionales.bonoEscalones` dice, además de `hasta` / `monto` / `norma`:
 *   - `alcance`: cómo se paga según el haber (lo usa el motor del hub, previsionalService.bonoDelMes)
 *       umbral_decreciente  `monto` hasta `hasta`; por encima, lo necesario para llegar a hasta + monto
 *       umbral              `monto` entero hasta `hasta`; por encima, nada
 *       escalonado          como `umbral`, con varios escalones de la norma (rige el del tramo del haber)
 *       solo_minimo         `monto` solo a quien cobra el haber mínimo (`hasta: null`)
 *       todos               `monto` a todos, con techo en `hasta` (null = haber máximo del mes)
 *   - `base`: contra qué se mide el umbral — `unico_beneficio` (con dos prestaciones no se cobra),
 *       `suma_prestaciones` (la suma de todas las del titular), `cada_prestacion` (ninguna supera el umbral)
 *   - `universo`: `sipa` (prestaciones de la ley 24.241 y regímenes anteriores) o `movilidad_art32`
 *       (solo las que se mueven por el art. 32 de la ley 24.241: quedan afuera los regímenes con movilidad propia)
 *   - `excluye`, `normaModificatoria`, `url`
 * `base`, `universo` y `excluye` son informativos por ahora: el motor compara con el haber de la prestación liquidada.
 *
 * Todo lo que sigue sale del texto oficial en InfoLeg (id entre paréntesis), leído el 23/11/2026.
 */

const INFOLEG = 'https://servicios.infoleg.gob.ar/infolegInternet/verNorma.do?id=';
const POLICIA = 'policia_penitenciario_provincial_transferido';
const ALCANCES = ['umbral_decreciente', 'umbral', 'escalonado', 'solo_minimo', 'todos'];

/**
 * Pagos únicos de 2004 a 2016. No estaban cargados: el sincronizador arranca en 11/2019.
 * `bono` es el monto máximo del mes (el que cobra quien percibe el haber mínimo).
 */
const PAGOS_UNICOS = [
	{
		// Dec. 1670/2004 (101520). Art. 1: "subsidio equivalente a la suma de PESOS DOSCIENTOS ($ 200) a los beneficiarios de
		// las prestaciones previsionales a cargo del Régimen Previsional Público … cuyos haberes mensuales no superen en total
		// el haber máximo establecido por el artículo 9º, inciso 3, de la Ley Nº 24.463". Art. 3: "por única vez,
		// simultáneamente con los haberes correspondientes al mes de diciembre de 2004 y no será susceptible de descuento
		// alguno ni computable para ningún otro concepto".
		mes: '2004-12', norma: 'Decreto 1670/2004', id: 101520, tipo: 'subsidio', bono: 200,
		escalones: [{ hasta: null, monto: 200, alcance: 'todos', base: 'suma_prestaciones', universo: 'sipa' }],
	},
	{
		// Dec. 2300/2008 (148940). Art. 1: "suma fija por única vez equivalente a PESOS DOSCIENTOS ($ 200) … cuyos haberes
		// mensuales no superen en total el haber máximo vigente a la fecha del presente decreto … deben computarse la
		// totalidad de los beneficios". Art. 2: no alcanza a policía y servicio penitenciario provinciales transferidos ni a
		// las PNC. Art. 4: "en el mes de diciembre de 2008".
		mes: '2008-12', norma: 'Decreto 2300/2008', id: 148940, tipo: 'suma fija', bono: 200,
		escalones: [{ hasta: null, monto: 200, alcance: 'todos', base: 'suma_prestaciones', universo: 'sipa', excluye: [POLICIA] }],
	},
	{
		// Dec. 1879/2009 (161043). Art. 1: "$ 350 … a los que perciben un haber mensual de hasta $ 827,23; de $ 325 para los
		// que perciben hasta $ 1.000; de $ 300 … hasta $ 1.100; de $ 275 … hasta $ 1.200; de $ 250 … hasta $ 1.300; de $ 225 …
		// hasta $ 1.400 y de $ 200 para los que perciben hasta $ 1.500. Quienes perciban un haber superior a esta última
		// cifra, no gozarán del subsidio". Art. 4: $ 200 a quienes tengan más de una prestación, si ninguna supera el máximo
		// del art. 1 (no modelado). Art. 6: "en el mes de diciembre de 2009".
		mes: '2009-12', norma: 'Decreto 1879/2009', id: 161043, tipo: 'subsidio extraordinario', bono: 350,
		escalones: [[827.23, 350], [1000, 325], [1100, 300], [1200, 275], [1300, 250], [1400, 225], [1500, 200]]
			.map(([hasta, monto]) => ({ hasta, monto, alcance: 'escalonado', base: 'cada_prestacion', universo: 'sipa', excluye: [POLICIA] })),
	},
	{
		// Dec. 1856/2010 (175980). Art. 1: "suplemento especial por única vez … equivalente a PESOS QUINIENTOS ($ 500) el cual
		// se abonará a los titulares de beneficios cuyo monto fuese de hasta PESOS UN MIL QUINIENTOS ($ 1500) mensuales.
		// Quienes perciban un haber superior a esta última cifra, no gozarán del mencionado suplemento". Art. 4: $ 500 a
		// quienes tengan hasta dos prestaciones si ninguna supera ese monto. Art. 6: "en el mes de diciembre de 2010"; para
		// el cálculo no se incluye la bonificación por zona austral.
		mes: '2010-12', norma: 'Decreto 1856/2010', id: 175980, tipo: 'suplemento especial', bono: 500,
		escalones: [{ hasta: 1500, monto: 500, alcance: 'umbral', base: 'cada_prestacion', universo: 'sipa', excluye: [POLICIA] }],
	},
	{
		// Dec. 253/2015 (257351). Art. 2: "el subsidio se abonará a los titulares que perciben el haber mínimo jubilatorio
		// vigente. En el caso de personas con más de un beneficio previsional, se considerará … la suma de la totalidad de las
		// prestaciones que percibe. Quienes reciban sumas superiores al haber mínimo vigente … quedan excluidos". Art. 6:
		// "liquidado por única vez, en el mes de diciembre de 2015".
		mes: '2015-12', norma: 'Decreto 253/2015', id: 257351, tipo: 'subsidio extraordinario', bono: 400,
		escalones: [{ hasta: null, monto: 400, alcance: 'solo_minimo', base: 'suma_prestaciones', universo: 'sipa', excluye: [POLICIA] }],
	},
	{
		// Dec. 591/2016 (260488). Art. 2: igual que el 253/15 (solo haber mínimo, suma de prestaciones). Art. 6: "liquidado
		// por única vez, en el mes de abril del 2016".
		mes: '2016-04', norma: 'Decreto 591/2016', id: 260488, tipo: 'subsidio extraordinario', bono: 500,
		escalones: [{ hasta: null, monto: 500, alcance: 'solo_minimo', base: 'suma_prestaciones', universo: 'sipa', excluye: [POLICIA] }],
	},
	{
		// Dec. 1252/2016 (268874). Art. 1: "Subsidio Extraordinario de PESOS UN MIL ($ 1.000,00) a los titulares … que
		// perciban hasta un haber mínimo legal, vigente al mes de diciembre de 2016". Art. 2: "para el mensual diciembre de
		// 2016, ningún titular de una prestación contributiva del SIPA podrá percibir, en carácter de haber bruto mensual,
		// una suma menor a $ 6.661,16" (= mínimo 5.661,16 + 1.000): los dos artículos juntos dan el decreciente hasta
		// mínimo + monto. Art. 4: suma de todas las prestaciones.
		mes: '2016-12', norma: 'Decreto 1252/2016', id: 268874, tipo: 'subsidio extraordinario', bono: 1000,
		escalones: [{ hasta: null, monto: 1000, alcance: 'umbral_decreciente', base: 'suma_prestaciones', universo: 'sipa', excluye: [POLICIA] }],
	},
];

/**
 * Base, universo y exclusión de un decreto de bono a partir de su texto (lo usa el sincronizador para los decretos
 * nuevos). La forma es siempre `umbral_decreciente`: es la que lee `escalonesBono` y la de todos los decretos desde
 * el 73/19 ("hasta alcanzar…", "igual a la cantidad necesaria hasta alcanzar…").
 */
function clasificarDecretoBono(texto) {
	const t = String(texto || '').replace(/\s+/g, ' ');
	const r = { alcance: 'umbral_decreciente' };
	if (/perciban un [uú]nico beneficio/i.test(t)) r.base = 'unico_beneficio';
	else if (/suma de los haberes de todas|suma de la totalidad de/i.test(t)) r.base = 'suma_prestaciones';
	r.universo = /movilidad se rija por el art[íi]culo 32/i.test(t) ? 'movilidad_art32' : 'sipa';
	if (/(?:Polic[ií]a|Fuerzas Policiales|Policiales)[^.]{0,200}(?:Penitenciari)/i.test(t)) r.excluye = [POLICIA];
	return r;
}

/**
 * Clasificación de los decretos ya cargados (12/2019 en adelante), por período. Verificada contra el texto de los 48:
 *  - Dec. 73/2019 (333593) y 309/2020 (335821): "a quienes perciban un único beneficio"; excluyen policía y
 *    penitenciarios provinciales transferidos.
 *  - Dec. 218/2021 (348231) a 215/2022 (363925): "por la suma de los haberes de todas sus prestaciones vigentes";
 *    misma exclusión.
 *  - Dec. 532/2022 (370319) en adelante: suma de prestaciones y solo prestaciones "cuya movilidad se rija por el
 *    artículo 32 de la Ley N° 24.241" (más Dec. 160/05, PUAM y PNC).
 */
function clasificacionVigente(mes) {
	if (mes < '2019-12') return null;
	if (mes <= '2020-12') return { alcance: 'umbral_decreciente', base: 'unico_beneficio', universo: 'sipa', excluye: [POLICIA] };
	if (mes <= '2022-08') return { alcance: 'umbral_decreciente', base: 'suma_prestaciones', universo: 'sipa', excluye: [POLICIA] };
	return { alcance: 'umbral_decreciente', base: 'suma_prestaciones', universo: 'movilidad_art32' };
}

/**
 * Abril de 2024: el Dec. 268/2024 (397510) fijaba el umbral en $ 134.445,30 (mínimo de marzo); el Dec. 282/2024
 * (397702) lo sustituyó por $ 171.283,31, el mínimo de abril. Lo cargado (`hasta: null`) ya da ese resultado.
 */
const MODIFICATORIAS = { '2024-04': { norma: 'Decreto 268/2024', normaModificatoria: 'Decreto 282/2024', urlModificatoria: `${INFOLEG}397702` } };

const limpio = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/**
 * Qué habría que escribir en un mes (función pura).
 * @param {string} mes YYYY-MM
 * @param {object|null} doc documento actual de datosprevisionales
 * @returns {null | {tipo:'pago_unico'|'alcance', set:object, antes:object, problema?:string}}
 */
function planMes(mes, doc) {
	const pago = PAGOS_UNICOS.find((p) => p.mes === mes);
	if (pago) {
		if (!doc) return { tipo: 'pago_unico', problema: 'no hay documento del mes' };
		const yaCargado = (doc.bonoEscalones || []).length || doc.bono > 0;
		const url = `${INFOLEG}${pago.id}`;
		const set = {
			bono: pago.bono,
			bonoNorma: `${pago.norma} (${pago.tipo})`,
			bonoEscalones: pago.escalones.map((e) => limpio({ hasta: e.hasta, monto: e.monto, norma: pago.norma, alcance: e.alcance, base: e.base, universo: e.universo, excluye: e.excluye, url })),
			'fuentes.bono': [url],
		};
		const antes = { bono: doc.bono, bonoNorma: doc.bonoNorma, bonoEscalones: doc.bonoEscalones };
		if (yaCargado && JSON.stringify(doc.bonoEscalones) !== JSON.stringify(set.bonoEscalones)) return { tipo: 'pago_unico', set, antes, problema: 'el mes ya tiene un bono distinto: no se pisa' };
		if (yaCargado) return null;
		return { tipo: 'pago_unico', set, antes };
	}
	const c = clasificacionVigente(mes);
	const escalones = (doc && doc.bonoEscalones) || [];
	if (!c || !escalones.length) return null;
	const urls = (doc.fuentes && doc.fuentes.bono) || [];
	const mod = MODIFICATORIAS[mes];
	const nuevos = escalones.map((e) => limpio({
		hasta: e.hasta === undefined ? null : e.hasta, monto: e.monto, norma: e.norma,
		alcance: c.alcance, base: c.base, universo: c.universo, excluye: c.excluye,
		normaModificatoria: mod && mod.norma === e.norma ? mod.normaModificatoria : undefined,
		url: urls.length === 1 ? urls[0] : e.url,
	}));
	if (JSON.stringify(nuevos) === JSON.stringify(escalones)) return null;
	const set = { bonoEscalones: nuevos };
	if (mod && doc.bonoNorma && !doc.bonoNorma.includes(mod.normaModificatoria)) set.bonoNorma = `${doc.bonoNorma}; umbral sustituido por el ${mod.normaModificatoria}`;
	return { tipo: 'alcance', set, antes: { bonoEscalones: escalones, ...(set.bonoNorma ? { bonoNorma: doc.bonoNorma } : {}) } };
}

/** Lo que deshace `planMes` en un documento ya escrito (función pura). */
function planRevertir(mes, doc) {
	if (!doc) return null;
	const pago = PAGOS_UNICOS.find((p) => p.mes === mes);
	if (pago) {
		if (!(doc.bonoEscalones || []).some((e) => e.norma === pago.norma)) return null;
		return { unset: { bono: '', bonoNorma: '', bonoEscalones: '', 'fuentes.bono': '' } };
	}
	const escalones = doc.bonoEscalones || [];
	if (!escalones.some((e) => e.alcance || e.base || e.universo || e.url || e.normaModificatoria || e.excluye)) return null;
	const set = { bonoEscalones: escalones.map((e) => ({ hasta: e.hasta === undefined ? null : e.hasta, monto: e.monto, norma: e.norma })) };
	const mod = MODIFICATORIAS[mes];
	if (mod && doc.bonoNorma) set.bonoNorma = doc.bonoNorma.replace(`; umbral sustituido por el ${mod.normaModificatoria}`, '');
	return { set };
}

module.exports = { ALCANCES, PAGOS_UNICOS, MODIFICATORIAS, POLICIA, INFOLEG, clasificarDecretoBono, clasificacionVigente, planMes, planRevertir };
