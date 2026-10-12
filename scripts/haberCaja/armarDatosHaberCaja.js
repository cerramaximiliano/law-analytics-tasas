/**
 * Arma server/data/previsional/haber-caja.json (datos versionados del haber de caja, Ley 24.241) a partir de las
 * series de la investigación del 12/10/2026 (la-ads/analysis/2026-10-12-haber-caja-investigacion.md).
 *
 * Uso: node scripts/haberCaja/armarDatosHaberCaja.js --dir=<carpeta hc-investigacion> [--parametros=<json definitivo>] [--rentas=<rentas_autonomos.json>]
 *
 * Salida: [{ periodo: 'YYYY-MM', campos: { 'ruta.del.campo': valor }, normas: { 'ruta.del.campo': 'norma' } }]
 * Lo aplica scripts/haberCaja/cargarDatosHaberCaja.js (modo prueba, --apply, --forzar, --revertir).
 */
const fs = require('fs');
const path = require('path');

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=') || null;
const DIR = arg('dir');
if (!DIR) { console.error('Falta --dir'); process.exit(1); }
const leer = (p) => JSON.parse(fs.readFileSync(path.join(DIR, p), 'utf8'));
const mesSig = (p) => { let [y, m] = p.split('-').map(Number); m++; if (m === 13) { y++; m = 1; } return `${y}-${String(m).padStart(2, '0')}`; };
const ULTIMO = '2026-10';

const porMes = {};
// evidencias: casos del banco (ids internos) que respaldan el valor, con la fuente (ANSES / BlueCorp / Jáuregui)
const poner = (periodo, campo, valor, norma, evidencias) => {
  if (valor === null || valor === undefined || periodo > ULTIMO || periodo < '1955-01') return;
  const m = (porMes[periodo] = porMes[periodo] || { periodo, campos: {}, normas: {}, evidencias: {} });
  m.campos[campo] = valor;
  if (norma) m.normas[campo] = norma;
  if (evidencias && evidencias.length) m.evidencias[campo] = evidencias.slice(0, 5).map((e) => ({ fuente: e.fuente, caso: e.idInterno || e.fixture, valor: e.valorImpreso, detalle: e.detalle }));
};

// 1. Índices de actualización de remuneraciones
const oficial = leer('indices-2009/series/indice_actualizacion_remuneraciones_oficial.json');
for (const d of oficial.datos) poner(d.periodo, 'indicesRemuneraciones.ley27260', d.valor, d.norma);
const r135 = leer('indices-2009/series/indice_cadena_res135_09.json');
for (const d of r135.datos) poner(d.periodo, 'indicesRemuneraciones.res135', d.valor, d.norma);
const r140 = leer('indices-pre2009/series/res140.json');
for (const d of r140.datos) poner(d.periodo, 'indicesRemuneraciones.res140', d.valor, r140.norma ? 'Res. D.E.-A ANSES 140/95' : null);

// 2. Rentas de autónomos (por tramo → cada mes del tramo)
const rentas = arg('rentas') ? JSON.parse(fs.readFileSync(arg('rentas'), 'utf8')) : leer('autonomos/data/tabla_rentas_autonomos_anses.json');
for (const t of rentas.tramos) {
  for (let p = t.desde; p <= (t.hasta || ULTIMO); p = mesSig(p)) poner(p, 'rentasAutonomos', t.valores, t.norma || t.fuente);
}

// 3. Parámetros a la FAD (tabla de la investigación o la definitiva si se pasa --parametros)
const parametros = arg('parametros') ? JSON.parse(fs.readFileSync(arg('parametros'), 'utf8')) : leer('prestaciones/parametros_haber_inicial_1994_2026.json');
const MAPA = {
  ampoMopre: 'valorAMPOoMOPRE',
  maximoImponible: 'maximoImponible',
  baseImponibleMinima: 'baseImponibleMinima',
  haberMinimo: 'haberMinimoJubilacion',
  haberMaximo: 'haberMaximoJubilacion',
  pbu: 'pbu',
  topePCporAnio: 'topePC',
  factorSuplementoAltas: 'factorSuplementoAltas',
  pbuAltas: 'pbuAltas',
  pcPctPorAnio: 'pcPctPorAnio',
  papPctPorAnio: 'papPctPorAnio',
};
const tabla = parametros.meses || parametros; // parametros_definitivos.json: { meta, meses: { 'YYYY-MM': {...} } }
const filas = Array.isArray(tabla) ? tabla : Object.entries(tabla).map(([periodo, v]) => ({ periodo, ...v }));
for (const f of filas) {
  for (const [origen, destino] of Object.entries(MAPA)) {
    const v = f[origen];
    if (v && typeof v === 'object' && typeof v.valor === 'number') poner(f.periodo, destino, v.valor, v.url ? `${v.norma} — ${v.url}` : v.norma, v.ejemplos);
  }
}

const salida = Object.values(porMes).sort((a, b) => (a.periodo < b.periodo ? -1 : 1));
const destino = path.join(__dirname, '../../server/data/previsional/haber-caja.json');
fs.writeFileSync(destino, JSON.stringify({ generado: new Date().toISOString().slice(0, 10), fuente: 'la-ads/analysis/2026-10-12-haber-caja-investigacion.md', meses: salida }, null, 1));
const cuenta = {};
for (const m of salida) for (const c of Object.keys(m.campos)) cuenta[c] = (cuenta[c] || 0) + 1;
console.log(`${salida.length} meses (${salida[0].periodo} a ${salida[salida.length - 1].periodo}) → ${destino}`);
console.log(cuenta);
