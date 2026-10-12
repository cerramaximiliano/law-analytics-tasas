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
    movilidadAumentoMar2021: { type: Number },
    norma: { type: String },
    links: { type: [String] },
    // Sincronizador (services/scrapers/previsional/datosPrevisionalesService.js)
    baseImponibleMinima: { type: Number },
    puam: { type: Number },
    bono: { type: Number },          // monto máximo del bono/ayuda/refuerzo pagado en el mes; 0 si no hubo
    bonoNorma: { type: String },
    // Escalones del decreto: quien cobra hasta `hasta` (null = haber mínimo del mes) recibe `monto`; por encima,
    // lo necesario para llegar a hasta + monto. Varios decretos en el mes se suman.
    bonoEscalones: [{ _id: false, hasta: { type: Number, default: null }, monto: Number, norma: String }],
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
