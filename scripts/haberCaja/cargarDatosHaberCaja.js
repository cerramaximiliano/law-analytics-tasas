/**
 * Aplica server/data/previsional/haber-caja.json a `datosprevisionales` (haber de caja, Ley 24.241).
 *
 *   node scripts/haberCaja/cargarDatosHaberCaja.js                         (prueba: no escribe)
 *   node scripts/haberCaja/cargarDatosHaberCaja.js --apply                 (escribe campos vacíos)
 *   node scripts/haberCaja/cargarDatosHaberCaja.js --apply --forzar        (además pisa valores distintos)
 *   node scripts/haberCaja/cargarDatosHaberCaja.js --campos=pbuAltas,rentasAutonomos --desde=2019-01 --hasta=2020-12
 *   node scripts/haberCaja/cargarDatosHaberCaja.js --revertir=<corrida>
 *   --exacto   compara sin la tolerancia de medio centavo (un valor sin redondear como 6.558,05623 no es igual al publicado
 *              6.558,06: 246 valores de 2009–2019 quedaron así en la primera carga del 18/10/2026)
 *
 * Cada cambio queda en `datosprevisionales-sincronizaciones` (mismo formato que el sincronizador de InfoLeg), y la
 * norma de cada campo se guarda en `normas.<campo>`.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const mongoose = require('mongoose');
const svc = require('../../server/services/scrapers/previsional/datosPrevisionalesService');

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=') || null;
const flag = (n) => process.argv.includes(`--${n}`);
const get = (o, ruta) => ruta.split('.').reduce((x, k) => (x === undefined || x === null ? undefined : x[k]), o);
const TOL = process.argv.includes('--exacto') ? 1e-9 : 0.005;
const iguales = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= Math.max(TOL, Math.abs(b) * 1e-12) : JSON.stringify(a) === JSON.stringify(b));
const vacio = (v) => v === undefined || v === null || v === '' || (typeof v === 'number' && v === 0);

(async () => {
  await mongoose.connect(process.env.URLDB);
  const col = mongoose.connection.collection('datosprevisionales');
  const auditoria = mongoose.connection.collection('datosprevisionales-sincronizaciones');
  if (arg('revertir')) {
    console.log(`Revertidos ${await svc.revertir(arg('revertir'))} cambios de ${arg('revertir')}`);
    return mongoose.disconnect();
  }
  const archivo = arg('archivo') || path.join(__dirname, '../../server/data/previsional/haber-caja.json');
  const { meses } = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  const campos = arg('campos') ? arg('campos').split(',') : null;
  const desde = arg('desde') || '0000-00';
  const hasta = arg('hasta') || '9999-99';
  const aplicar = flag('apply');
  const forzar = flag('forzar');
  const corrida = `haberCaja-${moment.utc().format('YYYYMMDD-HHmmss')}`;
  console.log(`=== haber de caja · ${aplicar ? (forzar ? 'APLICAR + FORZAR' : 'APLICAR (solo vacíos)') : 'PRUEBA'} · ${archivo}`);

  const res = { nuevos: 0, iguales: 0, conflictos: 0, normas: 0, escritos: 0, sinDoc: 0 };
  const conflictosPorCampo = {};
  for (const m of meses) {
    if (m.periodo < desde || m.periodo > hasta) continue;
    const fecha = moment.utc(m.periodo, 'YYYY-MM').startOf('month').toDate();
    const doc = await col.findOne({ fecha });
    if (!doc) { res.sinDoc++; continue; }
    const $set = {};
    const cambios = [];
    for (const [campo, valor] of Object.entries(m.campos)) {
      if (campos && !campos.some((c) => campo === c || campo.startsWith(`${c}.`))) continue;
      const actual = get(doc, campo);
      if (actual !== undefined && iguales(actual, valor)) {
        res.iguales++;
        // valor igual pero la norma falta o cambió: se completa solo la norma (antes se salteaba y la norma no llegaba)
        const nActual = get(doc, `normas.${campo}`);
        if (m.normas[campo] && nActual !== m.normas[campo]) {
          res.normas++;
          $set[`normas.${campo}`] = m.normas[campo];
          cambios.push({ campo: `normas.${campo}`, actual: nActual });
        }
        continue;
      }
      const conflicto = !vacio(actual);
      if (conflicto) {
        res.conflictos++;
        const c = (conflictosPorCampo[campo] = conflictosPorCampo[campo] || { n: 0, ejemplos: [] });
        c.n++;
        if (c.ejemplos.length < 3) c.ejemplos.push(`${m.periodo}: ${JSON.stringify(actual)} → ${JSON.stringify(valor)}`);
        if (!forzar) continue;
      } else res.nuevos++;
      $set[campo] = valor;
      if (m.normas[campo]) $set[`normas.${campo}`] = m.normas[campo];
      cambios.push({ campo, actual });
      if (m.normas[campo]) cambios.push({ campo: `normas.${campo}`, actual: get(doc, `normas.${campo}`) });
    }
    if (!aplicar || !Object.keys($set).length) continue;
    await col.updateOne({ _id: doc._id }, { $set });
    await auditoria.insertMany(cambios.map((c) => ({ corrida, fecha, campo: c.campo, valorAnterior: c.actual === undefined ? null : c.actual, valorNuevo: get({ ...$set }, c.campo) ?? $set[c.campo], existia: c.actual !== undefined, creado: new Date() })));
    res.escritos += cambios.length;
  }
  console.log('Resumen', JSON.stringify(res));
  for (const [c, v] of Object.entries(conflictosPorCampo)) console.log(`  conflicto ${c}: ${v.n} meses · ${v.ejemplos.join(' | ')}`);
  if (aplicar && res.escritos) console.log(`Para revertir: node scripts/haberCaja/cargarDatosHaberCaja.js --revertir=${corrida}`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
