/**
 * Script de auditoría y reparación de fechas faltantes en TasasConfig.
 *
 * Para cada tipo de tasa:
 *   1. Consulta directamente la colección Tasas para obtener fechaInicio y fechaUltima reales.
 *   2. Genera el rango completo de fechas entre ambas.
 *   3. Identifica qué fechas tienen el campo nulo/undefined (gaps reales).
 *   4. Calcula la fechaUltimaCompleta correcta.
 *   5. Compara con lo almacenado en TasasConfig y actualiza si difiere.
 *
 * Uso:
 *   node scripts/auditarFechasFaltantes.js [--fix] [--tasa=tasaActivaCNAT2764]
 *
 *   --fix              Aplica los cambios en la base de datos (sin este flag solo reporta)
 *   --tasa=<tipo>      Limita la auditoría a un solo tipo de tasa
 */

'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const moment = require('moment');
const config = require('../server/config');
const Tasas = require('../server/models/tasas');
const TasasConfig = require('../server/models/tasasConfig');

const TIPOS_TASA = [
    'tasaPasivaBNA',
    'tasaPasivaBCRA',
    'tasaActivaBNA',
    'cer',
    'icl',
    'tasaActivaCNAT2601',
    'tasaActivaCNAT2658',
    'tasaActivaCNAT2764',
    'tasaActivaTnaBNA',
];

const args = process.argv.slice(2);
const FIX_MODE = args.includes('--fix');
const tasaArg = args.find(a => a.startsWith('--tasa='));
const SOLO_TASA = tasaArg ? tasaArg.split('=')[1] : null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(d) {
    if (!d) return 'null';
    return moment.utc(d).format('YYYY-MM-DD');
}

function mismaFecha(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return moment.utc(a).format('YYYY-MM-DD') === moment.utc(b).format('YYYY-MM-DD');
}

// ─── Auditoría por tipo de tasa ───────────────────────────────────────────────

async function auditarTasa(tipoTasa) {
    // 1. Obtener rango real desde la colección Tasas
    const [primerDoc, ultimoDoc] = await Promise.all([
        Tasas.findOne({ [tipoTasa]: { $ne: null } }).sort({ fecha: 1 }).select('fecha').lean(),
        Tasas.findOne({ [tipoTasa]: { $ne: null } }).sort({ fecha: -1 }).select('fecha').lean(),
    ]);

    if (!primerDoc || !ultimoDoc) {
        console.log(`  [${tipoTasa}] Sin datos en Tasas. Salteando.`);
        return null;
    }

    const fechaInicio = moment.utc(primerDoc.fecha).startOf('day');
    const fechaUltima = moment.utc(ultimoDoc.fecha).startOf('day');
    const totalDias = fechaUltima.diff(fechaInicio, 'days') + 1;

    // 2. Obtener todas las fechas que SÍ tienen valor en el rango
    const docsConValor = await Tasas.find({
        fecha: { $gte: fechaInicio.toDate(), $lte: fechaUltima.toDate() },
        [tipoTasa]: { $ne: null },
    }).select('fecha').lean();

    const existentes = new Set(docsConValor.map(d => moment.utc(d.fecha).format('YYYY-MM-DD')));

    // 3. Identificar gaps
    const gaps = [];
    let cursor = fechaInicio.clone();
    while (cursor.isSameOrBefore(fechaUltima)) {
        const key = cursor.format('YYYY-MM-DD');
        if (!existentes.has(key)) {
            gaps.push(cursor.clone().toDate());
        }
        cursor.add(1, 'days');
    }

    // 4. Calcular fechaUltimaCompleta correcta
    let fechaUltimaCompletaCorrecta = null;
    if (gaps.length === 0) {
        fechaUltimaCompletaCorrecta = fechaUltima.toDate();
    } else {
        const primerGap = moment.utc(gaps[0]).startOf('day');
        if (primerGap.isAfter(fechaInicio)) {
            fechaUltimaCompletaCorrecta = primerGap.clone().subtract(1, 'days').toDate();
        } else {
            fechaUltimaCompletaCorrecta = null; // gaps desde el inicio
        }
    }

    // 5. Obtener TasasConfig actual
    const configActual = await TasasConfig.findOne({ tipoTasa });

    const stored = {
        fechaInicio: configActual?.fechaInicio,
        fechaUltima: configActual?.fechaUltima,
        fechaUltimaCompleta: configActual?.fechaUltimaCompleta,
        fechasFaltantes: configActual?.fechasFaltantes?.length ?? 'N/A',
    };

    const computed = {
        fechaInicio: fechaInicio.toDate(),
        fechaUltima: fechaUltima.toDate(),
        fechaUltimaCompleta: fechaUltimaCompletaCorrecta,
        fechasFaltantes: gaps.length,
    };

    // 6. Detectar diferencias
    const diff = {
        fechaInicio: !mismaFecha(stored.fechaInicio, computed.fechaInicio),
        fechaUltima: !mismaFecha(stored.fechaUltima, computed.fechaUltima),
        fechaUltimaCompleta: !mismaFecha(stored.fechaUltimaCompleta, computed.fechaUltimaCompleta),
        fechasFaltantes: stored.fechasFaltantes !== computed.fechasFaltantes,
    };

    const hayCambios = Object.values(diff).some(Boolean);

    // 7. Mostrar reporte
    console.log(`\n  ┌─ [${tipoTasa}]`);
    console.log(`  │  Rango real:          ${fmt(computed.fechaInicio)} → ${fmt(computed.fechaUltima)} (${totalDias} días)`);
    console.log(`  │  Días con datos:      ${existentes.size} / ${totalDias}`);
    console.log(`  │  Gaps encontrados:    ${gaps.length}${gaps.length > 0 ? ` (primero: ${fmt(gaps[0])})` : ''}`);
    console.log(`  │  fechaUltimaCompleta:`);
    console.log(`  │    almacenada:  ${fmt(stored.fechaUltimaCompleta)}`);
    console.log(`  │    calculada:   ${fmt(computed.fechaUltimaCompleta)} ${diff.fechaUltimaCompleta ? '⚠️  DIFIERE' : '✓'}`);

    if (diff.fechaInicio)   console.log(`  │  fechaInicio:   ${fmt(stored.fechaInicio)} → ${fmt(computed.fechaInicio)} ⚠️`);
    if (diff.fechaUltima)   console.log(`  │  fechaUltima:   ${fmt(stored.fechaUltima)} → ${fmt(computed.fechaUltima)} ⚠️`);
    if (diff.fechasFaltantes) console.log(`  │  fechasFaltantes: ${stored.fechasFaltantes} almacenadas vs ${computed.fechasFaltantes} calculadas ⚠️`);

    if (!hayCambios) {
        console.log(`  └─ OK. Sin cambios necesarios.`);
        return { tipoTasa, cambios: false };
    }

    if (gaps.length > 0 && gaps.length <= 30) {
        console.log(`  │  Gaps: ${gaps.map(fmt).join(', ')}`);
    } else if (gaps.length > 30) {
        console.log(`  │  Primeros 10 gaps: ${gaps.slice(0, 10).map(fmt).join(', ')} ...`);
    }

    // 8. Aplicar cambios si --fix
    if (FIX_MODE) {
        if (configActual) {
            configActual.fechaInicio = computed.fechaInicio;
            configActual.fechaUltima = computed.fechaUltima;
            configActual.fechaUltimaCompleta = computed.fechaUltimaCompleta;
            configActual.fechasFaltantes = gaps;
            configActual.ultimaVerificacion = new Date();
            await configActual.save();
            console.log(`  └─ ✅ TasasConfig actualizado.`);
        } else {
            await TasasConfig.create({
                tipoTasa,
                fechaInicio: computed.fechaInicio,
                fechaUltima: computed.fechaUltima,
                fechaUltimaCompleta: computed.fechaUltimaCompleta,
                fechasFaltantes: gaps,
                ultimaVerificacion: new Date(),
            });
            console.log(`  └─ ✅ TasasConfig creado (no existía).`);
        }
    } else {
        console.log(`  └─ (dry-run) Ejecutar con --fix para aplicar cambios.`);
    }

    return { tipoTasa, cambios: hayCambios, gaps: gaps.length, fechaUltimaCompletaCorrecta };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
    console.log(`\n=== Auditoría de Fechas Faltantes en Tasas ===`);
    console.log(`Modo: ${FIX_MODE ? '✏️  FIX (aplica cambios)' : '👁  DRY-RUN (solo reporte)'}`);
    if (SOLO_TASA) console.log(`Tasa filtrada: ${SOLO_TASA}`);
    console.log(`Fecha actual (UTC): ${moment.utc().format('YYYY-MM-DD HH:mm')}\n`);

    mongoose.set('strictQuery', false);
    await mongoose.connect(config.mongodb.url);
    console.log('Conectado a MongoDB.');

    const tipos = SOLO_TASA ? [SOLO_TASA] : TIPOS_TASA;
    const resultados = [];

    for (const tipoTasa of tipos) {
        const r = await auditarTasa(tipoTasa);
        if (r) resultados.push(r);
    }

    // Resumen final
    console.log(`\n${'='.repeat(50)}`);
    console.log('RESUMEN:');
    const conCambios = resultados.filter(r => r.cambios);
    const sinCambios = resultados.filter(r => !r.cambios);
    console.log(`  OK (sin diferencias):  ${sinCambios.length}`);
    console.log(`  Con diferencias:       ${conCambios.length}`);
    if (conCambios.length > 0) {
        console.log(`  Tasas con diferencias:`);
        conCambios.forEach(r => {
            console.log(`    - ${r.tipoTasa}: ${r.gaps} gaps, fechaUltimaCompleta correcta: ${fmt(r.fechaUltimaCompletaCorrecta)}`);
        });
    }
    if (!FIX_MODE && conCambios.length > 0) {
        console.log(`\n  ⚡ Ejecutar con --fix para aplicar las correcciones.`);
    }

    await mongoose.disconnect();
    console.log('\nDesconectado. Auditoría completada.');
}

run().catch((err) => {
    console.error('Error durante la auditoría:', err);
    process.exit(1);
});
