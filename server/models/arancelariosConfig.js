const mongoose = require('mongoose');

let Schema = mongoose.Schema;

/**
 * Documento único de configuración/estado de las sincronizaciones de valores
 * arancelarios.
 * ==========================================================================
 * Es UN solo documento (_id fijo) con un sub-objeto por fuente. Cada
 * sincronización, al terminar, escribe acá su última corrida: cuándo fue, si
 * salió bien, cuántos valores trajo y cuál quedó vigente. Sirve para dos cosas:
 * que el panel muestre el estado de cada scraper de un vistazo, y que la propia
 * sincronización sepa si el valor vigente cambió respecto de la vez anterior
 * —que es lo que dispara el post y el aviso por correo.
 */

// Estado de una fuente. No se declara `required` en los campos porque un
// registro se crea inccompleto en la primera corrida y se va completando.
const fuenteSchema = new Schema(
  {
    etiqueta: String,        // "UMA PJN", "JUS SFE", ...
    unidad: String,          // UMA / JUS / IUS
    ambito: String,          // PJN / CABA / SFE / ...
    url: String,             // fuente pública

    ultimaEjecucion: Date,
    ultimoEstado: { type: String, enum: ['ok', 'error'], default: 'ok' },
    ultimoError: String,
    duracionMs: Number,

    // Resultado de la última corrida.
    publicados: Number,      // cuántos valores trae la fuente
    nuevos: Number,
    corregidos: Number,
    sinCambios: Number,

    // Valor vigente al cierre de la última corrida.
    vigente: {
      valor: Number,
      periodo: String,
      norma: String,
      vigenciaDesde: Date
    },

    // Fecha de vigencia del último valor sobre el que ya se generó post + aviso.
    // Se compara contra el vigente nuevo para no volver a avisar de lo mismo ni
    // spamear en la carga histórica inicial.
    ultimaVigenciaAvisada: Date,
    ultimoPostId: { type: Schema.Types.ObjectId, ref: 'SocialPost' },
    ultimoPostFecha: Date
  },
  { _id: false }
);

let arancelariosConfigSchema = new Schema(
  {
    _id: { type: String, default: 'arancelarios-config' },
    // Sub-documento por fuente, indexado por su clave ("uma-pjn", "jus-sfe"…).
    fuentes: {
      type: Map,
      of: fuenteSchema,
      default: {}
    }
  },
  { timestamps: true, collection: 'arancelarios-config', versionKey: false }
);

module.exports = mongoose.model('ArancelariosConfig', arancelariosConfigSchema);
