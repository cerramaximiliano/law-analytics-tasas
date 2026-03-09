const mongoose = require('mongoose');
const moment = require('moment');

let Schema = mongoose.Schema;

let tasasSchema = new Schema({
  fecha: {
    type: Date,
    required: true,
    index: true, // Usar index en lugar de unique+plugin
    // Aplicar un setter que normalice todas las fechas a UTC al inicio del día
    set: function (fecha) {
      if (fecha) {
        return moment.utc(fecha).startOf('day').toDate();
      }
      return fecha;
    }
  },
  tasaPasivaBNA: {
    type: Number
  },
  tasaPasivaBCRA: {
    type: Number
  },
  tasaActivaBNA: {
    type: Number
  },
  cer: {
    type: Number
  },
  icl: {
    type: Number
  },
  tasaActivaCNAT2601: {
    type: Number
  },
  tasaActivaCNAT2658: {
    type: Number
  },
  tasaActivaCNAT2764: {
    type: Number
  },
  tasaActivaTnaBNA: {
    type: Number
  },
  tasaPasivaBP: {
    type: Number
  },
  tasaActivaBPDolares: {
    type: Number
  },
  tasaPasivaBPDolares: {
    type: Number
  },
  // Fuente de origen para cada campo (servicio que lo extrajo)
  fuentes: {
    type: {
      tasaPasivaBNA:       { type: String },
      tasaPasivaBCRA:      { type: String },
      tasaActivaBNA:       { type: String },
      cer:                 { type: String },
      icl:                 { type: String },
      tasaActivaCNAT2601:  { type: String },
      tasaActivaCNAT2658:  { type: String },
      tasaActivaCNAT2764:  { type: String },
      tasaActivaTnaBNA:    { type: String },
      tasaPasivaBP:        { type: String },
      tasaActivaBPDolares: { type: String },
      tasaPasivaBPDolares: { type: String },
    },
    _id: false,
    default: {},
  },
});

// Middleware pre-save para asegurar que la fecha siempre se guarde normalizada
tasasSchema.pre('save', function (next) {
  if (this.fecha) {
    this.fecha = moment.utc(this.fecha).startOf('day').toDate();
  }
  next();
});

// Para búsquedas por fecha
tasasSchema.pre('findOne', function () {
  const query = this.getQuery();
  if (query.fecha) {
    query.fecha = moment.utc(query.fecha).startOf('day').toDate();
  }
});

// Para updates
tasasSchema.pre('findOneAndUpdate', function () {
  const update = this.getUpdate();
  if (update?.fecha || (update?.$set && update.$set.fecha)) {
    const fecha = update.fecha || update.$set.fecha;
    const fechaNormalizada = moment.utc(fecha).startOf('day').toDate();

    if (update.fecha) {
      update.fecha = fechaNormalizada;
    } else if (update.$set && update.$set.fecha) {
      update.$set.fecha = fechaNormalizada;
    }
  }
});

// Eliminar registros duplicados al guardar
tasasSchema.pre('save', async function () {
  if (this.isNew) {
    // Buscar documentos con la misma fecha
    const fechaNormalizada = moment.utc(this.fecha).startOf('day').toDate();
    const existingDoc = await this.constructor.findOne({ fecha: fechaNormalizada });

    if (existingDoc && existingDoc._id.toString() !== this._id.toString()) {
      // Si encontramos un documento con la misma fecha pero diferente ID,
      // transferimos el nuevo valor al documento existente y abortamos este guardado
      if (this.tasaPasivaBNA !== undefined) existingDoc.tasaPasivaBNA = this.tasaPasivaBNA;
      if (this.tasaPasivaBCRA !== undefined) existingDoc.tasaPasivaBCRA = this.tasaPasivaBCRA;
      if (this.tasaActivaBNA !== undefined) existingDoc.tasaActivaBNA = this.tasaActivaBNA;
      if (this.cer !== undefined) existingDoc.cer = this.cer;
      if (this.icl !== undefined) existingDoc.icl = this.icl;
      if (this.tasaActivaCNAT2601 !== undefined) existingDoc.tasaActivaCNAT2601 = this.tasaActivaCNAT2601;
      if (this.tasaActivaCNAT2658 !== undefined) existingDoc.tasaActivaCNAT2658 = this.tasaActivaCNAT2658;
      if (this.tasaActivaTnaBNA !== undefined) existingDoc.tasaActivaTnaBNA = this.tasaActivaTnaBNA;
      if (this.tasaPasivaBP !== undefined) existingDoc.tasaPasivaBP = this.tasaPasivaBP;
      if (this.tasaActivaBPDolares !== undefined) existingDoc.tasaActivaBPDolares = this.tasaActivaBPDolares;
      if (this.tasaPasivaBPDolares !== undefined) existingDoc.tasaPasivaBPDolares = this.tasaPasivaBPDolares;

      // Fusionar fuentes al hacer merge de documentos
      if (this.fuentes) {
        const fuentesNuevas = this.fuentes.toObject ? this.fuentes.toObject() : { ...this.fuentes };
        const fuentesActuales = existingDoc.fuentes ? (existingDoc.fuentes.toObject ? existingDoc.fuentes.toObject() : { ...existingDoc.fuentes }) : {};
        existingDoc.fuentes = { ...fuentesActuales, ...fuentesNuevas };
      }

      await existingDoc.save();
      throw new Error('MERGED_WITH_EXISTING'); // Esta excepción será detectada por el controlador
    }
  }
});


module.exports = mongoose.model('Tasas', tasasSchema);