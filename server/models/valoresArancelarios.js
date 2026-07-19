const mongoose = require('mongoose');
const moment = require('moment');

let Schema = mongoose.Schema;

/**
 * Unidades arancelarias y previsionales de valor variable.
 * =======================================================
 * UMA, JUS y afines: unidades cuyo valor fija una norma cada tanto y que se
 * usan para regular honorarios o calcular montos.
 *
 * A diferencia de `tasas`, que es una serie diaria y densa, acá cada documento
 * es un ESCALON: un valor que rige desde una fecha hasta que otra norma lo
 * reemplaza. Por eso no hay un doc por día sino uno por resolución, y la
 * consulta habitual no es "el valor del 12 de marzo" sino "el valor vigente a
 * tal fecha" —el último escalón cuya vigencia ya empezó.
 *
 * `norma` y `fuente` no son decorativos: el valor se publica de cara a
 * profesionales que necesitan poder citarlo, y un número sin la resolución que
 * lo fija no sirve para escribir un escrito.
 */
let valorArancelarioSchema = new Schema(
  {
    // Sigla de la unidad, tal como se la nombra en la práctica: UMA, JUS, IUS.
    unidad: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      index: true
    },
    // Jurisdicción o entidad que fija el valor. Una misma sigla puede tener
    // valores distintos según el ámbito —el JUS de una provincia no es el de
    // otra—, así que la unidad sola no identifica una serie.
    ambito: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    valor: {
      type: Number,
      required: true,
      min: 0
    },
    // Desde cuándo rige. Se normaliza a UTC al inicio del día, igual que en
    // `tasas`, para que comparar fechas no dependa del huso del proceso que
    // escribió el documento.
    vigenciaDesde: {
      type: Date,
      required: true,
      set: function (fecha) {
        return fecha ? moment.utc(fecha).startOf('day').toDate() : fecha;
      }
    },
    // Norma que fija ESTE valor. Ej: "Res. 1352/26", "Ac. CSJN 11/2026".
    // Cambia con cada escalón.
    norma: {
      type: String,
      trim: true
    },
    // Cuándo se publicó la resolución. Es POSTERIOR a la vigencia, entre 58 y
    // 80 días según la serie: el valor de mayo 2026 se publicó el 13/07/2026.
    // Por eso "última resolución publicada" y "valor vigente hoy" no son lo
    // mismo, y el nombre del campo dice publicación y no "fecha" a secas.
    fechaPublicacion: {
      type: Date
    },
    // Fecha desde la que la fuente declara que rige, cuando no es el primero
    // del mes del período.
    vigenciaPublicada: {
      type: Date
    },
    // Período que el valor cubre, tal como lo rotula la fuente. Ej: "MAY-2026".
    periodo: {
      type: String,
      trim: true
    },
    // Ley o acordada que crea la unidad. Ej: "Ley N° 27.423" para la UMA.
    // No cambia entre escalones, pero se guarda con cada uno para que un valor
    // viejo siga citando el marco que regía cuando se fijó.
    leyMarco: {
      type: String,
      trim: true
    },
    // Cómo se nombra la unidad en un texto de cara al público. Ej: "Unidad de
    // Medida Arancelaria del Poder Judicial de la Nación". Es dato y no
    // presentación: depende de la unidad y del ámbito, y si lo arma quien
    // publica, termina distinto en cada pieza.
    descripcion: {
      type: String,
      trim: true
    },
    // URL de la publicación oficial, para poder verificar el valor sin
    // depender de quien lo cargó.
    fuente: {
      type: String,
      trim: true
    },
    notas: {
      type: String,
      trim: true
    },
    // Permite dar de baja un valor mal cargado sin borrarlo, para no perder el
    // rastro de que estuvo publicado.
    estado: {
      type: Boolean,
      default: true
    }
  },
  { timestamps: true, collection: 'valoresarancelarios' }
);

// Un mismo ámbito no puede tener dos valores de la misma unidad rigiendo desde
// la misma fecha: si se recarga una resolución, se actualiza el escalón que ya
// existe en vez de duplicarlo.
valorArancelarioSchema.index({ unidad: 1, ambito: 1, vigenciaDesde: -1 }, { unique: true });

/** Valor vigente de una unidad a una fecha dada (por defecto, hoy). */
valorArancelarioSchema.statics.vigente = function (unidad, ambito, fecha = new Date()) {
  return this.findOne({
    unidad: String(unidad).toUpperCase(),
    ambito,
    estado: true,
    vigenciaDesde: { $lte: moment.utc(fecha).endOf('day').toDate() }
  }).sort({ vigenciaDesde: -1 });
};

/** Serie completa de una unidad, del escalón más nuevo al más viejo. */
valorArancelarioSchema.statics.serie = function (unidad, ambito, limite = 24) {
  return this.find({ unidad: String(unidad).toUpperCase(), ambito, estado: true })
    .sort({ vigenciaDesde: -1 })
    .limit(limite);
};

module.exports = mongoose.model('ValorArancelario', valorArancelarioSchema);
