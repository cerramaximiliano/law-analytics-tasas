// COPIA de pjn-models/src/utils/dias-habiles.js (v1.66.0). No editar acá: cambiar en pjn-models y recopiar.
/**
 * dias-habiles.js — Calendario judicial y cómputo de plazos procesales (PJN).
 *
 * Capa 0 del subsistema de plazos/vencimientos: dado un calendario de días
 * inhábiles (colección `feriados-judiciales`, modelo FeriadoJudicial) computa
 * días hábiles judiciales y vencimientos de plazos contados desde una
 * notificación, con el detalle completo del cómputo para auditoría (la UI
 * debe poder mostrar SIEMPRE la base del cálculo).
 *
 * Reglas implementadas (fuero nacional/federal, CPCCN):
 *   - Días inhábiles: sábados, domingos y los días del calendario recibido
 *     (feriados nacionales, ferias judiciales de enero y julio, asuetos por
 *     acordada). Art. 152 CPCCN.
 *   - Perfeccionamiento de la notificación: si la cédula se diarizó/subió en
 *     día inhábil, se tiene por practicada el primer día hábil siguiente
 *     (régimen de notificación electrónica, Ac. CSJN 31/2011 y 38/2013).
 *   - Cómputo: los plazos corren desde el día hábil siguiente a la
 *     notificación — el día de la notificación no se cuenta (art. 156 CPCCN).
 *   - Plazos en días hábiles (regla general, art. 156) o corridos (cuando la
 *     norma lo dispone); el plazo corrido que vence en día inhábil se
 *     prorroga al primer día hábil siguiente.
 *   - Plazo de gracia ("cargo"): la presentación es válida dentro de las DOS
 *     primeras horas del día hábil siguiente al vencimiento (art. 124 CPCCN).
 *
 * Convención de fechas: todo el cómputo opera sobre strings 'YYYY-MM-DD'
 * (día calendario argentino) para evitar bugs de timezone. Los `fecha` de los
 * movimientos scrapeados se guardan como Date a medianoche UTC representando
 * el día calendario — por eso toDay() usa getters UTC. Si se parte de un
 * instante real (p.ej. timestamp de diarización del portal), convertir antes
 * con toDayART() (Argentina es UTC-3 fijo, sin DST).
 *
 * Mongoose-agnóstico: recibe el calendario como Set/Array de 'YYYY-MM-DD'
 * (FeriadoJudicial.getSet() lo produce). Opera sobre datos planos.
 */

// Versión de las reglas de cómputo. Subirla cuando cambie la mecánica del
// cálculo (no cuando cambie el calendario — eso vive en Mongo). Los
// vencimientos persistidos guardan la versión con la que se computaron.
const VERSION = 1;

const RE_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MS_DIA = 24 * 60 * 60 * 1000;
const MAX_ITER = 5000; // guard: ningún plazo real recorre más de ~13 años de días

// ---------------------------------------------------------------------------
// Normalización de fechas
// ---------------------------------------------------------------------------

/**
 * Normaliza a día calendario 'YYYY-MM-DD'.
 * - String 'YYYY-MM-DD' → passthrough (validado).
 * - Date → día calendario según reloj UTC (convención de `movimiento[].fecha`:
 *   medianoche UTC codifica el día calendario del movimiento).
 */
function toDay(input) {
    if (typeof input === "string") {
        if (!RE_DAY.test(input)) throw new TypeError(`toDay: string no es 'YYYY-MM-DD': ${input}`);
        return input;
    }
    if (input instanceof Date && !isNaN(input)) {
        const y = input.getUTCFullYear();
        const m = String(input.getUTCMonth() + 1).padStart(2, "0");
        const d = String(input.getUTCDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
    }
    throw new TypeError(`toDay: se esperaba Date o 'YYYY-MM-DD', llegó ${input}`);
}

/**
 * Día calendario ARGENTINO de un instante real (Date con hora significativa).
 * Argentina es UTC-3 fijo (sin DST) — restar 3h y leer el día UTC.
 */
function toDayART(instant) {
    if (!(instant instanceof Date) || isNaN(instant)) {
        throw new TypeError(`toDayART: se esperaba Date válido, llegó ${instant}`);
    }
    return toDay(new Date(instant.getTime() - 3 * 60 * 60 * 1000));
}

/** Day string → Date a medianoche UTC (para persistir o comparar). */
function dayToDate(day) {
    return new Date(`${toDay(day)}T00:00:00Z`);
}

/** Suma n días CALENDARIO a un day string. */
function addDays(day, n) {
    return toDay(new Date(dayToDate(day).getTime() + n * MS_DIA));
}

/** Día de la semana: 0=domingo ... 6=sábado. */
function dow(day) {
    return dayToDate(day).getUTCDay();
}

// ---------------------------------------------------------------------------
// Días hábiles
// ---------------------------------------------------------------------------

function asSet(feriados) {
    if (!feriados) return new Set();
    if (feriados instanceof Set) return feriados;
    if (Array.isArray(feriados)) return new Set(feriados);
    throw new TypeError("feriados debe ser Set, Array o null");
}

function esFinDeSemana(day) {
    const d = dow(day);
    return d === 0 || d === 6;
}

/** Hábil judicial: no finde y no está en el calendario de inhábiles. */
function esHabil(day, feriados) {
    const f = asSet(feriados);
    const d = toDay(day);
    return !esFinDeSemana(d) && !f.has(d);
}

/** El mismo día si es hábil; si no, el primer hábil posterior. */
function habilOSiguiente(day, feriados) {
    const f = asSet(feriados);
    let d = toDay(day);
    for (let i = 0; i < MAX_ITER; i++) {
        if (esHabil(d, f)) return d;
        d = addDays(d, 1);
    }
    throw new Error(`habilOSiguiente: sin día hábil en ${MAX_ITER} días desde ${day} — calendario corrupto?`);
}

/** Primer día hábil ESTRICTAMENTE posterior a `day`. */
function siguienteHabil(day, feriados) {
    return habilOSiguiente(addDays(toDay(day), 1), feriados);
}

/**
 * Avanza n días hábiles desde `day` (exclusive) y devuelve el n-ésimo hábil.
 * addDiasHabiles('viernes', 1) → lunes siguiente.
 */
function addDiasHabiles(day, n, feriados) {
    if (!Number.isInteger(n) || n < 1) throw new TypeError(`addDiasHabiles: n debe ser entero >= 1, llegó ${n}`);
    const f = asSet(feriados);
    let d = toDay(day);
    for (let i = 0; i < n; i++) d = siguienteHabil(d, f);
    return d;
}

/** Cantidad de días hábiles en el intervalo (desde, hasta] — desde excluido. */
function habilesEntre(desde, hasta, feriados) {
    const f = asSet(feriados);
    let d = toDay(desde);
    const fin = toDay(hasta);
    if (d > fin) return -habilesEntre(fin, d, f);
    let count = 0;
    for (let i = 0; i < MAX_ITER && d < fin; i++) {
        d = addDays(d, 1);
        if (esHabil(d, f)) count++;
    }
    return count;
}

// ---------------------------------------------------------------------------
// Cómputo de vencimientos
// ---------------------------------------------------------------------------

/**
 * Computa el vencimiento de un plazo contado desde una notificación.
 *
 * @param {Object} opts
 * @param {Date|string} opts.fechaNotificacion — día en que la cédula se
 *   diarizó / quedó disponible (day string o Date-medianoche-UTC).
 * @param {number} opts.plazoDias — cantidad de días del plazo (entero >= 1).
 * @param {'habiles'|'corridos'} [opts.tipoPlazo='habiles']
 * @param {Set|Array} [opts.feriados] — calendario de días inhábiles.
 * @param {boolean} [opts.conGracia=true] — incluir el día de gracia (art. 124).
 *
 * @returns {Object} — todo en day strings 'YYYY-MM-DD':
 *   version              — VERSION de las reglas de cómputo
 *   fechaNotificacion    — input normalizado
 *   perfeccionamiento    — día en que se tiene por practicada la notificación
 *                          (= fechaNotificacion, o el hábil siguiente si cayó
 *                          en inhábil)
 *   inicioPlazo          — primer día computado del plazo
 *   vencimiento          — ÚLTIMO día del plazo (vence a las 24:00 / cierre)
 *   vencimientoConGracia — día hábil siguiente (válido en las dos primeras
 *                          horas, art. 124 CPCCN) | null si conGracia=false
 *   prorrogado           — true si un plazo corrido cayó en inhábil y se
 *                          corrió al hábil siguiente
 *   diasComputados       — [day] cada día hábil contado (solo tipoPlazo
 *                          'habiles'; null en corridos) — para auditoría/UI
 *   feriadosAplicados    — [day] feriados (no-finde) del calendario que
 *                          cayeron dentro del cómputo y corrieron el plazo
 *   plazoDias, tipoPlazo — inputs normalizados
 */
function computarVencimiento({ fechaNotificacion, plazoDias, tipoPlazo = "habiles", feriados, conGracia = true }) {
    if (!Number.isInteger(plazoDias) || plazoDias < 1 || plazoDias > 1000) {
        throw new TypeError(`computarVencimiento: plazoDias inválido: ${plazoDias}`);
    }
    if (tipoPlazo !== "habiles" && tipoPlazo !== "corridos") {
        throw new TypeError(`computarVencimiento: tipoPlazo inválido: ${tipoPlazo}`);
    }
    const f = asSet(feriados);
    const notif = toDay(fechaNotificacion);

    const perfeccionamiento = habilOSiguiente(notif, f);

    let vencimiento;
    let prorrogado = false;
    let diasComputados = null;

    if (tipoPlazo === "habiles") {
        diasComputados = [];
        let d = perfeccionamiento;
        for (let i = 0; i < plazoDias; i++) {
            d = siguienteHabil(d, f);
            diasComputados.push(d);
        }
        vencimiento = d;
    } else {
        const bruto = addDays(perfeccionamiento, plazoDias);
        vencimiento = habilOSiguiente(bruto, f);
        prorrogado = vencimiento !== bruto;
    }

    const inicioPlazo = tipoPlazo === "habiles" ? diasComputados[0] : addDays(perfeccionamiento, 1);

    // Feriados (no-finde) que efectivamente corrieron el cómputo.
    const feriadosAplicados = [];
    for (let d = perfeccionamiento; d <= vencimiento; d = addDays(d, 1)) {
        if (f.has(d) && !esFinDeSemana(d)) feriadosAplicados.push(d);
    }

    return {
        version: VERSION,
        fechaNotificacion: notif,
        perfeccionamiento,
        inicioPlazo,
        vencimiento,
        vencimientoConGracia: conGracia ? siguienteHabil(vencimiento, f) : null,
        prorrogado,
        diasComputados,
        feriadosAplicados,
        plazoDias,
        tipoPlazo,
    };
}

module.exports = {
    VERSION,
    toDay,
    toDayART,
    dayToDate,
    addDays,
    dow,
    esFinDeSemana,
    esHabil,
    habilOSiguiente,
    siguienteHabil,
    addDiasHabiles,
    habilesEntre,
    computarVencimiento,
};
