const mongoose = require('mongoose');

/**
 * Series mensuales (inflación, RIPTE, IPC, SMVM, haber mínimo). Un documento por serie y
 * período. La lee el motor de intereses del hub (law-analytics-server/models/IndicesMensuales.js).
 *
 * tipo:
 *  - 'variacion': variación % del mes (inflación mensual)      → tipoIndice variacionMensual
 *  - 'nivel':     nivel del índice en el mes (RIPTE, IPC)        → tipoIndice indiceMensual
 *  - 'valor':     monto vigente en el mes (SMVM, haber mínimo)   → tipoIndice valorMensual (topes/pisos)
 */
const indicesMensualesSchema = new mongoose.Schema(
  {
    serie: { type: String, required: true },
    periodo: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ }, // YYYY-MM
    valor: { type: Number, required: true },
    tipo: { type: String, enum: ['variacion', 'nivel', 'valor'], required: true },
    fuente: { type: String, required: true },
    norma: { type: String },
    provisorio: { type: Boolean, default: false },
    // Series de 'valor' (SMVM, haber mínimo): la fuente publica solo los meses con cambio; los
    // meses intermedios repiten el valor vigente y guardan acá el período de origen.
    rellenoDesde: { type: String },
    publicadoEn: { type: Date },
  },
  { timestamps: true, collection: 'indicesmensuales' }
);

indicesMensualesSchema.index({ serie: 1, periodo: 1 }, { unique: true });

module.exports = mongoose.models.IndicesMensuales || mongoose.model('IndicesMensuales', indicesMensualesSchema);
