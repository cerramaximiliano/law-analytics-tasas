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
    normaSMVM: { type: String },
    fuentes: { type: Schema.Types.Mixed }, // { anses: [url], bono: [url], smvm: [url] }
  }, { collection: 'datosprevisionales' });


  datosPrevSchema.plugin(uniqueValidator, {message: '{PATH} debe de ser unico'})


  module.exports = mongoose.model('DatosPrevisionales', datosPrevSchema);
