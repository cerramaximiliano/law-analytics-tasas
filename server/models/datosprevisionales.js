const mongoose = require('mongoose');
const uniqueValidator = require('mongoose-unique-validator');
let Schema = mongoose.Schema;

let datosPrevSchema = new Schema({
    fecha: {
    type: Date,
    unique: true,
    required: true
    },
    moneda: {
    type: String,
    required: true
    },
    maximoImponible: {
    type: Number
    },
    haberMaximoJubilacion: {
    type: Number
    },
    haberMaximoPension: {
    type: Number
    },
    haberMinimoJubilacion: {
    type: Number
    },
    haberMinimoPension: {
    type: Number
    },
    suplemento82SMVM: {
    type: Number
    },
    salarioMVM: {
    type: Number
    },
    minimoFerroviario406: {
    type: Number
    },
    minimoFerroviario662: {
    type: Number
    },
    movilidadGeneral: {
    type: Number
    },
    haberGeneralBrigada: {
    type: Number
    },
    valorAMPOoMOPRE: {
    type: Number,
    default: 80
    },
    pbu: {
    type: Number,
    },
    topePC: {
    type: Number,
    },
    estado: {
    type: Boolean,
    default: true
    },
    referenciaDiferencialMin: {
    type: Number
    },
    referenciaDiferncialMax: {
    type: Number
    },
    movilidadDiferencial: {
    type: Number
    },
    adicionales: {
    type: Number
    },
    NormasMinima: {
    type: String
    },
    NormasMovilidad: {
    type: String
    },
    SupMovilidad: {
    type: Boolean
    },
    // Campos presentes en Atlas que el schema no tenía
    referenciaDiferencialMax: { type: Number },
    movilidadLey27426: { type: Number },
    movilidadIpcTrimRetrasado3m: { type: Number },
    // Derivados de IPC y RIPTE para el empalme de 2024 (scripts/cargarMovilidadDerivada2024.js):
    // empalme 70/30 de 12/2023 a 4/2024 (solo 2024-07) e IPC trimestral del criterio Aguirre (2024-03 y 2024-06)
    movilidadEmpalme27426Dnu: { type: Number },
    movilidadAguirreIpcTrimestral: { type: Number },
    movilidadAumentoMar2021: { type: Number },
    norma: { type: String },
    links: { type: [String] },
    // Sincronizador (services/scrapers/previsional/datosPrevisionalesService.js)
    baseImponibleMinima: { type: Number },
    puam: { type: Number },
    bono: { type: Number },          // monto máximo del bono/ayuda/refuerzo pagado en el mes; 0 si no hubo
    bonoNorma: { type: String },
    // Escalones del decreto. `alcance` dice cómo se paga (services/scrapers/previsional/bonosAlcance.js):
    // umbral_decreciente (default: `monto` hasta `hasta`; por encima, lo necesario para llegar a hasta + monto),
    // umbral / escalonado (`monto` entero hasta `hasta`), solo_minimo, todos. `hasta: null` = haber mínimo del mes
    // (haber máximo si el alcance es "todos"). Varios decretos en el mes se suman.
    // `base` (único beneficio / suma de prestaciones / cada prestación), `universo` (sipa / movilidad_art32) y
    // `excluye` dicen a quién alcanza según el texto; el motor del hub todavía no los usa.
    bonoEscalones: [{
      _id: false, hasta: { type: Number, default: null }, monto: Number, norma: String,
      alcance: { type: String, enum: ['umbral_decreciente', 'umbral', 'escalonado', 'solo_minimo', 'todos'] },
      base: { type: String, enum: ['unico_beneficio', 'suma_prestaciones', 'cada_prestacion'] },
      universo: { type: String, enum: ['sipa', 'movilidad_art32'] },
      excluye: { type: [String], default: undefined },
      normaModificatoria: { type: String },
      url: { type: String },
    }],
    normaSMVM: { type: String },
    fuentes: { type: Schema.Types.Mixed }, // { anses: [url], bono: [url], smvm: [url] }
    // ── Haber de caja (Ley 24.241): mismo esquema que law-analytics-server/models/DatosPrevisionales.js ──
    indicesRemuneraciones: {
      res140: { type: Number },
      res135: { type: Number },
      ley27260: { type: Number },
      ley27260Provisorio: { type: Boolean },
    },
    rentasAutonomos: { type: Schema.Types.Mixed },
    pbuAltas: { type: Number },
    factorSuplementoAltas: { type: Number },
    pcPctPorAnio: { type: Number },
    papPctPorAnio: { type: Number },
    normas: { type: Schema.Types.Mixed },
    evidencias: { type: Schema.Types.Mixed },
  }, { collection: 'datosprevisionales' });


  datosPrevSchema.plugin(uniqueValidator, {message: '{PATH} debe de ser unico'})


  module.exports = mongoose.model('DatosPrevisionales', datosPrevSchema);
